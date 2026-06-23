/**
 * Servicio WhatsApp Business API
 * Abstrae todas las llamadas a Meta Graph API
 * Usa las credenciales del tenant, no variables de entorno globales
 */

const axios    = require('axios');
const FormData = require('form-data');
const db       = require('../db');

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

// ── Subir media a Meta y obtener media_id ─────────────────────────────────────
async function uploadMedia(tenantId, buffer, mimeType, filename) {
  const { wa_phone_id, wa_token } = await getTenantCreds(tenantId);
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', buffer, { filename, contentType: mimeType });
  const res = await axios.post(
    `${GRAPH_URL}/${wa_phone_id}/media`,
    form,
    { headers: { ...form.getHeaders(), Authorization: `Bearer ${wa_token}` } }
  );
  return res.data.id; // media_id
}

// ── Enviar mensaje de media (image / video / document / audio) ────────────────
async function sendMedia(tenantId, toWaId, mediaType, mediaId, caption = '') {
  const { wa_phone_id, wa_token } = await getTenantCreds(tenantId);
  const mediaObj = { id: mediaId };
  if (caption && mediaType !== 'audio') mediaObj.caption = caption;
  const res = await axios.post(
    `${GRAPH_URL}/${wa_phone_id}/messages`,
    {
      messaging_product: 'whatsapp',
      to: toWaId,
      recipient_type: 'individual',
      type: mediaType,
      [mediaType]: mediaObj,
    },
    { headers: { Authorization: `Bearer ${wa_token}` } }
  );
  return res.data?.messages?.[0]?.id;
}

// ── Push notification vía Expo Push API ───────────────────────────────────────
// La app móvil registra un Expo push token (formato "ExponentPushToken[...]"),
// no un token FCM nativo, así que el envío debe pasar por el servicio de Expo
// (que internamente reenvía a FCM/APNs). Enviar este token directo a la API
// legacy de FCM con una server key nunca funcionaba: por eso ninguna notificación
// llegaba al móvil.
async function sendPush(tenantId, pushToken, title, body, data = {}) {
  if (!pushToken) return;

  if (!pushToken.startsWith('ExponentPushToken[')) {
    console.warn(`sendPush: token con formato no soportado para tenant ${tenantId}, se ignora`);
    return;
  }

  try {
    const res = await axios.post(
      'https://exp.host/--/api/v2/push/send',
      {
        to: pushToken,
        title,
        body,
        sound: 'default',
        priority: 'high',
        channelId: 'default',
        data: { type: 'whasat', ...data },
      },
      { headers: { Accept: 'application/json', 'Content-Type': 'application/json' } }
    );

    const ticket = res.data?.data;
    if (ticket?.status === 'error') {
      console.warn(`sendPush: Expo devolvió error para tenant ${tenantId}:`, ticket.message);
    }
  } catch (err) {
    console.error(`sendPush: fallo al enviar push (tenant ${tenantId}):`, err.message);
  }
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

module.exports = { sendText, sendTemplate, sendAppointmentReminder, uploadMedia, sendMedia, pushToAgent, broadcastPush };
