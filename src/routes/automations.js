const router = require('express').Router();
const db     = require('../db');
const auth   = require('../middleware/auth');

// GET /api/automations — listar automatizaciones del tenant
router.get('/', auth, (req, res) => {
  const automations = db.prepare(`
    SELECT a.*, ag.name AS created_by_name
    FROM automations a
    LEFT JOIN agents ag ON ag.id = a.created_by
    WHERE a.tenant_id = ?
    ORDER BY a.created_at DESC
  `).all(req.agent.tenant_id);

  res.json({
    automations: automations.map(a => ({
      ...a,
      conditions: JSON.parse(a.conditions || '[]'),
      actions:    JSON.parse(a.actions    || '[]'),
    }))
  });
});

// GET /api/automations/:id
router.get('/:id', auth, (req, res) => {
  const auto = db.prepare('SELECT * FROM automations WHERE id = ? AND tenant_id = ?')
    .get(req.params.id, req.agent.tenant_id);
  if (!auto) return res.status(404).json({ error: 'No encontrada' });
  res.json({
    automation: {
      ...auto,
      conditions: JSON.parse(auto.conditions || '[]'),
      actions:    JSON.parse(auto.actions    || '[]'),
    }
  });
});

// POST /api/automations — crear nueva automatización
router.post('/', auth, (req, res) => {
  if (req.agent.role !== 'admin') return res.status(403).json({ error: 'Solo admins' });

  const { name, description, trigger, conditions = [], actions = [] } = req.body;
  if (!name || !trigger) return res.status(400).json({ error: 'name y trigger son requeridos' });

  const VALID_TRIGGERS = [
    'lead.created', 'lead.updated',
    'appointment.scheduled', 'appointment.reminder_7d', 'appointment.reminder_1d',
    'message.received',
  ];
  if (!VALID_TRIGGERS.includes(trigger)) {
    return res.status(400).json({ error: `Trigger inválido. Válidos: ${VALID_TRIGGERS.join(', ')}` });
  }

  const insert = db.prepare(`
    INSERT INTO automations (tenant_id, name, description, trigger, conditions, actions, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.agent.tenant_id, name, description || null, trigger,
    JSON.stringify(conditions), JSON.stringify(actions), req.agent.id
  );

  res.status(201).json({ id: insert.lastInsertRowid, name, trigger });
});

// PATCH /api/automations/:id — editar
router.patch('/:id', auth, (req, res) => {
  if (req.agent.role !== 'admin') return res.status(403).json({ error: 'Solo admins' });

  const auto = db.prepare('SELECT id FROM automations WHERE id = ? AND tenant_id = ?')
    .get(req.params.id, req.agent.tenant_id);
  if (!auto) return res.status(404).json({ error: 'No encontrada' });

  const { name, description, conditions, actions, active } = req.body;
  const fields = [], values = [];

  if (name        !== undefined) { fields.push('name = ?');        values.push(name); }
  if (description !== undefined) { fields.push('description = ?'); values.push(description); }
  if (conditions  !== undefined) { fields.push('conditions = ?');  values.push(JSON.stringify(conditions)); }
  if (actions     !== undefined) { fields.push('actions = ?');     values.push(JSON.stringify(actions)); }
  if (active      !== undefined) { fields.push('active = ?');      values.push(active ? 1 : 0); }

  if (fields.length === 0) return res.status(400).json({ error: 'Nada que actualizar' });
  values.push(req.params.id);

  db.prepare(`UPDATE automations SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  res.json({ ok: true });
});

// DELETE /api/automations/:id — desactivar (no borrar, para conservar historial)
router.delete('/:id', auth, (req, res) => {
  if (req.agent.role !== 'admin') return res.status(403).json({ error: 'Solo admins' });
  db.prepare('UPDATE automations SET active = 0 WHERE id = ? AND tenant_id = ?')
    .run(req.params.id, req.agent.tenant_id);
  res.json({ ok: true });
});

// GET /api/automations/:id/runs — historial de ejecuciones
router.get('/:id/runs', auth, (req, res) => {
  const runs = db.prepare(`
    SELECT id, status, error, started_at, completed_at
    FROM automation_runs
    WHERE automation_id = ? AND tenant_id = ?
    ORDER BY started_at DESC
    LIMIT 50
  `).all(req.params.id, req.agent.tenant_id);
  res.json({ runs });
});

module.exports = router;
