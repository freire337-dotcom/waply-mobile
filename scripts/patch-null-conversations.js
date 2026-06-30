/**
 * Parchea conversaciones que quedaron con last_msg_at = NULL tras una importación
 * fallida de plantilla. Sin este timestamp aparecen al fondo de la lista y el
 * agente no las ve.
 *
 * Uso:
 *   node scripts/patch-null-conversations.js
 */

require('dotenv').config();
const db = require('../src/db');

async function main() {
  const rows = await db.prepare(`
    SELECT id, (SELECT name FROM contacts WHERE id = c.contact_id) AS contact_name
    FROM conversations c
    WHERE last_msg_at IS NULL
  `).all();

  if (rows.length === 0) {
    console.log('✅ No hay conversaciones sin last_msg_at.');
    return;
  }

  console.log(`🔧 Parcheando ${rows.length} conversaciones sin timestamp...`);

  for (const row of rows) {
    await db.prepare(`
      UPDATE conversations
      SET last_message = '[Lead importado — pendiente de contactar]', last_msg_at = NOW()
      WHERE id = ?
    `).run(row.id);
    console.log(`  ✅ Conversación #${row.id} (${row.contact_name || 'sin nombre'})`);
  }

  console.log('\n✅ Listo. Recarga WaplyAdmin para verlas.');
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
