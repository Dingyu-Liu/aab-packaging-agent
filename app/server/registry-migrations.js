import { registryExtensionSql } from "./migrations.js";
const registrySchemaSql = `
CREATE TABLE IF NOT EXISTS users (
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
CREATE TABLE IF NOT EXISTS repo_packs (
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
  PRIMARY KEY(id,version)
);
CREATE INDEX IF NOT EXISTS repo_packs_id_created ON repo_packs(id,created_at DESC);
CREATE INDEX IF NOT EXISTS repo_packs_pack ON repo_packs(pack_sha256);
`;
function migrateRegistry(db) {
  db.exec("CREATE TABLE IF NOT EXISTS registry_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const current = Number(db.prepare("SELECT COALESCE(MAX(version),0) AS version FROM registry_migrations").get().version);
  if (current > 1) throw new Error("仓库数据库来自更新版本的应用，请使用匹配的版本打开。");
  if (current === 1) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(registrySchemaSql);
    db.exec(registryExtensionSql);
    db.prepare("INSERT INTO registry_migrations(version,applied_at) VALUES(1,?)").run((/* @__PURE__ */ new Date()).toISOString());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
export {
  migrateRegistry
};
