/**
 * Helper para guardar notificaciones en la tabla `notifications`.
 * Lo usan: webhook/meta.js (nuevo lead), engine/cron.js (tareas, sin-respuesta).
 *
 * saveNotification({ tenantId, agentId?, type, title, body?, conversationId? })
 *   agentId  null  → visible para todos los agentes del tenant
 *   agentId  X     → solo para ese agente
 */

const db = require('../db');

async function saveNotification({ tenantId, agentId = null, type, title, body = null, conversationId = null }) {
  try {
    await db.prepare(`
      INSERT INTO notifications (tenant_id, agent_id, type, title, body, conversation_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(tenantId, agentId, type, title, body, conversationId);
  } catch (err) {
    // No relanzamos — una notificación que no se guarda no debe romper el flujo principal
    console.error('[notifications] Error guardando notificación:', err.message);
  }
}

module.exports = { saveNotification };
