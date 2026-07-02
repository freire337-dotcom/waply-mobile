/**
 * AI Agent Service — responde conversaciones de WhatsApp automáticamente
 *
 * Cuando una conversación está asignada a un agente con is_ai_agent=true,
 * cada mensaje entrante dispara este servicio. Obtiene el historial,
 * llama a Claude (o GPT), y envía la respuesta por WhatsApp.
 *
 * El agente IA aparece como un agente más del equipo — se le pueden asignar
 * conversaciones igual que a cualquier humano.
 */

const db = require('../db');
const wa = require('./whatsapp');
const { getIO } = require('../io');

/**
 * Responde a la conversación si está asignada a un agente IA activo.
 * @param {number} tenantId
 * @param {number} convId
 * @param {string} contactName — nombre del contacto (para personalizar respuesta)
 */
async function respondIfAIAgent(tenantId, convId, contactName) {
  try {
    console.log(`[AI Agent] ▶ respondIfAIAgent convId=${convId} tenantId=${tenantId}`);

    // 1. Verificar que la conv está asignada a un agente IA
    const conv = await db.prepare(`
      SELECT c.*, ct.wa_id, a.is_ai_agent, a.ai_system_prompt, a.ai_model, a.id AS ai_agent_id, a.name AS ai_agent_name
      FROM conversations c
      JOIN contacts ct ON ct.id = c.contact_id
      LEFT JOIN agents a ON a.id = c.assigned_to
      WHERE c.id = ? AND c.tenant_id = ?
    `).get(convId, tenantId);

    console.log(`[AI Agent] conv encontrada: assigned_to=${conv?.assigned_to}, is_ai_agent=${conv?.is_ai_agent}`);

    if (!conv || !conv.is_ai_agent || !conv.assigned_to) {
      console.log(`[AI Agent] ⏭ Saltando: conv=${!!conv} is_ai_agent=${conv?.is_ai_agent} assigned_to=${conv?.assigned_to}`);
      return;
    }

    // 2. Obtener API key del tenant
    const config = await db.prepare(
      'SELECT * FROM ai_agent_config WHERE tenant_id = ?'
    ).get(tenantId);

    if (!config?.api_key) {
      console.warn(`[AI Agent] ⚠ tenant ${tenantId} no tiene api_key configurada`);
      return;
    }
    console.log(`[AI Agent] config OK — provider=${config.provider}`);

    // 3. Obtener historial de mensajes (últimos 30 para contexto)
    // IMPORTANTE: ORDER BY DESC + LIMIT para coger los más recientes,
    // luego invertimos para mantener el orden cronológico para la IA.
    const rowsDesc = await db.prepare(`
      SELECT direction, type, body FROM messages
      WHERE conversation_id = ? AND type IN ('text', 'template')
      ORDER BY created_at DESC
      LIMIT 30
    `).all(convId);
    const rows = rowsDesc.reverse();

    console.log(`[AI Agent] ${rows.length} mensajes de historial`);

    // 4. Construir lista de mensajes para la API
    //    inbound = user, outbound = assistant
    //    Claude exige roles alternados — fusionamos consecutivos del mismo rol
    const apiMessages = [];
    for (const m of rows) {
      if (!m.body) continue;
      const role = m.direction === 'inbound' ? 'user' : 'assistant';
      const last = apiMessages[apiMessages.length - 1];
      if (last && last.role === role) {
        last.content += '\n' + m.body;
      } else {
        apiMessages.push({ role, content: m.body });
      }
    }

    console.log(`[AI Agent] apiMessages: ${apiMessages.length} — último rol: ${apiMessages.at(-1)?.role}`);

    // Solo respondemos si el último mensaje es del usuario
    if (!apiMessages.length || apiMessages[apiMessages.length - 1].role !== 'user') {
      console.log(`[AI Agent] ⏭ Último mensaje no es del usuario — abortando`);
      return;
    }

    const systemPrompt = conv.ai_system_prompt ||
      `Eres un asistente de atención al cliente. El cliente se llama ${contactName || 'Cliente'}. Responde de forma amable, concisa y útil en el mismo idioma que use el cliente. Si no sabes algo, dilo honestamente y ofrece derivar con un agente humano.`;

    // 5. Llamar a la IA
    // Mapa de modelos deprecados → actuales (Anthropic renombra modelos periódicamente)
    const MODEL_ALIASES = {
      'claude-3-5-haiku-20241022':  'claude-haiku-4-5-20251001',
      'claude-3-5-sonnet-20241022': 'claude-sonnet-4-6',
      'claude-3-opus-20240229':     'claude-opus-4-8',
      'claude-opus-4-5':            'claude-opus-4-8',
    };
    const rawModel = conv.ai_model || 'claude-haiku-4-5-20251001';
    const model    = MODEL_ALIASES[rawModel] || rawModel;
    if (model !== rawModel) console.log(`[AI Agent] Modelo migrado: ${rawModel} → ${model}`);
    console.log(`[AI Agent] Llamando a IA... provider=${config.provider} model=${model}`);
    const axios = require('axios');
    let responseText;

    if (config.provider === 'openai') {
      const resp = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: model || 'gpt-4o-mini',
          messages: [{ role: 'system', content: systemPrompt }, ...apiMessages],
          max_tokens: 500,
        },
        { headers: { Authorization: `Bearer ${config.api_key.trim()}`, 'Content-Type': 'application/json' } }
      );
      responseText = resp.data.choices?.[0]?.message?.content;
    } else {
      // Anthropic — llamada directa con axios para evitar problemas del SDK
      const resp = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model,
          max_tokens: 500,
          system: systemPrompt,
          messages: apiMessages,
        },
        {
          headers: {
            'x-api-key':         config.api_key.trim(),
            'anthropic-version': '2023-06-01',
            'Content-Type':      'application/json',
          },
        }
      );
      responseText = resp.data.content?.[0]?.text;
    }

    if (!responseText?.trim()) {
      console.warn('[AI Agent] respuesta vacía de la IA');
      return;
    }

    // 6. Enviar por WhatsApp
    const waMessageId = await wa.sendText(tenantId, conv.wa_id, responseText.trim());

    // 7. Guardar en BD
    const insert = await db.prepare(`
      INSERT INTO messages (tenant_id, conversation_id, wa_message_id, direction, type, body, status, sender_id)
      VALUES (?, ?, ?, 'outbound', 'text', ?, 'sent', ?)
    `).run(tenantId, convId, waMessageId || null, responseText.trim(), conv.ai_agent_id);

    // 8. Actualizar conversación
    await db.prepare(`
      UPDATE conversations SET last_message = ?, last_msg_at = NOW(), followup_24h_sent = false WHERE id = ?
    `).run(responseText.trim(), convId);

    // 9. Emitir via Socket.IO para que WaplyAdmin/móvil lo vean en tiempo real
    const newMsg = await db.prepare(`
      SELECT m.*, a.name AS sender_name FROM messages m
      LEFT JOIN agents a ON a.id = m.sender_id
      WHERE m.id = ?
    `).get(insert.lastInsertRowid);

    const io = getIO();
    if (io && newMsg) {
      io.to(`conv:${convId}`).emit('message:new', newMsg);
      // Actualizar lista de conversaciones del tenant
      const fullConv = await db.prepare(`
        SELECT c.*, ct.name AS contact_name, ct.wa_id, a.name AS agent_name
        FROM conversations c
        JOIN contacts ct ON ct.id = c.contact_id
        LEFT JOIN agents a ON a.id = c.assigned_to
        WHERE c.id = ?
      `).get(convId);
      io.to(`tenant:${tenantId}`).emit('conversation:updated', fullConv);
    }

    console.log(`[AI Agent] 🤖 Respondió a conv ${convId} del tenant ${tenantId}`);
  } catch (err) {
    // Si es error de axios, muestra la respuesta exacta de la API (Anthropic/OpenAI)
    const apiErr = err.response?.data;
    console.error(`[AI Agent] ❌ Error al responder: ${err.message}`, apiErr ? JSON.stringify(apiErr) : '');
  }
}

module.exports = { respondIfAIAgent };
