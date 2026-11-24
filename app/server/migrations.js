const registryExtensionSql = `
CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS api_tokens_user ON api_tokens(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS api_tokens_expiry ON api_tokens(expires_at);
CREATE TABLE IF NOT EXISTS repo_uploads (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK(channel IN ('stable','beta')),
  expected_id TEXT,
  expected_version TEXT,
  status TEXT NOT NULL CHECK(status IN ('uploading','committing','committed','aborted')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  files_json TEXT NOT NULL DEFAULT '[]',
  pack_id TEXT,
  pack_version TEXT
);
CREATE INDEX IF NOT EXISTS repo_uploads_owner ON repo_uploads(owner_id, status, expires_at);
CREATE TABLE IF NOT EXISTS repo_audit (
  id TEXT PRIMARY KEY,
  actor_id TEXT,
  action TEXT NOT NULL,
  package_id TEXT,
  version TEXT,
  created_at TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS repo_audit_created ON repo_audit(created_at DESC);
CREATE TABLE IF NOT EXISTS repo_keys (
  id TEXT PRIMARY KEY,
  algorithm TEXT NOT NULL CHECK(algorithm='Ed25519'),
  public_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);`;
const migrations = [{
  version: 1,
  sql: "CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);"
}, {
  version: 2,
  sql: `CREATE TABLE IF NOT EXISTS data_chat_sessions (id TEXT PRIMARY KEY, mode TEXT NOT NULL, kind TEXT, scope_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, body TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS data_chat_sessions_mode ON data_chat_sessions(mode, updated_at DESC);
CREATE TABLE IF NOT EXISTS script_releases (id TEXT PRIMARY KEY, plugin_id TEXT NOT NULL, created_at TEXT NOT NULL, body TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS script_releases_plugin ON script_releases(plugin_id, created_at DESC);`
}, {
  version: 3,
  sql: `CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','member')),
  allowed_plugins TEXT NOT NULL DEFAULT '[]',
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
ALTER TABLE tasks ADD COLUMN owner_id TEXT;
CREATE INDEX IF NOT EXISTS tasks_owner ON tasks(owner_id, created_at DESC);
ALTER TABLE data_chat_sessions ADD COLUMN owner_id TEXT;
CREATE INDEX IF NOT EXISTS data_chat_sessions_owner ON data_chat_sessions(owner_id, updated_at DESC);
ALTER TABLE script_releases ADD COLUMN owner_id TEXT;
CREATE INDEX IF NOT EXISTS script_releases_owner ON script_releases(owner_id, created_at DESC);`
}, {
  version: 4,
  sql: `CREATE TABLE IF NOT EXISTS repo_packs (
  id TEXT NOT NULL,
  version TEXT NOT NULL,
  kind TEXT NOT NULL,
  module_kind TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  channel TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  pack_sha256 TEXT NOT NULL,
  files_json TEXT NOT NULL,
  pack_json TEXT NOT NULL,
  publisher_id TEXT,
  publisher_name TEXT,
  created_at TEXT NOT NULL,
  yanked INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (id, version)
);
CREATE INDEX IF NOT EXISTS repo_packs_id_created ON repo_packs(id, created_at DESC);
CREATE INDEX IF NOT EXISTS repo_packs_pack ON repo_packs(pack_sha256);
CREATE TABLE IF NOT EXISTS package_states (
  package_id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  source TEXT NOT NULL,
  previous_version TEXT,
  installed_at TEXT NOT NULL,
  detail_json TEXT
);
CREATE TABLE IF NOT EXISTS package_events (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL,
  action TEXT NOT NULL,
  from_version TEXT,
  to_version TEXT,
  sha256 TEXT,
  created_at TEXT NOT NULL,
  detail_json TEXT
);
CREATE INDEX IF NOT EXISTS package_events_package ON package_events(package_id, created_at DESC);`
}, { version: 5, sql: registryExtensionSql }, {
  version: 6,
  sql: `CREATE TABLE IF NOT EXISTS local_account_seeds (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);`
}];
function migrate(db) {
  const current = Number(db.prepare("PRAGMA user_version").get().user_version);
  if (current > migrations.at(-1).version) throw new Error("任务数据库来自更新版本的应用，请使用匹配的版本打开。");
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version=${migration.version}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
export {
  migrate,
  registryExtensionSql
};
