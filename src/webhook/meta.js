/**
 * Webhook Meta WhatsApp — multi-tenant
 *
 * Meta envía todos los mensajes a una sola URL.
 * Identificamos el tenant por el wa_phone_number_id que viene en el payload.
 */

const router  = require('express').Router();
const db      = require('../db');
const engine  = require('../engine/automation-engine');
const wa      = require('../services/whatsapp');
const { pushToCRM } = require('../services/crm-sync');
const { normalizePhone } = require('../utils/phone');

// GET /webhook/meta — verificación (Meta usa un solo verify token global)
router.get('/', async (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  // Buscamos algún tenant que tenga ese verify token
  if (mode === 'subscribe') {
    const tenant = await db.prepare('SELECT id FROM tenants WHERE wa_verify_token = ?').get(token);
    if (tenant) {
      console.log('✅ Webhook Meta verificado');
      return res.status(200).send(challenge);
    }
  }
  res.status(403).send('Forbidden');
});

// POST /webhook/meta — mensajes entrantes
router.post('/', (req, res) => {
  res.sendStatus(200); // responder rápido a Meta
  console.log('📨 Webhook Meta recibido:', JSON.stringify(req.body).slice(0, 200));

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'messages') continue;
        const value = change.value;

        // Identificar tenant por phone_number_id
        const phoneNumberId = value.metadata?.phone_number_id;

        db.prepare('SELECT * FROM tenants WHERE wa_phone_id = ? AND active = 1').get(phoneNumberId)
          .then(tenant => {
            if (!tenant) {
              console.warn('Webhook recibido para phone_id desconocido:', phoneNumberId);
              return;
            }

            // ── Actualizaciones de estado ──────────────────────────────────────
            for (const status of value.statuses || []) {
              db.prepare(`
                UPDATE messages SET status = ? WHERE wa_message_id = ? AND tenant_id = ?
              `).run(status.status, status.id, tenant.id).catch(console.error);
            }

            // ── Mensajes entrantes ─────────────────────────────────────────────
            for (const msg of value.messages || []) {
              processInboundMessage(msg, value, tenant, req.app.get('io')).catch(console.error);
            }
          })
          .catch(err => console.error('Error procesando webhook Meta:', err));
      }
    }
  } catch (err) {
    console.error('Error procesando webhook Meta:', err);
  }
});

async function processInboundMessage(msg, value, tenant, io) {
  const waId   = normalizePhone(msg.from);
  const waName = value.contacts?.find(c => c.wa_id === msg.from)?.profile?.name || waId;

  // Upsert contacto
  await db.prepare(`
    INSERT INTO contacts (tenant_id, wa_id, name, phone)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(tenant_id, wa_id) DO UPDATE SET name = excluded.name
  `).run(tenant.id, waId, waName, waId);

  const contact = await db.prepare('SELECT * FROM contacts WHERE tenant_id = ? AND wa_id = ?').get(tenant.id, waId);

  // Upsert conversación
  let conv = await db.prepare('SELECT * FROM conversations WHERE tenant_id = ? AND contact_id = ?').get(tenant.id, contact.id);
  if (!conv) {
    const ins = await db.prepare(`
      INSERT INTO conversations (tenant_id, contact_id, lead_id, status)
      VALUES (?, ?, ?, 'open')
    `).run(tenant.id, contact.id, contact.lead_id || null);
    conv = await db.prepare('SELECT * FROM conversations WHERE id = ?').get(ins.lastInsertRowid);
  }

  // Extraer contenido del mensaje
  let type = msg.type, body_text = null, media_url = null, media_mime = null;

  if (type === 'text') {
    body_text = msg.text?.body;
  } else if (['image', 'audio', 'video', 'document'].includes(type)) {
    const media = msg[type];
    media_url   = media?.id;
    media_mime  = media?.mime_type;
    body_text   = media?.caption || null;
  } else if (type === 'interactive') {
    const btn  = msg.interactive?.button_reply;
    const list = msg.interactive?.list_reply;
    body_text  = btn?.title || list?.title || '[interactive]';
    type       = 'text';
  } else if (type === 'button') {
    body_text = msg.button?.text;
    type      = 'text';
  }

  // Deduplicación
  const existing = await db.prepare('SELECT id FROM messages WHERE wa_message_id = ?').get(msg.id);
  if (existing) return;

  // Insertar mensaje
  await db.prepare(`
    INSERT INTO messages (tenant_id, conversation_id, wa_message_id, direction, type, body, media_url, media_mime, status)
    VALUES (?, ?, ?, 'inbound', ?, ?, ?, ?, 'received')
  `).run(tenant.id, conv.id, msg.id, type, body_text, media_url, media_mime);

  // Actualizar conversación. followup_24h_sent = false: el contacto acaba de
  // responder, así que el ciclo de "sin respuesta 24h" se reinicia.
  await db.prepare(`
    UPDATE conversations
    SET last_message = ?, last_msg_at = NOW(), unread_count = unread_count + 1, status = 'open', followup_24h_sent = false
    WHERE id = ?
  `).run(body_text || `[${type}]`, conv.id);

  const fullConv = await db.prepare(`
    SELECT c.*, ct.name AS contact_name, ct.wa_id, a.name AS agent_name
    FROM conversations c
    JOIN contacts ct ON ct.id = c.contact_id
    LEFT JOIN agents a ON a.id = c.assigned_to
    WHERE c.id = ?
  `).get(conv.id);

  const newMsg = await db.prepare('SELECT * FROM messages WHERE wa_message_id = ?').get(msg.id);

  // Emitir tiempo real (sala del tenant + sala de conversación)
  io.to(`tenant:${tenant.id}`).emit('conversation:updated', fullConv);
  io.to(`conv:${conv.id}`).emit('message:new', newMsg);

  // Push notification: al agente asignado, o a todo el equipo si la conversación
  // todavía no tiene agente (caso típico de un lead nuevo) — sin este fallback
  // los leads nuevos no generaban ninguna notificación.
  if (fullConv.assigned_to) {
    wa.pushToAgent(tenant.id, fullConv.assigned_to,
      waName, body_text || `[${type}]`,
      { conversation_id: String(conv.id), tenant_slug: tenant.slug }
    ).catch(console.error);
  } else {
    wa.broadcastPush(tenant.id,
      waName, body_text || `[${type}]`,
      { conversation_id: String(conv.id), tenant_slug: tenant.slug }
    ).catch(console.error);
  }

  // ── Verificar si hay un timer esperando respuesta de este contacto ────────
  const pendingTimers = await db.prepare(`
    SELECT t.* FROM automation_timers t
    JOIN automation_runs r ON r.id = t.run_id
    WHERE t.tenant_id = ? AND t.status = 'pending' AND t.waiting_for = 'response'
  `).all(tenant.id);

  for (const timer of pendingTimers) {
    const ctx = JSON.parse(timer.context || '{}');
    if (ctx.contact?.wa_id === waId || ctx.wa_id === waId) {
      await engine.resolveTimer(timer.id, { response: body_text }).catch(console.error);
    }
  }

  // ── Sincronizar con CRM ───────────────────────────────────────────────────
  pushToCRM({
    tenantId:    tenant.id,
    convId:      conv.id,
    direction:   'inbound',
    phone:       waId,
    contactName: waName,
    leadId:      contact.lead_id || null,
    message:     newMsg,
  });

  // ── Disparar automatización message.received ──────────────────────────────
  await engine.fire('message.received', tenant.id, {
    message:         newMsg,
    contact:         { id: contact.id, wa_id: contact.wa_id, name: contact.name },
    conversation:    fullConv,
    conversation_id: conv.id,
    lead_id:         contact.lead_id,
  }).catch(console.error);
}

module.exports = router;
