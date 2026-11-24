import { cp, mkdir, readdir, lstat, copyFile, writeFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { join, relative, isAbsolute, basename, dirname, resolve } from "node:path";
import { AppError } from "./errors.js";
import { skillPath } from "./plugins.js";
import { runProcess } from "./processes.js";
function isWithin(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || !rel.startsWith("..") && !isAbsolute(rel);
}
async function prepareWorkspace(options) {
  const { source, taskDir, pluginDirectory, profile, report, signal, onProgress } = options;
  const destination = join(taskDir, "workspace", basename(source));
  if (isWithin(source, destination) || isWithin(destination, source)) throw new AppError(400, "任务工作目录不能包含项目或被项目包含，请选择具体的工程根目录。");
  await mkdir(destination, { recursive: true });
  let files = 0, bytes = 0, skipped = 0;
  const rootSkip = /* @__PURE__ */ new Set(["Library", "Temp", "Obj", "obj", "Logs", "Build", "Builds", "build", ".gradle", ".idea", ".vs", ".local-data", ".opencode"]);
  const anySkip = /* @__PURE__ */ new Set([".git", "node_modules", ".DS_Store", ".gradle"]);
  async function copyDir(from, to, depth) {
    for (const entry of await readdir(from, { withFileTypes: true })) {
      if (signal.aborted) throw new AppError(409, "任务已取消。");
      if (options.includeSigning && entry.name === "build" || depth === 1 && ["app", "launcher", "unityLibrary"].includes(basename(from)) && entry.name === "build" || anySkip.has(entry.name) || depth === 0 && (rootSkip.has(entry.name) || ["opencode.json", "opencode.jsonc"].includes(entry.name))) continue;
      const src = join(from, entry.name), dest = join(to, entry.name);
      if (entry.isSymbolicLink() || !options.includeSigning && /\.(?:keystore|jks|p12|pfx|mobileprovision)$/i.test(entry.name) || options.includeSigning && /\.(?:aab|apk)$/i.test(entry.name) || /^\.env(?:\.|$)/.test(entry.name)) {
        skipped++;
        continue;
      }
      if (entry.isDirectory()) {
        await mkdir(dest, { recursive: true });
        await copyDir(src, dest, depth + 1);
      } else if (entry.isFile()) {
        const stat = await lstat(src);
        files++;
        bytes += stat.size;
        if (files > 1e5 || bytes > 5e9) throw new AppError(400, "工程超过首版复制上限（10 万文件 / 5 GB），请移除构建缓存后重试。");
        await copyFile(src, dest, constants.COPYFILE_FICLONE);
        if (files % 500 === 0) onProgress(`已复制 ${files} 个工程文件`);
      }
    }
  }
  await copyDir(source, destination, 0);
  onProgress(`工作副本已建立：${files} 个文件${skipped ? `；跳过 ${skipped} 个链接、环境或排除文件` : ""}`);
  const gitEnv = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
  for (const args of [["init", "--quiet"], ["config", "core.hooksPath", "/dev/null"], ["add", "--all"], ["-c", "user.name=Partner Agent", "-c", "user.email=local@partner-agent.invalid", "commit", "--quiet", "--allow-empty", "-m", "Task baseline"]]) {
    const result = await runProcess("git", args, { cwd: destination, env: gitEnv, signal, timeoutMs: 6e4 });
    if (result.code !== 0) throw new AppError(400, "无法为工作副本创建改动基线，请检查 Git 环境。");
  }
  const skill = await skillPath(pluginDirectory, profile);
  const skillName = basename(dirname(skill));
  const target = join(destination, ".opencode", "skills", skillName);
  await mkdir(dirname(target), { recursive: true });
  await cp(dirname(skill), target, { recursive: true, filter: async (path) => !(await lstat(path)).isSymbolicLink() });
  await mkdir(join(destination, ".partner-agent"), { recursive: true });
  await writeFile(join(destination, ".partner-agent", "original-project.json"), JSON.stringify(report, null, 2), { mode: 384 });
  await writeFile(join(destination, ".git", "info", "exclude"), ".opencode/\n.partner-agent/\n.env\n.env.*\n");
  return realpath(destination);
}
async function writeDiff(workspace, target, signal) {
  await runProcess("git", ["add", "-N", "--all"], { cwd: workspace, signal, timeoutMs: 3e4 });
  const diff = await runProcess("git", ["diff", "--no-ext-diff", "--no-color", "--binary", "HEAD"], { cwd: workspace, env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, signal, timeoutMs: 3e4, maxOutput: 1e7 });
  if (diff.code !== 0) throw new AppError(400, "生成改动补丁失败，请直接检查工作副本。");
  await writeFile(target, diff.stdout);
  return Buffer.byteLength(diff.stdout);
}
export {
  isWithin,
  prepareWorkspace,
  writeDiff
};
