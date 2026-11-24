import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { AppError } from "./errors.js";
import { isWithin } from "./workspaces.js";
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MAX_LOG_BYTES = 2 * 1024 * 1024;
function updateKindOf(task) {
  if (task.pluginId === "h5-sync") return "h5";
  if (task.pluginId !== "finance-sync") return void 0;
  if (task.parameters.mode === "ads") return "ads";
  if (task.parameters.mode === "consume" || task.parameters.mode === void 0 || task.parameters.mode === "dapan") return "consume";
  return void 0;
}
function isTerminal(task) {
  return ["succeeded", "failed", "cancelled", "needs_review", "partial"].includes(task.status);
}
function object(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function text(value) {
  return typeof value === "string" && value ? value : void 0;
}
async function readBounded(file, limit = MAX_JSON_BYTES) {
  const info = await lstat(file);
  if (!info.isFile() || info.size > limit) throw new AppError(400, "结果文件不可读取或过大。");
  return readFile(file, "utf8");
}
async function runDirectory(task, area, dataDir) {
  const root = join(dataDir, "tasks", task.id, area);
  let names;
  try {
    names = (await readdir(root)).filter((name) => name.startsWith("run-")).sort().reverse();
  } catch {
    return void 0;
  }
  for (const name of names) {
    const candidate = join(root, name);
    try {
      const real = await realpath(candidate);
      const info = await lstat(real);
      if (info.isDirectory() && !info.isSymbolicLink() && isWithin(join(dataDir, "tasks", task.id), real)) return real;
    } catch {
    }
  }
  return void 0;
}
async function readVerification(task) {
  const artifact = task.artifacts.find((item) => item.name === "business-verification.json");
  if (!artifact || artifact.type === "directory") return void 0;
  try {
    const parsed = JSON.parse(await readBounded(artifact.path, 4 * 1024 * 1024));
    if (!object(parsed)) return void 0;
    return { ok: parsed.ok === true, summary: text(parsed.summary) ?? "", details: parsed.details };
  } catch {
    return void 0;
  }
}
function readinessOf(task, verification) {
  if (task.mode === "check") return "check_only";
  if (task.mode === "dry-run") return "dry_run";
  if (["queued", "running", "waiting_approval"].includes(task.status)) return "running";
  if (task.status === "failed" || task.status === "cancelled") return "failed";
  if (task.status === "needs_review") return "unconfirmed";
  if (task.status === "succeeded" && verification?.ok === true) return "verified";
  if (task.status === "succeeded" && verification?.ok === false) return "unconfirmed";
  if (task.status === "partial") return "unconfirmed";
  return task.status === "succeeded" ? "unconfirmed" : "not_run";
}
async function summarizeRun(task, redactor) {
  const kind = updateKindOf(task);
  if (!kind) throw new AppError(400, "该任务不是工作数据更新。");
  const verification = await readVerification(task);
  const details = object(verification?.details) ? verification.details : void 0;
  const runId = typeof details?.runId === "string" ? details.runId : void 0;
  return {
    taskId: task.id,
    name: task.name,
    kind,
    mode: task.mode,
    status: task.status,
    readiness: readinessOf(task, verification),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    runId,
    summary: redactor.text(verification?.summary || task.phase || task.status),
    details
  };
}
async function listRuns(tasks, kind, limit, redactor) {
  const matching = tasks.filter((task) => updateKindOf(task) === kind && isTerminal(task)).sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0)).slice(0, Math.max(1, Math.min(limit, 20)));
  return Promise.all(matching.map((task) => summarizeRun(task, redactor)));
}
function financeSources(task) {
  if (task.parameters.mode === "ads") return ["topon", "max", "admob"];
  return ["consume"];
}
function normalizeFinanceRow(row, source) {
  return {
    recordId: text(row.record_id),
    product: text(row.name) ?? text(row["产品名"]) ?? "未知产品",
    platform: text(row["平台"]) ?? text(row.platform),
    source,
    ok: row.ok === true,
    error: text(row.err),
    written: number(row["写"]),
    skipped: number(row["跳过"]),
    zero: number(row["零值"]),
    missingRows: number(row["缺行"])
  };
}
function filterRows(rows, filter) {
  let result = rows;
  if (filter.status === "failed") result = result.filter((row) => !row.ok);
  if (filter.status === "ok") result = result.filter((row) => row.ok);
  if (filter.product) result = result.filter((row) => row.product.includes(filter.product));
  if (filter.source) result = result.filter((row) => row.source === filter.source);
  return result;
}
async function queryRunItems(task, dataDir, filter) {
  const kind = updateKindOf(task);
  if (!kind) throw new AppError(400, "该任务不是工作数据更新。");
  if (!isTerminal(task)) throw new AppError(409, "任务仍在运行，结果尚未完成。");
  const limit = Math.max(1, Math.min(filter.limit ?? 20, 100));
  const offset = Math.max(0, filter.offset ?? 0);
  const rows = [];
  const verification = await readVerification(task);
  const runId = object(verification?.details) && typeof verification?.details.runId === "string" ? verification.details.runId : void 0;
  if (task.pluginId === "finance-sync") {
    const directory = await runDirectory(task, "finance", dataDir);
    if (!directory) throw new AppError(404, "未找到本轮运行目录。");
    for (const source of financeSources(task)) {
      let content;
      try {
        content = JSON.parse(await readBounded(join(directory, `full_review_result_${source}.json`)));
      } catch {
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const item of content) if (object(item)) rows.push(normalizeFinanceRow(item, source));
    }
  } else {
    const directory = await runDirectory(task, "h5", dataDir);
    if (!directory) throw new AppError(404, "未找到本轮运行目录。");
    let result;
    try {
      result = JSON.parse(await readBounded(join(directory, "result.json")));
    } catch {
      result = void 0;
    }
    if (object(result)) {
      const successes = Array.isArray(result.successes) ? result.successes : [];
      const failures = Array.isArray(result.failures) ? result.failures : [];
      for (const item of successes) {
        if (!object(item)) continue;
        rows.push({ product: text(item.product) ?? "未知产品", ok: item.ok !== false, readback: text(item.readback) ? text(item.readback).slice(0, 2e3) : "未回读" });
      }
      for (const item of failures) {
        if (!object(item)) continue;
        rows.push({ product: text(item.product) ?? "未知产品", ok: false, error: text(item.error) ?? "同步失败" });
      }
    } else {
      let scan;
      try {
        scan = JSON.parse(await readBounded(join(directory, "scan.json")));
      } catch {
        scan = void 0;
      }
      if (object(scan) && Array.isArray(scan.complete)) {
        for (const item of scan.complete) if (object(item)) rows.push({ product: text(item.product) ?? "未知产品", ok: item.ok === true });
      }
    }
  }
  const filtered = filterRows(rows, filter);
  const aggregation = {
    total: filtered.length,
    ok: filtered.filter((row) => row.ok).length,
    failed: filtered.filter((row) => !row.ok).length,
    written: filtered.reduce((sum, row) => sum + (row.written ?? 0), 0),
    skipped: filtered.reduce((sum, row) => sum + (row.skipped ?? 0), 0),
    zero: filtered.reduce((sum, row) => sum + (row.zero ?? 0), 0),
    missingRows: filtered.reduce((sum, row) => sum + (row.missingRows ?? 0), 0)
  };
  return { taskId: task.id, runId, total: filtered.length, returned: Math.min(limit, Math.max(0, filtered.length - offset)), truncated: offset + limit < filtered.length, aggregation, rows: filtered.slice(offset, offset + limit) };
}
async function compareRuns(task, tasks, dataDir, redactor) {
  const kind = updateKindOf(task);
  if (!kind) throw new AppError(400, "该任务不是工作数据更新。");
  const current = await summarizeRun(task, redactor);
  const fingerprint = (item) => item.pluginId === "finance-sync" ? `finance:${String(item.parameters.mode ?? "consume")}` : `h5:${String(item.parameters.dates ?? "")}`;
  const previousTask = tasks.filter((item) => item.id !== task.id && updateKindOf(item) === kind && item.mode === "sync" && item.status === "succeeded" && fingerprint(item) === fingerprint(task)).sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0))[0];
  if (!previousTask) return { current, comparison: "没有找到同类别、同数据日、已完成的上一轮正式更新，无法对比。" };
  const previous = await summarizeRun(previousTask, redactor);
  const currentItems = await queryRunItems(task, dataDir, { limit: 1 }).catch(() => void 0);
  const previousItems = await queryRunItems(previousTask, dataDir, { limit: 1 }).catch(() => void 0);
  if (!currentItems || !previousItems) return { current, previous, comparison: "本轮或上一轮缺少可读取的逐项结果，无法做数值对比。" };
  const keys = ["total", "ok", "failed", "written", "skipped", "zero", "missingRows"];
  const lines = keys.map((key) => {
    const now = currentItems.aggregation[key] ?? 0;
    const before = previousItems.aggregation[key] ?? 0;
    const delta = now - before;
    return `${key}: ${before} → ${now}${delta === 0 ? "（无变化）" : `（${delta > 0 ? "+" : ""}${delta}）`}`;
  });
  return { current, previous, comparison: `已按同类别、同数据口径对比：
${lines.join("\n")}` };
}
async function searchRunLog(task, dataDir, contains, limit, redactor) {
  const candidates = [
    task.artifacts.find((item) => item.name === "script-output.txt")?.path,
    join(dataDir, "tasks", task.id, "script-output.txt")
  ].filter((path) => typeof path === "string");
  let content = "";
  for (const file of candidates) {
    try {
      const real = await realpath(file);
      if (!isWithin(join(dataDir, "tasks", task.id), real)) continue;
      const info = await lstat(real);
      if (!info.isFile() || info.size > MAX_LOG_BYTES) continue;
      content = await readFile(real, "utf8");
      break;
    } catch {
    }
  }
  if (!content) return { lines: [], truncated: false };
  const needle = contains?.toLowerCase().trim();
  const lines = content.split(/\r?\n/).filter((line) => !needle || line.toLowerCase().includes(needle));
  const capped = lines.slice(-Math.max(1, Math.min(limit, 200)));
  return { lines: capped.map((line) => redactor.text(line).slice(0, 2e3)), truncated: capped.length < lines.length };
}
export {
  compareRuns,
  isTerminal,
  listRuns,
  queryRunItems,
  readVerification,
  readinessOf,
  searchRunLog,
  summarizeRun,
  updateKindOf
};
