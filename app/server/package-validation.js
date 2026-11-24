import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { AppError } from "./errors.js";
import { allowedPackPath, assertPackFiles, packSha256, sha256, validPackPath, validPackVersion } from "./pack-utils.js";
import { compareVersions, skillPath, validateManifest } from "./plugins.js";
const APP_VERSION = "0.1.0";
const OPENCODE_VERSION = "1.19.5";
const PACKAGE_ID = /^[a-z0-9][a-z0-9-]{1,79}$/;
function validPackageVersion(value) {
  return typeof value === "string" && validPackVersion(value);
}
function allowedPackageFile(path) {
  return allowedPackPath(path);
}
function need(condition, message) {
  if (!condition) throw new AppError(400, message);
}
function validateRepoPack(input, options = {}) {
  need(input && typeof input === "object" && !Array.isArray(input), "技能包描述无效。");
  const pack = structuredClone(input);
  need(pack.schemaVersion === 1 && typeof pack.id === "string" && PACKAGE_ID.test(pack.id), "技能包 id 或 schemaVersion 无效。");
  need(validPackageVersion(pack.version), "技能包版本必须是合法语义版本。");
  need(typeof pack.name === "string" && pack.name.length > 0 && pack.name.length < 1e3 && typeof pack.description === "string" && pack.description.length < 1e5, "技能包描述字段无效。");
  need(["skill", "script"].includes(pack.kind) && ["sdk", "script", "website"].includes(pack.moduleKind), "技能包类型无效。");
  need(pack.kind === "script" === (pack.moduleKind === "script"), "技能包模块类型不一致。");
  need(["stable", "beta"].includes(pack.channel) && !(pack.channel === "stable" && pack.version.split("+")[0].includes("-")), "技能包发布通道无效。");
  need(typeof pack.createdAt === "string" && Number.isFinite(Date.parse(pack.createdAt)), "技能包发布时间无效。");
  need(Array.isArray(pack.files) && pack.files.every((file) => file && typeof file === "object"), "技能包文件清单无效。");
  assertPackFiles(pack.files);
  const folded = new Set(pack.files.map((file) => file.path.toLowerCase()));
  for (const file of pack.files) {
    need(allowedPackageFile(file.path), `技能包文件不在白名单：${file.path}`);
    const parts = file.path.toLowerCase().split("/");
    for (let i = 1; i < parts.length; i += 1) need(!folded.has(parts.slice(0, i).join("/")), "技能包文件与目录冲突。");
  }
  need(pack.files.some((file) => file.path === "manifest.json"), "技能包缺少 manifest.json。");
  need(typeof pack.packSha256 === "string" && /^[a-f0-9]{64}$/.test(pack.packSha256) && packSha256(pack) === pack.packSha256, "技能包描述 SHA-256 校验失败。");
  const compatibility = pack.compatibility;
  need(compatibility && typeof compatibility === "object" && compatibility.pluginSchemaVersion === 1, "技能包 manifest schema 不兼容。");
  for (const key of ["minAppVersion", "maxAppVersion"]) if (compatibility[key] !== void 0) need(validPackageVersion(compatibility[key]), "技能包应用兼容范围无效。");
  const appVersion = options.appVersion ?? APP_VERSION;
  need(!compatibility.minAppVersion || compareVersions(appVersion, compatibility.minAppVersion) >= 0, `技能包需要应用版本 ${compatibility.minAppVersion} 或以上。`);
  need(!compatibility.maxAppVersion || compareVersions(appVersion, compatibility.maxAppVersion) <= 0, `技能包仅兼容应用版本 ${compatibility.maxAppVersion} 或以下。`);
  need(!compatibility.opencodeVersion || compatibility.opencodeVersion === (options.opencodeVersion ?? OPENCODE_VERSION), "技能包 OpenCode 版本不兼容。");
  if (compatibility.runners !== void 0) need(Array.isArray(compatibility.runners) && compatibility.runners.every((runner) => ["finance-sync", "h5-sync", "external"].includes(runner)), "技能包 runner 不兼容。");
  return pack;
}
async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 448 });
  const info = await lstat(path);
  need(info.isDirectory() && !info.isSymbolicLink(), "包管理目录不能使用符号链接。");
}
async function readRegularFile(path, limit) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    need(info.isFile() && info.nlink === 1 && info.size <= limit, "包文件不是普通文件、使用硬链接或超过大小上限。");
    const buffer = Buffer.alloc(Math.min(info.size + 1, limit + 1));
    let bytes = 0;
    while (bytes < buffer.length) {
      const read = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
    }
    need(bytes === info.size && bytes <= limit, "读取时包文件内容发生变化。");
    return buffer.subarray(0, bytes);
  } finally {
    await handle.close();
  }
}
async function writePrivateFile(path, data) {
  const temporary = join(dirname(path), `.write-${randomUUID()}`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 384);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    const directory = await open(dirname(path), constants.O_RDONLY);
    try {
      await directory.sync();
    } catch (error) {
      if (!["EINVAL", "ENOTSUP", "EBADF"].includes(error.code ?? "")) throw error;
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}
async function writePrivateJson(path, value) {
  await writePrivateFile(path, JSON.stringify(value, null, 2) + "\n");
}
async function readPrivateJson(path, limit = 4 * 1024 * 1024) {
  return JSON.parse((await readRegularFile(path, limit)).toString("utf8"));
}
async function packageTree(directory, skipMetadata = false, skipGit = false) {
  need((await lstat(directory)).isDirectory() && !(await lstat(directory)).isSymbolicLink(), "技能包目录必须是普通目录。");
  const files = [];
  const walk = async (prefix) => {
    for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!prefix && (skipMetadata && ["pack.json", ".package-origin.json"].includes(entry.name) || skipGit && entry.name === ".git")) continue;
      need(!entry.isSymbolicLink(), "技能包不允许符号链接。");
      if (entry.isDirectory()) {
        need(validPackPath(path) && !path.split("/").some((part) => part.startsWith(".") || ["node_modules", "__pycache__"].includes(part)), "技能包目录无效。");
        need(path.split("/").length <= 16, "技能包目录层数过多。");
        await walk(path);
      } else {
        need(entry.isFile() && allowedPackageFile(path), `技能包文件不在白名单：${path}`);
        const content = await readRegularFile(join(directory, path), path === "manifest.json" ? 255999 : 8 * 1024 * 1024);
        files.push({ path, size: content.length, sha256: sha256(content) });
        need(files.length <= 2e3 && files.reduce((sum, file) => sum + file.size, 0) <= 50 * 1024 * 1024, "技能包超过文件数量或总大小上限。");
      }
    }
  };
  await walk("");
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
async function validatePackageDirectory(directory, pack) {
  const actual = await packageTree(directory, true);
  need(actual.length === pack.files.length, "staging 文件数量与清单不一致。");
  const expected = new Map(pack.files.map((file) => [file.path, file]));
  for (const file of actual) {
    const declared = expected.get(file.path);
    need(declared && file.size === declared.size && file.sha256 === declared.sha256, `技能包文件 SHA-256 校验失败：${file.path}`);
  }
  const manifest = validateManifest(await readPrivateJson(join(directory, "manifest.json"), 255999));
  need(manifest.id === pack.id && manifest.version === pack.version && manifest.kind === pack.moduleKind, "pack 与 manifest 的 id、版本或类型不一致。");
  for (const profile of manifest.profiles) {
    need(/(?:^|\/)SKILL\.md$/.test(profile.skill.path) && validPackPath(profile.skill.path) && expected.has(profile.skill.path), "Skill 必须引用包内的 SKILL.md。");
    const path = await skillPath(directory, profile);
    need((await readRegularFile(path, 1024 * 1024)).toString("utf8").trim().length > 0, "Skill 内容不能为空。");
  }
  if (manifest.kind === "website") {
    need(expected.has("scripts/generation-prompt.txt"), "网站模块缺少生成说明。");
    need((await readRegularFile(join(directory, "scripts", "generation-prompt.txt"), 64e3)).toString("utf8").trim().length > 0, "网站模块的生成说明不能为空。");
  }
  if (manifest.script) {
    need(!pack.compatibility.runners || pack.compatibility.runners.includes(manifest.script.runner), "manifest runner 不在包兼容列表内。");
    const required = manifest.script.runner === "finance-sync" ? ["scripts/run_consume.py", "scripts/run_ads.py", "scripts/dapan_sync.py", "scripts/full_review.py", "scripts/sync_log.py", "scripts/codex_lark_adapter.py"] : manifest.script.runner === "h5-sync" ? ["scripts/feishu_h5_sync.py"] : [];
    for (const path of required) need(expected.has(path), `技能包缺少入口脚本：${path}`);
  }
  return manifest;
}
export {
  APP_VERSION,
  OPENCODE_VERSION,
  PACKAGE_ID,
  allowedPackageFile,
  packageTree,
  pathExists,
  privateDirectory,
  readPrivateJson,
  readRegularFile,
  validPackageVersion,
  validatePackageDirectory,
  validateRepoPack,
  writePrivateFile,
  writePrivateJson
};
