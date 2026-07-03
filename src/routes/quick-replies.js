const router = require('express').Router();
const db     = require('../db');
const auth   = require('../middleware/auth');

// GET /api/quick-replies — listar todas las del tenant
router.get('/', auth, async (req, res) => {
  try {
    const replies = await db.prepare(
      'SELECT * FROM quick_replies WHERE tenant_id = ? ORDER BY name ASC'
    ).all(req.agent.tenant_id);
    res.json(replies);
  } catch (err) {
    console.error('[quick-replies] GET error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/quick-replies — crear nueva
router.post('/', auth, async (req, res) => {
  try {
    const { name, body } = req.body;
    if (!name?.trim() || !body?.trim())
      return res.status(400).json({ error: 'name y body son obligatorios' });

    const result = await db.prepare(
      'INSERT INTO quick_replies (tenant_id, name, body, created_by) VALUES (?, ?, ?, ?)'
    ).run(req.agent.tenant_id, name.trim(), body.trim(), req.agent.id);

    const reply = await db.prepare('SELECT * FROM quick_replies WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(reply);
  } catch (err) {
    console.error('[quick-replies] POST error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/quick-replies/:id — editar
router.put('/:id', auth, async (req, res) => {
  try {
    const { name, body } = req.body;
    if (!name?.trim() || !body?.trim())
      return res.status(400).json({ error: 'name y body son obligatorios' });

    const changes = await db.prepare(
      'UPDATE quick_replies SET name = ?, body = ? WHERE id = ? AND tenant_id = ?'
    ).run(name.trim(), body.trim(), req.params.id, req.agent.tenant_id);

    if (!changes.changes) return res.status(404).json({ error: 'No encontrada' });

    const reply = await db.prepare('SELECT * FROM quick_replies WHERE id = ?').get(req.params.id);
    res.json(reply);
  } catch (err) {
    console.error('[quick-replies] PUT error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/quick-replies/:id — borrar
router.delete('/:id', auth, async (req, res) => {
  try {
    await db.prepare(
      'DELETE FROM quick_replies WHERE id = ? AND tenant_id = ?'
    ).run(req.params.id, req.agent.tenant_id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[quick-replies] DELETE error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
