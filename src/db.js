const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
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

    CREATE INDEX IF NOT EXISTS idx_messages_conv     ON messages(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_conv_tenant       ON conversations(tenant_id, status, last_msg_at DESC NULLS LAST);
    CREATE INDEX IF NOT EXISTS idx_timers_pending    ON automation_timers(status, execute_at);
    CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(tenant_id, scheduled_at, status);
    CREATE INDEX IF NOT EXISTS idx_contacts_tenant   ON contacts(tenant_id, wa_id);
  `);
  console.log('✅ Schema PostgreSQL inicializado');
}

module.exports = { prepare, pool, initSchema };
