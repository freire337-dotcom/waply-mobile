import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Image, TouchableOpacity, ActivityIndicator, Modal, Alert, Linking } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { Audio, Video, ResizeMode } from 'expo-av';
import { Ionicons } from '@expo/vector-icons';
import { format } from 'date-fns';
import { getMediaUrl } from '../services/api';

interface QuotedMessage {
  body?: string | null;
  type?: string;
  direction?: 'inbound' | 'outbound';
  sender_name?: string | null;
}

interface Props {
  message: {
    id: number | string;
    direction: 'inbound' | 'outbound';
    type: string;
    body: string | null;
    media_url?: string | null;
    media_mime?: string | null;
    status: string;
    sender_name?: string;
    created_at: string;
    edited?: boolean;
    is_internal?: boolean;     // nota interna (solo agentes) — fondo ámbar
    // Tarjeta de contacto compartida (vCard) — viene ya parseada del backend
    // cuando type === 'contacts' (ver webhook/meta.js).
    contacts?: { name?: { formatted_name?: string }; phones?: { phone?: string; wa_id?: string }[] }[] | null;
    // Mensaje al que se está respondiendo (reply/quote de WhatsApp)
    quoted_message?: QuotedMessage | null;
    wa_message_id?: string | null;
  };
  contactName?: string; // nombre del contacto (para mostrar quién envió en citas inbound)
  // Editar/eliminar (solo se pasa para administradores — ver pantalla de conversación).
  onLongPress?: (message: Props['message']) => void;
}

const ICONS: Record<string, string> = {
  document: '📄',
  audio: '🎵',
  video: '🎬',
};

const URL_SPLIT_RE = /((?:https?:\/\/|www\.)[^\s]+)/gi;
const URL_TEST_RE  = /^(?:https?:\/\/|www\.)/i;

// Divide el texto en partes normales y enlaces, para poder pintar los
// enlaces como texto tocable (abre en el navegador in-app) sin perder
// la selección/copia nativa del resto del mensaje.
function linkify(text: string): { text: string; isLink: boolean }[] {
  if (!text) return [{ text: '', isLink: false }];
  return text.split(URL_SPLIT_RE)
    .filter(p => p !== '')
    .map(p => ({ text: p, isLink: URL_TEST_RE.test(p) }));
}

export default function MessageBubble({ message: m, contactName, onLongPress }: Props) {
  const isOut      = m.direction === 'outbound';
  const isInternal = !!m.is_internal;
  // Si el backend ya incluye 'Z' o '+HH:mm', no añadir otro 'Z' (daría Invalid Date en Hermes)
  const rawDate = m.created_at || '';
  const parsedDate = rawDate
    ? new Date(/[Z+]/.test(rawDate) ? rawDate : rawDate + 'Z')
    : null;
  const isToday = parsedDate
    ? parsedDate.toDateString() === new Date().toDateString()
    : true;
  const time  = parsedDate && !isNaN(parsedDate.getTime())
    ? isToday ? format(parsedDate, 'HH:mm') : format(parsedDate, 'dd/MM HH:mm')
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
  // completa; para video/documento usamos el navegador in-app de Expo
  // (WebBrowser). Los audios (notas de voz) ya no abren nada — se reproducen
  // directamente en la burbuja con un botón play/pausa (ver más abajo).
  const openMedia = () => {
    if (!mediaUri) return;
    if (isImage) {
      setPreviewVisible(true);
    } else {
      WebBrowser.openBrowserAsync(mediaUri).catch(() => {});
    }
  };

  const mediaHasFailed = imgError || fetchFailed;

  // ── Reproductor de audio in-app ───────────────────────────────────────────
  const [sound, setSound]               = useState<Audio.Sound | null>(null);
  const [isPlaying, setIsPlaying]       = useState(false);
  const [audioLoading, setAudioLoading] = useState(false);
  const [positionMs, setPositionMs]     = useState(0);
  const [durationMs, setDurationMs]     = useState(0);

  useEffect(() => {
    return () => { sound?.unloadAsync(); };
  }, [sound]);

  const onPlaybackStatusUpdate = (status: any) => {
    if (!status.isLoaded) return;
    setIsPlaying(status.isPlaying);
    setPositionMs(status.positionMillis || 0);
    setDurationMs(status.durationMillis || 0);
    if (status.didJustFinish) {
      setIsPlaying(false);
      setPositionMs(0);
    }
  };

  const toggleAudio = async () => {
    if (!mediaUri) return;
    try {
      if (sound) {
        const status = await sound.getStatusAsync();
        if (!status.isLoaded) return;
        if (status.isPlaying) {
          await sound.pauseAsync();
        } else {
          if (status.positionMillis >= (status.durationMillis || 0) - 200) {
            await sound.setPositionAsync(0);
          }
          await sound.playAsync();
        }
        return;
      }
      setAudioLoading(true);
      await Audio.setAudioModeAsync({ playsInSilentModeIOS: true, allowsRecordingIOS: false });
      const { sound: newSound } = await Audio.Sound.createAsync(
        { uri: mediaUri },
        { shouldPlay: true },
        onPlaybackStatusUpdate
      );
      setSound(newSound);
    } catch {
      Alert.alert('Error', 'No se pudo reproducir el audio');
    } finally {
      setAudioLoading(false);
    }
  };

  const fmtAudioTime = (ms: number) => {
    const s = Math.floor(ms / 1000);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };

  const audioProgressPct = durationMs ? Math.min(100, (positionMs / durationMs) * 100) : 0;
  const audioTimeLabel = isPlaying || positionMs > 0
    ? fmtAudioTime(positionMs)
    : (durationMs ? fmtAudioTime(durationMs) : '0:00');

  // ── Descarga de video/documento ───────────────────────────────────────────
  const downloadMedia = () => {
    if (!mediaUri) return;
    Linking.openURL(mediaUri).catch(() =>
      Alert.alert('Error', 'No se pudo abrir el archivo.')
    );
  };

  // No se puede editar/eliminar un mensaje optimista (todavía no tiene id real
  // del servidor) — el id temporal empieza por "tmp-".
  const canLongPress = !!onLongPress && typeof m.id !== 'string';

  return (
    <View style={[styles.wrapper, isOut ? styles.wrapperOut : styles.wrapperIn]}>
      <TouchableOpacity
        activeOpacity={canLongPress ? 0.7 : 1}
        disabled={!canLongPress}
        delayLongPress={350}
        onLongPress={() => onLongPress?.(m)}
        style={[
        styles.bubble,
        isInternal ? styles.bubbleInternal : (isOut ? styles.bubbleOut : styles.bubbleIn),
        m.status === 'sending' && { opacity: 0.6 },
      ]}>
        {/* Badge de nota interna */}
        {isInternal && (
          <View style={styles.internalBadge}>
            <Text style={styles.internalBadgeText}>🔒 Nota interna</Text>
          </View>
        )}
        {!isOut && !isInternal && m.sender_name && (
          <Text style={styles.sender}>{m.sender_name}</Text>
        )}
        {isInternal && m.sender_name && (
          <Text style={[styles.sender, { color: '#92400e' }]}>{m.sender_name}</Text>
        )}

        {/* Cita del mensaje al que se responde (reply/quote de WhatsApp) */}
        {m.quoted_message && (
          <View style={[styles.quotedBox, isOut ? styles.quotedBoxOut : styles.quotedBoxIn]}>
            <View style={[styles.quotedBar, { backgroundColor: isOut ? '#075e54' : '#128C7E' }]} />
            <View style={{ flex: 1 }}>
              <Text style={[styles.quotedSender, { color: isOut ? '#075e54' : '#128C7E' }]} numberOfLines={1}>
                {m.quoted_message.direction === 'outbound'
                  ? (m.quoted_message.sender_name || 'Tú')
                  : (contactName || 'Cliente')}
              </Text>
              <Text style={styles.quotedBody} numberOfLines={2}>
                {m.quoted_message.type && m.quoted_message.type !== 'text'
                  ? (m.quoted_message.type === 'image' ? '📷 Imagen'
                    : m.quoted_message.type === 'video' ? '🎥 Video'
                    : m.quoted_message.type === 'audio' ? '🎤 Audio'
                    : '📎 Archivo')
                  : (m.quoted_message.body || '')}
              </Text>
            </View>
          </View>
        )}

        {/* Mensajes de plantilla ('template') no tenían rama de render — quedaban
            visualmente vacíos (solo hora + check), aunque sí traían body guardado. */}
        {(m.type === 'text' || m.type === 'template') && (
          <Text selectable style={[styles.body, isOut ? styles.bodyOut : styles.bodyIn]}>
            {linkify(m.body || '').map((part, i) =>
              part.isLink ? (
                <Text
                  key={i}
                  style={styles.link}
                  onPress={() => {
                    const url = part.text.match(/^https?:\/\//i) ? part.text : `https://${part.text}`;
                    WebBrowser.openBrowserAsync(url).catch(() => {});
                  }}
                >
                  {part.text}
                </Text>
              ) : (
                // String directo (sin <Text> extra) evita el bug de Android que
                // hace invisibles los emojis cuando hay anidamiento de <Text>.
                part.text
              )
            )}
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

        {m.type === 'audio' && hasMedia && (
          fetchFailed ? (
            <TouchableOpacity style={styles.mediaRow} onPress={fetchMedia}>
              <Text style={styles.mediaIcon}>⚠️</Text>
              <Text style={styles.mediaText}>No se pudo cargar — toca para reintentar</Text>
            </TouchableOpacity>
          ) : (
            <View style={styles.audioRow}>
              <TouchableOpacity
                style={styles.audioPlayBtn}
                onPress={toggleAudio}
                disabled={!mediaUri || audioLoading}
              >
                {audioLoading || !mediaUri ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Ionicons name={isPlaying ? 'pause' : 'play'} size={16} color="#fff" />
                )}
              </TouchableOpacity>
              <View style={styles.audioProgressTrack}>
                <View style={[styles.audioProgressFill, { width: `${audioProgressPct}%` }]} />
              </View>
              <Text style={styles.audioTime}>{audioTimeLabel}</Text>
            </View>
          )
        )}

        {m.type === 'video' && hasMedia && (
          fetchFailed ? (
            <TouchableOpacity style={styles.mediaRow} onPress={fetchMedia}>
              <Text style={styles.mediaIcon}>⚠️</Text>
              <Text style={styles.mediaText}>No se pudo cargar — toca para reintentar</Text>
            </TouchableOpacity>
          ) : !mediaUri ? (
            <View style={[styles.videoContainer, { alignItems: 'center', justifyContent: 'center' }]}>
              <ActivityIndicator color="#888" />
            </View>
          ) : (
            <View>
              <Video
                source={{ uri: mediaUri }}
                style={styles.videoContainer}
                useNativeControls
                resizeMode={ResizeMode.CONTAIN}
                shouldPlay={false}
              />
              <TouchableOpacity style={styles.downloadBtn} onPress={downloadMedia}>
                <Ionicons name="download-outline" size={15} color="#075E54" />
                <Text style={styles.downloadText}>Descargar</Text>
              </TouchableOpacity>
            </View>
          )
        )}

        {m.type === 'document' && hasMedia && (
          <TouchableOpacity
            style={styles.mediaRow}
            onPress={fetchFailed ? fetchMedia : openMedia}
            disabled={!mediaUri && !fetchFailed}
          >
            <Text style={styles.mediaIcon}>{fetchFailed ? '⚠️' : '📄'}</Text>
            <Text style={styles.mediaText} numberOfLines={1}>
              {fetchFailed
                ? 'No se pudo cargar — toca para reintentar'
                : (m.body || 'Documento')}
            </Text>
            {!mediaUri && !fetchFailed && <ActivityIndicator size="small" color="#888" style={{ marginLeft: 6 }} />}
          </TouchableOpacity>
        )}

        {m.type === 'contacts' && (
          <View style={{ gap: 6 }}>
            {(m.contacts && m.contacts.length ? m.contacts : [null]).map((c, idx) => {
              const name  = c?.name?.formatted_name || 'Contacto';
              const phone = c?.phones?.[0]?.phone || c?.phones?.[0]?.wa_id || null;
              return (
                <View key={idx} style={styles.contactRow}>
                  <Text style={styles.contactIcon}>👤</Text>
                  <View>
                    <Text style={styles.contactName}>{name}</Text>
                    {phone && <Text style={styles.contactPhone}>{phone}</Text>}
                  </View>
                </View>
              );
            })}
          </View>
        )}

        {/* Reacciones de WhatsApp (tipo 'reaction') — mostrar el emoji grande */}
        {m.type === 'reaction' && m.body && (
          <Text style={styles.reactionEmoji}>{m.body}</Text>
        )}

        {/* Stickers de WhatsApp */}
        {m.type === 'sticker' && (
          mediaUri ? (
            <Image
              source={{ uri: mediaUri }}
              style={{ width: 120, height: 120, marginTop: 2 }}
              resizeMode="contain"
            />
          ) : (
            <Text style={styles.reactionEmoji}>🏷️</Text>
          )
        )}

        {isImage && m.body && (
          <Text selectable style={[styles.body, styles.caption]}>{m.body}</Text>
        )}

        <View style={styles.meta}>
          {m.edited && (
            <Text style={[styles.time, isOut ? styles.timeOut : styles.timeIn]}>editado · </Text>
          )}
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
      </TouchableOpacity>

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
  bubbleIn:       { backgroundColor: '#fff', borderTopLeftRadius: 2 },
  bubbleOut:      { backgroundColor: '#DCF8C6', borderTopRightRadius: 2 },
  // Notas internas: fondo ámbar suave, borde izquierdo naranja
  bubbleInternal: {
    backgroundColor: '#fef3c7',
    borderTopLeftRadius: 2,
    borderLeftWidth: 3,
    borderLeftColor: '#f59e0b',
  },
  internalBadge: {
    backgroundColor: 'rgba(245,158,11,0.15)',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginBottom: 4,
    alignSelf: 'flex-start',
  },
  internalBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#92400e',
    letterSpacing: 0.2,
  },

  sender: {
    fontSize: 12,
    fontWeight: '700',
    color: '#128C7E',
    marginBottom: 2,
  },

  quotedBox: {
    flexDirection: 'row',
    borderRadius: 6,
    marginBottom: 6,
    overflow: 'hidden',
    paddingVertical: 4,
    paddingRight: 8,
  },
  quotedBoxIn:  { backgroundColor: 'rgba(0,0,0,0.05)' },
  quotedBoxOut: { backgroundColor: 'rgba(0,0,0,0.08)' },
  quotedBar: {
    width: 3,
    borderRadius: 2,
    marginRight: 7,
  },
  quotedSender: {
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 1,
  },
  quotedBody: {
    fontSize: 12,
    color: '#555',
    lineHeight: 16,
  },

  reactionEmoji: { fontSize: 28, lineHeight: 34, textAlign: 'center', paddingVertical: 2 },
  body: { fontSize: 15, lineHeight: 20 },
  bodyIn:  { color: '#111' },
  bodyOut: { color: '#111' },
  caption: { color: '#111', marginTop: 4 },
  link: { color: '#1565C0', textDecorationLine: 'underline' },

  contactRow:   { flexDirection: 'row', alignItems: 'center', gap: 8 },
  contactIcon:  { fontSize: 20 },
  contactName:  { fontSize: 14, fontWeight: '600', color: '#111' },
  contactPhone: { fontSize: 12, color: '#555', marginTop: 1 },

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

  audioRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 2,
    minWidth: 170,
    maxWidth: 220,
    gap: 8,
  },
  audioPlayBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#128C7E',
    alignItems: 'center',
    justifyContent: 'center',
  },
  audioProgressTrack: {
    flex: 1,
    height: 3,
    borderRadius: 2,
    backgroundColor: 'rgba(0,0,0,0.15)',
    overflow: 'hidden',
  },
  audioProgressFill: {
    height: 3,
    backgroundColor: '#128C7E',
  },
  audioTime: {
    fontSize: 11,
    color: '#666',
    minWidth: 34,
    textAlign: 'right',
  },

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

  videoContainer: {
    width: 240,
    height: 170,
    borderRadius: 8,
    marginTop: 2,
    backgroundColor: '#000',
    overflow: 'hidden',
  },
  downloadBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 5,
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 6,
    backgroundColor: 'rgba(7,94,84,0.08)',
    alignSelf: 'flex-start',
  },
  downloadText: {
    fontSize: 12,
    color: '#075E54',
    fontWeight: '600',
  },
});
