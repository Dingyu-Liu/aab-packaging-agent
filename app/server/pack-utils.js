import { createHash } from "node:crypto";
import { extname } from "node:path";
import { AppError } from "./errors.js";
const PACK_LIMITS = Object.freeze({ files: 2e3, fileBytes: 8 * 1024 * 1024, totalBytes: 50 * 1024 * 1024, manifestBytes: 256e3 });
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  const record = value;
  return `{${Object.keys(record).filter((key) => record[key] !== void 0).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}
function packSha256(pack) {
  const { packSha256: _ignored, ...rest } = pack;
  return sha256(stableJson(rest));
}
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
function parseSemver(value) {
  if (typeof value !== "string" || value.length > 120) return void 0;
  const match = semverPattern.exec(value);
  if (!match) return void 0;
  const pre = match[4]?.split(".") ?? [];
  if (pre.some((part) => /^\d+$/.test(part) && part.length > 1 && part[0] === "0")) return void 0;
  return { core: match.slice(1, 4), pre };
}
function validPackVersion(value) {
  return !!parseSemver(value);
}
function validPackId(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{1,79}$/.test(value);
}
function compareNumeric(a, b) {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}
function compareSemver(a, b) {
  const left = parseSemver(a), right = parseSemver(b);
  if (!left || !right) return a.localeCompare(b);
  for (let i = 0; i < 3; i++) {
    const diff = compareNumeric(left.core[i], right.core[i]);
    if (diff) return diff;
  }
  if (!left.pre.length || !right.pre.length) return Number(!left.pre.length) - Number(!right.pre.length);
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i], y = right.pre[i];
    if (x === void 0 || y === void 0) return left.pre.length - right.pre.length;
    if (x === y) continue;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return compareNumeric(x, y);
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
function validPackPath(path) {
  if (typeof path !== "string" || !path || path.length > 512 || /[\x00-\x1f\x7f\\]/.test(path) || path.normalize("NFC") !== path) return false;
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return false;
  const parts = path.split("/");
  if (parts.length > 16 || parts.some((part) => !part || part.startsWith(".") || part.length > 200)) return false;
  if (parts.some((part) => /[<>:"|?*]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part))) return false;
  return true;
}
const packExtensions = /* @__PURE__ */ new Set([".py", ".sh", ".ps1", ".bat", ".cmd", ".js", ".mjs", ".cjs", ".ts", ".json", ".yaml", ".yml", ".toml", ".md", ".txt", ".rst", ".csv", ".tsv", ".xml", ".ini", ".cfg", ".properties", ".cs", ".swift", ".java", ".kt", ".gradle", ".pro", ".h", ".m", ".mm", ".diff", ".patch"]);
const assetExtensions = /* @__PURE__ */ new Set([".html", ".css", ".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico", ".zip", ".part", ".storyboard", ".tpl", ".template"]);
function allowedPackPath(path) {
  if (!validPackPath(path) || path.split("/").some((part) => ["node_modules", "__pycache__"].includes(part.toLowerCase()))) return false;
  if (/^(manifest\.json|provenance\.json|README(?:\.(?:md|txt|rst))?|LICENSE(?:\.(?:md|txt))?|CHANGELOG(?:\.(?:md|txt))?|SKILL\.md)$/i.test(path)) return true;
  if (!/^(scripts|skills)\//.test(path)) return false;
  const extension = extname(path).toLowerCase();
  return packExtensions.has(extension) || path.startsWith("skills/") && path.split("/").slice(1, -1).includes("assets") && assetExtensions.has(extension);
}
function assertPackFiles(files) {
  if (!Array.isArray(files) || !files.length || files.length > PACK_LIMITS.files) throw new AppError(400, "技能包文件数量无效。");
  const paths = /* @__PURE__ */ new Set();
  let total = 0;
  for (const file of files) {
    if (!file || !validPackPath(file.path)) throw new AppError(400, "技能包文件路径无效。");
    const key = file.path.toLowerCase();
    if (paths.has(key)) throw new AppError(400, "技能包文件路径重复。");
    paths.add(key);
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > PACK_LIMITS.fileBytes) throw new AppError(400, "技能包文件大小无效。");
    if (typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new AppError(400, "技能包文件哈希无效。");
    total += file.size;
    if (total > PACK_LIMITS.totalBytes) throw new AppError(400, "技能包超过 50 MiB 上限。");
  }
  for (const path of paths) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) if (paths.has(parts.slice(0, i).join("/"))) throw new AppError(400, "技能包文件和目录路径冲突。");
  }
}
export {
  PACK_LIMITS,
  allowedPackPath,
  assertPackFiles,
  compareSemver,
  packSha256,
  sha256,
  stableJson,
  validPackId,
  validPackPath,
  validPackVersion
};
