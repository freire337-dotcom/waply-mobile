import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';

// En desarrollo local, define EXPO_PUBLIC_API_URL=http://TU_IP_LOCAL:3001 en un .env
// Sin esa variable, usa el backend de producción en Railway.
export const API_BASE = process.env.EXPO_PUBLIC_API_URL || 'https://waply-backend-production.up.railway.app';

const api = axios.create({ baseURL: `${API_BASE}/api` });

// Inyectar token JWT automáticamente
api.interceptors.request.use(async (config) => {
  const token = await AsyncStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// ── Auth ──────────────────────────────────────────────────────────────────────
export const login = (email: string, password: string, tenant_slug: string) =>
  api.post('/auth/login', { email, password, tenant_slug }).then(r => r.data);

export const getMe = () =>
  api.get('/auth/me').then(r => r.data.agent);

export const saveFcmToken = (fcm_token: string) =>
  api.post('/auth/fcm-token', { fcm_token });

// ── Conversaciones ────────────────────────────────────────────────────────────
export type ConvStatus = 'open' | 'closed' | 'pending' | 'all';

export const getConversations = (params?: {
  status?: ConvStatus;
  assigned_to?: 'me' | 'unassigned';
  page?: number;
  limit?: number;
}) => api.get('/conversations', { params }).then(r => r.data);

export const getConversation = (id: number) =>
  api.get(`/conversations/${id}`).then(r => r.data.conversation);

export const patchConversation = (id: number, data: { assigned_to?: number | null; status?: string; pipeline_stage?: string }) =>
  api.patch(`/conversations/${id}`, data).then(r => r.data.conversation);

// Etapas fijas del pipeline de ventas (campo independiente de ConvStatus)
export const PIPELINE_STAGES: { value: string; label: string; color: string }[] = [
  { value: 'abierto',       label: 'Abierto',       color: '#3b82f6' },
  { value: 'contactado',    label: 'Contactado',    color: '#8b5cf6' },
  { value: 'negociacion',   label: 'Negociación',   color: '#f59e0b' },
  { value: 'pendiente',     label: 'Pendiente',     color: '#f97316' },
  { value: 'venta_cerrada', label: 'Venta cerrada', color: '#22c55e' },
  { value: 'venta_perdida', label: 'Venta perdida', color: '#ef4444' },
];

export const getPipeline = () =>
  api.get('/conversations/pipeline').then(r => r.data);

// ── Mensajes ──────────────────────────────────────────────────────────────────
export const getMessages = (convId: number, page = 1, limit = 200) =>
  api.get(`/conversations/${convId}/messages`, { params: { page, limit } }).then(r => r.data);

export const sendMessage = (convId: number, payload: {
  type?: 'text' | 'template';
  body?: string;
  context_id?: string | null; // wa_message_id del mensaje al que se responde (reply/quote)
  is_internal?: boolean;      // true = nota interna (solo visible para agentes)
  template_name?: string;
  template_language?: string;
  template_components?: unknown[];
}) => api.post(`/conversations/${convId}/messages`, payload).then(r => r.data.message);

// Envía un archivo (imagen/video/documento) como FormData multipart.
// `file` es { uri, name, type } tal como lo devuelven expo-image-picker / expo-document-picker.
export const sendMedia = (
  convId: number,
  file: { uri: string; name: string; type: string },
  caption?: string
) => {
  const form = new FormData();
  form.append('file', { uri: file.uri, name: file.name, type: file.type } as any);
  if (caption) form.append('caption', caption);
  return api.post(`/conversations/${convId}/messages/media`, form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }).then(r => r.data.message);
};

// URL autenticada para ver/descargar un media de WhatsApp (imagen, documento, audio, video).
// El backend actúa de proxy hacia Meta porque sus URLs firmadas requieren un header Authorization
// que un <Image>/navegador no puede enviar, así que pasamos el JWT como query param.
export const getMediaUrl = async (mediaId: string) => {
  const token = await AsyncStorage.getItem('token');
  return `${API_BASE}/api/media/${mediaId}?token=${token}`;
};

// Editar/eliminar mensaje (solo admin — el backend devuelve 403 si no lo es).
export const editMessage = (id: number, body: string) =>
  api.patch(`/messages/${id}`, { body }).then(r => r.data.message);

export const deleteMessage = (id: number) =>
  api.delete(`/messages/${id}`).then(r => r.data);

// Reenviar un mensaje a otra conversación
export const forwardMessage = (msgId: number, targetConvId: number) =>
  api.post(`/messages/${msgId}/forward`, { target_conv_id: targetConvId }).then(r => r.data.message);

// ── Notificaciones in-app ─────────────────────────────────────────────────────
export const getNotifications = () =>
  api.get('/notifications').then(r => r.data as { notifications: any[]; unread: number });

export const markNotificationRead = (id: number) =>
  api.patch(`/notifications/${id}/read`).then(r => r.data);

export const markAllNotificationsRead = () =>
  api.post('/notifications/read-all').then(r => r.data);

// Alta manual de contacto/conversación (lead que nunca escribió solo por WhatsApp).
// No envía ningún mensaje — solo crea el registro para poder escribirle desde aquí.
export const createConversation = (data: { name?: string; phone: string }) =>
  api.post('/conversations', data).then(r => r.data.conversation);

// ── Agentes ───────────────────────────────────────────────────────────────────
export const getAgents = () =>
  api.get('/agents').then(r => r.data.agents);

// ── Tareas/recordatorios de conversación ──────────────────────────────────────
// Ej: "quedamos en llamarle mañana" — recordatorio ligado a un chat, con aviso
// push automático (backend) cuando vence due_at.
export interface ConversationTask {
  id: number;
  conversation_id: number;
  agent_id: number | null;
  agent_name?: string | null;
  title: string;
  due_at: string;
  status: 'pending' | 'done';
  created_at: string;
  completed_at?: string | null;
}

export const getConversationTasks = (convId: number) =>
  api.get(`/conversations/${convId}/tasks`).then(r => r.data.tasks as ConversationTask[]);

export const createConversationTask = (convId: number, data: { title: string; due_at: string; agent_id?: number }) =>
  api.post(`/conversations/${convId}/tasks`, data).then(r => r.data.task as ConversationTask);

export const patchTask = (taskId: number, data: { status?: 'pending' | 'done'; title?: string; due_at?: string }) =>
  api.patch(`/tasks/${taskId}`, data).then(r => r.data.task as ConversationTask);

export const deleteTask = (taskId: number) =>
  api.delete(`/tasks/${taskId}`).then(r => r.data);

export const getQuickReplies = () =>
  api.get('/quick-replies').then(r => r.data as any[]);

// ── Plantillas WhatsApp aprobadas ─────────────────────────────────────────────
export const getTemplates = () =>
  api.get('/templates').then(r => r.data.templates as any[]);

// ── Etiquetas (Labels) ────────────────────────────────────────────────────────
export interface Label {
  id: number;
  name: string;
  color: string;
  usage_count?: number;
}

// Lista de etiquetas del tenant
export const getLabels = () =>
  api.get('/labels').then(r => r.data.labels as Label[]);

// Etiquetas asignadas a una conversación
export const getConversationLabels = (convId: number) =>
  api.get(`/conversations/${convId}/labels`).then(r => r.data.labels as Label[]);

// Asignar etiqueta a conversación
export const addLabelToConversation = (convId: number, labelId: number) =>
  api.post(`/conversations/${convId}/labels`, { label_id: labelId }).then(r => r.data.labels as Label[]);

// Quitar etiqueta de conversación
export const removeLabelFromConversation = (convId: number, labelId: number) =>
  api.delete(`/conversations/${convId}/labels/${labelId}`).then(r => r.data);

// ── Agenda de citas ───────────────────────────────────────────────────────────
export type AppointmentStatus = 'scheduled' | 'confirmed' | 'cancelled' | 'completed';

export interface Appointment {
  id: number;
  tenant_id: number;
  title: string;
  contact_id: number | null;
  contact_name?: string | null;
  contact_phone?: string | null;
  conversation_id: number | null;
  scheduled_at: string;
  duration_minutes: number;
  agent_id: number | null;
  agent_name?: string | null;
  notes: string | null;
  status: AppointmentStatus;
  created_at: string;
  updated_at: string | null;
}

export const getAppointments = (params?: { from?: string; to?: string; status?: string; agent_id?: number }) =>
  api.get('/appointments', { params }).then(r => r.data as Appointment[]);

export const getAppointment = (id: number) =>
  api.get(`/appointments/${id}`).then(r => r.data as Appointment);

export const createAppointment = (data: {
  title: string;
  contact_id?: number | null;
  conversation_id?: number | null;
  scheduled_at: string;
  duration_minutes?: number;
  agent_id?: number | null;
  notes?: string | null;
  status?: AppointmentStatus;
}) => api.post('/appointments', data).then(r => r.data as Appointment);

export const updateAppointment = (id: number, data: Partial<{
  title: string;
  contact_id: number | null;
  scheduled_at: string;
  duration_minutes: number;
  agent_id: number | null;
  notes: string | null;
  status: AppointmentStatus;
}>) => api.patch(`/appointments/${id}`, data).then(r => r.data as Appointment);

export const deleteAppointment = (id: number) =>
  api.delete(`/appointments/${id}`).then(r => r.data);

export const getAvailabilitySlots = (date: string) =>
  api.get('/appointments/availability', { params: { date } }).then(r => r.data as {
    available: boolean;
    date: string;
    slot_duration: number;
    slots: { time: string; free: boolean }[];
    reason?: string;
  });

export default api;
