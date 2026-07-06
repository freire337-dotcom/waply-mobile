import React, { useCallback, useEffect, useState } from 'react';
import {
  View, FlatList, Text, StyleSheet, TouchableOpacity,
  ActivityIndicator, RefreshControl, StatusBar, Modal, TextInput, Alert, ScrollView,
} from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { getConversations, createConversation, getLabels, getTemplates, sendMessage, ConvStatus } from '../../../services/api';
import { useSocket } from '../../../hooks/useSocket';
import { useUnreadStore } from '../../../store/unread';
import ConversationItem from '../../../components/ConversationItem';

const FILTERS: { label: string; value: ConvStatus | 'me' }[] = [
  { label: 'Abiertas',    value: 'open' },
  { label: 'Mis chats',   value: 'me' },
  { label: 'Pendientes',  value: 'pending' },
  { label: 'Cerradas',    value: 'closed' },
];

export default function ConversationsScreen() {
  const [conversations, setConversations] = useState<any[]>([]);
  const [filter, setFilter]               = useState<string>('open');
  const [loading, setLoading]             = useState(true);
  const [refreshing, setRefreshing]       = useState(false);
  const setUnreadTotal                    = useUnreadStore(s => s.setTotal);

  // Etiquetas para filtrar
  const [allLabels, setAllLabels]         = useState<any[]>([]);
  const [labelFilter, setLabelFilter]     = useState<number | null>(null);
  const [showLabelPicker, setShowLabelPicker] = useState(false);

  // Buscador de contactos — filtra la lista cargada por nombre o teléfono
  const [search, setSearch] = useState('');

  // Alta manual de contacto — paso 1: datos, paso 2: plantilla
  const [showNewContact, setShowNewContact] = useState(false);
  const [newName, setNewName]               = useState('');
  const [newPhone, setNewPhone]             = useState('');
  const [creatingContact, setCreatingContact] = useState(false);
  // paso 2
  const [contactStep, setContactStep]       = useState<1 | 2>(1);
  const [newConvId, setNewConvId]           = useState<number | null>(null);
  const [templates, setTemplates]           = useState<any[]>([]);
  const [loadingTpls, setLoadingTpls]       = useState(false);
  const [selectedTpl, setSelectedTpl]       = useState<any | null>(null);
  const [tplParams, setTplParams]           = useState<string[]>([]);
  const [sendingTpl, setSendingTpl]         = useState(false);

  const resetContactModal = () => {
    setShowNewContact(false);
    setNewName(''); setNewPhone('');
    setContactStep(1); setNewConvId(null);
    setTemplates([]); setSelectedTpl(null); setTplParams([]);
  };

  // Paso 1: crear contacto y pasar al paso 2 (elegir plantilla)
  const handleCreateContact = async () => {
    const phone = newPhone.trim();
    if (!phone || creatingContact) return;
    setCreatingContact(true);
    try {
      const conv = await createConversation({ name: newName.trim() || undefined, phone });
      setNewConvId(conv.id);
      setContactStep(2);
      // Cargar plantillas aprobadas
      setLoadingTpls(true);
      try {
        const tpls = await getTemplates();
        setTemplates((tpls || []).filter((t: any) => t.status === 'APPROVED'));
      } catch { setTemplates([]); }
      finally { setLoadingTpls(false); }
    } catch (err: any) {
      Alert.alert('Error', err?.response?.data?.error || 'No se pudo crear el contacto');
    } finally {
      setCreatingContact(false);
    }
  };

  // Al seleccionar una plantilla, preparar array de params vacíos
  const handleSelectTpl = (tpl: any) => {
    setSelectedTpl(tpl);
    setTplParams(Array(tpl.param_count || 0).fill(''));
  };

  // Paso 2: enviar plantilla y abrir chat
  const handleSendTemplate = async () => {
    if (!selectedTpl || !newConvId || sendingTpl) return;
    setSendingTpl(true);
    try {
      const components = selectedTpl.param_count > 0
        ? [{ type: 'body', parameters: tplParams.map((v: string) => ({ type: 'text', text: v || ' ' })) }]
        : [];
      await sendMessage(newConvId, {
        type: 'template',
        template_name: selectedTpl.name,
        template_language: selectedTpl.language,
        template_components: components,
      });
    } catch { /* si falla el envío igual abrimos el chat */ }
    finally { setSendingTpl(false); }
    resetContactModal();
    router.push(`/(app)/conversation/${newConvId}`);
  };

  // Paso 2: omitir plantilla, solo abrir chat
  const handleSkipTemplate = () => {
    const id = newConvId;
    resetContactModal();
    if (id) router.push(`/(app)/conversation/${id}`);
  };

  // Cargar etiquetas una vez al montar
  useEffect(() => {
    getLabels().then(setAllLabels).catch(() => {});
  }, []);

  const fetchConversations = useCallback(async (showRefresh = false) => {
    if (showRefresh) setRefreshing(true);
    else setLoading(true);

    try {
      const params: any = {};
      if (filter === 'me') {
        params.assigned_to = 'me';
        params.status = 'open';
      } else {
        params.status = filter;
      }
      if (labelFilter) params.label_id = labelFilter;
      const data = await getConversations(params);
      setConversations(data.conversations);
    } catch (err) {
      console.error('Error cargando conversaciones:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [filter, labelFilter]);

  useEffect(() => { fetchConversations(); }, [fetchConversations]);

  // Actualizar lista cuando llega un evento de socket
  useSocket((updatedConv) => {
    setConversations(prev => {
      const idx = prev.findIndex(c => c.id === updatedConv.id);
      if (idx === -1) return [updatedConv, ...prev];
      const next = [...prev];
      next[idx] = updatedConv;
      return next.sort((a, b) =>
        new Date(b.last_msg_at || 0).getTime() - new Date(a.last_msg_at || 0).getTime()
      );
    });
  }, () => fetchConversations());

  const totalUnread = conversations.reduce((acc, c) => acc + (c.unread_count || 0), 0);

  // Reflejar el total en la tab bar (badge), igual que Callbell
  useEffect(() => { setUnreadTotal(totalUnread); }, [totalUnread, setUnreadTotal]);

  // Filtrar conversaciones según el texto de búsqueda (cliente-side)
  const visibleConversations = search.trim()
    ? conversations.filter(c => {
        const q = search.toLowerCase();
        return (
          (c.contact_name || '').toLowerCase().includes(q) ||
          (c.wa_id || '').includes(q) ||
          (c.last_message || '').toLowerCase().includes(q)
        );
      })
    : conversations;

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#075E54" />

      {/* Buscador */}
      <View style={styles.searchBar}>
        <Ionicons name="search" size={16} color="#aaa" style={{ marginRight: 6 }} />
        <TextInput
          style={styles.searchInput}
          placeholder="Buscar contacto o conversación..."
          placeholderTextColor="#aaa"
          value={search}
          onChangeText={setSearch}
          returnKeyType="search"
          clearButtonMode="while-editing"
        />
        {search.length > 0 && (
          <TouchableOpacity onPress={() => setSearch('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="close-circle" size={16} color="#aaa" />
          </TouchableOpacity>
        )}
      </View>

      {/* Filtros de estado */}
      <View style={styles.filters}>
        {FILTERS.map(f => (
          <TouchableOpacity
            key={f.value}
            style={[styles.filter, filter === f.value && styles.filterActive]}
            onPress={() => setFilter(f.value)}
          >
            <Text style={[styles.filterText, filter === f.value && styles.filterTextActive]}>
              {f.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Filtro por etiqueta — botón compacto */}
      {allLabels.length > 0 && (
        <TouchableOpacity
          style={[styles.labelFilterBtn, labelFilter !== null && styles.labelFilterBtnActive]}
          onPress={() => setShowLabelPicker(true)}
        >
          <Text style={[styles.labelFilterBtnText, labelFilter !== null && styles.labelFilterBtnTextActive]}>
            🏷 {labelFilter ? (allLabels.find(l => l.id === labelFilter)?.name ?? 'Etiqueta') : 'Todas las etiquetas'}
          </Text>
          <Text style={{ color: labelFilter !== null ? '#075E54' : '#aaa', fontSize: 11 }}>▼</Text>
        </TouchableOpacity>
      )}

      {/* Modal picker de etiquetas */}
      <Modal visible={showLabelPicker} transparent animationType="slide" onRequestClose={() => setShowLabelPicker(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>Filtrar por etiqueta</Text>
            <TouchableOpacity
              style={[styles.labelPickerItem, labelFilter === null && styles.labelPickerItemActive]}
              onPress={() => { setLabelFilter(null); setShowLabelPicker(false); }}
            >
              <Text style={[styles.labelPickerText, labelFilter === null && { color: '#128C7E', fontWeight: '700' }]}>
                Todas las conversaciones
              </Text>
            </TouchableOpacity>
            {allLabels.map(label => (
              <TouchableOpacity
                key={label.id}
                style={[styles.labelPickerItem, labelFilter === label.id && styles.labelPickerItemActive]}
                onPress={() => { setLabelFilter(label.id); setShowLabelPicker(false); }}
              >
                <View style={[styles.labelPickerDot, { backgroundColor: label.color }]} />
                <Text style={[styles.labelPickerText, labelFilter === label.id && { color: label.color, fontWeight: '700' }]}>
                  {label.name}
                </Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity style={styles.modalClose} onPress={() => setShowLabelPicker(false)}>
              <Text style={styles.modalCloseText}>Cancelar</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Badge total no leídos */}
      {totalUnread > 0 && (
        <View style={styles.unreadBanner}>
          <Text style={styles.unreadBannerText}>
            {totalUnread} mensaje{totalUnread !== 1 ? 's' : ''} sin leer
          </Text>
        </View>
      )}

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#128C7E" />
        </View>
      ) : (
        <FlatList
          data={visibleConversations}
          keyExtractor={item => String(item.id)}
          renderItem={({ item }) => (
            <ConversationItem
              conversation={item}
              onPress={() => router.push(`/(app)/conversation/${item.id}`)}
            />
          )}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => fetchConversations(true)}
              tintColor="#128C7E"
            />
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyIcon}>💬</Text>
              <Text style={styles.emptyText}>No hay conversaciones</Text>
              <Text style={styles.emptySubtext}>
                Los mensajes de WhatsApp aparecerán aquí
              </Text>
            </View>
          }
        />
      )}

      {/* Alta manual de contacto */}
      <TouchableOpacity style={styles.fab} onPress={() => setShowNewContact(true)}>
        <Ionicons name="person-add" size={22} color="#fff" />
      </TouchableOpacity>

      <Modal visible={showNewContact} transparent animationType="slide" onRequestClose={resetContactModal}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalBox, { maxHeight: '90%' }]}>
            {/* ── Paso 1: nombre + teléfono ── */}
            {contactStep === 1 && (
              <>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 18, paddingBottom: 4 }}>
                  <Text style={styles.modalTitle}>Nuevo contacto</Text>
                  <TouchableOpacity onPress={resetContactModal} style={{ padding: 6 }}>
                    <Text style={{ fontSize: 20, color: '#6b7280', fontWeight: '700' }}>✕</Text>
                  </TouchableOpacity>
                </View>
                <View style={{ paddingHorizontal: 20, paddingVertical: 14, gap: 10 }}>
                  <Text style={styles.inputLabel}>Nombre (opcional)</Text>
                  <TextInput
                    style={styles.modalInput}
                    value={newName}
                    onChangeText={setNewName}
                    placeholder="Ej: Sara Aguilera"
                    placeholderTextColor="#aaa"
                  />
                  <Text style={styles.inputLabel}>Teléfono</Text>
                  <TextInput
                    style={styles.modalInput}
                    value={newPhone}
                    onChangeText={setNewPhone}
                    placeholder="Ej: +34640330820"
                    placeholderTextColor="#aaa"
                    keyboardType="phone-pad"
                  />
                  <TouchableOpacity
                    style={[styles.createBtn, (!newPhone.trim() || creatingContact) && { opacity: 0.5 }]}
                    onPress={handleCreateContact}
                    disabled={!newPhone.trim() || creatingContact}
                  >
                    {creatingContact
                      ? <ActivityIndicator size="small" color="#fff" />
                      : <Text style={styles.createBtnText}>Continuar →</Text>
                    }
                  </TouchableOpacity>
                </View>
              </>
            )}

            {/* ── Paso 2: elegir plantilla ── */}
            {contactStep === 2 && (
              <>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 18, paddingBottom: 4 }}>
                  <Text style={styles.modalTitle}>Enviar plantilla</Text>
                  <TouchableOpacity onPress={resetContactModal} style={{ padding: 6 }}>
                    <Text style={{ fontSize: 20, color: '#6b7280', fontWeight: '700' }}>✕</Text>
                  </TouchableOpacity>
                </View>
                <Text style={{ paddingHorizontal: 20, fontSize: 13, color: '#6b7280', marginBottom: 10 }}>
                  Selecciona una plantilla aprobada para iniciar la conversación (obligatorio en nuevos contactos).
                </Text>

                {loadingTpls && <ActivityIndicator style={{ marginVertical: 20 }} color="#075E54" />}

                {!loadingTpls && templates.length === 0 && (
                  <Text style={{ paddingHorizontal: 20, color: '#999', fontSize: 13, marginBottom: 16 }}>
                    No hay plantillas aprobadas. Puedes crearlas en tu cuenta Meta Business.
                  </Text>
                )}

                {!loadingTpls && templates.length > 0 && (
                  <ScrollView style={{ maxHeight: 240 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                    {templates.map((tpl: any) => (
                      <TouchableOpacity
                        key={tpl.name + tpl.language}
                        onPress={() => handleSelectTpl(tpl)}
                        style={{
                          paddingHorizontal: 20, paddingVertical: 12,
                          borderBottomWidth: 1, borderBottomColor: '#f0f0f0',
                          backgroundColor: selectedTpl?.name === tpl.name ? '#e8f5e9' : '#fff',
                        }}
                      >
                        <Text style={{ fontWeight: '600', color: '#111', fontSize: 14 }}>{tpl.name}</Text>
                        <Text style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
                          {tpl.language} · {tpl.category}
                          {tpl.param_count > 0 ? ` · ${tpl.param_count} param(s)` : ''}
                        </Text>
                        {/* Preview del body */}
                        {tpl.components?.find((c: any) => c.type === 'BODY')?.text && (
                          <Text numberOfLines={2} style={{ fontSize: 12, color: '#374151', marginTop: 4 }}>
                            {tpl.components.find((c: any) => c.type === 'BODY').text}
                          </Text>
                        )}
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                )}

                {/* Inputs para parámetros si la plantilla los tiene */}
                {selectedTpl && selectedTpl.param_count > 0 && (
                  <View style={{ paddingHorizontal: 20, paddingTop: 10, gap: 8 }}>
                    {Array.from({ length: selectedTpl.param_count }).map((_: any, i: number) => (
                      <View key={i}>
                        <Text style={styles.inputLabel}>Parámetro {'{{'}{i + 1}{'}}'}</Text>
                        <TextInput
                          style={styles.modalInput}
                          value={tplParams[i] || ''}
                          onChangeText={(v: string) => setTplParams((prev: string[]) => { const a = [...prev]; a[i] = v; return a; })}
                          placeholder={`Valor para {{${i + 1}}}`}
                          placeholderTextColor="#aaa"
                        />
                      </View>
                    ))}
                  </View>
                )}

                <View style={{ paddingHorizontal: 20, paddingVertical: 14, gap: 8 }}>
                  <TouchableOpacity
                    style={[styles.createBtn, (!selectedTpl || sendingTpl) && { opacity: 0.5 }]}
                    onPress={handleSendTemplate}
                    disabled={!selectedTpl || sendingTpl}
                  >
                    {sendingTpl
                      ? <ActivityIndicator size="small" color="#fff" />
                      : <Text style={styles.createBtnText}>Enviar y abrir chat</Text>
                    }
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.modalClose} onPress={handleSkipTemplate}>
                    <Text style={styles.modalCloseText}>Omitir — solo abrir chat</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },

  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#075E54',
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 4,
  },
  searchInput: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 7,
    fontSize: 14,
    color: '#fff',
  },

  filters: {
    flexDirection: 'row',
    backgroundColor: '#075E54',
    paddingBottom: 8,
    paddingHorizontal: 8,
  },
  filter: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    borderRadius: 20,
  },
  filterActive: {
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  filterText: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.7)',
    fontWeight: '500',
  },
  filterTextActive: {
    color: '#fff',
    fontWeight: '700',
  },

  labelFilterBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#f0f0f0',
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ddd',
    gap: 6,
  },
  labelFilterBtnActive: {
    backgroundColor: '#e8f5e9',
  },
  labelFilterBtnText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#666',
    flex: 1,
  },
  labelFilterBtnTextActive: {
    color: '#075E54',
    fontWeight: '700',
  },
  labelPickerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#f0f0f0',
    gap: 10,
  },
  labelPickerItemActive: {
    backgroundColor: '#f0faf8',
  },
  labelPickerDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  labelPickerText: {
    fontSize: 15,
    color: '#333',
    fontWeight: '400',
  },

  unreadBanner: {
    backgroundColor: '#25D366',
    paddingVertical: 6,
    alignItems: 'center',
  },
  unreadBannerText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  empty: {
    alignItems: 'center',
    paddingTop: 80,
  },
  emptyIcon:    { fontSize: 48, marginBottom: 12 },
  emptyText:    { fontSize: 18, fontWeight: '600', color: '#333' },
  emptySubtext: { fontSize: 14, color: '#888', marginTop: 4 },

  fab: {
    position: 'absolute',
    right: 20,
    bottom: 24,
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#25D366',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 4,
  },

  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  modalBox: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingTop: 16,
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: '700',
    textAlign: 'center',
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e0e0e0',
  },
  inputLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#888',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  modalInput: {
    backgroundColor: '#f0f0f0',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    color: '#111',
  },
  createBtn: {
    backgroundColor: '#128C7E',
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
    marginTop: 6,
  },
  createBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  modalClose: {
    padding: 16,
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e0e0e0',
  },
  modalCloseText: { color: '#e53e3e', fontSize: 15, fontWeight: '600' },
});
