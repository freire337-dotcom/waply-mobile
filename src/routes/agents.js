const router = require('express').Router();
const bcrypt = require('bcryptjs');
const db     = require('../db');
const auth   = require('../middleware/auth');

// GET /api/agents  — listar agentes (para asignación)
router.get('/', auth, (req, res) => {
  const agents = db.prepare('SELECT id, name, email, role FROM agents ORDER BY name').all();
  res.json({ agents });
});

// POST /api/agents  — crear agente (solo admin)
router.post('/', auth, (req, res) => {
  if (req.agent.role !== 'admin') {
    return res.status(403).json({ error: 'Solo admins pueden crear agentes' });
  }
  const { name, email, password, role = 'agent' } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email y password son requeridos' });
  }

  const existing = db.prepare('SELECT id FROM agents WHERE email = ?').get(email);
  if (existing) return res.status(409).json({ error: 'Email ya registrado' });

  const hash   = bcrypt.hashSync(password, 10);
  const insert = db.prepare(`
    INSERT INTO agents (name, email, password, role) VALUES (?, ?, ?, ?)
  `).run(name, email, hash, role);

  res.status(201).json({
    agent: { id: insert.lastInsertRowid, name, email, role }
  });
});

// PATCH /api/agents/:id/password
router.patch('/:id/password', auth, (req, res) => {
  // El agente solo puede cambiar su propia contraseña; admin puede cambiar cualquiera
  if (req.agent.role !== 'admin' && req.agent.id !== Number(req.params.id)) {
    return res.status(403).json({ error: 'Sin permiso' });
  }
  const { password } = req.body;
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Contraseña mínimo 8 caracteres' });
  }
  db.prepare('UPDATE agents SET password = ? WHERE id = ?')
    .run(bcrypt.hashSync(password, 10), req.params.id);
  res.json({ ok: true });
});

module.exports = router;
