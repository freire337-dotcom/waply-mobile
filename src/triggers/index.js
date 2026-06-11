/**
 * Triggers externos — endpoints que el CRM del cliente llama
 * para disparar automatizaciones.
 *
 * Autenticados con un tenant_token (slug + secret del tenant).
 */

const router = require('express').Router();
const db     = require('../db');
const engine = require('../engine/automation-engine');

// Middleware de autenticación por tenant
function tenantAuth(req, res, next) {
  const tenantSlug = req.headers['x-tenant-slug'];
  const tenantKey  = req.headers['x-tenant-key'];

  if (!tenantSlug || !tenantKey) {
    return res.status(401).json({ error: 'x-tenant-slug y x-tenant-key requeridos' });
  }

  // El tenant_key es sha256(slug + JWT_SECRET) — simple y sin estado
  const crypto   = require('crypto');
  const expected = crypto.createHmac('sha256', process.env.JWT_SECRET).update(tenantSlug).digest('hex');

  if (tenantKey !== expected) {
    return res.status(401).json({ error: 'Credenciales de tenant inválidas' });
  }

  const tenant = db.prepare('SELECT * FROM tenants WHERE slug = ? AND active = 1').get(tenantSlug);
  if (!tenant) return res.status(404).json({ error: 'Tenant no encontrado o inactivo' });

  req.tenant = tenant;
  next();
}

// ── POST /api/triggers/lead-created ──────────────────────────────────────────
router.post('/lead-created', tenantAuth, async (req, res) => {
  res.sendStatus(200); // responder rápido, procesar en background

  const { lead_id, name, phone, email, source, metadata = {} } = req.body;
  const tenantId = req.tenant.id;

  if (!phone && !lead_id) return;

  // Normalizar teléfono (quitar +, espacios)
  const waId = phone?.replace(/\D/g, '');

  // Upsert contacto
  if (waId) {
    db.prepare(`
      INSERT INTO contacts (tenant_id, wa_id, name, phone, lead_id)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, wa_id) DO UPDATE SET
        name    = excluded.name,
        lead_id = excluded.lead_id
    `).run(tenantId, waId, name || null, phone || null, lead_id || null);
  }

  const contact = waId
    ? db.prepare('SELECT * FROM contacts WHERE tenant_id = ? AND wa_id = ?').get(tenantId, waId)
    : null;

  // Crear o recuperar conversación
  let convId = null;
  if (contact) {
    let conv = db.prepare('SELECT id FROM conversations WHERE tenant_id = ? AND contact_id = ?')
      .get(tenantId, contact.id);
    if (!conv) {
      const ins = db.prepare(`
        INSERT INTO conversations (tenant_id, contact_id, lead_id, status)
        VALUES (?, ?, ?, 'open')
      `).run(tenantId, contact.id, lead_id || null);
      convId = ins.lastInsertRowid;
    } else {
      convId = conv.id;
    }
  }

  // Disparar automatización
  await engine.fire('lead.created', tenantId, {
    lead: { id: lead_id, name, phone, email, source, ...metadata },
    contact: contact ? { id: contact.id, wa_id: contact.wa_id, name: contact.name } : null,
    conversation_id: convId,
    lead_id,
  }).catch(err => console.error('Error en trigger lead.created:', err.message));
});

// ── POST /api/triggers/appointment-scheduled ──────────────────────────────────
router.post('/appointment-scheduled', tenantAuth, async (req, res) => {
  res.sendStatus(200);

  const { crm_appointment_id, lead_id, phone, contact_name, scheduled_at, agent_email } = req.body;
  const tenantId = req.tenant.id;

  if (!scheduled_at || !crm_appointment_id) return;

  const waId   = phone?.replace(/\D/g, '');
  let contact  = waId
    ? db.prepare('SELECT * FROM contacts WHERE tenant_id = ? AND wa_id = ?').get(tenantId, waId)
    : null;

  // Si no existe el contacto, crearlo
  if (!contact && waId) {
    db.prepare(`
      INSERT INTO contacts (tenant_id, wa_id, name, phone, lead_id)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, wa_id) DO UPDATE SET name = excluded.name
    `).run(tenantId, waId, contact_name || null, phone || null, lead_id || null);
    contact = db.prepare('SELECT * FROM contacts WHERE tenant_id = ? AND wa_id = ?').get(tenantId, waId);
  }

  // Buscar agente por email si se pasa
  let agentId = null;
  if (agent_email) {
    const agent = db.prepare('SELECT id FROM agents WHERE tenant_id = ? AND email = ?').get(tenantId, agent_email);
    agentId = agent?.id || null;
  }

  // Upsert cita
  db.prepare(`
    INSERT INTO appointments (tenant_id, crm_appointment_id, lead_id, contact_id, scheduled_at, agent_id)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id, crm_appointment_id) DO UPDATE SET
      scheduled_at = excluded.scheduled_at,
      agent_id     = excluded.agent_id,
      status       = 'scheduled',
      reminder_7d_sent = 0,
      reminder_1d_sent = 0
  `).run(tenantId, crm_appointment_id, lead_id || null, contact?.id || null, scheduled_at, agentId);

  console.log(`📅 Cita registrada: ${crm_appointment_id} para ${contact_name} el ${scheduled_at}`);
});

// ── POST /api/triggers/lead-updated ──────────────────────────────────────────
router.post('/lead-updated', tenantAuth, async (req, res) => {
  res.sendStatus(200);
  const { lead_id, changes = {}, metadata = {} } = req.body;
  await engine.fire('lead.updated', req.tenant.id, { lead: { id: lead_id, ...changes }, metadata, lead_id })
    .catch(console.error);
});

// ── GET /api/triggers/tenant-key ─────────────────────────────────────────────
// Devuelve el key de autenticación del tenant (solo para admins autenticados)
router.get('/tenant-key/:slug', (req, res) => {
  const superToken = req.headers['x-super-token'];
  if (superToken !== process.env.SUPER_ADMIN_TOKEN) {
    return res.status(403).json({ error: 'Acceso restringido' });
  }
  const crypto = require('crypto');
  const key    = crypto.createHmac('sha256', process.env.JWT_SECRET).update(req.params.slug).digest('hex');
  res.json({ slug: req.params.slug, key });
});

module.exports = router;
