/**
 * GET /api/media/:mediaId
 *
 * Proxy autenticado para archivos de WhatsApp.
 * Meta devuelve una URL firmada que requiere Authorization header —
 * los <img> del navegador no pueden enviar headers, así que el backend
 * actúa de intermediario y stream-ea el archivo al cliente.
 *
 * Auth: token JWT en query param  ?token=...  o header Authorization: Bearer ...
 */

const router = require('express').Router();
const db     = require('../db');
const jwt    = require('jsonwebtoken');
const https  = require('https');

// ── Middleware de auth por query param o header ──────────────────────────────
async function mediaAuth(req, res, next) {
  const raw = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
  if (!raw) return res.status(401).json({ error: 'Token requerido' });
  try {
    const payload = jwt.verify(raw, process.env.JWT_SECRET);
    const agent   = await db.prepare(
      'SELECT id, tenant_id FROM agents WHERE id = ? AND active = 1'
    ).get(payload.id);
    if (!agent) return res.status(401).json({ error: 'Agente no válido' });
    req.agent = agent;
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
}

// ── GET /api/media/:mediaId ──────────────────────────────────────────────────
router.get('/:mediaId', mediaAuth, async (req, res) => {
  try {
    const tenant = await db.prepare(
      'SELECT wa_token FROM tenants WHERE id = ? AND active = 1'
    ).get(req.agent.tenant_id);

    if (!tenant?.wa_token) {
      return res.status(503).json({ error: 'Token WhatsApp no configurado' });
    }

    const mediaId = req.params.mediaId;

    // 1. Obtener URL temporal de Meta
    const metaInfoUrl = `https://graph.facebook.com/v19.0/${mediaId}`;
    const infoResp = await fetchWithAuth(metaInfoUrl, tenant.wa_token);
    const info = JSON.parse(infoResp.body);

    if (!info.url) {
      return res.status(404).json({ error: 'Media no encontrada en Meta', detail: info });
    }

    // 2. Descargar el archivo desde Meta y stream-earlo al cliente
    const mime = info.mime_type || 'application/octet-stream';
    const ext  = mimeToExt(mime);
    const filename = `media_${mediaId}${ext}`;

    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'private, max-age=3600');

    // Para imágenes: inline (se ven en el browser)
    // Para el resto: attachment (descarga)
    if (mime.startsWith('image/')) {
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    } else {
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    }

    await streamFile(info.url, tenant.wa_token, res);

  } catch (err) {
    console.error('Error proxy media:', err.message);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Error obteniendo media', detail: err.message });
    }
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fetchWithAuth(url, token) {
  return new Promise((resolve, reject) => {
    const opts = {
      headers: { Authorization: `Bearer ${token}` },
    };
    https.get(url, opts, (resp) => {
      let body = '';
      resp.on('data', chunk => body += chunk);
      resp.on('end', () => resolve({ status: resp.statusCode, body, headers: resp.headers }));
    }).on('error', reject);
  });
}

function streamFile(url, token, res) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Authorization: `Bearer ${token}` } }, (resp) => {
      if (resp.statusCode !== 200) {
        reject(new Error(`Meta respondió ${resp.statusCode}`));
        return;
      }
      resp.pipe(res);
      resp.on('end', resolve);
      resp.on('error', reject);
    }).on('error', reject);
  });
}

function mimeToExt(mime = '') {
  const map = {
    'image/jpeg':       '.jpg',
    'image/png':        '.png',
    'image/webp':       '.webp',
    'image/gif':        '.gif',
    'video/mp4':        '.mp4',
    'video/3gpp':       '.3gp',
    'audio/ogg':        '.ogg',
    'audio/mpeg':       '.mp3',
    'audio/mp4':        '.m4a',
    'application/pdf':  '.pdf',
    'application/msword': '.doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.ms-excel': '.xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  };
  return map[mime] || '';
}

module.exports = router;
