const router = require('express').Router();
const multer = require('multer');
const db     = require('../db');
const auth   = require('../middleware/auth');
const wa     = require('../services/whatsapp');

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
    const { originalname, mimetype, buffer } = req.file;
    const caption = req.body.caption || '';
    const mediaType = getMimeMediaType(mimetype);

    // 1. Subir a Meta y obtener media_id
    const mediaId = await wa.uploadMedia(tid, buffer, mimetype, originalname);

    // 2. Enviar mensaje con el media_id
    const waMessageId = await wa.sendMedia(tid, conv.wa_id, mediaType, mediaId, caption);

    // 3. Guardar en BD
    const insert = await db.prepare(`
      INSERT INTO messages (tenant_id, conversation_id, wa_message_id, direction, type, body, media_url, media_mime, status, sender_id)
      VALUES (?, ?, ?, 'outbound', ?, ?, ?, ?, 'sent', ?)
    `).run(tid, req.params.convId, waMessageId || null, mediaType, caption || null, originalname, mimetype, req.agent.id);

    await db.prepare(`
      UPDATE conversations
      SET last_message = ?, last_msg_at = NOW(), status = 'open'
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

    await db.prepare(`
      UPDATE conversations
      SET last_message = ?, last_msg_at = NOW(), status = 'open'
      WHERE id = ?
    `).run(body || `[${type}]`, req.params.convId);

    const newMsg = await db.prepare(`
      SELECT m.*, a.name AS sender_name FROM messages m
      LEFT JOIN agents a ON a.id = m.sender_id
      WHERE m.id = ?
    `).get(insert.lastInsertRowid);

    req.app.get('io').to(`conv:${req.params.convId}`).emit('message:new', newMsg);
    res.status(201).json({ message: newMsg });

  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('Error enviando a WhatsApp:', detail);
    res.status(502).json({ error: 'Error enviando mensaje', detail });
  }
});

module.exports = router;
