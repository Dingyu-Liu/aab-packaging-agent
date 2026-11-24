import { readFile, readdir, lstat, realpath } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { AppError } from "./errors.js";
import { exists } from "./projects.js";
import { compareSemver as compareVersions } from "./pack-utils.js";
import { compareSemver } from "./pack-utils.js";
import { packageLockFor } from "./package-lock.js";
import { validateManifest } from "./manifest-validation.js";
import { validateManifest as validateManifest2 } from "./manifest-validation.js";
function need(condition, message) {
  if (!condition) throw new AppError(400, `模块格式错误：${message}`);
}
function validateParameters(defs, input, required) {
  const output = {};
  const known = new Set(defs.map((field) => field.key));
  for (const key of Object.keys(input)) if (!known.has(key)) throw new AppError(400, `未知参数「${key}」，请刷新模块后重试。`);
  for (const def of defs) {
    const value = input[def.key] ?? def.default;
    if (value === void 0 || value === "") {
      if (required && def.required) throw new AppError(400, `请填写「${def.label}」。`);
      if (value === "") output[def.key] = "";
      continue;
    }
    if (def.type === "boolean") {
      if (typeof value !== "boolean") throw new AppError(400, `「${def.label}」必须是开关值。`);
    } else if (def.type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) throw new AppError(400, `「${def.label}」必须是有效数字。`);
    } else {
      if (typeof value !== "string" || value.length > 1e5) throw new AppError(400, `「${def.label}」格式无效。`);
    }
    if (def.type === "select" && !def.options?.some((option) => option.value === value)) throw new AppError(400, `「${def.label}」的选项无效。`);
    if (["eventMapping", "adjustEventMapping", "argumentsJson"].includes(def.key) && typeof value === "string" && value.trim()) {
      try {
        JSON.parse(value);
      } catch {
        throw new AppError(400, `「${def.label}」须为合法 JSON。`);
      }
    }
    if (["versionCode", "attributionWaitSeconds", "paMode", "paAtt"].includes(def.key) && typeof value === "number" && (!Number.isInteger(value) || value < 0)) throw new AppError(400, `「${def.label}」须为非负整数。`);
    output[def.key] = value;
  }
  return output;
}
class PluginRegistry {
  constructor(appRoot, dataDir) {
    this.appRoot = appRoot;
    this.dataDir = dataDir;
    this.moduleLock = packageLockFor(dataDir);
  }
  appRoot;
  dataDir;
  manifests = /* @__PURE__ */ new Map();
  builtins = /* @__PURE__ */ new Map();
  moduleLock;
  withReadLock(fn) {
    return this.moduleLock.withReadLock(fn);
  }
  withWriteLock(fn) {
    return this.moduleLock.withWriteLock(fn);
  }
  exclusive(fn) {
    return this.withWriteLock(fn);
  }
  reload() {
    return this.withWriteLock(() => this.reloadUnlocked());
  }
  async reloadUnlocked() {
    const next = /* @__PURE__ */ new Map(), builtins = /* @__PURE__ */ new Map();
    const disabled = /* @__PURE__ */ new Set();
    try {
      const raw = JSON.parse(await readFile(join(this.dataDir, "packages", "disabled-modules.json"), "utf8"));
      if (Array.isArray(raw)) for (const item of raw) {
        const id = typeof item === "string" ? item : item && typeof item === "object" ? String(item.id || "") : "";
        if (/^[A-Za-z0-9._-]{1,120}$/.test(id)) disabled.add(id);
      }
    } catch {
    }
    for (const [root, source] of [[join(this.appRoot, "plugins"), "builtin"], [join(this.dataDir, "plugins"), "local"]]) {
      if (!await exists(root)) continue;
      need(!(await lstat(root)).isSymbolicLink(), "模块根目录不能是符号链接");
      for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith(".")) continue;
        if (source === "builtin" && disabled.has(entry.name)) continue;
        need(!entry.isSymbolicLink(), "模块目录不能是符号链接");
        if (!entry.isDirectory()) continue;
        const directory = join(root, entry.name), file = join(directory, "manifest.json");
        if (!await exists(file)) continue;
        const stat = await lstat(file);
        need(stat.isFile() && !stat.isSymbolicLink() && stat.size < 256e3, "manifest 过大或使用了符号链接");
        let raw;
        try {
          raw = JSON.parse(await readFile(file, "utf8"));
        } catch {
          throw new AppError(400, `模块 ${entry.name} 的 manifest.json 不是合法 JSON。`);
        }
        const manifest = validateManifest(raw);
        need(manifest.id === entry.name, "模块目录名称必须与 id 一致");
        if (next.has(manifest.id)) {
          const old = next.get(manifest.id).manifest;
          if (compareVersions(manifest.version, old.version) <= 0) throw new AppError(400, `自定义模块 ${manifest.id} 的版本必须高于内置版本 ${old.version}。`);
        }
        for (const profile of manifest.profiles) await skillPath(directory, profile);
        let origin = { source };
        const originFile = join(directory, ".package-origin.json");
        if (source !== "builtin" && await exists(originFile)) {
          const info = await lstat(originFile);
          need(info.isFile() && !info.isSymbolicLink() && info.size < 16384, "包来源文件无效");
          const value = JSON.parse(await readFile(originFile, "utf8"));
          need(["registry", "local"].includes(value.source), "包来源无效");
          need(value.packSha256 === void 0 || /^[a-f0-9]{64}$/.test(value.packSha256), "包 SHA-256 无效");
          need(value.releaseId === void 0 || typeof value.releaseId === "string" && /^[a-zA-Z0-9._:-]{1,200}$/.test(value.releaseId), "包 releaseId 无效");
          origin = { source: value.source, ...value.packSha256 ? { packSha256: value.packSha256 } : {}, ...value.releaseId ? { releaseId: value.releaseId } : {} };
        }
        const loaded = { manifest, directory, ...origin };
        next.set(manifest.id, loaded);
        if (source === "builtin") builtins.set(manifest.id, loaded);
      }
    }
    this.manifests = next;
    this.builtins = builtins;
    return this.list();
  }
  list() {
    return [...this.manifests.values()].map((item) => structuredClone(item.manifest));
  }
  get(id) {
    const found = this.manifests.get(id);
    if (!found) throw new AppError(404, "未找到所选业务模块。");
    return structuredClone(found);
  }
  getBuiltin(id) {
    const found = this.builtins.get(id);
    return found ? structuredClone(found) : void 0;
  }
}
async function skillPath(directory, profile) {
  const root = await realpath(directory), path = await realpath(resolve(directory, profile.skill.path)).catch(() => {
    throw new AppError(400, `找不到 ${profile.name} 的 skill 文件。`);
  });
  const rel = relative(root, path);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new AppError(400, "skill 路径越出了模块目录。");
  if (!(await lstat(path)).isFile()) throw new AppError(400, "skill 路径必须指向 SKILL.md 文件。");
  return path;
}
export {
  PluginRegistry,
  compareSemver as compareVersions,
  skillPath,
  validateManifest2 as validateManifest,
  validateParameters
};
