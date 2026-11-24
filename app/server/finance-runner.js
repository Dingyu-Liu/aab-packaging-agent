import { access, lstat, realpath, readFile, readdir, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AppError } from "./errors.js";
import { runProcess } from "./processes.js";
import { dayTimestamp, parseUpdateDates } from "../shared/update-dates.js";
const baselines = /* @__PURE__ */ new WeakMap();
const modes = /* @__PURE__ */ new Set(["consume", "ads", "dapan"]);
const allowed = /* @__PURE__ */ new Set(["scriptPath", "mode", "dates", "sendCard", "pushAudit", "serial"]);
const jsonLimit = 64 * 1024 * 1024;
const packagedScripts = fileURLToPath(new URL("../plugins/finance-sync/scripts/", import.meta.url));
const quietEnvironment = { BASH_ENV: "", ENV: "", PYTHONSTARTUP: "", PYTHONPATH: "", PYTHONDONTWRITEBYTECODE: "1", PYTHONUNBUFFERED: "1" };
const python = () => process.env.PARTNER_AGENT_PYTHON || "python3";
function absolutePath(input, label) {
  if (typeof input !== "string" || !input.trim() || !isAbsolute(input) || input.includes("\0")) throw new AppError(400, `${label} 必须配置为服务器文件的绝对路径。`);
  return input;
}
async function sourceAnchor(params, context) {
  if (process.env.PARTNER_FINANCE_SCRIPT_PATH !== void 0) return absolutePath(process.env.PARTNER_FINANCE_SCRIPT_PATH, "PARTNER_FINANCE_SCRIPT_PATH");
  if (params.scriptPath !== void 0) return absolutePath(params.scriptPath, "scriptPath");
  if (context) {
    const scripts = join(context.pluginDirectory, "scripts");
    try {
      const stat = await lstat(scripts);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new AppError(400, "冻结 finance scripts 必须是普通目录。");
      const root = await realpath(scripts), anchor = await filePath(join(root, "run_consume.py"));
      if (dirname(anchor) !== root) throw new AppError(400, "冻结 finance 入口不能通过符号链接跳出插件目录。");
      return anchor;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return join(packagedScripts, "run_consume.py");
}
async function financeDependency(overrides) {
  const environment = { ...process.env, ...overrides };
  const cli = environment.SYNC_LARK_CLI, launcher = environment.FEISHU_TEAM_RUNNER;
  if (cli !== void 0) {
    const path = await filePath(absolutePath(cli, "SYNC_LARK_CLI"));
    try {
      await access(path, constants.X_OK);
    } catch {
      throw new AppError(400, "SYNC_LARK_CLI 不可执行，请由部署管理员配置。");
    }
    return { env: { SYNC_LARK_CLI: path, FEISHU_TEAM_RUNNER: "" } };
  }
  if (launcher !== void 0) {
    const path = await filePath(absolutePath(launcher, "FEISHU_TEAM_RUNNER"));
    return { env: { SYNC_LARK_CLI: "", FEISHU_TEAM_RUNNER: path }, launcher: path };
  }
  throw new AppError(400, "服务器缺少飞书运行依赖：请配置 SYNC_LARK_CLI 或 FEISHU_TEAM_RUNNER，并由部署环境提供授权。");
}
function option(params, key) {
  const value = params[key];
  if (value === void 0) return false;
  if (typeof value !== "boolean") throw new AppError(400, `${key} 必须是布尔值。`);
  return value;
}
async function stamp(file) {
  try {
    const st = await lstat(file);
    if (!st.isFile()) return void 0;
    return { mtime: st.mtimeMs, size: st.size, ino: st.ino, dev: st.dev };
  } catch {
    return void 0;
  }
}
async function filePath(file) {
  let target;
  try {
    target = await realpath(file);
    if (!(await lstat(target)).isFile()) throw new Error();
  } catch {
    throw new AppError(400, `缺少 finance-sync 必需文件：${basename(file)}。`);
  }
  return target;
}
async function configuration(params, mode, context) {
  if (mode !== "sync" && mode !== "dry-run") throw new AppError(400, "finance 检查仅做本地路径、解释器和语法检查，不生成同步或 selfcheck 调用。");
  if (Object.keys(params).some((key) => !allowed.has(key))) throw new AppError(400, "finance 参数中有未支持选项；日期请使用 dates，不支持任意附加命令参数。");
  const anchor = await filePath(await sourceAnchor(params, context));
  if (basename(anchor) !== "run_consume.py") throw new AppError(400, "finance 安装入口必须是 run_consume.py。");
  const scope = params.mode ?? "consume";
  if (typeof scope !== "string" || !modes.has(scope)) throw new AppError(400, "finance 范围仅支持 consume、ads、dapan；run_all 不支持预演。");
  let dates;
  if (params.dates !== void 0) {
    if (scope !== "consume") throw new AppError(400, "dates 日期选择仅适用于消耗更新。");
    try {
      dates = parseUpdateDates(params.dates);
    } catch (error) {
      throw new AppError(400, error.message);
    }
  }
  const card = option(params, "sendCard"), push = option(params, "pushAudit"), serial = option(params, "serial");
  if (card) throw new AppError(400, "sendCard 已停用；报表会返回工作台，请复制后自行分享。");
  if (push && scope === "dapan") throw new AppError(400, "pushAudit 不适用于 dapan。");
  if (serial && scope !== "ads") throw new AppError(400, "serial 仅适用于 ads。");
  const cwd = dirname(anchor);
  const name = scope === "consume" ? "run_consume.py" : scope === "ads" ? "run_ads.py" : "dapan_sync.py";
  const entry = await filePath(join(cwd, name));
  if (dirname(entry) !== cwd) throw new AppError(400, "finance 同级脚本不能通过符号链接跳出安装目录。");
  const dependencies = ["sync_log.py", "codex_lark_adapter.py", ...dates ? ["sync_dates.py"] : [], ...scope === "dapan" ? [] : ["full_review.py"], ...scope === "consume" && mode === "sync" ? ["dapan_sync.py", "sync_daily_summary.py"] : []];
  for (const dependency of dependencies) {
    const target = await filePath(join(cwd, dependency));
    if (dirname(target) !== cwd) throw new AppError(400, "finance 依赖不能指向安装目录之外。");
  }
  const db = resolve(cwd, context ? "sync_history.db" : process.env.SYNC_LOG_DB || "sync_history.db");
  const config = { anchor, path: entry, cwd, scope, dates, dry: mode === "dry-run", card, push, serial, db, signature: "", context };
  if (context && (scope === "dapan" || scope === "consume" && mode === "sync")) {
    await filePath(join(cwd, "full_review.py"));
    const local = join(cwd, "bootstrap_rules.py");
    let exists = true;
    try {
      await lstat(local);
    } catch (error) {
      if (error.code === "ENOENT") exists = false;
      else throw error;
    }
    config.bootstrap = await filePath(exists ? local : join(packagedScripts, "bootstrap_rules.py"));
    if (exists && dirname(config.bootstrap) !== cwd) throw new AppError(400, "finance 快照准备脚本不能跳出安装目录。");
  }
  config.signature = JSON.stringify([anchor, entry, mode, scope, dates, card, push, serial, db, context?.taskDirectory, config.bootstrap, process.env.SYNC_LARK_CLI, process.env.FEISHU_TEAM_RUNNER]);
  return config;
}
async function codeFiles(directory) {
  const files = [];
  for (const name of (await readdir(directory)).sort()) {
    if (!name.endsWith(".py")) continue;
    const path = join(directory, name), st = await lstat(path);
    if (!/^[A-Za-z_][A-Za-z0-9_]*\.py$/.test(name) || !st.isFile() || st.isSymbolicLink() || st.size > 8 * 1024 * 1024) throw new AppError(400, "finance 代码目录只能包含普通 Python 源文件，不支持符号链接或异常大小。");
    files.push(path);
  }
  return files;
}
async function isolate(config) {
  const context = config.context;
  const dependency = await financeDependency(context.env);
  const files = await codeFiles(config.cwd);
  if (config.bootstrap && !files.includes(config.bootstrap)) files.push(config.bootstrap);
  const task = await realpath(context.taskDirectory), root = join(task, "finance");
  await mkdir(root, { recursive: true, mode: 448 });
  const st = await lstat(root);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new AppError(400, "任务 finance 目录必须是普通目录。");
  const directory = await mkdtemp(join(root, "run-")), hashes = {};
  for (const file of files) {
    const content = await readFile(file), name = basename(file);
    await writeFile(join(directory, name), content, { mode: 384, flag: "wx" });
    hashes[name] = createHash("sha256").update(content).digest("hex");
  }
  await writeFile(join(directory, "code-manifest.json"), JSON.stringify({ schemaVersion: 1, sourceDirectory: config.cwd, sha256: hashes }, null, 2) + "\n", { mode: 384 });
  config.path = join(directory, basename(config.path));
  config.cwd = directory;
  config.db = join(directory, "sync_history.db");
  if (config.bootstrap) config.bootstrap = join(directory, basename(config.bootstrap));
  config.env = { ...context.env, ...quietEnvironment, ...dependency.env, SYNC_LOG_DB: config.db, SYNC_RUN_ID: "", SYNC_TRIGGER: "work-data-update", SYNC_MACHINE: `${process.env.SYNC_MACHINE || hostname()}:${basename(directory)}` };
}
async function inspectFinance(params, context) {
  const checks = [];
  let config;
  try {
    config = await configuration(params, "sync", context);
  } catch (error) {
    return [{ label: "Finance服务器配置", status: "fail", detail: error instanceof AppError ? error.message : "服务器代码配置不可读。" }];
  }
  checks.push({ label: "Finance服务器配置", status: "pass", detail: "同步代码与必需模块存在；执行时使用任务专属副本。" });
  try {
    const dependency = await financeDependency(context.env);
    if (dependency.launcher) {
      const shell = await runProcess("/bin/bash", ["-n", dependency.launcher], { signal: context.signal, env: quietEnvironment, timeoutMs: 1e4, maxOutput: 5e3 });
      if (shell.code !== 0) throw new AppError(400, "FEISHU_TEAM_RUNNER 的 Bash 语法检查失败。");
    }
    checks.push({ label: "飞书运行依赖", status: "pass", detail: "部署指定的 CLI/launcher 存在，未执行或验证授权。" });
  } catch (error) {
    if (context.signal?.aborted) throw error;
    checks.push({ label: "飞书运行依赖", status: "fail", detail: error instanceof AppError ? error.message : "飞书运行依赖不可用。" });
  }
  try {
    const files = await codeFiles(config.cwd);
    if (config.bootstrap && !files.includes(config.bootstrap)) files.push(config.bootstrap);
    const result = await runProcess(python(), ["-I", "-B", "-c", 'import ast,sys,tokenize,sqlite3; assert sys.version_info >= (3,8), "Python 3.8+ required"; [ast.parse(tokenize.open(p).read(), filename=p) for p in sys.argv[1:]]', ...files], { signal: context.signal, env: quietEnvironment, timeoutMs: 15e3, maxOutput: 5e3 });
    checks.push({ label: "Python与模块语法", status: result.code === 0 ? "pass" : "fail", detail: result.code === 0 ? "Python 3.8+、SQLite 与全部模块语法检查通过，未执行同步逻辑。" : "需要 Python 3.8+ 及标准库 SQLite；模块语法或解释器检查失败。" });
  } catch (error) {
    if (context.signal?.aborted) throw error;
    checks.push({ label: "Python与模块语法", status: "fail", detail: error instanceof AppError ? error.message : "Python解释器或代码模块不可用。" });
  }
  checks.push({ label: "飞书授权与目标权限", status: "warn", detail: "本地检查不连接飞书；授权、资源访问权限与业务数据尚未验证。" });
  return checks;
}
function openAudit(file) {
  return new DatabaseSync(file, { readOnly: true, timeout: 2e3 });
}
function sources(config) {
  return config.scope === "ads" ? ["topon", "max", "admob"] : config.scope === "consume" ? ["consume"] : [];
}
function resultPaths(config) {
  return sources(config).map((source) => join(config.cwd, `full_review_result_${source}.json`));
}
async function buildFinanceInvocation(params, mode, context) {
  const config = await configuration(params, mode, context);
  if (context) await isolate(config);
  const args = ["-B", config.path];
  if (config.dry) args.push("--dry");
  if (config.dates) args.push("--dates", config.dates.join(","));
  if (config.scope === "consume") args.push("--no-card");
  if (config.scope !== "dapan" && (!config.push || config.dry)) args.push("--no-push");
  if (config.scope === "ads" && config.serial) args.push("--serial");
  const dbStamp = await stamp(config.db);
  let watermark = 0, auditAvailable = true;
  if (dbStamp) {
    let db;
    try {
      db = openAudit(config.db);
      watermark = Number(db.prepare("SELECT COALESCE(MAX(rowid),0) AS mark FROM runs").get()?.mark);
    } catch {
      auditAvailable = false;
    } finally {
      db?.close();
    }
  }
  const tracked = [join(config.cwd, "rules_full.json"), join(config.cwd, "finance-report.json"), join(config.cwd, "dapan-result.json"), ...resultPaths(config)];
  const stamps = new Map(await Promise.all(tracked.map(async (file) => [file, await stamp(file)])));
  baselines.set(params, { config, capturedAt: Date.now(), watermark, dbStamp, stamps, auditAvailable });
  return { command: python(), args, cwd: config.cwd, path: config.path, env: config.env, bootstrap: config.bootstrap };
}
class EvidenceError extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
  reason;
}
function evidence(condition, reason, message) {
  if (!condition) throw new EvidenceError(reason, message);
}
function object(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function time(value) {
  return typeof value === "string" ? Date.parse(value.replace(" ", "T")) : NaN;
}
function truth(value) {
  return Array.isArray(value) ? value.length > 0 : object(value) ? Object.keys(value).length > 0 : !!value;
}
async function freshJson(file, baseline, startedAt) {
  const current = await stamp(file), old = baseline.stamps.get(file);
  evidence(current, "result_missing", "缺少本轮快照或逐项结果文件，结果未确认。");
  evidence(current.size <= jsonLimit, "result_too_large", "结果文件超过可核验大小，结果未确认。");
  evidence(current.mtime >= startedAt && current.mtime <= Date.now() + 1e3, "stale_result", "结果文件不是本轮生成，不能使用旧结果。");
  evidence(!old || current.mtime !== old.mtime || current.size !== old.size || current.ino !== old.ino || current.dev !== old.dev, "unchanged_result", "结果文件未在本轮更新，结果未确认。");
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new EvidenceError("invalid_json", "本轮结果 JSON 无法解析，结果未确认。");
  }
}
function requireSteps(rows, names) {
  for (const name of names) {
    const found = rows.filter((row) => row.step === name);
    evidence(found.length === 1, "step_missing", `缺少本轮步骤 ${name}，结果未确认。`);
    if (name !== "dapan") evidence(found[0].ok === 1 && (found[0].exit_code === null || found[0].exit_code === 0), "step_failed", `共享步骤 ${name} 未完成，结果未确认。`);
  }
}
async function verifyFinanceOutcome(params, mode, startedAt) {
  let db;
  try {
    const baseline = baselines.get(params);
    evidence(baseline, "baseline_missing", "缺少本次执行前基线，无法将文件和审计运行绑定到本轮，结果未确认。");
    evidence(Number.isFinite(startedAt) && startedAt >= baseline.capturedAt && startedAt <= Date.now(), "invalid_start_time", "启动时间无效，结果未确认。");
    const currentConfig = await configuration(params, mode, baseline.config.context);
    const config = baseline.config;
    evidence(currentConfig.signature === config.signature, "configuration_changed", "执行后参数或安装位置变化，结果未确认。");
    evidence(baseline.auditAvailable, "audit_baseline_unreadable", "执行前审计库不可读，无法可靠排除旧运行，结果未确认。");
    const current = await stamp(config.db);
    evidence(current, "audit_missing", "缺少本轮审计库和运行标识，结果未确认。");
    if (baseline.dbStamp) evidence(current.dev === baseline.dbStamp.dev && current.ino === baseline.dbStamp.ino, "audit_replaced", "审计库已被替换，不能把旧记录归入本轮。");
    const wal = await stamp(config.db + "-wal");
    evidence(Math.max(current.mtime, wal?.mtime ?? 0) >= startedAt, "stale_audit", "审计库及 WAL 均未在本轮更新，结果未确认。");
    db = openAudit(config.db);
    const newRuns = db.prepare("SELECT rowid AS sequence,run_id,started_at,finished_at,mode,ok,argv FROM runs WHERE rowid > ? ORDER BY rowid").all(baseline.watermark);
    evidence(newRuns.length < 1e4, "ambiguous_audit", "本轮新增审计过多，无法可靠绑定，结果未确认。");
    const expectedMode = config.scope === "dapan" ? "dapan" : config.scope + (config.dry ? "-dry" : "");
    const runs = newRuns.filter((row) => row.mode === expectedMode && typeof row.argv === "string" && row.argv.includes(config.path));
    evidence(runs.length === 1, "run_not_unique", "没有唯一匹配本次入口的新增运行 ID，不能把旧运行或并发运行当成功。");
    const run = runs[0], runId = run.run_id;
    evidence(typeof runId === "string" && /^\d{8}-\d{6}(?:-\d+)?$/.test(runId), "invalid_run_id", "本轮审计运行 ID 无效，结果未确认。");
    const lower = Math.floor(startedAt / 1e3) * 1e3;
    evidence(time(run.started_at) >= lower && time(run.started_at) <= Date.now() + 1e3, "stale_run", "运行 ID 的开始时间不属于本轮，结果未确认。");
    const conflicts = newRuns.filter((row) => ["consume", "consume-dry", "ads", "ads-dry"].includes(String(row.mode)) && row.run_id !== runId);
    evidence(conflicts.length === 0, "concurrent_run", "同一安装目录有并发同步运行，共享结果归属不明确。");
    if (config.scope === "dapan") return { ok: false, summary: config.dry ? "大盘预演未确认：原脚本会写本地审计，但没有完整的本轮逐项结果 JSON，也未关闭预演运行记录。" : "大盘同步待核对：本轮写入回执不等于完整回读核验，审计成功或进程退出0不足以证明全部记录完成。", details: { reason: "dapan_item_evidence_missing", runId, scope: config.scope, mode, localAuditWrites: true } };
    evidence((run.ok === 0 || run.ok === 1) && Number.isFinite(time(run.finished_at)) && time(run.finished_at) >= time(run.started_at) && time(run.finished_at) <= Date.now() + 1e3, "run_incomplete", "本轮运行审计未成功完成，结果未确认。");
    const steps = db.prepare("SELECT * FROM steps WHERE run_id=?").all(runId);
    requireSteps(steps, ["snapshot", ...sources(config).map((source) => "sync:" + source), ...!config.dry && config.scope === "consume" ? ["dapan"] : []]);
    const snapshot = await freshJson(join(config.cwd, "rules_full.json"), baseline, startedAt);
    evidence(object(snapshot), "snapshot_invalid", "本轮规则快照结构无效。");
    const allResults = [];
    const counts = {};
    for (const source of sources(config)) {
      const records = snapshot[source];
      evidence(Array.isArray(records), "snapshot_segment_missing", "本轮规则快照缺少所选来源分段。");
      const expected = /* @__PURE__ */ new Map();
      for (const record of records) {
        evidence(object(record) && object(record.fields), "rule_invalid", "本轮规则结构不完整。");
        if (!truth(record.fields["启用"])) continue;
        evidence(typeof record.record_id === "string" && record.record_id.length > 0 && typeof record.fields["产品名"] === "string" && record.fields["产品名"].length > 0, "rule_invalid", "启用规则缺少标识或产品名。");
        evidence(!expected.has(record.record_id), "duplicate_rule", "快照中出现重复规则标识。");
        expected.set(record.record_id, record.fields["产品名"]);
      }
      const results = await freshJson(join(config.cwd, `full_review_result_${source}.json`), baseline, startedAt);
      evidence(Array.isArray(results), "result_invalid", "本轮逐项结果必须是 JSON 数组。");
      evidence(results.length === expected.size, "rule_count_mismatch", "本轮结果数量与启用规则不一致，不能将缺项当成功。");
      const seen = /* @__PURE__ */ new Set();
      for (const row of results) {
        evidence(object(row) && typeof row.record_id === "string" && row.src_type === source && expected.has(row.record_id) && expected.get(row.record_id) === row.name && !seen.has(row.record_id), "rule_identity_mismatch", "本轮结果含未知、重复或不匹配的规则。");
        seen.add(row.record_id);
        evidence(typeof row.ok === "boolean" && typeof row.err === "string" && (row.ok ? row.err === "" : row.err.length > 0), "rule_invalid", "本轮逐项结果的状态与错误说明不一致。");
        for (const key of ["写", "跳过", "零值", "缺行"]) evidence(typeof row[key] === "number" && Number.isInteger(row[key]) && Number(row[key]) >= 0, "rule_metrics_invalid", "本轮规则统计不完整，结果未确认。");
        if (config.dates) {
          evidence(Array.isArray(row.dates) && JSON.stringify(row.dates) === JSON.stringify(config.dates), "result_dates_mismatch", "消耗逐项结果的日期与本轮选择不一致。");
          const serials = new Set(config.dates.map((date) => (dayTimestamp(date) - Date.UTC(1899, 11, 30)) / 864e5));
          evidence(Array.isArray(row.changes) && row.changes.every((change) => object(change) && typeof change.date === "number" && serials.has(change.date)), "result_dates_mismatch", "消耗逐项变更包含所选范围以外的日期，结果未确认。");
        }
        allResults.push(row);
      }
      counts[source] = results.length;
    }
    evidence(allResults.length > 0, "zero_rules", "本轮启用规则为0，0/0不构成预演或同步成功。");
    const auditRules = db.prepare("SELECT src_type,product,platform,ok,wrote,skipped,zero_skipped,missing_rows,CASE WHEN error IS NULL OR error='' THEN 0 ELSE 1 END AS has_error FROM rule_runs WHERE run_id=?").all(runId);
    const failures = allResults.filter((row) => row.ok === false), completed = allResults.length - failures.length;
    const issues = failures.map((row) => ({ product: row.name, stage: row.src_type, error: String(row.err) + (row.writeUnconfirmed === true ? " 本次可能已有部分写入，请核对该产品。" : "") }));
    for (const step of steps) if (step.ok !== 1 || step.exit_code !== null && step.exit_code !== 0) {
      const name = String(step.step);
      issues.push({ product: "后续步骤", stage: name.startsWith("dapan") ? "大盘更新" : name.startsWith("status:") ? "状态回写" : name === "push_relay" ? "审计中转" : name, error: typeof step.summary === "string" && step.summary ? step.summary : `${name} 未完成。` });
    }
    const partial = () => ({ ok: false, summary: `本轮${config.scope === "ads" ? "广告" : "消耗"}${config.dry ? "预演" : "更新"}已结束：共 ${allResults.length} 条规则，完成 ${completed} 条，未完成 ${failures.length} 条${issues.length > failures.length ? `；另有 ${issues.length - failures.length} 个后续步骤问题` : ""}。`, details: { reason: completed > 0 ? "partial_completion" : "rule_failed", runId, scope: config.scope, mode, rules: counts, total: allResults.length, completed, failed: failures.length, issues, consumptionResultsVerified: !config.dry && config.scope === "consume", consumptionRulesVerified: false, remoteDataVerified: false } });
    if (config.dry) {
      evidence(auditRules.length === 0, "dry_run_has_committed_rules", "预演运行出现正式逐项入库证据，结果未确认。");
      if (issues.length) return partial();
      evidence(run.ok === 1, "run_incomplete", "本轮运行审计未成功完成，结果未确认。");
      return { ok: true, summary: `预演结果已核验：${allResults.length}条规则均通过；--dry 仍会写本地快照、结果与审计，未核验远程数据。`, details: { runId, scope: config.scope, mode, rules: counts, localWrites: ["rules snapshot", "result JSON", "SQLite runs/steps"], remoteDataVerified: false } };
    }
    evidence(auditRules.length === allResults.length, "audit_rule_count_mismatch", "本轮逐项审计数量与结果不一致，结果未确认。");
    const remaining = [...auditRules];
    for (const row of allResults) {
      const index = remaining.findIndex((a) => a.src_type === row.src_type && a.product === row.name && String(a.platform ?? "") === String(row["平台"] ?? row.platform ?? "") && a.ok === (row.ok ? 1 : 0) && a.has_error === (row.ok ? 0 : 1) && a.wrote === row["写"] && a.skipped === row["跳过"] && a.zero_skipped === row["零值"] && a.missing_rows === row["缺行"]);
      evidence(index >= 0, "audit_rule_mismatch", "逐项结果未能与本轮运行 ID 的审计对应。");
      remaining.splice(index, 1);
    }
    if (issues.length) return partial();
    evidence(run.ok === 1, "run_incomplete", "本轮运行审计未成功完成，结果未确认。");
    if (config.scope === "consume") return { ok: false, summary: "消耗逐项结果已核验；大盘保留本轮写入回执，尚缺完整回读核验，整体同步仍待核对。", details: { reason: "dapan_item_evidence_missing", runId, rules: counts, consumptionRulesVerified: true, workflowVerified: false } };
    if (config.push) return { ok: false, summary: "广告逐项结果已核验，但原审计推送没有完整的本轮接收确认，整体结果仍未确认。", details: { reason: "relay_ack_missing", runId, rules: counts, advertisingRulesVerified: true } };
    return { ok: true, summary: `本轮广告同步结果已核验：${allResults.length}条规则的结果及运行审计均通过；未发送卡片或推送中转。`, details: { runId, scope: config.scope, mode, rules: counts, ruleAuditVerified: true } };
  } catch (error) {
    return { ok: false, summary: error instanceof EvidenceError ? error.message : "无法可靠读取本轮 finance 结果，结果未确认。", details: { reason: error instanceof EvidenceError ? error.reason : "verification_unavailable" } };
  } finally {
    db?.close();
  }
}
async function buildFinanceDailyReport(params, mode, startedAt, exitCode, verification) {
  const baseline = baselines.get(params), details = object(verification?.details) ? verification.details : {};
  if (mode === "dry-run" || exitCode !== 0 || !baseline || baseline.config.scope !== "consume" || details.consumptionRulesVerified !== true && !(details.consumptionResultsVerified === true && typeof details.completed === "number" && details.completed > 0)) return;
  try {
    const data = await freshJson(join(baseline.config.cwd, "finance-report.json"), baseline, startedAt);
    evidence(object(data) && data.schemaVersion === 1 && data.kind === "consume" && typeof details.runId === "string" && data.runId === details.runId, "report_identity_mismatch", "日报与本轮运行不匹配。");
    evidence(typeof data.generatedAt === "string" && Date.parse(data.generatedAt) >= startedAt && Date.parse(data.generatedAt) <= Date.now() + 1e3, "stale_report", "日报生成时间不属于本轮。");
    evidence(typeof data.dataDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(data.dataDate) && Number.isFinite(Date.parse(data.dataDate + "T00:00:00Z")), "report_date_invalid", "日报缺少有效数据日期。");
    if (baseline.config.dates) evidence(data.dataDate === baseline.config.dates[baseline.config.dates.length - 1], "report_date_mismatch", "日报日期与本轮选择不一致。");
    evidence(typeof data.text === "string" && data.text.trim().length > 0 && data.text.length <= 6e4, "report_text_invalid", "日报内容不可用。");
    if (data.source === "confirmed_dashboard") {
      const dashboard = await freshJson(join(baseline.config.cwd, "dapan-result.json"), baseline, startedAt);
      evidence(object(dashboard) && dashboard.schemaVersion === 1 && dashboard.runId === details.runId && dashboard.dashboardRunId === data.dashboardRunId && dashboard.dataDate === data.dataDate, "report_dashboard_mismatch", "日报缺少匹配的本轮大盘记录。");
      evidence(typeof dashboard.generatedAt === "string" && Date.parse(dashboard.generatedAt) >= startedAt && Date.parse(dashboard.generatedAt) <= Date.parse(data.generatedAt), "stale_dashboard", "大盘记录生成时间不属于本轮。");
      evidence(Array.isArray(dashboard.records) && typeof dashboard.total === "number" && Number.isInteger(dashboard.total) && dashboard.total > 0 && dashboard.records.length <= dashboard.total, "report_coverage_invalid", "日报统计范围无效。");
      const identifiers = /* @__PURE__ */ new Set();
      let included = 0;
      for (const row of dashboard.records) {
        evidence(object(row) && typeof row.record_id === "string" && !identifiers.has(row.record_id) && object(row.fields), "report_record_invalid", "大盘记录标识无效。");
        identifiers.add(row.record_id);
        const fields = row.fields;
        evidence(fields["数据日"] === data.dataDate, "report_date_mismatch", "大盘记录的数据日与日报不一致。");
        if (["买量消耗", "前日消耗", "消耗日环比"].every((key) => typeof fields[key] === "number" && Number.isFinite(fields[key]))) included++;
      }
      evidence(object(data.coverage) && data.coverage.total === dashboard.total && data.coverage.included === included && included > 0 && data.coverage.excluded === dashboard.total - included, "report_coverage_invalid", "日报统计范围与本轮大盘记录不一致。");
      evidence(included === dashboard.total || data.text.includes("以上为部分统计"), "report_coverage_missing", "部分日报缺少统计范围说明。");
      return data.text.trim();
    }
    evidence(details.consumptionRulesVerified === true, "report_dashboard_missing", "部分更新必须提供已确认的大盘记录。");
    return data.text.trim() + "\n\n统计口径：本轮读取的大盘汇总，大盘写入仍待核对。";
  } catch {
    return;
  }
}
async function buildFinanceReport(params, mode, _startedAt, exitCode, verification, dailyReport) {
  const baseline = baselines.get(params);
  const scope = baseline?.config.scope ?? params.mode ?? "consume";
  const label = scope === "ads" ? "广告" : scope === "dapan" ? "大盘" : "消耗";
  const details = object(verification?.details) ? verification.details : {};
  const failed = exitCode !== 0 || ["rule_failed", "step_failed", "run_incomplete", "dry_run_has_committed_rules"].includes(String(details.reason));
  const status = details.reason === "partial_completion" ? "部分完成" : failed ? "执行未完成" : mode === "dry-run" ? verification?.ok ? "预演已核验，未更新表格" : "预演结果待核对" : verification?.ok ? "本轮结果已核验" : "业务结果待核对";
  const lines = [`${label}执行结果${mode === "dry-run" ? "（预演）" : ""}`, `状态：${status}`];
  const dates = baseline?.config.dates;
  if (dates) lines.push(`更新日期：${dates.length === 1 ? dates[0] : `${dates[0]} 至 ${dates[dates.length - 1]}（${dates.length} 天）`}`);
  if (typeof details.runId === "string") lines.push(`运行编号：${details.runId}`);
  lines.push(verification?.summary ?? `脚本退出码：${exitCode}。部分步骤可能已执行，请查看本次运行记录后核对。`);
  if (Array.isArray(details.issues)) {
    for (const issue of details.issues) if (object(issue)) lines.push(`- ${String(issue.product ?? "未完成项目")}（${String(issue.stage ?? "更新")}）：${String(issue.error ?? "请核对本次运行记录。")}`);
  }
  if (details.reason === "partial_completion" || Array.isArray(details.issues) && details.issues.length) lines.push("其余独立项目已继续处理完毕。");
  if (object(details.rules)) for (const [source, count] of Object.entries(details.rules)) {
    if (typeof count === "number" && Number.isInteger(count) && count >= 0) lines.push(`${source}：已处理并核对 ${count} 条规则`);
  }
  if (mode === "dry-run") lines.push("这是预演记录，不能作为已更新表格的日报。");
  else if (scope === "consume") lines.push(dailyReport ? "消耗日报已单独生成，可使用「复制日报」。" : "本轮没有可核对的消耗日报；不会复用历史日报。");
  else if (exitCode === 0 && scope === "ads" && verification?.ok) lines.push("本次仅更新广告数据，未刷新大盘；日报金额需在刷新大盘后核对。");
  return lines.join("\n");
}
export {
  buildFinanceDailyReport,
  buildFinanceInvocation,
  buildFinanceReport,
  inspectFinance,
  verifyFinanceOutcome
};
