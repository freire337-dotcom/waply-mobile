/**
 * Importa los leads del CSV de Meta Ads que no llegaron por webhook.
 *
 * Uso:
 *   API_URL="https://tu-backend.railway.app" \
 *   EMAIL="tu@email.com" \
 *   PASSWORD="tupassword" \
 *   node scripts/import-meta-leads.js
 *
 * Si ya existen en Waply se saltarán sin reenviar nada.
 * Los nuevos recibirán la plantilla de bienvenida.
 */

const https = require('https');
const http  = require('http');

const API_URL     = (process.env.API_URL  || 'http://localhost:3001').replace(/\/$/, '');
const EMAIL       = process.env.EMAIL    || '';
const PASSWORD    = process.env.PASSWORD || '';
const TENANT_SLUG = process.env.TENANT_SLUG || '';

if (!EMAIL || !PASSWORD || !TENANT_SLUG) {
  console.error('❌  Debes pasar EMAIL, PASSWORD y TENANT_SLUG como variables de entorno.');
  process.exit(1);
}

// ─── Leads del informe de Meta (41 en total) ──────────────────────────────────
// Teléfonos problemáticos anotados:
//   650776860       → normalizePhone añadirá +34 si la función lo soporta; si no, fallará
//   +346099757234   → dígitos de más (probablemente +34609975723)
//   +36625366316    → prefijo +36 (Hungría) — puede ser error en el formulario
//   "+34 641 90 06 91" → espacios, normalizePhone los elimina
const LEADS = [
  { name: 'Julia Revilla Muñoz',          phone: '+34660731103'   },
  { name: 'Gustavo Piñuela Peral',         phone: '+34672924578'   },
  { name: 'Santi',                         phone: '+34611355165'   },
  { name: 'Joana Rodríguez',               phone: '+34697777003'   },
  { name: 'Maria fca Vidal mesa',          phone: '+34659827463'   },
  { name: 'Tec sup en Medicina Estética',  phone: '+34680397910'   },
  { name: 'Ana',                           phone: '+34665450258'   },
  { name: 'David Muñoz',                   phone: '+34622064118'   },
  { name: 'Mari José Suárez',              phone: '+34692575323'   },
  { name: 'Kilian Santana Vega',           phone: '+34640917292'   },
  { name: 'Carmen Zarcero Barbudo',        phone: '+34665878013'   },
  { name: 'Isaura Anddris',               phone: '+34642774796'   },
  { name: 'Julian González',              phone: '+34640330820'   },
  { name: 'Sara Aguilera blancart',       phone: '+34661189014'   },
  { name: 'MGR',                           phone: '+34650776860'   }, // ⚠ faltaba +34
  { name: 'Nixis Mina Chavez',            phone: '+34643151706'   },
  { name: 'July González',               phone: '+34609975723'   }, // ⚠ corregido dígito extra
  { name: 'Carlos Luciano',              phone: '+34632017621'   },
  { name: 'Pao Sanabria',               phone: '+34642116970'   },
  { name: 'Anix',                        phone: '+34609126094'   },
  { name: 'Bianka Miura',               phone: '+34641827159'   },
  { name: 'Carriel Mite Cinthya',       phone: '+34682594385'   },
  { name: 'Juanjo Velasco',             phone: '+34699038623'   },
  { name: 'Naina Krishen',              phone: '+34666781278'   },
  { name: 'Roberto Sola Moreno',        phone: '+34687983480'   },
  { name: 'Juanma Ureña R',             phone: '+36625366316'   }, // ⚠ prefijo +36 (del formulario)
  { name: 'MINGAXO BLACKERS',           phone: '+34649802663'   },
  { name: 'Juan Perdigones Jaen',       phone: '+34687592831'   },
  { name: 'Maria Regla Vidal Porras',   phone: '+34634469192'   },
  { name: 'Dayanis',                    phone: '+34641900691'   }, // espacios eliminados
  { name: 'Vicente Peinado',            phone: '+34676034828'   },
  { name: 'Marta Herranz',              phone: '+34628107989'   },
  { name: 'Alfonso Garcia Tudero',      phone: '+34652431395'   },
  { name: 'Marilza Morais',             phone: '+34678275266'   },
  { name: 'Maria Luisa',                phone: '+34661323147'   },
  { name: 'Luis',                       phone: '+34691462071'   },
  { name: 'Sheyla Mbm',                 phone: '+34644551547'   },
  { name: 'Sheila',                     phone: '+34662611049'   },
  { name: 'R E B E C C H I  M A R C O S', phone: '+34693718408' },
  { name: 'Marcela Trujillo',           phone: '+34677377819'   },
  { name: 'Alvarez Martinez Angel',     phone: ''               }, // ⚠ sin teléfono en Meta
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function request(url, options, body) {
  return new Promise((resolve, reject) => {
    const lib    = url.startsWith('https') ? https : http;
    const parsed = new URL(url);
    const req    = lib.request({
      hostname: parsed.hostname,
      port:     parsed.port || (url.startsWith('https') ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   options.method || 'GET',
      headers:  { 'Content-Type': 'application/json', ...(options.headers || {}) },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  // 1. Login
  console.log(`🔐 Iniciando sesión en ${API_URL}...`);
  const loginRes = await request(`${API_URL}/api/auth/login`, { method: 'POST' }, { email: EMAIL, password: PASSWORD, tenant_slug: TENANT_SLUG });
  if (loginRes.status !== 200 || !loginRes.body.token) {
    console.error('❌  Login fallido:', loginRes.body);
    process.exit(1);
  }
  const token = loginRes.body.token;
  console.log('✅  Sesión iniciada\n');

  // 2. Bulk import
  console.log(`📤 Enviando ${LEADS.length} leads al endpoint /api/conversations/bulk-import...`);
  const importRes = await request(
    `${API_URL}/api/conversations/bulk-import`,
    { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } },
    { contacts: LEADS, template: 'bienvenida_gestorfer_v2_', language: 'es' }
  );

  if (importRes.status !== 200) {
    console.error('❌  Error en la importación:', importRes.body);
    process.exit(1);
  }

  const { created = [], skipped = [], failed = [] } = importRes.body;

  // Parchear conversaciones que quedaron sin last_msg_at (creadas pero con envío fallido)
  // llamando al endpoint de health para forzar que el backend las actualice.
  // Nota: el backend ya lo hace desde esta versión, pero las 10 anteriores necesitan
  // un fix manual — se hace con el script patch-null-conversations.js si hace falta.

  console.log(`\n✅  NUEVOS (${created.length}): leads creados y plantilla enviada`);
  created.forEach(c => console.log(`   + ${c.name} (${c.phone})`));

  console.log(`\n⏭   SALTADOS (${skipped.length}): ya existían en Waply`);
  skipped.forEach(c => console.log(`   = ${c.name} (${c.phone})`));

  if (failed.length) {
    console.log(`\n❌  FALLIDOS (${failed.length}):`);
    failed.forEach(c => console.log(`   ✗ ${c.name} (${c.phone}) → ${c.error}`));
  }

  console.log(`\n📊  Resumen: ${created.length} nuevos | ${skipped.length} existentes | ${failed.length} fallidos`);
}

main().catch(err => { console.error(err); process.exit(1); });
