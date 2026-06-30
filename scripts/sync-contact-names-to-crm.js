/**
 * sync-contact-names-to-crm.js
 *
 * Script de ejecución única: lee todos los contactos de nuestra BD (Railway)
 * que tienen nombre real y los reenvía al webhook del CRM (Supabase) para que
 * actualice el campo contact_name en whatsapp_conversations.
 *
 * Uso (desde la carpeta backend/):
 *   node scripts/sync-contact-names-to-crm.js
 */

require('dotenv').config();
const { Pool } = require('pg');

const DB_URL = process.env.DATABASE_URL
  || 'postgresql://postgres:IqsRVoWnimNERANtRvpGaGPnruBGYTXi@acela.proxy.rlwy.net:39726/railway';

const CRM_WEBHOOK_URL    = process.env.CRM_WEBHOOK_URL    || 'https://neolhaaonclnkryndzyj.supabase.co/functions/v1/waply-webhook';
const CRM_WEBHOOK_SECRET = process.env.CRM_WEBHOOK_SECRET;

if (!CRM_WEBHOOK_SECRET) {
  console.error('❌ Falta CRM_WEBHOOK_SECRET en .env');
  process.exit(1);
}

const pool = new Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  // Solo contactos con nombre real (excluye los que son solo número de teléfono)
  const { rows: contacts } = await pool.query(`
    SELECT wa_id, name, lead_id,
           (SELECT id FROM conversations WHERE contact_id = contacts.id LIMIT 1) AS conv_id,
           (SELECT tenant_id FROM conversations WHERE contact_id = contacts.id LIMIT 1) AS tenant_id
    FROM contacts
    WHERE name IS NOT NULL
      AND name != ''
      AND name NOT SIMILAR TO '[0-9+ ()-]+'
    ORDER BY name
  `);

  console.log(`📋 ${contacts.length} contactos con nombre real encontrados`);

  let ok = 0, fail = 0;

  for (const c of contacts) {
    if (!c.conv_id || !c.tenant_id) {
      console.log(`⚠️  Sin conversación: ${c.name} (${c.wa_id}) — omitido`);
      continue;
    }

    const payload = {
      event:           'contact_name_update',
      tenant_id:       c.tenant_id,
      conversation_id: c.conv_id,
      phone:           c.wa_id,
      contact_name:    c.name,
      lead_id:         c.lead_id || null,
    };

    try {
      const res = await fetch(CRM_WEBHOOK_URL, {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-waply-secret': CRM_WEBHOOK_SECRET,
        },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        console.log(`✅ ${c.name} (${c.wa_id})`);
        ok++;
      } else {
        const err = await res.text();
        console.warn(`❌ ${c.name} (${c.wa_id}) → ${res.status}: ${err}`);
        fail++;
      }
    } catch (e) {
      console.warn(`❌ ${c.name} (${c.wa_id}) → ${e.message}`);
      fail++;
    }

    // Pequeña pausa para no saturar el webhook
    await new Promise(r => setTimeout(r, 100));
  }

  console.log(`\nResumen: ${ok} OK, ${fail} fallidos`);
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
