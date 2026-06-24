import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { formatDistanceToNow } from 'date-fns';
import { es } from 'date-fns/locale';

interface Props {
  conversation: {
    id: number;
    contact_name: string;
    wa_id: string;
    last_message: string;
    last_msg_at: string;
    unread_count: number;
    status: string;
    agent_name?: string;
  };
  onPress: () => void;
}

export default function ConversationItem({ conversation: c, onPress }: Props) {
  const initials = (c.contact_name || c.wa_id)
    .split(' ')
    .slice(0, 2)
    .map((w: string) => w[0])
    .join('')
    .toUpperCase();

  const parsedDate = c.last_msg_at ? new Date(c.last_msg_at + 'Z') : null;
  const timeAgo = parsedDate && !isNaN(parsedDate.getTime())
    ? formatDistanceToNow(parsedDate, { addSuffix: false, locale: es })
    : '';

  return (
    <TouchableOpacity style={styles.container} onPress={onPress} activeOpacity={0.7}>
      {/* Avatar */}
      <View style={styles.avatar}>
        <Text style={styles.avatarText}>{initials}</Text>
      </View>

      {/* Contenido */}
      <View style={styles.content}>
        <View style={styles.row}>
          <Text style={styles.name} numberOfLines={1}>
            {c.contact_name || c.wa_id}
          </Text>
          <Text style={styles.time}>{timeAgo}</Text>
        </View>
        <View style={styles.row}>
          <Text style={[styles.preview, c.unread_count > 0 && styles.previewUnread]} numberOfLines={1}>
            {c.last_message || 'Sin mensajes'}
          </Text>
          {c.unread_count > 0 && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{c.unread_count > 99 ? '99+' : c.unread_count}</Text>
            </View>
          )}
        </View>
        {c.agent_name && (
          <Text style={styles.agent}>👤 {c.agent_name}</Text>
        )}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#fff',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e5e5e5',
  },
  avatar: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: '#128C7E',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  avatarText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
  },
  content: {
    flex: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  name: {
    fontSize: 16,
    fontWeight: '600',
    color: '#111',
    flex: 1,
    marginRight: 8,
  },
  time: {
    fontSize: 12,
    color: '#999',
  },
  preview: {
    fontSize: 14,
    color: '#888',
    flex: 1,
    marginRight: 8,
    marginTop: 2,
  },
  previewUnread: {
    color: '#333',
    fontWeight: '500',
  },
  badge: {
    backgroundColor: '#25D366',
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  badgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },
  agent: {
    fontSize: 11,
    color: '#128C7E',
    marginTop: 2,
  },
});
