import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createPublicKey, randomUUID } from "node:crypto";
import { AppError } from "./errors.js";
import { validateManifest } from "./manifest-validation.js";
import { allowedPackPath, assertPackFiles, compareSemver, PACK_LIMITS, packSha256, sha256, validPackId, validPackPath, validPackVersion } from "./pack-utils.js";
const uploadLifetimeMs = 60 * 6e4;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function object(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function rowPack(row) {
  return JSON.parse(row.pack_json);
}
function uploadInfo(row) {
  return { uploadId: row.id, status: row.status, expiresAt: row.expires_at, files: JSON.parse(row.files_json), ...row.pack_id ? { packId: row.pack_id } : {}, ...row.pack_version ? { version: row.pack_version } : {} };
}
function decodeFile(item) {
  if (!object(item) || typeof item.path !== "string" || typeof item.contentBase64 !== "string") throw new AppError(400, "技能包文件格式无效。");
  const encoded = item.contentBase64;
  if (encoded.length > Math.ceil(PACK_LIMITS.fileBytes / 3) * 4) throw new AppError(413, "技能包文件超过 8 MiB 上限。");
  if (encoded.length % 4 !== 0) throw new AppError(400, "文件 Base64 编码无效。");
  const content = Buffer.from(encoded, "base64");
  if (content.toString("base64") !== encoded) throw new AppError(400, "文件 Base64 编码无效。");
  return { path: item.path, content };
}
class RepoStore {
  constructor(store, repoDir, redactor) {
    this.store = store;
    this.redactor = redactor;
    this.root = resolve(repoDir);
  }
  store;
  redactor;
  root;
  ready;
  busyUploads = /* @__PURE__ */ new Set();
  busyPacks = /* @__PURE__ */ new Set();
  async initialize() {
    this.ready ??= this.initializeRoot();
    await this.ready;
  }
  async initializeRoot() {
    await mkdir(this.root, { recursive: true, mode: 448 });
    if (!(await lstat(this.root)).isDirectory() || (await lstat(this.root)).isSymbolicLink()) throw new Error("Registry 仓库目录不能使用符号链接。");
    this.root = await realpath(this.root);
    await this.directory("packs", true);
    await this.directory("staging", true);
    await this.cleanupExpired();
  }
  /** Walk every component: realpath containment alone would still allow symlinks inside the root. */
  async directory(path, create = false) {
    let current = this.root;
    const rootStat = await lstat(current);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new AppError(400, "仓库目录无效。");
    for (const part of path.split("/").filter(Boolean)) {
      if (part === "." || part === ".." || part.includes("\\")) throw new AppError(400, "仓库目录路径无效。");
      current = join(current, part);
      if (create) await mkdir(current, { mode: 448 }).catch((error) => {
        if (error.code !== "EEXIST") throw error;
      });
      const stat = await lstat(current).catch(() => {
        throw new AppError(404, "仓库目录不存在。");
      });
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new AppError(400, "仓库目录不能使用符号链接。");
    }
    if (await realpath(current) !== current) throw new AppError(400, "仓库目录路径无效。");
    return current;
  }
  async file(relative, limit = PACK_LIMITS.fileBytes) {
    const parts = relative.split("/"), name = parts.pop();
    const directory = await this.directory(parts.join("/"));
    const path = join(directory, name);
    const stat = await lstat(path).catch(() => {
      throw new AppError(404, "技能包文件不存在。");
    });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit || stat.nlink !== 1) throw new AppError(400, "技能包文件不是普通文件或超过大小上限。");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
      throw new AppError(400, "技能包文件无法安全读取。");
    });
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > limit || opened.ino !== stat.ino || opened.dev !== stat.dev) throw new AppError(400, "技能包文件在读取时发生变化。");
      const content = Buffer.alloc(opened.size);
      let offset = 0;
      while (offset < content.length) {
        const read = await handle.read(content, offset, content.length - offset, offset);
        if (!read.bytesRead) break;
        offset += read.bytesRead;
      }
      const after = await handle.stat();
      if (offset !== content.length || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.nlink !== 1) throw new AppError(400, "技能包文件在读取时发生变化。");
      return content;
    } finally {
      await handle.close();
    }
  }
  actor(user, admin = false) {
    const current = this.store.getUser(user.id);
    if (!current || current.disabled) throw new AppError(401, "账号已停用，请重新登录。");
    if (admin && current.role !== "admin") throw new AppError(403, "需要管理员权限。");
    return current;
  }
  visible(user, id) {
    return user.role === "admin" || user.allowedPlugins.includes(id);
  }
  coordinates(id, version) {
    if (!validPackId(id) || version !== void 0 && !validPackVersion(version)) throw new AppError(400, "技能包 id 或版本无效。");
  }
  audit(actor, action, id, version, detail = {}) {
    this.store.db.prepare("INSERT INTO repo_audit(id,actor_id,action,package_id,version,created_at,detail_json) VALUES(?,?,?,?,?,?,?)").run(randomUUID(), actor.id, action, id ?? null, version ?? null, (/* @__PURE__ */ new Date()).toISOString(), JSON.stringify(this.redactor.json(detail)));
  }
  upload(user, id, active = true) {
    const current = this.actor(user, true);
    if (!uuidPattern.test(id)) throw new AppError(404, "上传不存在。");
    const row = this.store.db.prepare("SELECT * FROM repo_uploads WHERE id=? AND owner_id=?").get(id, current.id);
    if (!row) throw new AppError(404, "上传不存在。");
    if (active && (row.status !== "uploading" || Date.parse(row.expires_at) <= Date.now())) throw new AppError(409, "上传已结束或已过期，请创建新的上传。");
    return row;
  }
  async locked(id, fn) {
    if (this.busyUploads.has(id)) throw new AppError(409, "此上传正在处理，请稍后重试。");
    this.busyUploads.add(id);
    try {
      return await fn();
    } finally {
      this.busyUploads.delete(id);
    }
  }
  async cleanupExpired() {
    const rows = this.store.db.prepare("SELECT * FROM repo_uploads WHERE status IN ('uploading','aborted') AND expires_at<=?").all((/* @__PURE__ */ new Date()).toISOString());
    for (const row of rows) {
      if (!uuidPattern.test(row.id) || this.busyUploads.has(row.id)) continue;
      this.store.db.prepare("UPDATE repo_uploads SET status='aborted',files_json='[]' WHERE id=?").run(row.id);
      await this.directory("staging");
      await rm(join(this.root, "staging", row.id), { recursive: true, force: true });
      this.store.db.prepare("DELETE FROM repo_uploads WHERE id=?").run(row.id);
    }
  }
  async createUpload(input, publisher) {
    const actor = this.actor(publisher, true);
    if (!object(input) || input.channel !== "stable" && input.channel !== "beta") throw new AppError(400, "发布通道无效。");
    if (input.id !== void 0 && (typeof input.id !== "string" || !validPackId(input.id))) throw new AppError(400, "技能包 id 无效。");
    if (input.version !== void 0 && (typeof input.version !== "string" || !validPackVersion(input.version))) throw new AppError(400, "技能包版本无效。");
    if (input.files !== void 0 && (!Array.isArray(input.files) || input.files.length > PACK_LIMITS.files)) throw new AppError(400, "技能包文件列表无效。");
    await this.initialize();
    await this.cleanupExpired();
    this.actor(actor, true);
    const active = this.store.db.prepare("SELECT owner_id FROM repo_uploads WHERE status IN ('uploading','committing') AND expires_at>?").all((/* @__PURE__ */ new Date()).toISOString());
    if (active.length >= 20 || active.filter((row) => row.owner_id === actor.id).length >= 4) throw new AppError(429, "未完成的上传过多，请先提交或放弃已有上传。");
    const id = randomUUID(), now = /* @__PURE__ */ new Date(), expiresAt = new Date(now.getTime() + uploadLifetimeMs).toISOString();
    this.store.db.prepare("INSERT INTO repo_uploads(id,owner_id,channel,expected_id,expected_version,status,created_at,expires_at) VALUES(?,?,?,?,?,'uploading',?,?)").run(id, actor.id, input.channel, input.id ?? null, input.version ?? null, now.toISOString(), expiresAt);
    try {
      await this.directory(`staging/${id}/payload`, true);
      if (Array.isArray(input.files)) for (const item of input.files) {
        const file = decodeFile(item);
        await this.uploadFile(actor, id, file.path, file.content);
      }
      this.audit(actor, "upload.create", typeof input.id === "string" ? input.id : void 0, typeof input.version === "string" ? input.version : void 0, { uploadId: id });
      return { uploadId: id, status: "uploading", expiresAt };
    } catch (error) {
      this.store.db.prepare("UPDATE repo_uploads SET status='aborted',files_json='[]' WHERE id=?").run(id);
      await rm(join(this.root, "staging", id), { recursive: true, force: true });
      throw error;
    }
  }
  getUpload(user, id) {
    return uploadInfo(this.upload(user, id, false));
  }
  async uploadJsonFile(user, id, input) {
    this.upload(user, id);
    const file = decodeFile(input);
    return this.uploadFile(user, id, file.path, file.content);
  }
  async uploadFile(user, id, path, content) {
    return this.locked(id, async () => {
      const row = this.upload(user, id);
      if (!allowedPackPath(path) || path.toLowerCase() === "pack.json") throw new AppError(400, "文件路径不在技能包白名单内。");
      if (content.length > PACK_LIMITS.fileBytes || path === "manifest.json" && content.length >= PACK_LIMITS.manifestBytes) throw new AppError(413, "技能包文件超过大小上限。");
      const metadata = { path, size: content.length, sha256: sha256(content) };
      const files = JSON.parse(row.files_json);
      const next = [...files.filter((file) => file.path !== path), metadata];
      assertPackFiles(next);
      const relative = `staging/${id}/payload/${path}`;
      const parent = dirname(relative);
      await this.directory(parent, true);
      const target = join(this.root, relative);
      const existing = await lstat(target).catch((error) => {
        if (error.code === "ENOENT") return void 0;
        throw error;
      });
      if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) throw new AppError(400, "上传目标不是普通文件。");
      const temporary = join(this.root, "staging", id, `${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, content, { mode: 384, flag: "wx" });
        await this.directory(parent);
        this.upload(user, id);
        await rename(temporary, target);
        this.store.db.prepare("UPDATE repo_uploads SET files_json=? WHERE id=?").run(JSON.stringify(next), id);
      } finally {
        await rm(temporary, { force: true });
      }
      return metadata;
    });
  }
  async abortUpload(user, id) {
    await this.locked(id, async () => {
      const row = this.upload(user, id, false);
      if (row.status === "committed") throw new AppError(409, "已提交的版本不能删除，请使用 yank。");
      this.store.db.prepare("UPDATE repo_uploads SET status='aborted',files_json='[]' WHERE id=?").run(id);
      await this.directory("staging");
      await rm(join(this.root, "staging", id), { force: true, recursive: true });
      this.audit(user, "upload.abort", row.expected_id ?? void 0, row.expected_version ?? void 0, { uploadId: id });
    });
  }
  async scanPayload(id) {
    const files = [];
    let bytes = 0;
    const walk = async (path) => {
      const directory = await this.directory(`staging/${id}/payload${path ? "/" + path : ""}`);
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const relative = path ? `${path}/${entry.name}` : entry.name;
        if (!validPackPath(relative) || entry.isSymbolicLink()) throw new AppError(400, "staging 含非法路径或符号链接。");
        if (entry.isDirectory()) {
          if (relative.split("/").length >= 16) throw new AppError(400, "技能包目录层级过多。");
          await walk(relative);
        } else {
          if (!entry.isFile() || !allowedPackPath(relative) || relative.toLowerCase() === "pack.json") throw new AppError(400, "staging 含白名单外文件。");
          if (files.length >= PACK_LIMITS.files) throw new AppError(400, "技能包文件数量过多。");
          const content = await this.file(`staging/${id}/payload/${relative}`, relative === "manifest.json" ? PACK_LIMITS.manifestBytes - 1 : PACK_LIMITS.fileBytes);
          bytes += content.length;
          if (bytes > PACK_LIMITS.totalBytes) throw new AppError(400, "技能包超过 50 MiB 上限。");
          files.push({ path: relative, size: content.length, sha256: sha256(content) });
        }
      }
    };
    await walk("");
    assertPackFiles(files);
    return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  }
  validateContent(manifest, files, channel) {
    if (!validPackVersion(manifest.version)) throw new AppError(400, "技能包版本必须是语义版本。");
    if (channel === "stable" && manifest.version.split("+")[0].includes("-")) throw new AppError(400, "稳定通道不能发布预发布版本。");
    if (manifest.script?.runner === "external") throw new AppError(400, "团队仓库不接受 external runner 包。");
    const paths = new Set(files.map((file) => file.path));
    const required = manifest.script?.runner === "finance-sync" ? ["scripts/run_consume.py", "scripts/run_ads.py", "scripts/dapan_sync.py", "scripts/full_review.py", "scripts/sync_log.py", "scripts/codex_lark_adapter.py"] : manifest.script?.runner === "h5-sync" ? ["scripts/feishu_h5_sync.py"] : [];
    for (const path of required) if (!paths.has(path)) throw new AppError(400, `缺少必需脚本：${path}`);
    for (const profile of manifest.profiles) if (!paths.has(profile.skill.path) || files.find((file) => file.path === profile.skill.path).size === 0) throw new AppError(400, "缺少非空 SKILL.md 文件。");
  }
  assertNewVersion(id, version, channel) {
    if (this.store.db.prepare("SELECT 1 FROM repo_packs WHERE id=? AND version=?").get(id, version)) throw new AppError(409, "该版本已经发布，不能覆盖；请发布新版本。");
    if (channel === "stable") {
      const latest = this.store.db.prepare("SELECT version FROM repo_packs WHERE id=? AND channel='stable'").all(id).sort((a, b) => compareSemver(b.version, a.version))[0];
      if (latest && compareSemver(version, latest.version) <= 0) throw new AppError(409, `稳定通道版本必须高于当前最新稳定版本 ${latest.version}。`);
    }
  }
  savePack(pack, manifestHash) {
    this.store.db.prepare("INSERT INTO repo_packs(id,version,kind,module_kind,name,description,channel,manifest_sha256,pack_sha256,files_json,pack_json,publisher_id,publisher_name,created_at,yanked) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)").run(pack.id, pack.version, pack.kind, pack.moduleKind, pack.name, pack.description, pack.channel, manifestHash, pack.packSha256, JSON.stringify(pack.files), JSON.stringify(pack), pack.publisher?.id ?? null, pack.publisher?.name ?? null, pack.createdAt);
  }
  async commitUpload(user, id) {
    return this.locked(id, async () => {
      const row = this.upload(user, id);
      const files = await this.scanPayload(id);
      if (!files.some((file) => file.path === "manifest.json")) throw new AppError(400, "技能包必须包含 manifest.json。");
      const manifestFile = await this.file(`staging/${id}/payload/manifest.json`, PACK_LIMITS.manifestBytes - 1);
      let raw;
      try {
        raw = JSON.parse(manifestFile.toString("utf8"));
      } catch {
        throw new AppError(400, "manifest.json 不是合法 JSON。");
      }
      const manifest = validateManifest(raw);
      this.validateContent(manifest, files, row.channel);
      for (const profile of manifest.profiles) {
        const content = await this.file(`staging/${id}/payload/${profile.skill.path}`, 1024 * 1024);
        let skill;
        try {
          skill = new TextDecoder("utf-8", { fatal: true }).decode(content);
        } catch {
          throw new AppError(400, "SKILL.md 必须是 UTF-8 文本。");
        }
        if (!skill.trim()) throw new AppError(400, "SKILL.md 内容不能为空。");
      }
      if (row.expected_id && row.expected_id !== manifest.id || row.expected_version && row.expected_version !== manifest.version) throw new AppError(400, "上传声明的包 id/版本与 manifest 不一致。");
      const packKey = `${manifest.id}@${manifest.version}`;
      if (this.busyPacks.has(packKey)) throw new AppError(409, "此版本正在发布，请稍后重试。");
      this.busyPacks.add(packKey);
      let reserved = false, published = false;
      const directory = join(this.root, "packs", manifest.id, manifest.version);
      const releaseRelative = `staging/${id}/release`;
      const release = join(this.root, releaseRelative);
      try {
        this.assertNewVersion(manifest.id, manifest.version, row.channel);
        const actor = this.actor(user, true);
        const base = {
          schemaVersion: 1,
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          kind: manifest.kind !== "script" ? "skill" : "script",
          moduleKind: manifest.kind,
          description: manifest.description,
          channel: row.channel,
          compatibility: { pluginSchemaVersion: 1, opencodeVersion: "1.19.5", ...manifest.script ? { runners: [manifest.script.runner] } : {} },
          files,
          createdAt: (/* @__PURE__ */ new Date()).toISOString(),
          publisher: { id: actor.id, name: actor.displayName || actor.username }
        };
        const pack = { ...base, packSha256: packSha256(base) };
        this.store.db.prepare("UPDATE repo_uploads SET status='committing',pack_id=?,pack_version=? WHERE id=?").run(pack.id, pack.version, id);
        await this.directory(`staging/${id}`);
        await rm(release, { recursive: true, force: true });
        await this.directory(releaseRelative, true);
        for (const file of files) {
          const content = await this.file(`staging/${id}/payload/${file.path}`);
          if (content.length !== file.size || sha256(content) !== file.sha256) throw new AppError(400, "staging 文件在提交时发生变化。");
          await this.directory(dirname(`${releaseRelative}/${file.path}`), true);
          await writeFile(join(release, file.path), content, { flag: "wx", mode: 384 });
        }
        await writeFile(join(release, "pack.json"), JSON.stringify(pack, null, 2) + "\n", { mode: 384, flag: "wx" });
        await this.directory(`packs/${manifest.id}`, true);
        this.actor(user, true);
        this.assertNewVersion(manifest.id, manifest.version, row.channel);
        await mkdir(directory, { mode: 448 }).catch((error) => {
          if (error.code === "EEXIST") throw new AppError(409, "该版本目录已存在，不能覆盖。");
          throw error;
        });
        reserved = true;
        await rename(release, directory);
        this.actor(user, true);
        this.store.db.exec("BEGIN IMMEDIATE");
        try {
          this.savePack(pack, sha256(manifestFile));
          this.store.db.prepare("UPDATE repo_uploads SET status='committed',files_json=? WHERE id=?").run(JSON.stringify(files), id);
          this.audit(actor, "pack.publish", pack.id, pack.version, { uploadId: id, packSha256: pack.packSha256, files: files.length });
          this.store.db.exec("COMMIT");
        } catch (error) {
          this.store.db.exec("ROLLBACK");
          throw error;
        }
        published = true;
        await rm(join(this.root, "staging", id), { recursive: true, force: true }).catch(() => void 0);
        return pack;
      } catch (error) {
        if (reserved && !published) await rm(directory, { recursive: true, force: true });
        if (!published) {
          this.store.db.prepare("UPDATE repo_uploads SET status='uploading',pack_id=NULL,pack_version=NULL WHERE id=?").run(id);
          await rm(release, { recursive: true, force: true }).catch(() => void 0);
        }
        throw error;
      } finally {
        this.busyPacks.delete(packKey);
      }
    });
  }
  /** Compatibility with the original JSON/base64 publication endpoint. */
  async publish(input, publisher) {
    if (!input || !Array.isArray(input.files) || !input.files.length) throw new AppError(400, "技能包文件列表无效。");
    const upload = await this.createUpload(input, publisher);
    try {
      return await this.commitUpload(publisher, upload.uploadId);
    } catch (error) {
      await this.abortUpload(publisher, upload.uploadId).catch(() => void 0);
      throw error;
    }
  }
  catalog(user) {
    const actor = this.actor(user);
    const rows = this.store.db.prepare("SELECT * FROM repo_packs WHERE yanked=0").all();
    const latest = /* @__PURE__ */ new Map();
    for (const row of rows) {
      if (!this.visible(actor, row.id)) continue;
      const current = latest.get(row.id);
      if (!current || row.channel === "stable" && current.channel !== "stable" || row.channel === current.channel && compareSemver(row.version, current.version) > 0) latest.set(row.id, row);
    }
    return [...latest.values()].sort((a, b) => a.name.localeCompare(b.name)).map((row) => {
      const pack = rowPack(row);
      return { id: pack.id, name: pack.name, version: pack.version, kind: pack.kind, moduleKind: pack.moduleKind, description: pack.description, channel: pack.channel, packSha256: pack.packSha256, createdAt: pack.createdAt };
    });
  }
  versions(user, id) {
    const actor = this.actor(user);
    this.coordinates(id);
    if (!this.visible(actor, id)) throw new AppError(404, "技能包不存在。");
    const rows = this.store.db.prepare("SELECT * FROM repo_packs WHERE id=? AND yanked=0").all(id);
    if (!rows.length && !this.store.db.prepare("SELECT 1 FROM repo_packs WHERE id=?").get(id)) throw new AppError(404, "技能包不存在。");
    return rows.sort((a, b) => compareSemver(b.version, a.version)).map(rowPack);
  }
  get(user, id, version) {
    const actor = this.actor(user);
    this.coordinates(id, version);
    if (!this.visible(actor, id)) throw new AppError(404, "技能包不存在。");
    const row = this.store.db.prepare("SELECT * FROM repo_packs WHERE id=? AND version=?").get(id, version);
    if (!row) throw new AppError(404, "技能包版本不存在。");
    if (row.yanked) throw new AppError(410, "该版本已撤回，不能再下载或安装。");
    return rowPack(row);
  }
  async readFile(user, id, version, path) {
    const pack = this.get(user, id, version);
    if (!validPackPath(path)) throw new AppError(400, "技能包文件路径无效。");
    const metadata = pack.files.find((file) => file.path === path);
    if (!metadata && path !== "pack.json") throw new AppError(404, "技能包文件不存在。");
    const content = await this.file(`packs/${id}/${version}/${path}`, path === "pack.json" ? 2 * 1024 * 1024 : PACK_LIMITS.fileBytes);
    const hash = sha256(content);
    if (metadata && (content.length !== metadata.size || hash !== metadata.sha256)) throw new AppError(409, "仓库文件完整性校验失败。");
    if (path === "pack.json") {
      let description;
      try {
        description = JSON.parse(content.toString("utf8"));
      } catch {
        throw new AppError(409, "仓库文件完整性校验失败。");
      }
      if (!description || description.packSha256 !== pack.packSha256 || packSha256(description) !== pack.packSha256) throw new AppError(409, "仓库文件完整性校验失败。");
    }
    this.get(user, id, version);
    return { content, pack, sha256: hash };
  }
  yank(user, id, version) {
    const actor = this.actor(user, true);
    this.coordinates(id, version);
    const row = this.store.db.prepare("SELECT yanked FROM repo_packs WHERE id=? AND version=?").get(id, version);
    if (!row) throw new AppError(404, "技能包版本不存在。");
    if (!row.yanked) {
      this.store.db.exec("BEGIN IMMEDIATE");
      try {
        this.store.db.prepare("UPDATE repo_packs SET yanked=1 WHERE id=? AND version=?").run(id, version);
        this.audit(actor, "pack.yank", id, version);
        this.store.db.exec("COMMIT");
      } catch (error) {
        this.store.db.exec("ROLLBACK");
        throw error;
      }
    }
  }
  auditLog(user, limit = 100, before) {
    this.actor(user, true);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200 || before !== void 0 && (!Number.isFinite(Date.parse(before)) || before.length > 40)) throw new AppError(400, "审计分页参数无效。");
    const rows = before ? this.store.db.prepare("SELECT * FROM repo_audit WHERE created_at<? ORDER BY created_at DESC,rowid DESC LIMIT ?").all(before, limit) : this.store.db.prepare("SELECT * FROM repo_audit ORDER BY created_at DESC,rowid DESC LIMIT ?").all(limit);
    return { entries: rows.map((row) => ({ id: row.id, actorId: row.actor_id, action: row.action, packageId: row.package_id, version: row.version, createdAt: row.created_at, detail: JSON.parse(String(row.detail_json)) })), ...rows.length === limit ? { nextCursor: String(rows.at(-1).created_at) } : {} };
  }
  keys(user) {
    this.actor(user);
    const rows = this.store.db.prepare("SELECT * FROM repo_keys WHERE revoked_at IS NULL ORDER BY created_at").all();
    return { signatureRequired: false, keys: rows.map((row) => ({ id: row.id, algorithm: row.algorithm, publicKey: row.public_key, createdAt: row.created_at })) };
  }
  addKey(user, input) {
    const actor = this.actor(user, true);
    if (!object(input) || typeof input.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(input.id) || typeof input.publicKey !== "string" || input.publicKey.length > 4096 || /PRIVATE KEY/.test(input.publicKey)) throw new AppError(400, "公钥格式无效。");
    let publicKey;
    try {
      const key = createPublicKey(input.publicKey);
      if (key.asymmetricKeyType !== "ed25519") throw new Error();
      publicKey = key.export({ type: "spki", format: "pem" }).toString();
    } catch {
      throw new AppError(400, "仅接受 Ed25519 公钥。");
    }
    if (this.store.db.prepare("SELECT 1 FROM repo_keys WHERE id=?").get(input.id)) throw new AppError(409, "keyId 已存在，不能覆盖。");
    this.store.db.prepare("INSERT INTO repo_keys(id,algorithm,public_key,created_at) VALUES(?,'Ed25519',?,?)").run(input.id, publicKey, (/* @__PURE__ */ new Date()).toISOString());
    this.audit(actor, "key.add", void 0, void 0, { keyId: input.id });
  }
  revokeKey(user, id) {
    const actor = this.actor(user, true);
    if (Number(this.store.db.prepare("UPDATE repo_keys SET revoked_at=COALESCE(revoked_at,?) WHERE id=?").run((/* @__PURE__ */ new Date()).toISOString(), id).changes) === 0) throw new AppError(404, "公钥不存在。");
    this.audit(actor, "key.revoke", void 0, void 0, { keyId: id });
  }
}
export {
  RepoStore
};
