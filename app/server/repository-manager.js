import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { AppError } from "./errors.js";
import { allowedPackPath, assertPackFiles, compareSemver, PACK_LIMITS, sha256, validPackId, validPackPath, validPackVersion } from "./pack-utils.js";
import { pathExists, privateDirectory, readPrivateJson, writePrivateFile, writePrivateJson } from "./package-validation.js";
import { validateManifest } from "./plugins.js";
import { preparePackageSnapshot } from "./repo-publisher.js";
import { createStoredZip } from "./zip-store.js";
const REPOSITORY_UPLOAD_LIMIT = Math.ceil(PACK_LIMITS.totalBytes * 4 / 3) + 2 * 1024 * 1024;
function need(condition, message) {
  if (!condition) throw new AppError(400, message);
}
function nextVersion(versions) {
  const latest = [...versions].sort(compareSemver).at(-1);
  const [major, minor, patch] = latest.split(/[+-]/)[0].split(".");
  return `${major}.${minor}.${BigInt(patch) + 1n}`;
}
function validateUploadInput(input) {
  need(input && typeof input === "object", "上传内容无效。");
  need(input.note === void 0 || typeof input.note === "string" && input.note.length <= 2e3, "更新说明不能超过 2000 字。");
  need(input.version === void 0 || input.version === "" || typeof input.version === "string" && validPackVersion(input.version), "版本号须使用如 1.2.3 的格式。");
  need(Array.isArray(input.files) && input.files.length > 0 && input.files.length <= PACK_LIMITS.files, "请选择文件，最多支持 2000 个文件。");
}
function decodeUploadFiles(input, profile, resourcesOnly = false) {
  const uploaded = /* @__PURE__ */ new Map(), seen = /* @__PURE__ */ new Set();
  let total = 0;
  for (const file of input.files) {
    need(file && typeof file.path === "string" && validPackPath(file.path), "上传文件路径无效。");
    const path = profile ? posix.join(posix.dirname(profile.skill.path), file.path) : file.path;
    need(allowedPackPath(path), `文件不在模块资源范围内：${file.path}`);
    if (resourcesOnly) need(path.startsWith("scripts/") || path.startsWith("skills/"), "资源更新仅支持 scripts/ 或 skills/ 内的文件；修改 manifest 请上传完整模块。");
    need(!seen.has(path.toLowerCase()), `文件路径重复：${file.path}`);
    seen.add(path.toLowerCase());
    need(typeof file.contentBase64 === "string" && file.contentBase64.length <= Math.ceil(PACK_LIMITS.fileBytes / 3) * 4, "单个文件不能超过 8 MiB。");
    const content = Buffer.from(file.contentBase64, "base64");
    need(content.toString("base64") === file.contentBase64 && content.length <= PACK_LIMITS.fileBytes, "文件编码或大小无效。");
    total += content.length;
    need(total <= PACK_LIMITS.totalBytes, "上传总大小不能超过 50 MiB。");
    uploaded.set(path, content);
  }
  return uploaded;
}
function uploadedManifest(files) {
  need(files.has("manifest.json"), "完整模块目录必须包含 manifest.json。");
  let raw;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(files.get("manifest.json")));
  } catch {
    throw new AppError(400, "manifest.json 不是有效的 UTF-8 JSON 文件。");
  }
  return validateManifest(raw);
}
class RepositoryManager {
  constructor(installer, repo, redactor) {
    this.installer = installer;
    this.repo = repo;
    this.redactor = redactor;
    this.root = join(installer.root, "repository-uploads");
    this.publicationPath = join(installer.root, "repository-publications.json");
  }
  installer;
  repo;
  redactor;
  root;
  publicationPath;
  publications = {};
  busy = false;
  async initialize() {
    await privateDirectory(this.root);
    if (await pathExists(this.publicationPath)) {
      const records = await readPrivateJson(this.publicationPath);
      need(records && typeof records === "object" && !Array.isArray(records), "仓库发布记录损坏。");
      this.publications = records;
    }
  }
  assertId(id) {
    need(validPackId(id), "模块 id 无效。");
    this.installer.plugins.get(id);
  }
  assertEditable(id, installed = true) {
    if (installed) this.assertId(id);
    else need(validPackId(id), "模块 id 无效。");
    const allowed = (process.env.PARTNER_AGENT_EDITABLE_PLUGINS || "").split(",").map((value) => value.trim()).filter(Boolean);
    if (allowed.length && !allowed.includes(id)) throw new AppError(403, "当前部署未授权更新该模块。");
  }
  async state() {
    return this.installer.plugins.withReadLock(async () => {
      const remote = await this.repo.status();
      const modules = await Promise.all((remote.installed ?? []).map(async (installed) => {
        const manifest = structuredClone(this.installer.plugins.get(installed.id).manifest);
        const versions = await this.installer.history(installed.id);
        const cloudVersions = remote.catalog?.filter((item) => item.id === installed.id).map((item) => item.version) ?? [];
        return {
          manifest,
          installed,
          versions,
          nextVersion: nextVersion([...versions.map((item) => item.version), ...cloudVersions]),
          publication: installed.sha256 ? this.publications[`${installed.id}:${installed.sha256}`] : void 0,
          externalScriptOverride: manifest.script?.runner === "external" || installed.id === "finance-sync" && !!process.env.PARTNER_FINANCE_SCRIPT_PATH
        };
      }));
      return { modules, remote, disabledBuiltins: await this.installer.disabledBuiltins() };
    });
  }
  async detail(id) {
    this.assertId(id);
    return this.installer.plugins.withReadLock(async () => {
      const module = (await this.state()).modules.find((item) => item.manifest.id === id);
      const publication = await preparePackageSnapshot(this.installer.plugins.get(id).directory);
      return { ...module, files: publication.files.map(({ path, size, sha256: sha2562 }) => ({ path, size, sha256: sha2562 })) };
    });
  }
  async file(id, path) {
    this.assertId(id);
    need(allowedPackPath(path), "文件路径无效。");
    return this.installer.plugins.withReadLock(async () => {
      const publication = await preparePackageSnapshot(this.installer.plugins.get(id).directory);
      const file = publication.files.find((item) => item.path === path);
      if (!file) throw new AppError(404, "模块文件不存在。");
      let content = null;
      if (file.size <= 1024 * 1024 && !file.content.includes(0)) {
        try {
          content = new TextDecoder("utf-8", { fatal: true }).decode(file.content);
        } catch {
        }
      }
      return { path, content, size: file.size };
    });
  }
  async mutate(work) {
    if (this.busy) throw new AppError(409, "仓库正在处理另一项更新，请完成后重试。");
    this.busy = true;
    try {
      return await work();
    } finally {
      this.busy = false;
    }
  }
  async savePublication(id, hash, result) {
    this.publications[`${id}:${hash}`] = result;
    await writePrivateJson(this.publicationPath, this.publications);
  }
  async publishSnapshot(id, version, hash, directory) {
    let result;
    try {
      const published = await this.repo.publishDirectory(directory);
      result = { status: published.status, version, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
    } catch (error) {
      result = { status: "failed", version, updatedAt: (/* @__PURE__ */ new Date()).toISOString(), message: this.redactor.text(error instanceof AppError ? error.message : "云端发布失败，可稍后重试。") };
    }
    await this.savePublication(id, hash, result);
    return result;
  }
  async writeTree(directory, files) {
    await privateDirectory(directory);
    for (const [path, content] of files) {
      await mkdir(dirname(join(directory, path)), { recursive: true, mode: 448 });
      await writePrivateFile(join(directory, path), content);
    }
  }
  async importModule(input, user) {
    validateUploadInput(input);
    const files = decodeUploadFiles(input), manifest = uploadedManifest(files);
    this.assertEditable(manifest.id, false);
    return this.mutate(async () => {
      const directory = join(this.root, randomUUID());
      try {
        if (this.installer.plugins.list().some((item) => item.id === manifest.id)) throw new AppError(409, "此模块已存在，请选择更新此模块并上传新版本。");
        manifest.version = input.version || manifest.version;
        files.set("manifest.json", Buffer.from(JSON.stringify(manifest, null, 2) + "\n"));
        assertPackFiles([...files].map(([path, content]) => ({ path, size: content.length, sha256: sha256(content) })));
        await this.writeTree(directory, files);
        await preparePackageSnapshot(directory);
        const installed = await this.installer.installLocal(directory, {
          expectedVersion: null,
          expectedSha256: null,
          note: input.note?.trim(),
          actor: user.displayName || user.username
        });
        const publication = await this.publishSnapshot(manifest.id, installed.version, installed.sha256, directory);
        return { module: await this.detail(manifest.id), publication };
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
  async upload(id, input, user) {
    this.assertEditable(id);
    need(input && ["module", "skill", "files"].includes(input.mode), "请选择上传方式。");
    need(typeof input.baseVersion === "string" && validPackVersion(input.baseVersion), "请刷新并选择当前模块版本。");
    need(input.baseSha256 === void 0 || typeof input.baseSha256 === "string" && /^[a-f0-9]{64}$/.test(input.baseSha256), "当前版本校验值无效。");
    validateUploadInput(input);
    return this.mutate(async () => {
      const directory = join(this.root, randomUUID());
      try {
        const snapshot = await this.installer.plugins.withReadLock(async () => {
          const current = this.installer.plugins.get(id);
          if (current.manifest.version !== input.baseVersion || current.packSha256 !== input.baseSha256) throw new AppError(409, "模块已更新，请刷新后重新上传。");
          return {
            current: structuredClone(current.manifest),
            hash: current.packSha256,
            publication: await preparePackageSnapshot(current.directory),
            module: await this.detail(id)
          };
        });
        const profile = input.mode === "skill" ? snapshot.current.profiles.find((item) => item.id === input.profileId) : void 0;
        if (input.mode === "skill") need(profile, "请选择要替换的 Skill。");
        const uploaded = decodeUploadFiles(input, profile, input.mode === "files");
        if (profile) need(uploaded.has(profile.skill.path), "Skill 上传须包含 SKILL.md，可同时包含 references、scripts 和 assets 等资源。");
        const files = input.mode === "module" ? uploaded : new Map(snapshot.publication.files.map((file) => [file.path, file.content]));
        if (input.mode !== "module") for (const [path, content] of uploaded) files.set(path, content);
        const manifest = uploadedManifest(files);
        need(manifest.id === id, "上传模块的 id 与所选模块不一致。");
        need(manifest.kind === snapshot.current.kind, "上传模块的类型与所选模块不一致。");
        const version = input.version || (input.mode === "module" && compareSemver(manifest.version, snapshot.module.nextVersion) > 0 ? manifest.version : snapshot.module.nextVersion);
        const highest = snapshot.module.versions.map((item) => item.version).sort(compareSemver).at(-1);
        if (compareSemver(version, highest) <= 0) throw new AppError(409, `新版号必须高于历史版本 ${highest}；恢复旧版请使用版本历史。`);
        manifest.version = version;
        for (const item of manifest.profiles) {
          const skillRoot = posix.dirname(item.skill.path);
          if (input.mode === "module" || [...uploaded.keys()].some((path) => path === item.skill.path || skillRoot !== "." && path.startsWith(`${skillRoot}/`))) {
            item.version = version;
            item.skill.version = version;
          }
        }
        files.set("manifest.json", Buffer.from(JSON.stringify(manifest, null, 2) + "\n"));
        assertPackFiles([...files].map(([path, content]) => ({ path, size: content.length, sha256: sha256(content) })));
        await this.writeTree(directory, files);
        await preparePackageSnapshot(directory);
        const installed = await this.installer.installLocal(directory, {
          expectedVersion: input.baseVersion,
          expectedSha256: snapshot.hash ?? null,
          note: input.note?.trim(),
          actor: user.displayName || user.username
        });
        const publication = await this.publishSnapshot(id, installed.version, installed.sha256, directory);
        return { module: await this.detail(id), publication };
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
  async restore(id, input) {
    this.assertEditable(id);
    need(typeof input.versionId === "string" && (input.versionId === "builtin" || /^[a-f0-9-]{36}$/.test(input.versionId)), "请选择可恢复的历史版本。");
    need(typeof input.baseVersion === "string" && validPackVersion(input.baseVersion), "当前版本无效，请刷新后重试。");
    const versionId = input.versionId, baseVersion = input.baseVersion;
    return this.mutate(async () => {
      if (versionId === "builtin") await this.installer.restoreBuiltin(id, baseVersion);
      else await this.installer.rollback(id, versionId, baseVersion);
      return { module: await this.detail(id) };
    });
  }
  async uninstall(id) {
    this.assertEditable(id);
    return this.mutate(async () => {
      const loaded = this.installer.plugins.get(id);
      if (loaded.source === "builtin") {
        if (loaded.manifest.kind !== "sdk" || id === "gp-build") throw new AppError(409, "该内置模块不能删除。");
        const disabled = await this.installer.disableBuiltin(id);
        return { id, name: disabled.name, version: disabled.version, restoredBuiltin: false, disabled: true };
      }
      const result = await this.installer.uninstall(id);
      return { id, name: result.name, version: result.version, restoredBuiltin: result.restoredBuiltin };
    });
  }
  async download(id) {
    this.assertId(id);
    return this.installer.plugins.withReadLock(async () => {
      const loaded = this.installer.plugins.get(id);
      const snapshot = await preparePackageSnapshot(loaded.directory);
      const entries = snapshot.files.filter((file) => file.path !== "pack.json" && allowedPackPath(file.path)).map((file) => ({ name: file.path, data: file.content }));
      return { filename: `${id}-v${loaded.manifest.version}.zip`, version: loaded.manifest.version, content: createStoredZip(entries) };
    });
  }
  async enable(id) {
    need(validPackId(id), "模块 id 无效。");
    return this.mutate(() => this.installer.enableBuiltin(id));
  }
  async yank(id, version) {
    this.assertId(id);
    need(typeof version === "string" && validPackVersion(version), "版本号无效。");
    return this.mutate(async () => {
      const result = await this.repo.yank(id, version);
      return { id, version, status: result.status };
    });
  }
  async publish(id, baseVersion) {
    this.assertEditable(id);
    need(typeof baseVersion === "string", "请指定要推送的当前版本。");
    return this.mutate(async () => {
      const directory = join(this.root, randomUUID());
      try {
        const snapshot = await this.installer.plugins.withReadLock(async () => {
          const current = this.installer.plugins.get(id);
          if (current.manifest.version !== baseVersion) throw new AppError(409, "模块已更新，请刷新后重试。");
          need(current.packSha256, "请先上传一个新版再推送。");
          return { hash: current.packSha256, publication: await preparePackageSnapshot(current.directory) };
        });
        await this.writeTree(directory, new Map(snapshot.publication.files.map((file) => [file.path, file.content])));
        const publication = await this.publishSnapshot(id, baseVersion, snapshot.hash, directory);
        return { module: await this.detail(id), publication };
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
}
export {
  REPOSITORY_UPLOAD_LIMIT,
  RepositoryManager
};
