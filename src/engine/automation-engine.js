/**
 * Motor de Automatizaciones
 *
 * Responsabilidades:
 * 1. fire(trigger, tenantId, data) — busca automatizaciones activas y las ejecuta
 * 2. executeRun(runId) — ejecuta los pasos de una automatización
 * 3. resolveTimer(timerId, response) — resuelve un timer cuando llega respuesta
 */

const db       = require('../db');
const HANDLERS = require('./action-handlers');

// ── Evaluar condiciones ───────────────────────────────────────────────────────
function evaluateConditions(conditions, context) {
  if (!conditions || conditions.length === 0) return true;
  return conditions.every(cond => {
    const [obj, key] = cond.field.split('.');
    const actual = context[obj]?.[key] ?? context[cond.field];
    switch (cond.operator) {
      case 'equals':          return String(actual) === String(cond.value);
      case 'not_equals':      return String(actual) !== String(cond.value);
      case 'contains':        return String(actual).toLowerCase().includes(String(cond.value).toLowerCase());
      case 'starts_with':     return String(actual).toLowerCase().startsWith(String(cond.value).toLowerCase());
      case 'exists':          return actual !== undefined && actual !== null && actual !== '';
      case 'not_exists':      return actual === undefined || actual === null || actual === '';
      case 'greater_than':    return Number(actual) > Number(cond.value);
      case 'less_than':       return Number(actual) < Number(cond.value);
      default: return true;
    }
  });
}

// ── Disparar trigger ──────────────────────────────────────────────────────────
async function fire(trigger, tenantId, data) {
  const automations = db.prepare(`
    SELECT * FROM automations
    WHERE tenant_id = ? AND trigger = ? AND active = 1
  `).all(tenantId, trigger);

  for (const auto of automations) {
    const conditions = JSON.parse(auto.conditions || '[]');
    if (!evaluateConditions(conditions, data)) continue;

    // Crear run
    const run = db.prepare(`
      INSERT INTO automation_runs (tenant_id, automation_id, trigger_data, status)
      VALUES (?, ?, ?, 'running')
    `).run(tenantId, auto.id, JSON.stringify(data));

    // Ejecutar en background (no bloquear el request)
    executeRun(run.lastInsertRowid, JSON.parse(auto.actions || '[]'), tenantId, data)
      .catch(err => {
        console.error(`Error en automation_run #${run.lastInsertRowid}:`, err.message);
        db.prepare(`UPDATE automation_runs SET status='failed', error=?, completed_at=datetime('now') WHERE id=?`)
          .run(err.message, run.lastInsertRowid);
      });
  }
}

// ── Ejecutar pasos de una automatización ─────────────────────────────────────
async function executeRun(runId, actions, tenantId, context) {
  let currentContext = { ...context };

  for (let i = 0; i < actions.length; i++) {
    const action  = actions[i];
    const handler = HANDLERS[action.type];

    if (!handler) {
      console.warn(`Handler no encontrado: ${action.type}`);
      continue;
    }

    try {
      const result = await handler({
        tenantId,
        action,
        context: currentContext,
        runId,
        actionIndex: i,
      });

      // Mergeamos outputs al contexto para pasos siguientes
      if (result.output) {
        currentContext = { ...currentContext, ...result.output };
      }

      // Si el paso queda esperando (timer), pausamos la ejecución aquí
      if (result.status === 'waiting') {
        // El timer se encargará de continuar desde action_index + 1
        // Guardamos el contexto y acciones restantes en el timer
        db.prepare(`
          UPDATE automation_timers SET context = ?
          WHERE run_id = ? AND action_index = ? AND status = 'pending'
        `).run(
          JSON.stringify({ ...currentContext, _remaining_actions: actions.slice(i + 1) }),
          runId, i
        );
        return; // pausar ejecución
      }
    } catch (err) {
      console.error(`Error en acción ${action.type} (run #${runId}):`, err.message);
      // Continuar con el siguiente paso aunque uno falle
    }
  }

  db.prepare(`UPDATE automation_runs SET status='completed', completed_at=datetime('now') WHERE id=?`)
    .run(runId);
}

// ── Resolver timer (respuesta del cliente o timeout) ─────────────────────────
async function resolveTimer(timerId, { response = null, timedOut = false } = {}) {
  const timer = db.prepare('SELECT * FROM automation_timers WHERE id = ? AND status = ?')
    .get(timerId, 'pending');
  if (!timer) return;

  const context         = JSON.parse(timer.context || '{}');
  const remainingActions = context._remaining_actions || [];
  const tenantId        = timer.tenant_id;
  const runId           = timer.run_id;

  // Marcar timer como resuelto
  db.prepare(`UPDATE automation_timers SET status = ? WHERE id = ?`)
    .run(timedOut ? 'expired' : 'resolved', timerId);

  if (timedOut || isNegativeResponse(response)) {
    // Ejecutar acción de reconducción
    const rescheduleAction = {
      type: 'notify_agent_reschedule',
      config: { message_template: context.reschedule_message || 'Cliente no confirmó cita' },
    };
    await HANDLERS.notify_agent_reschedule({ tenantId, action: rescheduleAction, context }).catch(console.error);

    // Actualizar estado de la cita
    if (context.appointment?.crm_appointment_id) {
      db.prepare(`UPDATE appointments SET status='rescheduled' WHERE crm_appointment_id=? AND tenant_id=?`)
        .run(context.appointment.crm_appointment_id, tenantId);
    }
  } else if (isPositiveResponse(response)) {
    // Confirmar cita y continuar con acciones restantes
    await HANDLERS.confirm_appointment({ tenantId, action: {}, context }).catch(console.error);
    if (remainingActions.length > 0) {
      await executeRun(runId, remainingActions, tenantId, context).catch(console.error);
    } else {
      db.prepare(`UPDATE automation_runs SET status='completed', completed_at=datetime('now') WHERE id=?`).run(runId);
    }
  }
}

// ── Helpers de respuesta ──────────────────────────────────────────────────────
function isPositiveResponse(text) {
  if (!text) return false;
  const t = text.toLowerCase().trim();
  return ['si', 'sí', 'yes', 'confirmo', '1', 'ok', 'vale', 'perfecto', 'claro'].some(p => t.includes(p));
}

function isNegativeResponse(text) {
  if (!text) return false;
  const t = text.toLowerCase().trim();
  return ['no', 'cancel', 'no puedo', 'imposible', '2', 'cancelar'].some(p => t.includes(p));
}

module.exports = { fire, executeRun, resolveTimer, isPositiveResponse, isNegativeResponse };
