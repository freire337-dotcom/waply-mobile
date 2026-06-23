const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const db      = require('../db');
const auth    = require('../middleware/auth');
const { seedDefaultAutomations } = require('../engine/default-automations');

// Middleware: solo superadmin (sin tenant) puede gestionar tenants
function superAdminOnly(req, res, next) {
  const token = req.headers['x-super-token'];
  if (token !== process.env.SUPER_ADMIN_TOKEN) {
    return res.status(403).json({ error: 'Acceso restringido' });
  }
  next();
}

// POST /api/tenants — crear nuevo cliente/tenant
router.post('/', superAdminOnly, async (req, res) => {
  try {
    const { name, slug, wa_phone_id, wa_token, wa_verify_token, plan = 'free',
            admin_name, admin_email, admin_password } = req.body;

    if (!name || !slug || !admin_email || !admin_password) {
      return res.status(400).json({ error: 'name, slug, admin_email y admin_password son requeridos' });
    }

    const existing = await db.prepare('SELECT id FROM tenants WHERE slug = ?').get(slug);
    if (existing) return res.status(409).json({ error: 'Slug ya existe' });

    // Crear tenant
    const tenant = await db.prepare(`
      INSERT INTO tenants (name, slug, wa_phone_id, wa_token, wa_verify_token, plan)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(name, slug, wa_phone_id || null, wa_token || null, wa_verify_token || null, plan);

    const tenantId = tenant.lastInsertRowid;

    // Crear admin del tenant
    const hash = bcrypt.hashSync(admin_password, 10);
    await db.prepare(`
      INSERT INTO agents (tenant_id, name, email, password, role)
      VALUES (?, ?, ?, ?, 'admin')
    `).run(tenantId, admin_name || 'Admin', admin_email, hash);

    // Insertar automatizaciones por defecto
    await seedDefaultAutomations(tenantId);

    res.status(201).json({
      tenant: { id: tenantId, name, slug, plan },
      message: 'Tenant creado con automatizaciones por defecto',
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// GET /api/tenants — listar todos los clientes (solo superadmin)
router.get('/', superAdminOnly, async (req, res) => {
  try {
    const tenants = await db.prepare(`
      SELECT t.id, t.name, t.slug, t.plan, t.active, t.agent_limit, t.created_at,
             (SELECT COUNT(*) FROM agents a WHERE a.tenant_id = t.id) AS agent_count,
             (SELECT COUNT(*) FROM agents a WHERE a.tenant_id = t.id AND a.active = 1) AS active_agent_count,
             (SELECT COUNT(*) FROM conversations c WHERE c.tenant_id = t.id) AS conversation_count
      FROM tenants t
      ORDER BY t.created_at DESC
    `).all();
    res.json({ tenants });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// GET /api/tenants/:id/agents — listar agentes de un cliente (solo superadmin)
router.get('/:id/agents', superAdminOnly, async (req, res) => {
  try {
    const agents = await db.prepare(
      'SELECT id, name, email, role, active, created_at FROM agents WHERE tenant_id = ? ORDER BY created_at'
    ).all(req.params.id);
    res.json({ agents });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// POST /api/tenants/:id/agents — añadir un usuario/agente a un cliente (solo superadmin)
router.post('/:id/agents', superAdminOnly, async (req, res) => {
  try {
    const { name, email, password, role = 'agent' } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'name, email y password son requeridos' });
    }
    const existing = await db.prepare('SELECT id FROM agents WHERE email = ? AND tenant_id = ?').get(email, req.params.id);
    if (existing) return res.status(409).json({ error: 'Email ya registrado en ese cliente' });

    const tenant = await db.prepare('SELECT agent_limit FROM tenants WHERE id = ?').get(req.params.id);
    if (tenant?.agent_limit != null) {
      const { count } = await db.prepare('SELECT COUNT(*) AS count FROM agents WHERE tenant_id = ? AND active = 1').get(req.params.id);
      if (Number(count) >= tenant.agent_limit) {
        return res.status(403).json({ error: `Límite de usuarios alcanzado (${tenant.agent_limit}). Aumenta el límite del cliente para añadir más.` });
      }
    }

    const hash   = bcrypt.hashSync(password, 10);
    const insert = await db.prepare(
      'INSERT INTO agents (tenant_id, name, email, password, role) VALUES (?, ?, ?, ?, ?)'
    ).run(req.params.id, name, email, hash, role);

    res.status(201).json({ agent: { id: insert.lastInsertRowid, name, email, role } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// PATCH /api/tenants/:id/agents/:agentId — activar/desactivar o cambiar rol (solo superadmin)
router.patch('/:id/agents/:agentId', superAdminOnly, async (req, res) => {
  try {
    const { active, role } = req.body;
    const fields = [];
    const values = [];
    if (active !== undefined) { fields.push('active = ?'); values.push(active ? 1 : 0); }
    if (role   !== undefined) { fields.push('role = ?');   values.push(role); }
    if (fields.length === 0) return res.status(400).json({ error: 'Nada que actualizar' });
    values.push(req.params.agentId, req.params.id);

    await db.prepare(`UPDATE agents SET ${fields.join(', ')} WHERE id = ? AND tenant_id = ?`).run(...values);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// PATCH /api/tenants/:id/agents/:agentId/password — resetear contraseña (solo superadmin)
router.patch('/:id/agents/:agentId/password', superAdminOnly, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Contraseña mínimo 6 caracteres' });
    }
    await db.prepare('UPDATE agents SET password = ? WHERE id = ? AND tenant_id = ?')
      .run(bcrypt.hashSync(password, 10), req.params.agentId, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// PATCH /api/tenants/:id/admin — suspender/activar cliente o cambiar plan (solo superadmin)
router.patch('/:id/admin', superAdminOnly, async (req, res) => {
  try {
    const { active, plan, name, agent_limit } = req.body;
    const fields = [];
    const values = [];
    if (active      !== undefined) { fields.push('active = ?');      values.push(active ? 1 : 0); }
    if (plan        !== undefined) { fields.push('plan = ?');        values.push(plan); }
    if (name        !== undefined) { fields.push('name = ?');        values.push(name); }
    if (agent_limit !== undefined) { fields.push('agent_limit = ?'); values.push(agent_limit === null || agent_limit === "" ? null : Number(agent_limit)); }
    if (fields.length === 0) return res.status(400).json({ error: 'Nada que actualizar' });
    values.push(req.params.id);

    await db.prepare(`UPDATE tenants SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// GET /api/tenants/:id — datos del tenant (solo admin del tenant)
router.get('/:id', auth, async (req, res) => {
  try {
    if (req.agent.tenant_id !== Number(req.params.id) && req.agent.role !== 'admin') {
      return res.status(403).json({ error: 'Sin permiso' });
    }
    const tenant = await db.prepare(
      'SELECT id, name, slug, wa_phone_id, plan, active, created_at FROM tenants WHERE id = ?'
    ).get(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'Tenant no encontrado' });
    res.json({ tenant });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// PATCH /api/tenants/:id — actualizar configuración (solo admin)
router.patch('/:id', auth, async (req, res) => {
  try {
    if (req.agent.role !== 'admin' || req.agent.tenant_id !== Number(req.params.id)) {
      return res.status(403).json({ error: 'Solo el admin puede editar la configuración' });
    }
    const { wa_phone_id, wa_token, wa_verify_token, fcm_server_key } = req.body;

    const fields = [];
    const values = [];
    if (wa_phone_id     !== undefined) { fields.push('wa_phone_id = ?');     values.push(wa_phone_id); }
    if (wa_token        !== undefined) { fields.push('wa_token = ?');         values.push(wa_token); }
    if (wa_verify_token !== undefined) { fields.push('wa_verify_token = ?');  values.push(wa_verify_token); }
    if (fcm_server_key  !== undefined) { fields.push('fcm_server_key = ?');   values.push(fcm_server_key); }

    if (fields.length === 0) return res.status(400).json({ error: 'Nada que actualizar' });
    values.push(req.params.id);

    await db.prepare(`UPDATE tenants SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

module.exports = router;
