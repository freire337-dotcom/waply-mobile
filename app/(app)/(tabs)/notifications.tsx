import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { formatDistanceToNow } from 'date-fns';
import { es } from 'date-fns/locale';
import { getNotifications, markNotificationRead, markAllNotificationsRead } from '../../../services/api';

const TYPE_ICON: Record<string, string> = {
  new_lead:      '🟢',
  task_reminder: '⏰',
  no_response:   '🕐',
};

export default function NotificationsScreen() {
  const [notifications, setNotifications] = useState<any[]>([]);
  const [unread, setUnread]               = useState(0);
  const [loading, setLoading]             = useState(true);
  const [refreshing, setRefreshing]       = useState(false);
  const [marking, setMarking]             = useState(false);

  const load = useCallback(async (showRefresh = false) => {
    if (showRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      const data = await getNotifications();
      setNotifications(data.notifications);
      setUnread(data.unread);
    } catch (err) {
      console.error('Error cargando notificaciones:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleTap = async (notif: any) => {
    // Marcar como leída
    if (!notif.read) {
      markNotificationRead(notif.id).catch(() => {});
      setNotifications(prev => prev.map(n => n.id === notif.id ? { ...n, read: true } : n));
      setUnread(u => Math.max(0, u - 1));
    }
    // Navegar a la conversación si la tiene
    if (notif.conversation_id) {
      router.push(`/(app)/conversation/${notif.conversation_id}`);
    }
  };

  const handleMarkAll = async () => {
    if (marking || unread === 0) return;
    setMarking(true);
    try {
      await markAllNotificationsRead();
      setNotifications(prev => prev.map(n => ({ ...n, read: true })));
      setUnread(0);
    } finally {
      setMarking(false);
    }
  };

  const renderItem = ({ item }: { item: any }) => {
    const icon = TYPE_ICON[item.type] || '🔔';
    const ago  = formatDistanceToNow(new Date(item.created_at), { addSuffix: true, locale: es });

    return (
      <TouchableOpacity
        style={[styles.item, !item.read && styles.itemUnread]}
        onPress={() => handleTap(item)}
        activeOpacity={0.7}
      >
        <Text style={styles.itemIcon}>{icon}</Text>
        <View style={styles.itemContent}>
          <Text style={[styles.itemTitle, !item.read && styles.itemTitleBold]}>
            {item.title}
          </Text>
          {item.body ? (
            <Text style={styles.itemBody} numberOfLines={1}>{item.body}</Text>
          ) : null}
          <Text style={styles.itemTime}>{ago}</Text>
        </View>
        {item.conversation_id ? (
          <Ionicons name="chevron-forward" size={16} color="#ccc" />
        ) : null}
      </TouchableOpacity>
    );
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#128C7E" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Acción "marcar todas como leídas" */}
      {unread > 0 && (
        <TouchableOpacity style={styles.markAllBar} onPress={handleMarkAll} disabled={marking}>
          {marking
            ? <ActivityIndicator size="small" color="#128C7E" />
            : <Text style={styles.markAllText}>Marcar todas como leídas ({unread})</Text>
          }
        </TouchableOpacity>
      )}

      <FlatList
        data={notifications}
        keyExtractor={item => String(item.id)}
        renderItem={renderItem}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => load(true)}
            tintColor="#128C7E"
          />
        }
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>🔔</Text>
            <Text style={styles.emptyTitle}>Sin notificaciones</Text>
            <Text style={styles.emptySubtitle}>
              Aquí verás nuevos leads, recordatorios de tareas y avisos de seguimiento.
            </Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  center:    { flex: 1, alignItems: 'center', justifyContent: 'center' },

  markAllBar: {
    backgroundColor: '#e8f5e9',
    paddingVertical: 10,
    paddingHorizontal: 16,
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#c8e6c9',
  },
  markAllText: { color: '#128C7E', fontSize: 13, fontWeight: '600' },

  item: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
  },
  itemUnread:    { backgroundColor: '#f0faf5' },
  itemIcon:      { fontSize: 22, width: 30, textAlign: 'center' },
  itemContent:   { flex: 1 },
  itemTitle:     { fontSize: 14, color: '#333', fontWeight: '500' },
  itemTitleBold: { fontWeight: '700', color: '#111' },
  itemBody:      { fontSize: 13, color: '#666', marginTop: 2 },
  itemTime:      { fontSize: 11, color: '#aaa', marginTop: 3 },

  separator: { height: StyleSheet.hairlineWidth, backgroundColor: '#f0f0f0' },

  empty: {
    alignItems: 'center',
    paddingTop: 80,
    paddingHorizontal: 40,
  },
  emptyIcon:     { fontSize: 48, marginBottom: 12 },
  emptyTitle:    { fontSize: 18, fontWeight: '600', color: '#333' },
  emptySubtitle: { fontSize: 14, color: '#888', marginTop: 6, textAlign: 'center', lineHeight: 20 },
});
