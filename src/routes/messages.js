const router = require('express').Router();
const db     = require('../db');
const auth   = require('../middleware/auth');
const wa     = require('../services/whatsapp');

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

// POST /api/conversations/:convId/messages
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
      return res.status(400).json({ error: `Tipo '${type}' no soportado` });
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
