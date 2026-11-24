import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { configuredModelRequest } from "./model-request.js";
import { repairResponsesReasoning } from "./responses-repair.js";
const OPENCODE_VERSION = "1.19.5";
const fullAccessPermissions = [{ permission: "*", pattern: "*", action: "allow" }];
const modelTools = { question: false, task: false };
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => {
  });
  return { promise, resolve, reject };
}
function message(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) || "未知引擎错误";
  } catch {
    return "未知引擎错误";
  }
}
function cleanSecret(secret) {
  const values = [.../* @__PURE__ */ new Set([secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)])].filter(Boolean).sort((a, b) => b.length - a.length);
  return (text) => {
    for (const value of values) text = text.split(value).join("[已隐藏]");
    return text.replace(/\bBearer\s+[^\s"',}]+/gi, "Bearer [已隐藏]");
  };
}
function failure(text, name = "Error") {
  const error = new Error(text);
  error.name = name;
  return error;
}
async function closeServer(server) {
  if (!server) return;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(() => resolve()));
}
class OpenCodeEngine {
  constructor(options) {
    this.options = options;
    this.binary = join(options.appRoot, "node_modules", "opencode-ai", "bin", "opencode.exe");
  }
  options;
  active = /* @__PURE__ */ new Map();
  closed = false;
  binary;
  info() {
    let installed = false;
    let detail = `需要安装固定版本 opencode-ai 和 @opencode-ai/sdk ${OPENCODE_VERSION}。`;
    try {
      const cli = JSON.parse(readFileSync(join(this.options.appRoot, "node_modules/opencode-ai/package.json"), "utf8"));
      const sdk = JSON.parse(readFileSync(join(this.options.appRoot, "node_modules/@opencode-ai/sdk/package.json"), "utf8"));
      installed = cli.version === OPENCODE_VERSION && sdk.version === OPENCODE_VERSION && existsSync(this.binary) && statSync(this.binary).size > 1e6;
      if (installed) detail = "已安装；执行时启动独立本地服务，使用指定工程目录和应用专属 XDG 目录。权限控制不等同系统沙箱。";
      else detail = `CLI/SDK 必须同时固定为 ${OPENCODE_VERSION}，并完成平台二进制安装。`;
    } catch {
    }
    return { name: "OpenCode", installed, version: OPENCODE_VERSION, running: this.active.size > 0, detail };
  }
  async run(input) {
    if (this.closed) throw new Error("引擎已关闭。");
    if (this.active.has(input.taskId)) throw new Error("该任务已在执行中。");
    if (!this.info().installed) throw new Error(this.info().detail);
    const settings = { ...this.options.getSettings() };
    const key = this.options.getApiKey().trim();
    if (!key) throw new Error("尚未配置模型 API 密钥，请在设置中填写后再执行。");
    const clean = cleanSecret(key);
    if (/[\r\n]/.test(key)) throw new Error("模型 API 密钥不能包含换行。");
    let endpoint;
    try {
      endpoint = new URL(settings.apiBaseUrl);
    } catch {
      throw new Error("模型 API 地址无效。");
    }
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new Error("模型 API 地址必须是 HTTP(S) 基础地址，不能包含账号、密钥、查询参数或片段。");
    }
    if (!settings.model.trim()) throw new Error("请配置模型名称。");
    if (!["openai", "openai-compatible"].includes(settings.protocol)) throw new Error("模型协议无效。");
    if (!Number.isFinite(settings.timeoutMinutes) || settings.timeoutMinutes <= 0 || settings.timeoutMinutes > 1440) throw new Error("任务超时必须大于 0 且不超过 1440 分钟。");
    if (!Number.isInteger(settings.maxSteps) || settings.maxSteps < 1 || settings.maxSteps > 1e3) throw new Error("最大模型步骤必须是 1 到 1000 的整数。");
    if (!input.prompt.trim()) throw new Error("任务指令不能为空。");
    if (input.signal?.aborted) throw failure("任务已取消。", "AbortError");
    const completion = deferred();
    const task = {
      id: input.taskId,
      directory: input.workspacePath,
      controller: new AbortController(),
      permissions: /* @__PURE__ */ new Set(),
      finishing: false,
      clean,
      done: completion.promise,
      finish: () => completion.resolve()
    };
    this.active.set(input.taskId, task);
    const cancel = () => {
      void this.stop(task, failure("任务已取消。", "AbortError"));
    };
    input.signal?.addEventListener("abort", cancel, { once: true });
    if (input.signal?.aborted) cancel();
    const timeout = setTimeout(() => {
      void this.stop(task, failure(`任务超过配置的 ${settings.timeoutMinutes} 分钟，已停止模型和执行进程。`, "TimeoutError"));
    }, settings.timeoutMinutes * 6e4);
    timeout.unref();
    try {
      task.directory = await realpath(input.workspacePath);
      if (!statSync(task.directory).isDirectory()) throw new Error("任务工作副本必须是目录。");
      task.controller.signal.throwIfAborted();
      const taskRoot = join(this.options.dataDir, "engine", "tasks", createHash("sha256").update(task.id).digest("hex").slice(0, 24));
      const env = { ...await this.environment(taskRoot), ...input.toolEnvironment };
      task.controller.signal.throwIfAborted();
      const proxyToken = randomBytes(24).toString("hex");
      const gateway = await this.gateway(task, endpoint, key, proxyToken, settings);
      task.gateway = gateway.server;
      if (task.controller.signal.aborted) {
        await closeServer(gateway.server);
        throw task.reason ?? failure("任务已取消。", "AbortError");
      }
      const config = {
        logLevel: "ERROR",
        share: "disabled",
        autoupdate: false,
        snapshot: false,
        formatter: false,
        lsp: false,
        enabled_providers: ["partner-api"],
        model: "partner-api/selected-model",
        small_model: "partner-api/selected-model",
        default_agent: "build",
        subagent_depth: 0,
        skills: { paths: input.skillPaths ?? [join(task.directory, ".opencode", "skills")] },
        provider: {
          "partner-api": {
            npm: settings.protocol === "openai" ? "@ai-sdk/openai" : "@ai-sdk/openai-compatible",
            name: "Partner Agent API",
            options: { baseURL: `${gateway.url}/v1`, apiKey: "{env:PARTNER_AGENT_PROXY_TOKEN}", timeout: settings.timeoutMinutes * 6e4 },
            models: { "selected-model": { id: settings.model.trim(), name: settings.model.trim(), tool_call: true, limit: { context: 128e3, output: 16384 } } }
          }
        },
        permission: { "*": "allow" },
        tools: modelTools,
        agent: { build: { steps: settings.maxSteps }, title: { disable: true }, summary: { disable: true } }
      };
      const password = randomBytes(24).toString("hex");
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
      env.OPENCODE_SERVER_PASSWORD = password;
      env.OPENCODE_SERVER_USERNAME = "opencode";
      env.PARTNER_AGENT_PROXY_TOKEN = proxyToken;
      const processExit = deferred();
      const serverUrl = await this.startServer(task, env, processExit.reject);
      task.client = createOpencodeClient({
        baseUrl: serverUrl,
        directory: task.directory,
        headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }
      });
      const requestOptions = { signal: task.controller.signal, throwOnError: true };
      const health = await task.client.global.health(requestOptions);
      if (!health.data?.healthy || health.data.version !== OPENCODE_VERSION) throw new Error(`OpenCode 服务版本不匹配，需要 ${OPENCODE_VERSION}。`);
      this.emit(task, { type: "engine.started", properties: { version: OPENCODE_VERSION, pid: task.child?.pid, directory: task.directory } });
      if (input.sessionId) {
        const existing = await task.client.session.get({ sessionID: input.sessionId, directory: task.directory }, requestOptions);
        if (!existing.data?.id) throw new Error("原会话不存在，请重新创建任务。");
        task.sessionId = existing.data.id;
        await task.client.session.update({ sessionID: task.sessionId, directory: task.directory, permission: fullAccessPermissions }, requestOptions);
      } else {
        const created = await task.client.session.create({ directory: task.directory, title: "合作方接入任务", permission: fullAccessPermissions }, requestOptions);
        if (!created.data?.id) throw new Error("OpenCode 未返回会话 ID。");
        task.sessionId = created.data.id;
      }
      input.onSession?.(task.sessionId);
      const ready = deferred();
      const streamError = deferred();
      const events = await task.client.event.subscribe({ directory: task.directory }, {
        ...requestOptions,
        sseMaxRetryAttempts: 1,
        onSseError: (error) => {
          if (!task.finishing) streamError.reject(new Error(`OpenCode 事件连接失败：${clean(message(error))}`));
        }
      });
      const eventPump = (async () => {
        try {
          for await (const event of events.stream) {
            ready.resolve();
            if (task.finishing) break;
            const raw = event;
            if (raw.type === "permission.asked") {
              await task.client.permission.reply({ requestID: raw.properties.id, directory: task.directory, reply: "always" }, requestOptions);
              continue;
            }
            if (raw.type === "permission.replied") task.permissions.delete(raw.properties.requestID);
            this.emit(task, event);
            if (raw.type === "session.error") streamError.reject(new Error(clean(message(raw.properties?.error))));
            if (raw.type === "question.asked") {
              await task.client.question.reject({ requestID: raw.properties.id, directory: task.directory }, requestOptions);
            }
          }
          if (!task.finishing && !task.controller.signal.aborted) throw new Error("OpenCode 事件流提前关闭。");
        } catch (error) {
          if (!task.finishing && !task.controller.signal.aborted) streamError.reject(error);
        }
      })();
      const aborted = deferred();
      task.controller.signal.addEventListener("abort", () => aborted.reject(task.reason ?? failure("任务已取消。", "AbortError")), { once: true });
      if (task.controller.signal.aborted) aborted.reject(task.reason ?? failure("任务已取消。", "AbortError"));
      await Promise.race([ready.promise, streamError.promise, processExit.promise, aborted.promise]);
      const response = await Promise.race([
        task.client.session.prompt({
          sessionID: task.sessionId,
          directory: task.directory,
          agent: "build",
          model: { providerID: "partner-api", modelID: "selected-model" },
          tools: modelTools,
          parts: [{ type: "text", text: input.outputSchema ? `${input.prompt}

执行完可用工具后，最终回复只输出一个符合以下 JSON Schema 的 JSON 对象；面向用户的自然语言回复放在 message 字段，不使用代码围栏或额外文字：
${JSON.stringify(input.outputSchema)}` : input.prompt }]
        }, requestOptions),
        streamError.promise,
        processExit.promise,
        aborted.promise
      ]);
      if (!response.data) throw new Error("模型未返回可用结果。");
      if (response.data.info.error) throw new Error(clean(message(response.data.info.error)));
      const text = response.data.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      task.finishing = true;
      task.controller.abort();
      await eventPump;
      if (input.outputSchema) {
        let structured = response.data.info.structured;
        if (structured === void 0) {
          try {
            structured = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
          } catch {
            throw new Error("模型未返回有效的任务执行结果，请确认模型支持工具调用和 JSON 指令。");
          }
        }
        structured = JSON.parse(clean(JSON.stringify(structured)));
        const content = structured && typeof structured === "object" && typeof structured.message === "string" ? structured.message : "";
        return { sessionId: task.sessionId, text: content, structured };
      }
      return { sessionId: task.sessionId, text: clean(text) };
    } catch (error) {
      const reason = task.reason ?? failure(clean(message(error)), error instanceof Error ? error.name : "Error");
      this.emit(task, { type: "engine.error", properties: { message: clean(reason.message), name: reason.name } });
      throw reason;
    } finally {
      task.finishing = true;
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", cancel);
      await this.stop(task);
      this.active.delete(task.id);
      task.finish();
    }
  }
  async replyPermission(taskId, requestId, reply) {
    const task = this.active.get(taskId);
    if (!task?.client || task.finishing || task.controller.signal.aborted) throw new Error("该任务当前没有活动会话。");
    if (!task.permissions.has(requestId)) throw new Error("审批请求不存在或已处理。");
    if (!["once", "always", "reject"].includes(reply)) throw new Error("审批结果无效。");
    try {
      await task.client.permission.reply({ requestID: requestId, directory: task.directory, reply }, { throwOnError: true, signal: task.controller.signal });
      task.permissions.delete(requestId);
    } catch (error) {
      throw new Error(task.clean(message(error)));
    }
  }
  async abort(taskId) {
    const task = this.active.get(taskId);
    if (task) await this.stop(task, failure("任务已取消。", "AbortError"));
  }
  async close() {
    this.closed = true;
    const tasks = [...this.active.values()];
    await Promise.all(tasks.map((task) => this.stop(task, failure("应用关闭，任务已停止。", "AbortError"))));
    await Promise.all(tasks.map((task) => task.done));
  }
  emit(task, event) {
    this.options.onEvent(task.id, JSON.parse(task.clean(JSON.stringify(event))));
  }
  async environment(taskRoot) {
    const env = {};
    for (const name of ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "JAVA_HOME", "ANDROID_HOME", "ANDROID_SDK_ROOT", "ANDROID_NDK_HOME", "DEVELOPER_DIR", "SDKROOT"]) {
      if (process.env[name] !== void 0) env[name] = process.env[name];
    }
    env.PATH = `${dirname(process.execPath)}${process.platform === "win32" ? ";" : ":"}${env.PATH ?? ""}`;
    for (const [name, folder] of [["XDG_DATA_HOME", "data"], ["XDG_STATE_HOME", "state"], ["XDG_CACHE_HOME", "cache"], ["XDG_CONFIG_HOME", "config"]]) {
      env[name] = join(taskRoot, folder);
      await mkdir(env[name], { recursive: true, mode: 448 });
    }
    env.OPENCODE_TEST_HOME = join(taskRoot, "discovery-home");
    await mkdir(env.OPENCODE_TEST_HOME, { recursive: true, mode: 448 });
    env.OPENCODE_CONFIG_DIR = join(taskRoot, "config", "opencode");
    await mkdir(env.OPENCODE_CONFIG_DIR, { recursive: true, mode: 448 });
    env.OPENCODE_DISABLE_PROJECT_CONFIG = "true";
    env.OPENCODE_PURE = "true";
    return env;
  }
  async gateway(task, endpoint, key, token, settings) {
    let reasoningRepair = false;
    const server = createServer(async (req, res) => {
      try {
        if (req.headers.authorization !== `Bearer ${token}`) {
          res.writeHead(401).end();
          return;
        }
        const route = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
        if (req.method !== "POST" || !["/v1/chat/completions", "/v1/responses"].includes(route)) {
          res.writeHead(404).end();
          return;
        }
        const chunks = [];
        let bytes = 0;
        for await (const chunk of req) {
          const part = Buffer.from(chunk);
          bytes += part.length;
          if (bytes > 32 * 1024 * 1024) throw new Error("模型请求超过本地转发上限。");
          chunks.push(part);
        }
        const controller = new AbortController();
        const cancel = () => controller.abort();
        task.controller.signal.addEventListener("abort", cancel, { once: true });
        if (task.controller.signal.aborted) cancel();
        res.once("close", cancel);
        try {
          const target = `${endpoint.href.replace(/\/$/, "")}${route.slice(3)}`;
          const responses = route.endsWith("/responses");
          const requestBody = configuredModelRequest(settings, JSON.parse(Buffer.concat(chunks).toString("utf8")), responses ? "responses" : "chat");
          const send = async (body2) => {
            let lastError;
            for (let attempt = 0; attempt < 3; attempt++) {
              if (controller.signal.aborted) throw new Error("任务已取消。");
              try {
                const response2 = await fetch(target, {
                  method: "POST",
                  redirect: "manual",
                  signal: controller.signal,
                  headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, Accept: req.headers.accept ?? "*/*" },
                  body: JSON.stringify(body2)
                });
                if (attempt < 2 && [502, 503, 504].includes(response2.status)) {
                  await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
                  continue;
                }
                return response2;
              } catch (error) {
                lastError = error;
                if (controller.signal.aborted || attempt >= 2) throw error;
                this.emit(task, { type: "engine.log", message: `模型接口连接失败，正在自动重试（${attempt + 1}/2）…`, level: "warn" });
                await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
              }
            }
            throw lastError;
          };
          let body = requestBody;
          if (responses && reasoningRepair) body = repairResponsesReasoning(requestBody) ?? requestBody;
          let response = await send(body);
          if (responses && response.status === 400) {
            const contentType = response.headers.get("content-type") ?? "application/json";
            const text = await response.text();
            const repaired = body === requestBody && /reasoning_text/i.test(text) ? repairResponsesReasoning(requestBody) : void 0;
            if (!repaired) {
              res.writeHead(400, { "Content-Type": contentType, "Cache-Control": "no-store" });
              res.end(task.clean(text));
              return;
            }
            reasoningRepair = true;
            response = await send(repaired);
            if (response.status === 400) {
              const retryType = response.headers.get("content-type") ?? "application/json";
              res.writeHead(400, { "Content-Type": retryType, "Cache-Control": "no-store" });
              res.end(task.clean(await response.text()));
              return;
            }
          }
          if (response.status >= 300 && response.status < 400) throw new Error("模型 API 返回重定向，请填写最终的 API 基础地址。");
          res.writeHead(response.status, { "Content-Type": response.headers.get("content-type") ?? "application/json", "Cache-Control": "no-store" });
          const decoder = new TextDecoder();
          let pending = "";
          if (response.body) {
            for await (const chunk of response.body) {
              pending += decoder.decode(chunk, { stream: true });
              const newline = pending.lastIndexOf("\n");
              if (newline >= 0) {
                await this.write(res, task.clean(pending.slice(0, newline + 1)), controller.signal);
                pending = pending.slice(newline + 1);
              }
              if (pending.length > 16 * 1024 * 1024) throw new Error("模型返回的数据行过大。");
            }
          }
          res.end(task.clean(pending + decoder.decode()));
        } finally {
          task.controller.signal.removeEventListener("abort", cancel);
          res.off("close", cancel);
        }
      } catch (error) {
        if (res.destroyed) return;
        if (res.headersSent) res.destroy();
        else res.writeHead(502, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: task.clean(message(error)), type: "local_gateway_error" } }));
      }
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("无法启动本地模型转发。");
    return { server, url: `http://127.0.0.1:${address.port}` };
  }
  async write(res, data, signal) {
    signal.throwIfAborted();
    if (!res.write(data)) await once(res, "drain", { signal });
  }
  async startServer(task, env, onExit) {
    const child = spawn(this.binary, ["serve", "--hostname=127.0.0.1", "--port=0", "--log-level=ERROR"], {
      cwd: task.directory,
      env,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    task.child = child;
    child.on("error", (error) => onExit(new Error(`无法启动 OpenCode：${task.clean(error.message)}`)));
    child.on("exit", (code, signal) => {
      if (!task.finishing && !task.controller.signal.aborted) onExit(new Error(`OpenCode 服务退出（${signal ?? code}）。`));
    });
    return await new Promise((resolve, reject) => {
      let output = "";
      const finish = (error, url) => {
        clearTimeout(timer);
        child.stdout?.off("data", data);
        child.stderr?.off("data", data);
        child.off("error", fail);
        child.off("exit", exited);
        task.controller.signal.removeEventListener("abort", cancelled);
        if (error) reject(error);
        else resolve(url);
      };
      const data = (chunk) => {
        output = (output + chunk.toString("utf8")).slice(-16384);
        const match = /opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
        if (match) finish(void 0, match[1]);
      };
      const fail = (error) => finish(new Error(`无法启动 OpenCode：${task.clean(error.message)}`));
      const exited = (code) => finish(new Error(`OpenCode 启动失败（${code}）：${task.clean(output).slice(-2500)}`));
      const cancelled = () => finish(task.reason ?? failure("任务已取消。", "AbortError"));
      const timer = setTimeout(() => finish(new Error(`OpenCode 启动超时：${task.clean(output).slice(-2500)}`)), 3e4);
      child.stdout?.on("data", data);
      child.stderr?.on("data", data);
      child.stdout?.resume();
      child.stderr?.resume();
      child.once("error", fail);
      child.once("exit", exited);
      task.controller.signal.addEventListener("abort", cancelled, { once: true });
      if (task.controller.signal.aborted) cancelled();
    });
  }
  stop(task, reason) {
    if (reason && !task.reason) task.reason = reason;
    task.finishing = true;
    task.controller.abort(task.reason);
    if (task.stopping) return task.stopping;
    task.stopping = (async () => {
      if (task.client && task.sessionId && reason) {
        try {
          await task.client.session.abort({ sessionID: task.sessionId, directory: task.directory }, { throwOnError: true, signal: AbortSignal.timeout(1500) });
        } catch {
        }
      }
      const child = task.child;
      if (child?.pid) {
        const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((resolve) => {
          const finish = () => {
            child.off("exit", finish);
            child.off("error", finish);
            resolve();
          };
          child.once("exit", finish);
          child.once("error", finish);
        });
        if (process.platform === "win32") {
          const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          await new Promise((resolve) => {
            killer.once("close", () => resolve());
            killer.once("error", () => {
              child.kill();
              resolve();
            });
          });
        } else {
          const kill = (signal) => {
            try {
              process.kill(-child.pid, signal);
            } catch (error) {
              if (error.code !== "ESRCH") child.kill(signal);
            }
          };
          kill("SIGTERM");
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, 250);
            timer.unref();
          });
          kill("SIGKILL");
        }
        await exited;
      }
      await closeServer(task.gateway);
    })();
    return task.stopping;
  }
}
export {
  OPENCODE_VERSION,
  OpenCodeEngine
};
