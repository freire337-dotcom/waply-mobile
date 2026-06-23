import React, { useCallback, useEffect, useState } from 'react';
import {
  View, FlatList, Text, StyleSheet, TouchableOpacity,
  ActivityIndicator, RefreshControl, StatusBar,
} from 'react-native';
import { router } from 'expo-router';
import { getConversations, ConvStatus } from '../../../services/api';
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
  });

  const totalUnread = conversations.reduce((acc, c) => acc + (c.unread_count || 0), 0);

  // Reflejar el total en la tab bar (badge), igual que Callbell
  useEffect(() => { setUnreadTotal(totalUnread); }, [totalUnread, setUnreadTotal]);

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#075E54" />

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
          data={conversations}
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
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },

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
});
