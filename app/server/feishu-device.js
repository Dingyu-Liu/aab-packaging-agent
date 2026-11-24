import { gzipSync } from "node:zlib";
import { AppError } from "./errors.js";
const accounts = "https://accounts.feishu.cn";
const registration = accounts + "/oauth/v1/app/registration";
const deviceAuthorization = accounts + "/oauth/v1/device_authorization";
const token = accounts + "/oauth/v3/token";
function isData(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function officialUrl(value) {
  let url;
  try {
    if (typeof value !== "string") throw new Error();
    url = new URL(value);
  } catch {
    throw new AppError(502, "飞书没有返回有效的扫码地址，请重试。");
  }
  if (url.protocol !== "https:" || url.username || url.password || !(url.hostname === "feishu.cn" || url.hostname.endsWith(".feishu.cn"))) throw new AppError(502, "飞书返回的扫码地址不属于飞书官方域名。");
  return url;
}
function deviceError(result) {
  const code = typeof result.error === "string" && /^[a-z_]+$/.test(result.error) ? result.error : typeof result.code === "number" ? String(result.code) : "invalid_response";
  const messages = {
    access_denied: "飞书授权已拒绝或取消，请重新扫码。",
    expired_token: "二维码已过期，请点击重新获取。",
    invalid_client: "飞书应用凭据不可用，请由管理员重新扫码接入应用。",
    unauthorized_client: "当前飞书应用不支持设备扫码授权，请由管理员检查应用或重新扫码接入。",
    invalid_scope: "飞书应用尚未开通所需权限，请由管理员确认权限并发布应用后重试。",
    invalid_dpop_proof: "飞书要求校验设备凭据，请检查应用授权策略后重试。"
  };
  return new AppError(400, messages[code] ?? `飞书扫码未完成（${code}），请重新获取二维码。`);
}
class FeishuDeviceProtocol {
  constructor(request, redactor) {
    this.request = request;
    this.redactor = redactor;
  }
  request;
  redactor;
  async startUser(credentials, scopes) {
    const basic = Buffer.from(credentials.appId + ":" + credentials.appSecret).toString("base64");
    this.redactor.add(basic);
    const result = await this.form(deviceAuthorization, { client_id: credentials.appId, scope: scopes.join(" ") }, { Authorization: "Basic " + basic });
    return this.challenge(result);
  }
  async startRegistration(scopes, appId) {
    const result = await this.form(registration, { action: "begin", archetype: "PersonalAgent", auth_method: "client_secret", request_user_info: "open_id" });
    const challenge = this.challenge(result), url = new URL(challenge.verificationUrl);
    url.searchParams.set("from", "sdk");
    url.searchParams.set("tp", "sdk");
    url.searchParams.set("source", "partner-agent");
    url.searchParams.set("name", "Partner Agent 数据更新");
    url.searchParams.set("desc", "通过用户授权读取和更新业务表格");
    if (appId) {
      if (!/^cli_[A-Za-z0-9]+$/.test(appId)) throw new AppError(400, "当前应用 ID 无效，请由管理员检查配置。");
      url.searchParams.set("clientID", appId);
    } else url.searchParams.set("createOnly", "true");
    const addons = { preset: false, scopes: { user: scopes.filter((scope) => scope !== "offline_access") } };
    url.searchParams.set("addons", gzipSync(Buffer.from(JSON.stringify(addons))).toString("base64url"));
    challenge.verificationUrl = url.toString();
    return challenge;
  }
  pollUser(deviceCode, credentials) {
    return this.form(token, { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: deviceCode, client_id: credentials.appId, client_secret: credentials.appSecret });
  }
  pollRegistration(deviceCode) {
    return this.form(registration, { action: "poll", device_code: deviceCode });
  }
  challenge(result) {
    if (result.error || result.code !== void 0 && result.code !== 0) throw deviceError(result);
    if (typeof result.device_code !== "string" || !result.device_code || typeof result.user_code !== "string" || !result.user_code || typeof result.expires_in !== "number" || !Number.isFinite(result.expires_in) || result.expires_in <= 0) throw new AppError(502, "飞书二维码响应不完整，请重新获取。");
    this.redactor.add(result.device_code);
    const uri = officialUrl(result.verification_uri), complete = officialUrl(result.verification_uri_complete ?? result.verification_uri);
    if (complete.href.includes(result.device_code) || uri.href.includes(result.device_code)) throw new AppError(502, "飞书扫码响应包含异常的设备凭据，请重试。");
    if (!result.verification_uri_complete) complete.searchParams.set("user_code", result.user_code);
    const interval = typeof result.interval === "number" && Number.isFinite(result.interval) && result.interval >= 1 ? Math.ceil(result.interval) : 5;
    return { deviceCode: result.device_code, userCode: result.user_code, verificationUri: uri.toString(), verificationUrl: complete.toString(), expiresIn: Math.min(result.expires_in, 3600), interval: Math.max(interval, 5) };
  }
  async form(url, values, headers = {}) {
    let response;
    try {
      response = await this.request(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(values).toString(), redirect: "error", signal: AbortSignal.timeout(2e4) });
    } catch {
      throw new AppError(502, "暂时无法连接飞书扫码服务，请检查网络后重试。");
    }
    let result;
    try {
      result = await response.json();
    } catch {
      throw new AppError(502, "飞书扫码服务返回了无效响应，请重试。");
    }
    if (!isData(result)) throw new AppError(502, "飞书扫码响应格式无效。");
    if (response.status >= 500 || response.status === 429) throw new AppError(502, "飞书扫码服务暂时繁忙，请稍后重试。");
    if (!response.ok && !result.error && result.code === void 0) throw new AppError(502, `飞书扫码服务暂时不可用（HTTP ${response.status}）。`);
    return result;
  }
}
export {
  FeishuDeviceProtocol,
  deviceError
};
