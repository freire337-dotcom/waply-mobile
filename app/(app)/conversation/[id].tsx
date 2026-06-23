import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, FlatList, TextInput, TouchableOpacity, StyleSheet,
  Text, KeyboardAvoidingView, Platform, ActivityIndicator,
  Alert, Modal, ScrollView,
} from 'react-native';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import {
  getConversation, getMessages, sendMessage,
  patchConversation, getAgents, PIPELINE_STAGES,
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

  const flatRef = useRef<FlatList>(null);

  // Cargar conversación y mensajes
  const load = useCallback(async () => {
    try {
      const [conv, msgs] = await Promise.all([
        getConversation(convId),
        getMessages(convId),
      ]);
      setConversation(conv);
      setMessages(msgs.messages);
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
      return [...prev, newMsg];
    });
    setTimeout(() => flatRef.current?.scrollToEnd({ animated: true }), 100);
  });

  // Enviar mensaje
  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;

    setText('');
    setSending(true);
    try {
      const msg = await sendMessage(convId, { type: 'text', body: trimmed });
      setMessages(prev => prev.find(m => m.id === msg.id) ? prev : [...prev, msg]);
      setTimeout(() => flatRef.current?.scrollToEnd({ animated: true }), 100);
    } catch (err: any) {
      const detail = err?.response?.data?.error || 'Error al enviar';
      Alert.alert('Error', detail);
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

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#128C7E" />
      </View>
    );
  }

  const isClosed = conversation?.status === 'closed';

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
            <TouchableOpacity style={styles.actionBtn} onPress={openAssignModal}>
              <Text style={styles.actionBtnText}>
                {conversation.agent_name ? `👤 ${conversation.agent_name.split(' ')[0]}` : '+ Asignar'}
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

      {/* Etapa del pipeline de ventas */}
      {conversation && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.stageBar}
          contentContainerStyle={styles.stageBarContent}
        >
          {PIPELINE_STAGES.map(stage => {
            const active = (conversation.pipeline_stage || 'abierto') === stage.value;
            return (
              <TouchableOpacity
                key={stage.value}
                style={[
                  styles.stageChip,
                  { borderColor: stage.color },
                  active && { backgroundColor: stage.color },
                ]}
                onPress={() => handleStageChange(stage.value)}
              >
                <Text style={[styles.stageChipText, active ? { color: '#fff' } : { color: stage.color }]}>
                  {stage.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
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
      <View style={styles.inputRow}>
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
        <TouchableOpacity
          style={[styles.sendBtn, (!text.trim() || sending || isClosed) && styles.sendBtnDisabled]}
          onPress={handleSend}
          disabled={!text.trim() || sending || isClosed}
        >
          {sending
            ? <ActivityIndicator size="small" color="#fff" />
            : <Text style={styles.sendIcon}>➤</Text>
          }
        </TouchableOpacity>
      </View>

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

  contextActions: { flexDirection: 'row', gap: 6 },
  actionBtn: {
    backgroundColor: 'rgba(255,255,255,0.15)',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
  },
  actionBtnGreen: { backgroundColor: '#25D366' },
  actionBtnRed:   { backgroundColor: '#e53e3e' },
  actionBtnText:  { color: '#fff', fontSize: 12, fontWeight: '600' },

  stageBar: {
    backgroundColor: '#fff',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e0e0e0',
  },
  stageBarContent: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 6,
  },
  stageChip: {
    borderWidth: 1.5,
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 5,
    marginRight: 6,
  },
  stageChipText: { fontSize: 12, fontWeight: '600' },

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
});
