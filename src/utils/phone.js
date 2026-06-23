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
  let digits = String(p || '').replace(/\D/g, '');
  if (!digits) return '';

  // Prefijo internacional "00" (en vez de "+") → quitarlo, ej. "0034628331770" → "34628331770"
  if (digits.length >= 11 && digits.startsWith('00')) {
    digits = digits.slice(2);
  }

  // Trunk prefix "0" + móvil/fijo español de 9 dígitos sin código de país,
  // ej. "0628331770" (10 dígitos) → "628331770" → añadir 34
  if (digits.length === 10 && digits.startsWith('0')) {
    digits = digits.slice(1);
  }

  // Móvil/fijo español sin prefijo de país (9 dígitos) → añadir 34
  if (digits.length === 9) return '34' + digits;

  return digits;
}

module.exports = { normalizePhone };
