/**
 * Automatizaciones por defecto
 * Se insertan automáticamente cuando se crea un nuevo tenant.
 * El cliente puede modificarlas o desactivarlas desde su CRM.
 */

const db = require('../db');

const DEFAULT_AUTOMATIONS = [

  // ── 1. Bienvenida a nuevo lead ─────────────────────────────────────────────
  {
    name:        'Bienvenida nuevo lead',
    description: 'Cuando entra un lead por web: asigna comercial, envía mensaje de bienvenida y notifica al comercial',
    trigger:     'lead.created',
    conditions:  [],
    actions: [
      {
        type:   'assign_agent',
        config: { strategy: 'round_robin' },
      },
      {
        type:   'send_whatsapp',
        config: {
          type:          'template',
          template:      'bienvenida_lead',
          language:      'es',
        },
      },
      {
        type:   'notify_agent',
        config: {
          title:            '🆕 Nuevo lead asignado',
          message_template: 'Nuevo lead: {{lead.name}} ({{lead.phone}}). Ya recibió mensaje de bienvenida.',
          target:           'assigned',
        },
      },
    ],
  },

  // ── 2. Recordatorio de cita — 7 días antes ────────────────────────────────
  {
    name:        'Recordatorio cita — 7 días antes',
    description: 'Una semana antes de la cita: envía recordatorio con botones Sí/No. Si dice No o no responde en 72h, notifica al comercial.',
    trigger:     'appointment.reminder_7d',
    conditions:  [],
    actions: [
      {
        type:   'send_appointment_reminder',
        config: {
          template:      'recordatorio_cita_7dias',
          language:      'es',
          timeout_hours: 72,
        },
      },
    ],
  },

  // ── 3. Recordatorio de cita — 1 día antes ────────────────────────────────
  {
    name:        'Recordatorio cita — 1 día antes',
    description: 'El día anterior a las 11:00: recordatorio urgente. Si dice No o no responde en 3h15, notifica al comercial.',
    trigger:     'appointment.reminder_1d',
    conditions:  [],
    actions: [
      {
        type:   'send_appointment_reminder',
        config: {
          template:       'recordatorio_cita_1dia',
          language:       'es',
          timeout_hours:  3.25,
        },
      },
    ],
  },

];

/**
 * Inserta las automatizaciones por defecto para un tenant recién creado.
 * Solo las inserta si el tenant aún no tiene automatizaciones.
 */
async function seedDefaultAutomations(tenantId) {
  const existing = await db.prepare('SELECT COUNT(*) as cnt FROM automations WHERE tenant_id = ?').get(tenantId);
  if (Number(existing.cnt) > 0) return;

  for (const auto of DEFAULT_AUTOMATIONS) {
    await db.prepare(`
      INSERT INTO automations (tenant_id, name, description, trigger, conditions, actions, active)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run(
      tenantId,
      auto.name,
      auto.description,
      auto.trigger,
      JSON.stringify(auto.conditions),
      JSON.stringify(auto.actions)
    );
  }

  console.log(`✅ Automatizaciones por defecto creadas para tenant #${tenantId}`);
}

module.exports = { seedDefaultAutomations, DEFAULT_AUTOMATIONS };
