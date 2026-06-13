const router = require('express').Router();
const db     = require('../db');
const auth   = require('../middleware/auth');

// GET /api/conversations
router.get('/', auth, async (req, res) => {
  try {
    const { status = 'open', assigned_to, page = 1 } = req.query;
    const limit  = 30;
    const offset = (page - 1) * limit;
    const tid    = req.agent.tenant_id;

    let where  = 'WHERE c.tenant_id = ?';
    const params = [tid];

    if (status !== 'all') { where += ' AND c.status = ?'; params.push(status); }

    if (assigned_to === 'me') {
      where += ' AND c.assigned_to = ?';
      params.push(req.agent.id);
    } else if (assigned_to === 'unassigned') {
      where += ' AND c.assigned_to IS NULL';
    }

    params.push(limit, offset);

    const rows = await db.prepare(`
      SELECT c.id, c.status, c.unread_count, c.last_message, c.last_msg_at, c.lead_id,
             ct.id AS contact_id, ct.name AS contact_name, ct.wa_id, ct.phone,
             a.id  AS agent_id,   a.name  AS agent_name
      FROM conversations c
      JOIN contacts ct ON ct.id = c.contact_id
      LEFT JOIN agents a ON a.id = c.assigned_to
      ${where}
      ORDER BY c.last_msg_at DESC NULLS LAST
      LIMIT ? OFFSET ?
    `).all(...params);

    res.json({ conversations: rows, page: Number(page) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// GET /api/conversations/:id
router.get('/:id', auth, async (req, res) => {
  try {
    const conv = await db.prepare(`
      SELECT c.id, c.status, c.unread_count, c.last_message, c.last_msg_at, c.lead_id,
             ct.id AS contact_id, ct.name AS contact_name, ct.wa_id, ct.phone,
             a.id  AS agent_id,   a.name  AS agent_name
      FROM conversations c
      JOIN contacts ct ON ct.id = c.contact_id
      LEFT JOIN agents a ON a.id = c.assigned_to
      WHERE c.id = ? AND c.tenant_id = ?
    `).get(req.params.id, req.agent.tenant_id);

    if (!conv) return res.status(404).json({ error: 'No encontrada' });

    await db.prepare('UPDATE conversations SET unread_count = 0 WHERE id = ?').run(conv.id);
    res.json({ conversation: conv });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// PATCH /api/conversations/:id
router.patch('/:id', auth, async (req, res) => {
  try {
    const { assigned_to, status, unread_count } = req.body;
    const tid = req.agent.tenant_id;

    const conv = await db.prepare('SELECT id FROM conversations WHERE id = ? AND tenant_id = ?').get(req.params.id, tid);
    if (!conv) return res.status(404).json({ error: 'No encontrada' });

    if (assigned_to !== undefined)
      await db.prepare('UPDATE conversations SET assigned_to = ? WHERE id = ?').run(assigned_to || null, req.params.id);
    if (status)
      await db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run(status, req.params.id);
    if (unread_count !== undefined)
      await db.prepare('UPDATE conversations SET unread_count = ? WHERE id = ?').run(unread_count, req.params.id);

    const updated = await db.prepare(`
      SELECT c.*, ct.name AS contact_name, ct.wa_id, a.name AS agent_name
      FROM conversations c
      JOIN contacts ct ON ct.id = c.contact_id
      LEFT JOIN agents a ON a.id = c.assigned_to
      WHERE c.id = ?
    `).get(req.params.id);

    req.app.get('io').to(`tenant:${tid}`).emit('conversation:updated', updated);
    res.json({ conversation: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// DELETE /api/conversations/:id
router.delete('/:id', auth, async (req, res) => {
  try {
    const tid  = req.agent.tenant_id;
    const conv = await db.prepare('SELECT id FROM conversations WHERE id = ? AND tenant_id = ?').get(req.params.id, tid);
    if (!conv) return res.status(404).json({ error: 'No encontrada' });

    await db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conv.id);
    await db.prepare('DELETE FROM automation_timers WHERE tenant_id = ? AND run_id IN (SELECT id FROM automation_runs WHERE tenant_id = ? AND context LIKE ?)').run(tid, tid, `%"conversation_id":${conv.id}%`);
    await db.prepare('DELETE FROM conversations WHERE id = ?').run(conv.id);

    req.app.get('io').to(`tenant:${tid}`).emit('conversation:deleted', { id: conv.id });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// GET /api/leads/:leadId/conversation — historial del lead para el CRM
router.get('/lead/:leadId', auth, async (req, res) => {
  try {
    const messages = await db.prepare(`
      SELECT m.id, m.direction, m.type, m.body, m.status, m.created_at,
             a.name AS sender_name
      FROM conversations c
      JOIN messages m ON m.conversation_id = c.id
      LEFT JOIN agents a ON a.id = m.sender_id
      WHERE c.lead_id = ? AND c.tenant_id = ?
      ORDER BY m.created_at ASC
    `).all(req.params.leadId, req.agent.tenant_id);

    res.json({ messages });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

module.exports = router;
