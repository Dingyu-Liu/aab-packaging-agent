import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { AppError } from "./errors.js";
const TERMINAL = ["succeeded", "failed", "cancelled", "needs_review", "partial"];
function isTerminal(status) {
  return TERMINAL.includes(status);
}
function nodeResource(kind) {
  return kind === "h5" ? "h5-sync" : "finance-sync";
}
function redactedParameters(parameters) {
  const copy = { ...parameters };
  for (const key of ["sourceToken", "baseToken"]) if (copy[key] !== void 0) copy[key] = "[已隐藏]";
  return copy;
}
function aggregate(nodes) {
  if (nodes.some((node) => !isTerminal(node.status))) return "running";
  const succeeded = nodes.filter((node) => node.status === "succeeded").length;
  const failed = nodes.filter((node) => node.status === "failed").length;
  const review = nodes.filter((node) => node.status === "needs_review").length;
  const cancelled = nodes.filter((node) => node.status === "cancelled").length;
  if (cancelled === nodes.length) return "cancelled";
  if (failed === nodes.length) return "failed";
  if (review === nodes.length) return "needs_review";
  if (failed || review || cancelled) return "partial";
  return succeeded === nodes.length ? "succeeded" : "partial";
}
class RunOrchestrator {
  constructor(tasks, dataDir) {
    this.tasks = tasks;
    this.root = join(dataDir, "run-plans");
  }
  tasks;
  hasActive() {
    return this.schedulers.size > 0;
  }
  root;
  schedulers = /* @__PURE__ */ new Map();
  rawParameters = /* @__PURE__ */ new Map();
  path(id) {
    if (!/^[A-Za-z0-9-]{8,80}$/.test(id)) throw new AppError(400, "运行批次编号无效。");
    return join(this.root, `${id}.json`);
  }
  async save(plan) {
    plan.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    await mkdir(this.root, { recursive: true, mode: 448 });
    const temporary = `${this.path(plan.id)}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(plan, null, 2) + "\n", { mode: 384 });
    await rename(temporary, this.path(plan.id));
  }
  async load(id) {
    try {
      return JSON.parse(await readFile(this.path(id), "utf8"));
    } catch {
      throw new AppError(404, "运行批次不存在。");
    }
  }
  nodeInput(node) {
    const pluginId = node.kind === "h5" ? "h5-sync" : "finance-sync";
    const parameters = { ...node.parameters, ...node.kind === "h5" ? {} : { mode: node.kind } };
    return { pluginId, mode: node.mode, parameters };
  }
  async create(input, ownerId) {
    if (!input || !Array.isArray(input.nodes) || input.nodes.length < 1 || input.nodes.length > 12) throw new AppError(400, "批量更新需要 1–12 个节点。");
    const raw = {};
    const nodes = input.nodes.map((item) => {
      if (!item || !["consume", "h5", "ads"].includes(item.kind)) throw new AppError(400, "更新类别无效。");
      if (!["check", "dry-run", "sync"].includes(item.mode)) throw new AppError(400, "更新模式无效。");
      if (!item.parameters || typeof item.parameters !== "object" || Array.isArray(item.parameters)) throw new AppError(400, "更新参数无效。");
      const node = { id: randomUUID(), kind: item.kind, mode: item.mode, parameters: redactedParameters(item.parameters), status: "pending" };
      raw[node.id] = { ...item.parameters };
      return node;
    });
    if (new Set(nodes.map((node) => node.kind)).size !== nodes.length) throw new AppError(400, "同一批次内每个类别只能有一个节点。");
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const plan = { id: randomUUID(), ownerId, status: "pending", createdAt: now, updatedAt: now, maxParallel: Math.max(1, Math.min(input.maxParallel ?? 2, 3)), nodes };
    this.rawParameters.set(plan.id, raw);
    await this.save(plan);
    this.schedule(plan);
    return plan;
  }
  schedule(plan) {
    const tick = async () => {
      try {
        const current = await this.load(plan.id);
        if (current.status === "cancelled") {
          this.stop(plan.id);
          return;
        }
        for (const node of current.nodes) {
          if (!node.taskId || isTerminal(node.status)) continue;
          try {
            const task = this.tasks.get(node.taskId);
            node.status = task.status;
            if (task.status === "failed") node.error = task.events.findLast((event) => event.level === "error")?.message || task.phase;
          } catch {
            node.status = "failed";
            node.error = "任务记录已不存在。";
          }
        }
        const running = current.nodes.filter((node) => node.taskId && !isTerminal(node.status));
        const runningResources = new Set(running.map((node) => nodeResource(node.kind)));
        for (const node of current.nodes) {
          if (running.length >= current.maxParallel) break;
          if (node.status !== "pending") continue;
          const resource = nodeResource(node.kind);
          if (runningResources.has(resource)) continue;
          const raw = this.rawParameters.get(current.id)?.[node.id];
          if (!raw) {
            node.status = "failed";
            node.error = "应用重启后批次参数不再保留，请重新提交本次更新。";
            continue;
          }
          try {
            const task = await this.tasks.create({ ...this.nodeInput({ ...node, parameters: raw }), ownerId: plan.ownerId });
            node.taskId = task.id;
            node.status = task.status;
            runningResources.add(resource);
            running.push(node);
          } catch (error) {
            if (error instanceof AppError && error.status === 409) continue;
            node.status = "failed";
            node.error = error instanceof Error ? error.message : "无法创建子任务。";
          }
        }
        current.status = aggregate(current.nodes);
        await this.save(current);
        if (current.nodes.every((node) => isTerminal(node.status))) {
          this.stop(plan.id);
          return;
        }
        const timer2 = setTimeout(() => void tick(), 1e3);
        timer2.unref();
        this.schedulers.set(plan.id, timer2);
      } catch (error) {
        const timer2 = setTimeout(() => void tick(), 3e3);
        timer2.unref();
        this.schedulers.set(plan.id, timer2);
      }
    };
    const timer = setTimeout(() => void tick(), 0);
    timer.unref();
    this.schedulers.set(plan.id, timer);
  }
  stop(id) {
    const timer = this.schedulers.get(id);
    if (timer) clearTimeout(timer);
    this.schedulers.delete(id);
    this.rawParameters.delete(id);
  }
  async list(limit = 20, ownerId, includeAll = false) {
    let names;
    try {
      names = (await readdir(this.root)).filter((name) => name.endsWith(".json")).sort().reverse();
    } catch {
      return [];
    }
    const plans = [];
    for (const name of names.slice(0, Math.max(1, Math.min(limit, 50)))) {
      try {
        const plan = JSON.parse(await readFile(join(this.root, name), "utf8"));
        if (!includeAll && ownerId && plan.ownerId !== ownerId) continue;
        plan.status = aggregate(plan.nodes);
        plans.push(plan);
      } catch {
      }
    }
    return plans.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }
  async get(id, ownerId, includeAll = false) {
    const plan = await this.load(id);
    if (!includeAll && ownerId && plan.ownerId !== ownerId) throw new AppError(404, "运行批次不存在。");
    for (const node of plan.nodes) {
      if (!node.taskId || isTerminal(node.status)) continue;
      try {
        node.status = this.tasks.get(node.taskId).status;
      } catch {
        node.status = "failed";
        node.error = "任务记录已不存在。";
      }
    }
    plan.status = aggregate(plan.nodes);
    return plan;
  }
  async cancel(id, ownerId, includeAll = false) {
    const plan = await this.load(id);
    if (!includeAll && ownerId && plan.ownerId !== ownerId) throw new AppError(404, "运行批次不存在。");
    this.stop(id);
    for (const node of plan.nodes) {
      if (isTerminal(node.status)) continue;
      if (node.taskId) {
        try {
          await this.tasks.cancel(node.taskId);
        } catch {
        }
        node.status = "cancelled";
      } else node.status = "cancelled";
    }
    plan.status = "cancelled";
    await this.save(plan);
    return plan;
  }
}
export {
  RunOrchestrator
};
