/**
 * Envía la plantilla a las conversaciones importadas que no recibieron mensaje.
 * Uso: node scripts/send-template-pending.js
 */

require('dotenv').config();
const db = require('../src/db');
const wa = require('../src/services/whatsapp');

const TEMPLATE = 'info_humo_aereo';
const LANGUAGE = 'es';

async function main() {
  // Conversaciones importadas sin ningún mensaje
  const convs = await db.prepare(`
    SELECT c.id, c.tenant_id, ct.name, ct.wa_id
    FROM conversations c
    JOIN contacts ct ON ct.id = c.contact_id
    WHERE c.last_message = '[Lead importado — pendiente de contactar]'
    AND (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) = 0
    ORDER BY c.id
  `).all();

  if (convs.length === 0) {
    console.log('✅ No hay conversaciones pendientes de plantilla.');
    process.exit(0);
  }

  console.log(`📤 Enviando plantilla "${TEMPLATE}" a ${convs.length} contactos...\n`);

  for (const conv of convs) {
    const name = conv.name || 'cliente';
    try {
      const waMessageId = await wa.sendTemplate(
        conv.tenant_id,
        conv.wa_id,
        TEMPLATE,
        LANGUAGE,
        [{ type: 'body', parameters: [{ type: 'text', text: name }] }]
      );

      await db.prepare(`
        INSERT INTO messages (tenant_id, conversation_id, wa_message_id, direction, type, body, status)
        VALUES (?, ?, ?, 'outbound', 'template', ?, 'sent')
      `).run(conv.tenant_id, conv.id, waMessageId, `[Plantilla: ${TEMPLATE}] ${name}`);

      await db.prepare(`
        UPDATE conversations SET last_message = ?, last_msg_at = NOW() WHERE id = ?
      `).run(`[Plantilla: ${TEMPLATE}] ${name}`, conv.id);

      console.log(`  ✅ ${name} (${conv.wa_id})`);
    } catch (err) {
      console.log(`  ❌ ${name} (${conv.wa_id}) → ${err.response?.data?.error?.message || err.message}`);
    }
  }

  console.log('\nListo. Recarga WaplyAdmin.');
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
