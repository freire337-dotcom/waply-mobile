/**
 * Notificaciones in-app para la app móvil.
 *
 * GET  /api/notifications          — lista para el agente actual (propias + globales del tenant)
 * PATCH /api/notifications/:id/read — marcar una como leída
 * POST  /api/notifications/read-all — marcar todas como leídas
 */

const router = require('express').Router();
const db     = require('../db');
const auth   = require('../middleware/auth');

// GET /api/notifications
router.get('/', auth, async (req, res) => {
  try {
    const tid = req.agent.tenant_id;
    const aid = req.agent.id;

    const rows = await db.prepare(`
      SELECT * FROM notifications
      WHERE tenant_id = ?
        AND (agent_id = ? OR agent_id IS NULL)
      ORDER BY created_at DESC
      LIMIT 100
    `).all(tid, aid);

    const unread = rows.filter(n => !n.read).length;
    res.json({ notifications: rows, unread });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// PATCH /api/notifications/:id/read
router.patch('/:id/read', auth, async (req, res) => {
  try {
    const tid = req.agent.tenant_id;
    const aid = req.agent.id;
    await db.prepare(`
      UPDATE notifications SET read = true
      WHERE id = ? AND tenant_id = ? AND (agent_id = ? OR agent_id IS NULL)
    `).run(req.params.id, tid, aid);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// POST /api/notifications/read-all
router.post('/read-all', auth, async (req, res) => {
  try {
    const tid = req.agent.tenant_id;
    const aid = req.agent.id;
    await db.prepare(`
      UPDATE notifications SET read = true
      WHERE tenant_id = ? AND (agent_id = ? OR agent_id IS NULL) AND read = false
    `).run(tid, aid);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

module.exports = router;
