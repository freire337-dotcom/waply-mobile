/**
 * Rutas de configuración del Agente IA
 *
 * GET  /api/ai-agent          — obtener config del agente IA del tenant
 * POST /api/ai-agent          — crear agente IA (primera vez)
 * PATCH /api/ai-agent         — actualizar nombre/prompt/modelo/activar/desactivar
 * POST /api/ai-agent/assign/:convId — asignar conversación al agente IA
 */

const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const db      = require('../db');
const auth    = require('../middleware/auth');

// GET /api/ai-agent
router.get('/', auth, async (req, res) => {
  try {
    const tid = req.agent.tenant_id;

    const agent = await db.prepare(`
      SELECT id, name, active, is_ai_agent, ai_system_prompt, ai_model
      FROM agents
      WHERE tenant_id = ? AND is_ai_agent = true
      LIMIT 1
    `).get(tid);

    const config = await db.prepare(
      'SELECT provider, created_at FROM ai_agent_config WHERE tenant_id = ?'
    ).get(tid);

    // Nunca devolvemos la api_key — solo si existe
    res.json({
      agent:      agent || null,
      config:     config || null,
      has_api_key: !!config,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// POST /api/ai-agent — crear o actualizar agente IA
router.post('/', auth, async (req, res) => {
  try {
    if (req.agent.role !== 'admin') return res.status(403).json({ error: 'Solo admin' });
    const tid = req.agent.tenant_id;
    const { name, system_prompt, ai_model, provider, api_key } = req.body;

    if (!api_key) return res.status(400).json({ error: 'api_key requerida' });

    // Upsert api_key en tabla separada (no mezclar con agente)
    await db.prepare(`
      INSERT INTO ai_agent_config (tenant_id, provider, api_key)
      VALUES (?, ?, ?)
      ON CONFLICT(tenant_id) DO UPDATE SET provider = EXCLUDED.provider, api_key = EXCLUDED.api_key
    `).run(tid, provider || 'anthropic', api_key);

    // Verificar si ya existe el agente IA
    let agentRow = await db.prepare(
      'SELECT * FROM agents WHERE tenant_id = ? AND is_ai_agent = true LIMIT 1'
    ).get(tid);

    if (!agentRow) {
      // Crear agente IA (contraseña random — nunca puede iniciar sesión normalmente)
      const hash = bcrypt.hashSync(Math.random().toString(36) + Date.now(), 10);
      const ins  = await db.prepare(`
        INSERT INTO agents (tenant_id, name, email, password, role, is_ai_agent, ai_system_prompt, ai_model)
        VALUES (?, ?, ?, ?, 'agent', true, ?, ?)
      `).run(
        tid,
        name || 'Agente IA',
        `ai-bot-${tid}@waply.internal`,
        hash,
        system_prompt || null,
        ai_model || 'claude-3-5-haiku-20241022',
      );
      agentRow = await db.prepare('SELECT * FROM agents WHERE id = ?').get(ins.lastInsertRowid);
    } else {
      // Actualizar existente
      await db.prepare(`
        UPDATE agents
        SET name = ?, ai_system_prompt = ?, ai_model = ?, active = true
        WHERE id = ?
      `).run(
        name || agentRow.name,
        system_prompt !== undefined ? system_prompt : agentRow.ai_system_prompt,
        ai_model || agentRow.ai_model || 'claude-3-5-haiku-20241022',
        agentRow.id,
      );
      agentRow = await db.prepare('SELECT * FROM agents WHERE id = ?').get(agentRow.id);
    }

    res.json({ ok: true, agent: sanitize(agentRow) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// PATCH /api/ai-agent — editar prompt/nombre/modelo/activar
router.patch('/', auth, async (req, res) => {
  try {
    if (req.agent.role !== 'admin') return res.status(403).json({ error: 'Solo admin' });
    const tid = req.agent.tenant_id;
    const { active, system_prompt, name, ai_model, api_key, provider } = req.body;

    const existing = await db.prepare(
      'SELECT * FROM agents WHERE tenant_id = ? AND is_ai_agent = true LIMIT 1'
    ).get(tid);
    if (!existing) return res.status(404).json({ error: 'Agente IA no configurado' });

    const sets   = [];
    const values = [];
    if (active !== undefined)        { sets.push('active = ?');           values.push(active ? 1 : 0); }
    if (system_prompt !== undefined) { sets.push('ai_system_prompt = ?'); values.push(system_prompt || null); }
    if (name !== undefined)          { sets.push('name = ?');             values.push(name); }
    if (ai_model !== undefined)      { sets.push('ai_model = ?');         values.push(ai_model); }

    if (sets.length) {
      values.push(existing.id);
      await db.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    }

    // Actualizar api_key si se provee
    if (api_key) {
      await db.prepare(`
        INSERT INTO ai_agent_config (tenant_id, provider, api_key)
        VALUES (?, ?, ?)
        ON CONFLICT(tenant_id) DO UPDATE SET provider = EXCLUDED.provider, api_key = EXCLUDED.api_key
      `).run(tid, provider || 'anthropic', api_key);
    }

    const updated = await db.prepare('SELECT * FROM agents WHERE id = ?').get(existing.id);
    res.json({ ok: true, agent: sanitize(updated) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// POST /api/ai-agent/assign/:convId — asignar conversación al agente IA
router.post('/assign/:convId', auth, async (req, res) => {
  try {
    const tid = req.agent.tenant_id;
    const { convId } = req.params;

    const aiAgent = await db.prepare(
      'SELECT id FROM agents WHERE tenant_id = ? AND is_ai_agent = true AND active = true LIMIT 1'
    ).get(tid);
    if (!aiAgent) return res.status(404).json({ error: 'Agente IA no configurado o inactivo' });

    await db.prepare(
      'UPDATE conversations SET assigned_to = ? WHERE id = ? AND tenant_id = ?'
    ).run(aiAgent.id, convId, tid);

    const fullConv = await db.prepare(`
      SELECT c.*, ct.name AS contact_name, ct.wa_id, a.name AS agent_name
      FROM conversations c
      JOIN contacts ct ON ct.id = c.contact_id
      LEFT JOIN agents a ON a.id = c.assigned_to
      WHERE c.id = ?
    `).get(convId);

    // Emitir actualización via socket si hay IO disponible
    const { getIO } = require('../io');
    const io = getIO();
    if (io) io.to(`tenant:${tid}`).emit('conversation:updated', fullConv);

    res.json({ ok: true, conversation: fullConv });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Quita campos sensibles antes de devolver al front
function sanitize(a) {
  if (!a) return null;
  const { password, ...rest } = a;
  return rest;
}

module.exports = router;
