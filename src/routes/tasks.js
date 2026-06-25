const router = require('express').Router();
const db     = require('../db');
const auth   = require('../middleware/auth');

// ── Tareas/recordatorios ligados a una conversación ───────────────────────────
// Ej: "quedamos en llamarle mañana" → se crea una tarea con due_at = mañana,
// el cron (engine/cron.js) avisa por push al agente asignado cuando vence.

// GET /api/conversations/:id/tasks — tareas de una conversación
router.get('/conversations/:id/tasks', auth, async (req, res) => {
  try {
    const tid = req.agent.tenant_id;
    const rows = await db.prepare(`
      SELECT t.*, a.name AS agent_name
      FROM conversation_tasks t
      LEFT JOIN agents a ON a.id = t.agent_id
      WHERE t.tenant_id = ? AND t.conversation_id = ?
      ORDER BY t.status = 'pending' DESC, t.due_at ASC
    `).all(tid, req.params.id);
    res.json({ tasks: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// POST /api/conversations/:id/tasks — crear recordatorio
router.post('/conversations/:id/tasks', auth, async (req, res) => {
  try {
    const tid   = req.agent.tenant_id;
    const convId = req.params.id;
    const { title, due_at, agent_id } = req.body;

    if (!title?.trim() || !due_at) {
      return res.status(400).json({ error: 'title y due_at son obligatorios' });
    }

    const conv = await db.prepare(
      'SELECT id, assigned_to FROM conversations WHERE id = ? AND tenant_id = ?'
    ).get(convId, tid);
    if (!conv) return res.status(404).json({ error: 'Conversación no encontrada' });

    const assignedTo = agent_id || conv.assigned_to || req.agent.id;

    const row = await db.prepare(`
      INSERT INTO conversation_tasks (tenant_id, conversation_id, agent_id, title, due_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?)
      RETURNING *
    `).get(tid, convId, assignedTo, title.trim(), due_at, req.agent.id);

    res.status(201).json({ task: row });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// PATCH /api/tasks/:id — marcar hecha / editar
router.patch('/tasks/:id', auth, async (req, res) => {
  try {
    const tid = req.agent.tenant_id;
    const { status, title, due_at } = req.body;

    const existing = await db.prepare(
      'SELECT id FROM conversation_tasks WHERE id = ? AND tenant_id = ?'
    ).get(req.params.id, tid);
    if (!existing) return res.status(404).json({ error: 'Tarea no encontrada' });

    const fields = [];
    const params = [];
    if (status) {
      fields.push('status = ?');
      params.push(status);
      if (status === 'done') fields.push('completed_at = NOW()');
    }
    if (title?.trim()) { fields.push('title = ?'); params.push(title.trim()); }
    if (due_at)         { fields.push('due_at = ?'); params.push(due_at); fields.push('reminder_sent = 0'); }

    if (!fields.length) return res.status(400).json({ error: 'Nada que actualizar' });

    params.push(req.params.id, tid);
    const row = await db.prepare(`
      UPDATE conversation_tasks SET ${fields.join(', ')}
      WHERE id = ? AND tenant_id = ?
      RETURNING *
    `).get(...params);

    res.json({ task: row });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// DELETE /api/tasks/:id
router.delete('/tasks/:id', auth, async (req, res) => {
  try {
    const tid = req.agent.tenant_id;
    await db.prepare('DELETE FROM conversation_tasks WHERE id = ? AND tenant_id = ?').run(req.params.id, tid);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// GET /api/tasks/pending — recordatorios pendientes del agente logueado (todas sus conversaciones)
router.get('/tasks/pending', auth, async (req, res) => {
  try {
    const rows = await db.prepare(`
      SELECT t.*, c.contact_id, ct.name AS contact_name
      FROM conversation_tasks t
      JOIN conversations c ON c.id = t.conversation_id
      JOIN contacts ct     ON ct.id = c.contact_id
      WHERE t.tenant_id = ? AND t.agent_id = ? AND t.status = 'pending'
      ORDER BY t.due_at ASC
    `).all(req.agent.tenant_id, req.agent.id);
    res.json({ tasks: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

module.exports = router;
