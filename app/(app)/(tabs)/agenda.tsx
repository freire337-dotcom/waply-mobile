import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  Modal, TextInput, ScrollView, ActivityIndicator,
  RefreshControl, Alert, KeyboardAvoidingView, Platform, Pressable,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  Appointment, AppointmentStatus,
  getAppointments, createAppointment, updateAppointment, deleteAppointment,
  getAvailabilitySlots, getAgents,
} from '../../../services/api';

// ── Colores por estado ────────────────────────────────────────────────────────
const STATUS_COLOR: Record<AppointmentStatus, string> = {
  scheduled:  '#3b82f6',
  confirmed:  '#22c55e',
  cancelled:  '#ef4444',
  completed:  '#9aa0a6',
};
const STATUS_LABEL: Record<AppointmentStatus, string> = {
  scheduled:  'Programada',
  confirmed:  'Confirmada',
  cancelled:  'Cancelada',
  completed:  'Completada',
};

const DURATIONS = [15, 30, 45, 60, 90];
const STATUSES: AppointmentStatus[] = ['scheduled', 'confirmed', 'cancelled', 'completed'];

const GREEN  = '#075E54';
const TEAL   = '#128C7E';
const BG     = '#f5f5f5';
const WHITE  = '#fff';

// ── Helpers de fecha ──────────────────────────────────────────────────────────
function toDateStr(d: Date) {
  return d.toISOString().slice(0, 10);           // YYYY-MM-DD
}
function weekStart(d: Date) {                    // lunes de la semana
  const day  = new Date(d);
  const diff = (day.getDay() + 6) % 7;          // Monday=0
  day.setDate(day.getDate() - diff);
  return day;
}
function addDays(d: Date, n: number) {
  const r = new Date(d); r.setDate(r.getDate() + n); return r;
}
function fmtTime(iso: string) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}
function fmtDateLabel(d: Date) {
  return d.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' });
}
const WEEK_DAYS = ['Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sá', 'Do'];

// ── Componente principal ──────────────────────────────────────────────────────
export default function AgendaScreen() {
  const today = new Date();
  const [selectedDate, setSelectedDate] = useState<Date>(today);
  const [weekBase, setWeekBase]         = useState<Date>(weekStart(today));
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [loading, setLoading]           = useState(true);
  const [refreshing, setRefreshing]     = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [editing, setEditing]           = useState<Appointment | null>(null);
  const [agents, setAgents]             = useState<{ id: number; name: string }[]>([]);

  // ── Cargar citas del mes visible ────────────────────────────────────────────
  const load = useCallback(async (showRefresh = false) => {
    if (showRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      const from = toDateStr(weekBase);
      const to   = toDateStr(addDays(weekBase, 13)); // 2 semanas
      const data = await getAppointments({ from, to });
      setAppointments(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Error cargando agenda:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [weekBase]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { getAgents().then(setAgents).catch(() => {}); }, []);

  // ── Citas del día seleccionado ───────────────────────────────────────────────
  const dayStr = toDateStr(selectedDate);
  const dayAppointments = appointments
    .filter(a => a.scheduled_at.startsWith(dayStr))
    .sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at));

  // Semana actual (7 días desde weekBase)
  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(weekBase, i));

  // Cuántas citas tiene cada día de la semana (para los puntos)
  function countForDay(d: Date) {
    const s = toDateStr(d);
    return appointments.filter(a => a.scheduled_at.startsWith(s)).length;
  }

  // ── Render fila de semana ────────────────────────────────────────────────────
  function DayPill({ day, idx }: { day: Date; idx: number }) {
    const isSelected = toDateStr(day) === toDateStr(selectedDate);
    const isToday    = toDateStr(day) === toDateStr(today);
    const count      = countForDay(day);
    return (
      <TouchableOpacity
        style={[styles.dayPill, isSelected && styles.dayPillSelected]}
        onPress={() => setSelectedDate(day)}
      >
        <Text style={[styles.dayPillLabel, isSelected && styles.dayPillLabelSel]}>
          {WEEK_DAYS[idx]}
        </Text>
        <Text style={[styles.dayPillNum, isSelected && styles.dayPillNumSel, isToday && !isSelected && { color: TEAL }]}>
          {day.getDate()}
        </Text>
        {count > 0 && (
          <View style={[styles.dot, { backgroundColor: isSelected ? WHITE : TEAL }]} />
        )}
      </TouchableOpacity>
    );
  }

  // ── Tarjeta de cita ──────────────────────────────────────────────────────────
  function AppointmentCard({ item }: { item: Appointment }) {
    const color = STATUS_COLOR[item.status] ?? '#3b82f6';
    return (
      <TouchableOpacity style={styles.card} onPress={() => { setEditing(item); setModalVisible(true); }}>
        <View style={[styles.cardBar, { backgroundColor: color }]} />
        <View style={styles.cardBody}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={styles.cardTime}>{fmtTime(item.scheduled_at)}</Text>
            <View style={[styles.statusBadge, { backgroundColor: color + '22', borderColor: color }]}>
              <Text style={[styles.statusText, { color }]}>{STATUS_LABEL[item.status]}</Text>
            </View>
          </View>
          <Text style={styles.cardTitle} numberOfLines={1}>{item.title}</Text>
          {item.contact_name ? (
            <Text style={styles.cardSub} numberOfLines={1}>
              <Ionicons name="person-outline" size={11} /> {item.contact_name}
            </Text>
          ) : null}
          {item.notes ? (
            <Text style={styles.cardNotes} numberOfLines={1}>{item.notes}</Text>
          ) : null}
          <Text style={styles.cardDuration}>{item.duration_minutes} min</Text>
        </View>
      </TouchableOpacity>
    );
  }

  return (
    <View style={styles.root}>
      {/* ── Navegación semana ── */}
      <View style={styles.weekNav}>
        <TouchableOpacity onPress={() => setWeekBase(w => addDays(w, -7))} style={styles.navBtn}>
          <Ionicons name="chevron-back" size={20} color={GREEN} />
        </TouchableOpacity>
        <Text style={styles.weekLabel}>
          {weekBase.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })} –{' '}
          {addDays(weekBase, 6).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' })}
        </Text>
        <TouchableOpacity onPress={() => setWeekBase(w => addDays(w, 7))} style={styles.navBtn}>
          <Ionicons name="chevron-forward" size={20} color={GREEN} />
        </TouchableOpacity>
      </View>

      {/* ── Fila de días ── */}
      <View style={styles.weekStrip}>
        {weekDays.map((d, i) => <DayPill key={i} day={d} idx={i} />)}
      </View>

      {/* ── Título del día ── */}
      <View style={styles.dayHeader}>
        <Text style={styles.dayHeaderText}>{fmtDateLabel(selectedDate)}</Text>
        <Text style={styles.dayCount}>
          {dayAppointments.length === 0
            ? 'Sin citas'
            : `${dayAppointments.length} cita${dayAppointments.length > 1 ? 's' : ''}`}
        </Text>
      </View>

      {/* ── Lista de citas ── */}
      {loading ? (
        <ActivityIndicator color={TEAL} style={{ marginTop: 40 }} />
      ) : (
        <FlatList
          data={dayAppointments}
          keyExtractor={a => String(a.id)}
          renderItem={({ item }) => <AppointmentCard item={item} />}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={TEAL} />}
          contentContainerStyle={dayAppointments.length === 0 ? styles.emptyContainer : styles.listContent}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="calendar-outline" size={56} color="#ccc" />
              <Text style={styles.emptyText}>Sin citas para este día</Text>
              <TouchableOpacity style={styles.emptyBtn} onPress={() => { setEditing(null); setModalVisible(true); }}>
                <Text style={styles.emptyBtnText}>+ Crear cita</Text>
              </TouchableOpacity>
            </View>
          }
        />
      )}

      {/* ── FAB ── */}
      {!loading && (
        <TouchableOpacity style={styles.fab} onPress={() => { setEditing(null); setModalVisible(true); }}>
          <Ionicons name="add" size={28} color="#fff" />
        </TouchableOpacity>
      )}

      {/* ── Modal crear/editar ── */}
      {modalVisible && (
        <AppointmentModal
          editing={editing}
          selectedDate={selectedDate}
          agents={agents}
          onClose={() => { setModalVisible(false); setEditing(null); }}
          onSaved={() => { setModalVisible(false); setEditing(null); load(); }}
        />
      )}
    </View>
  );
}

// ── Modal de cita ─────────────────────────────────────────────────────────────
interface ModalProps {
  editing: Appointment | null;
  selectedDate: Date;
  agents: { id: number; name: string }[];
  onClose: () => void;
  onSaved: () => void;
}

function AppointmentModal({ editing, selectedDate, agents, onClose, onSaved }: ModalProps) {
  const isNew = !editing;

  const [title, setTitle]       = useState(editing?.title ?? '');
  const [dateStr, setDateStr]   = useState(
    editing ? editing.scheduled_at.slice(0, 10) : toDateStr(selectedDate)
  );
  const [timeStr, setTimeStr]   = useState(
    editing ? fmtTime(editing.scheduled_at) : '09:00'
  );
  const [duration, setDuration] = useState(editing?.duration_minutes ?? 30);
  const [status, setStatus]     = useState<AppointmentStatus>(editing?.status ?? 'scheduled');
  const [notes, setNotes]       = useState(editing?.notes ?? '');
  const [saving, setSaving]     = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [slots, setSlots]       = useState<{ time: string; free: boolean }[]>([]);

  // Cargar slots disponibles cuando cambia la fecha
  useEffect(() => {
    if (!dateStr || dateStr.length !== 10) return;
    getAvailabilitySlots(dateStr)
      .then(r => setSlots(r.slots || []))
      .catch(() => setSlots([]));
  }, [dateStr]);

  async function handleSave() {
    if (!title.trim()) { Alert.alert('Falta el título'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) { Alert.alert('Fecha inválida (YYYY-MM-DD)'); return; }
    if (!/^\d{2}:\d{2}$/.test(timeStr)) { Alert.alert('Hora inválida (HH:MM)'); return; }

    const scheduled_at = `${dateStr}T${timeStr}:00.000Z`;
    setSaving(true);
    try {
      if (isNew) {
        await createAppointment({ title: title.trim(), scheduled_at, duration_minutes: duration, notes: notes || null, status });
      } else {
        await updateAppointment(editing!.id, { title: title.trim(), scheduled_at, duration_minutes: duration, notes: notes || null, status });
      }
      onSaved();
    } catch (err: any) {
      Alert.alert('Error', err?.response?.data?.error ?? 'No se pudo guardar');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    Alert.alert('Eliminar cita', '¿Seguro?', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Eliminar', style: 'destructive',
        onPress: async () => {
          setDeleting(true);
          try { await deleteAppointment(editing!.id); onSaved(); }
          catch { Alert.alert('Error', 'No se pudo eliminar'); }
          finally { setDeleting(false); }
        },
      },
    ]);
  }

  const freeSlots = slots.filter(s => s.free);

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {/* Header */}
        <View style={mStyles.header}>
          <TouchableOpacity onPress={onClose}>
            <Ionicons name="close" size={24} color={WHITE} />
          </TouchableOpacity>
          <Text style={mStyles.headerTitle}>{isNew ? 'Nueva cita' : 'Editar cita'}</Text>
          <TouchableOpacity onPress={handleSave} disabled={saving}>
            {saving ? <ActivityIndicator color={WHITE} /> : <Ionicons name="checkmark" size={26} color={WHITE} />}
          </TouchableOpacity>
        </View>

        <ScrollView style={mStyles.scroll} keyboardShouldPersistTaps="handled">
          {/* Título */}
          <Text style={mStyles.label}>Título *</Text>
          <TextInput
            style={mStyles.input}
            value={title}
            onChangeText={setTitle}
            placeholder="Ej: Llamada de seguimiento"
            placeholderTextColor="#aaa"
          />

          {/* Fecha y hora */}
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Text style={mStyles.label}>Fecha (YYYY-MM-DD)</Text>
              <TextInput
                style={mStyles.input}
                value={dateStr}
                onChangeText={setDateStr}
                placeholder="2026-07-10"
                placeholderTextColor="#aaa"
                keyboardType="numeric"
                maxLength={10}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={mStyles.label}>Hora (HH:MM)</Text>
              <TextInput
                style={mStyles.input}
                value={timeStr}
                onChangeText={setTimeStr}
                placeholder="09:00"
                placeholderTextColor="#aaa"
                keyboardType="numeric"
                maxLength={5}
              />
            </View>
          </View>

          {/* Slots disponibles */}
          {freeSlots.length > 0 && (
            <>
              <Text style={mStyles.label}>Horas libres</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
                {slots.map(s => (
                  <TouchableOpacity
                    key={s.time}
                    onPress={() => s.free && setTimeStr(s.time)}
                    style={[
                      mStyles.slotPill,
                      s.free ? (s.time === timeStr ? mStyles.slotSelected : mStyles.slotFree) : mStyles.slotTaken,
                    ]}
                  >
                    <Text style={[mStyles.slotText, s.time === timeStr && { color: WHITE }]}>{s.time}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </>
          )}

          {/* Duración */}
          <Text style={mStyles.label}>Duración</Text>
          <View style={mStyles.row}>
            {DURATIONS.map(d => (
              <TouchableOpacity
                key={d}
                style={[mStyles.chip, duration === d && mStyles.chipSelected]}
                onPress={() => setDuration(d)}
              >
                <Text style={[mStyles.chipText, duration === d && { color: WHITE }]}>{d}m</Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Estado */}
          <Text style={mStyles.label}>Estado</Text>
          <View style={mStyles.row}>
            {STATUSES.map(s => (
              <TouchableOpacity
                key={s}
                style={[mStyles.statusChip, status === s && { backgroundColor: STATUS_COLOR[s] }]}
                onPress={() => setStatus(s)}
              >
                <Text style={[mStyles.statusChipText, status === s && { color: WHITE }]}>
                  {STATUS_LABEL[s]}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Notas */}
          <Text style={mStyles.label}>Notas</Text>
          <TextInput
            style={[mStyles.input, { height: 80, textAlignVertical: 'top' }]}
            value={notes}
            onChangeText={setNotes}
            placeholder="Observaciones..."
            placeholderTextColor="#aaa"
            multiline
          />

          {/* Eliminar */}
          {!isNew && (
            <TouchableOpacity style={mStyles.deleteBtn} onPress={handleDelete} disabled={deleting}>
              {deleting
                ? <ActivityIndicator color="#ef4444" />
                : <Text style={mStyles.deleteBtnText}>Eliminar cita</Text>}
            </TouchableOpacity>
          )}

          <View style={{ height: 40 }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ── Estilos ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  root:          { flex: 1, backgroundColor: BG },
  weekNav:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 8, paddingVertical: 10, backgroundColor: WHITE, borderBottomWidth: 1, borderBottomColor: '#e5e7eb' },
  navBtn:        { padding: 8 },
  weekLabel:     { fontWeight: '700', fontSize: 14, color: '#374151' },
  weekStrip:     { flexDirection: 'row', backgroundColor: WHITE, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: '#e5e7eb' },
  dayPill:       { flex: 1, alignItems: 'center', paddingVertical: 6, borderRadius: 8, marginHorizontal: 2 },
  dayPillSelected: { backgroundColor: GREEN },
  dayPillLabel:  { fontSize: 10, fontWeight: '600', color: '#6b7280' },
  dayPillLabelSel: { color: WHITE },
  dayPillNum:    { fontSize: 15, fontWeight: '700', color: '#1f2937', marginTop: 1 },
  dayPillNumSel: { color: WHITE },
  dot:           { width: 5, height: 5, borderRadius: 3, backgroundColor: TEAL, marginTop: 2 },
  dayHeader:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10 },
  dayHeaderText: { fontSize: 15, fontWeight: '700', color: '#1f2937', textTransform: 'capitalize' },
  dayCount:      { fontSize: 12, color: '#6b7280' },
  listContent:   { paddingHorizontal: 14, paddingBottom: 90 },
  emptyContainer: { flex: 1, justifyContent: 'center' },
  empty:         { alignItems: 'center', paddingTop: 60 },
  emptyText:     { color: '#9aa0a6', marginTop: 10, fontSize: 15 },
  emptyBtn:      { marginTop: 18, backgroundColor: GREEN, paddingHorizontal: 24, paddingVertical: 10, borderRadius: 22 },
  emptyBtnText:  { color: WHITE, fontWeight: '700', fontSize: 14 },
  card:          { flexDirection: 'row', backgroundColor: WHITE, borderRadius: 12, marginBottom: 10, overflow: 'hidden', elevation: 2, shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 4, shadowOffset: { width: 0, height: 2 } },
  cardBar:       { width: 5 },
  cardBody:      { flex: 1, padding: 12 },
  cardTime:      { fontSize: 12, fontWeight: '700', color: '#6b7280' },
  cardTitle:     { fontSize: 15, fontWeight: '700', color: '#111827', marginTop: 2 },
  cardSub:       { fontSize: 12, color: '#6b7280', marginTop: 2 },
  cardNotes:     { fontSize: 12, color: '#9aa0a6', marginTop: 2, fontStyle: 'italic' },
  cardDuration:  { fontSize: 11, color: '#9aa0a6', marginTop: 4 },
  statusBadge:   { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 12, borderWidth: 1 },
  statusText:    { fontSize: 10, fontWeight: '700' },
  fab:           { position: 'absolute', bottom: 20, right: 20, width: 56, height: 56, borderRadius: 28, backgroundColor: GREEN, justifyContent: 'center', alignItems: 'center', elevation: 6, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 6, shadowOffset: { width: 0, height: 3 } },
});

const mStyles = StyleSheet.create({
  header:      { backgroundColor: GREEN, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: Platform.OS === 'ios' ? 52 : 16, paddingBottom: 14 },
  headerTitle: { color: WHITE, fontSize: 17, fontWeight: '700' },
  scroll:      { flex: 1, backgroundColor: BG, padding: 16 },
  label:       { fontSize: 12, fontWeight: '600', color: '#6b7280', marginBottom: 4, marginTop: 14, textTransform: 'uppercase', letterSpacing: 0.5 },
  input:       { backgroundColor: WHITE, borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: '#111827' },
  row:         { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 4 },
  chip:        { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, borderWidth: 1.5, borderColor: '#d1d5db', backgroundColor: WHITE },
  chipSelected: { backgroundColor: TEAL, borderColor: TEAL },
  chipText:    { fontSize: 13, fontWeight: '600', color: '#374151' },
  statusChip:  { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 16, borderWidth: 1.5, borderColor: '#d1d5db', backgroundColor: WHITE },
  statusChipText: { fontSize: 12, fontWeight: '600', color: '#374151' },
  slotPill:    { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, marginRight: 6, borderWidth: 1 },
  slotFree:    { backgroundColor: WHITE, borderColor: TEAL },
  slotTaken:   { backgroundColor: '#f3f4f6', borderColor: '#e5e7eb' },
  slotSelected: { backgroundColor: TEAL, borderColor: TEAL },
  slotText:    { fontSize: 12, fontWeight: '600', color: '#374151' },
  deleteBtn:   { marginTop: 24, borderWidth: 1.5, borderColor: '#ef4444', borderRadius: 10, paddingVertical: 13, alignItems: 'center' },
  deleteBtnText: { color: '#ef4444', fontWeight: '700', fontSize: 15 },
});
