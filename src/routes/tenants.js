const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const db      = require('../db');
const auth    = require('../middleware/auth');
const { seedDefaultAutomations } = require('../engine/default-automations');

// Middleware: solo superadmin (sin tenant) puede gestionar tenants
// En producción añadirías un rol superadmin; aquí usamos un token de env
function superAdminOnly(req, res, next) {
  const token = req.headers['x-super-token'];
  if (token !== process.env.SUPER_ADMIN_TOKEN) {
    return res.status(403).json({ error: 'Acceso restringido' });
  }
  next();
}

// POST /api/tenants — crear nuevo cliente/tenant
router.post('/', superAdminOnly, (req, res) => {
  const { name, slug, wa_phone_id, wa_token, wa_verify_token, plan = 'free',
          admin_name, admin_email, admin_password } = req.body;

  if (!name || !slug || !admin_email || !admin_password) {
    return res.status(400).json({ error: 'name, slug, admin_email y admin_password son requeridos' });
  }

  const existing = db.prepare('SELECT id FROM tenants WHERE slug = ?').get(slug);
  if (existing) return res.status(409).json({ error: 'Slug ya existe' });

  // Crear tenant
  const tenant = db.prepare(`
    INSERT INTO tenants (name, slug, wa_phone_id, wa_token, wa_verify_token, plan)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(name, slug, wa_phone_id || null, wa_token || null, wa_verify_token || null, plan);

  const tenantId = tenant.lastInsertRowid;

  // Crear admin del tenant
  const hash = bcrypt.hashSync(admin_password, 10);
  db.prepare(`
    INSERT INTO agents (tenant_id, name, email, password, role)
    VALUES (?, ?, ?, ?, 'admin')
  `).run(tenantId, admin_name || 'Admin', admin_email, hash);

  // Insertar automatizaciones por defecto
  seedDefaultAutomations(tenantId);

  res.status(201).json({
    tenant: { id: tenantId, name, slug, plan },
    message: 'Tenant creado con automatizaciones por defecto',
  });
});

// GET /api/tenants/:id — datos del tenant (solo admin del tenant)
router.get('/:id', auth, (req, res) => {
  if (req.agent.tenant_id !== Number(req.params.id) && req.agent.role !== 'admin') {
    return res.status(403).json({ error: 'Sin permiso' });
  }
  const tenant = db.prepare(
    'SELECT id, name, slug, wa_phone_id, plan, active, created_at FROM tenants WHERE id = ?'
  ).get(req.params.id);
  if (!tenant) return res.status(404).json({ error: 'Tenant no encontrado' });
  res.json({ tenant });
});

// PATCH /api/tenants/:id — actualizar configuración (solo admin)
router.patch('/:id', auth, (req, res) => {
  if (req.agent.role !== 'admin' || req.agent.tenant_id !== Number(req.params.id)) {
    return res.status(403).json({ error: 'Solo el admin puede editar la configuración' });
  }
  const { wa_phone_id, wa_token, wa_verify_token, fcm_server_key } = req.body;

  const fields = [];
  const values = [];
  if (wa_phone_id  !== undefined) { fields.push('wa_phone_id = ?');   values.push(wa_phone_id); }
  if (wa_token     !== undefined) { fields.push('wa_token = ?');      values.push(wa_token); }
  if (wa_verify_token !== undefined) { fields.push('wa_verify_token = ?'); values.push(wa_verify_token); }
  if (fcm_server_key !== undefined) { fields.push('fcm_server_key = ?'); values.push(fcm_server_key); }

  if (fields.length === 0) return res.status(400).json({ error: 'Nada que actualizar' });
  values.push(req.params.id);

  db.prepare(`UPDATE tenants SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  res.json({ ok: true });
});

module.exports = router;
