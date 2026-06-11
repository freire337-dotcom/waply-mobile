/**
 * Servicio WhatsApp Business API
 * Abstrae todas las llamadas a Meta Graph API
 * Usa las credenciales del tenant, no variables de entorno globales
 */

const axios = require('axios');
const db    = require('../db');

const GRAPH_URL = 'https://graph.facebook.com/v20.0';

// Obtener credenciales del tenant
async function getTenantCreds(tenantId) {
  const tenant = await db.prepare('SELECT wa_phone_id, wa_token FROM tenants WHERE id = ?').get(tenantId);
  if (!tenant?.wa_token || !tenant?.wa_phone_id) {
    throw new Error(`Tenant ${tenantId} no tiene WhatsApp configurado`);
  }
  return tenant;
}

// ── Enviar mensaje de texto ───────────────────────────────────────────────────
async function sendText(tenantId, toWaId, body) {
  const { wa_phone_id, wa_token } = await getTenantCreds(tenantId);
  const res = await axios.post(
    `${GRAPH_URL}/${wa_phone_id}/messages`,
    {
      messaging_product: 'whatsapp',
      to: toWaId,
      recipient_type: 'individual',
      type: 'text',
      text: { body, preview_url: false },
    },
    { headers: { Authorization: `Bearer ${wa_token}` } }
  );
  return res.data?.messages?.[0]?.id;
}

// ── Enviar plantilla con botones de respuesta rápida ─────────────────────────
async function sendTemplate(tenantId, toWaId, templateName, language = 'es', components = []) {
  const { wa_phone_id, wa_token } = await getTenantCreds(tenantId);
  const res = await axios.post(
    `${GRAPH_URL}/${wa_phone_id}/messages`,
    {
      messaging_product: 'whatsapp',
      to: toWaId,
      recipient_type: 'individual',
      type: 'template',
      template: {
        name: templateName,
        language: { code: language },
        components,
      },
    },
    { headers: { Authorization: `Bearer ${wa_token}` } }
  );
  return res.data?.messages?.[0]?.id;
}

// ── Enviar plantilla con botones YES/NO ───────────────────────────────────────
async function sendAppointmentReminder(tenantId, toWaId, { name, date, time, templateName }) {
  const components = [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: name },
        { type: 'text', text: date },
        { type: 'text', text: time },
      ],
    },
  ];
  return sendTemplate(tenantId, toWaId, templateName, 'es', components);
}

// ── Push notification via FCM ─────────────────────────────────────────────────
async function sendPush(tenantId, fcmToken, title, body, data = {}) {
  const tenant = await db.prepare('SELECT fcm_server_key FROM tenants WHERE id = ?').get(tenantId);
  if (!tenant?.fcm_server_key || !fcmToken) return;

  await axios.post(
    'https://fcm.googleapis.com/fcm/send',
    {
      to: fcmToken,
      notification: { title, body, sound: 'default' },
      data: { type: 'whasat', ...data },
    },
    { headers: { Authorization: `key=${tenant.fcm_server_key}` } }
  );
}

// ── Enviar push a todos los agentes del tenant ────────────────────────────────
async function broadcastPush(tenantId, title, body, data = {}) {
  const agents = await db.prepare(
    'SELECT fcm_token FROM agents WHERE tenant_id = ? AND fcm_token IS NOT NULL AND active = 1'
  ).all(tenantId);
  await Promise.allSettled(agents.map(a => sendPush(tenantId, a.fcm_token, title, body, data)));
}

// ── Push a agente específico ──────────────────────────────────────────────────
async function pushToAgent(tenantId, agentId, title, body, data = {}) {
  const agent = await db.prepare('SELECT fcm_token FROM agents WHERE id = ? AND tenant_id = ?').get(agentId, tenantId);
  if (agent?.fcm_token) {
    await sendPush(tenantId, agent.fcm_token, title, body, data);
  }
}

module.exports = { sendText, sendTemplate, sendAppointmentReminder, pushToAgent, broadcastPush };
