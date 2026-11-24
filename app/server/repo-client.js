import { chmod, lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { AppError } from "./errors.js";
import { sha256 } from "./pack-utils.js";
import { prepareRepoPublication, publishRepoPublication } from "./repo-publisher.js";
import { PACKAGE_ID, pathExists, privateDirectory, readPrivateJson, readRegularFile, validPackageVersion, validateRepoPack, writePrivateFile, writePrivateJson } from "./package-validation.js";
function normalizeRepoUrl(input) {
  if (typeof input !== "string" || input.length > 2048 || input !== input.trim() || /[\s\u0000-\u001f\u007f]/.test(input)) throw new AppError(400, "仓库 URL 无效。");
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new AppError(400, "仓库 URL 无效。");
  }
  if (url.username || url.password || url.search || url.hash || !["http:", "https:"].includes(url.protocol)) throw new AppError(400, "仓库 URL 不能包含凭据、查询参数或片段。");
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !loopback) throw new AppError(400, "远程仓库必须使用 HTTPS。");
  if (url.pathname.split("/").some((part) => /%(?:2f|5c|2e|00)/i.test(part)) || url.pathname.includes("\\")) throw new AppError(400, "仓库 URL 路径无效。");
  return url.toString().replace(/\/+$/, "");
}
function validateToken(value) {
  if (typeof value !== "string" || value.length < 8 || value.length > 8192 || /[^\x21-\x7e]/.test(value)) throw new AppError(400, "请填写有效的仓库 PAT。");
  return value;
}
function catalogItems(input) {
  const list = Array.isArray(input) ? input : input && typeof input === "object" ? input.packs : void 0;
  if (!Array.isArray(list) || list.length > 2e3) throw new AppError(400, "仓库目录格式无效。");
  const ids = /* @__PURE__ */ new Set();
  return list.map((item) => {
    if (!item || !PACKAGE_ID.test(item.id) || ids.has(item.id) || !validPackageVersion(item.version) || !["skill", "script"].includes(item.kind) || !["sdk", "script", "website"].includes(item.moduleKind) || !["stable", "beta"].includes(item.channel) || typeof item.name !== "string" || item.name.length > 1e3 || typeof item.description !== "string" || item.description.length > 1e5 || !/^[a-f0-9]{64}$/.test(item.packSha256) || typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt))) throw new AppError(400, "仓库目录条目无效。");
    ids.add(item.id);
    return { id: item.id, name: item.name, version: item.version, kind: item.kind, moduleKind: item.moduleKind, description: item.description, channel: item.channel, packSha256: item.packSha256, createdAt: item.createdAt, ...item.yanked ? { yanked: true } : {} };
  });
}
class RepoClient {
  constructor(installer, dataDir, redactor) {
    this.installer = installer;
    this.dataDir = dataDir;
    this.redactor = redactor;
    this.root = join(installer.root, "repository");
    this.bindingPath = join(this.root, "binding.json");
    this.credentialsPath = join(this.root, "credentials.json");
    this.cachePath = join(this.root, "catalog.json");
  }
  installer;
  dataDir;
  redactor;
  root;
  bindingPath;
  credentialsPath;
  cachePath;
  ready;
  binding;
  token;
  sessionConnection;
  cache = { schemaVersion: 1, catalog: [], revokedPluginIds: [] };
  online;
  error;
  operations = Promise.resolve();
  initialize() {
    if (!this.ready) this.ready = (async () => {
      await this.installer.initialize();
      await privateDirectory(this.root);
      if (await pathExists(this.cachePath)) {
        const cached = await readPrivateJson(this.cachePath);
        if (!cached || cached.schemaVersion !== 1 || !Array.isArray(cached.revokedPluginIds) || cached.revokedPluginIds.some((id) => !PACKAGE_ID.test(id)) || cached.allowedPlugins !== void 0 && (!Array.isArray(cached.allowedPlugins) || cached.allowedPlugins.some((id) => !PACKAGE_ID.test(id))) || cached.managedPluginIds !== void 0 && (!Array.isArray(cached.managedPluginIds) || cached.managedPluginIds.some((id) => !PACKAGE_ID.test(id)))) throw new AppError(500, "本地仓库授权缓存损坏。");
        this.cache = { schemaVersion: 1, catalog: catalogItems(cached.catalog), revokedPluginIds: [...new Set(cached.revokedPluginIds)], ...cached.checkedAt ? { checkedAt: cached.checkedAt } : {}, ...cached.allowedPlugins ? { allowedPlugins: cached.allowedPlugins } : {}, ...cached.admin === true ? { admin: true } : {}, ...cached.managedPluginIds ? { managedPluginIds: cached.managedPluginIds } : {} };
      }
      if (await pathExists(this.credentialsPath)) {
        const info = await lstat(this.credentialsPath);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new AppError(500, "仓库凭据必须保存在本机普通文件中。");
        await chmod(this.credentialsPath, 384);
        const credential = await readPrivateJson(this.credentialsPath, 16384);
        this.redactor.add(credential.token);
        if (await pathExists(this.bindingPath)) {
          const binding = await readPrivateJson(this.bindingPath, 8192);
          const url = normalizeRepoUrl(binding.url);
          if (credential.url === url) {
            this.binding = { url };
            this.token = validateToken(credential.token);
          } else this.error = "仓库绑定与凭据不匹配，请重新绑定。";
        }
      }
    })();
    return this.ready;
  }
  useSession(connection) {
    this.sessionConnection = connection ? { url: connection.url, token: connection.token } : void 0;
    this.online = void 0;
    this.error = void 0;
    this.cache.catalog = [];
    this.cache.allowedPlugins = void 0;
    this.cache.admin = void 0;
    this.cache.revokedPluginIds = [];
  }
  connection() {
    return this.sessionConnection ?? (this.binding && this.token ? { url: this.binding.url, token: this.token } : void 0);
  }
  serialized(fn) {
    const result = this.operations.then(fn, fn);
    this.operations = result.catch(() => void 0);
    return result;
  }
  async status() {
    await this.initialize();
    return this.redactor.json({ bound: !!this.connection(), ...this.connection() ? { url: this.connection().url } : {}, ...this.online === void 0 ? {} : { online: this.online }, ...this.cache.checkedAt ? { checkedAt: this.cache.checkedAt } : {}, ...this.error ? { error: this.error } : {}, catalog: structuredClone(this.cache.catalog), installed: await this.installer.list(), revokedPluginIds: [...this.cache.revokedPluginIds], cacheBytes: await this.cacheBytes() });
  }
  async bind(input) {
    await this.initialize();
    return this.serialized(async () => {
      if (!input || typeof input !== "object") throw new AppError(400, "仓库绑定参数无效。");
      const url = normalizeRepoUrl(input.url);
      let token;
      if (input.token !== void 0 && input.token !== "") token = validateToken(input.token);
      else if (input.username || input.password) token = await this.loginForToken(url, input);
      else if (this.binding?.url === url && this.token) token = this.token;
      else throw new AppError(400, "请填写仓库 PAT 或登录凭据。");
      this.redactor.add(token);
      if (url.includes(token)) throw new AppError(400, "仓库 URL 不能包含 PAT。");
      await writePrivateJson(this.credentialsPath, { url, token });
      await writePrivateJson(this.bindingPath, { url });
      this.binding = { url };
      this.token = token;
      this.online = void 0;
      this.error = void 0;
      this.cache.catalog = [];
      await this.saveCache();
      return this.status();
    });
  }
  async unbind() {
    await this.initialize();
    return this.serialized(async () => {
      await rm(this.bindingPath, { force: true });
      await rm(this.credentialsPath, { force: true });
      this.binding = void 0;
      this.token = void 0;
      this.online = void 0;
      this.error = void 0;
      this.cache.catalog = [];
      await this.saveCache();
      return this.status();
    });
  }
  /** Only authorization and the catalog are requested; package metadata/files are never fetched here. */
  async check() {
    await this.initialize();
    return this.serialized(async () => {
      this.requireBinding();
      this.cache.checkedAt = (/* @__PURE__ */ new Date()).toISOString();
      try {
        const user = await this.requestJson("/api/auth/me");
        const account = user?.user;
        if (!account || !["admin", "member"].includes(String(account.role)) || !Array.isArray(account.allowedPlugins) || account.allowedPlugins.some((id) => typeof id !== "string" || !PACKAGE_ID.test(id))) throw new AppError(400, "仓库账号授权响应无效。");
        const admin = account.role === "admin", allowedPlugins = [...account.allowedPlugins];
        const installed = await this.installer.list();
        const known = /* @__PURE__ */ new Set([...installed.filter((pack) => pack.source === "registry").map((pack) => pack.id), ...this.cache.revokedPluginIds, ...this.cache.allowedPlugins ?? [], ...this.cache.managedPluginIds ?? []]);
        this.cache.admin = admin;
        this.cache.allowedPlugins = allowedPlugins;
        this.cache.revokedPluginIds = admin ? [] : [...known].filter((id) => !allowedPlugins.includes(id));
        await this.saveCache();
        const catalog = catalogItems(await this.requestJson("/api/repo/v1/packs"));
        this.cache.catalog = admin ? catalog : catalog.filter((pack) => allowedPlugins.includes(pack.id));
        this.online = true;
        this.error = void 0;
      } catch (error) {
        this.online = false;
        this.error = this.publicError(error);
        if (error instanceof AppError && [401, 403].includes(error.status)) {
          const installed = await this.installer.list();
          this.cache.revokedPluginIds = [.../* @__PURE__ */ new Set([...this.cache.revokedPluginIds, ...installed.filter((pack) => pack.source === "registry").map((pack) => pack.id), ...this.cache.managedPluginIds ?? []])];
        }
      }
      await this.saveCache();
      return this.status();
    });
  }
  assertAllowed(id) {
    if (this.cache.revokedPluginIds.includes(id)) throw new AppError(403, "该模块的仓库授权已撤销，已有任务可继续，不能创建新任务。");
  }
  assertTaskAllowed(id) {
    this.assertAllowed(id);
  }
  async install(id, version) {
    await this.initialize();
    return this.serialized(async () => {
      if (typeof id !== "string" || !PACKAGE_ID.test(id) || !validPackageVersion(version)) throw new AppError(400, "模块 id 或版本无效。");
      this.requireBinding();
      this.assertAllowed(id);
      try {
        const pack = validateRepoPack(await this.requestJson(`/api/repo/v1/packs/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}`));
        if (pack.id !== id || pack.version !== version) throw new AppError(400, "仓库返回的技能包 id 或版本不匹配。");
        const catalog = this.cache.catalog.find((item) => item.id === id && item.version === version);
        if (catalog && catalog.packSha256 !== pack.packSha256) throw new AppError(400, "仓库技能包与已检查目录的 SHA-256 不一致。");
        const result = await this.installer.install(pack, (file) => this.blob(pack, file));
        this.cache.managedPluginIds = [.../* @__PURE__ */ new Set([...this.cache.managedPluginIds ?? [], id])];
        await this.saveCache();
        this.online = true;
        this.error = void 0;
        return result;
      } catch (error) {
        this.error = this.publicError(error);
        if (error instanceof AppError && [401, 403].includes(error.status)) {
          this.cache.revokedPluginIds = [.../* @__PURE__ */ new Set([...this.cache.revokedPluginIds, id])];
          await this.saveCache();
        }
        throw error instanceof AppError ? new AppError(error.status, this.error) : new AppError(503, this.error);
      }
    });
  }
  /** Publish the locally installed bytes after activation; never turn a remote failure into success. */
  /** Yank a published version so it can no longer be installed. Immutable content and installed copies stay intact. */
  async yank(id, version) {
    try {
      await this.initialize();
    } catch (error) {
      throw new AppError(error instanceof AppError ? error.status : 500, this.publicError(error));
    }
    return this.serialized(async () => {
      if (!this.connection()) return { status: "unbound" };
      try {
        await this.requestJson(`/api/repo/v1/packs/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}/yank`, { method: "POST", headers: { "Content-Type": "application/json", "X-Partner-Agent": "local" }, body: "{}" }, this.requireBinding());
        this.online = true;
        this.error = void 0;
        return { status: "yanked" };
      } catch (error) {
        this.online = false;
        this.error = this.publicError(error);
        throw new AppError(error instanceof AppError ? error.status : 503, this.error);
      }
    });
  }
  async publishDirectory(directory) {
    try {
      await this.initialize();
    } catch (error) {
      throw new AppError(error instanceof AppError ? error.status : 500, this.publicError(error));
    }
    return this.serialized(async () => {
      if (!this.connection()) return { status: "unbound" };
      try {
        const connection = this.requireBinding();
        const publication = await this.installer.plugins.withReadLock(async () => {
          try {
            return await prepareRepoPublication(directory);
          } catch (error) {
            throw error instanceof AppError ? error : new AppError(400, "无法读取待推送的本地技能包，请检查目录和文件权限。");
          }
        });
        const pack = await publishRepoPublication(publication, connection, this.redactor);
        this.online = true;
        this.error = void 0;
        return { status: "published", pack };
      } catch (error) {
        this.online = false;
        this.error = this.publicError(error);
        throw new AppError(error instanceof AppError ? error.status : 503, this.error);
      }
    });
  }
  requireBinding() {
    const connection = this.connection();
    if (!connection) throw new AppError(400, "请先绑定技能包仓库。");
    return connection;
  }
  async saveCache() {
    await writePrivateJson(this.cachePath, this.redactor.json(this.cache));
  }
  async requestJson(path, init = {}, connection) {
    const response = await this.request(path, init, connection);
    const bytes = await this.responseBytes(response, 4 * 1024 * 1024);
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new AppError(400, "仓库响应不是合法 JSON。");
    }
  }
  async request(path, init = {}, connection) {
    const bound = connection ?? this.requireBinding();
    const headers = new Headers(init.headers);
    if (bound.token) headers.set("Authorization", `Bearer ${bound.token}`);
    headers.set("Accept", "application/json");
    let response;
    try {
      response = await fetch(`${bound.url}${path}`, { ...init, headers, redirect: "manual", credentials: "omit", signal: AbortSignal.timeout(2e4) });
    } catch {
      throw new AppError(503, "仓库不可用，已安装的本地包可继续离线使用。");
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new AppError(400, "仓库重定向已拒绝，请直接绑定最终 HTTPS 地址。");
    }
    if (!response.ok) {
      await response.body?.cancel();
      const message = response.status === 401 ? "仓库凭据已失效，请重新绑定。" : response.status === 403 ? "仓库拒绝授权。" : response.status === 404 ? "仓库中的包或接口不存在。" : "仓库请求失败。";
      throw new AppError(response.status, message);
    }
    return response;
  }
  async responseBytes(response, limit) {
    const declared = response.headers.get("content-length");
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
      await response.body?.cancel();
      throw new AppError(400, "仓库响应超过大小上限。");
    }
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > limit) {
          await reader.cancel();
          throw new AppError(400, "仓库响应超过大小上限。");
        }
        chunks.push(Buffer.from(item.value));
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks, size);
  }
  async blob(pack, file) {
    const directory = join(this.installer.root, "blobs", file.sha256.slice(0, 2));
    await privateDirectory(directory);
    const path = join(directory, file.sha256);
    if (await pathExists(path)) {
      try {
        const cached = await readRegularFile(path, 8 * 1024 * 1024);
        if (cached.length === file.size && sha256(cached) === file.sha256) return cached;
      } catch {
      }
      await rm(path, { force: true });
    }
    const response = await this.request(`/api/repo/v1/packs/${encodeURIComponent(pack.id)}/versions/${encodeURIComponent(pack.version)}/file?path=${encodeURIComponent(file.path)}`);
    const bytes = await this.responseBytes(response, file.size);
    if (bytes.length !== file.size || sha256(bytes) !== file.sha256) throw new AppError(400, `下载文件 SHA-256 校验失败：${file.path}`);
    await writePrivateFile(path, bytes);
    return bytes;
  }
  async cacheBytes() {
    let total = 0;
    for (const entry of await readdir(join(this.installer.root, "blobs"), { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9]{2}$/.test(entry.name)) continue;
      for (const file of await readdir(join(this.installer.root, "blobs", entry.name), { withFileTypes: true })) {
        if (file.isFile() && /^[a-f0-9]{64}$/.test(file.name)) total += (await lstat(join(this.installer.root, "blobs", entry.name, file.name))).size;
      }
    }
    return total;
  }
  async loginForToken(url, input) {
    if (typeof input.username !== "string" || !input.username || typeof input.password !== "string" || !input.password || input.username.length > 200 || input.password.length > 1024) throw new AppError(400, "请填写仓库用户名和密码。");
    this.redactor.add(input.password);
    const response = await this.request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: input.username, password: input.password }) }, { url });
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    await response.body?.cancel();
    if (!cookie || /[\r\n]/.test(cookie)) throw new AppError(400, "仓库登录没有返回有效会话。");
    this.redactor.add(cookie.split("=").slice(1).join("="));
    try {
      const issued = await this.requestJson("/api/auth/token", { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ name: "Local App", days: 90 }) }, { url });
      const token = validateToken(issued?.token);
      this.redactor.add(token);
      return token;
    } finally {
      try {
        const logout = await this.request("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: "{}" }, { url });
        await logout.body?.cancel();
      } catch {
      }
    }
  }
  publicError(error) {
    return this.redactor.text(error instanceof AppError ? error.message : "仓库不可用，已安装的本地包可继续离线使用。");
  }
}
export {
  RepoClient,
  normalizeRepoUrl
};
