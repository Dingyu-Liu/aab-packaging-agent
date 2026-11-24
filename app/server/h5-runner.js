import { lstat, realpath, readFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { AppError } from "./errors.js";
import { runProcess } from "./processes.js";
import { Redactor } from "./redaction.js";
import { buildH5DailyReport } from "./h5-daily-report.js";
class H5Failure extends Error {
  constructor(reason, message, code = 1) {
    super(message);
    this.reason = reason;
    this.code = code;
  }
  reason;
  code;
}
const keys = /* @__PURE__ */ new Set(["dates", "sourceToken", "sheetId", "baseToken", "tableId", "feishuLauncher", "workers"]);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const data = (value) => !!value && typeof value === "object" && !Array.isArray(value);
function fail(condition, message, reason = "rule_failed") {
  if (!condition) throw new H5Failure(reason, message);
}
function day(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const time = Date.parse(value + "T00:00:00Z");
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : NaN;
}
function datesOf(value) {
  if (typeof value !== "string") throw new AppError(400, "dates 必须是逗号分隔的日期字符串。");
  const dates = value.split(",").map((value2) => value2.trim());
  if (dates.length < 1 || dates.length > 31 || dates.some((value2) => !Number.isFinite(day(value2)))) throw new AppError(400, "日期须为合法 YYYY-MM-DD，最多31天，不可留空。");
  for (let i = 1; i < dates.length; i++) if (day(dates[i]) - day(dates[i - 1]) !== 864e5) throw new AppError(400, "日期必须唯一、升序且逐日连续，不自动扩展日期。");
  return dates;
}
async function localFile(input, label) {
  if (typeof input !== "string" || !input || !isAbsolute(input) || input.includes("\0")) throw new AppError(400, `${label}需要本机文件的绝对路径。`);
  try {
    const file = await realpath(input);
    if (!(await lstat(file)).isFile()) throw new Error();
    return file;
  } catch {
    throw new AppError(400, `${label}不存在或不是普通文件。`);
  }
}
const resourceVariables = {
  sourceToken: "PARTNER_H5_SOURCE_TOKEN",
  sheetId: "PARTNER_H5_SOURCE_SHEET_ID",
  baseToken: "PARTNER_H5_BASE_TOKEN",
  tableId: "PARTNER_H5_TABLE_ID"
};
async function resolveH5Parameters(params, env) {
  const resolved = { ...params };
  const missing = Object.keys(resourceVariables).filter((key) => resolved[key] === void 0 || typeof resolved[key] === "string" && !resolved[key].trim());
  const configFile = env?.PARTNER_H5_CONFIG_FILE ?? process.env.PARTNER_H5_CONFIG_FILE;
  let defaults = {};
  if (configFile && missing.some((key) => (env?.[resourceVariables[key]] ?? process.env[resourceVariables[key]]) === void 0)) {
    let source;
    try {
      source = await readFile(configFile, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw new AppError(400, "无法读取 H5 默认表格配置，请检查 h5.config.local.json。");
      source = "{}";
    }
    let parsed;
    try {
      parsed = JSON.parse(source);
    } catch {
      throw new AppError(400, "H5 默认表格配置不是有效 JSON，请检查 h5.config.local.json。");
    }
    if (!data(parsed) || Object.keys(parsed).some((key) => !own(resourceVariables, key) && key !== "rawSource")) throw new AppError(400, "H5 默认表格配置仅支持 sourceToken、sheetId、baseToken、tableId 和 rawSource。");
    defaults = parsed;
  }
  for (const key of missing) {
    const variable = resourceVariables[key];
    const value = env?.[variable] ?? process.env[variable] ?? defaults[key];
    if (value !== void 0) resolved[key] = typeof value === "string" ? value.trim() : value;
    else delete resolved[key];
  }
  return resolved;
}
async function configOf(params, env) {
  if (Object.keys(params).some((key) => !keys.has(key))) throw new AppError(400, "H5 参数包含未注册选项，不支持扩行、消息或任意命令参数。");
  params = await resolveH5Parameters(params, env);
  const dates = datesOf(params.dates);
  for (const key of ["sourceToken", "sheetId", "baseToken", "tableId"]) if (typeof params[key] !== "string" || !params[key] || !/^[A-Za-z0-9_-]{1,4096}$/.test(params[key])) throw new AppError(400, `H5 默认表格配置缺少或无效：${key}。请配置 h5.config.local.json 或在高级设置中填写有效资源标识。`);
  const workers = params.workers ?? 4;
  if (typeof workers !== "number" || !Number.isInteger(workers) || workers < 1 || workers > 16) throw new AppError(400, "workers 必须是1到16的整数。");
  let raw;
  const rawSheet = env?.PARTNER_H5_RAW_SHEET_ID ?? process.env.PARTNER_H5_RAW_SHEET_ID;
  if (rawSheet) raw = { sheetId: rawSheet, basis: env?.PARTNER_H5_RAW_REVENUE_BASIS ?? process.env.PARTNER_H5_RAW_REVENUE_BASIS, fromDate: env?.PARTNER_H5_RAW_FROM_DATE ?? process.env.PARTNER_H5_RAW_FROM_DATE };
  else {
    const configFile = env?.PARTNER_H5_CONFIG_FILE ?? process.env.PARTNER_H5_CONFIG_FILE;
    if (configFile) {
      let defaults;
      try {
        defaults = JSON.parse(await readFile(configFile, "utf8"));
      } catch {
      }
      if (data(defaults) && defaults.sourceToken === params.sourceToken && defaults.sheetId === params.sheetId) raw = defaults.rawSource;
    }
  }
  let rawSource;
  if (raw !== void 0) {
    if (!data(raw) || Object.keys(raw).some((key) => !["sheetId", "basis", "fromDate"].includes(key)) || typeof raw.sheetId !== "string" || !/^[A-Za-z0-9_-]{1,4096}$/.test(raw.sheetId) || raw.basis !== "settled" || typeof raw.fromDate !== "string" || !Number.isFinite(day(raw.fromDate))) throw new AppError(400, "H5 备用来源须明确工作表、已结算口径（settled）和生效日期。");
    rawSource = { sheetId: raw.sheetId, basis: "settled", fromDate: raw.fromDate };
  }
  return { dates, rawSource, sourceToken: params.sourceToken, sheetId: params.sheetId, baseToken: params.baseToken, tableId: params.tableId, launcher: await localFile(env?.PARTNER_H5_FEISHU_LAUNCHER ?? process.env.PARTNER_H5_FEISHU_LAUNCHER ?? params.feishuLauncher, "服务器飞书启动脚本（PARTNER_H5_FEISHU_LAUNCHER；兼容 feishuLauncher）"), workers };
}
async function validateH5Parameters(params, env) {
  await configOf(params, env);
}
async function pluginScript(context) {
  let root;
  try {
    root = await realpath(context.pluginDirectory);
  } catch {
    throw new AppError(400, "冻结的H5插件目录不存在。");
  }
  const file = await localFile(join(root, "scripts/feishu_h5_sync.py"), "H5同步脚本");
  const rel = relative(root, file);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new AppError(400, "H5脚本越出冻结插件目录。");
  return file;
}
function deadline(context) {
  const timeout = context.timeoutMs ?? 3e5;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2147483647) throw new AppError(400, "H5超时时间无效。");
  const controller = new AbortController(), expires = Date.now() + timeout;
  const cancel = () => controller.abort("cancelled");
  if (context.signal?.aborted) cancel();
  else context.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort("timeout"), timeout);
  timer.unref();
  const check = () => {
    if (controller.signal.aborted || Date.now() >= expires) throw new AppError(controller.signal.reason === "cancelled" ? 409 : 408, controller.signal.reason === "cancelled" ? "H5任务已取消，已停止执行。" : "H5全流程超时，已停止执行。");
  };
  return { signal: controller.signal, check, remaining: () => {
    check();
    return Math.max(1, expires - Date.now());
  }, close: () => {
    clearTimeout(timer);
    context.signal?.removeEventListener("abort", cancel);
  } };
}
const python = () => process.env.PARTNER_AGENT_PYTHON || "python3";
const quietEnvironment = { BASH_ENV: "", ENV: "", PYTHONSTARTUP: "", PYTHONPATH: "", PYTHONDONTWRITEBYTECODE: "1" };
async function inspectH5(params, context) {
  const limit = deadline(context);
  try {
    limit.check();
    let config, script;
    try {
      config = await configOf(params, context.env);
      script = await pluginScript(context);
    } catch (error) {
      return [{ label: "H5本地配置", status: "fail", detail: error instanceof AppError ? error.message : "本地配置检查失败。" }];
    }
    limit.check();
    const checks = [{ label: "H5本地配置", status: "pass", detail: "参数与服务器脚本存在，未验证飞书授权。" }];
    const version = await runProcess(python(), ["--version"], { signal: limit.signal, timeoutMs: limit.remaining(), maxOutput: 5e3, env: quietEnvironment });
    checks.push({ label: "Python解释器", status: version.code === 0 ? "pass" : "fail", detail: version.code === 0 ? "Python可用。" : "Python不可用。" });
    const syntax = await runProcess(python(), ["-I", "-B", "-c", "import ast,sys,tokenize; ast.parse(tokenize.open(sys.argv[1]).read(), filename=sys.argv[1])", script], { signal: limit.signal, timeoutMs: limit.remaining(), maxOutput: 5e3, env: quietEnvironment });
    checks.push({ label: "H5脚本语法", status: syntax.code === 0 ? "pass" : "fail", detail: syntax.code === 0 ? "语法检查通过，未执行同步逻辑。" : "语法检查失败，原始输出未展示。" });
    const shell = await runProcess("/bin/bash", ["-n", config.launcher], { signal: limit.signal, timeoutMs: limit.remaining(), maxOutput: 5e3, env: quietEnvironment });
    checks.push({ label: "飞书启动脚本语法", status: shell.code === 0 ? "pass" : "fail", detail: shell.code === 0 ? "Bash语法检查通过，未执行启动脚本。" : "启动脚本语法检查失败。" });
    checks.push({ label: "飞书授权与目标权限", status: "warn", detail: "本地检查不连接飞书，未验证登录、数据或权限。" });
    limit.check();
    return checks;
  } catch (error) {
    limit.check();
    return [{ label: "H5服务器运行依赖", status: "fail", detail: error instanceof AppError ? error.message : "Python 或 Bash 运行环境不可用。" }];
  } finally {
    limit.close();
  }
}
async function save(file, value) {
  await writeFile(file, JSON.stringify(value, null, 2) + "\n", { mode: 384 });
}
async function fresh(file, startedAt) {
  let st;
  try {
    st = await lstat(file);
  } catch {
    throw new H5Failure("rule_failed", "缺少本轮业务结果文件，不能复用旧scratch。");
  }
  fail(st.isFile() && st.size <= 64 * 1024 * 1024, "业务结果不是可读取的普通JSON文件。");
  fail(st.mtimeMs >= startedAt && st.mtimeMs <= Date.now() + 1e3, "业务结果时间不属于本轮，拒绝旧结果。");
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new H5Failure("rule_failed", "本轮业务JSON无法解析。");
  }
}
function sameDates(value, dates) {
  return Array.isArray(value) && value.length === dates.length && value.every((item, i) => item === dates[i]);
}
function emptyList(value) {
  return Array.isArray(value) && value.length === 0;
}
function targetsOf(source, configs, scan, dates) {
  fail(data(source) && data(source.pivot_data), "来源缺少明确的产品/日期数值。");
  fail(data(configs) && data(configs.active_configs) && data(configs.all_configs), "配置清单结构不完整。");
  fail(data(scan) && sameDates(scan.target_dates, dates), "扫描日期与本轮日期不一致。");
  fail(emptyList(scan.expiring) && emptyList(scan.failed) && scan.expiring_count === 0, "扫描存在expiring/missing/失败项，禁止猜行号或自动扩展。");
  for (const key of ["errors", "missing"]) if (own(scan, key)) fail(emptyList(scan[key]), "扫描包含错误或缺失项，禁止写入。");
  fail(Array.isArray(scan.complete) && scan.complete.length > 0, "没有完整目标，0/0不能视为同步成功。");
  const active = configs.active_configs, all = configs.all_configs, names = Object.keys(active);
  fail(configs.active_count === names.length && scan.complete_count === names.length && scan.total_scanned === names.length && scan.complete.length === names.length, "扫描/配置目标数量不完整或不一致。");
  for (const [name, cfg] of Object.entries(all)) {
    fail(data(cfg), "配置记录结构无效。");
    const state = cfg["状态"], enabled = state === "正常更新" || Array.isArray(state) && state.length === 1 && state[0] === "正常更新";
    if (enabled) fail(own(active, name), "活跃配置被遗漏，禁止部分目标静默同步。");
  }
  const products = /* @__PURE__ */ new Set(), destinations = /* @__PURE__ */ new Set(), targets = [];
  for (const item of scan.complete) {
    fail(data(item) && typeof item.product === "string" && own(active, item.product) && !products.has(item.product), "扫描目标未知或重复。");
    const cfg = active[item.product];
    fail(data(cfg), "目标配置无效。");
    fail(item.ok === true && item.is_complete === true && emptyList(item.missing_dates), "目标未完整匹配日期，禁止写入。");
    if (own(item, "duplicate_dates")) fail(emptyList(item.duplicate_dates), "目标同一日期匹配多行，禁止写入。");
    fail(typeof item.token === "string" && item.token.length > 0 && typeof item.sheet_id === "string" && item.sheet_id.length > 0 && cfg["分表电子表格Token"] === item.token && cfg["目标工作表ID"] === item.sheet_id, "目标资源未与配置匹配。");
    const columns = cfg["更新列范围"];
    fail(typeof columns === "string" && /^(D:F|E:G)(?:$|[（(\s])/.test(columns), "写入列范围未明确，仅支持已确认的D:F或E:G。");
    const start = columns.startsWith("E:G") ? "E" : "D";
    fail(item.start_col === start, "扫描写入列与配置不一致。");
    const destination = JSON.stringify([item.token, item.sheet_id]);
    fail(!destinations.has(destination), "多个产品指向同一目标工作表，禁止覆盖。");
    fail(data(item.date_rows) && Object.keys(item.date_rows).length === dates.length, "目标日期行映射不完整。");
    const rows = dates.map((date) => item.date_rows && data(item.date_rows) ? item.date_rows[date] : void 0);
    fail(rows.every((row) => typeof row === "number" && Number.isInteger(row) && row >= 1 && row <= 750), "目标行号不可靠。");
    for (let i = 1; i < rows.length; i++) fail(Number(rows[i]) === Number(rows[i - 1]) + 1, "目标行须与日期同序逐行连续，禁止覆盖中间行。");
    fail(own(source.pivot_data, item.product) && data(source.pivot_data[item.product]), "来源缺少目标产品，禁止默认填0。");
    const product = source.pivot_data[item.product], values = [];
    for (const date of dates) {
      fail(own(product, date) && data(product[date]), "来源缺少目标日期，禁止默认填0。");
      const metrics = product[date];
      for (const key of ["rev", "imp", "clk"]) fail(own(metrics, key) && typeof metrics[key] === "number" && Number.isFinite(metrics[key]), "来源数值缺失或无效，禁止默认填0。");
      fail(Number.isSafeInteger(metrics.imp) && Number(metrics.imp) >= 0 && Number.isSafeInteger(metrics.clk) && Number(metrics.clk) >= 0, "来源展示/点击须为明确非负安全整数。");
      values.push({ rev: metrics.rev, imp: metrics.imp, clk: metrics.clk });
    }
    products.add(item.product);
    destinations.add(destination);
    targets.push({ product: item.product, token: item.token, sheet_id: item.sheet_id, start_col: start, rows, values });
  }
  return targets;
}
function planTargets(source, configs, scan, dates) {
  fail(data(source) && data(source.pivot_data), "来源缺少明确的产品/日期数值。");
  fail(data(configs) && data(configs.active_configs) && data(configs.all_configs), "配置清单结构不完整。");
  fail(data(scan) && sameDates(scan.target_dates, dates), "扫描日期与本轮日期不一致。");
  fail(Array.isArray(scan.complete) && Array.isArray(scan.expiring) && Array.isArray(scan.failed), "扫描结果结构不完整。");
  const active = configs.active_configs, names = Object.keys(active), issues = [], requested = /* @__PURE__ */ new Set();
  for (const [name, cfg] of Object.entries(configs.all_configs)) {
    fail(data(cfg), "配置记录结构无效。");
    const state = cfg["状态"];
    if (state === "正常更新" || Array.isArray(state) && state.length === 1 && state[0] === "正常更新") requested.add(name);
  }
  const add = (product, stage, error) => {
    if (!issues.some((issue) => issue.product === product)) issues.push({ product, stage, error });
  };
  if (configs.issues !== void 0) {
    fail(Array.isArray(configs.issues), "配置问题清单结构无效。");
    for (const row of configs.issues) {
      fail(data(row) && typeof row.product === "string" && typeof row.error === "string", "配置问题记录无效。");
      requested.add(row.product);
      add(row.product, "配置", row.error);
    }
  }
  for (const name of names) {
    fail(requested.has(name), "活动目标不属于本轮配置。");
  }
  for (const name of requested) if (!own(active, name) && !issues.some((issue) => issue.product === name)) add(name, "配置", "启用配置缺少可执行的目标表映射，已跳过该产品。");
  if (Array.isArray(source.issues)) {
    for (const row of source.issues) if (data(row) && typeof row.product === "string" && requested.has(row.product) && typeof row.error === "string") add(row.product, "来源数据", row.error);
  }
  const rows = [...scan.complete, ...scan.expiring, ...scan.failed], seen = /* @__PURE__ */ new Set();
  fail(configs.active_count === names.length && scan.complete_count === scan.complete.length && scan.expiring_count === scan.expiring.length && scan.total_scanned === rows.length && rows.length === names.length, "扫描/配置目标数量不完整或不一致。");
  for (const row of rows) {
    fail(data(row) && typeof row.product === "string" && own(active, row.product) && !seen.has(row.product), "扫描目标未知或重复。");
    seen.add(row.product);
  }
  for (const row of scan.expiring) {
    const item = row;
    const missing = Array.isArray(item.missing_dates) ? item.missing_dates.join("、") : "";
    add(String(item.product), "目标日期", missing ? `目标表缺少日期：${missing}，已跳过该产品。` : "目标日期存在重复或行号不完整，已跳过该产品。");
  }
  for (const row of scan.failed) {
    const item = row;
    add(String(item.product), "读取目标", typeof item.error === "string" ? item.error : "读取目标表失败，请检查权限和目标配置。");
  }
  const destinations = /* @__PURE__ */ new Map();
  for (const row of scan.complete) {
    const item = row;
    const key = JSON.stringify([item.token, item.sheet_id]);
    destinations.set(key, [...destinations.get(key) ?? [], String(item.product)]);
  }
  for (const products of destinations.values()) if (products.length > 1) for (const product of products) add(product, "配置", "多个产品指向同一目标工作表，已跳过这些产品以避免相互覆盖。");
  const targets = [];
  for (const row of scan.complete) {
    const item = row, name = String(item.product);
    if (issues.some((issue) => issue.product === name)) continue;
    try {
      targets.push(...targetsOf(source, { active_count: 1, active_configs: { [name]: active[name] }, all_configs: { [name]: active[name] } }, { target_dates: dates, total_scanned: 1, complete_count: 1, expiring_count: 0, complete: [item], expiring: [], failed: [] }, dates));
    } catch (error) {
      if (!(error instanceof H5Failure)) throw error;
      add(name, "预检", error.message);
    }
  }
  fail(requested.size > 0, "没有启用目标，0/0不能视为同步成功。");
  return { targets, issues, total: requested.size };
}
function verifyItems(value, targets, dates) {
  fail(data(value) && sameDates(value.dates, dates) && Array.isArray(value.successes) && Array.isArray(value.failures), "缺少本轮逐条同步结果。");
  fail(value.total === targets.length && value.success_count === value.successes.length && value.failure_count === value.failures.length && value.successes.length + value.failures.length === targets.length, "同步数量不符，结果不完整。");
  const expected = new Map(targets.map((target) => [target.product, target])), seen = /* @__PURE__ */ new Set(), issues = [], successes = [], failures = [];
  for (const [ok, rows] of [[true, value.successes], [false, value.failures]]) for (const row of rows) {
    fail(data(row) && typeof row.product === "string" && expected.has(row.product) && !seen.has(row.product) && row.ok === ok, "同步结果出现未知、重复或状态错误的目标。");
    seen.add(row.product);
    const target = expected.get(row.product);
    fail(row.token === target.token && row.sheet_id === target.sheet_id, "同步结果目标与本轮计划不一致。");
    let issue;
    if (!ok) issue = { product: row.product, stage: row.step === "readback" ? "回读" : "写入", error: typeof row.error === "string" ? row.error : "该目标同步失败。", ...row.written === true ? { unconfirmed: true } : {} };
    else try {
      const verified = verifyH5Readback({ dates, total: 1, success_count: 1, failure_count: 0, successes: [row], failures: [] }, [target], dates);
      if (!verified.ok) issue = { product: row.product, stage: "回读", error: verified.summary, unconfirmed: true };
    } catch (error) {
      if (!(error instanceof H5Failure)) throw error;
      issue = { product: row.product, stage: "回读", error: error.message };
    }
    if (issue) {
      issues.push(issue);
      failures.push({ ...row, ok: false, error: issue.error, unconfirmed: issue.unconfirmed === true });
    } else successes.push(row);
  }
  return { successes, issues, failures };
}
function csvRow(text) {
  const cells = [];
  let value = "", quoted = false, closed = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          value += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else value += c;
      continue;
    }
    if (c === ",") {
      cells.push(value);
      value = "";
      closed = false;
      continue;
    }
    if (c === '"') {
      if (value !== "" || closed) return null;
      quoted = true;
      continue;
    }
    if (closed && c.trim() !== "") return null;
    value += c;
  }
  if (quoted) return null;
  cells.push(value);
  return cells;
}
function readDate(value) {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 1 || value > 2958465) return null;
    return new Date(Date.UTC(1899, 11, 30) + value * 864e5).toISOString().slice(0, 10);
  }
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!match) return null;
  const result = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  return Number.isFinite(day(result)) ? result : null;
}
function readNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}
function sameMetric(actual, expected, index) {
  if (actual === expected) return true;
  if (index !== 0) return false;
  const tolerance = Math.min(1e-7, 8 * Number.EPSILON * Math.max(1, Math.abs(actual), Math.abs(expected)));
  return Math.abs(actual - expected) <= tolerance;
}
function verifyH5Readback(value, targets, dates) {
  fail(data(value) && sameDates(value.dates, dates), "结果日期不属于本轮。");
  fail(Array.isArray(value.successes) && Array.isArray(value.failures), "缺少逐条同步结果。");
  fail(value.total === targets.length && value.success_count === targets.length && value.failure_count === 0 && value.failures.length === 0 && value.successes.length === targets.length, "同步数量不符或存在失败项，不能算成功。");
  const byProduct = new Map(targets.map((target) => [target.product, target])), seen = /* @__PURE__ */ new Set(), reasons = /* @__PURE__ */ new Set();
  for (const row of value.successes) {
    fail(data(row) && typeof row.product === "string" && byProduct.has(row.product) && !seen.has(row.product) && row.ok === true, "同步结果出现未知、重复或失败目标。");
    const target = byProduct.get(row.product);
    seen.add(row.product);
    fail(row.token === target.token && row.sheet_id === target.sheet_id, "同步结果目标与本轮计划不一致。");
    const offset = target.start_col === "D" ? 3 : 4, parsed = /* @__PURE__ */ new Map();
    if (own(row, "readback_values") || own(row, "readback_render")) {
      const range = `A${target.rows[0]}:G${target.rows.at(-1)}`;
      if (row.readback_render !== "UnformattedValue" || row.readback_range !== range || !Array.isArray(row.readback_values) || row.readback_values.length !== dates.length) {
        reasons.add("原始回读的区域或行数不完整");
        continue;
      }
      let invalid = false;
      for (const [index, cells] of row.readback_values.entries()) {
        if (!Array.isArray(cells) || cells.length < offset + 3 || cells.length > 7) {
          invalid = true;
          break;
        }
        parsed.set(target.rows[index], cells);
      }
      if (invalid) {
        reasons.add("原始回读缺少日期或指标列");
        continue;
      }
    } else {
      if (typeof row.readback !== "string" || !row.readback.trim()) {
        reasons.add("没有返回回读内容");
        continue;
      }
      let invalid = false;
      for (const line of row.readback.split(/\r?\n/).filter((line2) => line2.trim())) {
        const match = line.match(/^\[row=(\d+)\]\s*(.*)$/);
        if (!match) {
          invalid = true;
          break;
        }
        const number = Number(match[1]), cells = csvRow(match[2]);
        if (!cells || cells.length < offset + 3 || cells.length > 7 || parsed.has(number)) {
          invalid = true;
          break;
        }
        parsed.set(number, cells);
      }
      if (invalid || parsed.size !== dates.length) {
        reasons.add("旧回读格式或行号不完整");
        continue;
      }
    }
    for (let index = 0; index < dates.length; index++) {
      const cells = parsed.get(target.rows[index]);
      if (!cells) {
        reasons.add("回读缺少目标行");
        continue;
      }
      const date = readDate(cells[0]);
      if (!date) {
        reasons.add("回读日期无法识别");
        continue;
      }
      fail(date === dates[index], "回读日期与预期行不符，已知写入结果不匹配。");
      const actual = cells.slice(offset, offset + 3).map(readNumber), expected = [target.values[index].rev, target.values[index].imp, target.values[index].clk];
      if (actual.some((value2) => value2 === null)) {
        reasons.add("回读指标缺少原始数值");
        continue;
      }
      for (let metric = 0; metric < 3; metric++) fail(sameMetric(actual[metric], expected[metric], metric), "回读数值与来源预期不匹配，不能算成功。");
    }
  }
  if (reasons.size) return { ok: false, summary: `写入返回成功，但自动回读核验尚未确认：${[...reasons].join("；")}。`, details: { reason: "readback_unconfirmed", targets: targets.length, dates: dates.length, reasons: [...reasons] } };
  return { ok: true, summary: `H5同步完成：${targets.length}个目标、${dates.length}天的回读日期与原始数值均匹配；未扩行、未发送消息。`, details: { targets: targets.length, dates: dates.length, readbackVerified: true } };
}
async function executeH5(params, mode, context) {
  if (mode !== "dry-run" && mode !== "sync") throw new AppError(400, "H5执行仅支持dry-run或sync；check请调用inspectH5。");
  const limit = deadline(context);
  let runDirectory;
  const summaries = [], redactor = new Redactor();
  const emit = (message, stream = "stdout") => {
    message = redactor.text(message);
    summaries.push(message);
    context.onLine?.(message, stream);
  };
  try {
    limit.check();
    const config = await configOf(params, context.env), script = await pluginScript(context);
    limit.check();
    for (const value of [config.sourceToken, config.baseToken, config.launcher]) redactor.add(value);
    const task = await realpath(context.taskDirectory), h5 = join(task, "h5");
    await mkdir(h5, { recursive: true, mode: 448 });
    fail((await lstat(h5)).isDirectory() && !(await lstat(h5)).isSymbolicLink(), "任务H5目录不能是符号链接。");
    runDirectory = await mkdtemp(join(h5, "run-"));
    const runId = randomUUID();
    const env = { ...context.env, ...quietEnvironment, PARTNER_H5_FEISHU_LAUNCHER: config.launcher, PARTNER_H5_SOURCE_TOKEN: config.sourceToken, PARTNER_H5_SOURCE_SHEET_ID: config.sheetId, PARTNER_H5_BASE_TOKEN: config.baseToken, PARTNER_H5_TABLE_ID: config.tableId, PARTNER_H5_RAW_SHEET_ID: config.rawSource?.sheetId ?? "", PARTNER_H5_RAW_REVENUE_BASIS: config.rawSource?.basis ?? "", PARTNER_H5_RAW_FROM_DATE: config.rawSource?.fromDate ?? "", PARTNER_H5_PREVIEW_USER: "", PARTNER_H5_GROUP_CHAT: "", PARTNER_H5_ALLOW_WRITE: "0" };
    const stage = async (name, args, output, write = false) => {
      limit.check();
      emit(`H5阶段：${name}${write ? "（真实写入）" : "（远程只读）"}`);
      const start = Date.now(), result = await runProcess(python(), ["-I", "-B", script, name, ...args], { cwd: runDirectory, env: { ...env, PARTNER_H5_ALLOW_WRITE: write ? "1" : "0" }, signal: limit.signal, timeoutMs: limit.remaining(), maxOutput: 2e6 });
      await writeFile(join(runDirectory, `${name}.stdout.txt`), result.stdout, { mode: 384 });
      await writeFile(join(runDirectory, `${name}.stderr.txt`), result.stderr, { mode: 384 });
      limit.check();
      fail(result.code === 0, `H5 ${name}进程失败：${redactor.text(result.stderr.trim().split("\n").at(-1) || "请检查本轮日志。").slice(0, 1e3)}`);
      return output ? fresh(output, start) : void 0;
    };
    const sourceFile = join(runDirectory, "source.json"), configFile = join(runDirectory, "config.json"), scanFile = join(runDirectory, "scan.json"), resultFile = join(runDirectory, "result.json");
    const source = await stage("fetch-source", ["--dates", config.dates.join(","), "--output", sourceFile], sourceFile);
    if (data(source) && data(source.source_info) && source.source_info.kind === "settled_rows") {
      emit(`处理透视页为空，已按已校验结算明细汇总 ${data(source.pivot_data) ? Object.keys(source.pivot_data).length : 0} 个产品；最新可用日期 ${String(source.source_info.latestAvailableDate)}。`);
    }
    const configs = await stage("fetch-config", ["--output", configFile], configFile);
    if (data(configs) && data(configs.all_configs)) {
      for (const cfg of Object.values(configs.all_configs)) if (data(cfg)) redactor.add(cfg["分表电子表格Token"]);
    }
    const scan = await stage("scan", ["--dates", config.dates.join(","), "--config-file", configFile, "--workers", String(config.workers), "--output", scanFile], scanFile);
    limit.check();
    const plan = planTargets(source, configs, scan, config.dates), { targets, issues } = plan;
    await save(join(runDirectory, "plan-summary.json"), { runId, mode, dates: config.dates, targetCount: targets.length, total: plan.total, skipped: issues.length, cells: targets.length * config.dates.length * 3, noExpansion: true, noMessages: true, localFilesWritten: true });
    emit(`预检结束：${targets.length}个目标可继续，${issues.length}个目标已记录问题；将在全部结束后汇总。`);
    const readyFile = join(runDirectory, "ready-scan.json"), products = new Set(targets.map((target) => target.product));
    fail(data(scan) && Array.isArray(scan.complete), "扫描结果不可用。");
    await save(readyFile, { target_dates: config.dates, total_scanned: targets.length, complete_count: targets.length, expiring_count: 0, complete: scan.complete.filter((row) => data(row) && products.has(String(row.product))), expiring: [], failed: [] });
    const syncArgs = ["--source-file", sourceFile, "--scan-file", readyFile, "--dates", config.dates.join(","), "--workers", String(config.workers), "--output", resultFile];
    let successes = [], failures = [];
    if (targets.length) {
      if (mode === "dry-run") {
        await stage("sync", [...syncArgs, "--dry-run"], void 0);
        successes = targets.map((target) => ({ product: target.product, ok: true, preview: true }));
      } else {
        const checked = verifyItems(await stage("sync", syncArgs, resultFile, true), targets, config.dates);
        limit.check();
        successes = checked.successes;
        failures = checked.failures;
        issues.push(...checked.issues);
      }
    }
    for (const issue of plan.issues) if (!failures.some((row) => row.product === issue.product)) failures.push({ product: issue.product, ok: false, error: issue.error, step: issue.stage });
    const safeIssues = redactor.json(issues), unconfirmed = safeIssues.filter((issue) => issue.unconfirmed).length, failed = safeIssues.length - unconfirmed, ok = safeIssues.length === 0 && successes.length > 0;
    const summary = `H5${mode === "dry-run" ? "预演" : "更新"}已结束：共 ${plan.total} 个目标，${mode === "dry-run" ? "预演通过" : "完成并核对"} ${successes.length} 个，失败或跳过 ${failed} 个，待核对 ${unconfirmed} 个。`;
    const reason = ok ? void 0 : successes.length > 0 ? "partial_completion" : unconfirmed > 0 && failed === 0 ? "readback_unconfirmed" : "rule_failed";
    const verification = { ok, summary, details: { ...reason ? { reason } : {}, runId, targets: plan.total, dates: config.dates.length, completed: successes.length, failed, unconfirmed, issues: safeIssues, ...mode === "dry-run" ? { remoteWrites: false, messagesSent: false, localFilesWritten: true } : { readbackVerified: ok } } };
    const status = ok ? "全部完成" : successes.length > 0 ? "部分完成" : unconfirmed > 0 ? "结果待核对" : "本轮未完成更新";
    const resultReport = [`H5执行结果${mode === "dry-run" ? "（预演）" : ""}`, `状态：${status}`, `运行编号：${runId}`, `日期：${config.dates.join("、")}`, summary, ...safeIssues.map((issue) => `- ${issue.product}（${issue.stage}）：${issue.error}${issue.unconfirmed ? " 已返回写入成功，需核对实际数据。" : ""}`), ...mode === "dry-run" ? ["本次仅预演，未写飞书、未扩行、未发送消息。"] : []].join("\n");
    let dailyReport;
    if (mode !== "dry-run") {
      const completed = new Set(successes.map((row) => String(row.product)));
      const daily = buildH5DailyReport({ runId, dates: config.dates, products: targets.filter((target) => completed.has(target.product)), totalTargets: plan.total });
      if (daily) {
        const safe = redactor.json(daily);
        dailyReport = safe.text;
        await save(join(runDirectory, "daily-report.json"), safe);
        await writeFile(join(runDirectory, "daily-report.txt"), dailyReport, { mode: 384 });
      }
    }
    await save(resultFile, { dates: config.dates, total: plan.total, success_count: successes.length, failure_count: failures.length, successes, failures });
    await save(join(runDirectory, "verification-summary.json"), verification);
    await writeFile(join(runDirectory, "report.txt"), resultReport, { mode: 384 });
    limit.check();
    emit(summary, ok ? "stdout" : "stderr");
    return { code: 0, stdout: summaries.join("\n"), stderr: ok ? "" : summary, businessVerification: verification, resultReport, dailyReport };
  } catch (error) {
    limit.check();
    const known = error instanceof H5Failure, summary = redactor.text(known ? error.message : error instanceof AppError ? error.message : "H5执行未完成，请查看本轮日志。");
    const verification = { ok: false, summary, details: { reason: known ? error.reason : "rule_failed" } };
    const resultReport = `H5更新报表
状态：执行未完成
${summary}`;
    if (runDirectory) {
      await save(join(runDirectory, "verification-summary.json"), verification).catch(() => {
      });
      await writeFile(join(runDirectory, "report.txt"), resultReport, { mode: 384 }).catch(() => {
      });
    }
    emit(summary, "stderr");
    return { code: known ? error.code : 1, stdout: summaries.join("\n"), stderr: summary, businessVerification: verification, resultReport };
  } finally {
    limit.close();
  }
}
export {
  executeH5,
  inspectH5,
  resolveH5Parameters,
  validateH5Parameters,
  verifyH5Readback
};
