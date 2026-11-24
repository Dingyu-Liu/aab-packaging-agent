import { findGameProject } from "./gp-game.js";
import { createServer } from "node:http";
import { readFile, realpath, stat, lstat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { resolve, join, extname } from "node:path";
import { spawn } from "node:child_process";
import { AppError, errorMessage } from "./errors.js";
import { Store } from "./store.js";
import { Redactor } from "./redaction.js";
import { SettingsManager } from "./settings.js";
import { LOCAL_USER } from "./public-user.js";
import { canAccessTask, canUsePlugin, updatePluginId } from "../shared/permissions.js";
import { PluginRegistry } from "./plugins.js";
import { PackageInstaller } from "./package-installer.js";
import { RepoClient } from "./repo-client.js";
import { RepositoryManager, REPOSITORY_UPLOAD_LIMIT } from "./repository-manager.js";
import { inspectProject, directoryDialog, canonicalDirectory } from "./projects.js";
import { TaskManager } from "./tasks.js";
import { OpenCodeEngine } from "./engine.js";
import { ScriptWorkshop } from "./script-workshop.js";
import { DataChatService } from "./data-chat.js";
import { RunOrchestrator } from "./orchestrator.js";
import { assertLocalApplicationRole } from "./role.js";
import { APP_ROOT, VERSION } from "./app.js";
import { isWithin } from "./workspaces.js";
import { FeishuOAuth, FEISHU_CALLBACK } from "./feishu-oauth.js";
import { feishuCallback } from "./feishu-http.js";
import { FeishuBridge } from "./feishu-bridge.js";
import { WebsiteGenerationService, WEBSITE_PLUGIN_ID } from "./website-generation.js";
import { UnityPreparation } from "./unity-preparation.js";
import { SdkDelivery } from "./sdk-delivery.js";
async function createLocalApplication(options = {}) {
  assertLocalApplicationRole();
  const appRoot = options.appRoot || APP_ROOT;
  const dataDir = resolve(options.dataDir || process.env.PARTNER_AGENT_DATA_DIR || join(appRoot, ".local-data"));
  const redactor = new Redactor(), store = new Store(dataDir, redactor, { role: "local" }), settings = new SettingsManager(store, redactor, { appRoot, dataDir });
  const feishu = new FeishuOAuth(dataDir, redactor, options.feishu);
  const bridge = new FeishuBridge(feishu, redactor, () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new AppError(503, "本地飞书连接服务尚未就绪。");
    const host = address.address === "::1" ? "[::1]" : address.address;
    return `http://${host}:${address.port}`;
  }, options.feishu?.fetch);
  const projectRoots = (process.env.PARTNER_AGENT_PROJECT_ROOTS || "").split(",").map((item) => item.trim()).filter(Boolean);
  store.recoverInterrupted();
  const plugins = new PluginRegistry(appRoot, dataDir);
  const installer = PackageInstaller.for(plugins, dataDir, redactor);
  await installer.initialize();
  const repo = new RepoClient(installer, dataDir, redactor);
  await repo.initialize();
  const auth = undefined; // Public desktop edition has no account service.
  await auth?.initialize();
  const repository = new RepositoryManager(installer, repo, redactor);
  await repository.initialize();
  const workshop = new ScriptWorkshop(plugins, dataDir, store, redactor, installer, repo);
  const unityPreparation = new UnityPreparation();
  let tasks;
  let dataChat;
  const engine = new OpenCodeEngine({ appRoot, dataDir, getSettings: () => settings.get(), getApiKey: () => settings.getKey(), onEvent: (id, event) => {
    tasks.handleEngineEvent(id, event);
    dataChat.handleEngineEvent(id, event);
  } });
  tasks = new TaskManager(store, plugins, settings, redactor, engine, dataDir, { origin: (id) => installer.origin(id), assertAllowed: async (id, ownerId) => {
    await auth?.assertTaskAllowed(id, ownerId);
    repo.assertTaskAllowed(id);
  }, scriptEnvironment: (ownerId) => ({ PARTNER_H5_CONFIG_FILE: process.env.PARTNER_H5_CONFIG_FILE ?? join(appRoot, "h5.config.local.json"), ...bridge.environment(ownerId) }) }, unityPreparation, new SdkDelivery(appRoot));
  dataChat = new DataChatService(store, settings, redactor, dataDir, workshop, engine, tasks);
  const websites = new WebsiteGenerationService(store, settings, plugins, redactor, dataDir, async (id, ownerId) => {
    await auth?.assertTaskAllowed(id, ownerId);
    repo.assertTaskAllowed(id);
  }, options.websiteGeneration);
  const orchestrator = new RunOrchestrator(tasks, dataDir);
  if (auth) auth.onSessionEnd = async (userId) => {
    dataChat.cancelAll();
    await websites.cancelOwner(userId);
    for (const plan of await orchestrator.list(50, userId)) if (plan.nodes.some((node) => ["pending", "queued", "running", "waiting_approval"].includes(node.status))) await orchestrator.cancel(plan.id, userId);
    await Promise.allSettled(tasks.list(userId).filter((task) => ["queued", "running", "waiting_approval"].includes(task.status)).map((task) => tasks.cancel(task.id)));
  };
  let vite;
  if (options.dev) {
    const { createServer: createViteServer } = await import("vite");
    vite = await createViteServer({ root: appRoot, server: { middlewareMode: true }, appType: "spa" });
  }
  const desktopToken = options.desktopToken || process.env.PARTNER_AGENT_DESKTOP_TOKEN;
  let updatePrepared = false, activeMutations = 0;
  const server = createServer(async (req, res) => {
    try {
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("X-Frame-Options", "DENY");
      const host = req.headers.host || "";
      const localHost = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host);
      if (!localHost) throw new AppError(403, "本地工作台仅允许通过本机地址访问。");
      const url = new URL(req.url || "/", `http://${host}`), path = url.pathname;
      if (path === FEISHU_CALLBACK && req.method === "GET") return await feishuCallback(feishu, url, res);
      if (path.startsWith("/api/")) {
        const origin = req.headers.origin;
        const allowedOrigins = /* @__PURE__ */ new Set([`http://${host}`, `https://${host}`]);
        if (origin && !allowedOrigins.has(origin)) throw new AppError(403, "已拒绝跨站请求，请从工作台页面操作。");
        if (!["GET", "HEAD"].includes(req.method || "GET") && req.headers["x-partner-agent"] !== "local") throw new AppError(403, "缺少本地操作标记，请刷新工作台。");
        res.setHeader("Cache-Control", "no-store");
        if (req.method === "OPTIONS") throw new AppError(403, "不允许跨站调用。");
        const json = (body2, status = 200) => sendJson(res, body2, status);
        const body = async () => readJson(req);
        const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
        if (path === "/api/health" && req.method === "GET") return json({ ok: true, version: VERSION, role: "local" });
        if (path.startsWith("/api/desktop/update/")) {
          if (!desktopToken || desktopToken.length < 32 || req.headers["x-partner-desktop-token"] !== desktopToken) throw new AppError(404, "接口不存在。");
          if (req.method !== "POST") throw new AppError(405, "请使用 POST。");
          await body();
          if (path === "/api/desktop/update/cancel") {
            updatePrepared = false;
            return json({ ready: false });
          }
          if (path === "/api/desktop/update/prepare") {
            updatePrepared = true;
            const busy = activeMutations > 0 || tasks.list().some((task) => ["queued", "running", "waiting_approval"].includes(task.status)) || engine.info().running || dataChat.hasActive() || websites.hasActive() || orchestrator.hasActive();
            if (busy) {
              updatePrepared = false;
              throw new AppError(409, "仍有任务、批量运行或对话正在执行，请结束后再安装更新。");
            }
            return json({ ready: true });
          }
          throw new AppError(404, "接口不存在。");
        }
        if (updatePrepared && !["GET", "HEAD"].includes(req.method || "GET")) throw new AppError(409, "App 正在准备安装更新，请稍后操作。");
        if (!["GET", "HEAD"].includes(req.method || "GET")) {
          activeMutations++;
          let finished = false;
          const complete = () => {
            if (!finished) {
              finished = true;
              activeMutations--;
            }
          };
          res.once("finish", complete);
          res.once("close", complete);
        }
        if (path === "/api/auth/status" && req.method === "GET") return json(auth ? await auth.status(req.headers.cookie, url.searchParams.get("registryUrl") || void 0) : { authRequired: false, setupRequired: false, user: LOCAL_USER });
        if (parts[1] === "users" || (parts[1] === "auth" && !["status", "me"].includes(parts[2]))) throw new AppError(404, "公开版不提供账号接口。");
        if (path === "/api/feishu/bridge" && req.method === "POST") return json(await bridge.invoke(await body(), req.headers.authorization));
        const user = auth ? await auth.current(req.headers.cookie) : LOCAL_USER;
        const requirePlugin = (id) => {
          if (!canUsePlugin(user, id)) throw new AppError(403, "当前账号没有该模块的使用权限。");
        };
        const visiblePlugins = () => plugins.list().filter((plugin) => canUsePlugin(user, plugin.id));
        const visibleTasks = () => tasks.list(user.role === "admin" ? void 0 : user.id).filter((task) => canAccessTask(user, task));
        const accessibleTask = (id) => {
          const task = tasks.get(id);
          if (!canAccessTask(user, task)) throw new AppError(404, "任务不存在。");
          return task;
        };
        const repoStatus = async () => {
          const status = await repo.status();
          return { ...status, catalog: status.catalog?.filter((pack) => canUsePlugin(user, pack.id)), installed: status.installed?.filter((pack) => canUsePlugin(user, pack.id)), revokedPluginIds: status.revokedPluginIds?.filter((id) => canUsePlugin(user, id)) };
        };
        if (path === "/api/auth/me" && req.method === "GET") return json({ user });
        if (path === "/api/bootstrap" && req.method === "GET") return json({ version: VERSION, role: "local", accountSource: auth?.accountSource, authRequired: !!auth, user, plugins: visiblePlugins(), tasks: visibleTasks(), settings: settings.get(), engine: engine.info(), projectRoots, capabilities: { nativeDialog: process.platform === "darwin" } });
        if (path === "/api/feishu/status" && req.method === "GET") return json(await feishu.poll(url.origin, user.id));
        if (path === "/api/feishu/config" && req.method === "PUT") {
          return json(feishu.configure(await body(), url.origin, user.id));
        }
        if (path === "/api/feishu/oauth/device/start" && req.method === "POST") {
          await body();
          return json(await feishu.beginDevice(url.origin, user.id));
        }
        if (path === "/api/feishu/oauth/setup" && req.method === "POST") {
          await body();
          return json(await feishu.beginDevice(url.origin, user.id, true));
        }
        if (path === "/api/feishu/oauth/start" && req.method === "POST") {
          await body();
          return json(feishu.begin(url.origin, user.id));
        }
        if (path === "/api/feishu/oauth/cancel" && req.method === "POST") {
          await body();
          return json(feishu.cancel(url.origin, user.id));
        }
        if (path === "/api/feishu/connection" && req.method === "DELETE") {
          await body();
          return json(feishu.disconnect(url.origin, user.id));
        }
        if (path === "/api/plugins" && req.method === "GET") return json(visiblePlugins());
        if (path === "/api/plugins/reload" && req.method === "POST") {
          await body();
          await plugins.reload();
          return json(visiblePlugins());
        }
        if (path === "/api/repo/status" && req.method === "GET") return json(await repoStatus());
        if (path === "/api/repo/binding" && req.method === "PUT") {
          if (auth?.accountSource === "registry") throw new AppError(409, "仓库连接跟随当前登录账号，请退出后使用目标账号登录。");
          return json(await repo.bind(await body()));
        }
        if (path === "/api/repo/binding" && req.method === "DELETE") {
          if (auth?.accountSource === "registry") throw new AppError(409, "仓库连接跟随当前登录账号，请使用退出登录。");
          await body();
          return json(await repo.unbind());
        }
        if (path === "/api/repo/check" && req.method === "POST") {
          await body();
          await repo.check();
          return json(await repoStatus());
        }
        if (path === "/api/repo/install" && req.method === "POST") {
          const input = await body();
          if (typeof input.id !== "string" || typeof input.version !== "string") throw new AppError(400, "请选择技能包和目标版本。");
          requirePlugin(input.id);
          await repo.install(input.id, input.version);
          return json(await repoStatus());
        }
        if (path === "/api/repo/rollback" && req.method === "POST") {
          const input = await body();
          if (typeof input.id !== "string") throw new AppError(400, "请选择要回滚的模块。");
          requirePlugin(input.id);
          await installer.rollback(input.id);
          return json(await repoStatus());
        }
        if (path === "/api/repo/restore-builtin" && req.method === "POST") {
          const input = await body();
          if (typeof input.id !== "string") throw new AppError(400, "请选择要恢复内置的模块。");
          requirePlugin(input.id);
          await installer.restoreBuiltin(input.id);
          return json(await repoStatus());
        }
        if (parts[1] === "repository") {
          if (parts.length === 2 && req.method === "GET") return json(await repository.state());
          if (parts.length === 3 && parts[2] === "import" && req.method === "POST") return json(await repository.importModule(await readJson(req, REPOSITORY_UPLOAD_LIMIT), user), 201);
          if (parts.length === 3 && req.method === "GET") return json(await repository.detail(parts[2]));
          if (parts.length === 3 && req.method === "DELETE") {
            await body();
            return json(await repository.uninstall(parts[2]));
          }
          if (parts.length === 4 && parts[3] === "yank" && req.method === "POST") return json(await repository.yank(parts[2], (await body()).version));
          if (parts.length === 4 && parts[3] === "enable" && req.method === "POST") {
            await body();
            return json(await repository.enable(parts[2]));
          }
          if (parts.length === 4 && parts[3] === "download" && req.method === "GET") {
            const file2 = await repository.download(parts[2]);
            res.setHeader("Content-Type", "application/zip");
            res.setHeader("Content-Disposition", `attachment; filename="${file2.filename}"`);
            res.setHeader("Content-Length", String(file2.content.length));
            res.end(file2.content);
            return;
          }
          if (parts.length === 4 && parts[3] === "file" && req.method === "GET") return json(await repository.file(parts[2], url.searchParams.get("path") || ""));
          if (parts.length === 4 && parts[3] === "upload" && req.method === "POST") return json(await repository.upload(parts[2], await readJson(req, REPOSITORY_UPLOAD_LIMIT), user), 201);
          if (parts.length === 4 && parts[3] === "restore" && req.method === "POST") return json(await repository.restore(parts[2], await body()));
          if (parts.length === 4 && parts[3] === "publish" && req.method === "POST") return json(await repository.publish(parts[2], (await body()).baseVersion));
        }
        if (path === "/api/tasks" && req.method === "GET") return json(visibleTasks());
        if (path === "/api/tasks" && req.method === "POST") {
          const input = await body();
          requirePlugin(input.pluginId);
          const task = await tasks.create({ ...input, ownerId: user.id });
          return json(task, 201);
        }
        if (path === "/api/website-generation/tasks" && req.method === "POST") {
          requirePlugin(WEBSITE_PLUGIN_ID);
          return json(await websites.create(await body(), user.id), 201);
        }
        if (parts[1] === "website-generation" && parts[2] === "tasks" && parts[3] && parts[4] === "preview" && parts.length === 6 && req.method === "GET") {
          accessibleTask(parts[3]);
          const content2 = await websites.preview(parts[3], parts[5]);
          res.setHeader("X-Frame-Options", "SAMEORIGIN");
          res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-same-origin allow-popups allow-popups-to-escape-sandbox");
          res.setHeader("Content-Type", parts[5] === "styles.css" ? "text/css; charset=utf-8" : "text/html; charset=utf-8");
          res.end(content2);
          return;
        }
        if (path === "/api/gp-build/tasks" && req.method === "POST") {
          requirePlugin("gp-build");
          const input = await body();
          if (typeof input.projectPath !== "string" || typeof input.versionName !== "string" || typeof input.versionCode !== "number") throw new AppError(400, "请选择 Android 工程并填写目标版本号和 Version Code。");
          return json(await tasks.create({ pluginId: "gp-build", profileId: "android-aab", projectType: "android", projectPath: input.projectPath, parameters: { ...input.category !== void 0 ? { category: input.category } : {}, versionName: input.versionName, versionCode: input.versionCode, ...input.module !== void 0 ? { module: input.module } : {}, ...input.variant !== void 0 ? { variant: input.variant } : {} }, mode: "execute", ownerId: user.id }), 201);
        }
        if (path === "/api/projects/inspect" && req.method === "POST") {
          const input = await body();
          if (typeof input.path !== "string") throw new AppError(400, "请选择本机工程目录。");
          return json(await inspectProject(input.category === "game" ? await findGameProject(await canonicalDirectory(input.path)) : input.path, { unityToolchain: input.sdkPartner === "01", refreshUnityToolchain: input.sdkPartner === "01" }));
        }
        if (path === "/api/projects/roots" && req.method === "GET") return json({ roots: projectRoots });
        if (path === "/api/dialog/directory" && req.method === "POST") {
          await body();
          return json(await directoryDialog("directory"));
        }
        if (path === "/api/dialog/file" && req.method === "POST") {
          await body();
          return json(await directoryDialog("file"));
        }
        if (path === "/api/settings" && req.method === "GET") return json(settings.get());
        if (path === "/api/settings" && req.method === "PUT") {
          if (tasks.hasModelTask() || websites.hasActive()) throw new AppError(409, "有任务正在使用模型配置，请完成或取消后再修改。");
          const saved = settings.save(await body());
          return json(saved);
        }
        if (path === "/api/settings/test" && req.method === "POST") {
          await body();
          return json(await settings.test());
        }
        if (path === "/api/settings/models" && (req.method === "GET" || req.method === "POST")) {
          return json(await settings.listModels(req.method === "POST" ? await body() : {}));
        }
        const accessibleChat = async (id) => {
          const session = dataChat.get(id, user);
          if (session.mode === "script" && session.scopeId) {
            try {
              await workshop.getCandidate(session.scopeId, user);
            } catch (error) {
              if (!(error instanceof AppError) || error.status !== 404) throw error;
            }
          }
          return session;
        };
        if (path === "/api/data-chat/sessions" && req.method === "GET") {
          const sessions = dataChat.list(url.searchParams.get("mode") === "assistant" ? "assistant" : url.searchParams.get("mode") === "script" ? "script" : "data", user.role === "admin" ? void 0 : user.id);
          const allowed = [];
          for (const session of sessions) {
            try {
              await accessibleChat(session.id);
              allowed.push(session);
            } catch (error) {
              if (!(error instanceof AppError) || ![403, 404].includes(error.status)) throw error;
            }
          }
          return json(allowed);
        }
        if (path === "/api/data-chat/sessions" && req.method === "POST") {
          const input = await body();
          if (input.mode === "script") {
            if (typeof input.scopeId !== "string") throw new AppError(400, "脚本更新需要选择工作副本。");
            await workshop.getCandidate(input.scopeId, user);
          }
          return json(dataChat.create(input, user), 201);
        }
        if (parts[1] === "data-chat" && parts[2] === "sessions" && parts[3] && parts.length >= 4) {
          const id = parts[3];
          await accessibleChat(id);
          if (parts.length === 4 && req.method === "GET") return json(dataChat.get(id, user));
          if (parts.length === 4 && req.method === "DELETE") {
            await body();
            dataChat.remove(id, user);
            return json({ ok: true });
          }
          if (parts[4] === "cancel" && parts.length === 5 && req.method === "POST") {
            await body();
            dataChat.cancel(id, user);
            return json({ ok: true });
          }
          if (parts[4] === "messages" && parts.length === 5 && req.method === "POST") {
            const content2 = (await body()).content;
            res.on("close", () => {
              if (!res.writableEnded) dataChat.cancel(id, user);
            });
            await dataChat.stream(id, content2, res, user);
            return;
          }
        }
        if (path === "/api/runs/batch" && req.method === "GET") return json((await orchestrator.list(20, user.id, user.role === "admin")).filter((plan) => plan.nodes.every((node) => canUsePlugin(user, updatePluginId(node.kind)))));
        if (path === "/api/runs/batch" && req.method === "POST") {
          const input = await body();
          if (!Array.isArray(input.nodes)) throw new AppError(400, "批量更新参数无效。");
          for (const node of input.nodes) {
            if (!node || !["consume", "h5", "ads"].includes(node.kind)) throw new AppError(400, "更新类别无效。");
            requirePlugin(updatePluginId(node.kind));
          }
          return json(await orchestrator.create(input, user.id), 201);
        }
        if (parts[1] === "runs" && parts[2] === "batch" && parts[3]) {
          const id = parts[3];
          const plan = await orchestrator.get(id, user.id, user.role === "admin");
          for (const node of plan.nodes) requirePlugin(updatePluginId(node.kind));
          if (parts.length === 4 && req.method === "GET") return json(plan);
          if (parts[4] === "cancel" && parts.length === 5 && req.method === "POST") {
            await body();
            return json(await orchestrator.cancel(id, user.id, user.role === "admin"));
          }
        }
        if (parts[1] === "script-workshop") {
          if (parts[2] === "candidates" && parts.length === 3 && req.method === "GET") return json(await workshop.listCandidates(url.searchParams.get("pluginId") || void 0, user));
          if (parts[2] === "candidates" && parts.length === 3 && req.method === "POST") {
            const input = await body();
            return json(await workshop.createCandidate(String(input.pluginId || ""), user), 201);
          }
          if (parts[2] === "candidates" && parts[3] && parts.length === 4 && req.method === "GET") return json(await workshop.getCandidate(parts[3], user));
          if (parts[2] === "candidates" && parts[3] && parts[4] === "check" && parts.length === 5 && req.method === "POST") {
            await body();
            return json(await workshop.checkCandidate(parts[3], user));
          }
          if (parts[2] === "candidates" && parts[3] && parts[4] === "publish" && parts.length === 5 && req.method === "POST") {
            await body();
            return json(await workshop.publishCandidate(parts[3], user));
          }
          if (parts[2] === "releases" && parts.length === 3 && req.method === "GET") {
            const pluginId = url.searchParams.get("pluginId") || void 0;
            return json(workshop.listReleases(pluginId).filter((release) => canUsePlugin(user, release.pluginId) && (user.role === "admin" || release.ownerId === user.id)));
          }
          if (parts[2] === "rollback" && parts.length === 3 && req.method === "POST") {
            const input = await body();
            return json(await workshop.rollback(String(input.pluginId || ""), user));
          }
        }
        if (path === "/api/engine" && req.method === "GET") return json(engine.info());
        if (parts[1] === "tasks" && parts[2]) {
          const id = parts[2];
          const taskRecord = accessibleTask(id);
          if (parts.length === 3 && req.method === "GET") return json(tasks.get(id));
          if (parts[3] === "confirm-unity" && parts.length === 4 && req.method === "POST") {
            await body();
            return json(await tasks.confirmUnityPreparation(id));
          }
          if (parts[3] === "confirm-gp-build" && parts.length === 4 && req.method === "POST") return json(await tasks.confirmGpBuild(id, (await body()).compilationId));
          if (parts[3] === "cancel" && parts.length === 4 && req.method === "POST") {
            await body();
            return json(taskRecord.websiteGeneration ? await websites.cancel(id) : await tasks.cancel(id));
          }
          if (parts[3] === "messages" && parts.length === 4 && req.method === "POST") {
            if (taskRecord.websiteGeneration) throw new AppError(400, "请在官网与隐私模块调整条件后重新生成。");
            return json(await tasks.message(id, (await body()).content));
          }
          if (parts[3] === "permissions" && parts[4] && parts.length === 5 && req.method === "POST") return json(await tasks.replyPermission(id, parts[4], (await body()).reply));
          if (parts[3] === "open-workspace" && parts.length === 4 && req.method === "POST") {
            await body();
            const task = tasks.get(id);
            if (!task.workspacePath) throw new AppError(400, "该任务尚未创建工程副本。");
            const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
            await new Promise((done, fail) => {
              const child = spawn(command, [task.workspacePath], { stdio: "ignore" });
              child.once("error", () => fail(new AppError(400, "无法打开目录，请复制工作副本路径。")));
              child.once("close", (code) => code === 0 ? done() : fail(new AppError(400, "系统未能打开工作副本目录。")));
            });
            return json({ ok: true });
          }
          if (parts[3] === "artifacts" && parts[4] && parts.length === 5 && req.method === "GET") {
            const task = tasks.get(id), artifact = task.artifacts.find((item) => item.id === parts[4]);
            if (!artifact || artifact.type === "directory") throw new AppError(404, "未找到可下载的文件。");
            const file2 = await realpath(artifact.path).catch(() => {
              throw new AppError(404, "文件已不存在。");
            });
            if (!isWithin(join(await realpath(dataDir), "tasks", id), file2) || (await lstat(file2)).isSymbolicLink() || !(await stat(file2)).isFile()) throw new AppError(403, "文件路径无效。");
            res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(artifact.name)}`, "Content-Length": (await stat(file2)).size });
            createReadStream(file2).pipe(res);
            return;
          }
        }
        throw new AppError(404, "未找到该接口。");
      }
      if (!["GET", "HEAD"].includes(req.method || "GET")) throw new AppError(405, "不支持的请求方式。");
      if (vite) {
        vite.middlewares(req, res, () => {
          res.writeHead(404);
          res.end();
        });
        return;
      }
      const dist = join(appRoot, "dist"), requested = resolve(dist, "." + decodeURIComponent(path));
      if (!isWithin(dist, requested)) throw new AppError(403, "无效的文件路径。");
      let file = requested;
      try {
        if (!(await stat(file)).isFile()) file = join(dist, "index.html");
      } catch {
        file = join(dist, "index.html");
      }
      let content;
      try {
        content = await readFile(file);
      } catch {
        throw new AppError(503, "界面尚未构建，请先运行 pnpm build。");
      }
      const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
      res.setHeader("Content-Type", mime[extname(file)] || "application/octet-stream");
      res.setHeader("Cache-Control", extname(file) === ".html" ? "no-cache" : "public,max-age=3600");
      res.end(content);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const status = error instanceof AppError ? error.status : 500;
      sendJson(res, { error: redactor.text(status === 500 ? "服务处理失败，请查看本地日志或重试。" : errorMessage(error)) }, status);
      if (status === 500) console.error(redactor.text(errorMessage(error)));
    }
  });
  return { server, store, auth, tasks, websites, settings, plugins, engine, workshop, dataChat, orchestrator, installer, repo, repository, feishu, bridge, role: "local", dataDir, async close() {
    dataChat.cancelAll();
    await websites.cancelOwner();
    await tasks.close();
    await auth?.close();
    await vite?.close();
    await new Promise((done) => server.close(() => done()));
    store.close();
  } };
}
function sendJson(res, body, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
async function readJson(req, limit = 1e6) {
  if (!(req.headers["content-type"] || "").includes("application/json")) throw new AppError(415, "请使用 JSON 请求。");
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) throw new AppError(413, "请求内容过大。");
    chunks.push(Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks, bytes).toString("utf8");
  let parsed;
  try {
    parsed = body ? JSON.parse(body) : {};
  } catch {
    throw new AppError(400, "JSON 格式无效。");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new AppError(400, "请求必须是 JSON 对象。");
  return parsed;
}
export {
  createLocalApplication
};
