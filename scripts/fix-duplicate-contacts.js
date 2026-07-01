/**
 * Detecta y elimina conversaciones duplicadas para el mismo contacto.
 * Conserva la que tiene mensajes; borra la vacía importada.
 *
 * Uso: node scripts/fix-duplicate-contacts.js
 */

require('dotenv').config();
const db = require('../src/db');

async function main() {
  // Conversaciones duplicadas por contact_id (sin filtro de tenant)
  const dupConvs = await db.prepare(`
    SELECT contact_id, COUNT(*) as cnt
    FROM conversations
    GROUP BY contact_id
    HAVING COUNT(*) > 1
  `).all();

  if (dupConvs.length === 0) {
    console.log('✅ No se encontraron conversaciones duplicadas.');
  } else {
    console.log(`⚠️  ${dupConvs.length} contactos con conversaciones duplicadas:\n`);

    for (const row of dupConvs) {
      const contact = await db.prepare('SELECT id, name, wa_id FROM contacts WHERE id = ?').get(row.contact_id);
      const convs = await db.prepare(`
        SELECT c.id, c.last_message, c.last_msg_at,
               (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) AS msg_count
        FROM conversations c
        WHERE c.contact_id = ?
        ORDER BY msg_count DESC, c.id ASC
      `).all(row.contact_id);

      console.log(`  👤 ${contact.name} (${contact.wa_id})`);
      for (const cv of convs) {
        console.log(`     conv #${cv.id} — ${cv.msg_count} mensajes — "${cv.last_message || 'vacía'}"`);
      }

      const [keep, ...toDelete] = convs;
      console.log(`     → Conservar #${keep.id}, borrar: ${toDelete.map(x => '#' + x.id).join(', ')}`);

      for (const cv of toDelete) {
        await db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(cv.id);
        await db.prepare('DELETE FROM conversations WHERE id = ?').run(cv.id);
        console.log(`     ✅ Conversación #${cv.id} eliminada`);
      }
    }
  }

  // También buscar contactos con el mismo número en distintos registros
  const allContacts = await db.prepare('SELECT id, wa_id, name FROM contacts ORDER BY id').all();
  const normalize = (p) => (p || '').replace(/[\s+\-()]/g, '');
  const groups = {};
  for (const c of allContacts) {
    const key = normalize(c.wa_id);
    if (!groups[key]) groups[key] = [];
    groups[key].push(c);
  }
  const dupContacts = Object.entries(groups).filter(([, v]) => v.length > 1);

  if (dupContacts.length > 0) {
    console.log(`\n⚠️  ${dupContacts.length} números con contactos duplicados:\n`);
    for (const [key, contacts] of dupContacts) {
      console.log(`  📞 ${key}`);
      const withCounts = [];
      for (const c of contacts) {
        const conv = await db.prepare('SELECT id FROM conversations WHERE contact_id = ?').get(c.id);
        const msgCount = conv
          ? (await db.prepare('SELECT COUNT(*) as n FROM messages WHERE conversation_id = ?').get(conv.id)).n
          : 0;
        withCounts.push({ ...c, conv, msgCount });
        console.log(`     contact #${c.id} "${c.name}" wa_id="${c.wa_id}" — ${msgCount} msgs`);
      }
      withCounts.sort((a, b) => b.msgCount - a.msgCount);
      const [keep, ...toDelete] = withCounts;
      console.log(`     → Conservar contact #${keep.id}, borrar: ${toDelete.map(x => '#' + x.id).join(', ')}`);
      for (const c of toDelete) {
        if (c.conv) {
          await db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(c.conv.id);
          await db.prepare('DELETE FROM conversations WHERE id = ?').run(c.conv.id);
        }
        await db.prepare('DELETE FROM contacts WHERE id = ?').run(c.id);
        console.log(`     ✅ Contact #${c.id} eliminado`);
      }
    }
  } else if (dupConvs.length === 0) {
    console.log('✅ Tampoco hay contactos duplicados por número.');
  }

  console.log('\n✅ Listo. Recarga WaplyAdmin.');
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
