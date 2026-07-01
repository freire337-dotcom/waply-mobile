import React, { useCallback, useEffect, useState } from 'react';
import {
  View, FlatList, Text, StyleSheet, TouchableOpacity,
  ActivityIndicator, RefreshControl, StatusBar, Modal, TextInput, Alert,
} from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { getConversations, createConversation, ConvStatus } from '../../../services/api';
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

  // Buscador de contactos — filtra la lista cargada por nombre o teléfono
  const [search, setSearch] = useState('');

  // Alta manual de contacto
  const [showNewContact, setShowNewContact] = useState(false);
  const [newName, setNewName]             = useState('');
  const [newPhone, setNewPhone]           = useState('');
  const [creatingContact, setCreatingContact] = useState(false);

  const handleCreateContact = async () => {
    const phone = newPhone.trim();
    if (!phone || creatingContact) return;
    setCreatingContact(true);
    try {
      const conv = await createConversation({ name: newName.trim() || undefined, phone });
      setShowNewContact(false);
      setNewName('');
      setNewPhone('');
      router.push(`/(app)/conversation/${conv.id}`);
    } catch (err: any) {
      Alert.alert('Error', err?.response?.data?.error || 'No se pudo crear el contacto');
    } finally {
      setCreatingContact(false);
    }
  };

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
      const data = await getConversations(params);
      setConversations(data.conversations);
    } catch (err) {
      console.error('Error cargando conversaciones:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [filter]);

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

      {/* Filtros */}
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

      <Modal visible={showNewContact} transparent animationType="slide" onRequestClose={() => setShowNewContact(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>Nuevo contacto</Text>
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
                placeholder="Ej: +34 640 330 820"
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
                  : <Text style={styles.createBtnText}>Crear contacto</Text>
                }
              </TouchableOpacity>
            </View>
            <TouchableOpacity style={styles.modalClose} onPress={() => setShowNewContact(false)}>
              <Text style={styles.modalCloseText}>Cancelar</Text>
            </TouchableOpacity>
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
