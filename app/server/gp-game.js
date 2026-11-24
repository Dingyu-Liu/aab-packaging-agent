import { cp, mkdir, readFile, readdir, realpath, lstat, writeFile, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { AppError } from "./errors.js";
import { GpInputRequired } from "./gp-agent.js";
import { runProcess } from "./processes.js";
import { isWithin } from "./workspaces.js";
import { GAME_ANDROID, moduleMinSdk, normalizeGameGradle, normalizeGameSettings, setJavaProperty, signingReferences, signingFileName, replaceSigningReference } from "./gp-game-gradle.js";
import { materializeGameResources } from "./gp-game-resources.js";
import { prepareNativeCompatibility, patchNativeGradle } from "./gp-native-compat.js";
import { ensureGameTools, ensureGameWrapper } from "./gp-game-tools.js";
async function scanDelivery(root, signal) {
  const result = { projects: [], gradleFiles: [], keys: [] }, settings = [], files = /* @__PURE__ */ new Set();
  let visited = 0;
  async function walk(directory) {
    if (signal?.aborted) throw new AppError(409, "任务已取消。");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++visited > 5e5) throw new AppError(400, "交付包文件超过扫描上限，请缩小到本次交付包目录。");
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        if (entry.name === "settings.gradle") settings.push(directory);
        if (entry.name === "build.gradle") {
          result.gradleFiles.push(path);
          files.add(path);
        }
        if (/\.(?:jks|keystore)$/i.test(entry.name)) result.keys.push(path);
      }
    }
  }
  await walk(root);
  result.projects = settings.filter((path) => files.has(join(path, "launcher", "build.gradle")) && files.has(join(path, "unityLibrary", "build.gradle")));
  return result;
}
async function findGameProject(delivery, signal) {
  const root = await realpath(delivery), scan = await scanDelivery(root, signal);
  if (scan.projects.includes(root)) return root;
  if (scan.projects.length === 1) return scan.projects[0];
  if (!scan.projects.length) throw new AppError(400, "交付包中没有找到包含 settings.gradle、launcher 和 unityLibrary 的 Unity Android 导出工程。");
  throw new GpInputRequired({ reason: "decision", question: `交付包包含多个游戏工程，请选择本次工程目录：${scan.projects.join("、")}。密钥仍应随本次交付包提供。` });
}
const read = (path) => readFile(path, "utf8").catch(() => "");
async function regular(path) {
  const info = await lstat(path).catch(() => void 0);
  return Boolean(info?.isFile() && !info.isSymbolicLink());
}
async function chooseSigningKey(reference, module, keys, delivery, tools, options) {
  const original = reference.path.replace(/\\/g, "/");
  const resolved = /^[A-Za-z]:/.test(original) ? "" : resolve(module, original);
  if (resolved && isWithin(delivery, resolved) && await regular(resolved)) return resolved;
  const named = keys.filter((path) => signingFileName(path) === signingFileName(original));
  let candidates = named.length ? named : keys;
  if (!candidates.length) throw new GpInputRequired({ reason: "credentials", question: "所选目录内未找到 .jks 或 .keystore。请确认选择的是完整交付包：签名若位于工程上一级，请选择包含工程与签名的父目录；程序不会擅自扫描所选范围外的文件。" });
  if (reference.alias && reference.storePassword !== void 0) {
    const matching = [];
    for (const path of candidates) {
      const result = await runProcess(join(tools.javaHome, "bin", "keytool"), ["-list", "-keystore", path, "-storepass:env", "PARTNER_GP_STORE_PASSWORD", "-alias", reference.alias], { signal: options.signal, timeoutMs: 2e4, env: { JAVA_HOME: tools.javaHome, PARTNER_GP_STORE_PASSWORD: reference.storePassword }, maxOutput: 4096 });
      if (result.code === 0) matching.push(path);
    }
    candidates = matching;
    if (!candidates.length) throw new GpInputRequired({ reason: "credentials", question: "交付包中的签名文件无法通过工程现有密码和 alias 校验，请补充正确的原签名文件或签名配置。" });
  }
  if (candidates.length !== 1) throw new GpInputRequired({ reason: "decision", question: `整个交付包中找到多份可用密钥，无法唯一确定本次签名，请指定：${candidates.map((path) => relative(delivery, path)).join("、")}。` });
  return candidates[0];
}
async function prepareGameBuild(options) {
  options.onLine("扫描整个交付包，识别游戏模块与签名文件。", "stdout");
  const delivery = await realpath(options.deliveryRoot), scan = await scanDelivery(delivery, options.signal);
  if (!scan.projects.includes(options.workspace)) throw new AppError(400, "游戏工程结构已变化，需要恢复 launcher、unityLibrary 和 settings.gradle。");
  const moduleFiles = scan.gradleFiles.filter((path) => isWithin(options.workspace, path) && !relative(options.workspace, path).split("/").some((part) => [".partner-agent", ".gradle", "build", ".git"].includes(part)));
  const texts = /* @__PURE__ */ new Map();
  for (const path of moduleFiles) {
    const text = await readFile(path, "utf8");
    texts.set(path, text);
    for (const reference of signingReferences(text)) {
      options.onSecret(reference.storePassword);
      options.onSecret(reference.keyPassword);
    }
  }
  const tools = await ensureGameTools(options);
  let resources;
  try {
    resources = await materializeGameResources(options.taskDir, options.signal);
  } catch (error) {
    if (options.signal.aborted) throw error;
    throw new GpInputRequired({ reason: "runner", question: `本次冻结的游戏资源无法读取或校验，请恢复 GP打包模块资源后继续：${error instanceof Error ? error.message : String(error)}` });
  }
  const changed = new Set(options.previous?.changedFiles || []), signingFiles = /* @__PURE__ */ new Set();
  const minSdk = Math.max(GAME_ANDROID.minSdk, ...[...texts.values()].map(moduleMinSdk));
  const nativeCompat = await prepareNativeCompatibility({ workspace: options.workspace, ndkPath: tools.ndkPath, minSdk, signal: options.signal });
  async function save(path, value) {
    if (options.signal.aborted) throw new AppError(409, "任务已取消。");
    const old = await read(path);
    if (old === value) return;
    const backup = join(options.workspace, ".partner-agent", "gp-game-originals", relative(options.workspace, path) + ".original");
    await mkdir(dirname(backup), { recursive: true, mode: 448 });
    if (!await regular(backup)) await writeFile(backup, old, { mode: 384 });
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, value);
    changed.add(relative(options.workspace, path));
    options.onLine(`已适配 ${relative(options.workspace, path)}`, "stdout");
  }
  for (const [path, source] of texts) {
    let text = source;
    for (const reference of signingReferences(text).reverse()) {
      const key = await chooseSigningKey(reference, dirname(path), scan.keys, delivery, tools, options);
      signingFiles.add(key);
      text = replaceSigningReference(text, reference, dirname(path), key);
    }
    const primary = ["launcher/build.gradle", "unityLibrary/build.gradle"].includes(relative(options.workspace, path));
    text = normalizeGameGradle(text, { ...options, ndkPath: tools.ndkPath, minSdk, primary });
    if (relative(options.workspace, path) === "unityLibrary/build.gradle") text = patchNativeGradle(text, nativeCompat);
    await save(path, text);
  }
  const settings = join(options.workspace, "settings.gradle");
  await save(settings, normalizeGameSettings(await read(settings), resources.firebase));
  const properties = join(options.workspace, "gradle.properties");
  await save(properties, setJavaProperty(await read(properties), "android.aapt2FromMavenOverride", join(tools.sdkPath, "build-tools", GAME_ANDROID.buildTools, "aapt2"), true));
  const local = join(options.workspace, "local.properties");
  await save(local, setJavaProperty(await read(local), "sdk.dir", tools.sdkPath, true));
  const deploy = join(options.workspace, "unityLibrary", "src", "main", "Il2CppOutputProject", "IL2CPP", "build", "deploy");
  const marker = join(options.workspace, ".partner-agent", "gp-game-deploy.sha256");
  if ((await read(marker)).trim() !== resources.hashes.deploy || !await regular(join(deploy, "il2cpp"))) {
    await mkdir(dirname(deploy), { recursive: true });
    const backup = join(dirname(deploy), "deploy copy");
    const existing = await lstat(deploy).catch(() => void 0);
    if (existing?.isSymbolicLink()) throw new AppError(400, "deploy 不能是符号链接。");
    if (existing && !await lstat(backup).catch(() => void 0)) await cp(deploy, backup, { recursive: true, preserveTimestamps: true });
    const staged = join(dirname(deploy), `deploy.preparing-${crypto.randomUUID()}`), previous = `${staged}.previous`;
    try {
      await cp(resources.deploy, staged, { recursive: true, preserveTimestamps: true });
      if (existing) await rename(deploy, previous);
      try {
        await rename(staged, deploy);
      } catch (error) {
        if (existing) await rename(previous, deploy);
        throw error;
      }
      await rm(previous, { recursive: true, force: true });
    } finally {
      await rm(staged, { recursive: true, force: true });
    }
    await mkdir(dirname(marker), { recursive: true, mode: 448 });
    await writeFile(marker, resources.hashes.deploy, { mode: 384 });
    changed.add(relative(options.workspace, deploy));
    options.onLine("已备份原 deploy，并替换为内置 macOS IL2CPP 工具。", "stdout");
  }
  await ensureGameWrapper(options);
  options.onLine("游戏固定预处理完成：SDK 36 / Build Tools 36.1.0 / NDK 29.0.14206865。", "stdout");
  return { preparedAt: (/* @__PURE__ */ new Date()).toISOString(), sdkPath: tools.sdkPath, ndkPath: tools.ndkPath, javaHome: tools.javaHome, resourceHashes: resources.hashes, changedFiles: [...changed], signingFiles: [...signingFiles], fingerprintInputs: [...signingFiles, deploy, resources.firebase, ...nativeCompat.fingerprintInputs], reviewedAt: options.previous?.reviewedAt };
}
export {
  findGameProject,
  prepareGameBuild
};
