import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { AppError } from "./errors.js";
import { validateManifest, compareVersions } from "./plugins.js";
import { PackageInstaller } from "./package-installer.js";
import { runProcess } from "./processes.js";
import { preparePackageSnapshot } from "./repo-publisher.js";
import { isWithin } from "./workspaces.js";
const EDITABLE_ROOT_FILES = /* @__PURE__ */ new Set(["manifest.json", "README.md", "provenance.json"]);
const FILES_LIMIT = 2 * 1024 * 1024;
const gitEnv = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
function iso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
function bumpPatch(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
  if (!match) return "0.0.1";
  return `${match[1]}.${match[2]}.${BigInt(match[3]) + 1n}`;
}
async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
function whitelisted(relativePath) {
  const normalized = relativePath.replace(/\\/g, "/");
  if (EDITABLE_ROOT_FILES.has(normalized)) return true;
  return /^scripts\/[A-Za-z_][A-Za-z0-9_]*\.py$/.test(normalized);
}
class ScriptWorkshop {
  constructor(plugins, dataDir, store, redactor, installer = PackageInstaller.for(plugins, dataDir, redactor), publisher) {
    this.plugins = plugins;
    this.dataDir = dataDir;
    this.store = store;
    this.redactor = redactor;
    this.installer = installer;
    this.publisher = publisher;
    this.root = join(dataDir, "script-workshop");
  }
  plugins;
  dataDir;
  store;
  redactor;
  installer;
  publisher;
  root;
  activeCandidates = /* @__PURE__ */ new Map();
  editablePlugins = new Set((process.env.PARTNER_AGENT_EDITABLE_PLUGINS || "").split(",").map((item) => item.trim()).filter(Boolean));
  publishing = false;
  assertEditable(pluginId, user) {
    if (this.editablePlugins.size && !this.editablePlugins.has(pluginId)) throw new AppError(403, "当前部署未授权更新该模块。");
    if (user && user.role !== "admin" && !user.allowedPlugins.includes(pluginId)) throw new AppError(403, "当前账号没有该模块的更新权限。");
  }
  assertOwner(meta, user) {
    if (user && user.role !== "admin" && meta.ownerId !== user.id) throw new AppError(404, "脚本更新不存在。");
    if (user) this.assertEditable(meta.pluginId, user);
  }
  candidateDir(id) {
    return join(this.root, "candidates", id);
  }
  pluginDir(id) {
    return join(this.candidateDir(id), "plugin");
  }
  metaPath(id) {
    return join(this.candidateDir(id), "meta.json");
  }
  async loadMeta(id) {
    if (!/^[A-Za-z0-9-]{8,80}$/.test(id)) throw new AppError(400, "候选编号无效。");
    try {
      return await readJson(this.metaPath(id));
    } catch {
      throw new AppError(404, "脚本候选不存在。");
    }
  }
  async saveMeta(meta) {
    meta.updatedAt = iso();
    await writeFile(this.metaPath(meta.id), JSON.stringify(meta, null, 2) + "\n", { mode: 384 });
  }
  toCandidate(meta, diff) {
    return { ...meta, ...diff !== void 0 ? { diff } : {} };
  }
  async candidateDiff(meta) {
    const directory = this.pluginDir(meta.id);
    await runProcess("git", ["add", "-N", "--all"], { cwd: directory, env: gitEnv, timeoutMs: 3e4 });
    const result = await runProcess("git", ["diff", "--no-ext-diff", "--no-color", "--binary", "HEAD"], { cwd: directory, env: gitEnv, timeoutMs: 3e4, maxOutput: 2e6 });
    return result.code === 0 ? result.stdout : "";
  }
  async changedFiles(meta) {
    const directory = this.pluginDir(meta.id);
    await runProcess("git", ["add", "-N", "--all"], { cwd: directory, env: gitEnv, timeoutMs: 3e4 });
    const result = await runProcess("git", ["diff", "--numstat", "HEAD"], { cwd: directory, env: gitEnv, timeoutMs: 3e4, maxOutput: 2e5 });
    if (result.code !== 0) return meta.files;
    return result.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
      const [added, removed, ...path] = line.split("	");
      return { path: path.join("	"), additions: Number(added) || 0, deletions: Number(removed) || 0 };
    });
  }
  async createCandidate(pluginId, user) {
    return this.plugins.withReadLock(() => this.createCandidateUnlocked(pluginId, user));
  }
  async createCandidateUnlocked(pluginId, user) {
    this.assertEditable(pluginId, user);
    const found = this.plugins.get(pluginId);
    if (found.manifest.kind !== "script" || !found.manifest.script) throw new AppError(400, "只有脚本模块可以进入脚本更新。");
    const id = randomUUID();
    const directory = this.candidateDir(id), plugin = this.pluginDir(id);
    await mkdir(plugin, { recursive: true, mode: 448 });
    const snapshot = await preparePackageSnapshot(found.directory);
    for (const file of snapshot.files) {
      const target = join(plugin, file.path);
      await mkdir(dirname(target), { recursive: true, mode: 448 });
      await writeFile(target, file.content, { mode: 384 });
    }
    for (const args of [
      ["init", "--quiet"],
      ["config", "core.hooksPath", "/dev/null"],
      ["add", "--all"],
      ["-c", "user.name=Partner Agent", "-c", "user.email=local@partner-agent.invalid", "commit", "--quiet", "--allow-empty", "-m", "Candidate baseline"]
    ]) {
      const result = await runProcess("git", args, { cwd: plugin, env: gitEnv, timeoutMs: 3e4 });
      if (result.code !== 0) throw new AppError(400, "无法建立脚本候选基线，请检查 Git 环境。");
    }
    const parameters = found.manifest.script.parameters ?? [];
    const meta = {
      id,
      ownerId: user?.id,
      pluginId,
      pluginName: found.manifest.name,
      baseVersion: found.manifest.version,
      version: found.manifest.version,
      baseDirectory: found.directory,
      baseManifestSha256: sha256(JSON.stringify(found.manifest)),
      baseParametersSha256: sha256(JSON.stringify(parameters)),
      baseKind: found.manifest.kind,
      baseRunner: found.manifest.script.runner,
      status: "editing",
      createdAt: iso(),
      updatedAt: iso(),
      files: []
    };
    await this.saveMeta(meta);
    return this.toCandidate(meta);
  }
  async listCandidates(pluginId, user) {
    const root = join(this.root, "candidates");
    let entries;
    try {
      entries = await readdir(root);
    } catch {
      return [];
    }
    const metas = [];
    for (const entry of entries) {
      try {
        const meta = await readJson(join(root, entry, "meta.json"));
        if ((!pluginId || meta.pluginId === pluginId) && (!user || user.role === "admin" || meta.ownerId === user.id && user.allowedPlugins.includes(meta.pluginId))) metas.push(meta);
      } catch {
      }
    }
    return metas.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).map((meta) => this.toCandidate(meta));
  }
  async getCandidate(id, user) {
    const meta = await this.loadMeta(id);
    this.assertOwner(meta, user);
    const diff = await this.candidateDiff(meta);
    const files = await this.changedFiles(meta);
    meta.files = files;
    await this.saveMeta(meta);
    return this.toCandidate(meta, diff);
  }
  beginEdit(id) {
    if (this.activeCandidates.has(id)) throw new AppError(409, "该脚本正在另一段对话中修改，请等待完成。");
    const token = Symbol(id);
    this.activeCandidates.set(id, token);
    return token;
  }
  endEdit(id, token) {
    if (token === void 0 || this.activeCandidates.get(id) === token) this.activeCandidates.delete(id);
  }
  async resolveEditable(id, relativePath) {
    const meta = await this.loadMeta(id);
    const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!whitelisted(normalized) || normalized.includes("..") || isAbsolute(normalized)) throw new AppError(400, "只能修改候选的 manifest、README、provenance 或 scripts/*.py。");
    const plugin = await realpath(this.pluginDir(id));
    const target = resolve(plugin, normalized);
    if (!isWithin(plugin, target)) throw new AppError(400, "文件路径越出候选目录。");
    let existing;
    try {
      existing = await realpath(target);
    } catch {
      existing = void 0;
    }
    if (existing && !isWithin(plugin, existing)) throw new AppError(400, "文件路径越出候选目录。");
    return { meta, path: target };
  }
  async listFiles(id, user) {
    const meta = await this.loadMeta(id);
    this.assertOwner(meta, user);
    const plugin = this.pluginDir(id);
    const result = [];
    const walk = async (current) => {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        if (entry.name === ".git") continue;
        const full = join(current, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile() && !entry.isSymbolicLink()) result.push(relative(plugin, full).replace(/\\/g, "/"));
      }
    };
    await walk(plugin);
    return result.sort();
  }
  async readFile(id, relativePath, user) {
    const { meta, path } = await this.resolveEditable(id, relativePath);
    this.assertOwner(meta, user);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > FILES_LIMIT) throw new AppError(400, "文件不可读取或过大。");
    return readFile(path, "utf8");
  }
  async writeFile(id, relativePath, content, user) {
    if (Buffer.byteLength(content) > FILES_LIMIT) throw new AppError(400, "写入内容过大。");
    const { meta, path } = await this.resolveEditable(id, relativePath);
    this.assertOwner(meta, user);
    if (meta.status === "published") throw new AppError(409, "候选已发布，请新建候选继续修改。");
    await mkdir(dirname(path), { recursive: true, mode: 448 });
    await writeFile(path, content, { mode: 384 });
    meta.status = "editing";
    meta.checks = void 0;
    await this.saveMeta(meta);
  }
  async checkCandidate(id, user) {
    const meta = await this.loadMeta(id);
    this.assertOwner(meta, user);
    if (meta.status === "published") throw new AppError(409, "候选已发布，请新建候选继续修改。");
    const plugin = this.pluginDir(id);
    const checks = [];
    let manifest;
    try {
      manifest = validateManifest(await readJson(join(plugin, "manifest.json")));
      checks.push({ label: "模块清单", status: "pass", detail: "manifest 结构有效。" });
      if (manifest.id !== meta.pluginId || manifest.kind !== meta.baseKind) throw new AppError(400, "候选不能修改模块 id 或 kind。");
      if (manifest.script?.runner !== meta.baseRunner) throw new AppError(400, "候选不能修改 runner。");
      const parameters = manifest.script?.parameters ?? [];
      if (sha256(JSON.stringify(parameters)) !== meta.baseParametersSha256) throw new AppError(400, "候选不能修改参数 key/type/required/default/options；如需新增参数，请人工修改并升级版本。");
    } catch (error) {
      checks.push({ label: "模块清单", status: "fail", detail: error instanceof Error ? error.message : "manifest 无效。" });
    }
    const pythonFiles = (await this.listFiles(id)).filter((file) => file.endsWith(".py"));
    const required = meta.baseRunner === "finance-sync" ? ["scripts/run_consume.py", "scripts/run_ads.py", "scripts/dapan_sync.py", "scripts/full_review.py", "scripts/sync_log.py", "scripts/codex_lark_adapter.py"] : meta.baseRunner === "h5-sync" ? ["scripts/feishu_h5_sync.py"] : [];
    for (const requiredFile of required) {
      checks.push({ label: `入口 ${requiredFile}`, status: await exists(join(plugin, requiredFile)) ? "pass" : "fail", detail: await exists(join(plugin, requiredFile)) ? "存在。" : "缺少必需脚本。" });
    }
    if (pythonFiles.length) {
      const python = process.env.PARTNER_AGENT_PYTHON || "python3";
      const code = 'import ast,sys,tokenize; assert sys.version_info >= (3,8), "Python 3.8+ required"; [ast.parse(tokenize.open(p).read(), filename=p) for p in sys.argv[1:]]';
      const result = await runProcess(python, ["-I", "-B", "-c", code, ...pythonFiles.map((file) => join(plugin, file))], { signal: AbortSignal.timeout(3e4), timeoutMs: 3e4, maxOutput: 1e5, env: { PYTHONPATH: "", PYTHONSTARTUP: "", PYTHONDONTWRITEBYTECODE: "1" } }).catch((error) => ({ code: 1, stdout: "", stderr: error instanceof Error ? error.message : "Python 检查失败。" }));
      checks.push({ label: "Python 语法", status: result.code === 0 ? "pass" : "fail", detail: result.code === 0 ? "全部 Python 文件语法检查通过，未执行业务逻辑。" : (result.stderr || result.stdout || "语法检查失败。").slice(0, 2e3) });
    }
    const warnings = [];
    for (const file of pythonFiles) {
      let content = "";
      try {
        content = await readFile(join(plugin, file), "utf8");
      } catch {
        continue;
      }
      if (/os\.system\s*\(|subprocess\.|eval\s*\(|exec\s*\(/.test(content)) warnings.push(`${file} 含进程或动态执行调用`);
      if (/(?:^|[^A-Za-z])(?:\/Users\/|\/home\/|[A-Za-z]:\\\\)/.test(content)) warnings.push(`${file} 含本机绝对路径`);
      if (/https?:\/\/(?!open\.feishu\.cn|lark)/.test(content)) warnings.push(`${file} 含外部网络地址`);
    }
    checks.push({ label: "静态风险扫描", status: warnings.length ? "warn" : "pass", detail: warnings.length ? warnings.join("；") : "未发现明显的进程、绝对路径或外部网络调用。" });
    const failed = checks.some((check) => check.status === "fail");
    meta.checks = checks;
    meta.status = failed ? "editing" : "ready";
    meta.error = failed ? "检查未通过" : void 0;
    await this.saveMeta(meta);
    return { candidate: await this.getCandidate(id), checks };
  }
  async nextVersion(pluginId, baseVersion) {
    const active = this.plugins.list().find((plugin) => plugin.id === pluginId)?.version || baseVersion;
    const releases = [...this.store.listReleases(pluginId), ...await this.installer.history(pluginId)];
    const highest = releases.reduce((version, release) => compareVersions(release.version, version) > 0 ? release.version : version, active);
    return bumpPatch(compareVersions(highest, baseVersion) > 0 ? highest : baseVersion);
  }
  async publishCandidate(id, user, editToken, signal) {
    const requested = await this.loadMeta(id);
    this.assertOwner(requested, user);
    this.assertEditable(requested.pluginId, user);
    if (this.publishing) throw new AppError(409, "已有发布正在进行。");
    if (this.activeCandidates.has(id) && this.activeCandidates.get(id) !== editToken) throw new AppError(409, "候选正在被编辑，停止对话后再发布。");
    this.publishing = true;
    try {
      signal?.throwIfAborted();
      const checked = await this.checkCandidate(id);
      signal?.throwIfAborted();
      if (checked.checks.some((check) => check.status === "fail")) throw new AppError(400, "候选检查未通过，不能发布。");
      const meta = await this.loadMeta(id);
      if (meta.status === "published") throw new AppError(409, "候选已发布，请新建候选继续修改。");
      const plugin = this.pluginDir(id);
      const previousVersion = this.plugins.list().find((item) => item.id === meta.pluginId)?.version || meta.baseVersion;
      const manifest = await readJson(join(plugin, "manifest.json"));
      const version = await this.nextVersion(meta.pluginId, meta.baseVersion);
      manifest.version = version;
      await writeFile(join(plugin, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 384 });
      const release = { id: randomUUID(), ownerId: meta.ownerId, pluginId: meta.pluginId, version, previousVersion, action: "publish", createdAt: iso(), candidateId: meta.id, ...meta.pluginId === "finance-sync" && process.env.PARTNER_FINANCE_SCRIPT_PATH ? { note: "检测到 PARTNER_FINANCE_SCRIPT_PATH，本机覆盖可能不会影响 finance 实际执行。" } : {} };
      await this.installer.installLocal(plugin, { releaseId: release.id, expectedVersion: meta.baseVersion, signal });
      this.store.saveRelease(release);
      meta.status = "published";
      meta.version = version;
      meta.checks = checked.checks;
      meta.files = await this.changedFiles(meta);
      await this.saveMeta(meta);
      return { candidate: this.toCandidate(meta, await this.candidateDiff(meta)), release, version };
    } finally {
      this.publishing = false;
    }
  }
  /** Published candidates are immutable snapshots, so a push cannot race a local install. */
  async pushCandidate(id, user) {
    const meta = await this.loadMeta(id);
    this.assertOwner(meta, user);
    this.assertEditable(meta.pluginId, user);
    if (meta.status !== "published") throw new AppError(409, "修改尚未通过检查并在本机生效，不能推送。");
    if (!this.publisher) return { status: "unbound" };
    return this.publisher.publishDirectory(this.pluginDir(id));
  }
  async rollback(pluginId, user) {
    this.assertEditable(pluginId, user);
    const plugin = this.plugins.list().find((item) => item.id === pluginId);
    if (!plugin) throw new AppError(404, "未找到要回滚的模块。");
    const previousVersion = plugin.version;
    const result = await this.installer.rollback(pluginId);
    const version = result.version;
    const release = { id: randomUUID(), ownerId: user?.id, pluginId, version, previousVersion, action: "rollback", createdAt: iso(), note: result.source === "builtin" ? "已回退到内置版本。" : "已恢复上一个本机版本。" };
    this.store.saveRelease(release);
    return { release, version };
  }
  async restoreBuiltin(pluginId, user) {
    this.assertEditable(pluginId, user);
    const result = await this.installer.restoreBuiltin(pluginId);
    return { version: result.version };
  }
  listReleases(pluginId) {
    return this.store.listReleases(pluginId);
  }
}
export {
  ScriptWorkshop
};
