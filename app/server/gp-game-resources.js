import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, lstat, chmod } from "node:fs/promises";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { inflateRawSync } from "node:zlib";
import { AppError } from "./errors.js";
function resourceHash(content) {
  return createHash("sha256").update(content).digest("hex");
}
async function extractGameZip(data, destination, signal) {
  let end = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) if (data.readUInt32LE(i) === 101010256 && i + 22 + data.readUInt16LE(i + 20) === data.length) {
    end = i;
    break;
  }
  if (end < 0) throw new AppError(400, "内置资源不是有效 ZIP。");
  const count = data.readUInt16LE(end + 10), start = data.readUInt32LE(end + 16), length = data.readUInt32LE(end + 12);
  if (count > 2e4 || start + length > end) throw new AppError(400, "资源 ZIP 目录无效。");
  let cursor = start, total = 0;
  for (let index = 0; index < count; index++) {
    if (signal?.aborted) throw new AppError(409, "任务已取消。");
    if (cursor + 46 > start + length || data.readUInt32LE(cursor) !== 33639248) throw new AppError(400, "资源 ZIP 条目无效。");
    const flags = data.readUInt16LE(cursor + 8), method = data.readUInt16LE(cursor + 10), compressed = data.readUInt32LE(cursor + 20), size = data.readUInt32LE(cursor + 24);
    const nameLength = data.readUInt16LE(cursor + 28), extra = data.readUInt16LE(cursor + 30), comment = data.readUInt16LE(cursor + 32), attributes = data.readUInt32LE(cursor + 38), offset = data.readUInt32LE(cursor + 42);
    const name = data.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    cursor += 46 + nameLength + extra + comment;
    if (cursor > start + length || flags & 1 || !name || name.includes("\\") || name.includes("\0") || isAbsolute(name) || /^[A-Za-z]:/.test(name) || name.split("/").some((part) => part === "..")) throw new AppError(400, "资源 ZIP 路径无效。");
    if (name.startsWith("__MACOSX/") || name.split("/").at(-1)?.startsWith("._") || name.endsWith(".DS_Store")) continue;
    const kind = attributes >>> 16 & 61440;
    if (kind && kind !== 32768 && kind !== 16384) throw new AppError(400, "资源 ZIP 不允许链接或特殊文件。");
    const target = resolve(destination, name);
    if (relative(destination, target).startsWith("..")) throw new AppError(400, "资源 ZIP 路径越界。");
    if (name.endsWith("/")) {
      await mkdir(target, { recursive: true });
      continue;
    }
    total += size;
    if (size > 128 * 1024 * 1024 || total > 512 * 1024 * 1024 || offset + 30 > start || data.readUInt32LE(offset) !== 67324752) throw new AppError(400, "资源 ZIP 大小或文件头无效。");
    const body = offset + 30 + data.readUInt16LE(offset + 26) + data.readUInt16LE(offset + 28);
    if (body + compressed > start) throw new AppError(400, "资源 ZIP 内容不完整。");
    const packed = data.subarray(body, body + compressed);
    if (![0, 8].includes(method)) throw new AppError(400, "资源 ZIP 压缩格式不支持。");
    const content = method === 0 ? packed : inflateRawSync(packed, { maxOutputLength: Math.max(1, size) });
    if (content.length !== size) throw new AppError(400, "资源 ZIP 解压长度不符。");
    await mkdir(dirname(target), { recursive: true });
    const mode = attributes >>> 16 & 511 || 420;
    await writeFile(target, content, { mode });
    await chmod(target, mode);
  }
}
async function materializeGameResources(taskDir, signal) {
  const assets = join(taskDir, "module", "skills", "gp-build", "assets");
  const manifest = JSON.parse(await readFile(join(assets, "resources.json"), "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.platform !== "mac-intel") throw new AppError(400, "游戏资源清单格式无效。");
  const output = join(taskDir, "game-resources"), hashes = {};
  for (const key of ["deploy", "firebase"]) {
    const archive = manifest[key];
    if (!archive || !Array.isArray(archive.parts) || !archive.parts.length || !/^[a-f0-9]{64}$/.test(archive.sha256) || archive.directory !== (key === "deploy" ? "deploy" : "m2repository")) throw new AppError(400, "游戏资源清单不完整。");
    const buffers = [];
    for (const name of archive.parts) {
      if (typeof name !== "string" || !/^[A-Za-z0-9_.-]+$/.test(name)) throw new AppError(400, "游戏资源文件名无效。");
      const path = join(assets, name), info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) throw new AppError(400, "游戏资源分片无效。");
      buffers.push(await readFile(path));
    }
    const data = Buffer.concat(buffers);
    if (resourceHash(data) !== archive.sha256) throw new AppError(400, `内置 ${key} 资源校验失败。`);
    hashes[key] = archive.sha256;
    const directory = join(output, key), marker = join(directory, "archive.sha256");
    if (await readFile(marker, "utf8").catch(() => "") !== archive.sha256 || !(await lstat(join(directory, archive.directory)).catch(() => void 0))?.isDirectory()) {
      await extractGameZip(data, directory, signal);
      await writeFile(marker, archive.sha256, { mode: 384 });
    }
  }
  return { deploy: join(output, "deploy", "deploy"), firebase: join(output, "firebase", "m2repository"), hashes };
}
export {
  extractGameZip,
  materializeGameResources,
  resourceHash
};
