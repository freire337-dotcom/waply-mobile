const { Pool } = require('pg');

const DB_URL = process.env.DATABASE_URL
  || 'postgresql://postgres:IqsRVoWnimNERANtRvpGaGPnruBGYTXi@acela.proxy.rlwy.net:39726/railway';

console.log('🔍 DATABASE_URL:', DB_URL.substring(0, 40) + '...');

const pool = new Pool({
  connectionString:        DB_URL,
  ssl:                     { rejectUnauthorized: false },
  max:                     20,               // más conexiones paralelas (default: 10)
  idleTimeoutMillis:       30_000,           // libera conexiones ociosas tras 30s
  connectionTimeoutMillis: 8_000,            // error en vez de colgar si la BD no responde
});

// Convierte ? placeholders a $1, $2, ... para PostgreSQL
function toPostgres(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// API compatible con better-sqlite3 pero async
function prepare(sql) {
  const pgSql = toPostgres(sql);
  return {
    async get(...params) {
      const res = await pool.query(pgSql, params.flat());
      return res.rows[0] || null;
    },
    async all(...params) {
      const res = await pool.query(pgSql, params.flat());
      return res.rows;
    },
    async run(...params) {
      let q = pgSql;
      // Añadir RETURNING id a INSERTs para obtener el id insertado
      if (/^\s*INSERT/i.test(q) && !/RETURNING/i.test(q)) {
        q += ' RETURNING id';
      }
      const res = await pool.query(q, params.flat());
      return {
        lastInsertRowid: res.rows[0]?.id ?? null,
        changes: res.rowCount,
      };
    },
  };
}

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tenants (
      id              SERIAL PRIMARY KEY,
      name            TEXT    NOT NULL,
      slug            TEXT    NOT NULL UNIQUE,
      wa_phone_id     TEXT,
      wa_token        TEXT,
      wa_verify_token TEXT,
      fcm_server_key  TEXT,
      plan            TEXT    NOT NULL DEFAULT 'free',
      active          INTEGER NOT NULL DEFAULT 1,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS agents (
      id          SERIAL PRIMARY KEY,
      tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name        TEXT    NOT NULL,
      email       TEXT    NOT NULL,
      password    TEXT    NOT NULL,
      role        TEXT    NOT NULL DEFAULT 'agent',
      fcm_token   TEXT,
      active      INTEGER NOT NULL DEFAULT 1,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(tenant_id, email)
    );

    CREATE TABLE IF NOT EXISTS contacts (
      id          SERIAL PRIMARY KEY,
      tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      wa_id       TEXT    NOT NULL,
      name        TEXT,
      phone       TEXT,
      lead_id     TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(tenant_id, wa_id)
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id            SERIAL PRIMARY KEY,
      tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      contact_id    INTEGER NOT NULL REFERENCES contacts(id),
      lead_id       TEXT,
      assigned_to   INTEGER REFERENCES agents(id),
      status        TEXT    NOT NULL DEFAULT 'open',
      unread_count  INTEGER NOT NULL DEFAULT 0,
      last_message  TEXT,
      last_msg_at   TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS messages (
      id              SERIAL PRIMARY KEY,
      tenant_id       INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id),
      wa_message_id   TEXT    UNIQUE,
      direction       TEXT    NOT NULL,
      type            TEXT    NOT NULL DEFAULT 'text',
      body            TEXT,
      media_url       TEXT,
      media_mime      TEXT,
      status          TEXT    NOT NULL DEFAULT 'sent',
      sender_id       INTEGER REFERENCES agents(id),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS automations (
      id          SERIAL PRIMARY KEY,
      tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name        TEXT    NOT NULL,
      description TEXT,
      trigger     TEXT    NOT NULL,
      conditions  TEXT    NOT NULL DEFAULT '[]',
      actions     TEXT    NOT NULL DEFAULT '[]',
      active      INTEGER NOT NULL DEFAULT 1,
      created_by  INTEGER REFERENCES agents(id),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS automation_runs (
      id             SERIAL PRIMARY KEY,
      tenant_id      INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      automation_id  INTEGER NOT NULL REFERENCES automations(id),
      trigger_data   TEXT    NOT NULL DEFAULT '{}',
      status         TEXT    NOT NULL DEFAULT 'running',
      error          TEXT,
      started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at   TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS automation_timers (
      id              SERIAL PRIMARY KEY,
      tenant_id       INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      run_id          INTEGER NOT NULL REFERENCES automation_runs(id),
      action_index    INTEGER NOT NULL DEFAULT 0,
      execute_at      TIMESTAMPTZ NOT NULL,
      waiting_for     TEXT    NOT NULL DEFAULT 'timeout',
      context         TEXT    NOT NULL DEFAULT '{}',
      status          TEXT    NOT NULL DEFAULT 'pending',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS appointments (
      id                 SERIAL PRIMARY KEY,
      tenant_id          INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      crm_appointment_id TEXT    NOT NULL,
      lead_id            TEXT    NOT NULL,
      contact_id         INTEGER REFERENCES contacts(id),
      scheduled_at       TIMESTAMPTZ NOT NULL,
      agent_id           INTEGER REFERENCES agents(id),
      status             TEXT    NOT NULL DEFAULT 'scheduled',
      reminder_7d_sent   INTEGER NOT NULL DEFAULT 0,
      reminder_1d_sent   INTEGER NOT NULL DEFAULT 0,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(tenant_id, crm_appointment_id)
    );

    CREATE TABLE IF NOT EXISTS conversation_tasks (
      id              SERIAL PRIMARY KEY,
      tenant_id       INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      agent_id        INTEGER REFERENCES agents(id),
      title           TEXT    NOT NULL,
      due_at          TIMESTAMPTZ NOT NULL,
      status          TEXT    NOT NULL DEFAULT 'pending',
      reminder_sent   INTEGER NOT NULL DEFAULT 0,
      created_by      INTEGER REFERENCES agents(id),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at    TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS app_releases (
      id          SERIAL PRIMARY KEY,
      platform    TEXT    NOT NULL UNIQUE,
      profile     TEXT    NOT NULL,
      version     TEXT,
      url         TEXT    NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS agent_limit INTEGER;
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS pipeline_stage TEXT NOT NULL DEFAULT 'abierto';
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited BOOLEAN NOT NULL DEFAULT false;
    -- Meta envía las tarjetas de contacto compartidas (vCard) en msg.contacts, no en
    -- msg.text/msg.<media> — sin esta columna ese payload se perdía y el mensaje
    -- quedaba guardado con body=null (ver webhook/meta.js).
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS contacts_payload TEXT;
    -- Evita re-disparar el trigger "sin respuesta 24h" en cada pasada del cron;
    -- se resetea a false en cuanto entra o sale un mensaje nuevo en la conversación.
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS followup_24h_sent BOOLEAN NOT NULL DEFAULT false;
    -- Referencia al wa_message_id del mensaje al que se responde (reply/quote de WhatsApp).
    -- Null si el mensaje no es una respuesta. Ver whatsapp.js sendText y webhook/meta.js.
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS context_wa_message_id TEXT;

    -- Cola de webhooks: cada evento de Meta se guarda aquí ANTES de procesarlo.
    -- Si el servidor muere a mitad del procesamiento, al reiniciar se reprocesarán
    -- los que quedaron en status='pending' — así no se pierden leads aunque el
    -- servidor caiga por OOM u otro motivo (ver webhook/meta.js).
    CREATE TABLE IF NOT EXISTS webhook_queue (
      id          SERIAL PRIMARY KEY,
      payload     TEXT    NOT NULL,
      status      TEXT    NOT NULL DEFAULT 'pending',  -- pending | done | error
      error       TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      processed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_queue_status ON webhook_queue(status, created_at);

    -- Agente IA: columnas en agents para marcar si es un bot y su configuración
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS is_ai_agent BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS ai_system_prompt TEXT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS ai_model TEXT DEFAULT 'claude-3-5-haiku-20241022';

    -- Configuración de API key del agente IA (una por tenant)
    CREATE TABLE IF NOT EXISTS ai_agent_config (
      id          SERIAL PRIMARY KEY,
      tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      provider    TEXT NOT NULL DEFAULT 'anthropic',  -- anthropic | openai
      api_key     TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(tenant_id)
    );

    -- Historial de notificaciones en la app móvil
    -- agent_id NULL = visible para todos los agentes del tenant (ej. nuevo lead sin asignar)
    -- agent_id X    = solo para ese agente (ej. recordatorio de su propia tarea)
    CREATE TABLE IF NOT EXISTS notifications (
      id              SERIAL PRIMARY KEY,
      tenant_id       INTEGER NOT NULL,
      agent_id        INTEGER,  -- null = todos los agentes del tenant
      type            TEXT NOT NULL,  -- 'new_lead' | 'task_reminder' | 'no_response'
      title           TEXT NOT NULL,
      body            TEXT,
      conversation_id INTEGER,  -- para navegar al chat al tocar
      read            BOOLEAN NOT NULL DEFAULT false,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_notif_tenant ON notifications(tenant_id, agent_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_messages_conv       ON messages(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_conv_tenant         ON conversations(tenant_id, status, last_msg_at DESC NULLS LAST);
    CREATE INDEX IF NOT EXISTS idx_timers_pending      ON automation_timers(status, execute_at);
    CREATE INDEX IF NOT EXISTS idx_appointments_date   ON appointments(tenant_id, scheduled_at, status);
    CREATE INDEX IF NOT EXISTS idx_contacts_tenant     ON contacts(tenant_id, wa_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_conv          ON conversation_tasks(conversation_id, status);
    CREATE INDEX IF NOT EXISTS idx_tasks_due           ON conversation_tasks(status, reminder_sent, due_at);
    -- PostgreSQL NO crea índices automáticamente en FK — los añadimos para acelerar
    -- los JOINs y filtros más frecuentes (conversations→contacts, conversations→agents,
    -- messages→sender, conversations por assigned_to).
    CREATE INDEX IF NOT EXISTS idx_conv_contact_id     ON conversations(contact_id);
    CREATE INDEX IF NOT EXISTS idx_conv_assigned_to    ON conversations(assigned_to);
    CREATE INDEX IF NOT EXISTS idx_messages_sender     ON messages(sender_id) WHERE sender_id IS NOT NULL;
    -- Índice para el panel de notificaciones (campana): acelera la query más frecuente
    CREATE INDEX IF NOT EXISTS idx_notif_unread        ON notifications(tenant_id, read, created_at DESC);

    -- Plantillas rápidas de respuesta: textos predefinidos que los agentes insertan
    -- con un clic en el chat sin escribirlos cada vez (ej. "Muchas gracias, en breve..").
    CREATE TABLE IF NOT EXISTS quick_replies (
      id          SERIAL PRIMARY KEY,
      tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name        TEXT    NOT NULL,
      body        TEXT    NOT NULL,
      created_by  INTEGER REFERENCES agents(id),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_quick_replies_tenant ON quick_replies(tenant_id);
  `);
  console.log('✅ Schema PostgreSQL inicializado');
}

module.exports = { prepare, pool, initSchema };
