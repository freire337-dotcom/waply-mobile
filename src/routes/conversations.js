const router = require('express').Router();
const db     = require('../db');
const auth   = require('../middleware/auth');
const wa     = require('../services/whatsapp');
const { pushStatusToCRM, pushToCRM } = require('../services/crm-sync');
const { normalizePhone } = require('../utils/phone');

// Etapas válidas del pipeline de ventas (campo independiente de c.status)
const PIPELINE_STAGES = ['abierto', 'contactado', 'negociacion', 'pendiente', 'venta_cerrada', 'venta_perdida'];

// POST /api/conversations — alta manual de contacto/conversación.
// Para leads que nunca llegaron solos (p.ej. rellenaron el formulario del anuncio
// pero no llegaron a escribir por WhatsApp, o el webhook que los traía falló) y
// el agente quiere darlos de alta a mano con el teléfono que sí tiene del CRM/anuncio.
router.post('/', auth, async (req, res) => {
  try {
    const { name, phone } = req.body;
    if (!phone || !String(phone).trim()) return res.status(400).json({ error: 'Teléfono requerido' });
    const tid  = req.agent.tenant_id;
    const waId = normalizePhone(phone);
    if (!waId) return res.status(400).json({ error: 'Teléfono no válido' });

    await db.prepare(`
      INSERT INTO contacts (tenant_id, wa_id, name, phone)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(tenant_id, wa_id) DO UPDATE SET name = COALESCE(excluded.name, contacts.name)
    `).run(tid, waId, name || null, phone);

    const contact = await db.prepare('SELECT * FROM contacts WHERE tenant_id = ? AND wa_id = ?').get(tid, waId);

    let conv = await db.prepare('SELECT * FROM conversations WHERE tenant_id = ? AND contact_id = ?').get(tid, contact.id);
    if (!conv) {
      const ins = await db.prepare(`
        INSERT INTO conversations (tenant_id, contact_id, status)
        VALUES (?, ?, 'open')
      `).run(tid, contact.id);
      conv = await db.prepare('SELECT * FROM conversations WHERE id = ?').get(ins.lastInsertRowid);
    }

    const full = await db.prepare(`
      SELECT c.id, c.status, c.pipeline_stage, c.unread_count, c.last_message, c.last_msg_at, c.lead_id,
             ct.id AS contact_id, ct.name AS contact_name, ct.wa_id, ct.phone,
             a.id  AS agent_id,   a.name  AS agent_name
      FROM conversations c
      JOIN contacts ct ON ct.id = c.contact_id
      LEFT JOIN agents a ON a.id = c.assigned_to
      WHERE c.id = ?
    `).get(conv.id);

    req.app.get('io').to(`tenant:${tid}`).emit('conversation:updated', full);
    res.status(201).json({ conversation: full });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// POST /api/conversations/bulk-import — alta masiva de leads que no llegaron solos
// (p.ej. exportados de Meta Ads Manager: rellenaron el formulario del anuncio pero
// nunca pulsaron "Enviar" en WhatsApp, así que no hay mensaje ni webhook). Para cada
// contacto que NO exista ya en Waply: crea contacto+conversación y le envía una
// plantilla genérica de bienvenida (obligatorio usar plantilla — el lead nunca nos
// escribió, así que no hay ventana de 24h abierta para mensaje de texto libre).
// Si el contacto ya existe, se omite (no se le re-envía nada).
router.post('/bulk-import', auth, async (req, res) => {
  const { contacts, template = 'bienvenida_gestorfer_v2_', language = 'es' } = req.body;
  if (!Array.isArray(contacts) || contacts.length === 0) {
    return res.status(400).json({ error: 'contacts (array) requerido' });
  }

  const tid = req.agent.tenant_id;
  const io  = req.app.get('io');
  const created = [];
  const skipped = [];
  const failed  = [];

  for (const raw of contacts) {
    const name  = (raw?.name || '').trim();
    const phone = (raw?.phone || '').trim();

    if (!phone) { failed.push({ name, phone, error: 'Sin teléfono' }); continue; }
    const waId = normalizePhone(phone);
    if (!waId) { failed.push({ name, phone, error: 'Teléfono no válido' }); continue; }

    try {
      const existing = await db.prepare('SELECT id FROM contacts WHERE tenant_id = ? AND wa_id = ?').get(tid, waId);
      if (existing) { skipped.push({ name, phone, reason: 'Ya existe en Waply' }); continue; }

      await db.prepare(`
        INSERT INTO contacts (tenant_id, wa_id, name, phone)
        VALUES (?, ?, ?, ?)
      `).run(tid, waId, name || null, phone);

      const contact = await db.prepare('SELECT * FROM contacts WHERE tenant_id = ? AND wa_id = ?').get(tid, waId);

      const ins = await db.prepare(`
        INSERT INTO conversations (tenant_id, contact_id, status)
        VALUES (?, ?, 'open')
      `).run(tid, contact.id);
      const convId = ins.lastInsertRowid;

      const paramName = name || 'cliente';
      const components = [
        { type: 'body', parameters: [{ type: 'text', text: paramName }] },
      ];

      let waMessageId;
      try {
        waMessageId = await wa.sendTemplate(tid, waId, template, language, components);
      } catch (sendErr) {
        // El contacto/conversación ya quedaron creados aunque falle el envío —
        // se queda "en Waply" pero sin mensaje de bienvenida, visible para el agente.
        failed.push({ name, phone, error: `Creado pero falló el envío: ${sendErr.message}` });
        continue;
      }

      const displayBody = `[Plantilla: ${template}] ${paramName}`;
      const msgIns = await db.prepare(`
        INSERT INTO messages (tenant_id, conversation_id, wa_message_id, direction, type, body, status)
        VALUES (?, ?, ?, 'outbound', 'template', ?, 'sent')
        ON CONFLICT(wa_message_id) DO NOTHING
      `).run(tid, convId, waMessageId, displayBody);

      await db.prepare(`
        UPDATE conversations SET last_message = ?, last_msg_at = NOW(), status = 'open' WHERE id = ?
      `).run(displayBody, convId);

      const fullConv = await db.prepare(`
        SELECT c.*, ct.name AS contact_name, ct.wa_id, a.name AS agent_name
        FROM conversations c
        JOIN contacts ct ON ct.id = c.contact_id
        LEFT JOIN agents a ON a.id = c.assigned_to
        WHERE c.id = ?
      `).get(convId);

      if (io) io.to(`tenant:${tid}`).emit('conversation:updated', fullConv);

      // Sincronizar con CRM — sin esto, los leads importados aquí nunca aparecen
      // en el chat de WhatsApp del CRM (el resto de flujos sí lo hacen: webhook
      // inbound, envío manual, motor de automatizaciones).
      pushToCRM({
        tenantId:    tid,
        convId,
        direction:   'outbound',
        phone:       waId,
        contactName: paramName,
        leadId:      null,
        message: {
          id:            msgIns.lastInsertRowid,
          wa_message_id: waMessageId,
          type:          'template',
          body:          displayBody,
          created_at:    new Date().toISOString(),
        },
      });

      created.push({ name, phone, conversation_id: convId });
    } catch (err) {
      console.error('bulk-import error:', err.message);
      failed.push({ name, phone, error: err.message });
    }
  }

  res.json({ created, skipped, failed });
});

// GET /api/conversations/pipeline — vista Kanban: todas las conversaciones del tenant agrupables por etapa
// (debe ir ANTES de GET /:id para que Express no confunda "pipeline" con un :id)
router.get('/pipeline', auth, async (req, res) => {
  try {
    const tid = req.agent.tenant_id;
    const rows = await db.prepare(`
      SELECT c.id, c.pipeline_stage, c.status, c.last_message, c.last_msg_at, c.lead_id,
             ct.id AS contact_id, ct.name AS contact_name, ct.wa_id, ct.phone,
             a.id  AS agent_id,   a.name  AS agent_name
      FROM conversations c
      JOIN contacts ct ON ct.id = c.contact_id
      LEFT JOIN agents a ON a.id = c.assigned_to
      WHERE c.tenant_id = ?
      ORDER BY c.last_msg_at DESC NULLS LAST
      LIMIT 300
    `).all(tid);
    res.json({ conversations: rows, stages: PIPELINE_STAGES });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// GET /api/conversations
router.get('/', auth, async (req, res) => {
  try {
    const { status = 'open', assigned_to, page = 1 } = req.query;
    const limit  = 30;
    const offset = (page - 1) * limit;
    const tid    = req.agent.tenant_id;

    let where  = 'WHERE c.tenant_id = ?';
    const params = [tid];

    if (status !== 'all') { where += ' AND c.status = ?'; params.push(status); }

    if (assigned_to === 'me') {
      where += ' AND c.assigned_to = ?';
      params.push(req.agent.id);
    } else if (assigned_to === 'unassigned') {
      where += ' AND c.assigned_to IS NULL';
    }

    params.push(limit, offset);

    const rows = await db.prepare(`
      SELECT c.id, c.status, c.pipeline_stage, c.unread_count, c.last_message, c.last_msg_at, c.lead_id,
             ct.id AS contact_id, ct.name AS contact_name, ct.wa_id, ct.phone,
             a.id  AS agent_id,   a.name  AS agent_name
      FROM conversations c
      JOIN contacts ct ON ct.id = c.contact_id
      LEFT JOIN agents a ON a.id = c.assigned_to
      ${where}
      ORDER BY c.last_msg_at DESC NULLS LAST
      LIMIT ? OFFSET ?
    `).all(...params);

    res.json({ conversations: rows, page: Number(page) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// GET /api/conversations/:id
router.get('/:id', auth, async (req, res) => {
  try {
    const conv = await db.prepare(`
      SELECT c.id, c.status, c.pipeline_stage, c.unread_count, c.last_message, c.last_msg_at, c.lead_id,
             ct.id AS contact_id, ct.name AS contact_name, ct.wa_id, ct.phone,
             a.id  AS agent_id,   a.name  AS agent_name
      FROM conversations c
      JOIN contacts ct ON ct.id = c.contact_id
      LEFT JOIN agents a ON a.id = c.assigned_to
      WHERE c.id = ? AND c.tenant_id = ?
    `).get(req.params.id, req.agent.tenant_id);

    if (!conv) return res.status(404).json({ error: 'No encontrada' });

    await db.prepare('UPDATE conversations SET unread_count = 0 WHERE id = ?').run(conv.id);
    res.json({ conversation: conv });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// PATCH /api/conversations/:id
router.patch('/:id', auth, async (req, res) => {
  try {
    let { assigned_to, status, unread_count, pipeline_stage } = req.body;
    const tid = req.agent.tenant_id;

    const conv = await db.prepare('SELECT id, status, pipeline_stage FROM conversations WHERE id = ? AND tenant_id = ?').get(req.params.id, tid);
    if (!conv) return res.status(404).json({ error: 'No encontrada' });

    if (pipeline_stage !== undefined && !PIPELINE_STAGES.includes(pipeline_stage))
      return res.status(400).json({ error: `Etapa inválida. Usa una de: ${PIPELINE_STAGES.join(', ')}` });

    // Sincronía automática entre el status de la conversación (pestañas Abiertas/
    // Pendientes/Cerradas) y la etapa del Pipeline — son dos vistas del mismo avance,
    // así que mover una mueve la otra. Solo se deriva cuando el cliente manda un
    // campo sin el otro; si manda los dos explícitamente, se respetan tal cual.
    if (status && pipeline_stage === undefined) {
      if (status === 'pending') {
        pipeline_stage = 'pendiente';
      } else if (status === 'closed' && !['venta_cerrada', 'venta_perdida'].includes(conv.pipeline_stage)) {
        // Cerrar un chat normalmente significa que no se concretó la venta — si fue
        // una venta ganada, el agente lo mueve a mano a "venta_cerrada" en el Pipeline.
        pipeline_stage = 'venta_perdida';
      } else if (status === 'open' && ['pendiente', 'venta_cerrada', 'venta_perdida'].includes(conv.pipeline_stage)) {
        pipeline_stage = conv.pipeline_stage === 'pendiente' ? 'contactado' : 'negociacion';
      }
    } else if (pipeline_stage !== undefined && status === undefined) {
      if (pipeline_stage === 'pendiente') {
        status = 'pending';
      } else if (['venta_cerrada', 'venta_perdida'].includes(pipeline_stage)) {
        status = 'closed';
      } else if (['abierto', 'contactado', 'negociacion'].includes(pipeline_stage) && conv.status !== 'open') {
        status = 'open';
      }
    }

    if (assigned_to !== undefined)
      await db.prepare('UPDATE conversations SET assigned_to = ? WHERE id = ?').run(assigned_to || null, req.params.id);
    if (status)
      await db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run(status, req.params.id);
    if (unread_count !== undefined)
      await db.prepare('UPDATE conversations SET unread_count = ? WHERE id = ?').run(unread_count, req.params.id);
    if (pipeline_stage !== undefined)
      await db.prepare('UPDATE conversations SET pipeline_stage = ? WHERE id = ?').run(pipeline_stage, req.params.id);

    const updated = await db.prepare(`
      SELECT c.*, ct.name AS contact_name, ct.wa_id, a.id AS agent_id, a.name AS agent_name
      FROM conversations c
      JOIN contacts ct ON ct.id = c.contact_id
      LEFT JOIN agents a ON a.id = c.assigned_to
      WHERE c.id = ?
    `).get(req.params.id);

    req.app.get('io').to(`tenant:${tid}`).emit('conversation:updated', updated);
    res.json({ conversation: updated });

    // Sincronizar el nuevo estado con el CRM (Supabase) — si no se hace, cerrar/
    // marcar pendiente un chat en Waply no se refleja allí (queda desincronizado).
    if (status) {
      pushStatusToCRM({
        tenantId: tid,
        convId:   updated.id,
        phone:    updated.wa_id,
        leadId:   updated.lead_id || null,
        status,
      });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// DELETE /api/conversations/:id
// Solo admin puede borrar un chat completo — ocultar el botón en la UI no basta,
// cualquiera con el token podría llamar a este endpoint directamente.
router.delete('/:id', auth, async (req, res) => {
  try {
    if (req.agent.role !== 'admin') return res.status(403).json({ error: 'Solo un administrador puede eliminar conversaciones' });
    const tid  = req.agent.tenant_id;
    const conv = await db.prepare('SELECT id FROM conversations WHERE id = ? AND tenant_id = ?').get(req.params.id, tid);
    if (!conv) return res.status(404).json({ error: 'No encontrada' });

    await db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conv.id);
    await db.prepare('DELETE FROM automation_timers WHERE tenant_id = ? AND run_id IN (SELECT id FROM automation_runs WHERE tenant_id = ? AND context LIKE ?)').run(tid, tid, `%"conversation_id":${conv.id}%`);
    await db.prepare('DELETE FROM conversations WHERE id = ?').run(conv.id);

    req.app.get('io').to(`tenant:${tid}`).emit('conversation:deleted', { id: conv.id });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// GET /api/leads/:leadId/conversation — historial del lead para el CRM
router.get('/lead/:leadId', auth, async (req, res) => {
  try {
    const messages = await db.prepare(`
      SELECT m.id, m.direction, m.type, m.body, m.status, m.created_at,
             a.name AS sender_name
      FROM conversations c
      JOIN messages m ON m.conversation_id = c.id
      LEFT JOIN agents a ON a.id = m.sender_id
      WHERE c.lead_id = ? AND c.tenant_id = ?
      ORDER BY m.created_at ASC
    `).all(req.params.leadId, req.agent.tenant_id);

    res.json({ messages });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

module.exports = router;
