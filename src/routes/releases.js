/**
 * Página de descarga de la app + registro del último build.
 *
 * Flujo automático: EAS llama a POST /api/eas-webhook al terminar cada build.
 * El endpoint verifica la firma HMAC-SHA1 (secret en EAS_WEBHOOK_SECRET) y
 * upserta la URL en app_releases. GET /download siempre apunta al último build.
 */

const router  = require('express').Router();
const db      = require('../db');
const crypto  = require('crypto');

// ── POST /api/eas-webhook ─────────────────────────────────────────────────────
// EAS llama aquí automáticamente al terminar cada build (evento BUILD).
// Registrar el webhook: eas webhook:create --event BUILD --url https://waply-backend-production.up.railway.app/api/eas-webhook
// El secret generado va en la variable de Railway: EAS_WEBHOOK_SECRET
router.post('/api/eas-webhook', express_raw_body, async (req, res) => {
  try {
    // Verificar firma HMAC-SHA1 de EAS
    const secret = process.env.EAS_WEBHOOK_SECRET;
    if (secret) {
      const sig      = req.headers['expo-signature'] || '';
      const expected = 'sha1=' + crypto.createHmac('sha1', secret).update(req.rawBody).digest('hex');
      if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
        console.warn('⚠ EAS webhook: firma inválida');
        return res.status(401).json({ error: 'Firma inválida' });
      }
    }

    const body = JSON.parse(req.rawBody.toString());

    // Solo procesar builds terminados con éxito
    if (body.status !== 'finished') {
      return res.json({ ok: true, skipped: body.status });
    }

    const apkUrl   = body.artifacts?.buildUrl;
    const platform = body.metadata?.platform || 'android';
    const profile  = body.metadata?.buildProfile || 'preview';
    const version  = body.metadata?.appVersion || null;

    if (!apkUrl) {
      console.warn('⚠ EAS webhook: sin buildUrl en', JSON.stringify(body.artifacts));
      return res.status(400).json({ error: 'Sin buildUrl' });
    }

    await db.prepare(`
      INSERT INTO app_releases (platform, profile, version, url)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (platform) DO UPDATE SET
        profile    = excluded.profile,
        version    = excluded.version,
        url        = excluded.url,
        created_at = NOW()
    `).run(platform, profile, version, apkUrl);

    console.log(`✅ EAS webhook: nueva release ${platform} ${version} → ${apkUrl}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('❌ EAS webhook error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Middleware para capturar el raw body (necesario para verificar firma HMAC)
function express_raw_body(req, res, next) {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    req.rawBody = Buffer.concat(chunks);
    next();
  });
}

// ── POST /api/releases ────────────────────────────────────────────────────────
// Registra/actualiza el último build de una plataforma. Protegido con el mismo
// x-super-token que ya se usa en /api/triggers/tenant-key.
router.post('/api/releases', async (req, res) => {
  const superToken = req.headers['x-super-token'];
  if (superToken !== process.env.SUPER_ADMIN_TOKEN) {
    return res.status(403).json({ error: 'Acceso restringido' });
  }

  const { platform, profile, version, url } = req.body;
  if (!platform || !profile || !url) {
    return res.status(400).json({ error: 'platform, profile y url son requeridos' });
  }

  await db.prepare(`
    INSERT INTO app_releases (platform, profile, version, url)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (platform) DO UPDATE SET
      profile    = excluded.profile,
      version    = excluded.version,
      url        = excluded.url,
      created_at = NOW()
  `).run(platform, profile, version || null, url);

  res.json({ ok: true });
});

// ── GET /api/releases/latest ──────────────────────────────────────────────────
router.get('/api/releases/latest', async (req, res) => {
  const platform = req.query.platform || 'android';
  const release = await db.prepare('SELECT * FROM app_releases WHERE platform = ?').get(platform);
  if (!release) return res.status(404).json({ error: 'Sin builds registrados todavía' });
  res.json(release);
});

// ── GET /download/apk ────────────────────────────────────────────────────────
// Redirect directo a la URL del APK (GitHub Releases — pública, sin auth).
router.get('/download/apk', async (req, res) => {
  const platform = req.query.platform || 'android';
  const release  = await db.prepare('SELECT * FROM app_releases WHERE platform = ?').get(platform);
  if (!release) return res.status(404).send('Sin builds registrados');
  res.redirect(302, release.url);
});

// ── GET /download/redirect ────────────────────────────────────────────────────
router.get('/download/redirect', async (req, res) => {
  res.redirect(302, '/download/apk');
});

// ── GET /download ──────────────────────────────────────────────────────────────
// Página pública con botón de descarga. Siempre apunta al último build.
router.get('/download', async (req, res) => {
  const platform = req.query.platform || 'android';
  const release  = await db.prepare('SELECT * FROM app_releases WHERE platform = ?').get(platform);

  if (!release) {
    return res.status(404).send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px 20px;">
        <h2>Todavía no hay ningún build publicado</h2>
        <p>Ejecuta <code>eas build</code> y publícalo con el script de release.</p>
      </body></html>
    `);
  }

  const fecha = new Date(release.created_at).toLocaleString('es-ES');
  res.send(`
    <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Descargar Waply</title>
    </head>
    <body style="font-family:-apple-system,sans-serif;text-align:center;padding:60px 20px;background:#f4f4f4;">
      <h1 style="color:#128C7E;">Waply</h1>
      <p>Última versión disponible: <strong>${release.version || '—'}</strong></p>
      <p style="color:#888;font-size:13px;">Build del ${fecha} · perfil ${release.profile}</p>
      <a href="/download/apk"
         style="display:inline-block;margin-top:20px;background:#128C7E;color:#fff;
                padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;">
        ⬇ Descargar APK
      </a>
      <p style="color:#aaa;font-size:11px;margin-top:12px;">
        Después de descargarlo, abre el archivo .apk desde las notificaciones o desde Archivos.<br>
        Si Android lo bloquea, ve a Ajustes → Seguridad → Instalar apps desconocidas.
      </p>
    </body>
    </html>
  `);
});

module.exports = router;
