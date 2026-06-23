import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { format } from 'date-fns';

interface Props {
  message: {
    id: number;
    direction: 'inbound' | 'outbound';
    type: string;
    body: string | null;
    status: string;
    sender_name?: string;
    created_at: string;
  };
}

export default function MessageBubble({ message: m }: Props) {
  const isOut = m.direction === 'outbound';
  const time  = m.created_at
    ? format(new Date(m.created_at + 'Z'), 'HH:mm')
    : '';

  const statusIcon =
    m.status === 'read'      ? '✓✓' :
    m.status === 'delivered' ? '✓✓' :
    m.status === 'sent'      ? '✓'  :
    m.status === 'failed'    ? '✗'  : '';

  return (
    <View style={[styles.wrapper, isOut ? styles.wrapperOut : styles.wrapperIn]}>
      <View style={[styles.bubble, isOut ? styles.bubbleOut : styles.bubbleIn]}>
        {!isOut && m.sender_name && (
          <Text style={styles.sender}>{m.sender_name}</Text>
        )}

        {m.type === 'text' && (
          <Text style={[styles.body, isOut ? styles.bodyOut : styles.bodyIn]}>
            {m.body}
          </Text>
        )}

        {['image', 'audio', 'video', 'document'].includes(m.type) && (
          <Text style={[styles.body, styles.mediaLabel]}>
            📎 [{m.type}]{m.body ? ` — ${m.body}` : ''}
          </Text>
        )}

        <View style={styles.meta}>
          <Text style={[styles.time, isOut ? styles.timeOut : styles.timeIn]}>
            {time}
          </Text>
          {isOut && (
            <Text style={[
              styles.status,
              m.status === 'read' ? styles.statusRead : styles.statusSent,
              m.status === 'failed' && styles.statusFailed,
            ]}>
              {statusIcon}
            </Text>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    paddingHorizontal: 12,
    paddingVertical: 2,
    maxWidth: '80%',
  },
  wrapperIn:  { alignSelf: 'flex-start' },
  wrapperOut: { alignSelf: 'flex-end' },

  bubble: {
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 6,
    paddingBottom: 4,
    minWidth: 60,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.07,
    shadowRadius: 1,
    elevation: 1,
  },
  bubbleIn:  { backgroundColor: '#fff', borderTopLeftRadius: 2 },
  bubbleOut: { backgroundColor: '#DCF8C6', borderTopRightRadius: 2 },

  sender: {
    fontSize: 12,
    fontWeight: '700',
    color: '#128C7E',
    marginBottom: 2,
  },

  body: { fontSize: 15, lineHeight: 20 },
  bodyIn:  { color: '#111' },
  bodyOut: { color: '#111' },
  mediaLabel: { color: '#555', fontStyle: 'italic' },

  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    marginTop: 3,
    gap: 3,
  },
  time:    { fontSize: 11, color: '#999' },
  timeOut: { color: '#77a87c' },
  timeIn:  { color: '#999' },

  status:       { fontSize: 11 },
  statusSent:   { color: '#aaa' },
  statusRead:   { color: '#34B7F1' },
  statusFailed: { color: '#e53e3e' },
});
