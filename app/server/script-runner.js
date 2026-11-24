import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute } from "node:path";
import { canonicalDirectory } from "./projects.js";
import { AppError } from "./errors.js";
import { runProcess } from "./processes.js";
import { buildFinanceInvocation, buildFinanceReport, buildFinanceDailyReport, verifyFinanceOutcome, inspectFinance } from "./finance-runner.js";
import { inspectH5, executeH5 } from "./h5-runner.js";
async function resolveScript(params) {
  const input = params.scriptPath;
  if (typeof input !== "string" || !input.trim() || !isAbsolute(input)) throw new AppError(400, "请选择实际同步脚本的绝对路径。");
  let path;
  try {
    path = await realpath(input);
  } catch {
    throw new AppError(400, "同步脚本不存在或无法访问。");
  }
  if (!(await lstat(path)).isFile()) throw new AppError(400, "脚本路径应指向文件。");
  const cwd = typeof params.workingDirectory === "string" && params.workingDirectory.trim() ? await canonicalDirectory(params.workingDirectory) : dirname(path);
  const ext = extname(path).toLowerCase();
  const inferred = ext === ".py" ? "python3" : [".js", ".mjs", ".cjs"].includes(ext) ? "node" : ext === ".sh" ? "bash" : "";
  const interpreter = String(params.interpreter || inferred);
  if (!["python3", "node", "bash"].includes(interpreter)) throw new AppError(400, "首版支持 Python、Node.js 或 Bash 脚本，请选择对应解释器。");
  return { path, cwd, interpreter };
}
function commandFor(interpreter) {
  return interpreter === "node" ? process.execPath : interpreter === "bash" ? "/bin/bash" : process.env.PARTNER_AGENT_PYTHON || "python3";
}
async function inspectScript(params, signal) {
  const script = await resolveScript(params);
  const command = commandFor(script.interpreter);
  const checks = [{ label: "同步脚本", status: "pass", detail: script.path }, { label: "工作目录", status: "pass", detail: script.cwd }];
  const version = await runProcess(command, [script.interpreter === "bash" ? "--version" : "--version"], { cwd: script.cwd, signal, timeoutMs: 1e4, maxOutput: 5e3 });
  checks.push({ label: "脚本运行环境", status: version.code === 0 ? "pass" : "fail", detail: (version.stdout || version.stderr).split("\n")[0] || command });
  const args = script.interpreter === "python3" ? ["-c", 'import ast,sys,tokenize; ast.parse(tokenize.open(sys.argv[1]).read(),filename=sys.argv[1]); print("Python syntax OK")', script.path] : script.interpreter === "node" ? ["--check", script.path] : ["-n", script.path];
  const syntax = await runProcess(command, args, { cwd: script.cwd, signal, timeoutMs: 15e3, maxOutput: 12e3 });
  checks.push({ label: "脚本语法", status: syntax.code === 0 ? "pass" : "fail", detail: syntax.code === 0 ? "语法检查通过，未执行同步逻辑。" : syntax.stderr || "语法检查失败。" });
  checks.push({ label: "业务依赖", status: "warn", detail: "本地检查不连接业务系统。账号、依赖和目标范围需在预演或运行时核对。" });
  return checks;
}
async function inspectScriptForPlugin(plugin, params, context) {
  if (plugin.script?.runner === "finance-sync") return inspectFinance(params, context);
  return plugin.script?.runner === "h5-sync" ? inspectH5(params, context) : inspectScript(params, context.signal);
}
async function scriptInvocation(plugin, params, mode, context) {
  if (plugin.script?.runner === "finance-sync") return buildFinanceInvocation(params, mode, context);
  const script = await resolveScript(params);
  if (mode === "dry-run" && !plugin.script?.supportsDryRun) throw new AppError(400, "该脚本没有声明可靠的预演模式。");
  let extra = [];
  if (plugin.script?.runner === "external") {
    let input;
    try {
      input = JSON.parse(String(params.argumentsJson || "[]"));
    } catch {
      throw new AppError(400, '脚本参数必须是 JSON 字符串数组，例如 ["--date", "2026-11-09"]。');
    }
    if (!Array.isArray(input) || input.length > 100 || !input.every((item) => typeof item === "string" && item.length <= 4096 && !item.includes("\0"))) throw new AppError(400, "脚本参数必须是最多 100 项的字符串数组。");
    extra = input;
  } else throw new AppError(400, "未注册的脚本执行器。");
  return { command: commandFor(script.interpreter), args: [script.path, ...extra], cwd: script.cwd, path: script.path };
}
async function executeScript(plugin, params, mode, options) {
  if (plugin.script?.runner === "h5-sync") return executeH5(params, mode, options);
  const invocation = await scriptInvocation(plugin, params, mode, options);
  const deadline = Date.now() + options.timeoutMs;
  let preparationOutput = "";
  if (invocation.bootstrap) {
    options.onLine("准备完整规则快照（远程只读，写入本轮本地目录）", "stdout");
    const preparation = await runProcess(invocation.command, ["-B", invocation.bootstrap], { cwd: invocation.cwd, env: invocation.env, signal: options.signal, timeoutMs: options.timeoutMs, onLine: options.onLine, maxOutput: 2e6 });
    if (preparation.code !== 0) return preparation;
    preparationOutput = preparation.stdout;
  }
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new AppError(408, "规则快照准备超时，同步未启动。");
  options.onLine(`启动 ${basename(invocation.path)}（${mode === "dry-run" ? "预演" : "实际执行"}）`, "stdout");
  const startedAt = Date.now();
  const result = await runProcess(invocation.command, invocation.args, { cwd: invocation.cwd, env: invocation.env, signal: options.signal, timeoutMs: remaining, onLine: options.onLine, maxOutput: 2e6 });
  if (preparationOutput) result.stdout = preparationOutput + "\n" + result.stdout;
  if (plugin.script?.runner === "finance-sync") {
    const businessVerification = result.code === 0 ? await verifyFinanceOutcome(params, mode, startedAt) : void 0;
    if (businessVerification) options.onLine(businessVerification.summary, businessVerification.ok ? "stdout" : "stderr");
    const dailyReport = await buildFinanceDailyReport(params, mode, startedAt, result.code, businessVerification);
    const resultReport = await buildFinanceReport(params, mode, startedAt, result.code, businessVerification, dailyReport);
    return { ...result, businessVerification, resultReport, dailyReport };
  }
  return result;
}
export {
  executeScript,
  inspectScript,
  inspectScriptForPlugin,
  resolveScript,
  scriptInvocation
};
