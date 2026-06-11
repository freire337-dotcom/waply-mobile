/**
 * CRON Jobs
 *
 * Job 1 — Cada día a las 10:00: busca citas en 7 días y 1 día, dispara recordatorios
 * Job 2 — Cada 15 min: revisa timers expirados sin respuesta
 *
 * Usa setInterval en lugar de dependencias externas para mantener el proyecto simple.
 */

const db     = require('../db');
const engine = require('./automation-engine');

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

  // Ejecutar inmediatamente al arrancar (para dev)
  if (process.env.NODE_ENV !== 'production') {
    checkExpiredTimers().catch(console.error);
  }

  console.log('✅ Cron jobs iniciados');
}

module.exports = { startCronJobs, checkAppointmentReminders, checkExpiredTimers };
