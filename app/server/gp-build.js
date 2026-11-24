import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { finished } from "node:stream/promises";
import { copyFile, lstat, mkdir, open, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { AppError } from "./errors.js";
import { GpInputRequired } from "./gp-agent.js";
import { runProcess } from "./processes.js";
import { isWithin } from "./workspaces.js";
function gpBuildParameters(parameters) {
  const { versionName, versionCode, module, variant } = parameters;
  const category = parameters.category === void 0 ? "other" : parameters.category;
  if (category !== "game" && category !== "other") throw new AppError(400, "应用类型无效，请选择游戏或其他。");
  if (typeof versionName !== "string" || !versionName.trim() || versionName.length > 100 || /[\x00-\x1f\x7f]/.test(versionName)) throw new AppError(400, "请填写不超过 100 字且不含控制字符的目标版本号。");
  if (typeof versionCode !== "number" || !Number.isInteger(versionCode) || versionCode < 1 || versionCode > 21e8) throw new AppError(400, "Version Code 必须是 1 到 2100000000 之间的整数。");
  if (module !== void 0 && (typeof module !== "string" || module !== "" && module !== ":" && !/^:?[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)*$/.test(module))) throw new AppError(400, "应用模块格式无效，例如 app 或 :game:app。");
  if (variant !== void 0 && (typeof variant !== "string" || variant !== "" && !/^(?:[A-Za-z][A-Za-z0-9]*Release|release)$/.test(variant))) throw new AppError(400, "请选择 Release 变体，例如 release 或 googleRelease。");
  return { category, projectMode: "in-place", stage: "preparing", versionName: versionName.trim(), versionCode, ...module ? { module: String(module).startsWith(":") ? String(module) : `:${module}` } : {}, ...variant ? { variant: String(variant) } : {} };
}
const initScript = String.raw`import groovy.json.JsonOutput
import groovy.json.JsonSlurper

def configPath = System.getenv('PARTNER_GP_CONFIG')
if (!configPath?.trim()) throw new GradleException('PARTNER_GP_RUNNER_ERROR: 工作台未传入 GP 构建配置文件路径。')
def configFile = new File(configPath)
if (!configFile.isFile()) throw new GradleException('PARTNER_GP_RUNNER_ERROR: 工作台 GP 构建配置文件不存在。')
def config = new JsonSlurper().parse(configFile)
if (!config.projectDirectory) throw new GradleException('PARTNER_GP_RUNNER_ERROR: 工作台 GP 配置缺少工程目录。')
// Gradle applies init scripts to buildSrc/included builds too; mutate only the selected build.
gradle.settingsEvaluated { settings ->
if (settings.settingsDir.canonicalFile != new File(config.projectDirectory.toString()).canonicalFile) return
def variants = []
gradle.beforeProject { p ->
    p.pluginManager.withPlugin('com.android.application') {
        def components = p.extensions.findByName('androidComponents')
        if (components == null) throw new GradleException('GP打包需要支持 Android Components API 的 Android Gradle Plugin（7.0+）。')
        components.onVariants(components.selector().all()) { variant ->
            if (variant.buildType == 'release') variant.outputs.each { output ->
                output.versionName.set(config.versionName.toString())
                output.versionCode.set((config.versionCode as Number).intValue())
                output.versionName.disallowChanges()
                output.versionCode.disallowChanges()
            }
            def capitalized = variant.name.substring(0, 1).toUpperCase(java.util.Locale.ROOT) + variant.name.substring(1)
            def prefix = p.path == ':' ? ':' : p.path + ':'
            variants.add([module: p.path, variant: variant.name, release: variant.buildType == 'release',
                apkTask: prefix + 'package' + capitalized,
                compileTask: prefix + 'compile' + capitalized + 'Sources',
                bundleTask: prefix + 'bundle' + capitalized,
                outputDirectory: new File(p.layout.buildDirectory.get().asFile, 'outputs/bundle/' + variant.name).absolutePath])
        }
    }
}
gradle.projectsEvaluated {
    // Materialize lazy Android variants before reporting their tasks.
    gradle.rootProject.allprojects.each { p -> p.tasks.names }
    gradle.rootProject.tasks.register('partnerGpInspect') {
        doLast {
            def available = variants.findAll { item ->
                def p = gradle.rootProject.findProject(item.module)
                item.release && p.tasks.findByPath(item.compileTask) != null && p.tasks.findByPath(item.bundleTask) != null
            }
            if (config.category == 'game') {
                def nativeTasks = gradle.rootProject.allprojects.collectMany { p ->
                    p.tasks.findAll { it.name in ['BuildIl2CppTask', 'buildIl2Cpp'] }.collect { it.path }
                }
                available.each { it.nativeTasks = nativeTasks }
            }
            println('PARTNER_GP_VARIANTS=' + JsonOutput.toJson(available))
        }
    }
}
gradle.taskGraph.whenReady { graph ->
    if (!config.approved) {
        def bundles = variants.collectMany { [it.bundleTask, it.apkTask] }
        def blocked = graph.allTasks.findAll { t -> bundles.contains(t.path) || t.name ==~ /(?i)(package.*Bundle|sign.*Bundle|assemble.*|install.*|publish.*|upload.*)/ }
        if (!blocked.empty) throw new GradleException('GP打包尚未获得本次编译的用户确认，已阻止打包任务：' + blocked.collect { it.path }.join(', '))
    }
}
}
`;
class GpBuildFailure extends AppError {
  constructor(taskName, message, diagnostics, origin = "project") {
    super(400, `${message}${diagnostics ? `
${diagnostics}` : ""}`);
    this.taskName = taskName;
    this.diagnostics = diagnostics;
    this.origin = origin;
  }
  taskName;
  diagnostics;
  origin;
}
function gradleDiagnostics(output) {
  const lines = output.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/);
  const marker = lines.findIndex((line) => /\* What went wrong:|^FAILURE:|\berror[: ]|^e: |^Caused by:|^> .*failed/i.test(line));
  const relevant = marker < 0 ? lines.slice(-45) : lines.slice(Math.max(0, marker - 2), marker + 55);
  return relevant.join("\n").trim().slice(0, 6e3);
}
async function assertWorkspace(options) {
  const { workspace, taskDir } = options;
  const actual = await realpath(workspace);
  const info = await lstat(workspace);
  if (!info.isDirectory() || info.isSymbolicLink() || actual !== resolve(workspace)) throw new AppError(409, "构建工程目录已失效，请重新选择工程。");
  if (options.state.projectMode === "in-place") {
    if (!options.projectPath || (options.state.category === "game" ? !isWithin(await realpath(options.projectPath), actual) : actual !== await realpath(options.projectPath))) throw new AppError(409, "构建目录与选择的原工程不一致，请重新选择工程。");
  } else {
    const root = await realpath(join(taskDir, "workspace"));
    if (!isWithin(root, actual)) throw new AppError(409, "历史构建工作副本已失效，请重新开始编译。");
  }
  const wrapper = join(workspace, process.platform === "win32" ? "gradlew.bat" : "gradlew");
  const wrapperInfo = await lstat(wrapper).catch(() => void 0);
  if (!wrapperInfo?.isFile() || wrapperInfo.isSymbolicLink()) throw new AppError(400, "工程根目录缺少 Gradle Wrapper，请选择包含 gradlew 的 Android 工程。");
}
async function configure(options, approved) {
  await assertWorkspace(options);
  options.state.logLevel = "info";
  options.onLine("详细构建日志已由 agent 执行器开启（INFO）。", "stdout");
  await writeFile(join(options.taskDir, "gp-build.init.gradle"), initScript, { mode: 384 });
  await writeFile(join(options.taskDir, "gp-build-input.json"), JSON.stringify({ projectDirectory: options.workspace, versionName: options.state.versionName, versionCode: options.state.versionCode, category: options.state.category || "other", approved }), { mode: 384 });
  return ["--no-daemon", "--console=plain", "--no-configuration-cache", "--info", "--init-script", join(options.taskDir, "gp-build.init.gradle")];
}
async function buildEnvironment() {
  if (!process.env.JAVA_HOME && process.platform === "darwin") {
    for (const candidate of ["/Applications/Android Studio.app/Contents/jbr/Contents/Home", "/Applications/Android Studio.app/Contents/jre/Contents/Home"]) {
      if ((await lstat(join(candidate, "bin", "java")).catch(() => void 0))?.isFile()) return { JAVA_HOME: candidate };
    }
  }
  return {};
}
async function gradle(options, flags, task) {
  if (options.signal.aborted) throw new AppError(409, "任务已取消。");
  options.onLine(`Gradle ${task}`, "stdout");
  const launcher = join(options.workspace, "scripts", "gradle-local.sh");
  const launcherInfo = process.platform !== "win32" ? await lstat(launcher).catch(() => void 0) : void 0;
  const useLauncher = launcherInfo?.isFile() && !launcherInfo.isSymbolicLink() && isWithin(options.workspace, await realpath(launcher));
  const command = process.platform === "win32" ? "cmd.exe" : useLauncher ? "/bin/bash" : "/bin/sh";
  const args = process.platform === "win32" ? ["/d", "/c", "gradlew.bat", ...flags, task] : [useLauncher ? launcher : join(options.workspace, "gradlew"), ...flags, task];
  let output = "";
  const startedAt = Date.now();
  let lastOutputAt = startedAt;
  const detailed = createWriteStream(join(options.taskDir, "gradle-detailed.log"), { flags: "a", mode: 384 });
  detailed.on("error", () => {
    try {
      options.onLine("详细日志文件暂时无法写入，继续保留页面构建记录。", "stderr");
    } catch {
    }
  });
  const logFinished = finished(detailed).catch(() => {
  });
  const writeDetailed = (line, stream) => {
    if (!detailed.destroyed) detailed.write(`${(/* @__PURE__ */ new Date()).toISOString()} [${stream}] ${options.redactLog ? options.redactLog(line) : line}
`);
  };
  writeDetailed(`Gradle ${task}`, "stdout");
  const onLine = (line, stream) => {
    lastOutputAt = Date.now();
    writeDetailed(line, stream);
    output = (output + line + "\n").slice(-1e5);
    options.onLine(line, stream);
  };
  const heartbeat = setInterval(() => {
    if (options.signal.aborted) return;
    const seconds = Math.round((Date.now() - startedAt) / 1e3);
    const quiet = Math.round((Date.now() - lastOutputAt) / 1e3);
    if (quiet >= 30) {
      const message = `Gradle ${task} 仍在执行，已运行 ${seconds} 秒，距最近构建输出 ${quiet} 秒；当前结果尚未返回。`;
      writeDetailed(message, "stdout");
      try {
        options.onLine(message, "stdout");
      } catch {
      }
    }
  }, 3e4);
  heartbeat.unref();
  let result;
  try {
    result = await runProcess(command, args, { cwd: options.workspace, env: { ...await buildEnvironment(), ...options.state.game ? { JAVA_HOME: options.state.game.javaHome, ANDROID_HOME: options.state.game.sdkPath, ANDROID_SDK_ROOT: options.state.game.sdkPath } : {}, PARTNER_GP_CONFIG: join(options.taskDir, "gp-build-input.json") }, signal: options.signal, timeoutMs: options.timeoutMs, onLine });
  } catch (error) {
    if (options.signal.aborted) throw error;
    throw new GpBuildFailure(task, `${task} 执行未完成：${error instanceof Error ? error.message : String(error)}`, gradleDiagnostics(output));
  } finally {
    clearInterval(heartbeat);
    detailed.end();
    await logFinished;
  }
  if (options.signal.aborted) throw new AppError(409, "任务已取消。");
  if (result.code !== 0) {
    const runnerFailure = output.includes("PARTNER_GP_RUNNER_ERROR:") || output.split(/\r?\n/).some((line) => /Initialization script/.test(line) && line.includes(join(options.taskDir, "gp-build.init.gradle")));
    throw new GpBuildFailure(task, `${task} 执行失败（退出码 ${result.code}）。`, gradleDiagnostics(output), runnerFailure ? "runner" : "project");
  }
  return result.stdout;
}
async function compileGpBuild(options) {
  const flags = await configure(options, false);
  const output = await gradle(options, flags, "partnerGpInspect");
  const lines = output.split(/\r?\n/).filter((line) => line.startsWith("PARTNER_GP_VARIANTS="));
  let variants;
  try {
    variants = JSON.parse(lines.at(-1).slice("PARTNER_GP_VARIANTS=".length));
  } catch {
    throw new AppError(400, "Gradle 未返回应用的 Release 变体，请检查 Android Gradle Plugin 与工程配置。");
  }
  if (!Array.isArray(variants) || variants.length > 500 || variants.some((item) => !item || !/^:(?:[\w-]+:)*[\w-]*$/.test(item.module) || !/^[A-Za-z][A-Za-z0-9]*$/.test(item.variant) || typeof item.outputDirectory !== "string")) throw new AppError(400, "Gradle 返回的构建变体格式无效。");
  const matches = variants.filter((item) => (!options.state.module || item.module === options.state.module) && (!options.state.variant || item.variant === options.state.variant));
  const production = !options.state.variant && matches.length > 1 && new Set(matches.map((item) => item.module)).size === 1 ? matches.find((item) => item.variant === "productionRelease") : void 0;
  const plan = matches.length === 1 ? matches[0] : production;
  if (!plan) throw new GpInputRequired({ reason: "decision", question: matches.length ? `发现多个 Release 变体，请选择要构建的应用模块和变体：${matches.map((item) => `${item.module} / ${item.variant}`).join("、")}。直接在聊天中告诉我你的选择。` : "没有匹配的 Release 应用变体，请提供正确的应用模块与 Release 变体后继续。" });
  if (production) options.onLine(`GP 默认选择正式构建变体：${plan.module} / ${plan.variant}`, "stdout");
  const prefix = plan.module === ":" ? ":" : `${plan.module}:`, capitalized = plan.variant[0].toUpperCase() + plan.variant.slice(1);
  if (plan.compileTask !== `${prefix}compile${capitalized}Sources` || plan.bundleTask !== `${prefix}bundle${capitalized}` || !isWithin(options.workspace, plan.outputDirectory) || resolve(plan.outputDirectory) === resolve(options.workspace)) throw new AppError(400, "构建任务或 AAB 输出目录无效，输出必须位于所选工程内。");
  if (options.state.category === "game") {
    if (!Array.isArray(plan.nativeTasks) || !plan.nativeTasks.length || plan.nativeTasks.some((task) => !/^:(?:[\w-]+:)*(?:BuildIl2CppTask|buildIl2Cpp)$/.test(task))) throw new GpBuildFailure("IL2CPP 任务检查", "未发现 Unity 原生编译任务（支持 BuildIl2CppTask / buildIl2Cpp）。请检查 unityLibrary 的任务注册；这是任务发现检查，尚未执行原生编译。", "");
    for (const nativeTask of plan.nativeTasks) await gradle(options, flags, nativeTask);
  }
  await gradle(options, flags, plan.compileTask);
  if (options.signal.aborted) throw new AppError(409, "任务已取消。");
  return plan;
}
const fingerprintSkips = /* @__PURE__ */ new Set([".git", ".gradle", ".opencode", ".partner-agent", ".idea", ".kotlin", "build", ".DS_Store"]);
async function gpWorkspaceFingerprint(workspace, signal, additionalInputs = []) {
  const hash = createHash("sha256"), root = await realpath(workspace);
  let visited = 0;
  async function walk(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (signal?.aborted) throw new AppError(409, "任务已取消。");
      if (fingerprintSkips.has(entry.name)) continue;
      if (++visited > 1e5) throw new AppError(400, "工程文件过多，请缩小构建工程范围后重试。");
      const path = join(directory, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink() || await realpath(path) !== path) throw new AppError(409, "构建工程包含符号链接，无法核验本次编译内容。");
      hash.update(JSON.stringify(relative(root, path)) + "\0");
      if (info.isDirectory()) {
        hash.update("directory\0");
        await walk(path);
      } else if (info.isFile()) {
        hash.update(`file:${info.size}\0`);
        for await (const chunk of createReadStream(path)) {
          if (signal?.aborted) throw new AppError(409, "任务已取消。");
          hash.update(chunk);
        }
      } else throw new AppError(409, "构建工程包含不支持的文件，无法核验本次编译内容。");
    }
  }
  await walk(root);
  for (const input of [...new Set(additionalInputs)].sort()) {
    if (signal?.aborted) throw new AppError(409, "任务已取消。");
    const info = await lstat(input).catch((error) => {
      if (error.code === "ENOENT") return void 0;
      throw error;
    });
    if (!info) {
      hash.update("missing-game-input:" + resolve(input) + "\0");
      continue;
    }
    const actual = await realpath(input);
    if (info.isSymbolicLink() || actual !== resolve(input)) throw new AppError(409, "游戏构建输入包含符号链接，无法核验本次编译。");
    hash.update("game-input:" + actual + "\0");
    if (info.isDirectory()) await walk(actual);
    else if (info.isFile()) for await (const chunk of createReadStream(actual)) hash.update(chunk);
    else throw new AppError(409, "游戏构建输入已失效，请重新编译。");
  }
  return hash.digest("hex");
}
async function validateAab(path) {
  const file = await open(path, "r");
  try {
    const size = (await file.stat()).size;
    if (size < 22) throw new Error("empty ZIP");
    const tail = Buffer.alloc(Math.min(size, 65557));
    await file.read(tail, 0, tail.length, size - tail.length);
    let end = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 101010256 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) {
      end = i;
      break;
    }
    if (end < 0) throw new Error("ZIP directory missing");
    const directorySize = tail.readUInt32LE(end + 12), offset = tail.readUInt32LE(end + 16);
    if (directorySize > 16e6 || offset + directorySize > size - tail.length + end) throw new Error("invalid ZIP directory");
    const directory = Buffer.alloc(directorySize);
    await file.read(directory, 0, directory.length, offset);
    const names = /* @__PURE__ */ new Set();
    for (let i = 0; i < directory.length; ) {
      if (i + 46 > directory.length || directory.readUInt32LE(i) !== 33639248) throw new Error("invalid ZIP entry");
      const length = directory.readUInt16LE(i + 28), extra = directory.readUInt16LE(i + 30), comment = directory.readUInt16LE(i + 32);
      const next = i + 46 + length + extra + comment;
      if (next > directory.length) throw new Error("truncated ZIP entry");
      names.add(directory.toString("utf8", i + 46, i + 46 + length));
      i = next;
    }
    if (!names.has("BundleConfig.pb") || !names.has("base/manifest/AndroidManifest.xml")) throw new Error("not an Android App Bundle");
  } catch {
    throw new AppError(400, "输出文件不是有效的 Android App Bundle，未交付 AAB。");
  } finally {
    await file.close();
  }
}
async function packageGpBuild(options) {
  const state = options.state;
  if (!state.compilationId || !state.compiledAt || !state.approvedAt || !state.fingerprint || !state.bundleTask || !state.outputDirectory) throw new AppError(409, "尚未确认本次编译，不能开始打包。");
  if (await gpWorkspaceFingerprint(options.workspace, options.signal, state.game?.fingerprintInputs) !== state.fingerprint) throw new AppError(409, "工程在编译后发生变化，请重新编译并确认。");
  const flags = await configure(options, true), startedAt = Date.now();
  await gradle(options, flags, state.bundleTask);
  if (options.signal.aborted) throw new AppError(409, "任务已取消。");
  const output = await realpath(state.outputDirectory).catch(() => {
    throw new AppError(400, "Gradle 已结束，但没有找到本次 AAB 输出目录。");
  });
  if (!isWithin(options.workspace, output) || output !== resolve(state.outputDirectory)) throw new AppError(400, "AAB 输出目录无效。");
  const files = [];
  for (const entry of await readdir(output, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".aab")) continue;
    const path2 = join(output, entry.name), info = await lstat(path2);
    if (info.nlink === 1 && info.size > 0 && info.mtimeMs >= startedAt - 1e3) files.push(path2);
  }
  if (files.length !== 1) throw new AppError(400, files.length ? "发现多个 AAB 输出，请检查变体配置后重新编译。" : "没有找到本次新生成的 AAB 文件，请查看构建日志。");
  await validateAab(files[0]);
  const delivery = join(options.taskDir, "delivery");
  await mkdir(delivery, { recursive: true, mode: 448 });
  const path = join(delivery, basename(files[0]));
  await copyFile(files[0], path);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { path, sha256: hash.digest("hex") };
}
async function gpSkill(taskDir, category) {
  const main = (await readFile(join(taskDir, "module", "skills", "gp-build", "SKILL.md"), "utf8")).slice(0, 16e3);
  return category === "game" ? main + "\n\n" + (await readFile(join(taskDir, "module", "skills", "gp-build", "references", "unity-game.md"), "utf8")).slice(0, 16e3) : main;
}
export {
  GpBuildFailure,
  compileGpBuild,
  gpBuildParameters,
  gpSkill,
  gpWorkspaceFingerprint,
  packageGpBuild,
  validateAab
};
