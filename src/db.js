import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { currentTenantId } from './tenant-context.js'

export const DATA_DIR = path.resolve(process.cwd(), 'data')
fs.mkdirSync(DATA_DIR, { recursive: true })

export const db = new Database(path.join(DATA_DIR, 'bot.db'))
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
CREATE TABLE IF NOT EXISTS tenants (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS global_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  tenant_id INTEGER NOT NULL DEFAULT 1,
  key       TEXT NOT NULL,
  value     TEXT NOT NULL,
  PRIMARY KEY (tenant_id, key),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS contacts (
  tenant_id       INTEGER NOT NULL DEFAULT 1,
  jid             TEXT NOT NULL,
  name            TEXT,
  whatsapp_name_raw TEXT,
  transport_jid   TEXT,
  bot_paused      INTEGER NOT NULL DEFAULT 0,
  service_status  TEXT NOT NULL DEFAULT 'open' CHECK (service_status IN ('open','resolved')),
  assigned_user_id INTEGER,
  current_cycle_id INTEGER,
  last_unanswered_alert_message_id INTEGER,
  last_message_at TEXT,
  last_read_message_id INTEGER NOT NULL DEFAULT 0,
  synced_at       TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, jid),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS customers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  INTEGER NOT NULL DEFAULT 1,
  first_name TEXT NOT NULL,
  last_name  TEXT NOT NULL,
  phone      TEXT NOT NULL,
  extra_data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, phone),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_customers_name ON customers (tenant_id, first_name, last_name);
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  INTEGER NOT NULL DEFAULT 1,
  jid        TEXT NOT NULL,
  direction  TEXT NOT NULL CHECK (direction IN ('in','out')),
  text       TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'user',
  message_type TEXT NOT NULL DEFAULT 'text',
  mime_type TEXT,
  file_name TEXT,
  media_path TEXT,
  file_size INTEGER,
  duration_seconds INTEGER,
  is_voice_note INTEGER NOT NULL DEFAULT 0,
  author_user_id INTEGER,
  author_name TEXT,
  cycle_id INTEGER,
  external_id TEXT,
  external_timestamp TEXT,
  edited_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_messages_jid ON messages (tenant_id, jid, id);
CREATE TABLE IF NOT EXISTS canned_responses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  INTEGER NOT NULL DEFAULT 1,
  name       TEXT NOT NULL,
  triggers   TEXT NOT NULL,
  match_type TEXT NOT NULL DEFAULT 'contains',
  response   TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  priority   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS rules (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  INTEGER NOT NULL DEFAULT 1,
  name       TEXT NOT NULL,
  pattern    TEXT NOT NULL,
  match_type TEXT NOT NULL DEFAULT 'contains',
  action     TEXT NOT NULL DEFAULT 'reply',
  response   TEXT,
  enabled    INTEGER NOT NULL DEFAULT 1,
  priority   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS knowledge (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   INTEGER NOT NULL DEFAULT 1,
  question    TEXT NOT NULL,
  answer      TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'manual',
  status      TEXT NOT NULL DEFAULT 'approved',
  usage_count INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS smart_notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  INTEGER NOT NULL DEFAULT 1,
  jid        TEXT NOT NULL,
  category   TEXT NOT NULL,
  title      TEXT NOT NULL,
  content    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_smart_notes_status ON smart_notes (tenant_id, status, updated_at DESC);
CREATE TABLE IF NOT EXISTS smart_note_messages (
  note_id    INTEGER NOT NULL,
  message_id INTEGER NOT NULL UNIQUE,
  PRIMARY KEY (note_id, message_id),
  FOREIGN KEY (note_id) REFERENCES smart_notes(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id     INTEGER NOT NULL DEFAULT 1,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'attendant' CHECK (role IN ('super_admin','admin','attendant')),
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS conversation_cycles (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id        INTEGER NOT NULL DEFAULT 1,
  jid              TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  assigned_user_id INTEGER,
  opened_by        INTEGER,
  resolved_by      INTEGER,
  started_at       TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at      TEXT,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (assigned_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (opened_by) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (resolved_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_cycles_jid ON conversation_cycles (tenant_id, jid, id DESC);
CREATE TABLE IF NOT EXISTS internal_notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  INTEGER NOT NULL DEFAULT 1,
  jid        TEXT NOT NULL,
  author_id  INTEGER,
  author_name TEXT NOT NULL,
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_internal_notes_jid ON internal_notes (tenant_id, jid, id DESC);
CREATE TABLE IF NOT EXISTS internal_messages (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id        INTEGER NOT NULL DEFAULT 1,
  sender_id        INTEGER,
  sender_name      TEXT NOT NULL,
  recipient_id     INTEGER NOT NULL,
  text             TEXT NOT NULL DEFAULT '',
  message_type     TEXT NOT NULL DEFAULT 'text',
  mime_type        TEXT,
  file_name        TEXT,
  media_path       TEXT,
  file_size        INTEGER,
  duration_seconds INTEGER,
  is_voice_note    INTEGER NOT NULL DEFAULT 0,
  edited_at        TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (recipient_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_internal_messages_thread ON internal_messages (tenant_id, sender_id, recipient_id, id);
CREATE TABLE IF NOT EXISTS history_imports (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id         INTEGER NOT NULL DEFAULT 1,
  jid               TEXT NOT NULL,
  imported_by       INTEGER,
  file_name         TEXT NOT NULL,
  messages_imported INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (imported_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS weekly_availability (
  tenant_id    INTEGER NOT NULL DEFAULT 1,
  weekday      INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  enabled      INTEGER NOT NULL DEFAULT 1,
  start_time   TEXT NOT NULL DEFAULT '09:00',
  end_time     TEXT NOT NULL DEFAULT '18:00',
  slot_minutes INTEGER NOT NULL DEFAULT 60,
  PRIMARY KEY (tenant_id, weekday),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS calendar_exceptions (
  tenant_id  INTEGER NOT NULL DEFAULT 1,
  date       TEXT NOT NULL,
  is_open    INTEGER NOT NULL DEFAULT 0,
  start_time TEXT,
  end_time   TEXT,
  note       TEXT,
  PRIMARY KEY (tenant_id, date),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS appointments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id     INTEGER NOT NULL DEFAULT 1,
  jid           TEXT,
  customer_name TEXT NOT NULL,
  title         TEXT NOT NULL,
  start_at      TEXT NOT NULL,
  end_at        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','completed','cancelled')),
  notes         TEXT,
  source        TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','ai')),
  created_by    INTEGER,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_appointments_start ON appointments (tenant_id, start_at, status);
CREATE INDEX IF NOT EXISTS idx_appointments_jid ON appointments (tenant_id, jid, start_at DESC);
CREATE TABLE IF NOT EXISTS external_requests (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id           INTEGER NOT NULL DEFAULT 1,
  source_jid          TEXT NOT NULL,
  target_jid          TEXT NOT NULL,
  request_message_id  INTEGER NOT NULL,
  request_text        TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined')),
  response_message_id INTEGER,
  response_text       TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_external_requests_target ON external_requests (tenant_id, target_jid, status, id);
CREATE INDEX IF NOT EXISTS idx_external_requests_source ON external_requests (tenant_id, source_jid, status, id DESC);
CREATE TABLE IF NOT EXISTS appointment_notifications (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id      INTEGER NOT NULL DEFAULT 1,
  appointment_id INTEGER NOT NULL,
  jid            TEXT NOT NULL,
  message        TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent')),
  last_error     TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_appointment_notifications_pending ON appointment_notifications (tenant_id, status, id);
CREATE TABLE IF NOT EXISTS api_usage (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id         INTEGER NOT NULL DEFAULT 1,
  provider          TEXT NOT NULL DEFAULT 'xai',
  model             TEXT NOT NULL,
  purpose           TEXT NOT NULL DEFAULT 'chat_reply',
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  cached_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens  INTEGER NOT NULL DEFAULT 0,
  total_tokens      INTEGER NOT NULL DEFAULT 0,
  cost_usd          REAL NOT NULL DEFAULT 0,
  estimated         INTEGER NOT NULL DEFAULT 0,
  response_id       TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_api_usage_created ON api_usage (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_usage_model ON api_usage (tenant_id, model, created_at DESC);
`)

// Multiempresa migration. Existing installations become tenant 1 without
// losing conversations, settings, appointments or the connected account.
db.prepare("INSERT OR IGNORE INTO tenants (id, name, slug) VALUES (1, 'Empresa principal', 'empresa-principal')").run()

function hasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((item) => item.name === column)
}

db.pragma('foreign_keys = OFF')
if (!hasColumn('settings', 'tenant_id')) {
  db.exec(`
    ALTER TABLE settings RENAME TO settings_legacy;
    CREATE TABLE settings (
      tenant_id INTEGER NOT NULL DEFAULT 1, key TEXT NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY (tenant_id, key), FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
    );
    INSERT INTO settings (tenant_id, key, value) SELECT 1, key, value FROM settings_legacy;
    DROP TABLE settings_legacy;
  `)
}
if (!hasColumn('contacts', 'tenant_id')) {
  db.exec(`
    ALTER TABLE contacts RENAME TO contacts_legacy;
    CREATE TABLE contacts (
      tenant_id INTEGER NOT NULL DEFAULT 1, jid TEXT NOT NULL, name TEXT, transport_jid TEXT,
      bot_paused INTEGER NOT NULL DEFAULT 0, last_message_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (tenant_id, jid),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
    );
    INSERT INTO contacts (tenant_id, jid, name, transport_jid, bot_paused, last_message_at, created_at)
      SELECT 1, jid, name, transport_jid, bot_paused, last_message_at, created_at FROM contacts_legacy;
    DROP TABLE contacts_legacy;
  `)
}
if (!hasColumn('contacts', 'whatsapp_name_raw')) {
  db.exec('ALTER TABLE contacts ADD COLUMN whatsapp_name_raw TEXT')
}
if (!hasColumn('contacts', 'synced_at')) {
  db.exec('ALTER TABLE contacts ADD COLUMN synced_at TEXT')
}
if (!hasColumn('contacts', 'last_read_message_id')) {
  db.exec('ALTER TABLE contacts ADD COLUMN last_read_message_id INTEGER NOT NULL DEFAULT 0')
  const messagesHaveTenant = hasColumn('messages', 'tenant_id')
  db.exec(messagesHaveTenant
    ? `UPDATE contacts SET last_read_message_id = COALESCE((
        SELECT MAX(m.id) FROM messages m
        WHERE m.tenant_id = contacts.tenant_id AND m.jid = contacts.jid
      ), 0)`
    : `UPDATE contacts SET last_read_message_id = COALESCE((
        SELECT MAX(m.id) FROM messages m WHERE m.jid = contacts.jid
      ), 0)`)
}
if (!hasColumn('contacts', 'service_status')) {
  db.exec("ALTER TABLE contacts ADD COLUMN service_status TEXT NOT NULL DEFAULT 'open'")
}
if (!hasColumn('contacts', 'assigned_user_id')) db.exec('ALTER TABLE contacts ADD COLUMN assigned_user_id INTEGER')
if (!hasColumn('contacts', 'current_cycle_id')) db.exec('ALTER TABLE contacts ADD COLUMN current_cycle_id INTEGER')
if (!hasColumn('contacts', 'last_unanswered_alert_message_id')) {
  db.exec('ALTER TABLE contacts ADD COLUMN last_unanswered_alert_message_id INTEGER')
}
if (!hasColumn('messages', 'external_id')) {
  db.exec('ALTER TABLE messages ADD COLUMN external_id TEXT')
}
if (!hasColumn('messages', 'external_timestamp')) {
  db.exec('ALTER TABLE messages ADD COLUMN external_timestamp TEXT')
}
if (!hasColumn('messages', 'edited_at')) db.exec('ALTER TABLE messages ADD COLUMN edited_at TEXT')
if (!hasColumn('messages', 'message_type')) db.exec("ALTER TABLE messages ADD COLUMN message_type TEXT NOT NULL DEFAULT 'text'")
if (!hasColumn('messages', 'mime_type')) db.exec('ALTER TABLE messages ADD COLUMN mime_type TEXT')
if (!hasColumn('messages', 'file_name')) db.exec('ALTER TABLE messages ADD COLUMN file_name TEXT')
if (!hasColumn('messages', 'media_path')) db.exec('ALTER TABLE messages ADD COLUMN media_path TEXT')
if (!hasColumn('messages', 'file_size')) db.exec('ALTER TABLE messages ADD COLUMN file_size INTEGER')
if (!hasColumn('messages', 'duration_seconds')) db.exec('ALTER TABLE messages ADD COLUMN duration_seconds INTEGER')
if (!hasColumn('messages', 'is_voice_note')) db.exec('ALTER TABLE messages ADD COLUMN is_voice_note INTEGER NOT NULL DEFAULT 0')
if (!hasColumn('messages', 'author_user_id')) db.exec('ALTER TABLE messages ADD COLUMN author_user_id INTEGER')
if (!hasColumn('messages', 'author_name')) db.exec('ALTER TABLE messages ADD COLUMN author_name TEXT')
if (!hasColumn('messages', 'cycle_id')) db.exec('ALTER TABLE messages ADD COLUMN cycle_id INTEGER')
if (!hasColumn('internal_messages', 'edited_at')) db.exec('ALTER TABLE internal_messages ADD COLUMN edited_at TEXT')
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_external_id ON messages (tenant_id, external_id) WHERE external_id IS NOT NULL')
if (!hasColumn('users', 'tenant_id') || db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get()?.sql.includes("'master'")) {
  db.exec(`
    ALTER TABLE users RENAME TO users_legacy;
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL DEFAULT 1,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'attendant' CHECK (role IN ('super_admin','admin','attendant')),
      active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
    );
    INSERT INTO users (id, tenant_id, username, display_name, password_hash, role, active, created_at, updated_at)
      SELECT id, 1, username, display_name, password_hash,
        CASE WHEN role = 'master' THEN 'super_admin' ELSE role END,
        active, created_at, updated_at FROM users_legacy;
    DROP TABLE users_legacy;
  `)
}
if (!hasColumn('weekly_availability', 'tenant_id')) {
  db.exec(`
    ALTER TABLE weekly_availability RENAME TO weekly_availability_legacy;
    CREATE TABLE weekly_availability (
      tenant_id INTEGER NOT NULL DEFAULT 1, weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
      enabled INTEGER NOT NULL DEFAULT 1, start_time TEXT NOT NULL DEFAULT '09:00',
      end_time TEXT NOT NULL DEFAULT '18:00', slot_minutes INTEGER NOT NULL DEFAULT 60,
      PRIMARY KEY (tenant_id, weekday), FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
    );
    INSERT INTO weekly_availability SELECT 1, weekday, enabled, start_time, end_time, slot_minutes FROM weekly_availability_legacy;
    DROP TABLE weekly_availability_legacy;
  `)
}
if (!hasColumn('calendar_exceptions', 'tenant_id')) {
  db.exec(`
    ALTER TABLE calendar_exceptions RENAME TO calendar_exceptions_legacy;
    CREATE TABLE calendar_exceptions (
      tenant_id INTEGER NOT NULL DEFAULT 1, date TEXT NOT NULL, is_open INTEGER NOT NULL DEFAULT 0,
      start_time TEXT, end_time TEXT, note TEXT, PRIMARY KEY (tenant_id, date),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
    );
    INSERT INTO calendar_exceptions SELECT 1, date, is_open, start_time, end_time, note FROM calendar_exceptions_legacy;
    DROP TABLE calendar_exceptions_legacy;
  `)
}
for (const table of ['messages', 'canned_responses', 'rules', 'knowledge', 'smart_notes', 'appointments', 'external_requests', 'appointment_notifications', 'api_usage']) {
  if (!hasColumn(table, 'tenant_id')) db.exec(`ALTER TABLE ${table} ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1`)
}
// SQLite rewrites inbound foreign keys when a referenced table is renamed.
// Repair installations migrated from the old `users` table so new calendar
// entries keep referencing the current multiempresa users table.
const appointmentsSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'appointments'").get()?.sql || ''
if (appointmentsSql.includes('users_legacy')) {
  db.exec(`
    ALTER TABLE appointments RENAME TO appointments_legacy;
    CREATE TABLE appointments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 1,
      jid TEXT,
      customer_name TEXT NOT NULL,
      title TEXT NOT NULL,
      start_at TEXT NOT NULL,
      end_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','completed','cancelled')),
      notes TEXT,
      source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','ai')),
      created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    );
    INSERT INTO appointments (
      id, tenant_id, jid, customer_name, title, start_at, end_at, status,
      notes, source, created_by, created_at, updated_at
    ) SELECT
      id, tenant_id, jid, customer_name, title, start_at, end_at, status,
      notes, source, created_by, created_at, updated_at
    FROM appointments_legacy;
    DROP TABLE appointments_legacy;
  `)
}
db.pragma('foreign_keys = ON')

db.exec(`
  DROP INDEX IF EXISTS idx_messages_jid;
  CREATE INDEX idx_messages_jid ON messages (tenant_id, jid, id);
  DROP INDEX IF EXISTS idx_smart_notes_status;
  CREATE INDEX idx_smart_notes_status ON smart_notes (tenant_id, status, updated_at DESC);
  DROP INDEX IF EXISTS idx_appointments_start;
  CREATE INDEX idx_appointments_start ON appointments (tenant_id, start_at, status);
  DROP INDEX IF EXISTS idx_appointments_jid;
  CREATE INDEX idx_appointments_jid ON appointments (tenant_id, jid, start_at DESC);
  DROP INDEX IF EXISTS idx_external_requests_target;
  CREATE INDEX idx_external_requests_target ON external_requests (tenant_id, target_jid, status, id);
  DROP INDEX IF EXISTS idx_external_requests_source;
  CREATE INDEX idx_external_requests_source ON external_requests (tenant_id, source_jid, status, id DESC);
  DROP INDEX IF EXISTS idx_appointment_notifications_pending;
  CREATE INDEX idx_appointment_notifications_pending ON appointment_notifications (tenant_id, status, id);
  DROP INDEX IF EXISTS idx_api_usage_created;
  CREATE INDEX idx_api_usage_created ON api_usage (tenant_id, created_at DESC);
  DROP INDEX IF EXISTS idx_api_usage_model;
  CREATE INDEX idx_api_usage_model ON api_usage (tenant_id, model, created_at DESC);
`)

const DEFAULT_WEEKLY_AVAILABILITY = [
  [0, 0, '09:00', '18:00', 60],
  [1, 1, '09:00', '18:00', 60],
  [2, 1, '09:00', '18:00', 60],
  [3, 1, '09:00', '18:00', 60],
  [4, 1, '09:00', '18:00', 60],
  [5, 1, '09:00', '18:00', 60],
  [6, 1, '09:00', '13:00', 60],
]
const seedAvailability = db.prepare(
  'INSERT OR IGNORE INTO weekly_availability (tenant_id, weekday, enabled, start_time, end_time, slot_minutes) VALUES (?, ?, ?, ?, ?, ?)'
)
export function seedTenantAvailability(tenantId = currentTenantId()) {
  for (const row of DEFAULT_WEEKLY_AVAILABILITY) seedAvailability.run(Number(tenantId), ...row)
}
seedTenantAvailability(1)

// Migration: keep the user-facing phone JID separate from the LID used by
// newer WhatsApp encryption sessions.
const contactColumns = db.prepare('PRAGMA table_info(contacts)').all()
if (!contactColumns.some((column) => column.name === 'transport_jid')) {
  db.exec('ALTER TABLE contacts ADD COLUMN transport_jid TEXT')
}
db.exec('UPDATE contacts SET transport_jid = jid WHERE transport_jid IS NULL')

// Migration: confidence score used by the internal AI to rank learned
// knowledge (reinforced or weakened by customer feedback).
const knowledgeColumns = db.prepare('PRAGMA table_info(knowledge)').all()
if (!knowledgeColumns.some((column) => column.name === 'confidence')) {
  db.exec('ALTER TABLE knowledge ADD COLUMN confidence REAL NOT NULL DEFAULT 0.8')
}

// Migration: previous versions used the Claude API — move stored model to Grok.
db.prepare("UPDATE settings SET value = 'grok-4.5' WHERE key = 'model' AND value LIKE 'claude%'").run()
const legacyApiKey = db.prepare("SELECT value FROM settings WHERE tenant_id = 1 AND key = 'xai_api_key'").get()?.value
if (legacyApiKey) db.prepare("INSERT OR IGNORE INTO global_settings (key, value) VALUES ('xai_api_key', ?)").run(legacyApiKey)
db.prepare("DELETE FROM settings WHERE key = 'xai_api_key'").run()

// ---------- settings ----------

const DEFAULT_SETTINGS = {
  bot_enabled: 'true',
  ai_enabled: 'true',
  learning_enabled: 'true',
  ai_provider: 'grok',
  internal_learning_autoapprove: 'false',
  xai_api_key: '',
  gemini_api_key: '',
  groq_api_key: '',
  mistral_api_key: '',
  openrouter_api_key: '',
  giphy_api_key: '',
  model: 'grok-4.5',
  max_history: '20',
  business_name: 'Minha Empresa',
  business_info: '',
  system_prompt: [
    'Você é o atendente virtual da empresa no WhatsApp.',
    '',
    'Regras de comportamento:',
    '- Seja educado, objetivo e amigável. Use mensagens curtas, adequadas ao WhatsApp.',
    '- Responda apenas sobre assuntos relacionados ao negócio e ao atendimento ao cliente.',
    '- Use as informações do negócio e a base de conhecimento fornecidas. NUNCA invente preços, prazos, endereços ou políticas.',
    '- Se não souber a resposta, diga que vai verificar com a equipe e peça para o cliente aguardar.',
    '- Se o cliente pedir para falar com uma pessoa, informe que vai encaminhar para um atendente humano.',
    '- Responda sempre no idioma em que o cliente escrever.',
  ].join('\n'),
  welcome_message: '',
  non_text_reply: 'Desculpe, no momento consigo responder apenas mensagens de texto. Pode escrever sua dúvida? 🙂',
  fallback_message: '',
  last_learn_at: '',
  api_monthly_budget_usd: '25',
  api_cost_alert_percent: '80',
  api_usd_brl_rate: '5.50',
  inactivity_timeout_minutes: '5',
  attendant_name_enabled: 'true',
  resolved_message: 'Atendimento concluído por {atendente}. Se precisar de algo mais, é só enviar uma nova mensagem.',
  transfer_message: 'Seu atendimento foi transferido de {atendente} para {novo_atendente}.',
  n8n_enabled: 'false',
  n8n_webhook_url: '',
}

// ---------- tenants / commercial accounts ----------

export function listTenants() {
  return db.prepare(`
    SELECT t.*,
      (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id AND u.active = 1) AS active_users,
      (SELECT COUNT(*) FROM contacts c WHERE c.tenant_id = t.id) AS contacts,
      (SELECT COUNT(*) FROM appointments a WHERE a.tenant_id = t.id AND a.status = 'scheduled') AS scheduled_appointments,
      (SELECT COALESCE(SUM(x.cost_usd), 0) FROM api_usage x WHERE x.tenant_id = t.id
        AND date(x.created_at, '-3 hours') >= date('now', '-3 hours', 'start of month')) AS month_cost_usd,
      (SELECT COALESCE(SUM(x.total_tokens), 0) FROM api_usage x WHERE x.tenant_id = t.id
        AND date(x.created_at, '-3 hours') >= date('now', '-3 hours', 'start of month')) AS month_tokens
    FROM tenants t ORDER BY t.active DESC, t.name
  `).all()
}

export function getTenant(id = currentTenantId()) {
  return db.prepare('SELECT * FROM tenants WHERE id = ?').get(Number(id))
}

export function createTenant({ name, slug }) {
  const info = db.prepare('INSERT INTO tenants (name, slug) VALUES (?, ?)').run(String(name).trim(), String(slug).trim())
  const tenantId = Number(info.lastInsertRowid)
  seedTenantAvailability(tenantId)
  db.prepare(`
    INSERT INTO rules (tenant_id, name, pattern, match_type, action, response, priority)
    VALUES (?, 'Pedir atendimento humano', 'atendente|humano|falar com alguém|falar com uma pessoa', 'regex', 'pause_bot',
      'Claro! Vou encaminhar você para um atendente. Aguarde um momento, por favor.', 100)
  `).run(tenantId)
  db.prepare(`
    INSERT INTO canned_responses (tenant_id, name, triggers, match_type, response, priority)
    VALUES (?, 'Saudação', 'bom dia, boa tarde, boa noite, olá, oi', 'exact',
      'Olá! Bem-vindo(a) ao nosso atendimento. Como posso ajudar você hoje?', 10)
  `).run(tenantId)
  return getTenant(info.lastInsertRowid)
}

export function updateTenant(id, { name, active }) {
  db.prepare("UPDATE tenants SET name = ?, active = ?, updated_at = datetime('now') WHERE id = ?")
    .run(String(name).trim(), active ? 1 : 0, Number(id))
  return getTenant(id)
}

const deleteTenantTransaction = db.transaction((tenantId) => {
  db.prepare(`
    DELETE FROM smart_note_messages
    WHERE note_id IN (SELECT id FROM smart_notes WHERE tenant_id = ?)
  `).run(tenantId)
  for (const table of [
    'history_imports',
    'internal_messages',
    'internal_notes',
    'conversation_cycles',
    'appointment_notifications',
    'external_requests',
    'api_usage',
    'appointments',
    'smart_notes',
    'knowledge',
    'rules',
    'canned_responses',
    'messages',
    'customers',
    'contacts',
    'calendar_exceptions',
    'weekly_availability',
    'settings',
    'users',
  ]) {
    db.prepare(`DELETE FROM ${table} WHERE tenant_id = ?`).run(tenantId)
  }
  return db.prepare('DELETE FROM tenants WHERE id = ?').run(tenantId).changes
})

export function deleteTenants(ids = []) {
  const unique = [...new Set(ids.map(Number).filter((id) => Number.isInteger(id) && id > 1))].slice(0, 100)
  let deleted = 0
  for (const id of unique) deleted += deleteTenantTransaction(id)
  return deleted
}

const getSettingStmt = db.prepare('SELECT value FROM settings WHERE tenant_id = ? AND key = ?')
const setSettingStmt = db.prepare(
  'INSERT INTO settings (tenant_id, key, value) VALUES (?, ?, ?) ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value'
)
const deleteSettingStmt = db.prepare('DELETE FROM settings WHERE tenant_id = ? AND key = ?')
const getGlobalSettingStmt = db.prepare('SELECT value FROM global_settings WHERE key = ?')
const setGlobalSettingStmt = db.prepare(
  'INSERT INTO global_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
)

const GLOBAL_SECRET_SETTINGS = new Set([
  'xai_api_key',
  'gemini_api_key',
  'groq_api_key',
  'mistral_api_key',
  'openrouter_api_key',
  'giphy_api_key',
])

export function getSetting(key) {
  if (GLOBAL_SECRET_SETTINGS.has(key)) return getGlobalSettingStmt.get(key)?.value || ''
  const row = getSettingStmt.get(currentTenantId(), key)
  return row ? row.value : (DEFAULT_SETTINGS[key] ?? null)
}

export function setSetting(key, value) {
  if (GLOBAL_SECRET_SETTINGS.has(key)) return setGlobalSettingStmt.run(key, String(value))
  setSettingStmt.run(currentTenantId(), key, String(value))
}

export function deleteSetting(key) {
  if (GLOBAL_SECRET_SETTINGS.has(key)) return setGlobalSettingStmt.run(key, '')
  return deleteSettingStmt.run(currentTenantId(), key)
}

export function findTenantByIntegrationKeyHash(hash) {
  if (!hash) return null
  return db.prepare(`
    SELECT t.*
    FROM settings s
    JOIN tenants t ON t.id = s.tenant_id
    WHERE s.key = 'integration_api_key_hash' AND s.value = ? AND t.active = 1
    LIMIT 1
  `).get(String(hash)) || null
}

export function getSettings() {
  const out = { ...DEFAULT_SETTINGS }
  for (const row of db.prepare('SELECT key, value FROM settings WHERE tenant_id = ?').all(currentTenantId())) out[row.key] = row.value
  for (const key of GLOBAL_SECRET_SETTINGS) out[key] = getSetting(key)
  return out
}

export function updateSettings(patch) {
  const tx = db.transaction((entries) => {
    for (const [k, v] of entries) {
      if (k in DEFAULT_SETTINGS) setSetting(k, String(v))
    }
  })
  tx(Object.entries(patch))
}

// ---------- contacts ----------

export function upsertContact(jid, name, transportJid = jid) {
  const tenantId = currentTenantId()
  const existing = db.prepare('SELECT jid FROM contacts WHERE tenant_id = ? AND jid = ?').get(tenantId, jid)
  if (existing) {
    db.prepare(
      "UPDATE contacts SET name = COALESCE(?, name), transport_jid = COALESCE(?, transport_jid, jid), last_message_at = datetime('now') WHERE tenant_id = ? AND jid = ?"
    ).run(name, transportJid, tenantId, jid)
    return false
  }
  db.prepare(
    "INSERT INTO contacts (tenant_id, jid, name, transport_jid, last_message_at) VALUES (?, ?, ?, ?, datetime('now'))"
  ).run(tenantId, jid, name, transportJid)
  return true // new contact
}

export function upsertSyncedContact(jid, {
  name,
  rawName = name,
  transportJid = jid,
  lastMessageAt = null,
} = {}) {
  const tenantId = currentTenantId()
  const timestamp = lastMessageAt || new Date().toISOString()
  db.prepare(`
    INSERT INTO contacts (
      tenant_id, jid, name, whatsapp_name_raw, transport_jid, last_message_at, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(tenant_id, jid) DO UPDATE SET
      name = CASE
        WHEN excluded.name IS NOT NULL AND trim(excluded.name) <> '' THEN excluded.name
        ELSE contacts.name
      END,
      whatsapp_name_raw = COALESCE(excluded.whatsapp_name_raw, contacts.whatsapp_name_raw),
      transport_jid = COALESCE(excluded.transport_jid, contacts.transport_jid, contacts.jid),
      last_message_at = CASE
        WHEN contacts.last_message_at IS NULL OR excluded.last_message_at > contacts.last_message_at
          THEN excluded.last_message_at
        ELSE contacts.last_message_at
      END,
      synced_at = datetime('now')
  `).run(tenantId, jid, name || null, rawName || null, transportJid || jid, timestamp)
  return getContact(jid)
}

export function getContact(jid) {
  return db.prepare('SELECT * FROM contacts WHERE tenant_id = ? AND jid = ?').get(currentTenantId(), jid)
}

export function listContacts() {
  return db.prepare(`
    SELECT c.*,
      u.display_name AS assigned_user_name,
      (
        SELECT COUNT(*) FROM messages m
        WHERE m.tenant_id = c.tenant_id
          AND m.jid = c.jid
          AND m.direction = 'in'
          AND m.id > COALESCE(c.last_read_message_id, 0)
      ) AS unread_count
    FROM contacts c
    LEFT JOIN users u ON u.id = c.assigned_user_id
    WHERE c.tenant_id = ?
    ORDER BY COALESCE(datetime(c.last_message_at), datetime(c.created_at)) DESC, c.jid ASC
  `).all(currentTenantId())
}

export function setContactPaused(jid, paused) {
  db.prepare('UPDATE contacts SET bot_paused = ? WHERE tenant_id = ? AND jid = ?').run(paused ? 1 : 0, currentTenantId(), jid)
}

export function ensureOpenConversationCycle(jid, openedBy = null) {
  const tenantId = currentTenantId()
  return db.transaction(() => {
    const contact = getContact(jid)
    if (!contact) return null
    if (contact.service_status === 'open' && contact.current_cycle_id) {
      return db.prepare('SELECT * FROM conversation_cycles WHERE tenant_id = ? AND id = ?')
        .get(tenantId, contact.current_cycle_id)
    }
    const info = db.prepare(`
      INSERT INTO conversation_cycles (tenant_id, jid, status, assigned_user_id, opened_by)
      VALUES (?, ?, 'open', ?, ?)
    `).run(tenantId, jid, contact.assigned_user_id || null, openedBy || null)
    db.prepare(`
      UPDATE contacts
      SET service_status = 'open', current_cycle_id = ?, last_unanswered_alert_message_id = NULL
      WHERE tenant_id = ? AND jid = ?
    `).run(info.lastInsertRowid, tenantId, jid)
    return db.prepare('SELECT * FROM conversation_cycles WHERE id = ?').get(info.lastInsertRowid)
  })()
}

export function getCurrentConversationCycle(jid) {
  const contact = getContact(jid)
  if (!contact?.current_cycle_id) return null
  return db.prepare('SELECT * FROM conversation_cycles WHERE tenant_id = ? AND id = ?')
    .get(currentTenantId(), contact.current_cycle_id)
}

export function resolveConversation(jid, userId) {
  const tenantId = currentTenantId()
  return db.transaction(() => {
    const contact = getContact(jid)
    if (!contact) return null
    const cycle = ensureOpenConversationCycle(jid, userId)
    db.prepare(`
      UPDATE conversation_cycles
      SET status = 'resolved', resolved_by = ?, resolved_at = datetime('now')
      WHERE tenant_id = ? AND id = ?
    `).run(userId || null, tenantId, cycle.id)
    db.prepare(`
      UPDATE contacts
      SET service_status = 'resolved', bot_paused = 0, last_unanswered_alert_message_id = NULL
      WHERE tenant_id = ? AND jid = ?
    `).run(tenantId, jid)
    return getContact(jid)
  })()
}

export function transferConversation(jid, assignedUserId) {
  const tenantId = currentTenantId()
  return db.transaction(() => {
    const target = getUserById(assignedUserId)
    if (!target || target.tenant_id !== tenantId || !target.active) return null
    const cycle = ensureOpenConversationCycle(jid, assignedUserId)
    db.prepare('UPDATE conversation_cycles SET assigned_user_id = ? WHERE tenant_id = ? AND id = ?')
      .run(target.id, tenantId, cycle.id)
    db.prepare(`
      UPDATE contacts
      SET assigned_user_id = ?, service_status = 'open', bot_paused = 1
      WHERE tenant_id = ? AND jid = ?
    `).run(target.id, tenantId, jid)
    return { contact: getContact(jid), assignee: target }
  })()
}

export function listUnansweredConversations(minutes = 5) {
  const threshold = Math.max(1, Math.min(1440, Number(minutes) || 5))
  return db.prepare(`
    SELECT c.tenant_id, c.jid, c.name, m.id AS message_id, m.created_at
    FROM contacts c
    JOIN messages m ON m.id = (
      SELECT incoming.id FROM messages incoming
      WHERE incoming.tenant_id = c.tenant_id AND incoming.jid = c.jid AND incoming.direction = 'in'
      ORDER BY incoming.id DESC LIMIT 1
    )
    JOIN tenants t ON t.id = c.tenant_id AND t.active = 1
    WHERE c.service_status = 'open'
      AND datetime(m.created_at) <= datetime('now', '-' || ? || ' minutes')
      AND COALESCE(c.last_unanswered_alert_message_id, 0) <> m.id
      AND NOT EXISTS (
        SELECT 1 FROM messages response
        WHERE response.tenant_id = c.tenant_id AND response.jid = c.jid
          AND response.direction = 'out' AND response.id > m.id
      )
  `).all(threshold)
}

export function markUnansweredAlert(jid, messageId, tenantId = currentTenantId()) {
  return db.prepare(`
    UPDATE contacts SET last_unanswered_alert_message_id = ?
    WHERE tenant_id = ? AND jid = ?
  `).run(Number(messageId), Number(tenantId), jid).changes > 0
}

/**
 * Returns paused contacts (per tenant) whose last_message_at is older than
 * that tenant's configured inactivity_timeout_minutes.
 * Only returns contacts for tenants where the timeout is enabled (> 0).
 */
export function listPausedInactiveContacts() {
  return db.prepare(`
    SELECT c.tenant_id, c.jid, c.last_message_at
    FROM contacts c
    JOIN (
      SELECT s.tenant_id,
             CAST(COALESCE(s.value, '5') AS INTEGER) AS timeout_minutes
      FROM settings s
      WHERE s.key = 'inactivity_timeout_minutes'
        AND CAST(s.value AS INTEGER) > 0
      UNION ALL
      SELECT t.id AS tenant_id, 5 AS timeout_minutes
      FROM tenants t
      WHERE t.active = 1
        AND NOT EXISTS (
          SELECT 1 FROM settings s2
          WHERE s2.tenant_id = t.id AND s2.key = 'inactivity_timeout_minutes'
        )
    ) cfg ON cfg.tenant_id = c.tenant_id
    WHERE c.bot_paused = 1
      AND c.last_message_at IS NOT NULL
      AND datetime(c.last_message_at) <= datetime('now', '-' || cfg.timeout_minutes || ' minutes')
  `).all()
}

export function markContactRead(jid) {
  const tenantId = currentTenantId()
  return db.prepare(`
    UPDATE contacts
    SET last_read_message_id = MAX(
      COALESCE(last_read_message_id, 0),
      COALESCE((
        SELECT MAX(m.id) FROM messages m
        WHERE m.tenant_id = ? AND m.jid = ? AND m.direction = 'in'
      ), 0)
    )
    WHERE tenant_id = ? AND jid = ?
  `).run(tenantId, jid, tenantId, jid).changes > 0
}

// ---------- users ----------

export function countUsers() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n
}

export function countActiveMasters() {
  return db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'super_admin' AND active = 1").get().n
}

export function listUsers() {
  return db.prepare('SELECT id, tenant_id, username, display_name, role, active, created_at, updated_at FROM users WHERE tenant_id = ? ORDER BY role DESC, display_name').all(currentTenantId())
}

export function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id)
}

export function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(String(username || '').trim())
}

export function createUser({ username, displayName, passwordHash, role = 'attendant', tenantId = currentTenantId() }) {
  const info = db.prepare(
    'INSERT INTO users (tenant_id, username, display_name, password_hash, role) VALUES (?, ?, ?, ?, ?)'
  ).run(Number(tenantId), String(username).trim(), String(displayName).trim(), passwordHash, role)
  return getUserById(info.lastInsertRowid)
}

export function updateUser(id, { username, displayName, role, active }) {
  db.prepare("UPDATE users SET username = ?, display_name = ?, role = ?, active = ?, updated_at = datetime('now') WHERE id = ?")
    .run(String(username).trim(), String(displayName).trim(), role, active ? 1 : 0, id)
  return getUserById(id)
}

export function updateUserPassword(id, passwordHash) {
  db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").run(passwordHash, id)
}

export function deleteUser(id) {
  return db.prepare('DELETE FROM users WHERE id = ?').run(id).changes > 0
}

// ---------- messages ----------

function publicMessage(row) {
  if (!row) return row
  const { media_path: mediaPath, ...message } = row
  return { ...message, has_media: Boolean(mediaPath) }
}

export function addMessage(jid, direction, text, source, {
  authorUserId = null,
  authorName = null,
  messageType = 'text',
  cycleId = null,
  externalId = null,
  externalTimestamp = null,
} = {}) {
  const tenantId = currentTenantId()
  const contact = getContact(jid)
  const effectiveCycleId = cycleId || contact?.current_cycle_id || null
  const info = db
    .prepare(`
      INSERT INTO messages (
        tenant_id, jid, direction, text, source, message_type,
        author_user_id, author_name, cycle_id, external_id, external_timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(tenantId, jid, direction, text, source, messageType, authorUserId, authorName, effectiveCycleId, externalId, externalTimestamp)
  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid)
  db.prepare('UPDATE contacts SET last_message_at = ? WHERE tenant_id = ? AND jid = ?')
    .run(message.created_at, tenantId, jid)
  return publicMessage(message)
}

export function addMediaMessage({
  jid,
  direction,
  text = '',
  source = 'user',
  messageType,
  mimeType,
  fileName,
  mediaPath,
  fileSize,
  durationSeconds = null,
  isVoiceNote = false,
  authorUserId = null,
  authorName = null,
  cycleId = null,
  externalId = null,
  createdAt = null,
}) {
  const tenantId = currentTenantId()
  const info = db.prepare(`
    INSERT INTO messages (
      tenant_id, jid, direction, text, source, message_type, mime_type,
      file_name, media_path, file_size, duration_seconds, is_voice_note,
      author_user_id, author_name, cycle_id, external_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
  `).run(
    tenantId, jid, direction, String(text || ''), source, messageType,
    mimeType || null, fileName || null, mediaPath || null, Number(fileSize) || null,
    Number(durationSeconds) || null, isVoiceNote ? 1 : 0,
    authorUserId || null, authorName || null, cycleId || getContact(jid)?.current_cycle_id || null,
    externalId || null, createdAt
  )
  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid)
  db.prepare('UPDATE contacts SET last_message_at = ? WHERE tenant_id = ? AND jid = ?')
    .run(message.created_at, tenantId, jid)
  return publicMessage(message)
}

export function getMessageMedia(id) {
  return db.prepare(`
    SELECT id, tenant_id, media_path, mime_type, file_name, file_size
    FROM messages WHERE tenant_id = ? AND id = ?
  `).get(currentTenantId(), Number(id))
}

export function getMessageByExternalId(externalId) {
  if (!externalId) return null
  return publicMessage(db.prepare(`
    SELECT * FROM messages WHERE tenant_id = ? AND external_id = ?
  `).get(currentTenantId(), String(externalId)))
}

export function addHistoricalMessage({
  jid,
  direction,
  text,
  source = 'whatsapp_history',
  externalId,
  createdAt,
}) {
  if (!externalId) return { inserted: false, row: null }
  const timestamp = createdAt || new Date().toISOString()
  const result = db.prepare(`
    INSERT OR IGNORE INTO messages (
      tenant_id, jid, direction, text, source, external_id, external_timestamp, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(currentTenantId(), jid, direction, text, source, externalId, timestamp, timestamp)
  const row = result.changes
    ? db.prepare('SELECT * FROM messages WHERE id = ?').get(result.lastInsertRowid)
    : db.prepare('SELECT * FROM messages WHERE tenant_id = ? AND external_id = ?').get(currentTenantId(), externalId)
  if (result.changes) {
    db.prepare(`
      UPDATE contacts SET last_message_at = CASE
        WHEN last_message_at IS NULL OR datetime(last_message_at) < datetime(?) THEN ?
        ELSE last_message_at
      END
      WHERE tenant_id = ? AND jid = ?
    `).run(timestamp, timestamp, currentTenantId(), jid)
  }
  return { inserted: Boolean(result.changes), row }
}

export function getMessages(jid, limit = 100) {
  return db
    .prepare('SELECT * FROM messages WHERE tenant_id = ? AND jid = ? ORDER BY id DESC LIMIT ?')
    .all(currentTenantId(), jid, limit)
    .reverse()
    .map(publicMessage)
}

export function updateMessageText(id, text) {
  return db.prepare("UPDATE messages SET text = ?, edited_at = datetime('now') WHERE tenant_id = ? AND id = ?")
    .run(String(text), currentTenantId(), Number(id))
}

export function getMessageForAction(id) {
  return db.prepare('SELECT * FROM messages WHERE tenant_id = ? AND id = ?').get(currentTenantId(), Number(id))
}

export function deleteMessageRecord(id) {
  return db.prepare('DELETE FROM messages WHERE tenant_id = ? AND id = ?').run(currentTenantId(), Number(id))
}

export function setMessageCycle(id, cycleId) {
  return db.prepare('UPDATE messages SET cycle_id = ? WHERE tenant_id = ? AND id = ?')
    .run(Number(cycleId) || null, currentTenantId(), Number(id))
}

export function getMessagesSince(isoDate) {
  return db
    .prepare('SELECT * FROM messages WHERE tenant_id = ? AND created_at > ? ORDER BY jid, id')
    .all(currentTenantId(), isoDate)
}

// ---------- shared internal notes ----------

export function listInternalNotes(jid) {
  return db.prepare(`
    SELECT n.* FROM internal_notes n
    WHERE n.tenant_id = ? AND n.jid = ?
    ORDER BY n.id DESC
  `).all(currentTenantId(), jid)
}

export function createInternalNote({ jid, text, authorId, authorName }) {
  const info = db.prepare(`
    INSERT INTO internal_notes (tenant_id, jid, author_id, author_name, text)
    VALUES (?, ?, ?, ?, ?)
  `).run(currentTenantId(), jid, authorId || null, String(authorName || 'Atendente'), String(text || '').trim())
  return db.prepare('SELECT * FROM internal_notes WHERE id = ?').get(info.lastInsertRowid)
}

export function deleteInternalNote(id, user) {
  const note = db.prepare('SELECT * FROM internal_notes WHERE tenant_id = ? AND id = ?')
    .get(currentTenantId(), Number(id))
  if (!note) return { deleted: false, forbidden: false }
  const manager = ['super_admin', 'admin'].includes(user?.role)
  if (!manager && Number(note.author_id) !== Number(user?.id)) return { deleted: false, forbidden: true }
  db.prepare('DELETE FROM internal_notes WHERE tenant_id = ? AND id = ?').run(currentTenantId(), Number(id))
  return { deleted: true, forbidden: false }
}

// ---------- internal team chat ----------

function publicInternalMessage(row) {
  if (!row) return row
  const { media_path: mediaPath, ...message } = row
  return { ...message, has_media: Boolean(mediaPath) }
}

export function listInternalContacts(currentUserId) {
  const tenantId = currentTenantId()
  return db.prepare(`
    SELECT u.id, u.display_name, u.role, u.active,
      (
        SELECT MAX(im.created_at) FROM internal_messages im
        WHERE im.tenant_id = u.tenant_id
          AND ((im.sender_id = ? AND im.recipient_id = u.id)
            OR (im.sender_id = u.id AND im.recipient_id = ?))
      ) AS last_message_at
    FROM users u
    WHERE u.tenant_id = ? AND u.active = 1 AND u.id <> ?
    ORDER BY last_message_at DESC, u.display_name COLLATE NOCASE
  `).all(currentUserId, currentUserId, tenantId, currentUserId)
}

export function listInternalMessages(currentUserId, otherUserId, limit = 300) {
  return db.prepare(`
    SELECT * FROM internal_messages
    WHERE tenant_id = ?
      AND ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))
    ORDER BY id DESC LIMIT ?
  `).all(
    currentTenantId(), currentUserId, otherUserId, otherUserId, currentUserId,
    Math.max(1, Math.min(500, Number(limit) || 300))
  ).reverse().map(publicInternalMessage)
}

export function createInternalMessage({
  senderId,
  senderName,
  recipientId,
  text = '',
  messageType = 'text',
  mimeType = null,
  fileName = null,
  mediaPath = null,
  fileSize = null,
  durationSeconds = null,
  isVoiceNote = false,
}) {
  const tenantId = currentTenantId()
  const recipient = getUserById(recipientId)
  if (!recipient || recipient.tenant_id !== tenantId || !recipient.active || recipient.id === senderId) return null
  const info = db.prepare(`
    INSERT INTO internal_messages (
      tenant_id, sender_id, sender_name, recipient_id, text, message_type,
      mime_type, file_name, media_path, file_size, duration_seconds, is_voice_note
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    tenantId, senderId, String(senderName || 'Atendente'), recipient.id, String(text || ''),
    messageType, mimeType, fileName, mediaPath, fileSize, durationSeconds, isVoiceNote ? 1 : 0
  )
  return publicInternalMessage(db.prepare('SELECT * FROM internal_messages WHERE id = ?').get(info.lastInsertRowid))
}

export function getInternalMessageMedia(id, currentUserId) {
  return db.prepare(`
    SELECT id, tenant_id, media_path, mime_type, file_name, file_size
    FROM internal_messages
    WHERE tenant_id = ? AND id = ? AND (sender_id = ? OR recipient_id = ?)
  `).get(currentTenantId(), Number(id), currentUserId, currentUserId)
}

const INTERNAL_MESSAGE_ACTION_WINDOW_SECONDS = 15 * 60

// Só o próprio remetente pode apagar, e só dentro da janela de 1 minuto — a
// checagem de "recente" é feita pelo próprio SQLite (datetime('now', ...))
// para não depender de conversão de fuso horário em JS.
export function deleteOwnInternalMessage(id, senderId) {
  const tenantId = currentTenantId()
  const message = db.prepare('SELECT * FROM internal_messages WHERE tenant_id = ? AND id = ?').get(tenantId, Number(id))
  if (!message) return { ok: false, reason: 'not_found' }
  if (Number(message.sender_id) !== Number(senderId)) return { ok: false, reason: 'forbidden' }
  const fresh = db.prepare(
    `SELECT 1 FROM internal_messages WHERE id = ? AND created_at >= datetime('now', '-${INTERNAL_MESSAGE_ACTION_WINDOW_SECONDS} seconds')`
  ).get(Number(id))
  if (!fresh) return { ok: false, reason: 'expired' }
  db.prepare('DELETE FROM internal_messages WHERE id = ?').run(Number(id))
  return { ok: true, message }
}

export function updateOwnInternalMessage(id, senderId, text) {
  const tenantId = currentTenantId()
  const message = db.prepare('SELECT * FROM internal_messages WHERE tenant_id = ? AND id = ?').get(tenantId, Number(id))
  if (!message) return { ok: false, reason: 'not_found' }
  if (Number(message.sender_id) !== Number(senderId)) return { ok: false, reason: 'forbidden' }
  if (message.message_type !== 'text') return { ok: false, reason: 'unsupported' }
  const fresh = db.prepare(
    `SELECT 1 FROM internal_messages WHERE id = ? AND created_at >= datetime('now', '-${INTERNAL_MESSAGE_ACTION_WINDOW_SECONDS} seconds')`
  ).get(Number(id))
  if (!fresh) return { ok: false, reason: 'expired' }
  db.prepare("UPDATE internal_messages SET text = ?, edited_at = datetime('now') WHERE tenant_id = ? AND id = ?")
    .run(String(text), tenantId, Number(id))
  return { ok: true, message: publicInternalMessage(db.prepare('SELECT * FROM internal_messages WHERE id = ?').get(Number(id))) }
}

export function recordHistoryImport({ jid, importedBy, fileName, messagesImported }) {
  const info = db.prepare(`
    INSERT INTO history_imports (tenant_id, jid, imported_by, file_name, messages_imported)
    VALUES (?, ?, ?, ?, ?)
  `).run(currentTenantId(), jid, importedBy || null, String(fileName || 'conversa.txt'), Number(messagesImported) || 0)
  return db.prepare('SELECT * FROM history_imports WHERE id = ?').get(info.lastInsertRowid)
}

// ---------- external approvals / handoffs ----------

export function createExternalRequest({ sourceJid, targetJid, requestMessageId, requestText }) {
  const info = db.prepare(`
    INSERT INTO external_requests (tenant_id, source_jid, target_jid, request_message_id, request_text)
    VALUES (?, ?, ?, ?, ?)
  `).run(currentTenantId(), sourceJid, targetJid, Number(requestMessageId), String(requestText || '').trim())
  return db.prepare('SELECT * FROM external_requests WHERE id = ?').get(info.lastInsertRowid)
}

export function findRecentPendingExternalRequest(sourceJid, targetJid, withinMinutes = 60) {
  return db.prepare(`
    SELECT * FROM external_requests
    WHERE tenant_id = ? AND source_jid = ? AND target_jid = ? AND status = 'pending'
      AND created_at >= datetime('now', ?)
    ORDER BY id DESC LIMIT 1
  `).get(currentTenantId(), sourceJid, targetJid, `-${withinMinutes} minutes`)
}

export function findPendingExternalRequestByTarget(targetJid) {
  return db.prepare(`
    SELECT * FROM external_requests
    WHERE tenant_id = ? AND target_jid = ? AND status = 'pending'
    ORDER BY id ASC LIMIT 1
  `).get(currentTenantId(), targetJid)
}

export function listPendingExternalRequests() {
  return db.prepare("SELECT * FROM external_requests WHERE tenant_id = ? AND status = 'pending' ORDER BY id ASC").all(currentTenantId())
}

export function listExternalResponses(request, limit = 20) {
  return db.prepare(`
    SELECT * FROM messages
    WHERE tenant_id = ? AND jid = ? AND direction = 'in' AND id > ?
    ORDER BY id ASC LIMIT ?
  `).all(currentTenantId(), request.target_jid, Number(request.request_message_id), Number(limit))
}

export function resolveExternalRequest(id, status, responseMessageId, responseText) {
  db.prepare(`
    UPDATE external_requests
    SET status = ?, response_message_id = ?, response_text = ?, resolved_at = datetime('now')
    WHERE tenant_id = ? AND id = ? AND status = 'pending'
  `).run(status, Number(responseMessageId) || null, String(responseText || '').trim(), currentTenantId(), Number(id))
  return db.prepare('SELECT * FROM external_requests WHERE tenant_id = ? AND id = ?').get(currentTenantId(), Number(id))
}

export function completeAiPendingNotes(jid, resolutionText) {
  db.prepare(`
    UPDATE smart_notes
    SET content = content || '\n• ' || ?, status = 'done', updated_at = datetime('now')
    WHERE tenant_id = ? AND jid = ? AND category = 'ai_pending' AND status = 'open'
  `).run(String(resolutionText || '').trim(), currentTenantId(), jid)
}

export function enqueueAppointmentNotification({ appointmentId, jid, message, error = '' }) {
  const info = db.prepare(`
    INSERT INTO appointment_notifications (tenant_id, appointment_id, jid, message, last_error)
    VALUES (?, ?, ?, ?, ?)
  `).run(currentTenantId(), Number(appointmentId), jid, String(message || '').trim(), String(error || '').trim() || null)
  return db.prepare('SELECT * FROM appointment_notifications WHERE id = ?').get(info.lastInsertRowid)
}

export function listPendingAppointmentNotifications(limit = 50) {
  return db.prepare(`
    SELECT * FROM appointment_notifications
    WHERE tenant_id = ? AND status = 'pending'
    ORDER BY id ASC LIMIT ?
  `).all(currentTenantId(), Number(limit))
}

export function markAppointmentNotificationSent(id) {
  db.prepare(`
    UPDATE appointment_notifications
    SET status = 'sent', sent_at = datetime('now'), last_error = NULL
    WHERE tenant_id = ? AND id = ?
  `).run(currentTenantId(), Number(id))
}

export function markAppointmentNotificationError(id, error) {
  db.prepare('UPDATE appointment_notifications SET last_error = ? WHERE tenant_id = ? AND id = ?')
    .run(String(error || '').trim(), currentTenantId(), Number(id))
}

// ---------- smart notes ----------

export function listSmartNotes(status = null) {
  const base = `
    SELECT n.*, c.name
    FROM smart_notes n
    LEFT JOIN contacts c ON c.tenant_id = n.tenant_id AND c.jid = n.jid
  `
  if (status) {
    return db.prepare(`${base} WHERE n.tenant_id = ? AND n.status = ? ORDER BY n.updated_at DESC, n.id DESC`).all(currentTenantId(), status)
  }
  return db.prepare(`${base} WHERE n.tenant_id = ? ORDER BY n.status = 'done', n.updated_at DESC, n.id DESC`).all(currentTenantId())
}

export function findOpenSmartNote(jid, category, withinMinutes = 120) {
  return db.prepare(`
    SELECT * FROM smart_notes
    WHERE tenant_id = ? AND jid = ? AND category = ? AND status = 'open'
      AND updated_at >= datetime('now', ?)
    ORDER BY updated_at DESC, id DESC LIMIT 1
  `).get(currentTenantId(), jid, category, `-${withinMinutes} minutes`)
}

export function findRecentOpenSmartNote(jid, withinMinutes = 30) {
  return db.prepare(`
    SELECT * FROM smart_notes
    WHERE tenant_id = ? AND jid = ? AND status = 'open'
      AND category <> 'ai_pending'
      AND updated_at >= datetime('now', ?)
    ORDER BY updated_at DESC, id DESC LIMIT 1
  `).get(currentTenantId(), jid, `-${withinMinutes} minutes`)
}

export function createSmartNote({ jid, category, title, content, messageId }) {
  return db.transaction(() => {
    if (messageId && db.prepare('SELECT 1 FROM smart_note_messages WHERE message_id = ?').get(messageId)) return null
    const info = db.prepare(
      'INSERT INTO smart_notes (tenant_id, jid, category, title, content) VALUES (?, ?, ?, ?, ?)'
    ).run(currentTenantId(), jid, category, title, content)
    if (messageId) {
      db.prepare('INSERT INTO smart_note_messages (note_id, message_id) VALUES (?, ?)').run(info.lastInsertRowid, messageId)
    }
    return db.prepare('SELECT * FROM smart_notes WHERE id = ?').get(info.lastInsertRowid)
  })()
}

export function appendSmartNote(noteId, messageId, text) {
  return db.transaction(() => {
    if (messageId && db.prepare('SELECT 1 FROM smart_note_messages WHERE message_id = ?').get(messageId)) return null
    const note = db.prepare('SELECT * FROM smart_notes WHERE tenant_id = ? AND id = ?').get(currentTenantId(), noteId)
    if (!note) return null
    if (!note.content.includes(text)) {
      db.prepare("UPDATE smart_notes SET content = content || '\n• ' || ?, updated_at = datetime('now') WHERE tenant_id = ? AND id = ?")
        .run(text, currentTenantId(), noteId)
    } else {
      db.prepare("UPDATE smart_notes SET updated_at = datetime('now') WHERE tenant_id = ? AND id = ?").run(currentTenantId(), noteId)
    }
    if (messageId) {
      db.prepare('INSERT INTO smart_note_messages (note_id, message_id) VALUES (?, ?)').run(noteId, messageId)
    }
    return db.prepare('SELECT * FROM smart_notes WHERE id = ?').get(noteId)
  })()
}

export function setSmartNoteStatus(id, status) {
  db.prepare("UPDATE smart_notes SET status = ?, updated_at = datetime('now') WHERE tenant_id = ? AND id = ?").run(status, currentTenantId(), id)
  return db.prepare('SELECT * FROM smart_notes WHERE tenant_id = ? AND id = ?').get(currentTenantId(), id)
}

export function deleteSmartNote(id) {
  db.transaction(() => {
    db.prepare('DELETE FROM smart_note_messages WHERE note_id = ?').run(id)
    db.prepare('DELETE FROM smart_notes WHERE tenant_id = ? AND id = ?').run(currentTenantId(), id)
  })()
}

// ---------- calendar ----------

export function listWeeklyAvailability() {
  seedTenantAvailability()
  return db.prepare('SELECT * FROM weekly_availability WHERE tenant_id = ? ORDER BY weekday').all(currentTenantId())
}

export function updateWeeklyAvailability(weekday, { enabled, startTime, endTime, slotMinutes }) {
  db.prepare(`
    UPDATE weekly_availability
    SET enabled = ?, start_time = ?, end_time = ?, slot_minutes = ?
    WHERE tenant_id = ? AND weekday = ?
  `).run(enabled ? 1 : 0, startTime, endTime, slotMinutes, currentTenantId(), weekday)
  return db.prepare('SELECT * FROM weekly_availability WHERE tenant_id = ? AND weekday = ?').get(currentTenantId(), weekday)
}

export function listCalendarExceptions(from = '0000-01-01', to = '9999-12-31') {
  return db.prepare('SELECT * FROM calendar_exceptions WHERE tenant_id = ? AND date BETWEEN ? AND ? ORDER BY date').all(currentTenantId(), from, to)
}

export function getCalendarException(date) {
  return db.prepare('SELECT * FROM calendar_exceptions WHERE tenant_id = ? AND date = ?').get(currentTenantId(), date)
}

export function upsertCalendarException({ date, isOpen, startTime = null, endTime = null, note = '' }) {
  db.prepare(`
    INSERT INTO calendar_exceptions (tenant_id, date, is_open, start_time, end_time, note)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id, date) DO UPDATE SET
      is_open = excluded.is_open,
      start_time = excluded.start_time,
      end_time = excluded.end_time,
      note = excluded.note
  `).run(currentTenantId(), date, isOpen ? 1 : 0, startTime, endTime, note)
  return getCalendarException(date)
}

export function deleteCalendarException(date) {
  return db.prepare('DELETE FROM calendar_exceptions WHERE tenant_id = ? AND date = ?').run(currentTenantId(), date).changes > 0
}

export function listAppointments(from, to) {
  return db.prepare(`
    SELECT a.*, u.display_name AS created_by_name
    FROM appointments a LEFT JOIN users u ON u.id = a.created_by
    WHERE a.tenant_id = ? AND a.start_at >= ? AND a.start_at < ?
    ORDER BY a.start_at, a.id
  `).all(currentTenantId(), from, to)
}

export function listContactAppointments(jid) {
  return db.prepare(`
    SELECT * FROM appointments
    WHERE tenant_id = ? AND jid = ? AND status = 'scheduled'
    ORDER BY start_at
  `).all(currentTenantId(), jid)
}

export function getAppointment(id) {
  return db.prepare('SELECT * FROM appointments WHERE tenant_id = ? AND id = ?').get(currentTenantId(), id)
}

export function hasAppointmentConflict(startAt, endAt, excludeId = 0, capacity = 1) {
  const limit = Math.max(1, Math.min(50, Number(capacity) || 1))
  const overlaps = db.prepare(`
    SELECT start_at, end_at FROM appointments
    WHERE tenant_id = ? AND status = 'scheduled' AND id <> ?
      AND start_at < ? AND end_at > ?
  `).all(currentTenantId(), Number(excludeId) || 0, endAt, startAt)
  if (overlaps.length < limit) return false

  const points = new Set([startAt])
  for (const appointment of overlaps) {
    if (appointment.start_at > startAt && appointment.start_at < endAt) points.add(appointment.start_at)
  }
  return [...points].some((point) => overlaps.filter(
    (appointment) => appointment.start_at <= point && appointment.end_at > point
  ).length >= limit)
}

export function insertAppointment({ jid = null, customerName, title, startAt, endAt, notes = '', source = 'manual', createdBy = null }) {
  const info = db.prepare(`
    INSERT INTO appointments (tenant_id, jid, customer_name, title, start_at, end_at, notes, source, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(currentTenantId(), jid, customerName, title, startAt, endAt, notes, source, createdBy)
  return getAppointment(info.lastInsertRowid)
}

export function updateAppointmentRecord(id, { jid, customerName, title, startAt, endAt, status, notes }) {
  db.prepare(`
    UPDATE appointments SET
      jid = ?, customer_name = ?, title = ?, start_at = ?, end_at = ?,
      status = ?, notes = ?, updated_at = datetime('now')
    WHERE tenant_id = ? AND id = ?
  `).run(jid || null, customerName, title, startAt, endAt, status, notes || '', currentTenantId(), id)
  return getAppointment(id)
}

export function deleteAppointmentRecord(id) {
  return db.prepare('DELETE FROM appointments WHERE tenant_id = ? AND id = ?').run(currentTenantId(), id).changes > 0
}

// ---------- canned responses ----------

export function listCanned() {
  return db.prepare('SELECT * FROM canned_responses WHERE tenant_id = ? ORDER BY priority DESC, id').all(currentTenantId())
}
export function createCanned({ name, triggers, match_type = 'contains', response, enabled = 1, priority = 0 }) {
  db.prepare(
    'INSERT INTO canned_responses (tenant_id, name, triggers, match_type, response, enabled, priority) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(currentTenantId(), name, triggers, match_type, response, enabled ? 1 : 0, priority)
}
export function updateCanned(id, { name, triggers, match_type, response, enabled, priority }) {
  db.prepare(
    'UPDATE canned_responses SET name=?, triggers=?, match_type=?, response=?, enabled=?, priority=? WHERE tenant_id=? AND id=?'
  ).run(name, triggers, match_type, response, enabled ? 1 : 0, priority, currentTenantId(), id)
}
export function deleteCanned(id) {
  db.prepare('DELETE FROM canned_responses WHERE tenant_id=? AND id=?').run(currentTenantId(), id)
}

// ---------- rules ----------

export function listRules() {
  return db.prepare('SELECT * FROM rules WHERE tenant_id = ? ORDER BY priority DESC, id').all(currentTenantId())
}
export function createRule({ name, pattern, match_type = 'contains', action = 'reply', response = null, enabled = 1, priority = 0 }) {
  db.prepare(
    'INSERT INTO rules (tenant_id, name, pattern, match_type, action, response, enabled, priority) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(currentTenantId(), name, pattern, match_type, action, response, enabled ? 1 : 0, priority)
}
export function updateRule(id, { name, pattern, match_type, action, response, enabled, priority }) {
  db.prepare(
    'UPDATE rules SET name=?, pattern=?, match_type=?, action=?, response=?, enabled=?, priority=? WHERE tenant_id=? AND id=?'
  ).run(name, pattern, match_type, action, response, enabled ? 1 : 0, priority, currentTenantId(), id)
}
export function deleteRule(id) {
  db.prepare('DELETE FROM rules WHERE tenant_id=? AND id=?').run(currentTenantId(), id)
}

// ---------- knowledge ----------

export function listKnowledge(status = null) {
  if (status) return db.prepare('SELECT * FROM knowledge WHERE tenant_id = ? AND status = ? ORDER BY id DESC').all(currentTenantId(), status)
  return db.prepare('SELECT * FROM knowledge WHERE tenant_id = ? ORDER BY id DESC').all(currentTenantId())
}
export function createKnowledge({ question, answer, source = 'manual', status = 'approved' }) {
  db.prepare('INSERT INTO knowledge (tenant_id, question, answer, source, status) VALUES (?, ?, ?, ?, ?)').run(
    currentTenantId(), question, answer, source, status
  )
}
export function updateKnowledge(id, { question, answer }) {
  db.prepare('UPDATE knowledge SET question=?, answer=? WHERE tenant_id=? AND id=?').run(question, answer, currentTenantId(), id)
}
export function setKnowledgeStatus(id, status) {
  db.prepare('UPDATE knowledge SET status=? WHERE tenant_id=? AND id=?').run(status, currentTenantId(), id)
}
export function deleteKnowledge(id) {
  db.prepare('DELETE FROM knowledge WHERE tenant_id=? AND id=?').run(currentTenantId(), id)
}
export function bumpKnowledgeUsage(ids) {
  const stmt = db.prepare('UPDATE knowledge SET usage_count = usage_count + 1 WHERE tenant_id = ? AND id = ?')
  for (const id of ids) stmt.run(currentTenantId(), id)
}
export function adjustKnowledgeConfidence(id, delta) {
  db.prepare('UPDATE knowledge SET confidence = MIN(1, MAX(0.1, confidence + ?)) WHERE tenant_id = ? AND id = ?')
    .run(Number(delta), currentTenantId(), Number(id))
}
export function approvedKnowledge() {
  return db.prepare("SELECT * FROM knowledge WHERE tenant_id = ? AND status = 'approved'").all(currentTenantId())
}

// ---------- API usage and cost control ----------

const insertApiUsage = db.prepare(`
  INSERT INTO api_usage (
    tenant_id, provider, model, purpose, prompt_tokens, cached_tokens,
    completion_tokens, reasoning_tokens, total_tokens,
    cost_usd, estimated, response_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)

export function recordApiUsage({
  provider = 'xai', model, purpose = 'chat_reply', promptTokens = 0,
  cachedTokens = 0, completionTokens = 0, reasoningTokens = 0,
  totalTokens = 0, costUsd = 0, estimated = false, responseId = null,
}) {
  return insertApiUsage.run(
    currentTenantId(), provider, String(model || 'desconhecido'), String(purpose || 'chat_reply'),
    Math.max(0, Number(promptTokens) || 0), Math.max(0, Number(cachedTokens) || 0),
    Math.max(0, Number(completionTokens) || 0), Math.max(0, Number(reasoningTokens) || 0),
    Math.max(0, Number(totalTokens) || 0), Math.max(0, Number(costUsd) || 0),
    estimated ? 1 : 0, responseId ? String(responseId) : null
  ).lastInsertRowid
}

const USAGE_DATE_WHERE = "tenant_id = ? AND date(created_at, '-3 hours') BETWEEN date(?) AND date(?)"

export function getApiUsageReport(from, to) {
  const params = [currentTenantId(), from, to]
  const summary = db.prepare(`
    SELECT
      COUNT(*) AS calls,
      COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
      COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
      COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
      COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
      COALESCE(SUM(total_tokens), 0) AS total_tokens,
      COALESCE(SUM(cost_usd), 0) AS cost_usd,
      COALESCE(SUM(CASE WHEN estimated = 1 THEN cost_usd ELSE 0 END), 0) AS estimated_cost_usd,
      COALESCE(SUM(CASE WHEN estimated = 0 THEN cost_usd ELSE 0 END), 0) AS actual_cost_usd
    FROM api_usage WHERE ${USAGE_DATE_WHERE}
  `).get(...params)

  const daily = db.prepare(`
    SELECT date(created_at, '-3 hours') AS date, COUNT(*) AS calls,
      SUM(prompt_tokens) AS prompt_tokens, SUM(completion_tokens) AS completion_tokens,
      SUM(total_tokens) AS total_tokens, SUM(cost_usd) AS cost_usd
    FROM api_usage WHERE ${USAGE_DATE_WHERE}
    GROUP BY date(created_at, '-3 hours') ORDER BY date
  `).all(...params)

  const models = db.prepare(`
    SELECT model, COUNT(*) AS calls, SUM(prompt_tokens) AS prompt_tokens,
      SUM(completion_tokens) AS completion_tokens, SUM(total_tokens) AS total_tokens,
      SUM(cost_usd) AS cost_usd
    FROM api_usage WHERE ${USAGE_DATE_WHERE}
    GROUP BY model ORDER BY cost_usd DESC, total_tokens DESC
  `).all(...params)

  const purposes = db.prepare(`
    SELECT purpose, COUNT(*) AS calls, SUM(total_tokens) AS total_tokens, SUM(cost_usd) AS cost_usd
    FROM api_usage WHERE ${USAGE_DATE_WHERE}
    GROUP BY purpose ORDER BY cost_usd DESC, total_tokens DESC
  `).all(...params)

  const recent = db.prepare(`
    SELECT id, model, purpose, prompt_tokens, cached_tokens, completion_tokens,
      reasoning_tokens, total_tokens, cost_usd, estimated, created_at
    FROM api_usage WHERE ${USAGE_DATE_WHERE}
    ORDER BY id DESC LIMIT 100
  `).all(...params)

  const month = db.prepare(`
    SELECT COUNT(*) AS calls, COALESCE(SUM(total_tokens), 0) AS total_tokens,
      COALESCE(SUM(cost_usd), 0) AS cost_usd
    FROM api_usage
    WHERE tenant_id = ?
      AND date(created_at, '-3 hours') >= date('now', '-3 hours', 'start of month')
      AND date(created_at, '-3 hours') <= date('now', '-3 hours')
  `).get(currentTenantId())

  return { summary, daily, models, purposes, recent, month }
}

// ---------- seed examples on first run ----------

if (db.prepare('SELECT COUNT(*) AS n FROM rules WHERE tenant_id = ?').get(currentTenantId()).n === 0) {
  createRule({
    name: 'Pedir atendimento humano',
    pattern: 'atendente|humano|falar com alguém|falar com uma pessoa',
    match_type: 'regex',
    action: 'pause_bot',
    response: 'Claro! Vou te encaminhar para um dos nossos atendentes. Aguarde um momento, por favor. 🙋',
    priority: 100,
  })
}
if (db.prepare('SELECT COUNT(*) AS n FROM canned_responses WHERE tenant_id = ?').get(currentTenantId()).n === 0) {
  createCanned({
    name: 'Saudação',
    triggers: 'bom dia, boa tarde, boa noite, olá, oi',
    match_type: 'exact',
    response: 'Olá! 👋 Bem-vindo(a) ao nosso atendimento. Como posso ajudar você hoje?',
    priority: 10,
  })
}
