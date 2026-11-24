import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { migrate } from "./migrations.js";
function userFromRow(row) {
  let allowedPlugins = [];
  try {
    const parsed = JSON.parse(row.allowed_plugins);
    if (Array.isArray(parsed)) allowedPlugins = parsed.filter((item) => typeof item === "string");
  } catch {
  }
  return { id: row.id, username: row.username, displayName: row.display_name, role: row.role, allowedPlugins, disabled: row.disabled === 1, createdAt: row.created_at, updatedAt: row.updated_at };
}
class Store {
  constructor(dataDir, redactor, options = {}) {
    this.dataDir = dataDir;
    this.redactor = redactor;
    this.options = options;
    mkdirSync(dataDir, { recursive: true, mode: 448 });
    this.db = new DatabaseSync(join(dataDir, "partner-agent.sqlite"));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    chmodSync(join(dataDir, "partner-agent.sqlite"), 384);
    if (options.role === "registry" && !options.migrate) {
      this.db.close();
      throw new Error("Registry Store 必须提供独立迁移。");
    }
    try {
      (options.migrate ?? migrate)(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  dataDir;
  redactor;
  options;
  db;
  listTasks(ownerId) {
    const rows = ownerId ? this.db.prepare("SELECT body FROM tasks WHERE owner_id=? ORDER BY created_at DESC").all(ownerId) : this.db.prepare("SELECT body FROM tasks ORDER BY created_at DESC").all();
    return rows.map((row) => JSON.parse(row.body));
  }
  getTask(id) {
    const row = this.db.prepare("SELECT body FROM tasks WHERE id=?").get(id);
    return row ? JSON.parse(row.body) : void 0;
  }
  saveTask(task) {
    task.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    task.events = task.events.slice(-1200);
    const clean = this.redactor.json(task);
    this.db.prepare("INSERT INTO tasks(id,owner_id,created_at,body) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET owner_id=excluded.owner_id, body=excluded.body").run(clean.id, clean.ownerId ?? null, clean.createdAt, JSON.stringify(clean));
    return clean;
  }
  settings() {
    const row = this.db.prepare("SELECT body FROM settings WHERE id=1").get();
    return row ? JSON.parse(row.body) : {};
  }
  saveSettings(settings) {
    const { apiKeyConfigured: _present, keySource: _source, ...persisted } = settings;
    this.db.prepare("INSERT INTO settings(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body").run(JSON.stringify(persisted));
  }
  recoverInterrupted() {
    for (const task of this.listTasks()) {
      if (task.gpBuild?.stage === "awaiting_input") {
        task.status = "needs_review";
        task.phase = "等待你补充信息";
        this.saveTask(task);
        continue;
      }
      if (task.gpBuild?.stage === "awaiting_confirmation" && task.gpBuild.compilationId && task.gpBuild.compiledAt && task.gpBuild.fingerprint) {
        task.status = "waiting_approval";
        task.phase = "编译通过，等待确认打包";
        this.saveTask(task);
        continue;
      }
      if (["running", "queued", "waiting_approval"].includes(task.status)) {
        if (task.gpBuild) {
          const state = task.gpBuild;
          state.resumeStage ??= state.stage === "packaging" || state.approval ? "packaging" : "compiling";
          state.stage = "awaiting_input";
          state.blocker = { reason: "interrupted", question: "应用在处理完成前退出。工程、已有确认和已收到的消息已保留，直接在本会话回复后可继续。" };
          task.status = "needs_review";
          task.phase = "等待继续处理";
          task.messages.push({ id: crypto.randomUUID(), role: "system", time: (/* @__PURE__ */ new Date()).toISOString(), content: state.blocker.question });
        } else {
          task.status = "failed";
          task.phase = "上次运行被中断";
          if (task.websiteGeneration) task.websiteGeneration.stage = "failed";
        }
        task.permissions = task.permissions.map((item) => ({ ...item, status: "rejected" }));
        task.events.push({ id: crypto.randomUUID(), time: (/* @__PURE__ */ new Date()).toISOString(), kind: "error", level: "warn", message: "应用在任务完成前退出。记录与工作副本已保留，请核对后重新发起或继续会话。" });
        this.saveTask(task);
      }
    }
  }
  listChatSessions(mode, ownerId) {
    const conditions = [];
    const params = [];
    if (mode) {
      conditions.push("mode=?");
      params.push(mode);
    }
    if (ownerId) {
      conditions.push("owner_id=?");
      params.push(ownerId);
    }
    const sql = `SELECT body FROM data_chat_sessions${conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""} ORDER BY updated_at DESC`;
    const rows = this.db.prepare(sql).all(...params);
    return rows.map((row) => {
      const session = JSON.parse(row.body);
      return { id: session.id, ownerId: session.ownerId, mode: session.mode, kind: session.kind, scopeId: session.scopeId, title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt, messageCount: session.messages.length };
    });
  }
  getChatSession(id) {
    const row = this.db.prepare("SELECT body FROM data_chat_sessions WHERE id=?").get(id);
    return row ? JSON.parse(row.body) : void 0;
  }
  saveChatSession(session) {
    session.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    const clean = this.redactor.json(session);
    this.db.prepare("INSERT INTO data_chat_sessions(id,owner_id,mode,kind,scope_id,created_at,updated_at,body) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET owner_id=excluded.owner_id, updated_at=excluded.updated_at, body=excluded.body").run(clean.id, clean.ownerId ?? null, clean.mode, clean.kind ?? null, clean.scopeId ?? null, clean.createdAt, clean.updatedAt, JSON.stringify(clean));
    return clean;
  }
  deleteChatSession(id) {
    this.db.prepare("DELETE FROM data_chat_sessions WHERE id=?").run(id);
  }
  listReleases(pluginId, ownerId) {
    const conditions = [];
    const params = [];
    if (pluginId) {
      conditions.push("plugin_id=?");
      params.push(pluginId);
    }
    if (ownerId) {
      conditions.push("owner_id=?");
      params.push(ownerId);
    }
    const sql = `SELECT body FROM script_releases${conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""} ORDER BY created_at DESC`;
    const rows = this.db.prepare(sql).all(...params);
    return rows.map((row) => JSON.parse(row.body));
  }
  saveRelease(release) {
    this.db.prepare("INSERT OR REPLACE INTO script_releases(id,owner_id,plugin_id,created_at,body) VALUES(?,?,?,?,?)").run(release.id, release.ownerId ?? null, release.pluginId, release.createdAt, JSON.stringify(this.redactor.json(release)));
  }
  countUsers() {
    return Number(this.db.prepare("SELECT COUNT(*) AS count FROM users").get().count);
  }
  listUsers() {
    return this.db.prepare("SELECT * FROM users ORDER BY created_at").all().map(userFromRow);
  }
  findUser(username) {
    const row = this.db.prepare("SELECT * FROM users WHERE username=?").get(username);
    return row ? { user: userFromRow(row), passwordHash: row.password_hash } : void 0;
  }
  getUser(id) {
    const row = this.db.prepare("SELECT * FROM users WHERE id=?").get(id);
    return row ? userFromRow(row) : void 0;
  }
  createUser(input) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    this.db.prepare("INSERT INTO users(id,username,display_name,password_hash,role,allowed_plugins,disabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(input.id, input.username, input.displayName, input.passwordHash, input.role, JSON.stringify(input.allowedPlugins), input.disabled ? 1 : 0, now, now);
    return this.getUser(input.id);
  }
  updateUser(id, patch) {
    const current = this.getUser(id);
    if (!current) throw new Error("用户不存在。");
    const next = {
      displayName: patch.displayName ?? current.displayName,
      passwordHash: patch.passwordHash ?? this.db.prepare("SELECT password_hash FROM users WHERE id=?").get(id).password_hash,
      role: patch.role ?? current.role,
      allowedPlugins: patch.allowedPlugins ?? current.allowedPlugins,
      disabled: patch.disabled ?? current.disabled
    };
    this.db.prepare("UPDATE users SET display_name=?,password_hash=?,role=?,allowed_plugins=?,disabled=?,updated_at=? WHERE id=?").run(next.displayName, next.passwordHash, next.role, JSON.stringify(next.allowedPlugins), next.disabled ? 1 : 0, (/* @__PURE__ */ new Date()).toISOString(), id);
    return this.getUser(id);
  }
  deleteUser(id) {
    this.db.prepare("DELETE FROM users WHERE id=?").run(id);
    this.db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
    this.db.prepare("DELETE FROM api_tokens WHERE user_id=?").run(id);
  }
  createSession(tokenHash, userId, expiresAt) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    this.db.prepare("INSERT INTO sessions(token_hash,user_id,created_at,expires_at,last_seen_at) VALUES(?,?,?,?,?)").run(tokenHash, userId, now, expiresAt, now);
  }
  session(tokenHash) {
    const row = this.db.prepare("SELECT user_id,expires_at FROM sessions WHERE token_hash=?").get(tokenHash);
    return row ? { userId: row.user_id, expiresAt: row.expires_at } : void 0;
  }
  touchSession(tokenHash) {
    this.db.prepare("UPDATE sessions SET last_seen_at=? WHERE token_hash=?").run((/* @__PURE__ */ new Date()).toISOString(), tokenHash);
  }
  deleteSession(tokenHash) {
    this.db.prepare("DELETE FROM sessions WHERE token_hash=?").run(tokenHash);
  }
  cleanupSessions() {
    this.db.prepare("DELETE FROM sessions WHERE expires_at < ?").run((/* @__PURE__ */ new Date()).toISOString());
  }
  createApiToken(id, hash, userId, name, expiresAt) {
    const createdAt = (/* @__PURE__ */ new Date()).toISOString();
    this.db.prepare("INSERT INTO api_tokens(id,token_hash,user_id,name,created_at,expires_at) VALUES(?,?,?,?,?,?)").run(id, hash, userId, name, createdAt, expiresAt);
    return { id, name, createdAt, expiresAt };
  }
  apiToken(hash) {
    const row = this.db.prepare("SELECT id,user_id,expires_at,revoked_at FROM api_tokens WHERE token_hash=?").get(hash);
    return row ? { id: row.id, userId: row.user_id, expiresAt: row.expires_at, ...row.revoked_at ? { revokedAt: row.revoked_at } : {} } : void 0;
  }
  listApiTokens(userId) {
    const rows = this.db.prepare("SELECT id,name,created_at,expires_at,last_used_at,revoked_at FROM api_tokens WHERE user_id=? ORDER BY created_at DESC").all(userId);
    return rows.map((row) => ({ id: row.id, name: row.name, createdAt: row.created_at, expiresAt: row.expires_at, ...row.last_used_at ? { lastUsedAt: row.last_used_at } : {}, ...row.revoked_at ? { revokedAt: row.revoked_at } : {} }));
  }
  touchApiToken(id) {
    this.db.prepare("UPDATE api_tokens SET last_used_at=? WHERE id=?").run((/* @__PURE__ */ new Date()).toISOString(), id);
  }
  revokeApiToken(id, userId) {
    return Number(this.db.prepare("UPDATE api_tokens SET revoked_at=COALESCE(revoked_at,?) WHERE id=? AND user_id=?").run((/* @__PURE__ */ new Date()).toISOString(), id, userId).changes) > 0;
  }
  revokeUserTokens(userId) {
    this.db.prepare("DELETE FROM sessions WHERE user_id=?").run(userId);
    this.db.prepare("UPDATE api_tokens SET revoked_at=COALESCE(revoked_at,?) WHERE user_id=?").run((/* @__PURE__ */ new Date()).toISOString(), userId);
  }
  close() {
    this.db.close();
  }
}
export {
  Store
};
