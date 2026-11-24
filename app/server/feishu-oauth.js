import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AppError } from "./errors.js";
import { FeishuDeviceProtocol, deviceError } from "./feishu-device.js";
const FEISHU_SCOPES = ["offline_access", "sheets:spreadsheet", "bitable:app", "wiki:wiki:readonly"];
const FEISHU_CALLBACK = "/api/feishu/oauth/callback";
const authorizeEndpoint = "https://accounts.feishu.cn/open-apis/authen/v1/authorize";
const tokenEndpoint = "https://accounts.feishu.cn/oauth/v3/token";
const FEISHU_API = "https://open.feishu.cn";
const stateLifetime = 10 * 6e4;
function object(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function same(a, b) {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
class FeishuOAuth {
  constructor(dataDir, redactor, options = {}) {
    this.redactor = redactor;
    this.secretFile = join(dataDir, "secrets", "feishu.json");
    this.request = options.fetch ?? fetch;
    this.protocol = new FeishuDeviceProtocol(this.request, redactor);
    this.now = options.now ?? Date.now;
    this.environment = options.environment ?? process.env;
    if (existsSync(this.secretFile)) {
      try {
        const raw = JSON.parse(readFileSync(this.secretFile, "utf8"));
        if (!object(raw) || typeof raw.appId !== "string" || typeof raw.appSecret !== "string") throw new Error("invalid");
        this.saved = { appId: raw.appId, appSecret: raw.appSecret };
        const c = raw.connection;
        if (object(c) && typeof c.accessToken === "string" && typeof c.refreshToken === "string" && typeof c.expiresAt === "number" && Number.isFinite(c.expiresAt) && object(c.account) && typeof c.account.name === "string" && typeof c.account.openId === "string" && typeof c.connectedAt === "string") {
          this.saved.connection = { id: typeof c.id === "string" ? c.id : randomBytes(16).toString("hex"), ...typeof c.ownerId === "string" ? { ownerId: c.ownerId } : {}, accessToken: c.accessToken, refreshToken: c.refreshToken, expiresAt: c.expiresAt, ...typeof c.refreshExpiresAt === "number" ? { refreshExpiresAt: c.refreshExpiresAt } : {}, account: { name: c.account.name, openId: c.account.openId }, scopes: Array.isArray(c.scopes) ? c.scopes.filter((value) => typeof value === "string") : [], connectedAt: c.connectedAt, needsAuthorization: c.needsAuthorization === true };
        }
        chmodSync(this.secretFile, 384);
      } catch {
        throw new AppError(500, "飞书本地凭据无法读取，请检查本地 secrets/feishu.json 文件。");
      }
    }
    const credentials = this.credentials();
    if (credentials.source === "environment" && this.saved.appId && this.saved.appId !== credentials.appId) this.saved.connection = void 0;
    this.redact();
  }
  redactor;
  saved = { appId: "", appSecret: "" };
  pending;
  authError;
  completing;
  completingOwner;
  revision = 0;
  refresh;
  device;
  polling;
  protocol;
  secretFile;
  request;
  now;
  environment;
  credentials() {
    const appId = this.environment.PARTNER_FEISHU_APP_ID?.trim(), appSecret = this.environment.PARTNER_FEISHU_APP_SECRET?.trim();
    if (appId || appSecret) return { appId: appId || "", appSecret: appSecret || "", source: "environment" };
    return { appId: this.saved.appId, appSecret: this.saved.appSecret, source: this.saved.appId ? "local" : "none" };
  }
  redact() {
    this.redactor.add(this.credentials().appSecret);
    this.redactor.add(this.saved.connection?.accessToken);
    this.redactor.add(this.saved.connection?.refreshToken);
  }
  persist(next) {
    mkdirSync(dirname(this.secretFile), { recursive: true, mode: 448 });
    const temporary = `${this.secretFile}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(next), { mode: 384, flag: "wx" });
      renameSync(temporary, this.secretFile);
    } finally {
      rmSync(temporary, { force: true });
    }
    this.saved = next;
    this.redact();
  }
  status(origin, ownerId) {
    const credentials = this.credentials(), connection = this.connectionFor(ownerId);
    const expired = !!connection && (connection.needsAuthorization === true || connection.expiresAt <= this.now() && (!connection.refreshToken || connection.refreshExpiresAt !== void 0 && connection.refreshExpiresAt <= this.now()));
    if (this.pending && this.pending.expiresAt <= this.now()) {
      this.pending = void 0;
      this.authError = "授权等待已超时，请重新连接飞书。";
    }
    if (this.device && this.device.expiresAt <= this.now()) {
      this.device = void 0;
      this.authError = "二维码已过期，请点击重新获取。";
    }
    const device = this.device?.ownerId === ownerId ? this.device : void 0;
    return { ...device ? { challenge: { phase: device.phase, verificationUri: device.verificationUri, verificationUrl: device.verificationUrl, userCode: device.userCode, expiresAt: new Date(device.expiresAt).toISOString() } } : {}, configured: !!credentials.appId && !!credentials.appSecret, appId: credentials.appId, source: credentials.source, redirectUri: origin + FEISHU_CALLBACK, connected: !!connection && !expired, needsAuthorization: expired, authorizing: !!device || !!this.pending && this.pending.ownerId === ownerId || this.completing === this.revision && this.completingOwner === ownerId, scopes: connection?.scopes ?? [], requestedScopes: [...FEISHU_SCOPES], ...connection ? { account: connection.account, connectedAt: connection.connectedAt } : {}, ...this.authError ? { error: this.authError } : {} };
  }
  configure(input, origin, ownerId) {
    if (this.credentials().source === "environment") throw new AppError(409, "飞书应用由部署环境配置，请联系管理员修改。");
    if (typeof input.appId !== "string" || !/^cli_[A-Za-z0-9]+$/.test(input.appId.trim())) throw new AppError(400, "请输入以 cli_ 开头的飞书 App ID。");
    if (input.appSecret !== void 0 && typeof input.appSecret !== "string") throw new AppError(400, "App Secret 格式无效。");
    const appId = input.appId.trim(), appSecret = typeof input.appSecret === "string" && input.appSecret.trim() ? input.appSecret.trim() : appId === this.saved.appId ? this.saved.appSecret : "";
    if (!appSecret || appSecret.length > 4096 || /[\r\n\0]/.test(appSecret)) throw new AppError(400, "请填写此应用的 App Secret。");
    const changed = appId !== this.saved.appId || appSecret !== this.saved.appSecret;
    this.persist({ appId, appSecret, ...!changed && this.saved.connection ? { connection: this.saved.connection } : {} });
    this.revision++;
    this.pending = void 0;
    this.device = void 0;
    this.authError = void 0;
    return this.status(origin, ownerId);
  }
  async beginDevice(origin, ownerId, setup = false) {
    const credentials = this.credentials();
    if (setup && credentials.source === "environment") throw new AppError(409, "飞书应用由部署环境配置，请联系管理员修改。");
    if (!setup && (!credentials.appId || !credentials.appSecret)) throw new AppError(409, "请由管理员先接入团队使用的飞书应用，用户登录仅授权表格访问。");
    this.revision++;
    const revision = this.revision;
    this.pending = void 0;
    this.device = void 0;
    this.authError = void 0;
    this.completing = revision;
    this.completingOwner = ownerId;
    try {
      const challenge = setup ? await this.protocol.startRegistration(FEISHU_SCOPES, credentials.appId || void 0) : await this.protocol.startUser(credentials, FEISHU_SCOPES);
      if (revision !== this.revision) throw new AppError(409, "扫码请求已取消，请重新获取二维码。");
      this.device = { ...challenge, ownerId, revision, phase: setup ? "setup" : "login", expiresAt: this.now() + challenge.expiresIn * 1e3, nextPollAt: this.now() + challenge.interval * 1e3, failures: 0, ...!setup ? { appId: credentials.appId } : {} };
      return { status: this.status(origin, ownerId) };
    } catch (error) {
      if (revision === this.revision) this.authError = error instanceof AppError ? error.message : "二维码获取失败，请重试。";
      throw error;
    } finally {
      if (this.completing === revision) this.completing = void 0;
    }
  }
  async poll(origin, ownerId) {
    this.status(origin, ownerId);
    const job = this.device;
    if (!job || job.ownerId !== ownerId || job.nextPollAt > this.now() || this.polling?.revision === job.revision) return this.status(origin, ownerId);
    job.nextPollAt = this.now() + job.interval * 1e3;
    const promise = this.advanceDevice(job);
    const current = { revision: job.revision, promise };
    this.polling = current;
    try {
      await promise;
    } finally {
      if (this.polling === current) this.polling = void 0;
    }
    return this.status(origin, ownerId);
  }
  async advanceDevice(job) {
    let registered = false;
    try {
      const credentials = this.credentials();
      if (job.phase === "login" && credentials.appId !== job.appId) throw new AppError(409, "飞书应用已变化，请重新扫码。");
      const result = job.tokens ?? (job.phase === "setup" ? await this.protocol.pollRegistration(job.deviceCode) : await this.protocol.pollUser(job.deviceCode, credentials));
      if (job.revision !== this.revision || this.device !== job) return;
      if (job.expiresAt <= this.now()) throw new AppError(400, "二维码已过期，请点击重新获取。");
      if (result.error === "authorization_pending") return;
      if (result.error === "slow_down") {
        job.interval = Math.min(job.interval + 5, 60);
        job.nextPollAt = this.now() + job.interval * 1e3;
        return;
      }
      if (result.error || result.code !== void 0 && result.code !== 0) throw deviceError(result);
      if (job.phase === "setup") {
        if (object(result.user_info) && result.user_info.tenant_brand === "lark") throw new AppError(400, "请使用飞书账号扫码，当前入口暂不支持 Lark 账号。");
        if (!result.client_id && !result.client_secret) return;
        if (typeof result.client_id !== "string" || !/^cli_[A-Za-z0-9]+$/.test(result.client_id) || typeof result.client_secret !== "string" || !result.client_secret || result.client_secret.length > 4096) throw new AppError(400, "飞书未返回完整应用信息，请重新扫码接入。");
        this.redactor.add(result.client_secret);
        this.persist({ appId: result.client_id, appSecret: result.client_secret });
        registered = true;
        const challenge = await this.protocol.startUser(this.credentials(), FEISHU_SCOPES);
        if (job.revision !== this.revision || this.device !== job) return;
        this.device = { ...challenge, ownerId: job.ownerId, revision: job.revision, phase: "login", appId: result.client_id, expiresAt: this.now() + challenge.expiresIn * 1e3, nextPollAt: this.now() + challenge.interval * 1e3, failures: 0 };
        this.authError = void 0;
        return;
      }
      job.tokens = result;
      await this.acceptTokens(result, job.revision, job.ownerId);
      if (this.device === job) this.device = void 0;
    } catch (error) {
      if (job.revision !== this.revision || this.device !== job) return;
      if (!registered && error instanceof AppError && error.status >= 500 && ++job.failures < 3) {
        job.nextPollAt = this.now() + Math.min(job.interval * 2, 60) * 1e3;
        return;
      }
      this.device = void 0;
      this.authError = error instanceof AppError ? error.message : "扫码授权未完成，请重新获取二维码。";
    }
  }
  async acceptTokens(tokens, revision, ownerId) {
    const accessToken = tokens.access_token;
    if (typeof accessToken !== "string" || !accessToken || typeof tokens.expires_in !== "number" || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) throw new AppError(502, "飞书没有返回有效的登录凭据，请重新授权。");
    this.redactor.add(accessToken);
    this.redactor.add(tokens.refresh_token);
    const profile = await this.fetchJson(FEISHU_API + "/open-apis/authen/v1/user_info", { headers: { Authorization: `Bearer ${accessToken}` } });
    if (profile.code !== 0 || !object(profile.data) || typeof profile.data.open_id !== "string" || !profile.data.open_id) throw new AppError(502, "飞书用户信息读取失败，请确认应用权限后重新扫码。");
    if (revision !== this.revision) throw new AppError(409, "应用配置或连接状态已变化，请重新授权。");
    const credentials = this.credentials();
    const connection = { id: randomBytes(16).toString("hex"), ownerId, accessToken, refreshToken: typeof tokens.refresh_token === "string" ? tokens.refresh_token : "", expiresAt: this.now() + tokens.expires_in * 1e3, ...typeof tokens.refresh_token_expires_in === "number" ? { refreshExpiresAt: this.now() + tokens.refresh_token_expires_in * 1e3 } : {}, scopes: typeof tokens.scope === "string" ? tokens.scope.split(/\s+/).filter(Boolean) : [], account: { name: typeof profile.data.name === "string" ? profile.data.name : "飞书用户", openId: profile.data.open_id }, connectedAt: new Date(this.now()).toISOString() };
    this.persist({ appId: credentials.appId, appSecret: credentials.source === "environment" ? "" : credentials.appSecret, connection });
    this.revision++;
    this.authError = void 0;
  }
  begin(origin, ownerId) {
    const credentials = this.credentials();
    if (!credentials.appId || !credentials.appSecret) throw new AppError(409, "请先配置飞书应用，再连接飞书。");
    this.revision++;
    this.device = void 0;
    const state = randomBytes(32).toString("base64url"), redirectUri = origin + FEISHU_CALLBACK;
    this.pending = { ownerId, state, redirectUri, expiresAt: this.now() + stateLifetime, revision: this.revision };
    this.authError = void 0;
    const url = new URL(authorizeEndpoint);
    url.searchParams.set("client_id", credentials.appId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", FEISHU_SCOPES.join(" "));
    url.searchParams.set("state", state);
    return { url: url.toString(), status: this.status(origin, ownerId) };
  }
  async callback(params) {
    const pending = this.pending, state = params.get("state") ?? "";
    if (!pending || !state || !same(state, pending.state) || pending.expiresAt <= this.now()) throw new AppError(400, "授权请求已失效，请回到工作台重新连接飞书。");
    this.pending = void 0;
    const revision = this.revision;
    this.completing = revision;
    this.completingOwner = pending.ownerId;
    try {
      if (params.has("error")) throw new AppError(400, "你已取消飞书授权，可以回到工作台重新连接。");
      const code = params.get("code");
      if (!code || code.length > 4096) throw new AppError(400, "飞书没有返回有效授权码，请重新连接。");
      this.redactor.add(code);
      const credentials = this.credentials();
      const tokens = await this.exchange({ grant_type: "authorization_code", client_id: credentials.appId, client_secret: credentials.appSecret, code, redirect_uri: pending.redirectUri });
      await this.acceptTokens(tokens, revision, pending.ownerId);
    } catch (error) {
      if (revision === this.revision) this.authError = error instanceof AppError ? error.message : "飞书连接失败，请稍后重试。";
      throw error;
    } finally {
      if (this.completing === revision) this.completing = void 0;
    }
  }
  cancel(origin, ownerId) {
    if (this.pending && this.pending.ownerId === ownerId || this.completing !== void 0 && this.completingOwner === ownerId || this.device && this.device.ownerId === ownerId) {
      this.revision++;
      this.pending = void 0;
      this.device = void 0;
      this.authError = void 0;
    }
    return this.status(origin, ownerId);
  }
  disconnect(origin, ownerId) {
    if (this.connectionFor(ownerId)) this.persist({ appId: this.saved.appId, appSecret: this.saved.appSecret });
    this.revision++;
    this.pending = void 0;
    this.device = void 0;
    this.authError = void 0;
    return this.status(origin, ownerId);
  }
  connectionFor(ownerId) {
    const connection = this.saved.connection;
    return connection?.ownerId === ownerId ? connection : void 0;
  }
  connectionId(ownerId) {
    return this.connectionFor(ownerId)?.id;
  }
  hasConnection(ownerId) {
    return !!this.connectionFor(ownerId);
  }
  async accessToken(ownerId) {
    const connection = this.connectionFor(ownerId);
    if (!connection || connection.needsAuthorization) throw new AppError(401, "请先在首页连接飞书。");
    if (connection.expiresAt > this.now() + 6e4) return connection.accessToken;
    if (!connection.refreshToken || connection.refreshExpiresAt !== void 0 && connection.refreshExpiresAt <= this.now()) throw new AppError(401, "飞书授权已过期，请在首页重新连接。");
    if (!this.refresh) this.refresh = this.refreshConnection(connection).finally(() => {
      this.refresh = void 0;
    });
    return this.refresh;
  }
  async refreshConnection(connection) {
    const revision = this.revision, credentials = this.credentials();
    try {
      const tokens = await this.exchange({ grant_type: "refresh_token", client_id: credentials.appId, client_secret: credentials.appSecret, refresh_token: connection.refreshToken });
      if (typeof tokens.access_token !== "string" || !tokens.access_token || typeof tokens.expires_in !== "number" || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) throw new AppError(502, "飞书未返回有效续期凭据，请重新授权。");
      if (revision !== this.revision) throw new AppError(409, "飞书连接已变化，请重试。");
      const next = { ...connection, accessToken: tokens.access_token, refreshToken: typeof tokens.refresh_token === "string" && tokens.refresh_token ? tokens.refresh_token : connection.refreshToken, expiresAt: this.now() + tokens.expires_in * 1e3, ...typeof tokens.refresh_token_expires_in === "number" ? { refreshExpiresAt: this.now() + tokens.refresh_token_expires_in * 1e3 } : {}, ...typeof tokens.scope === "string" ? { scopes: tokens.scope.split(/\s+/).filter(Boolean) } : {} };
      this.redactor.add(next.accessToken);
      this.redactor.add(next.refreshToken);
      this.persist({ ...this.saved, connection: next });
      return next.accessToken;
    } catch (error) {
      if (revision === this.revision && error instanceof AppError && error.status === 401) this.persist({ ...this.saved, connection: { ...connection, needsAuthorization: true } });
      throw error;
    }
  }
  async exchange(body) {
    const result = await this.fetchJson(tokenEndpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (result.code !== void 0 && result.code !== 0 || result.error || typeof result.access_token !== "string") {
      const code = typeof result.code === "number" ? String(result.code) : typeof result.error === "string" && /^[a-z_]+$/.test(result.error) ? result.error : "unknown";
      if (code === "server_error" || code === "temporarily_unavailable") throw new AppError(502, "飞书授权服务暂时不可用，请稍后重试。");
      throw new AppError(body.grant_type === "refresh_token" ? 401 : 400, `飞书授权未通过（${code}），请检查应用配置、回调地址与权限后重新授权。`);
    }
    return result;
  }
  async fetchJson(url, init) {
    let response;
    try {
      response = await this.request(url, { ...init, redirect: "error", signal: AbortSignal.timeout(2e4) });
    } catch {
      throw new AppError(502, "暂时无法连接飞书，请检查网络后重试。");
    }
    let result;
    try {
      result = await response.json();
    } catch {
      throw new AppError(502, "飞书返回了无法解析的响应，请稍后重试。");
    }
    if (!object(result)) throw new AppError(502, "飞书响应格式无效，请稍后重试。");
    if (!response.ok && result.code === void 0 && typeof result.error !== "string") throw new AppError(502, `飞书接口暂时不可用（HTTP ${response.status}）。`);
    return result;
  }
}
export {
  FEISHU_API,
  FEISHU_CALLBACK,
  FEISHU_SCOPES,
  FeishuOAuth
};
