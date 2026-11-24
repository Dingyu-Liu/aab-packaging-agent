import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { FEISHU_API } from "./feishu-oauth.js";
import { AppError } from "./errors.js";
const launcher = fileURLToPath(new URL("./feishu-launcher.sh", import.meta.url));
const resource = "[A-Za-z0-9_-]+";
const permitted = [
  ["GET", /^\/open-apis\/wiki\/v2\/spaces\/get_node$/],
  ["GET", new RegExp(`^/open-apis/sheets/v3/spreadsheets/${resource}/sheets/query$`)],
  ["GET", new RegExp(`^/open-apis/sheets/v2/spreadsheets/${resource}/values/[^/?#]+$`)],
  ["PUT", new RegExp(`^/open-apis/sheets/v2/spreadsheets/${resource}/values$`)],
  ["POST", new RegExp(`^/open-apis/sheets/v2/spreadsheets/${resource}/values_batch_update$`)],
  ["GET", new RegExp(`^/open-apis/bitable/v1/apps/${resource}/tables/${resource}/(?:fields|records)$`)],
  ["POST", new RegExp(`^/open-apis/bitable/v1/apps/${resource}/tables/${resource}/records$`)],
  ["POST", new RegExp(`^/open-apis/bitable/v1/apps/${resource}/tables/${resource}/records/batch_update$`)],
  ["PUT", new RegExp(`^/open-apis/bitable/v1/apps/${resource}/tables/${resource}/records/${resource}$`)]
];
class FeishuBridge {
  constructor(oauth, redactor, origin, request = fetch) {
    this.oauth = oauth;
    this.redactor = redactor;
    this.origin = origin;
    this.request = request;
  }
  oauth;
  redactor;
  origin;
  request;
  capabilities = /* @__PURE__ */ new Map();
  environment(ownerId) {
    if (!this.oauth.hasConnection(ownerId)) return void 0;
    const owner = ownerId ?? "";
    const connectionId = this.oauth.connectionId(ownerId);
    let capability = this.capabilities.get(owner);
    if (!capability || capability.connectionId !== connectionId) {
      capability = { key: randomBytes(32).toString("base64url"), connectionId };
      this.capabilities.set(owner, capability);
      this.redactor.add(capability.key);
    }
    return { SYNC_LARK_CLI: void 0, FEISHU_TEAM_RUNNER: launcher, PARTNER_H5_FEISHU_LAUNCHER: launcher, PARTNER_FEISHU_BRIDGE_URL: this.origin() + "/api/feishu/bridge", PARTNER_FEISHU_BRIDGE_KEY: capability.key };
  }
  async invoke(input, authorization) {
    const actual = Buffer.from(authorization || "");
    const owner = [...this.capabilities].find(([, entry]) => {
      const expected = Buffer.from(`Bearer ${entry.key}`);
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    })?.[0];
    if (owner === void 0 || this.capabilities.get(owner)?.connectionId !== this.oauth.connectionId(owner || void 0)) throw new AppError(403, "飞书脚本连接凭据无效。");
    if (typeof input.method !== "string" || typeof input.path !== "string" || !permitted.some(([method, path]) => method === input.method && path.test(input.path))) throw new AppError(403, "当前飞书连接仅支持已登记的表格读写操作。");
    if (input.query !== void 0 && (!input.query || typeof input.query !== "object" || Array.isArray(input.query))) throw new AppError(400, "飞书查询参数无效。");
    const url = new URL(input.path, FEISHU_API);
    if (url.origin !== FEISHU_API || url.pathname !== input.path) throw new AppError(400, "飞书接口路径无效。");
    for (const [key, value] of Object.entries(input.query || {})) {
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") throw new AppError(400, "飞书查询参数必须是文本或数值。");
      url.searchParams.set(key, String(value));
    }
    const token = await this.oauth.accessToken(owner || void 0);
    let response;
    try {
      response = await this.request(url, { method: input.method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...input.body !== void 0 ? { body: JSON.stringify(input.body) } : {}, redirect: "error", signal: AbortSignal.timeout(3e4) });
    } catch {
      throw new AppError(502, "无法连接飞书表格接口，请检查网络。");
    }
    let result;
    try {
      result = await response.json();
    } catch {
      throw new AppError(502, "飞书表格接口返回了无效响应。");
    }
    if (!response.ok || !result || typeof result !== "object" || !("code" in result) || result.code !== 0) {
      const code = result && typeof result === "object" && "code" in result && typeof result.code === "number" ? result.code : response.status;
      throw new AppError(502, `飞书表格操作未通过（${code}），请核对首页授权和目标表格权限。`);
    }
    return { ...result, ok: true };
  }
}
export {
  FeishuBridge
};
