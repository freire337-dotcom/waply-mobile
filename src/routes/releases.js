/**
 * Página de descarga de la app + registro del último build.
 *
 * Flujo: tras cada `eas build`, el script mobile/scripts/publish-build.sh
 * hace POST aquí con la URL real del APK. GET /download siempre redirige
 * al build más reciente — no hay que copiar/pegar enlaces a mano.
 */

const router = require('express').Router();
const db     = require('../db');

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
      <a href="${release.url}"
         style="display:inline-block;margin-top:20px;background:#128C7E;color:#fff;
                padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;">
        Descargar APK
      </a>
    </body>
    </html>
  `);
});

module.exports = router;
