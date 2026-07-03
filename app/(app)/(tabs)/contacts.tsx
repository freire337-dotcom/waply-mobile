import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  TextInput, ActivityIndicator, RefreshControl, Alert,
  Linking,
} from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { getConversations } from '../../../services/api';

interface Contact {
  id: number;
  name: string;
  wa_id: string;
  phone: string;
  conv_id: number;
  last: string;
}

function initials(name: string) {
  return name.trim().split(' ').slice(0, 2).map(w => w[0]?.toUpperCase() || '').join('') || '?';
}

const AVATAR_COLORS = ['#128C7E', '#25D366', '#075E54', '#3b82f6', '#8b5cf6', '#f59e0b', '#ef4444'];

function Avatar({ name, size = 40 }: { name: string; size?: number }) {
  const color = AVATAR_COLORS[name.charCodeAt(0) % AVATAR_COLORS.length] ?? '#128C7E';
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: '#fff', fontWeight: '700', fontSize: size * 0.38 }}>{initials(name)}</Text>
    </View>
  );
}

export default function ContactsScreen() {
  const [contacts, setContacts]   = useState<Contact[]>([]);
  const [loading, setLoading]     = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch]       = useState('');

  const load = useCallback(async (showRefresh = false) => {
    if (showRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      const data = await getConversations({ status: 'all' as any, limit: 1000 });
      const seen = new Set<number>();
      const list: Contact[] = (data.conversations || [])
        .filter((c: any) => { if (seen.has(c.contact_id)) return false; seen.add(c.contact_id); return true; })
        .map((c: any) => ({
          id:      c.contact_id,
          name:    c.contact_name || '',
          wa_id:   c.wa_id || '',
          phone:   c.phone || c.wa_id || '',
          conv_id: c.id,
          last:    c.last_msg_at,
        }))
        .sort((a: Contact, b: Contact) => (a.name || a.wa_id).localeCompare(b.name || b.wa_id));
      setContacts(list);
    } catch (err) {
      console.error('Error cargando contactos:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const visible = search.trim()
    ? contacts.filter(c => {
        const q = search.toLowerCase();
        return (c.name || '').toLowerCase().includes(q) || (c.phone || '').includes(q) || (c.wa_id || '').includes(q);
      })
    : contacts;

  const renderItem = ({ item }: { item: Contact }) => (
    <TouchableOpacity
      style={styles.item}
      onPress={() => router.push(`/(app)/conversation/${item.conv_id}`)}
      activeOpacity={0.7}
    >
      <Avatar name={item.name || item.wa_id} size={44} />
      <View style={styles.itemInfo}>
        <Text style={styles.itemName} numberOfLines={1}>{item.name || 'Sin nombre'}</Text>
        <Text style={styles.itemPhone} numberOfLines={1}>{item.phone || item.wa_id}</Text>
      </View>
      <TouchableOpacity
        onPress={() => {
          const num = (item.phone || item.wa_id).replace(/\D/g, '');
          Linking.openURL(`https://wa.me/${num}`).catch(() =>
            Alert.alert('Error', 'No se pudo abrir WhatsApp')
          );
        }}
        style={styles.waBtn}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <Ionicons name="logo-whatsapp" size={20} color="#25D366" />
      </TouchableOpacity>
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      {/* Buscador */}
      <View style={styles.searchBar}>
        <Ionicons name="search" size={15} color="#aaa" style={{ marginRight: 6 }} />
        <TextInput
          style={styles.searchInput}
          placeholder="Buscar contacto o teléfono..."
          placeholderTextColor="#aaa"
          value={search}
          onChangeText={setSearch}
          returnKeyType="search"
        />
        {search.length > 0 && (
          <TouchableOpacity onPress={() => setSearch('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="close-circle" size={16} color="#aaa" />
          </TouchableOpacity>
        )}
      </View>

      {/* Contador */}
      {!loading && (
        <View style={styles.countBar}>
          <Text style={styles.countText}>
            {visible.length} contacto{visible.length !== 1 ? 's' : ''}
          </Text>
        </View>
      )}

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#128C7E" />
        </View>
      ) : (
        <FlatList
          data={visible}
          keyExtractor={item => String(item.id)}
          renderItem={renderItem}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor="#128C7E" />}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyIcon}>👥</Text>
              <Text style={styles.emptyTitle}>Sin contactos</Text>
              <Text style={styles.emptySub}>Los contactos aparecen cuando llega un mensaje de WhatsApp.</Text>
            </View>
          }
        />
      )}
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
    paddingBottom: 8,
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

  countBar: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    backgroundColor: '#fff',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e0e0e0',
  },
  countText: { fontSize: 12, color: '#888', fontWeight: '600' },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  item: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  itemInfo:  { flex: 1, minWidth: 0 },
  itemName:  { fontSize: 15, fontWeight: '600', color: '#111' },
  itemPhone: { fontSize: 13, color: '#666', marginTop: 2 },

  waBtn: { padding: 4 },

  separator: { height: StyleSheet.hairlineWidth, backgroundColor: '#f0f0f0', marginLeft: 72 },

  empty: { alignItems: 'center', paddingTop: 80, paddingHorizontal: 40 },
  emptyIcon:  { fontSize: 48, marginBottom: 12 },
  emptyTitle: { fontSize: 18, fontWeight: '600', color: '#333' },
  emptySub:   { fontSize: 14, color: '#888', marginTop: 6, textAlign: 'center', lineHeight: 20 },
});
