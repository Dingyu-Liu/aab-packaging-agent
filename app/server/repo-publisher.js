import { lstat, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AppError } from "./errors.js";
import { validateManifest } from "./manifest-validation.js";
import { allowedPackPath, assertPackFiles, PACK_LIMITS, sha256, validPackPath, validPackVersion } from "./pack-utils.js";
import { readRegularFile, validateRepoPack } from "./package-validation.js";
async function preparePackageSnapshot(directory) {
  if (typeof directory !== "string" || !directory || directory.includes("\0")) throw new AppError(400, "待推送的技能包目录无效。");
  const root = resolve(directory), info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new AppError(400, "待推送的技能包必须是普通目录。");
  const files = [];
  let total = 0, entries = 0;
  async function walk(prefix = "") {
    for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || ["node_modules", "__pycache__", "pack.json"].includes(entry.name)) continue;
      if (++entries > PACK_LIMITS.files * 16) throw new AppError(400, "待推送的技能包目录条目过多。");
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!validPackPath(path)) throw new AppError(400, "待推送的技能包包含非法路径。");
      const info2 = await lstat(join(root, path));
      if (info2.isSymbolicLink()) throw new AppError(400, "待推送的技能包不允许符号链接。");
      if (info2.isDirectory()) {
        if (path.split("/").length >= 16) throw new AppError(400, "待推送的技能包目录层级过多。");
        await walk(path);
        continue;
      }
      if (!info2.isFile() || !allowedPackPath(path)) throw new AppError(400, `文件不在技能包白名单内：${path}`);
      if (files.length >= PACK_LIMITS.files) throw new AppError(400, "技能包文件数量超限。");
      const content = await readRegularFile(join(root, path), path === "manifest.json" ? PACK_LIMITS.manifestBytes - 1 : PACK_LIMITS.fileBytes);
      total += content.length;
      if (total > PACK_LIMITS.totalBytes) throw new AppError(400, "技能包超过 50 MiB 上限。");
      files.push({ path, content, size: content.length, sha256: sha256(content) });
    }
  }
  await walk();
  assertPackFiles(files);
  const manifestFile = files.find((file) => file.path === "manifest.json");
  if (!manifestFile) throw new AppError(400, "技能包缺少 manifest.json。");
  let raw;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestFile.content));
  } catch {
    throw new AppError(400, "manifest.json 不是合法 UTF-8 JSON。");
  }
  const manifest = validateManifest(raw);
  if (!validPackVersion(manifest.version)) throw new AppError(400, "技能包版本必须是合法语义版本。");
  const byPath = new Map(files.map((file) => [file.path, file]));
  for (const profile of manifest.profiles) {
    const skill = byPath.get(profile.skill.path);
    if (!skill || skill.size > 1024 * 1024) throw new AppError(400, "技能包缺少有效的 SKILL.md。");
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(skill.content);
    } catch {
      throw new AppError(400, "SKILL.md 必须是 UTF-8 文本。");
    }
    if (!text.trim()) throw new AppError(400, "SKILL.md 内容不能为空。");
  }
  const required = manifest.script?.runner === "finance-sync" ? ["scripts/run_consume.py", "scripts/run_ads.py", "scripts/dapan_sync.py", "scripts/full_review.py", "scripts/sync_log.py", "scripts/codex_lark_adapter.py"] : manifest.script?.runner === "h5-sync" ? ["scripts/feishu_h5_sync.py"] : [];
  for (const path of required) if (!byPath.has(path)) throw new AppError(400, `技能包缺少入口脚本：${path}`);
  return { manifest, channel: manifest.version.split("+")[0].includes("-") ? "beta" : "stable", files };
}
async function prepareRepoPublication(directory) {
  const publication = await preparePackageSnapshot(directory);
  if (publication.manifest.script?.runner === "external") throw new AppError(400, "团队仓库不接受 external runner 包。");
  return publication;
}
class PublicationHttpError extends AppError {
}
function requestError(status) {
  const message = status === 401 ? "仓库凭据已失效，请重新绑定后再推送。" : status === 403 ? "当前仓库账号没有技能包发布权限。" : status === 409 ? "仓库版本已存在或存在发布冲突，版本不可覆盖，请使用新版本。" : status === 404 ? "仓库发布接口或上传记录不存在。" : status === 413 ? "仓库拒绝了超出大小上限的技能包。" : status === 429 ? "仓库发布请求过多，请稍后重试。" : status < 500 ? "仓库拒绝技能包发布，请检查 manifest、Skill 和脚本。" : "仓库发布请求失败。";
  return new PublicationHttpError(status, message);
}
async function responseJson(response) {
  const limit = 4 * 1024 * 1024, declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    await response.body?.cancel().catch(() => void 0);
    throw new AppError(502, "仓库发布响应超过大小上限。");
  }
  const reader = response.body?.getReader(), chunks = [];
  let size = 0;
  if (reader) try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => void 0);
        throw new AppError(502, "仓库发布响应超过大小上限。");
      }
      chunks.push(Buffer.from(item.value));
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size)));
  } catch {
    throw new AppError(502, "仓库发布响应不是合法 UTF-8 JSON。");
  }
}
function verifiedPack(input, publication, redactor) {
  const original = validateRepoPack(input), manifest = publication.manifest;
  if (original.id !== manifest.id || original.version !== manifest.version || original.moduleKind !== manifest.kind || original.name !== manifest.name || original.description !== manifest.description || original.channel !== publication.channel) throw new AppError(502, "仓库返回的技能包与本地 manifest 不一致。");
  const local = new Map(publication.files.map((file) => [file.path, file]));
  if (original.files.length !== local.size || original.files.some((file) => {
    const expected = local.get(file.path);
    return !expected || file.size !== expected.size || file.sha256 !== expected.sha256;
  })) throw new AppError(502, "仓库发布结果与本地文件 SHA-256 不一致。");
  if (original.publisher && (typeof original.publisher.id !== "string" || original.publisher.id.length > 200 || typeof original.publisher.name !== "string" || original.publisher.name.length > 1e3)) throw new AppError(502, "仓库返回的发布者信息无效。");
  const pack = validateRepoPack({
    schemaVersion: original.schemaVersion,
    id: original.id,
    name: original.name,
    version: original.version,
    kind: original.kind,
    moduleKind: original.moduleKind,
    description: original.description,
    channel: original.channel,
    compatibility: {
      pluginSchemaVersion: original.compatibility.pluginSchemaVersion,
      ...original.compatibility.minAppVersion !== void 0 ? { minAppVersion: original.compatibility.minAppVersion } : {},
      ...original.compatibility.maxAppVersion !== void 0 ? { maxAppVersion: original.compatibility.maxAppVersion } : {},
      ...original.compatibility.opencodeVersion !== void 0 ? { opencodeVersion: original.compatibility.opencodeVersion } : {},
      ...original.compatibility.runners !== void 0 ? { runners: [...original.compatibility.runners] } : {}
    },
    files: original.files.map(({ path, size, sha256: sha2562 }) => ({ path, size, sha256: sha2562 })),
    packSha256: original.packSha256,
    createdAt: original.createdAt,
    ...original.publisher ? { publisher: { id: original.publisher.id, name: original.publisher.name } } : {}
  });
  const serialized = JSON.stringify(pack);
  if (redactor.text(serialized) !== serialized) throw new AppError(502, "仓库返回了包含敏感信息的包描述，已拒绝发布确认。");
  return pack;
}
async function publishRepoPublication(publication, connection, redactor) {
  async function call(path, method = "POST", body = {}, cleanup = false) {
    let response;
    try {
      response = await fetch(`${connection.url}/api/repo/v1${path}`, {
        method,
        redirect: "error",
        credentials: "omit",
        signal: AbortSignal.timeout(cleanup ? 5e3 : 3e4),
        headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json", Accept: "application/json", "X-Partner-Agent": "local" },
        ...method === "GET" ? {} : { body: JSON.stringify(body) }
      });
    } catch {
      throw new AppError(503, "仓库连接中断或不可用，未确认推送成功。");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => void 0);
      throw requestError(response.status);
    }
    if (cleanup) {
      await response.body?.cancel().catch(() => void 0);
      return;
    }
    try {
      return await responseJson(response);
    } catch (error) {
      throw error instanceof AppError ? error : new AppError(503, "读取仓库发布响应时连接中断，未确认推送成功。");
    }
  }
  let uploadId, commitStarted = false;
  try {
    const upload = await call("/uploads", "POST", { id: publication.manifest.id, version: publication.manifest.version, channel: publication.channel });
    if (!upload || typeof upload.uploadId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(upload.uploadId)) throw new AppError(502, "仓库返回了无效的上传编号。");
    uploadId = upload.uploadId;
    for (const file of publication.files) {
      const receipt = await call(`/uploads/${uploadId}/files`, "POST", { path: file.path, contentBase64: file.content.toString("base64") });
      if (!receipt || receipt.path !== file.path || receipt.size !== file.size || receipt.sha256 !== file.sha256) throw new AppError(502, "仓库文件上传回执 SHA-256 校验失败。");
    }
    commitStarted = true;
    return verifiedPack(await call(`/uploads/${uploadId}/commit`), publication, redactor);
  } catch (error) {
    if (uploadId) await call(`/uploads/${uploadId}`, "DELETE", {}, true).catch(() => void 0);
    if (error instanceof PublicationHttpError && error.status === 409) {
      try {
        return verifiedPack(await call(`/packs/${encodeURIComponent(publication.manifest.id)}/versions/${encodeURIComponent(publication.manifest.version)}`, "GET"), publication, redactor);
      } catch {
      }
    }
    const status = error instanceof AppError ? error.status : 503;
    let message = error instanceof AppError ? error.message : "技能包推送失败。";
    if (commitStarted && !(error instanceof PublicationHttpError && error.status < 500)) message += " 提交结果未确认，仓库可能已发布该版本，请确认后再重试。";
    throw new AppError(status, redactor.text(message));
  }
}
export {
  preparePackageSnapshot,
  prepareRepoPublication,
  publishRepoPublication
};
