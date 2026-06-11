/**
 * Action Handlers — ejecutan cada tipo de acción del motor de automatizaciones
 *
 * Cada handler recibe: { tenantId, action, context, runId }
 * context contiene los datos del trigger (lead, appointment, etc.)
 * Devuelve { status: 'completed' | 'waiting', timer? }
 */

const db      = require('../db');
const wa      = require('../services/whatsapp');

// ── Helpers ───────────────────────────────────────────────────────────────────

function getOrCreateConversation(tenantId, contactId, leadId) {
  let conv = db.prepare(
    'SELECT id FROM conversations WHERE tenant_id = ? AND contact_id = ?'
  ).get(tenantId, contactId);

  if (!conv) {
    const ins = db.prepare(`
      INSERT INTO conversations (tenant_id, contact_id, lead_id, status)
      VALUES (?, ?, ?, 'open')
    `).run(tenantId, contactId, leadId || null);
    conv = { id: ins.lastInsertRowid };
  }
  return conv;
}

function assignAgentRoundRobin(tenantId) {
  // Obtiene el agente activo con menos conversaciones abiertas
  return db.prepare(`
    SELECT a.id
    FROM agents a
    LEFT JOIN conversations c ON c.assigned_to = a.id AND c.status = 'open' AND c.tenant_id = a.tenant_id
    WHERE a.tenant_id = ? AND a.active = 1 AND a.role = 'agent'
    GROUP BY a.id
    ORDER BY COUNT(c.id) ASC
    LIMIT 1
  `).get(tenantId);
}

// ── HANDLERS ─────────────────────────────────────────────────────────────────

/**
 * assign_agent: asigna un comercial a la conversación
 * config: { strategy: 'round_robin' | 'specific', agent_id?: number }
 */
async function assignAgent({ tenantId, action, context }) {
  const { strategy = 'round_robin', agent_id } = action.config || {};

  let agentId;
  if (strategy === 'specific' && agent_id) {
    agentId = agent_id;
  } else {
    const agent = assignAgentRoundRobin(tenantId);
    agentId = agent?.id;
  }
  if (!agentId) return { status: 'completed', note: 'No hay agentes disponibles' };

  // Actualizar conversación si existe
  if (context.conversation_id) {
    db.prepare('UPDATE conversations SET assigned_to = ? WHERE id = ? AND tenant_id = ?')
      .run(agentId, context.conversation_id, tenantId);
  }

  return { status: 'completed', output: { assigned_agent_id: agentId } };
}

/**
 * send_whatsapp: envía mensaje de texto o plantilla
 * config: { type: 'text'|'template', template?: string, body?: string,
 *           body_template?: string (con variables {{lead.name}} etc.) }
 */
async function sendWhatsapp({ tenantId, action, context }) {
  const { type = 'text', template, body_template, body, language = 'es', components = [] } = action.config || {};

  const waId = context.contact?.wa_id || context.wa_id;
  if (!waId) return { status: 'completed', note: 'Sin wa_id, mensaje no enviado' };

  // Resolver variables en el body
  const resolvedBody = (body_template || body || '').replace(
    /\{\{(\w+\.\w+)\}\}/g,
    (_, path) => {
      const [obj, key] = path.split('.');
      return context[obj]?.[key] || '';
    }
  );

  let waMessageId;
  if (type === 'template') {
    waMessageId = await wa.sendTemplate(tenantId, waId, template, language, components);
  } else {
    waMessageId = await wa.sendText(tenantId, waId, resolvedBody);
  }

  // Guardar en historial si hay conversación
  if (context.conversation_id && waMessageId) {
    db.prepare(`
      INSERT OR IGNORE INTO messages (tenant_id, conversation_id, wa_message_id, direction, type, body, status)
      VALUES (?, ?, ?, 'outbound', ?, ?, 'sent')
    `).run(tenantId, context.conversation_id, waMessageId, type, resolvedBody || null);
  }

  return { status: 'completed', output: { wa_message_id: waMessageId } };
}

/**
 * send_appointment_reminder: plantilla de recordatorio de cita con botones YES/NO
 * config: { template: string, timeout_hours: number }
 */
async function sendAppointmentReminder({ tenantId, action, context, runId, actionIndex }) {
  const { template, timeout_hours = 72, language = 'es' } = action.config || {};

  const waId = context.contact?.wa_id;
  if (!waId) return { status: 'completed', note: 'Sin wa_id' };

  // Construir componentes de la plantilla con nombre/fecha/hora
  const appt    = context.appointment;
  const apptDate = appt ? new Date(appt.scheduled_at) : null;
  const components = appt ? [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: context.contact?.name || 'Cliente' },
        { type: 'text', text: apptDate?.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' }) || '' },
        { type: 'text', text: apptDate?.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) || '' },
      ],
    },
  ] : [];

  const waMessageId = await wa.sendTemplate(tenantId, waId, template, language, components);

  // Crear timer — espera respuesta o expira en timeout_hours
  const executeAt = new Date(Date.now() + timeout_hours * 3600 * 1000).toISOString();
  db.prepare(`
    INSERT INTO automation_timers (tenant_id, run_id, action_index, execute_at, waiting_for, context, status)
    VALUES (?, ?, ?, ?, 'response', ?, 'pending')
  `).run(tenantId, runId, actionIndex, executeAt, JSON.stringify({
    ...context,
    wa_message_id: waMessageId,
    expected_responses: ['si', 'sí', 'yes', 'confirmo', '1', 'no', 'no puedo', 'cancel', '2'],
    positive_responses: ['si', 'sí', 'yes', 'confirmo', '1'],
    next_action_on_positive: 'confirm_appointment',
    next_action_on_negative: 'notify_agent_reschedule',
  }));

  return { status: 'waiting', output: { wa_message_id: waMessageId, timer_at: executeAt } };
}

/**
 * notify_agent: push notification al comercial asignado o a todos
 * config: { message_template: string, target: 'assigned'|'all'|'specific', agent_id? }
 */
async function notifyAgent({ tenantId, action, context }) {
  const { message_template, title = 'Whasat', target = 'assigned', agent_id } = action.config || {};

  const resolvedMsg = (message_template || '').replace(
    /\{\{(\w+\.\w+)\}\}/g,
    (_, path) => {
      const [obj, key] = path.split('.');
      return context[obj]?.[key] || '';
    }
  );

  if (target === 'assigned' && context.assigned_agent_id) {
    await wa.pushToAgent(tenantId, context.assigned_agent_id, title, resolvedMsg, context);
  } else if (target === 'specific' && agent_id) {
    await wa.pushToAgent(tenantId, agent_id, title, resolvedMsg, context);
  } else {
    await wa.broadcastPush(tenantId, title, resolvedMsg, context);
  }

  return { status: 'completed' };
}

/**
 * confirm_appointment: marca cita como confirmada
 */
async function confirmAppointment({ tenantId, context }) {
  if (context.appointment?.crm_appointment_id) {
    db.prepare(`
      UPDATE appointments SET status = 'confirmed' WHERE crm_appointment_id = ? AND tenant_id = ?
    `).run(context.appointment.crm_appointment_id, tenantId);
  }
  return { status: 'completed' };
}

/**
 * notify_agent_reschedule: notifica al comercial que debe reconducir la cita
 */
async function notifyAgentReschedule({ tenantId, action, context }) {
  const agentId = context.appointment?.agent_id || context.assigned_agent_id;
  if (!agentId) {
    await wa.broadcastPush(tenantId, '⚠️ Cita sin confirmar', `${context.contact?.name || 'Cliente'} no confirmó su cita`, context);
  } else {
    await wa.pushToAgent(tenantId, agentId,
      '⚠️ Acción requerida',
      `${context.contact?.name || 'Cliente'} no confirmó cita. Reconducir.`,
      context
    );
  }
  return { status: 'completed' };
}

/**
 * update_lead_field: actualiza un campo del lead en el CRM via webhook
 * config: { crm_webhook_url: string, field: string, value: string }
 */
async function updateLeadField({ tenantId, action, context }) {
  const { crm_webhook_url, field, value } = action.config || {};
  if (!crm_webhook_url || !context.lead_id) return { status: 'completed', note: 'Sin URL o lead_id' };

  const axios = require('axios');
  await axios.post(crm_webhook_url, {
    tenant_id: tenantId,
    lead_id: context.lead_id,
    field,
    value,
  }).catch(e => console.error('Error actualizando lead en CRM:', e.message));

  return { status: 'completed' };
}

/**
 * webhook: llama a cualquier URL externa (para integraciones con Make, Zapier, etc.)
 * config: { url, method: 'POST'|'GET', headers?: {}, body_template?: string }
 */
async function callWebhook({ tenantId, action, context }) {
  const { url, method = 'POST', headers = {}, body_template } = action.config || {};
  if (!url) return { status: 'completed', note: 'Sin URL configurada' };

  const axios = require('axios');
  const payload = body_template
    ? JSON.parse(body_template.replace(/\{\{(\w+\.\w+)\}\}/g, (_, p) => {
        const [obj, key] = p.split('.');
        return JSON.stringify(context[obj]?.[key] || '');
      }))
    : context;

  await axios({ method, url, headers, data: payload }).catch(e =>
    console.error('Error llamando webhook externo:', e.message)
  );

  return { status: 'completed' };
}

// ── Mapa de handlers ──────────────────────────────────────────────────────────
const HANDLERS = {
  assign_agent:               assignAgent,
  send_whatsapp:              sendWhatsapp,
  send_appointment_reminder:  sendAppointmentReminder,
  notify_agent:               notifyAgent,
  confirm_appointment:        confirmAppointment,
  notify_agent_reschedule:    notifyAgentReschedule,
  update_lead_field:          updateLeadField,
  webhook:                    callWebhook,
};

module.exports = HANDLERS;
