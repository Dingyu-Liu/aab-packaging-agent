import { lstat, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { AppError } from "./errors.js";
import { compareVersions, validateManifest } from "./plugins.js";
import { packSha256, sha256 } from "./pack-utils.js";
import { APP_VERSION, OPENCODE_VERSION, PACKAGE_ID, packageTree, pathExists, privateDirectory, readPrivateJson, readRegularFile, validatePackageDirectory, validateRepoPack, writePrivateFile, writePrivateJson } from "./package-validation.js";
const emptyState = () => ({ schemaVersion: 1, packages: {} });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const instances = /* @__PURE__ */ new WeakMap();
class PackageInstaller {
  constructor(plugins, dataDir, redactor) {
    this.plugins = plugins;
    this.dataDir = dataDir;
    this.redactor = redactor;
    if (resolve(dataDir) !== resolve(plugins.dataDir)) throw new Error("PackageInstaller 必须使用 PluginRegistry 的 dataDir。");
    this.root = join(resolve(dataDir), "packages");
    this.statePath = join(this.root, "package-state.json");
    this.journalPath = join(this.root, "journal.json");
    this.disabledPath = join(this.root, "disabled-modules.json");
    if (!instances.has(plugins)) instances.set(plugins, this);
  }
  plugins;
  dataDir;
  redactor;
  root;
  ready;
  statePath;
  journalPath;
  disabledPath;
  static for(plugins, dataDir, redactor) {
    return instances.get(plugins) ?? new PackageInstaller(plugins, dataDir, redactor);
  }
  initialize() {
    if (!this.ready) this.ready = this.plugins.withWriteLock(async () => {
      await privateDirectory(this.dataDir);
      await privateDirectory(this.root);
      for (const name of ["staging", "backups", "blobs"]) await privateDirectory(join(this.root, name));
      await privateDirectory(join(this.dataDir, "plugins"));
      await this.recoverUnlocked();
      await this.plugins.reload();
    });
    return this.ready;
  }
  /** Synchronous source lookup for TaskPackageAccess; call while holding the module read lock. */
  origin(id) {
    const { source, packSha256: packSha2562, releaseId } = this.plugins.get(id);
    return { source, ...packSha2562 ? { packSha256: packSha2562 } : {}, ...releaseId ? { releaseId } : {} };
  }
  async getSource(id) {
    return this.origin(id);
  }
  async list() {
    await this.initialize();
    return this.plugins.withReadLock(async () => {
      const state = await this.readState();
      return this.plugins.list().map((plugin) => this.installed(plugin.id, state));
    });
  }
  async history(id) {
    await this.initialize();
    this.assertId(id);
    return this.plugins.withReadLock(async () => {
      const state = await this.readState(), loaded = this.plugins.get(id), builtin = this.plugins.getBuiltin(id);
      const record = state.packages[id];
      const current = record?.current.version === loaded.manifest.version ? record.current : this.currentRecord(id);
      const versions = [];
      const seen = /* @__PURE__ */ new Set();
      const add = (item, key, active) => {
        const identity = `${item.version}:${item.packSha256 ?? item.source}`;
        if (seen.has(identity)) return;
        seen.add(identity);
        versions.push({
          id: key,
          version: item.version,
          source: item.source,
          current: active,
          restorable: !active && (item.source === "builtin" || !builtin || compareVersions(item.version, builtin.manifest.version) > 0),
          installedAt: item.installedAt || void 0,
          sha256: item.packSha256,
          note: item.note,
          actor: item.actor
        });
      };
      if (loaded.source !== "builtin") add(current, "current", true);
      for (const previous of record?.previous ?? []) add(previous, previous.backupId, false);
      if (builtin) add({ version: builtin.manifest.version, source: "builtin", installedAt: "" }, "builtin", loaded.source === "builtin");
      return versions;
    });
  }
  installed(id, state) {
    const loaded = this.plugins.get(id), builtin = this.plugins.getBuiltin(id);
    const record = state.packages[id];
    const current = record?.current?.version === loaded.manifest.version ? record.current : void 0;
    const previous = record?.previous?.[0];
    return {
      id,
      version: loaded.manifest.version,
      source: loaded.source,
      ...loaded.packSha256 ? { sha256: loaded.packSha256 } : {},
      ...loaded.releaseId ? { releaseId: loaded.releaseId } : {},
      ...builtin ? { builtinVersion: builtin.manifest.version } : {},
      ...current ? { installedAt: current.installedAt } : {},
      ...previous ? { previousVersion: previous.version, previousVersionInstalledAt: previous.installedAt } : {},
      rollbackAvailable: !!previous && (!builtin || compareVersions(previous.version, builtin.manifest.version) > 0)
    };
  }
  assertId(id) {
    if (typeof id !== "string" || !PACKAGE_ID.test(id)) throw new AppError(400, "模块 id 无效。");
  }
  assertFloor(id, version) {
    const builtin = this.plugins.getBuiltin(id);
    if (builtin && compareVersions(version, builtin.manifest.version) <= 0) throw new AppError(409, `安装或回滚目标版本必须高于内置版本 ${builtin.manifest.version}，请使用恢复内置。`);
  }
  backupPath(id, backupId) {
    this.assertId(id);
    if (!UUID.test(backupId)) throw new AppError(500, "包备份编号损坏。");
    return join(this.root, "backups", id, backupId);
  }
  async readState() {
    if (!await pathExists(this.statePath)) return emptyState();
    const state = await readPrivateJson(this.statePath);
    if (!state || state.schemaVersion !== 1 || !state.packages || typeof state.packages !== "object" || Array.isArray(state.packages)) throw new AppError(500, "本地包状态损坏。");
    for (const [id, record] of Object.entries(state.packages)) {
      this.assertId(id);
      if (!record?.current || !Array.isArray(record.previous) || record.previous.some((item) => !UUID.test(item.backupId))) throw new AppError(500, "本地包备份状态损坏。");
    }
    return state;
  }
  currentRecord(id) {
    const loaded = this.plugins.list().some((plugin) => plugin.id === id) ? this.plugins.get(id) : void 0;
    return loaded ? { version: loaded.manifest.version, ...this.origin(id), installedAt: (/* @__PURE__ */ new Date()).toISOString() } : void 0;
  }
  async install(input, loadFile, options = {}) {
    await this.initialize();
    options.signal?.throwIfAborted();
    const pack = validateRepoPack(input);
    this.assertFloor(pack.id, pack.version);
    const transactionId = randomUUID(), staging = join(this.root, "staging", transactionId);
    await privateDirectory(staging);
    try {
      for (const file of pack.files) {
        options.signal?.throwIfAborted();
        const content = await loadFile(structuredClone(file));
        if (!Buffer.isBuffer(content) || content.length !== file.size || sha256(content) !== file.sha256) throw new AppError(400, `技能包文件 SHA-256 校验失败：${file.path}`);
        await this.createParents(staging, file.path);
        await writePrivateFile(join(staging, file.path), content);
      }
      await validatePackageDirectory(staging, pack);
      const origin = { source: options.source ?? "registry", packSha256: pack.packSha256, releaseId: options.releaseId ?? pack.packSha256 };
      if (!/^[a-zA-Z0-9._:-]{1,200}$/.test(origin.releaseId)) throw new AppError(400, "releaseId 格式无效。");
      await writePrivateJson(join(staging, "pack.json"), pack);
      await writePrivateJson(join(staging, ".package-origin.json"), origin);
      return await this.plugins.withWriteLock(async () => {
        options.signal?.throwIfAborted();
        this.assertFloor(pack.id, pack.version);
        const current = this.currentRecord(pack.id);
        if (options.expectedVersion !== void 0 && (current?.version ?? null) !== options.expectedVersion || options.expectedSha256 !== void 0 && (current?.packSha256 ?? null) !== options.expectedSha256) throw new AppError(409, "模块已更新，请刷新后基于当前版本重新上传。");
        return this.swap(pack.id, transactionId, { version: pack.version, ...origin, installedAt: (/* @__PURE__ */ new Date()).toISOString(), ...options.note ? { note: options.note } : {}, ...options.actor ? { actor: options.actor } : {} }, "install");
      });
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  async installLocal(directory, options = {}) {
    await this.initialize();
    const pack = await this.describeLocal(directory, true);
    return this.install(pack, (file) => readRegularFile(join(directory, file.path), 8 * 1024 * 1024), { source: "local", ...options });
  }
  async describeLocal(directory, skipGit = false) {
    const manifest = validateManifest(await readPrivateJson(join(directory, "manifest.json"), 255999));
    const files = await packageTree(directory, true, skipGit);
    const base = {
      schemaVersion: 1,
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      kind: manifest.kind !== "script" ? "skill" : "script",
      moduleKind: manifest.kind,
      description: manifest.description,
      channel: manifest.version.split("+")[0].includes("-") ? "beta" : "stable",
      compatibility: { pluginSchemaVersion: 1, minAppVersion: APP_VERSION, opencodeVersion: OPENCODE_VERSION, ...manifest.script ? { runners: [manifest.script.runner] } : {} },
      files,
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    return { ...base, packSha256: packSha256(base) };
  }
  async sealLegacyBackup(directory, record) {
    if (await pathExists(join(directory, "pack.json"))) return record;
    if (record.source === "registry") throw new AppError(400, "当前 Registry 包缺少 pack.json，无法安全备份。");
    const pack = validateRepoPack(await this.describeLocal(directory));
    await validatePackageDirectory(directory, pack);
    const origin = { source: "local", packSha256: pack.packSha256, releaseId: record.releaseId ?? randomUUID() };
    await writePrivateJson(join(directory, "pack.json"), pack);
    await writePrivateJson(join(directory, ".package-origin.json"), origin);
    return { ...record, ...origin };
  }
  async createParents(root, path) {
    const parts = path.split("/").slice(0, -1);
    let target = root;
    for (const part of parts) {
      target = join(target, part);
      await privateDirectory(target);
    }
  }
  async rollback(id, backupId, expectedVersion) {
    await this.initialize();
    this.assertId(id);
    return this.plugins.withWriteLock(async () => {
      const state = await this.readState();
      if (expectedVersion !== void 0 && this.plugins.get(id).manifest.version !== expectedVersion) throw new AppError(409, "模块已更新，请刷新后再恢复版本。");
      const previous = backupId === void 0 ? state.packages[id]?.previous?.[0] : state.packages[id]?.previous.find((item) => item.backupId === backupId);
      if (!previous) throw new AppError(409, "该模块没有可回滚的本地备份，请使用恢复内置。");
      this.assertFloor(id, previous.version);
      const backup = this.backupPath(id, previous.backupId);
      const pack = validateRepoPack(await readPrivateJson(join(backup, "pack.json")));
      if (pack.id !== id || pack.version !== previous.version || previous.packSha256 !== void 0 && previous.packSha256 !== pack.packSha256) throw new AppError(400, "回滚备份与本地状态不一致。");
      await validatePackageDirectory(backup, pack);
      const transactionId = randomUUID(), staging = join(this.root, "staging", transactionId);
      await privateDirectory(staging);
      try {
        for (const file of pack.files) {
          await this.createParents(staging, file.path);
          await writePrivateFile(join(staging, file.path), await readRegularFile(join(backup, file.path), 8 * 1024 * 1024));
        }
        await writePrivateJson(join(staging, "pack.json"), pack);
        await writePrivateJson(join(staging, ".package-origin.json"), { source: previous.source, packSha256: previous.packSha256, releaseId: previous.releaseId });
        await validatePackageDirectory(staging, pack);
        return await this.swap(id, transactionId, { version: previous.version, source: previous.source, packSha256: previous.packSha256, releaseId: previous.releaseId, note: previous.note, actor: previous.actor, installedAt: (/* @__PURE__ */ new Date()).toISOString() }, "rollback");
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    });
  }
  async restoreBuiltin(id, expectedVersion) {
    await this.initialize();
    this.assertId(id);
    return this.plugins.withWriteLock(async () => {
      if (expectedVersion !== void 0 && this.plugins.get(id).manifest.version !== expectedVersion) throw new AppError(409, "模块已更新，请刷新后再恢复版本。");
      const builtin = this.plugins.getBuiltin(id);
      if (!builtin) throw new AppError(404, "该模块没有内置版本。");
      if (this.plugins.get(id).source === "builtin") return this.installed(id, await this.readState());
      return this.swap(id, randomUUID(), { version: builtin.manifest.version, source: "builtin", installedAt: (/* @__PURE__ */ new Date()).toISOString() }, "restore-builtin");
    });
  }
  /** Builtin modules the user removed from the lists; their files stay in the app bundle and can be restored. */
  async disabledBuiltins() {
    try {
      const raw = JSON.parse(await readFile(this.disabledPath, "utf8"));
      if (!Array.isArray(raw)) return [];
      return raw.filter((item) => item && typeof item === "object" && /^[A-Za-z0-9._-]{1,120}$/.test(String(item.id || ""))).map((item) => ({ id: String(item.id), name: String(item.name || item.id), version: String(item.version || "") }));
    } catch {
      return [];
    }
  }
  async writeDisabled(records) {
    await privateDirectory(this.root);
    await writePrivateJson(this.disabledPath, records.map((record) => ({ ...record, disabledAt: (/* @__PURE__ */ new Date()).toISOString() })));
  }
  async disableBuiltin(id) {
    await this.initialize();
    this.assertId(id);
    return this.plugins.withWriteLock(async () => {
      const loaded = this.plugins.get(id);
      if (loaded.source !== "builtin") throw new AppError(409, "该模块有本地版本，请先删除本地版本再停用内置模块。");
      const record = { id, name: loaded.manifest.name, version: loaded.manifest.version };
      const existing = await this.disabledBuiltins();
      if (!existing.some((item) => item.id === id)) await this.writeDisabled([...existing, record]);
      await this.plugins.reload();
      return record;
    });
  }
  async enableBuiltin(id) {
    await this.initialize();
    return this.plugins.withWriteLock(async () => {
      const existing = await this.disabledBuiltins();
      const record = existing.find((item) => item.id === id);
      if (!record) throw new AppError(404, "该模块没有被停用。");
      await this.writeDisabled(existing.filter((item) => item.id !== id));
      await this.plugins.reload();
      try {
        this.plugins.get(id);
      } catch {
        await this.writeDisabled(existing);
        await this.plugins.reload().catch(() => {
        });
        throw new AppError(404, "该模块没有内置版本，无法恢复。");
      }
      return record;
    });
  }
  /** Remove a local override. When a builtin with the same id exists the module falls back to it; otherwise the module disappears. */
  async uninstall(id) {
    await this.initialize();
    this.assertId(id);
    return this.plugins.withWriteLock(async () => {
      const loaded = this.plugins.get(id), builtin = this.plugins.getBuiltin(id), name = loaded.manifest.name;
      if (loaded.source === "builtin") throw new AppError(409, "内置模块不能删除；如需替换请上传新版。");
      if (builtin) {
        const restored = await this.restoreBuiltin(id);
        return { id, name, version: restored.version, source: restored.source, restoredBuiltin: true };
      }
      const active = join(this.dataDir, "plugins", id), transactionId = randomUUID(), backup = this.backupPath(id, transactionId);
      await privateDirectory(dirname(backup));
      await rename(active, backup);
      try {
        await this.plugins.reload();
        const state = await this.readState();
        delete state.packages[id];
        await writePrivateJson(this.statePath, state);
      } catch (error) {
        await rename(backup, active).catch(() => {
        });
        await this.plugins.reload().catch(() => {
        });
        throw error;
      }
      return { id, name, version: loaded.manifest.version, source: loaded.source, restoredBuiltin: false };
    });
  }
  /** The sole writer to dataDir/plugins; caller holds the registry write lock. */
  async swap(id, transactionId, current, action) {
    const active = join(this.dataDir, "plugins", id), staging = join(this.root, "staging", transactionId);
    const backup = this.backupPath(id, transactionId), previousState = await this.readState();
    const hadOverride = await pathExists(active);
    if (hadOverride) {
      const info = await lstat(active);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new AppError(400, "当前模块目录无效。");
    }
    const oldCurrent = previousState.packages[id]?.current ?? this.currentRecord(id);
    const oldPrevious = previousState.packages[id]?.previous ?? [];
    const journal = { schemaVersion: 1, transactionId, pluginId: id, action, phase: "prepared", hadOverride, previousState, createdAt: (/* @__PURE__ */ new Date()).toISOString() };
    await privateDirectory(dirname(backup));
    await writePrivateJson(this.journalPath, journal);
    try {
      let backedUpRecord = oldCurrent;
      if (hadOverride) {
        await rename(active, backup);
        if (oldCurrent) backedUpRecord = await this.sealLegacyBackup(backup, oldCurrent);
      }
      if (action !== "restore-builtin") await rename(staging, active);
      journal.phase = "swapped";
      await writePrivateJson(this.journalPath, journal);
      await this.plugins.reload();
      const loaded = this.plugins.get(id);
      if (loaded.manifest.version !== current.version || loaded.source !== current.source || loaded.packSha256 !== current.packSha256) throw new AppError(400, "包替换后加载结果与目标版本不一致。");
      const history = oldPrevious;
      const previous = hadOverride && backedUpRecord ? [{ ...backedUpRecord, backupId: transactionId }, ...history] : history;
      const state = { ...previousState, packages: { ...previousState.packages, [id]: { current, previous } } };
      await writePrivateJson(this.statePath, state);
      journal.phase = "committed";
      await writePrivateJson(this.journalPath, journal);
      await rm(this.journalPath, { force: true });
      return this.installed(id, state);
    } catch (error) {
      try {
        await this.recoverUnlocked();
        await this.plugins.reload();
      } catch {
        throw new AppError(500, "包安装失败且自动恢复未完成；保留 journal，请重启恢复。");
      }
      throw error instanceof AppError ? error : new AppError(500, this.redactor.text(error instanceof Error ? error.message : "技能包安装失败，已恢复旧版本。"));
    }
  }
  async recoverUnlocked() {
    if (!await pathExists(this.journalPath)) return;
    const journal = await readPrivateJson(this.journalPath);
    if (!journal || journal.schemaVersion !== 1 || !UUID.test(journal.transactionId) || !PACKAGE_ID.test(journal.pluginId) || !["prepared", "swapped", "committed"].includes(journal.phase) || typeof journal.hadOverride !== "boolean" || !journal.previousState || journal.previousState.schemaVersion !== 1) throw new AppError(500, "包事务 journal 损坏，不能自动恢复。");
    const active = join(this.dataDir, "plugins", journal.pluginId), backup = this.backupPath(journal.pluginId, journal.transactionId);
    if (journal.phase !== "committed") {
      if (journal.hadOverride) {
        if (await pathExists(backup)) {
          await rm(active, { recursive: true, force: true });
          await rename(backup, active);
        } else if (!await pathExists(active)) throw new AppError(500, "包事务缺少原版本备份，保留 journal 等待恢复。");
      } else await rm(active, { recursive: true, force: true });
      await writePrivateJson(this.statePath, journal.previousState);
    }
    await rm(join(this.root, "staging", journal.transactionId), { recursive: true, force: true });
    await rm(this.journalPath, { force: true });
  }
}
export {
  PackageInstaller
};
