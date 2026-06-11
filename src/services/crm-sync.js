/**
 * crm-sync.js
 * Sincroniza mensajes de Waply → CRM (Supabase gestorfer)
 * Se llama después de cada mensaje inbound/outbound
 */

const CRM_WEBHOOK_URL    = process.env.CRM_WEBHOOK_URL    || 'https://neolhaaonclnkryndzyj.supabase.co/functions/v1/waply-webhook';
const CRM_WEBHOOK_SECRET = process.env.CRM_WEBHOOK_SECRET || '';

/**
 * Notifica al CRM de un mensaje nuevo (inbound u outbound)
 *
 * @param {object} params
 * @param {number} params.tenantId
 * @param {number} params.convId          - ID de conversación en Waply
 * @param {'inbound'|'outbound'} params.direction
 * @param {string} params.phone           - wa_id del contacto
 * @param {string} params.contactName
 * @param {number|null} params.leadId     - si el contacto tiene lead vinculado en Waply
 * @param {object} params.message
 */
async function pushToCRM({ tenantId, convId, direction, phone, contactName, leadId, message }) {
  const secretLen = (process.env.CRM_WEBHOOK_SECRET || '').length;
  console.log(`[crm-sync] pushToCRM llamado: dir=${direction} phone=${phone} secret_len=${secretLen}`);
  if (!CRM_WEBHOOK_SECRET) {
    console.warn('[crm-sync] CRM_WEBHOOK_SECRET no configurado — sync desactivado');
    return;
  }

  const payload = {
    event:           'message',
    tenant_id:       tenantId,
    conversation_id: convId,
    direction,
    phone,
    contact_name:    contactName,
    lead_id:         leadId || null,
    message: {
      id:            message.id,
      wa_message_id: message.wa_message_id || null,
      type:          message.type || 'text',
      body:          message.body || null,
      media_url:     message.media_url || null,
      created_at:    message.created_at || new Date().toISOString(),
    },
  };

  try {
    const res = await fetch(CRM_WEBHOOK_URL, {
      method:  'POST',
      headers: {
        'Content-Type':    'application/json',
        'x-waply-secret':  CRM_WEBHOOK_SECRET,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.text();
      console.warn(`[crm-sync] Fallo al sincronizar con CRM: ${res.status} ${err}`);
    } else {
      console.log(`[crm-sync] ✅ Sincronizado con CRM: conv=${convId} dir=${direction} phone=${phone}`);
    }
  } catch (e) {
    // No bloquear el flujo principal si el CRM falla
    console.warn('[crm-sync] Error de red al sincronizar con CRM:', e.message);
  }
}

module.exports = { pushToCRM };
