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
import {
  getConversation, getMessages, sendMessage, sendMedia,
  patchConversation, getAgents, PIPELINE_STAGES,
  getConversationTasks, createConversationTask, patchTask, deleteTask,
  ConversationTask,
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

  const flatRef = useRef<FlatList>(null);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Cargar conversación y mensajes
  const load = useCallback(async () => {
    try {
      const [conv, msgs, taskList] = await Promise.all([
        getConversation(convId),
        getMessages(convId),
        getConversationTasks(convId).catch(() => []),
      ]);
      setConversation(conv);
      setMessages(msgs.messages);
      setTasks(taskList);
      navigation.setOptions({ title: conv.contact_name || conv.wa_id });
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
  }, load);

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
    const optimisticMsg = {
      id: tempId,
      direction: 'outbound',
      type: 'text',
      body: trimmed,
      status: 'sending',
      sender_name: currentAgent?.name,
      created_at: new Date().toISOString(),
    };

    setText('');
    setSending(true);
    setMessages(prev => [...prev, optimisticMsg]);
    setTimeout(() => flatRef.current?.scrollToEnd({ animated: true }), 50);

    try {
      const msg = await sendMessage(convId, { type: 'text', body: trimmed });
      setMessages(prev => {
        const withoutTemp = prev.filter(m => m.id !== tempId);
        return withoutTemp.find(m => m.id === msg.id) ? withoutTemp : [...withoutTemp, msg];
      });
    } catch (err: any) {
      const detail = err?.response?.data?.error || 'Error al enviar';
      Alert.alert('Error', detail);
      setMessages(prev => prev.filter(m => m.id !== tempId));
      setText(trimmed); // restaurar texto
    } finally {
      setSending(false);
    }
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
        renderItem={({ item }) => <MessageBubble message={item} />}
        contentContainerStyle={styles.messagesList}
        onLayout={() => flatRef.current?.scrollToEnd({ animated: false })}
        ListEmptyComponent={
          <View style={styles.emptyMessages}>
            <Text style={styles.emptyText}>No hay mensajes aún</Text>
          </View>
        }
        style={styles.messagesContainer}
      />

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
