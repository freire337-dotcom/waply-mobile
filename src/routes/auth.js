const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const db     = require('../db');
const auth   = require('../middleware/auth');

// POST /api/auth/login
// El cliente envía su tenant slug + email + password
router.post('/login', (req, res) => {
  const { email, password, tenant_slug } = req.body;
  if (!email || !password || !tenant_slug) {
    return res.status(400).json({ error: 'email, password y tenant_slug son requeridos' });
  }

  const tenant = db.prepare('SELECT id FROM tenants WHERE slug = ? AND active = 1').get(tenant_slug);
  if (!tenant) return res.status(404).json({ error: 'Tenant no encontrado' });

  const agent = db.prepare(
    'SELECT * FROM agents WHERE email = ? AND tenant_id = ? AND active = 1'
  ).get(email, tenant.id);

  if (!agent || !bcrypt.compareSync(password, agent.password)) {
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  }

  const token = jwt.sign({ id: agent.id, tenant_id: tenant.id }, process.env.JWT_SECRET, { expiresIn: '30d' });

  res.json({
    token,
    agent: { id: agent.id, name: agent.name, email: agent.email, role: agent.role, tenant_id: tenant.id },
  });
});

// POST /api/auth/fcm-token
router.post('/fcm-token', auth, (req, res) => {
  const { fcm_token } = req.body;
  if (!fcm_token) return res.status(400).json({ error: 'fcm_token requerido' });
  db.prepare('UPDATE agents SET fcm_token = ? WHERE id = ?').run(fcm_token, req.agent.id);
  res.json({ ok: true });
});

// GET /api/auth/me
router.get('/me', auth, (req, res) => res.json({ agent: req.agent }));

module.exports = router;
