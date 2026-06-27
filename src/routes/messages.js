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
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB máx
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

    const messages = await db.prepare(`
      SELECT m.*, a.name AS sender_name
      FROM messages m
      LEFT JOIN agents a ON a.id = m.sender_id
      WHERE m.conversation_id = ? AND m.tenant_id = ?
      ORDER BY m.created_at ASC
      LIMIT ? OFFSET ?
    `).all(req.params.convId, tid, limit, offset);

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

    const mediaType = getMimeMediaType(mimetype);

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
    const pipelineSetMedia = conv.pipeline_stage === 'abierto' ? `, pipeline_stage = 'contactado'` : '';
    await db.prepare(`
      UPDATE conversations
      SET last_message = ?, last_msg_at = NOW(), status = 'open'${pipelineSetMedia}
      WHERE id = ?
    `).run(`[${mediaType}] ${originalname}`, req.params.convId);

    const newMsg = await db.prepare(`
      SELECT m.*, a.name AS sender_name FROM messages m
      LEFT JOIN agents a ON a.id = m.sender_id
      WHERE m.id = ?
    `).get(insert.lastInsertRowid);

    req.app.get('io').to(`conv:${req.params.convId}`).emit('message:new', newMsg);
    res.status(201).json({ message: newMsg });

  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('Error enviando media:', detail);
    res.status(502).json({ error: 'Error enviando media', detail });
  }
});

// POST /api/conversations/:convId/messages  — texto y plantillas
router.post('/:convId/messages', auth, async (req, res) => {
  const { type = 'text', body, template_name, template_language, template_components } = req.body;
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
      waMessageId = await wa.sendText(tid, conv.wa_id, body);
    } else if (type === 'template') {
      waMessageId = await wa.sendTemplate(tid, conv.wa_id, template_name, template_language, template_components);
    } else {
      return res.status(400).json({ error: `Tipo '${type}' no soportado. Para media usa POST /messages/media` });
    }

    const insert = await db.prepare(`
      INSERT INTO messages (tenant_id, conversation_id, wa_message_id, direction, type, body, status, sender_id)
      VALUES (?, ?, ?, 'outbound', ?, ?, 'sent', ?)
    `).run(tid, req.params.convId, waMessageId || null, type, body || null, req.agent.id);

    // Si el lead seguía "abierto" (sin contactar) en el Pipeline y ahora le respondimos,
    // pasa automáticamente a "contactado" — ya hubo respuesta de nuestro lado.
    const pipelineSetText = conv.pipeline_stage === 'abierto' ? `, pipeline_stage = 'contactado'` : '';
    await db.prepare(`
      UPDATE conversations
      SET last_message = ?, last_msg_at = NOW(), status = 'open'${pipelineSetText}
      WHERE id = ?
    `).run(body || `[${type}]`, req.params.convId);

    const newMsg = await db.prepare(`
      SELECT m.*, a.name AS sender_name FROM messages m
      LEFT JOIN agents a ON a.id = m.sender_id
      WHERE m.id = ?
    `).get(insert.lastInsertRowid);

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
