const jwt = require('jsonwebtoken');
const db  = require('../db');

module.exports = function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token requerido' });
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const agent   = db.prepare(
      'SELECT id, tenant_id, name, email, role FROM agents WHERE id = ? AND active = 1'
    ).get(payload.id);
    if (!agent) return res.status(401).json({ error: 'Agente no encontrado' });
    req.agent = agent;
    next();
  } catch {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
};
