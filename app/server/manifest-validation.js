import { AppError } from "./errors.js";
import { validPackId, validPackPath } from "./pack-utils.js";
const versionPattern = /^\d+\.\d+\.\d+(?:[.+-][\w.-]+)?$/;
const fieldTypes = /* @__PURE__ */ new Set(["text", "secret", "number", "select", "boolean", "path"]);
function need(condition, message) {
  if (!condition) throw new AppError(400, `模块格式错误：${message}`);
}
function object(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function text(value, max = 4e3) {
  return typeof value === "string" && value.length <= max && !value.includes("\0");
}
function fields(value) {
  need(Array.isArray(value) && value.length <= 200, "parameters 必须是数组且不超过 200 项");
  const keys = /* @__PURE__ */ new Set();
  for (const field of value) {
    need(object(field), "参数必须是对象");
    need(typeof field.key === "string" && /^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(field.key), "参数 key 无效");
    need(!keys.has(field.key), "参数 key 重复");
    keys.add(field.key);
    need(text(field.label, 200) && typeof field.type === "string" && fieldTypes.has(field.type), "参数名称或类型无效");
    if (field.required !== void 0) need(typeof field.required === "boolean", "参数 required 无效");
    if (field.default !== void 0) need(typeof field.default === "string" || typeof field.default === "boolean" || typeof field.default === "number" && Number.isFinite(field.default), "参数默认值无效");
    if (field.type === "secret") need(field.default === void 0 || field.default === "", "敏感参数不得包含默认值");
    if (field.type === "select") need(Array.isArray(field.options) && field.options.length > 0 && field.options.length <= 200 && field.options.every((option) => object(option) && text(option.label, 200) && text(option.value)), "选择参数缺少有效选项");
  }
}
function validateManifest(value) {
  need(object(value), "manifest 必须是对象");
  const m = value;
  need(m.schemaVersion === 1, "仅支持 schemaVersion=1，请使用匹配的应用版本");
  need(typeof m.id === "string" && validPackId(m.id), "id 仅可用小写字母、数字和连字符");
  need(text(m.name, 200) && !!m.name.trim(), "缺少 name");
  need(typeof m.version === "string" && m.version.length <= 120 && versionPattern.test(m.version), "缺少合法版本号");
  need(m.kind === "sdk" || m.kind === "script" || m.kind === "website", "kind 应为 sdk、script 或 website");
  need(m.status === "ready" || m.status === "unconfigured", "status 无效");
  need(text(m.description, 1e4) && Array.isArray(m.tags) && m.tags.length <= 100 && m.tags.every((tag) => text(tag, 200)), "description/tags 无效");
  need(Array.isArray(m.profiles) && m.profiles.length <= 100, "profiles 必须是数组");
  const ids = /* @__PURE__ */ new Set();
  for (const profile of m.profiles) {
    need(object(profile), "profile 必须是对象");
    need(typeof profile.id === "string" && validPackId(profile.id) && !ids.has(profile.id), "profile id 无效或重复");
    ids.add(profile.id);
    need(profile.partner === void 0 || text(profile.partner, 200) && profile.partner.trim().length > 0, "partner 必须是非空名称");
    need(text(profile.name, 200) && text(profile.description, 1e4) && text(profile.attribution), "profile 描述不完整");
    need(typeof profile.version === "string" && versionPattern.test(profile.version), "profile version 无效");
    need(profile.platform === "ios" || profile.platform === "android", "platform 应为 ios/android");
    need(object(profile.skill) && typeof profile.skill.path === "string" && validPackPath(profile.skill.path) && /(?:^|\/)SKILL\.md$/.test(profile.skill.path) && typeof profile.skill.version === "string" && versionPattern.test(profile.skill.version), "skill 路径或版本无效，必须指向模块内的 SKILL.md");
    fields(profile.parameters);
  }
  if (m.kind === "website") need(m.profiles.length === 0 && m.script === void 0, "网站模块不使用 SDK 方案或脚本运行器");
  if (m.kind === "sdk") need(m.profiles.length > 0, "SDK 模块至少需要一个方案");
  if (m.kind === "script" || m.script !== void 0) {
    need(object(m.script) && ["finance-sync", "h5-sync", "external"].includes(String(m.script.runner)), "脚本 runner 未注册");
    need(typeof m.script.supportsDryRun === "boolean" && text(m.script.notes, 1e4), "script 能力声明无效");
    fields(m.script.parameters);
  }
  return structuredClone(m);
}
export {
  validateManifest
};
