import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { reasoningEfforts } from "../shared/contracts.js";
import { AppError } from "./errors.js";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "";
const SECRETS_DIR = "secrets";
const SECRETS_FILE = "model.key";
const BUILTIN_CONFIG = "agent.config.local.json";
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return void 0;
  }
}
function cleanBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new AppError(400, "请输入完整 API 地址。");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new AppError(400, "API 地址须为 HTTP(S) 地址，不能包含账号、查询参数或片段。");
  }
  return url.toString().replace(/\/$/, "");
}
class SettingsManager {
  constructor(store, redactor, options = {}) {
    this.store = store;
    this.redactor = redactor;
    const persisted = store.settings();
    let builtin = {};
    if (options.appRoot) {
      const raw = readJson(join(options.appRoot, BUILTIN_CONFIG));
      if (raw && typeof raw === "object" && !Array.isArray(raw)) builtin = raw;
    }
    this.secretFile = options.dataDir ? join(options.dataDir, SECRETS_DIR, SECRETS_FILE) : void 0;
    this.envKey = (process.env.PARTNER_AGENT_API_KEY || process.env.OPENAI_API_KEY || "").trim();
    this.builtinKey = typeof builtin.apiKey === "string" ? builtin.apiKey.trim() : "";
    const fileKey = this.readPersistedKey();
    this.key = this.envKey || fileKey || this.builtinKey;
    this.source = this.envKey ? "environment" : fileKey ? "file" : this.builtinKey ? "builtin" : "none";
    this.redactor.add(this.key);
    this.config = {
      engine: "opencode",
      apiBaseUrl: DEFAULT_BASE_URL,
      model: DEFAULT_MODEL,
      reasoningEffort: "default",
      protocol: "openai-compatible",
      timeoutMinutes: 30,
      maxSteps: 40,
      autoApprovePermissions: false,
      ...builtin.apiBaseUrl ? { apiBaseUrl: builtin.apiBaseUrl } : {},
      ...builtin.model ? { model: builtin.model } : {},
      ...builtin.reasoningEffort ? { reasoningEffort: builtin.reasoningEffort } : {},
      ...builtin.protocol ? { protocol: builtin.protocol } : {},
      apiKeyConfigured: !!this.key,
      keySource: this.source,
      ...persisted
    };
    if (!reasoningEfforts.includes(this.config.reasoningEffort)) this.config.reasoningEffort = "default";
    if (process.env.PARTNER_AGENT_API_BASE_URL) this.config.apiBaseUrl = process.env.PARTNER_AGENT_API_BASE_URL;
    if (process.env.PARTNER_AGENT_MODEL && persisted.model === void 0) this.config.model = process.env.PARTNER_AGENT_MODEL;
  }
  store;
  redactor;
  key = "";
  source = "none";
  envKey = "";
  builtinKey = "";
  config;
  secretFile;
  readPersistedKey() {
    if (!this.secretFile || !existsSync(this.secretFile)) return "";
    try {
      const file = statSync(this.secretFile);
      if (!file.isFile()) return "";
      if ((file.mode & 63) !== 0) chmodSync(this.secretFile, 384);
      return readFileSync(this.secretFile, "utf8").trim();
    } catch {
      return "";
    }
  }
  persistKey(key) {
    if (!this.secretFile) return false;
    try {
      mkdirSync(dirname(this.secretFile), { recursive: true, mode: 448 });
      const temporary = `${this.secretFile}.${process.pid}.tmp`;
      writeFileSync(temporary, `${key}
`, { mode: 384 });
      chmodSync(temporary, 384);
      renameSync(temporary, this.secretFile);
      return true;
    } catch {
      return false;
    }
  }
  removePersistedKey() {
    if (!this.secretFile) return;
    try {
      rmSync(this.secretFile, { force: true });
    } catch {
    }
  }
  recomputeFallback() {
    const fileKey = this.readPersistedKey();
    this.key = this.envKey || fileKey || this.builtinKey;
    this.source = this.envKey ? "environment" : fileKey ? "file" : this.builtinKey ? "builtin" : "none";
    this.redactor.add(this.key);
  }
  get() {
    return { ...this.config, apiKeyConfigured: !!this.key, keySource: this.source };
  }
  getKey() {
    return this.key;
  }
  save(input) {
    const next = { ...this.config };
    if (input.apiBaseUrl !== void 0) {
      if (typeof input.apiBaseUrl !== "string") throw new AppError(400, "API 地址格式无效。");
      next.apiBaseUrl = cleanBaseUrl(input.apiBaseUrl);
    }
    if (input.model !== void 0) {
      if (typeof input.model !== "string" || input.model.length > 300 || input.model.includes("\n")) throw new AppError(400, "模型 ID 格式无效。");
      next.model = input.model.trim();
    }
    if (input.reasoningEffort !== void 0) {
      if (typeof input.reasoningEffort !== "string" || !reasoningEfforts.includes(input.reasoningEffort)) throw new AppError(400, "请选择有效的思考强度。");
      next.reasoningEffort = input.reasoningEffort;
    }
    if (input.protocol !== void 0) {
      if (input.protocol !== "openai" && input.protocol !== "openai-compatible") throw new AppError(400, "请选择支持的接口协议。");
      next.protocol = input.protocol;
    }
    for (const [key, min, max] of [["timeoutMinutes", 1, 180], ["maxSteps", 1, 200]]) {
      if (input[key] !== void 0) {
        const value = input[key];
        if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new AppError(400, `${key} 应为 ${min}–${max} 的整数。`);
        next[key] = value;
      }
    }
    if (input.autoApprovePermissions !== void 0) {
      if (typeof input.autoApprovePermissions !== "boolean") throw new AppError(400, "自动允许设置格式无效。");
      next.autoApprovePermissions = input.autoApprovePermissions;
    }
    if (input.apiKey !== void 0 && typeof input.apiKey !== "string") throw new AppError(400, "API Key 格式无效。");
    this.config = next;
    if (input.clearApiKey === true) {
      this.removePersistedKey();
      this.recomputeFallback();
    }
    if (typeof input.apiKey === "string" && input.apiKey.trim()) {
      this.key = input.apiKey.trim();
      this.redactor.add(this.key);
      if (input.rememberApiKey === true && this.persistKey(this.key)) {
        this.source = "file";
      } else {
        this.source = "memory";
      }
    }
    this.store.saveSettings(this.get());
    return this.get();
  }
  requireConfigured() {
    if (!this.key || !this.config.model) throw new AppError(409, "请先在设置中填写 API 地址和 API Key，并从列表选择模型。本地检查无需 API。");
  }
  async test() {
    if (!this.key) throw new AppError(400, "请先保存 API Key。");
    const started = Date.now();
    try {
      const response = await fetch(this.config.apiBaseUrl.replace(/\/$/, "") + "/models", { headers: { Authorization: `Bearer ${this.key}` }, signal: AbortSignal.timeout(15e3), redirect: "error" });
      if (!response.ok) return { ok: false, detail: `模型列表接口返回 HTTP ${response.status}，请检查地址、协议和密钥。部分服务不提供 /models，仍需实际任务验证。`, latencyMs: Date.now() - started };
      const body = await response.json();
      const listed = Array.isArray(body.data) && body.data.some((item) => item.id === this.config.model);
      return { ok: true, detail: `API 已连通${this.config.model ? listed ? "，模型列表包含所选模型。" : "；模型列表未确认所选模型，请刷新列表并重新选择。" : "。"}此检查仅验证连通性，工具调用需通过实际任务验证。`, latencyMs: Date.now() - started };
    } catch (error) {
      return { ok: false, detail: error instanceof Error && error.name === "TimeoutError" ? "连接超时，请检查网络和 API 地址。" : "无法连接 API，请检查地址与网络；密钥不会写入日志。", latencyMs: Date.now() - started };
    }
  }
  async listModels(input = {}) {
    if (input.apiBaseUrl !== void 0 && typeof input.apiBaseUrl !== "string") throw new AppError(400, "API 地址格式无效。");
    if (input.apiKey !== void 0 && typeof input.apiKey !== "string") throw new AppError(400, "API Key 格式无效。");
    const apiBaseUrl = input.apiBaseUrl === void 0 ? this.config.apiBaseUrl : cleanBaseUrl(input.apiBaseUrl.trim());
    const apiKey = typeof input.apiKey === "string" && input.apiKey.trim() ? input.apiKey.trim() : this.key;
    if (!apiKey) throw new AppError(400, "请输入 API Key 后获取模型列表。");
    const started = Date.now();
    try {
      const response = await fetch(apiBaseUrl.replace(/\/+$/, "") + "/models", { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15e3), redirect: "error" });
      if (!response.ok) return { ok: false, models: [], detail: `模型列表接口返回 HTTP ${response.status}，请检查 API 地址、密钥和模型访问权限。`, latencyMs: Date.now() - started };
      const body = await response.json();
      const models = [...new Set(Array.isArray(body.data) ? body.data.map((item) => typeof item?.id === "string" ? item.id.trim() : "").filter((id) => id && id.length <= 300 && !/[\r\n]/.test(id)) : [])].sort();
      return { ok: models.length > 0, models, detail: models.length ? "已读取模型列表。" : "服务未返回可用模型，请检查 API 地址、密钥和模型访问权限后刷新列表。", latencyMs: Date.now() - started };
    } catch (error) {
      return { ok: false, models: [], detail: error instanceof Error && error.name === "TimeoutError" ? "连接超时，请检查网络和 API 地址后刷新列表。" : "无法连接模型列表接口，请检查 API 地址和网络后重试。", latencyMs: Date.now() - started };
    }
  }
}
export {
  SettingsManager
};
