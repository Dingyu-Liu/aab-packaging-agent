import { spawn } from "node:child_process";
import { AppError } from "./errors.js";
async function runProcess(command, args, options = {}) {
  if (options.signal?.aborted) throw new AppError(409, "任务已取消。");
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: [options.input === void 0 ? "ignore" : "pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
    if (options.input !== void 0) {
      child.stdin?.on("error", () => {
      });
      child.stdin?.end(options.input);
    }
    const max = options.maxOutput ?? 2e6;
    let stdout = "", stderr = "", outBuffer = "", errBuffer = "", settled = false, reason = "";
    let hardTimer;
    function terminate(why) {
      if (settled) return;
      reason = why;
      killProcessGroup(child, "SIGTERM");
      hardTimer = setTimeout(() => killProcessGroup(child, "SIGKILL"), 1500);
      hardTimer.unref();
    }
    const timeout = setTimeout(() => terminate("执行超时，进程已停止。"), options.timeoutMs ?? 6e4);
    timeout.unref();
    const abort = () => terminate("任务已取消，进程已停止。");
    options.signal?.addEventListener("abort", abort, { once: true });
    const flush = (stream, chunk, final = false) => {
      let buffer = (stream === "stdout" ? outBuffer : errBuffer) + chunk;
      const lines = buffer.split(/\r?\n|\r/);
      buffer = lines.pop() || "";
      for (const line of lines) if (line) options.onLine?.(line.slice(0, 2e4), stream);
      if (final && buffer) {
        options.onLine?.(buffer.slice(0, 2e4), stream);
        buffer = "";
      }
      if (buffer.length > 256e3) buffer = buffer.slice(-128e3);
      if (stream === "stdout") outBuffer = buffer;
      else errBuffer = buffer;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + chunk).slice(-max);
      flush("stdout", chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-max);
      flush("stderr", chunk);
    });
    function cleanup() {
      settled = true;
      clearTimeout(timeout);
      if (hardTimer) clearTimeout(hardTimer);
      options.signal?.removeEventListener("abort", abort);
    }
    child.on("error", (error) => {
      cleanup();
      reject(new AppError(400, `无法启动 ${command}：${error.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      flush("stdout", "", true);
      flush("stderr", "", true);
      cleanup();
      if (reason) reject(new AppError(409, reason));
      else resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}
function killProcessGroup(child, signal) {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
    }
  }
}
export {
  runProcess
};
