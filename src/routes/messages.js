const router  = require('express').Router();
const multer  = require('multer');
const db      = require('../db');
const auth    = require('../middleware/auth');
const wa      = require('../services/whatsapp');
const { pushToCRM } = require('../services/crm-sync');
const { convertToOggOpus } = require('../services/audio-convert');

// MIME de audio que la API de WhatsApp acepta tal cual.
const ALLOWED_AUDIO_MIMES = ['audio/aac', 'audio/mp4', 'audio/mpeg', 'audio/amr', 'audio/ogg'];

// Multer en memoria (no guarda en disco, sube directo a Meta)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB — el backend comprime video/audio antes de subir a Meta
});

// MIME → tipo WhatsApp
function getMimeMediaType(mimeType) {
  if (!mimeType) return 'document';
  if (mimeType.startsWith('image/'))  return 'image';
  if (mimeType.startsWith('video/'))  return 'video';
  if (mimeType.startsWith('audio/'))  return 'audio';
  return 'document';
}

// GET /api/conversations/:convId/messages
router.get('/:convId/messages', auth, async (req, res) => {
  try {
    const { page = 1 } = req.query;
    const limit  = 50;
    const offset = (page - 1) * limit;
    const tid    = req.agent.tenant_id;

    const conv = await db.prepare('SELECT id FROM conversations WHERE id = ? AND tenant_id = ?').get(req.params.convId, tid);
    if (!conv) return res.status(404).json({ error: 'Conversación no encontrada' });

    const rows = await db.prepare(`
      SELECT m.*, a.name AS sender_name,
             qm.body      AS quoted_body,
             qm.type      AS quoted_type,
             qm.direction AS quoted_direction,
             qm.media_url AS quoted_media_url,
             qa.name      AS quoted_sender_name
      FROM messages m
      LEFT JOIN agents a  ON a.id  = m.sender_id
      LEFT JOIN messages qm ON qm.wa_message_id = m.context_wa_message_id
      LEFT JOIN agents qa ON qa.id = qm.sender_id
      WHERE m.conversation_id = ? AND m.tenant_id = ?
      ORDER BY m.created_at ASC
      LIMIT ? OFFSET ?
    `).all(req.params.convId, tid, limit, offset);

    // contacts_payload va como TEXT (JSON serializado) en la BD — el front
    // espera el array ya parseado en `contacts` (ver tarjetas de contacto/vCard).
    const messages = rows.map(m => ({
      ...m,
      contacts: m.contacts_payload ? JSON.parse(m.contacts_payload) : null,
      quoted_message: m.context_wa_message_id ? {
        body:        m.quoted_body,
        type:        m.quoted_type,
        direction:   m.quoted_direction,
        media_url:   m.quoted_media_url,
        sender_name: m.quoted_sender_name,
      } : null,
    }));

    res.json({ messages, page: Number(page) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// POST /api/conversations/:convId/messages/media  — subir archivo y enviarlo
router.post('/:convId/messages/media', auth, upload.single('file'), async (req, res) => {
  const tid = req.agent.tenant_id;

  if (!req.file) return res.status(400).json({ error: 'Archivo requerido' });

  const conv = await db.prepare(`
    SELECT c.*, ct.wa_id FROM conversations c
    JOIN contacts ct ON ct.id = c.contact_id
    WHERE c.id = ? AND c.tenant_id = ?
  `).get(req.params.convId, tid);
  if (!conv) return res.status(404).json({ error: 'Conversación no encontrada' });

  try {
    let { originalname, mimetype, buffer } = req.file;
    const caption = req.body.caption || '';

    // WhatsApp solo acepta ciertos MIME de audio. El navegador (WaplyAdmin web)
    // solo sabe grabar en audio/webm, que Meta rechaza — lo convertimos a
    // Ogg/Opus (sí soportado) antes de subir. Ver services/audio-convert.js.
    if (mimetype.startsWith('audio/') && !ALLOWED_AUDIO_MIMES.includes(mimetype)) {
      buffer = await convertToOggOpus(buffer);
      mimetype = 'audio/ogg';
      originalname = originalname.replace(/\.[^.]+$/, '') + '.ogg';
    }

    // Si el frontend pide enviar como documento (asDocument=true), forzamos
    // tipo 'document' — WhatsApp acepta hasta 100 MB para documentos, sin
    // restricción de codec. Útil para videos > 16 MB que no caben como 'video'.
    const asDocument = req.body.asDocument === 'true';

    // Videos > 16 MB sin flag asDocument: rechazar con mensaje claro.
    if (mimetype.startsWith('video/') && buffer.length > 16 * 1024 * 1024 && !asDocument) {
      return res.status(413).json({ error: 'El video supera 16 MB. Envíalo como documento o comprímelo primero.' });
    }

    const mediaType = asDocument ? 'document' : getMimeMediaType(mimetype);

    // 1. Subir a Meta y obtener media_id
    const mediaId = await wa.uploadMedia(tid, buffer, mimetype, originalname);

    // 2. Enviar mensaje con el media_id
    const waMessageId = await wa.sendMedia(tid, conv.wa_id, mediaType, mediaId, caption);

    // 3. Guardar en BD — media_url guarda el media_id de Meta (igual que en mensajes
    // entrantes) para que el proxy /api/media/:mediaId pueda previsualizarlo en el chat.
    const insert = await db.prepare(`
      INSERT INTO messages (tenant_id, conversation_id, wa_message_id, direction, type, body, media_url, media_mime, status, sender_id)
      VALUES (?, ?, ?, 'outbound', ?, ?, ?, ?, 'sent', ?)
    `).run(tid, req.params.convId, waMessageId || null, mediaType, caption || null, mediaId, mimetype, req.agent.id);

    // Si el lead seguía "abierto" (sin contactar) en el Pipeline y ahora le respondimos,
    // pasa automáticamente a "contactado" — ya hubo respuesta de nuestro lado.
    // followup_24h_sent = false: le acabamos de escribir, el ciclo "sin respuesta 24h"
    // se reinicia desde este mensaje.
    const pipelineSetMedia = conv.pipeline_stage === 'abierto' ? `, pipeline_stage = 'contactado'` : '';
    await db.prepare(`
      UPDATE conversations
      SET last_message = ?, last_msg_at = NOW(), status = 'open', followup_24h_sent = false${pipelineSetMedia}
      WHERE id = ?
    `).run(`[${mediaType}] ${originalname}`, req.params.convId);

    const newMsg = await db.prepare(`
      SELECT m.*, a.name AS sender_name FROM messages m
      LEFT JOIN agents a ON a.id = m.sender_id
      WHERE m.id = ?
    `).get(insert.lastInsertRowid);

    req.app.get('io').to(`conv:${req.params.convId}`).emit('message:new', newMsg);

    pushToCRM({
      tenantId:    tid,
      convId:      Number(req.params.convId),
      direction:   'outbound',
      phone:       conv.wa_id,
      contactName: conv.contact_name || conv.wa_id,
      leadId:      conv.lead_id || null,
      message:     newMsg,
    });

    res.status(201).json({ message: newMsg });

  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('Error enviando media:', detail);
    res.status(502).json({ error: 'Error enviando media', detail });
  }
});

// POST /api/conversations/:convId/messages  — texto y plantillas
router.post('/:convId/messages', auth, async (req, res) => {
  const { type = 'text', body, context_id, template_name, template_language, template_components } = req.body;
  const tid = req.agent.tenant_id;

  const conv = await db.prepare(`
    SELECT c.*, ct.wa_id FROM conversations c
    JOIN contacts ct ON ct.id = c.contact_id
    WHERE c.id = ? AND c.tenant_id = ?
  `).get(req.params.convId, tid);
  if (!conv) return res.status(404).json({ error: 'Conversación no encontrada' });

  try {
    let waMessageId;

    if (type === 'text') {
      if (!body) return res.status(400).json({ error: 'body requerido' });
      waMessageId = await wa.sendText(tid, conv.wa_id, body, context_id || null);
    } else if (type === 'template') {
      waMessageId = await wa.sendTemplate(tid, conv.wa_id, template_name, template_language, template_components);
    } else {
      return res.status(400).json({ error: `Tipo '${type}' no soportado. Para media usa POST /messages/media` });
    }

    const insert = await db.prepare(`
      INSERT INTO messages (tenant_id, conversation_id, wa_message_id, direction, type, body, context_wa_message_id, status, sender_id)
      VALUES (?, ?, ?, 'outbound', ?, ?, ?, 'sent', ?)
    `).run(tid, req.params.convId, waMessageId || null, type, body || null, context_id || null, req.agent.id);

    // Si el lead seguía "abierto" (sin contactar) en el Pipeline y ahora le respondimos,
    // pasa automáticamente a "contactado" — ya hubo respuesta de nuestro lado.
    // followup_24h_sent = false: le acabamos de escribir, el ciclo "sin respuesta 24h"
    // se reinicia desde este mensaje.
    const pipelineSetText = conv.pipeline_stage === 'abierto' ? `, pipeline_stage = 'contactado'` : '';
    await db.prepare(`
      UPDATE conversations
      SET last_message = ?, last_msg_at = NOW(), status = 'open', followup_24h_sent = false${pipelineSetText}
      WHERE id = ?
    `).run(body || `[${type}]`, req.params.convId);

    // Incluir el mensaje citado en la respuesta para que WaplyAdmin/móvil
    // rendericen la cita sin necesidad de recargar mensajes.
    const newMsgRow = await db.prepare(`
      SELECT m.*, a.name AS sender_name,
             qm.body      AS quoted_body,
             qm.type      AS quoted_type,
             qm.direction AS quoted_direction,
             qm.media_url AS quoted_media_url,
             qa.name      AS quoted_sender_name
      FROM messages m
      LEFT JOIN agents a  ON a.id  = m.sender_id
      LEFT JOIN messages qm ON qm.wa_message_id = m.context_wa_message_id
      LEFT JOIN agents qa ON qa.id = qm.sender_id
      WHERE m.id = ?
    `).get(insert.lastInsertRowid);

    const newMsg = {
      ...newMsgRow,
      quoted_message: newMsgRow.context_wa_message_id ? {
        body:        newMsgRow.quoted_body,
        type:        newMsgRow.quoted_type,
        direction:   newMsgRow.quoted_direction,
        media_url:   newMsgRow.quoted_media_url,
        sender_name: newMsgRow.quoted_sender_name,
      } : null,
    };

    req.app.get('io').to(`conv:${req.params.convId}`).emit('message:new', newMsg);

    // Sincronizar con CRM
    pushToCRM({
      tenantId:    tid,
      convId:      Number(req.params.convId),
      direction:   'outbound',
      phone:       conv.wa_id,
      contactName: conv.contact_name || conv.wa_id,
      leadId:      conv.lead_id || null,
      message:     newMsg,
    });

    res.status(201).json({ message: newMsg });

  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('Error enviando a WhatsApp:', detail);
    res.status(502).json({ error: 'Error enviando mensaje', detail });
  }
});

// POST /api/messages/:id/forward — reenviar un mensaje a otra conversación
router.post('/:id/forward', auth, async (req, res) => {
  try {
    const { target_conv_id } = req.body;
    if (!target_conv_id) return res.status(400).json({ error: 'target_conv_id requerido' });
    const tid = req.agent.tenant_id;

    // Mensaje origen
    const msg = await db.prepare(`
      SELECT m.* FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE m.id = ? AND c.tenant_id = ?
    `).get(req.params.id, tid);
    if (!msg) return res.status(404).json({ error: 'Mensaje no encontrado' });

    // Conversación destino
    const targetConv = await db.prepare(`
      SELECT c.*, ct.wa_id FROM conversations c
      JOIN contacts ct ON ct.id = c.contact_id
      WHERE c.id = ? AND c.tenant_id = ?
    `).get(target_conv_id, tid);
    if (!targetConv) return res.status(404).json({ error: 'Conversación destino no encontrada' });

    // Enviar según tipo
    let waMessageId;
    if (msg.type === 'text') {
      if (!msg.body) return res.status(400).json({ error: 'El mensaje no tiene texto' });
      waMessageId = await wa.sendText(tid, targetConv.wa_id, msg.body);
    } else if (['image', 'video', 'audio', 'document'].includes(msg.type) && msg.media_url) {
      waMessageId = await wa.sendMedia(tid, targetConv.wa_id, msg.type, msg.media_url);
    } else {
      return res.status(400).json({ error: 'No se puede reenviar este tipo de mensaje' });
    }

    // Guardar en BD
    const insert = await db.prepare(`
      INSERT INTO messages (tenant_id, conversation_id, wa_message_id, direction, type, body, media_url, media_mime, status, sender_id)
      VALUES (?, ?, ?, 'outbound', ?, ?, ?, ?, 'sent', ?)
    `).run(tid, target_conv_id, waMessageId || null, msg.type, msg.body || null, msg.media_url || null, msg.media_mime || null, req.agent.id);

    await db.prepare(`
      UPDATE conversations
      SET last_message = ?, last_msg_at = NOW(), status = 'open', followup_24h_sent = false
      WHERE id = ?
    `).run(msg.body || `[${msg.type}]`, target_conv_id);

    const newMsg = await db.prepare(`
      SELECT m.*, a.name AS sender_name FROM messages m
      LEFT JOIN agents a ON a.id = m.sender_id
      WHERE m.id = ?
    `).get(insert.lastInsertRowid);

    req.app.get('io').to(`conv:${target_conv_id}`).emit('message:new', newMsg);

    res.status(201).json({ message: newMsg });
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('Error reenviando mensaje:', detail);
    res.status(502).json({ error: 'Error reenviando mensaje', detail });
  }
});

// PATCH /api/messages/:id — editar texto de un mensaje saliente (solo admin)
router.patch('/:id', auth, async (req, res) => {
  try {
    if (req.agent.role !== 'admin') return res.status(403).json({ error: 'Solo un administrador puede editar mensajes' });
    const { body } = req.body;
    if (!body || !body.trim()) return res.status(400).json({ error: 'body requerido' });
    const tid = req.agent.tenant_id;

    const msg = await db.prepare(`
      SELECT m.* FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE m.id = ? AND c.tenant_id = ?
    `).get(req.params.id, tid);
    if (!msg) return res.status(404).json({ error: 'Mensaje no encontrado' });
    if (msg.direction !== 'outbound' || (msg.type && msg.type !== 'text')) {
      return res.status(400).json({ error: 'Solo se pueden editar mensajes de texto salientes' });
    }

    await db.prepare('UPDATE messages SET body = ?, edited = true WHERE id = ?').run(body.trim(), msg.id);

    const updated = await db.prepare(`
      SELECT m.*, a.name AS sender_name FROM messages m
      LEFT JOIN agents a ON a.id = m.sender_id
      WHERE m.id = ?
    `).get(msg.id);

    req.app.get('io').to(`conv:${msg.conversation_id}`).emit('message:updated', updated);
    res.json({ message: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// DELETE /api/messages/:id — borrar un mensaje del historial (solo admin)
router.delete('/:id', auth, async (req, res) => {
  try {
    if (req.agent.role !== 'admin') return res.status(403).json({ error: 'Solo un administrador puede eliminar mensajes' });
    const tid = req.agent.tenant_id;

    const msg = await db.prepare(`
      SELECT m.* FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE m.id = ? AND c.tenant_id = ?
    `).get(req.params.id, tid);
    if (!msg) return res.status(404).json({ error: 'Mensaje no encontrado' });

    await db.prepare('DELETE FROM messages WHERE id = ?').run(msg.id);

    req.app.get('io').to(`conv:${msg.conversation_id}`).emit('message:deleted', { id: msg.id, conversation_id: msg.conversation_id });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

module.exports = router;
