import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, FlatList, TextInput, TouchableOpacity, StyleSheet,
  Text, KeyboardAvoidingView, Platform, ActivityIndicator,
  Alert, Modal, ScrollView,
} from 'react-native';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { Audio } from 'expo-av';
import { Ionicons } from '@expo/vector-icons';
import { format } from 'date-fns';
import * as Clipboard from 'expo-clipboard';
import {
  getConversation, getMessages, sendMessage, sendMedia,
  patchConversation, getAgents, getConversations, PIPELINE_STAGES,
  getConversationTasks, createConversationTask, patchTask, deleteTask,
  ConversationTask, editMessage, deleteMessage, forwardMessage,
  getQuickReplies,
} from '../../../services/api';
import { useConversationSocket } from '../../../hooks/useSocket';
import { useAuthStore } from '../../../store/auth';
import MessageBubble from '../../../components/MessageBubble';

export default function ConversationScreen() {
  const { id }                      = useLocalSearchParams<{ id: string }>();
  const convId                      = Number(id);
  const navigation                  = useNavigation();
  const { agent: currentAgent }     = useAuthStore();

  const [conversation, setConversation] = useState<any>(null);
  const [messages, setMessages]         = useState<any[]>([]);
  const [text, setText]                 = useState('');
  const [sending, setSending]           = useState(false);
  const [loading, setLoading]           = useState(true);
  const [showAssign, setShowAssign]     = useState(false);
  const [agents, setAgents]             = useState<any[]>([]);
  const [showStagePicker, setShowStagePicker] = useState(false);
  const [showAttach, setShowAttach]     = useState(false);
  const [uploading, setUploading]       = useState(false);
  const [isRecording, setIsRecording]   = useState(false);
  const [recSeconds, setRecSeconds]     = useState(0);

  // Recordatorios/tareas ligados a esta conversación (ej. "llamar mañana")
  const [tasks, setTasks]               = useState<ConversationTask[]>([]);
  const [showTasks, setShowTasks]       = useState(false);
  const [showNewTask, setShowNewTask]   = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [savingTask, setSavingTask]     = useState(false);

  // Editar/eliminar mensaje — solo admin (el backend rechaza con 403 si no lo es,
  // así que ni mostramos la opción a un agente normal).
  const isAdmin                         = currentAgent?.role === 'admin';
  const [actionMessage, setActionMessage] = useState<any>(null); // mensaje sobre el que se hizo long-press
  const [editingMessage, setEditingMessage] = useState<any>(null);
  const [editText, setEditText]         = useState('');
  const [savingEdit, setSavingEdit]     = useState(false);

  // Reenviar mensaje a otra conversación
  const [showForward, setShowForward]         = useState(false);
  const [forwardConvs, setForwardConvs]       = useState<any[]>([]);
  const [forwardSearch, setForwardSearch]     = useState('');
  const [forwarding, setForwarding]           = useState(false);
  const [forwardSourceMsg, setForwardSourceMsg] = useState<any>(null);

  // Plantillas rápidas de respuesta
  const [quickReplies, setQuickReplies] = useState<any[]>([]);
  const [showQR, setShowQR]             = useState(false);

  // Responder a un mensaje (quote/reply de WhatsApp)
  const [replyingTo, setReplyingTo] = useState<{
    wa_message_id: string; body: string | null; type: string;
    direction: 'inbound' | 'outbound'; sender_name?: string | null;
  } | null>(null);

  const flatRef = useRef<FlatList>(null);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Cargar conversación y mensajes
  const load = useCallback(async () => {
    try {
      const [conv, msgs, taskList, qrList] = await Promise.all([
        getConversation(convId),
        getMessages(convId),
        getConversationTasks(convId).catch(() => []),
        getQuickReplies().catch(() => []),
      ]);
      setConversation(conv);
      setMessages(msgs.messages);
      setTasks(taskList);
      setQuickReplies(qrList);
      navigation.setOptions({ title: conv.contact_name || conv.wa_id });
      // Scroll al último mensaje tras cargar
      setTimeout(() => flatRef.current?.scrollToEnd({ animated: false }), 200);
    } catch (err) {
      console.error('Error cargando conversación:', err);
    } finally {
      setLoading(false);
    }
  }, [convId]);

  useEffect(() => { load(); }, [load]);

  // Nuevos mensajes por WebSocket
  useConversationSocket(convId, (newMsg) => {
    setMessages(prev => {
      if (prev.find(m => m.id === newMsg.id)) return prev;
      // Si confirma un mensaje optimista (mismo cuerpo/dirección, aún "enviando"),
      // lo reemplaza en vez de duplicarlo.
      const withoutTemp = prev.filter(m => !(
        typeof m.id === 'string' && m.id.startsWith('tmp-') &&
        m.direction === newMsg.direction && m.body === newMsg.body
      ));
      return [...withoutTemp, newMsg];
    });
    setTimeout(() => flatRef.current?.scrollToEnd({ animated: true }), 100);
  }, load,
  // Edición/borrado puede venir de WaplyAdmin (web) mientras el móvil tiene
  // la misma conversación abierta — se refleja sin recargar la pantalla.
  (updatedMsg) => {
    setMessages(prev => prev.map(m => (m.id === updatedMsg.id ? updatedMsg : m)));
  },
  (info) => {
    setMessages(prev => prev.filter(m => m.id !== info.id));
  });

  // Enviar mensaje
  // Antes se esperaba la respuesta completa del servidor (que a su vez espera
  // a la API de WhatsApp) antes de pintar el mensaje, lo que se sentía lento.
  // Ahora se muestra de inmediato como "enviando" (optimista) y se reconcilia
  // con el mensaje real al llegar la respuesta — la latencia de red sigue
  // existiendo, pero ya no se nota en la interfaz.
  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;

    const tempId = `tmp-${Date.now()}`;
    const contextId = replyingTo?.wa_message_id || null;
    const quotedSnap = replyingTo ? {
      body: replyingTo.body, type: replyingTo.type,
      direction: replyingTo.direction, sender_name: replyingTo.sender_name,
    } : null;

    const optimisticMsg = {
      id: tempId,
      direction: 'outbound',
      type: 'text',
      body: trimmed,
      status: 'sending',
      sender_name: currentAgent?.name,
      created_at: new Date().toISOString(),
      quoted_message: quotedSnap,
    };

    setText('');
    setReplyingTo(null);
    setSending(true);
    setMessages(prev => [...prev, optimisticMsg]);
    setTimeout(() => flatRef.current?.scrollToEnd({ animated: true }), 50);

    try {
      const msg = await sendMessage(convId, { type: 'text', body: trimmed, context_id: contextId });
      setMessages(prev => {
        const withoutTemp = prev.filter(m => m.id !== tempId);
        return withoutTemp.find(m => m.id === msg.id) ? withoutTemp : [...withoutTemp, msg];
      });
    } catch (err: any) {
      const detail = err?.response?.data?.error || 'Error al enviar';
      Alert.alert('Error', detail);
      setMessages(prev => prev.filter(m => m.id !== tempId));
      setText(trimmed); // restaurar texto
      if (contextId) setReplyingTo(replyingTo); // restaurar la cita si falló
    } finally {
      setSending(false);
    }
  };

  // Long-press sobre un mensaje — abre el menú de acciones.
  // Responder está disponible para todos; editar/eliminar solo para admin.
  const handleLongPressMessage = (msg: any) => {
    // Solo mostrar el modal si hay algo que hacer (responder, o admin puede editar/borrar)
    if (!msg.wa_message_id && !isAdmin) return;
    setActionMessage(msg);
  };

  const canEditMessage = (msg: any) =>
    msg && msg.direction === 'outbound' && (!msg.type || msg.type === 'text');

  const openEditMessage = () => {
    if (!actionMessage) return;
    setEditingMessage(actionMessage);
    setEditText(actionMessage.body || '');
    setActionMessage(null);
  };

  const handleSaveEdit = async () => {
    if (!editingMessage || !editText.trim() || savingEdit) return;
    setSavingEdit(true);
    try {
      const updated = await editMessage(editingMessage.id, editText.trim());
      setMessages(prev => prev.map(m => (m.id === updated.id ? updated : m)));
      setEditingMessage(null);
    } catch (err: any) {
      Alert.alert('Error', err?.response?.data?.error || 'No se pudo editar el mensaje');
    } finally {
      setSavingEdit(false);
    }
  };

  const handleCopyMessage = async () => {
    if (!actionMessage?.body) return;
    await Clipboard.setStringAsync(actionMessage.body);
    setActionMessage(null);
    Alert.alert('✓ Copiado', 'Texto copiado al portapapeles');
  };

  const openForwardPicker = async () => {
    setForwardSourceMsg(actionMessage);
    setActionMessage(null);
    setForwardSearch('');
    try {
      const data = await getConversations({ status: 'all', page: 1 });
      const list = (data.conversations || data).filter((c: any) => c.id !== convId);
      setForwardConvs(list);
    } catch {
      setForwardConvs([]);
    }
    setShowForward(true);
  };

  const handleForwardTo = async (targetConvId: number, contactName: string) => {
    if (!forwardSourceMsg || forwarding) return;
    setForwarding(true);
    try {
      await forwardMessage(forwardSourceMsg.id, targetConvId);
      setShowForward(false);
      setForwardSourceMsg(null);
      Alert.alert('✓ Reenviado', `Mensaje reenviado a ${contactName}`);
    } catch (err: any) {
      Alert.alert('Error', err?.response?.data?.error || 'No se pudo reenviar el mensaje');
    } finally {
      setForwarding(false);
    }
  };

  const handleDeleteMessage = () => {
    if (!actionMessage) return;
    const msg = actionMessage;
    setActionMessage(null);
    Alert.alert(
      'Eliminar mensaje',
      '¿Seguro que quieres eliminar este mensaje del historial? Esto no afecta lo que ya se vio en WhatsApp.',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Eliminar',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteMessage(msg.id);
              setMessages(prev => prev.filter(m => m.id !== msg.id));
            } catch (err: any) {
              Alert.alert('Error', err?.response?.data?.error || 'No se pudo eliminar el mensaje');
            }
          },
        },
      ]
    );
  };

  // Asignar agente
  const handleAssign = async (agentId: number | null) => {
    try {
      const updated = await patchConversation(convId, { assigned_to: agentId });
      setConversation(updated);
      setShowAssign(false);
    } catch {
      Alert.alert('Error', 'No se pudo asignar el agente');
    }
  };

  // Cambiar estado
  const handleToggleStatus = async () => {
    const newStatus = conversation?.status === 'open' ? 'closed' : 'open';
    try {
      const updated = await patchConversation(convId, { status: newStatus });
      setConversation(updated);
    } catch {
      Alert.alert('Error', 'No se pudo cambiar el estado');
    }
  };

  // Cambiar etapa del pipeline de ventas
  const handleStageChange = async (stage: string) => {
    if (conversation?.pipeline_stage === stage) return;
    try {
      const updated = await patchConversation(convId, { pipeline_stage: stage });
      setConversation(updated);
    } catch {
      Alert.alert('Error', 'No se pudo cambiar la etapa');
    }
  };

  const openAssignModal = async () => {
    const data = await getAgents();
    setAgents(data);
    setShowAssign(true);
  };

  // ── Recordatorios de conversación ("quedamos en llamarle mañana") ────────────
  const pendingTasksCount = tasks.filter(t => t.status === 'pending').length;

  // Atajos de fecha: cubren los casos típicos sin necesitar un date picker nativo.
  const taskPresets: { label: string; getDate: () => Date }[] = [
    { label: 'En 1 hora',       getDate: () => new Date(Date.now() + 60 * 60 * 1000) },
    { label: 'En 3 horas',      getDate: () => new Date(Date.now() + 3 * 60 * 60 * 1000) },
    { label: 'Hoy a las 18:00', getDate: () => { const d = new Date(); d.setHours(18, 0, 0, 0); return d; } },
    { label: 'Mañana 9:00',     getDate: () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d; } },
    { label: 'Mañana 17:00',    getDate: () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(17, 0, 0, 0); return d; } },
  ];

  const handleCreateTask = async (dueDate: Date) => {
    const title = newTaskTitle.trim();
    if (!title || savingTask) return;
    setSavingTask(true);
    try {
      const task = await createConversationTask(convId, { title, due_at: dueDate.toISOString() });
      setTasks(prev => [...prev, task]);
      setNewTaskTitle('');
      setShowNewTask(false);
    } catch (err: any) {
      Alert.alert('Error', err?.response?.data?.error || 'No se pudo crear el recordatorio');
    } finally {
      setSavingTask(false);
    }
  };

  const handleToggleTaskDone = async (task: ConversationTask) => {
    const newStatus = task.status === 'done' ? 'pending' : 'done';
    try {
      const updated = await patchTask(task.id, { status: newStatus });
      setTasks(prev => prev.map(t => (t.id === task.id ? updated : t)));
    } catch {
      Alert.alert('Error', 'No se pudo actualizar el recordatorio');
    }
  };

  const handleDeleteTask = async (task: ConversationTask) => {
    try {
      await deleteTask(task.id);
      setTasks(prev => prev.filter(t => t.id !== task.id));
    } catch {
      Alert.alert('Error', 'No se pudo eliminar el recordatorio');
    }
  };

  // Subir y enviar un archivo (foto/video/documento) ya seleccionado
  const uploadAndSend = async (file: { uri: string; name: string; type: string }) => {
    setUploading(true);
    try {
      const msg = await sendMedia(convId, file);
      setMessages(prev => prev.find(m => m.id === msg.id) ? prev : [...prev, msg]);
      setTimeout(() => flatRef.current?.scrollToEnd({ animated: true }), 100);
    } catch (err: any) {
      const detail = err?.response?.data?.error || 'No se pudo enviar el archivo';
      Alert.alert('Error', detail);
    } finally {
      setUploading(false);
    }
  };

  const pickFromGallery = async () => {
    setShowAttach(false);
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return Alert.alert('Permiso requerido', 'Necesitamos acceso a tus fotos');
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.All,
      quality: 0.8,
    });
    if (result.canceled || !result.assets?.length) return;
    const asset = result.assets[0];
    const name = asset.fileName || asset.uri.split('/').pop() || `media_${Date.now()}`;
    const type = asset.mimeType || (asset.type === 'video' ? 'video/mp4' : 'image/jpeg');
    uploadAndSend({ uri: asset.uri, name, type });
  };

  const pickFromCamera = async () => {
    setShowAttach(false);
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return Alert.alert('Permiso requerido', 'Necesitamos acceso a tu cámara');
    const result = await ImagePicker.launchCameraAsync({ quality: 0.8 });
    if (result.canceled || !result.assets?.length) return;
    const asset = result.assets[0];
    const name = asset.fileName || asset.uri.split('/').pop() || `foto_${Date.now()}.jpg`;
    uploadAndSend({ uri: asset.uri, name, type: asset.mimeType || 'image/jpeg' });
  };

  const pickDocument = async () => {
    setShowAttach(false);
    const result = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true });
    if (result.canceled || !result.assets?.length) return;
    const asset = result.assets[0];
    uploadAndSend({
      uri: asset.uri,
      name: asset.name || `archivo_${Date.now()}`,
      type: asset.mimeType || 'application/octet-stream',
    });
  };

  // Notas de voz: grabar con expo-av y enviarlas igual que cualquier otro adjunto
  // (reusa sendMedia/uploadAndSend — el backend ya acepta audio sin cambios).
  const startRecording = async () => {
    try {
      const perm = await Audio.requestPermissionsAsync();
      if (!perm.granted) return Alert.alert('Permiso requerido', 'Necesitamos acceso al micrófono para grabar notas de voz');
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const { recording } = await Audio.Recording.createAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      recordingRef.current = recording;
      setRecSeconds(0);
      setIsRecording(true);
      recTimerRef.current = setInterval(() => setRecSeconds(s => s + 1), 1000);
    } catch {
      Alert.alert('Error', 'No se pudo iniciar la grabación');
    }
  };

  const stopRecording = async (send: boolean) => {
    if (recTimerRef.current) clearInterval(recTimerRef.current);
    const recording = recordingRef.current;
    recordingRef.current = null;
    setIsRecording(false);
    setRecSeconds(0);
    if (!recording) return;
    try {
      await recording.stopAndUnloadAsync();
      const uri = recording.getURI();
      if (send && uri) {
        // 'audio/mp4' (no 'audio/m4a', que no es un MIME válido para la API de WhatsApp).
        // El contenedor real que genera expo-av en HIGH_QUALITY es MPEG-4/AAC.
        uploadAndSend({ uri, name: `nota_de_voz_${Date.now()}.m4a`, type: 'audio/mp4' });
      }
    } catch {
      // si falla al detener, simplemente no se envía
    }
  };

  const fmtRecTime = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#128C7E" />
      </View>
    );
  }

  const isClosed = conversation?.status === 'closed';
  const currentStage = PIPELINE_STAGES.find(
    s => s.value === (conversation?.pipeline_stage || 'abierto')
  ) || PIPELINE_STAGES[0];

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : 0}
    >
      {/* Barra de contexto */}
      {conversation && (
        <View style={styles.contextBar}>
          <View style={styles.contextInfo}>
            <Text style={styles.contextPhone}>📱 {conversation.wa_id}</Text>
            <Text style={styles.contextStatus}>
              Estado: <Text style={[styles.bold, isClosed ? styles.closed : styles.open]}>
                {isClosed ? 'Cerrado' : 'Abierto'}
              </Text>
            </Text>
          </View>
          <View style={styles.contextActions}>
            <TouchableOpacity
              style={[styles.stagePill, { backgroundColor: currentStage.color }]}
              onPress={() => setShowStagePicker(true)}
            >
              <Text style={styles.stagePillText}>{currentStage.label}</Text>
              <Text style={styles.stagePillCaret}>▾</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.actionBtn} onPress={openAssignModal}>
              <Text style={styles.actionBtnText}>
                {conversation.agent_name ? `👤 ${conversation.agent_name.split(' ')[0]}` : '+ Asignar'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.actionBtn} onPress={() => setShowTasks(true)}>
              <Text style={styles.actionBtnText}>
                🔔{pendingTasksCount > 0 ? ` ${pendingTasksCount}` : ''}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionBtn, isClosed ? styles.actionBtnGreen : styles.actionBtnRed]}
              onPress={handleToggleStatus}
            >
              <Text style={[styles.actionBtnText, { color: '#fff' }]}>
                {isClosed ? '↩ Reabrir' : '✓ Cerrar'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Lista de mensajes */}
      <FlatList
        ref={flatRef}
        data={messages}
        keyExtractor={item => String(item.id)}
        renderItem={({ item, index }) => {
          const prev = messages[index - 1];
          const parseTs = (ts: string | null | undefined) => {
            if (!ts) return null;
            return new Date(/[Z+]/.test(ts) ? ts : ts + 'Z');
          };
          const d = parseTs(item.created_at);
          const dPrev = parseTs(prev?.created_at);
          const showSep = !dPrev || (d && d.toDateString() !== dPrev.toDateString());
          const now = new Date();
          const yest = new Date(now); yest.setDate(yest.getDate() - 1);
          const sepLabel = !d ? '' :
            d.toDateString() === now.toDateString()  ? 'Hoy' :
            d.toDateString() === yest.toDateString() ? 'Ayer' :
            d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
          return (
            <>
              {showSep && d && (
                <View style={styles.daySepRow}>
                  <View style={styles.daySepLine} />
                  <Text style={styles.daySepText}>{sepLabel}</Text>
                  <View style={styles.daySepLine} />
                </View>
              )}
              <MessageBubble
                message={item}
                contactName={conversation?.contact_name}
                onLongPress={handleLongPressMessage}
              />
            </>
          );
        }}
        contentContainerStyle={styles.messagesList}
        onLayout={() => flatRef.current?.scrollToEnd({ animated: false })}
        onContentSizeChange={() => flatRef.current?.scrollToEnd({ animated: false })}
        ListEmptyComponent={
          <View style={styles.emptyMessages}>
            <Text style={styles.emptyText}>No hay mensajes aún</Text>
          </View>
        }
        style={styles.messagesContainer}
      />

      {/* Barra de preview de respuesta */}
      {replyingTo && (
        <View style={styles.replyBar}>
          <View style={styles.replyBarLine} />
          <View style={{ flex: 1 }}>
            <Text style={styles.replyBarSender} numberOfLines={1}>
              Respondiendo a {replyingTo.direction === 'inbound' ? (conversation?.contact_name || 'Cliente') : 'ti mismo'}
            </Text>
            <Text style={styles.replyBarBody} numberOfLines={1}>
              {replyingTo.type !== 'text'
                ? (replyingTo.type === 'image' ? '📷 Imagen' : replyingTo.type === 'video' ? '🎥 Video' : replyingTo.type === 'audio' ? '🎤 Audio' : '📎 Archivo')
                : (replyingTo.body || '')}
            </Text>
          </View>
          <TouchableOpacity onPress={() => setReplyingTo(null)} style={{ padding: 8 }}>
            <Ionicons name="close" size={18} color="#888" />
          </TouchableOpacity>
        </View>
      )}

      {/* Input */}
      {isRecording ? (
        <View style={styles.inputRow}>
          <TouchableOpacity style={styles.attachBtn} onPress={() => stopRecording(false)}>
            <Text style={styles.attachIcon}>🗑</Text>
          </TouchableOpacity>
          <View style={styles.recordingBar}>
            <View style={styles.recordingDot} />
            <Text style={styles.recordingText}>Grabando… {fmtRecTime(recSeconds)}</Text>
          </View>
          <TouchableOpacity style={styles.sendBtn} onPress={() => stopRecording(true)}>
            <Text style={styles.sendIcon}>➤</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.inputRow}>
          <TouchableOpacity
            style={[styles.attachBtn, isClosed && styles.sendBtnDisabled]}
            onPress={() => setShowAttach(true)}
            disabled={isClosed || uploading}
          >
            {uploading
              ? <ActivityIndicator size="small" color="#666" />
              : <Text style={styles.attachIcon}>📎</Text>
            }
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.attachBtn, isClosed && styles.sendBtnDisabled]}
            onPress={() => setShowQR(true)}
            disabled={isClosed}
          >
            <Text style={styles.attachIcon}>⚡</Text>
          </TouchableOpacity>
          <TextInput
            style={styles.input}
            value={text}
            onChangeText={setText}
            placeholder={isClosed ? 'Conversación cerrada' : 'Escribe un mensaje...'}
            placeholderTextColor="#aaa"
            multiline
            maxLength={4096}
            editable={!isClosed}
            returnKeyType="default"
          />
          {text.trim() ? (
            <TouchableOpacity
              style={[styles.sendBtn, (sending || isClosed) && styles.sendBtnDisabled]}
              onPress={handleSend}
              disabled={sending || isClosed}
            >
              {sending
                ? <ActivityIndicator size="small" color="#fff" />
                : <Text style={styles.sendIcon}>➤</Text>
              }
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[styles.sendBtn, isClosed && styles.sendBtnDisabled]}
              onPress={startRecording}
              disabled={isClosed}
            >
              <Ionicons name="mic" size={19} color="#fff" />
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* Modal selector de etapa */}
      <Modal visible={showStagePicker} transparent animationType="fade">
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setShowStagePicker(false)}
        >
          <View style={styles.stageModalBox}>
            <Text style={styles.modalTitle}>Etapa del pipeline</Text>
            {PIPELINE_STAGES.map(stage => {
              const active = (conversation?.pipeline_stage || 'abierto') === stage.value;
              return (
                <TouchableOpacity
                  key={stage.value}
                  style={styles.stageOptionRow}
                  onPress={() => { handleStageChange(stage.value); setShowStagePicker(false); }}
                >
                  <View style={[styles.stageDot, { backgroundColor: stage.color }]} />
                  <Text style={[styles.stageOptionText, active && styles.bold]}>{stage.label}</Text>
                  {active && <Text style={styles.stageCheck}>✓</Text>}
                </TouchableOpacity>
              );
            })}
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Modal adjuntar */}
      <Modal visible={showAttach} transparent animationType="slide">
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setShowAttach(false)}
        >
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>Adjuntar</Text>
            <TouchableOpacity style={styles.attachOptionRow} onPress={pickFromGallery}>
              <Text style={styles.attachOptionIcon}>🖼️</Text>
              <Text style={styles.attachOptionText}>Foto o video de la galería</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.attachOptionRow} onPress={pickFromCamera}>
              <Text style={styles.attachOptionIcon}>📷</Text>
              <Text style={styles.attachOptionText}>Tomar foto</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.attachOptionRow} onPress={pickDocument}>
              <Text style={styles.attachOptionIcon}>📄</Text>
              <Text style={styles.attachOptionText}>Documento</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.modalClose} onPress={() => setShowAttach(false)}>
              <Text style={styles.modalCloseText}>Cancelar</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Modal recordatorios/tareas */}
      <Modal visible={showTasks} transparent animationType="slide" onRequestClose={() => setShowTasks(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>Recordatorios</Text>
            <ScrollView style={{ maxHeight: 300 }}>
              {tasks.length === 0 && !showNewTask && (
                <Text style={styles.emptyTasksText}>Sin recordatorios todavía</Text>
              )}
              {tasks
                .slice()
                .sort((a, b) => Number(a.status === 'done') - Number(b.status === 'done') || new Date(a.due_at).getTime() - new Date(b.due_at).getTime())
                .map(task => (
                  <View key={task.id} style={styles.taskRow}>
                    <TouchableOpacity style={styles.taskCheck} onPress={() => handleToggleTaskDone(task)}>
                      <Ionicons
                        name={task.status === 'done' ? 'checkmark-circle' : 'ellipse-outline'}
                        size={22}
                        color={task.status === 'done' ? '#25D366' : '#aaa'}
                      />
                    </TouchableOpacity>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.taskTitle, task.status === 'done' && styles.taskTitleDone]}>
                        {task.title}
                      </Text>
                      <Text style={styles.taskDue}>{format(new Date(task.due_at), "d MMM, HH:mm")}</Text>
                    </View>
                    <TouchableOpacity onPress={() => handleDeleteTask(task)} style={{ padding: 4 }}>
                      <Ionicons name="trash-outline" size={18} color="#c00" />
                    </TouchableOpacity>
                  </View>
                ))}
            </ScrollView>

            {showNewTask ? (
              <View style={styles.newTaskBox}>
                <TextInput
                  style={styles.newTaskInput}
                  placeholder="Ej: Llamar para confirmar la cita"
                  placeholderTextColor="#aaa"
                  value={newTaskTitle}
                  onChangeText={setNewTaskTitle}
                  autoFocus
                />
                <View style={styles.presetsRow}>
                  {taskPresets.map(p => (
                    <TouchableOpacity
                      key={p.label}
                      style={[styles.presetChip, (!newTaskTitle.trim() || savingTask) && { opacity: 0.5 }]}
                      disabled={!newTaskTitle.trim() || savingTask}
                      onPress={() => handleCreateTask(p.getDate())}
                    >
                      <Text style={styles.presetChipText}>{p.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <TouchableOpacity onPress={() => { setShowNewTask(false); setNewTaskTitle(''); }}>
                  <Text style={[styles.modalCloseText, { textAlign: 'center', marginTop: 8 }]}>Cancelar</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <TouchableOpacity style={styles.newTaskBtn} onPress={() => setShowNewTask(true)}>
                <Text style={styles.newTaskBtnText}>+ Nuevo recordatorio</Text>
              </TouchableOpacity>
            )}

            <TouchableOpacity style={styles.modalClose} onPress={() => { setShowTasks(false); setShowNewTask(false); }}>
              <Text style={styles.modalCloseText}>Cerrar</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Modal asignación */}
      <Modal visible={showAssign} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>Asignar conversación</Text>
            <ScrollView>
              <TouchableOpacity
                style={styles.agentRow}
                onPress={() => handleAssign(null)}
              >
                <Text style={styles.agentName}>Sin asignar</Text>
              </TouchableOpacity>
              {agents.map(a => (
                <TouchableOpacity
                  key={a.id}
                  style={[
                    styles.agentRow,
                    conversation?.agent_id === a.id && styles.agentRowActive,
                  ]}
                  onPress={() => handleAssign(a.id)}
                >
                  <Text style={styles.agentName}>{a.name}</Text>
                  <Text style={styles.agentEmail}>{a.email}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <TouchableOpacity style={styles.modalClose} onPress={() => setShowAssign(false)}>
              <Text style={styles.modalCloseText}>Cancelar</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Modal acciones de mensaje (responder/editar/eliminar) */}
      <Modal visible={!!actionMessage} transparent animationType="fade" onRequestClose={() => setActionMessage(null)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setActionMessage(null)}>
          <View style={styles.stageModalBox}>
            {/* Responder siempre disponible si el mensaje tiene wa_message_id */}
            {actionMessage?.wa_message_id && (
              <TouchableOpacity style={styles.stageOptionRow} onPress={() => {
                setReplyingTo({
                  wa_message_id: actionMessage.wa_message_id,
                  body: actionMessage.body,
                  type: actionMessage.type,
                  direction: actionMessage.direction,
                  sender_name: actionMessage.sender_name,
                });
                setActionMessage(null);
              }}>
                <Ionicons name="return-down-back-outline" size={18} color="#128C7E" />
                <Text style={[styles.stageOptionText, { color: '#128C7E' }]}>Responder</Text>
              </TouchableOpacity>
            )}
            {/* Copiar texto — solo si el mensaje tiene cuerpo de texto */}
            {!!actionMessage?.body && actionMessage?.type !== 'image' && actionMessage?.type !== 'video' && actionMessage?.type !== 'audio' && (
              <TouchableOpacity style={styles.stageOptionRow} onPress={handleCopyMessage}>
                <Ionicons name="copy-outline" size={18} color="#555" />
                <Text style={styles.stageOptionText}>Copiar texto</Text>
              </TouchableOpacity>
            )}
            {/* Reenviar — texto e imágenes/archivos con media_url */}
            {(!!actionMessage?.body || !!actionMessage?.media_url) && (
              <TouchableOpacity style={styles.stageOptionRow} onPress={openForwardPicker}>
                <Ionicons name="arrow-redo-outline" size={18} color="#555" />
                <Text style={styles.stageOptionText}>Reenviar</Text>
              </TouchableOpacity>
            )}
            {isAdmin && canEditMessage(actionMessage) && (
              <TouchableOpacity style={styles.stageOptionRow} onPress={openEditMessage}>
                <Ionicons name="pencil-outline" size={18} color="#111" />
                <Text style={styles.stageOptionText}>Editar mensaje</Text>
              </TouchableOpacity>
            )}
            {isAdmin && (
              <TouchableOpacity style={styles.stageOptionRow} onPress={handleDeleteMessage}>
                <Ionicons name="trash-outline" size={18} color="#e53e3e" />
                <Text style={[styles.stageOptionText, { color: '#e53e3e' }]}>Eliminar mensaje</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={styles.stageOptionRow} onPress={() => setActionMessage(null)}>
              <Text style={[styles.stageOptionText, { color: '#888' }]}>Cancelar</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Modal reenviar mensaje — picker de conversaciones */}
      <Modal visible={showForward} transparent animationType="slide" onRequestClose={() => setShowForward(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalBox, { maxHeight: '75%' }]}>
            <Text style={styles.modalTitle}>Reenviar a...</Text>
            <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
              <TextInput
                style={[styles.newTaskInput, { marginBottom: 0 }]}
                placeholder="Buscar contacto..."
                placeholderTextColor="#aaa"
                value={forwardSearch}
                onChangeText={setForwardSearch}
                autoFocus
              />
            </View>
            <ScrollView>
              {forwardConvs
                .filter(c => {
                  const q = forwardSearch.toLowerCase();
                  return !q || (c.contact_name || '').toLowerCase().includes(q) || (c.wa_id || '').includes(q);
                })
                .slice(0, 30)
                .map(c => (
                  <TouchableOpacity
                    key={c.id}
                    style={styles.agentRow}
                    onPress={() => handleForwardTo(c.id, c.contact_name || c.wa_id)}
                    disabled={forwarding}
                  >
                    <Text style={styles.agentName}>{c.contact_name || c.wa_id}</Text>
                    {c.last_message ? (
                      <Text style={styles.agentEmail} numberOfLines={1}>{c.last_message}</Text>
                    ) : null}
                  </TouchableOpacity>
                ))}
              {forwardConvs.length === 0 && (
                <Text style={[styles.emptyTasksText, { padding: 20 }]}>Sin conversaciones</Text>
              )}
            </ScrollView>
            {forwarding && (
              <View style={{ padding: 12, alignItems: 'center' }}>
                <ActivityIndicator size="small" color="#128C7E" />
              </View>
            )}
            <TouchableOpacity style={styles.modalClose} onPress={() => { setShowForward(false); setForwardSourceMsg(null); }}>
              <Text style={styles.modalCloseText}>Cancelar</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Modal editar mensaje */}
      <Modal visible={!!editingMessage} transparent animationType="slide" onRequestClose={() => setEditingMessage(null)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>Editar mensaje</Text>
            <View style={{ paddingHorizontal: 20, paddingVertical: 14 }}>
              <TextInput
                style={[styles.newTaskInput, { minHeight: 80 }]}
                value={editText}
                onChangeText={setEditText}
                multiline
                autoFocus
                placeholder="Texto del mensaje"
                placeholderTextColor="#aaa"
              />
              <TouchableOpacity
                style={[styles.newTaskBtn, { backgroundColor: '#128C7E', borderRadius: 10, marginTop: 12, borderTopWidth: 0 }, (!editText.trim() || savingEdit) && { opacity: 0.5 }]}
                onPress={handleSaveEdit}
                disabled={!editText.trim() || savingEdit}
              >
                {savingEdit
                  ? <ActivityIndicator size="small" color="#fff" />
                  : <Text style={[styles.newTaskBtnText, { color: '#fff' }]}>Guardar</Text>
                }
              </TouchableOpacity>
            </View>
            <TouchableOpacity style={styles.modalClose} onPress={() => setEditingMessage(null)}>
              <Text style={styles.modalCloseText}>Cancelar</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Modal plantillas rápidas */}
      <Modal visible={showQR} transparent animationType="slide" onRequestClose={() => setShowQR(false)}>
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setShowQR(false)}
        >
          <View style={[styles.modalBox, { maxHeight: '60%' }]}>
            <Text style={styles.modalTitle}>⚡ Plantillas rápidas</Text>
            <ScrollView>
              {quickReplies.map(qr => (
                <TouchableOpacity
                  key={qr.id}
                  style={styles.agentRow}
                  onPress={() => { setText(qr.body); setShowQR(false); }}
                >
                  <Text style={[styles.agentName, { fontWeight: '600' }]}>{qr.name}</Text>
                  <Text style={styles.agentEmail} numberOfLines={2}>{qr.body}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <TouchableOpacity style={styles.modalClose} onPress={() => setShowQR(false)}>
              <Text style={styles.modalCloseText}>Cancelar</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container:  { flex: 1, backgroundColor: '#ECE5DD' },
  center:     { flex: 1, alignItems: 'center', justifyContent: 'center' },

  contextBar: {
    backgroundColor: '#075E54',
    paddingHorizontal: 16,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  contextInfo:    { flex: 1 },
  contextPhone:   { color: 'rgba(255,255,255,0.8)', fontSize: 12 },
  contextStatus:  { color: 'rgba(255,255,255,0.8)', fontSize: 12, marginTop: 2 },
  bold:           { fontWeight: '700' },
  open:           { color: '#4ade80' },
  closed:         { color: '#f87171' },

  contextActions: { flexDirection: 'row', gap: 6, alignItems: 'center' },
  actionBtn: {
    backgroundColor: 'rgba(255,255,255,0.15)',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
  },
  actionBtnGreen: { backgroundColor: '#25D366' },
  actionBtnRed:   { backgroundColor: '#e53e3e' },
  actionBtnText:  { color: '#fff', fontSize: 12, fontWeight: '600' },

  stagePill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
    gap: 4,
  },
  stagePillText:  { color: '#fff', fontSize: 12, fontWeight: '700' },
  stagePillCaret: { color: 'rgba(255,255,255,0.85)', fontSize: 10 },

  stageModalBox: {
    backgroundColor: '#fff',
    borderRadius: 14,
    paddingVertical: 8,
    marginHorizontal: 32,
    alignSelf: 'center',
    width: '80%',
  },
  stageOptionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingVertical: 13,
    gap: 10,
  },
  stageDot:        { width: 10, height: 10, borderRadius: 5 },
  stageOptionText: { fontSize: 15, color: '#111', flex: 1 },
  stageCheck:      { fontSize: 15, color: '#25D366', fontWeight: '700' },

  attachBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  attachIcon: { fontSize: 20 },
  attachOptionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#f0f0f0',
    gap: 12,
  },
  attachOptionIcon: { fontSize: 22 },
  attachOptionText: { fontSize: 15, color: '#111', fontWeight: '500' },

  messagesContainer:  { flex: 1 },
  messagesList:       { paddingVertical: 12 },

  daySepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 8,
    paddingHorizontal: 16,
    gap: 8,
  },
  daySepLine: {
    flex: 1,
    height: 1,
    backgroundColor: 'rgba(0,0,0,0.1)',
  },
  daySepText: {
    fontSize: 11,
    color: '#888',
    backgroundColor: '#ddd8d0',
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 10,
    overflow: 'hidden',
  },
  emptyMessages:      { flex: 1, alignItems: 'center', paddingTop: 60 },
  emptyText:          { color: '#888', fontSize: 15 },

  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 8,
    paddingVertical: 8,
    backgroundColor: '#f0f0f0',
    gap: 8,
  },
  input: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 24,
    paddingHorizontal: 16,
    paddingVertical: Platform.OS === 'ios' ? 10 : 8,
    fontSize: 15,
    maxHeight: 120,
    color: '#111',
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#25D366',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnDisabled: { backgroundColor: '#aaa' },
  sendIcon: { color: '#fff', fontSize: 18, marginLeft: 2 },

  replyBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f7f7f7',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#ddd',
    paddingHorizontal: 12,
    paddingVertical: 6,
    gap: 8,
  },
  replyBarLine: {
    width: 3,
    alignSelf: 'stretch',
    backgroundColor: '#128C7E',
    borderRadius: 2,
  },
  replyBarSender: {
    fontSize: 12,
    fontWeight: '700',
    color: '#128C7E',
  },
  replyBarBody: {
    fontSize: 12,
    color: '#666',
    marginTop: 1,
  },

  recordingBar: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 24,
    paddingHorizontal: 16,
    height: 44,
    gap: 8,
  },
  recordingDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#e53e3e',
  },
  recordingText: { fontSize: 14, color: '#111' },

  // Modal
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
    maxHeight: '60%',
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: '700',
    textAlign: 'center',
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e0e0e0',
  },
  agentRow: {
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#f0f0f0',
  },
  agentRowActive: { backgroundColor: '#e8f5e9' },
  agentName:  { fontSize: 15, fontWeight: '600', color: '#111' },
  agentEmail: { fontSize: 13, color: '#888', marginTop: 2 },
  modalClose: {
    padding: 16,
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e0e0e0',
  },
  modalCloseText: { color: '#e53e3e', fontSize: 15, fontWeight: '600' },

  emptyTasksText: { textAlign: 'center', color: '#888', paddingVertical: 24, fontSize: 14 },
  taskRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 12,
    gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#f0f0f0',
  },
  taskCheck:      { padding: 2 },
  taskTitle:      { fontSize: 15, color: '#111', fontWeight: '500' },
  taskTitleDone:  { color: '#999', textDecorationLine: 'line-through' },
  taskDue:        { fontSize: 12, color: '#888', marginTop: 2 },

  newTaskBtn: {
    paddingVertical: 14,
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e0e0e0',
  },
  newTaskBtnText: { color: '#128C7E', fontSize: 15, fontWeight: '600' },

  newTaskBox: {
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e0e0e0',
  },
  newTaskInput: {
    backgroundColor: '#f0f0f0',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    color: '#111',
  },
  presetsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 10,
  },
  presetChip: {
    backgroundColor: '#e8f5e9',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 14,
  },
  presetChipText: { color: '#128C7E', fontSize: 13, fontWeight: '600' },
});
