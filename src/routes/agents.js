const router = require('express').Router();
const bcrypt = require('bcryptjs');
const db     = require('../db');
const auth   = require('../middleware/auth');

// GET /api/agents  — listar agentes (para asignación)
router.get('/', auth, async (req, res) => {
  try {
    const agents = await db.prepare('SELECT id, name, email, role, active, is_ai_agent FROM agents WHERE tenant_id = ? ORDER BY name').all(req.agent.tenant_id);
    res.json({ agents });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// POST /api/agents  — crear agente (solo admin)
router.post('/', auth, async (req, res) => {
  try {
    if (req.agent.role !== 'admin') {
      return res.status(403).json({ error: 'Solo admins pueden crear agentes' });
    }
    const { name, email, password, role = 'agent' } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'name, email y password son requeridos' });
    }

    const existing = await db.prepare('SELECT id FROM agents WHERE email = ? AND tenant_id = ?').get(email, req.agent.tenant_id);
    if (existing) return res.status(409).json({ error: 'Email ya registrado' });

    const tenant = await db.prepare('SELECT agent_limit FROM tenants WHERE id = ?').get(req.agent.tenant_id);
    if (tenant?.agent_limit != null) {
      const { count } = await db.prepare('SELECT COUNT(*) AS count FROM agents WHERE tenant_id = ? AND active = 1').get(req.agent.tenant_id);
      if (Number(count) >= tenant.agent_limit) {
        return res.status(403).json({ error: `Has alcanzado el límite de ${tenant.agent_limit} usuarios de tu plan. Contacta con soporte para ampliarlo.` });
      }
    }

    const hash   = bcrypt.hashSync(password, 10);
    const insert = await db.prepare(`
      INSERT INTO agents (tenant_id, name, email, password, role) VALUES (?, ?, ?, ?, ?)
    `).run(req.agent.tenant_id, name, email, hash, role);

    res.status(201).json({
      agent: { id: insert.lastInsertRowid, name, email, role }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// PATCH /api/agents/:id/password
router.patch('/:id/password', auth, async (req, res) => {
  try {
    // El agente solo puede cambiar su propia contraseña; admin puede cambiar cualquiera
    if (req.agent.role !== 'admin' && req.agent.id !== Number(req.params.id)) {
      return res.status(403).json({ error: 'Sin permiso' });
    }
    const { password } = req.body;
    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'Contraseña mínimo 8 caracteres' });
    }
    await db.prepare('UPDATE agents SET password = ? WHERE id = ?')
      .run(bcrypt.hashSync(password, 10), req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// DELETE /api/agents/:id — desactivar agente
router.delete('/:id', auth, async (req, res) => {
  try {
    if (req.agent.role !== 'admin') return res.status(403).json({ error: 'Solo admins' });
    await db.prepare('UPDATE agents SET active = 0 WHERE id = ? AND tenant_id = ?')
      .run(req.params.id, req.agent.tenant_id);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

module.exports = router;
