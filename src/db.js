const Database = require('better-sqlite3');
const path     = require('path');

const DB_PATH = path.join(__dirname, '..', 'whasat.db');
const db      = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── ESQUEMA COMPLETO ─────────────────────────────────────────────────────────

db.exec(`

  -- ── Tenants (un cliente = un tenant) ────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS tenants (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT    NOT NULL,
    slug            TEXT    NOT NULL UNIQUE,  -- gestorfer, factoria...
    wa_phone_id     TEXT,                      -- Meta phone number ID
    wa_token        TEXT,                      -- Meta access token
    wa_verify_token TEXT,                      -- para verificar webhook
    fcm_server_key  TEXT,                      -- push notifications
    plan            TEXT    NOT NULL DEFAULT 'free',
    active          INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- ── Agentes ──────────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS agents (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name        TEXT    NOT NULL,
    email       TEXT    NOT NULL,
    password    TEXT    NOT NULL,
    role        TEXT    NOT NULL DEFAULT 'agent',
    fcm_token   TEXT,
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(tenant_id, email)
  );

  -- ── Contactos ────────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS contacts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    wa_id       TEXT    NOT NULL,
    name        TEXT,
    phone       TEXT,
    lead_id     TEXT,   -- ID del lead en el CRM del cliente
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(tenant_id, wa_id)
  );

  -- ── Conversaciones ───────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS conversations (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    contact_id    INTEGER NOT NULL REFERENCES contacts(id),
    lead_id       TEXT,   -- referencia al lead en el CRM
    assigned_to   INTEGER REFERENCES agents(id),
    status        TEXT    NOT NULL DEFAULT 'open',
    unread_count  INTEGER NOT NULL DEFAULT 0,
    last_message  TEXT,
    last_msg_at   TEXT,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- ── Mensajes ─────────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
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
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- ── Motor de automatizaciones ────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS automations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name        TEXT    NOT NULL,
    description TEXT,
    trigger     TEXT    NOT NULL,  -- lead.created | appointment.scheduled | message.received
    conditions  TEXT    NOT NULL DEFAULT '[]',   -- JSON array
    actions     TEXT    NOT NULL DEFAULT '[]',   -- JSON array ordenado
    active      INTEGER NOT NULL DEFAULT 1,
    created_by  INTEGER REFERENCES agents(id),
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- ── Ejecuciones de automatizaciones ─────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS automation_runs (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id      INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    automation_id  INTEGER NOT NULL REFERENCES automations(id),
    trigger_data   TEXT    NOT NULL DEFAULT '{}',  -- JSON del evento que lo disparó
    status         TEXT    NOT NULL DEFAULT 'running',  -- running | completed | failed
    error          TEXT,
    started_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    completed_at   TEXT
  );

  -- ── Timers pendientes (esperar respuesta / timeout) ──────────────────────────
  CREATE TABLE IF NOT EXISTS automation_timers (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id       INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    run_id          INTEGER NOT NULL REFERENCES automation_runs(id),
    action_index    INTEGER NOT NULL DEFAULT 0,
    execute_at      TEXT    NOT NULL,  -- cuándo comprobar
    waiting_for     TEXT    NOT NULL DEFAULT 'timeout',  -- timeout | response
    context         TEXT    NOT NULL DEFAULT '{}',        -- JSON con datos del paso
    status          TEXT    NOT NULL DEFAULT 'pending',   -- pending | resolved | expired
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- ── Citas (sincronizadas desde el CRM) ───────────────────────────────────────
  CREATE TABLE IF NOT EXISTS appointments (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id        INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    crm_appointment_id TEXT  NOT NULL,
    lead_id          TEXT    NOT NULL,
    contact_id       INTEGER REFERENCES contacts(id),
    scheduled_at     TEXT    NOT NULL,  -- fecha/hora de la cita
    agent_id         INTEGER REFERENCES agents(id),
    status           TEXT    NOT NULL DEFAULT 'scheduled',  -- scheduled | confirmed | cancelled | rescheduled
    reminder_7d_sent INTEGER NOT NULL DEFAULT 0,
    reminder_1d_sent INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(tenant_id, crm_appointment_id)
  );

  -- ── Índices ──────────────────────────────────────────────────────────────────
  CREATE INDEX IF NOT EXISTS idx_messages_conv     ON messages(conversation_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_conv_tenant       ON conversations(tenant_id, status, last_msg_at DESC);
  CREATE INDEX IF NOT EXISTS idx_timers_pending    ON automation_timers(status, execute_at);
  CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(tenant_id, scheduled_at, status);
  CREATE INDEX IF NOT EXISTS idx_contacts_tenant   ON contacts(tenant_id, wa_id);
`);

module.exports = db;
