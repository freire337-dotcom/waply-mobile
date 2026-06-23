/**
 * Singleton para acceder a la instancia de Socket.io fuera de las rutas Express
 * (p.ej. desde el motor de automatizaciones, que corre en background y no
 * tiene acceso a `req.app.get('io')`).
 */
let ioInstance = null;

function setIO(io) {
  ioInstance = io;
}

function getIO() {
  return ioInstance;
}

module.exports = { setIO, getIO };
