import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Image, TouchableOpacity, ActivityIndicator, Modal } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { format } from 'date-fns';
import { getMediaUrl } from '../services/api';

interface Props {
  message: {
    id: number;
    direction: 'inbound' | 'outbound';
    type: string;
    body: string | null;
    media_url?: string | null;
    media_mime?: string | null;
    status: string;
    sender_name?: string;
    created_at: string;
  };
}

const ICONS: Record<string, string> = {
  document: '📄',
  audio: '🎵',
  video: '🎬',
};

export default function MessageBubble({ message: m }: Props) {
  const isOut = m.direction === 'outbound';
  const parsedDate = m.created_at ? new Date(m.created_at + 'Z') : null;
  const time  = parsedDate && !isNaN(parsedDate.getTime())
    ? format(parsedDate, 'HH:mm')
    : '';

  const statusIcon =
    m.status === 'read'      ? '✓✓' :
    m.status === 'delivered' ? '✓✓' :
    m.status === 'sent'      ? '✓'  :
    m.status === 'sending'   ? '🕐' :
    m.status === 'failed'    ? '✗'  : '';

  const isImage = m.type === 'image';
  const hasMedia = ['image', 'audio', 'video', 'document'].includes(m.type) && !!m.media_url;

  const [mediaUri, setMediaUri] = useState<string | null>(null);
  const [imgError, setImgError] = useState(false);
  const [fetchFailed, setFetchFailed] = useState(false);

  const fetchMedia = () => {
    if (!m.media_url) return;
    setFetchFailed(false);
    setImgError(false);
    getMediaUrl(m.media_url)
      .then(uri => setMediaUri(uri))
      .catch(() => setFetchFailed(true));
  };

  useEffect(() => {
    let active = true;
    // media_url guarda el media_id de Meta tanto para mensajes entrantes como salientes,
    // así que ambos se pueden previsualizar vía el proxy autenticado del backend.
    if (hasMedia && m.media_url) {
      getMediaUrl(m.media_url)
        .then(uri => { if (active) setMediaUri(uri); })
        .catch(() => { if (active) setFetchFailed(true); });
    }
    return () => { active = false; };
  }, [hasMedia, m.media_url]);

  const [previewVisible, setPreviewVisible] = useState(false);

  // Antes esto hacía Linking.openURL(), que sacaba al usuario de la app (otra
  // pestaña/app del sistema). Para imágenes basta un Modal nativo a pantalla
  // completa; para audio/video/documento usamos el navegador in-app de Expo
  // (WebBrowser), que se queda dentro del contexto de la app en vez de abrir
  // Chrome/el visor del sistema por separado.
  const openMedia = () => {
    if (!mediaUri) return;
    if (isImage) {
      setPreviewVisible(true);
    } else {
      WebBrowser.openBrowserAsync(mediaUri).catch(() => {});
    }
  };

  const mediaHasFailed = imgError || fetchFailed;

  return (
    <View style={[styles.wrapper, isOut ? styles.wrapperOut : styles.wrapperIn]}>
      <View style={[
        styles.bubble,
        isOut ? styles.bubbleOut : styles.bubbleIn,
        m.status === 'sending' && { opacity: 0.6 },
      ]}>
        {!isOut && m.sender_name && (
          <Text style={styles.sender}>{m.sender_name}</Text>
        )}

        {/* Mensajes de plantilla ('template') no tenían rama de render — quedaban
            visualmente vacíos (solo hora + check), aunque sí traían body guardado. */}
        {(m.type === 'text' || m.type === 'template') && (
          <Text style={[styles.body, isOut ? styles.bodyOut : styles.bodyIn]}>
            {m.body}
          </Text>
        )}

        {isImage && hasMedia && (
          mediaUri && !imgError ? (
            <TouchableOpacity onPress={openMedia}>
              <Image
                source={{ uri: mediaUri }}
                style={styles.image}
                resizeMode="cover"
                onError={() => setImgError(true)}
              />
            </TouchableOpacity>
          ) : mediaHasFailed ? (
            <TouchableOpacity style={[styles.image, styles.imagePlaceholder]} onPress={fetchMedia}>
              <Text style={styles.errorIcon}>⚠️</Text>
              <Text style={styles.errorText}>No se pudo cargar{'\n'}toca para reintentar</Text>
            </TouchableOpacity>
          ) : (
            <View style={[styles.image, styles.imagePlaceholder]}>
              <ActivityIndicator color="#888" />
            </View>
          )
        )}

        {['audio', 'video', 'document'].includes(m.type) && hasMedia && (
          <TouchableOpacity
            style={styles.mediaRow}
            onPress={fetchFailed ? fetchMedia : openMedia}
            disabled={!mediaUri && !fetchFailed}
          >
            <Text style={styles.mediaIcon}>{fetchFailed ? '⚠️' : (ICONS[m.type] || '📎')}</Text>
            <Text style={styles.mediaText} numberOfLines={1}>
              {fetchFailed
                ? 'No se pudo cargar — toca para reintentar'
                : (m.body || (m.type === 'document' ? 'Documento' : m.type === 'audio' ? 'Audio' : 'Video'))}
            </Text>
            {!mediaUri && !fetchFailed && <ActivityIndicator size="small" color="#888" style={{ marginLeft: 6 }} />}
          </TouchableOpacity>
        )}

        {isImage && m.body && (
          <Text style={[styles.body, styles.caption]}>{m.body}</Text>
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

      {isImage && mediaUri && (
        <Modal visible={previewVisible} transparent animationType="fade" onRequestClose={() => setPreviewVisible(false)}>
          <TouchableOpacity
            style={styles.previewBackdrop}
            activeOpacity={1}
            onPress={() => setPreviewVisible(false)}
          >
            <Image source={{ uri: mediaUri }} style={styles.previewImage} resizeMode="contain" />
          </TouchableOpacity>
        </Modal>
      )}
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
  caption: { color: '#111', marginTop: 4 },

  image: {
    width: 220,
    height: 220,
    borderRadius: 8,
    marginTop: 2,
    backgroundColor: '#e5e5e5',
  },
  imagePlaceholder: { alignItems: 'center', justifyContent: 'center' },
  errorIcon: { fontSize: 22, marginBottom: 4 },
  errorText: { fontSize: 12, color: '#888', textAlign: 'center' },

  mediaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.04)',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginTop: 2,
    maxWidth: 220,
  },
  mediaIcon: { fontSize: 18, marginRight: 8 },
  mediaText: { fontSize: 14, color: '#333', flexShrink: 1 },

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

  previewBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewImage: {
    width: '100%',
    height: '100%',
  },
});
