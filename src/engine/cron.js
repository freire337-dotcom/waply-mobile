/**
 * CRON Jobs
 *
 * Job 1 — Cada día a las 10:00: busca citas en 7 días y 1 día, dispara recordatorios
 * Job 2 — Cada 15 min: revisa timers expirados sin respuesta
 *
 * Usa setInterval en lugar de dependencias externas para mantener el proyecto simple.
 */

const db       = require('../db');
const engine   = require('./automation-engine');
const whatsapp = require('../services/whatsapp');
const { saveNotification } = require('../services/notifications');
const { pushStatusToCRM }  = require('../services/crm-sync');

// ── Utilidades de tiempo ──────────────────────────────────────────────────────
function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}
function endOfDay(date) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

// ── Job 1: Recordatorios de citas ─────────────────────────────────────────────
async function checkAppointmentReminders() {
  console.log('⏰ [CRON] Revisando citas próximas...');
  const now = new Date();

  const in7  = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
  const in1  = new Date(now.getTime() + 1 * 24 * 3600 * 1000);

  // 7 días — recordatorio semanal
  const appts7 = await db.prepare(`
    SELECT a.*, c.wa_id, c.name AS contact_name, c.id AS contact_id
    FROM appointments a
    JOIN contacts c ON c.id = a.contact_id
    WHERE a.status = 'scheduled'
      AND a.reminder_7d_sent = 0
      AND a.scheduled_at BETWEEN ? AND ?
  `).all(startOfDay(in7).toISOString(), endOfDay(in7).toISOString());

  for (const appt of appts7) {
    try {
      await engine.fire('appointment.reminder_7d', appt.tenant_id, buildAppointmentContext(appt));
      await db.prepare('UPDATE appointments SET reminder_7d_sent = 1 WHERE id = ?').run(appt.id);
      console.log(`  ✅ Recordatorio 7d enviado: cita #${appt.id}`);
    } catch (err) {
      console.error(`  ❌ Error recordatorio 7d cita #${appt.id}:`, err.message);
    }
  }

  // 1 día — recordatorio urgente
  const appts1 = await db.prepare(`
    SELECT a.*, c.wa_id, c.name AS contact_name, c.id AS contact_id
    FROM appointments a
    JOIN contacts c ON c.id = a.contact_id
    WHERE a.status IN ('scheduled', 'confirmed')
      AND a.reminder_1d_sent = 0
      AND a.scheduled_at BETWEEN ? AND ?
  `).all(startOfDay(in1).toISOString(), endOfDay(in1).toISOString());

  for (const appt of appts1) {
    try {
      await engine.fire('appointment.reminder_1d', appt.tenant_id, buildAppointmentContext(appt));
      await db.prepare('UPDATE appointments SET reminder_1d_sent = 1 WHERE id = ?').run(appt.id);
      console.log(`  ✅ Recordatorio 1d enviado: cita #${appt.id}`);
    } catch (err) {
      console.error(`  ❌ Error recordatorio 1d cita #${appt.id}:`, err.message);
    }
  }
}

function buildAppointmentContext(appt) {
  return {
    appointment: {
      id:                  appt.id,
      crm_appointment_id:  appt.crm_appointment_id,
      scheduled_at:        appt.scheduled_at,
      agent_id:            appt.agent_id,
    },
    contact: {
      id:    appt.contact_id,
      wa_id: appt.wa_id,
      name:  appt.contact_name,
    },
    lead_id:         appt.lead_id,
    conversation_id: null,
  };
}

// ── Job 2: Timers expirados ───────────────────────────────────────────────────
async function checkExpiredTimers() {
  const expired = await db.prepare(`
    SELECT * FROM automation_timers
    WHERE status = 'pending' AND execute_at <= NOW()
  `).all();

  for (const timer of expired) {
    console.log(`⏰ [CRON] Timer expirado #${timer.id}`);
    await engine.resolveTimer(timer.id, { timedOut: true }).catch(err =>
      console.error(`  ❌ Error resolviendo timer #${timer.id}:`, err.message)
    );
  }
}

// ── Job 3: Recordatorios de tareas de conversación ────────────────────────────
// Tareas tipo "quedamos en llamarle mañana": cuando due_at vence, avisa por
// push al agente asignado. No se marca 'done' sola — el agente la cierra a mano;
// solo se evita reenviar el push una vez disparado (reminder_sent).
async function checkConversationTasks() {
  const due = await db.prepare(`
    SELECT t.*, ct.name AS contact_name
    FROM conversation_tasks t
    JOIN conversations c ON c.id = t.conversation_id
    JOIN contacts ct     ON ct.id = c.contact_id
    WHERE t.status = 'pending' AND t.reminder_sent = 0 AND t.due_at <= NOW()
  `).all();

  for (const task of due) {
    try {
      if (task.agent_id) {
        await whatsapp.pushToAgent(
          task.tenant_id,
          task.agent_id,
          '⏰ Recordatorio',
          `${task.title}${task.contact_name ? ` — ${task.contact_name}` : ''}`,
          { type: 'conversation_task', conversation_id: task.conversation_id, task_id: task.id }
        );
      }
      await db.prepare('UPDATE conversation_tasks SET reminder_sent = 1 WHERE id = ?').run(task.id);
      // Notificación in-app: recordatorio de tarea
      await saveNotification({
        tenantId:       task.tenant_id,
        agentId:        task.agent_id || null,
        type:           'task_reminder',
        title:          '⏰ Recordatorio de tarea',
        body:           `${task.title}${task.contact_name ? ` — ${task.contact_name}` : ''}`,
        conversationId: task.conversation_id,
      });
      console.log(`  ✅ Recordatorio de tarea enviado: #${task.id}`);
    } catch (err) {
      console.error(`  ❌ Error recordatorio tarea #${task.id}:`, err.message);
    }
  }
}

// ── Job 4: Sin respuesta en 12h ───────────────────────────────────────────────
// Busca conversaciones abiertas cuyo último mensaje lo mandamos nosotros (outbound)
// y lleva 12h+ sin que el contacto responda. Dispara 'conversation.no_response_24h'
// una sola vez por ciclo — followup_24h_sent se resetea a false en cuanto entra
// o sale un mensaje nuevo (ver routes/messages.js, webhook/meta.js, action-handlers.js),
// así que si el contacto responde o le volvemos a escribir, el ciclo se reinicia.
async function checkNoResponse24h() {
  console.log('⏰ [CRON] Revisando conversaciones sin respuesta en 12h...');
  const rows = await db.prepare(`
    SELECT c.id AS conversation_id, c.tenant_id, c.lead_id,
           ct.id AS contact_id, ct.wa_id, ct.name AS contact_name
    FROM conversations c
    JOIN contacts ct ON ct.id = c.contact_id
    JOIN LATERAL (
      SELECT direction FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1
    ) lm ON true
    WHERE c.status = 'open'
      AND c.followup_24h_sent = false
      AND c.last_msg_at <= NOW() - INTERVAL '12 hours'
      AND lm.direction = 'outbound'
  `).all();
  console.log(`⏰ [CRON] Sin respuesta 12h: ${rows.length} conversación(es) candidata(s)`);

  for (const row of rows) {
    try {
      await engine.fire('conversation.no_response_24h', row.tenant_id, {
        contact:         { id: row.contact_id, wa_id: row.wa_id, name: row.contact_name },
        conversation_id: row.conversation_id,
        lead_id:         row.lead_id,
      });
      await db.prepare('UPDATE conversations SET followup_24h_sent = true WHERE id = ?').run(row.conversation_id);
      // Notificación in-app: sin respuesta 12h
      await saveNotification({
        tenantId:       row.tenant_id,
        agentId:        null,
        type:           'no_response',
        title:          '🕐 Sin respuesta 12h',
        body:           row.contact_name || row.wa_id,
        conversationId: row.conversation_id,
      });
      console.log(`  ✅ Trigger "sin respuesta 24h" disparado: conversación #${row.conversation_id}`);
    } catch (err) {
      console.error(`  ❌ Error en trigger sin respuesta 24h conv #${row.conversation_id}:`, err.message);
    }
  }
}

// ── Job 5: Auto-cierre como "perdido" ────────────────────────────────────────
// Si enviamos la plantilla de seguimiento (followup_24h_sent=true) y el cliente
// sigue sin contestar 10h después, cerramos el chat como cerrado/perdido.
// El cron de seguimiento ya no lo volverá a tocar (followup_24h_sent=true).
async function checkAutoCloseLost() {
  const { getIO } = require('../io');
  console.log('⏰ [CRON] Revisando chats a cerrar como perdido...');
  const rows = await db.prepare(`
    SELECT c.id AS conversation_id, c.tenant_id, c.lead_id,
           ct.id AS contact_id, ct.wa_id, ct.name AS contact_name
    FROM conversations c
    JOIN contacts ct ON ct.id = c.contact_id
    JOIN LATERAL (
      SELECT direction FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1
    ) lm ON true
    WHERE c.followup_24h_sent = true
      AND c.status != 'closed'
      AND c.last_msg_at <= NOW() - INTERVAL '10 hours'
      AND lm.direction = 'outbound'
  `).all();
  console.log(`⏰ [CRON] Cerrar como perdido: ${rows.length} conversación(es)`);

  for (const row of rows) {
    try {
      await db.prepare(`
        UPDATE conversations
        SET status = 'closed', pipeline_stage = 'perdido', followup_24h_sent = false
        WHERE id = ?
      `).run(row.conversation_id);

      // Sincronizar cierre con el CRM
      await pushStatusToCRM({
        tenantId: row.tenant_id,
        convId:   row.conversation_id,
        phone:    row.wa_id,
        leadId:   row.lead_id || null,
        status:   'closed',
      }).catch(e => console.warn(`  ⚠ CRM sync error conv #${row.conversation_id}:`, e.message));

      // Notificar en tiempo real al frontend
      const io = getIO();
      if (io) {
        io.to(`tenant:${row.tenant_id}`).emit('conversation:updated', {
          id:             row.conversation_id,
          status:         'closed',
          pipeline_stage: 'perdido',
        });
      }

      await saveNotification({
        tenantId:       row.tenant_id,
        agentId:        null,
        type:           'no_response',
        title:          '❌ Chat cerrado como perdido',
        body:           row.contact_name || `Conversación #${row.conversation_id}`,
        conversationId: row.conversation_id,
      });
      console.log(`  ✅ Conversación #${row.conversation_id} cerrada como perdido`);
    } catch (err) {
      console.error(`  ❌ Error cerrando conv #${row.conversation_id}:`, err.message);
    }
  }
}

// ── Calcular ms hasta la próxima hora objetivo ────────────────────────────────
function msUntilHour(hour, minute = 0) {
  const now  = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

// ── Arrancar crons ────────────────────────────────────────────────────────────
function startCronJobs() {
  // Job 1: corre cada día a las 10:00
  const scheduleDaily = () => {
    const delay = msUntilHour(10, 0);
    console.log(`⏰ Próximo cron de citas en ${Math.round(delay / 60000)} minutos`);
    setTimeout(async () => {
      await checkAppointmentReminders().catch(console.error);
      setInterval(() => checkAppointmentReminders().catch(console.error), 24 * 3600 * 1000);
    }, delay);
  };
  scheduleDaily();

  // Job 2: cada 15 minutos
  setInterval(() => checkExpiredTimers().catch(console.error), 15 * 60 * 1000);

  // Job 3: cada 5 minutos (recordatorios de tareas — necesitan más granularidad
  // porque el agente fija la hora exacta, ej. "llamar a las 11:30")
  setInterval(() => checkConversationTasks().catch(console.error), 5 * 60 * 1000);

  // Job 4: cada 30 minutos (sin respuesta en 12h)
  setInterval(() => checkNoResponse24h().catch(console.error), 30 * 60 * 1000);

  // Job 5: cada 30 minutos (auto-cierre como perdido tras 10h sin respuesta post-plantilla)
  setInterval(() => checkAutoCloseLost().catch(console.error), 30 * 60 * 1000);

  // Ejecutar inmediatamente al arrancar
  checkExpiredTimers().catch(console.error);
  checkConversationTasks().catch(console.error);
  checkNoResponse24h().catch(console.error);
  checkAutoCloseLost().catch(console.error);

  console.log('✅ Cron jobs iniciados');
}

module.exports = { startCronJobs, checkAppointmentReminders, checkExpiredTimers, checkConversationTasks, checkNoResponse24h, checkAutoCloseLost };
