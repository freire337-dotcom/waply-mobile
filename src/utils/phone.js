/**
 * Normaliza un número de teléfono al formato wa_id que usa WhatsApp
 * (sin '+', sin espacios, con código de país).
 *
 * Caso típico: un lead entra desde la web con el móvil español sin
 * prefijo (9 dígitos, ej. "628331770") y luego WhatsApp manda el
 * inbound con el número completo ("34628331770"). Sin normalizar,
 * se crean dos contactos/conversaciones distintos para la misma persona.
 */
function normalizePhone(p) {
  const digits = String(p || '').replace(/\D/g, '');
  if (!digits) return '';
  // Móvil español sin prefijo de país → añadir 34
  if (digits.length === 9) return '34' + digits;
  return digits;
}

module.exports = { normalizePhone };
