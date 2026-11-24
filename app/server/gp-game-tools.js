import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, readdir, cp, chmod, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { AppError } from "./errors.js";
import { GpInputRequired } from "./gp-agent.js";
import { runProcess } from "./processes.js";
import { PackageLock } from "./package-lock.js";
import { extractGameZip } from "./gp-game-resources.js";
import { GAME_ANDROID, javaProperty } from "./gp-game-gradle.js";
const sdkLocks = /* @__PURE__ */ new Map();
const javaLock = new PackageLock();
function gameHostArchitecture(platform = process.platform, arch = process.arch) {
  if (platform !== "darwin" || !["x64", "arm64"].includes(arch)) throw new GpInputRequired({ reason: "environment", question: "游戏模板需要在 Intel 或 Apple 芯片 Mac 上执行。", details: `当前环境：${platform}/${arch}` });
  return { java: arch === "arm64" ? "aarch64" : "x64", label: arch === "arm64" ? "Apple 芯片 Mac" : "Intel Mac", requiresRosetta: arch === "arm64" };
}
function selectMacCommandLineTools(entry, arch = process.arch) {
  const archives = (entry.match(/<archive>[\s\S]*?<\/archive>/g) || []).filter((value) => /<host-os>macosx<\/host-os>/.test(value));
  const variants = arch === "arm64" ? ["_(?:arm64|aarch64)", "", "_x86_64"] : ["_x86_64", ""];
  for (const variant of variants) {
    const archive = archives.find((value) => new RegExp(`<url>commandlinetools-mac${variant}-`).test(value));
    if (archive) return archive;
  }
}
function cancellable(work, signal) {
  return new Promise((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener("abort", aborted);
      reject(new AppError(409, "任务已取消。"));
    };
    work.then((value) => {
      signal.removeEventListener("abort", aborted);
      resolve(value);
    }, (error) => {
      signal.removeEventListener("abort", aborted);
      reject(error);
    });
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}
const available = async (path) => (await stat(path).catch(() => void 0))?.isFile() === true;
const read = (path) => readFile(path, "utf8").catch(() => "");
async function remote(url, signal, limit = 8 * 1024 * 1024) {
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(10 * 6e4)]) });
  if (!response.ok) throw new AppError(400, `工具链下载失败：HTTP ${response.status}（${new URL(url).hostname}）。`);
  const chunks = [];
  let size = 0;
  if (!response.body) throw new AppError(400, "工具链下载没有返回内容。");
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) {
      await response.body.cancel().catch(() => {
      });
      throw new AppError(400, "工具链下载超过大小上限。");
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}
async function download(url, path, signal, checksum) {
  const data = await remote(url, signal, 256 * 1024 * 1024);
  if (checksum && createHash(checksum.algorithm).update(data).digest("hex") !== checksum.value.toLowerCase()) throw new AppError(400, "工具链下载校验失败。");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data, { mode: 384 });
}
async function javaVersion(home, signal) {
  if (!await available(join(home, "bin", "java"))) return false;
  const result = await runProcess(join(home, "bin", "java"), ["-XshowSettings:properties", "-version"], { signal, timeoutMs: 15e3 }).catch(() => void 0);
  const version = /version\s+"(\d+)/.exec(`${result?.stderr}
${result?.stdout}`)?.[1];
  const architecture = /os\.arch\s*=\s*(\S+)/.exec(`${result?.stderr}
${result?.stdout}`)?.[1];
  return result?.code === 0 && Number(version) >= 17 && Number(version) <= 21 && (process.arch !== "arm64" || ["aarch64", "arm64"].includes(architecture || ""));
}
async function ensureJava(options) {
  const host = gameHostArchitecture();
  const managed = join(homedir(), "Library", "Application Support", "PartnerAgent", "toolchains", process.arch === "arm64" ? "jdk-17-arm64" : "jdk-17");
  const candidates = [process.env.JAVA_HOME, "/Applications/Android Studio.app/Contents/jbr/Contents/Home", join(managed, "Contents", "Home")];
  for (const candidate of candidates) if (candidate && await javaVersion(candidate, options.signal)) return candidate;
  const detected = await runProcess("/usr/libexec/java_home", ["-a", process.arch === "arm64" ? "arm64" : "x86_64", "-v", "17"], { signal: options.signal, timeoutMs: 15e3 }).catch(() => void 0);
  if (detected?.code === 0 && await javaVersion(detected.stdout.trim(), options.signal)) return detected.stdout.trim();
  options.onLine(`未找到可用 JDK，正在安装 ${host.label} JDK 17。`, "stdout");
  const stage = join(options.taskDir, "tool-downloads", "jdk");
  const releases = JSON.parse((await remote(`https://api.adoptium.net/v3/assets/latest/17/hotspot?architecture=${host.java}&image_type=jdk&os=mac&vendor=eclipse`, options.signal)).toString("utf8"));
  const archive = releases?.[0]?.binary?.package;
  if (typeof archive?.link !== "string" || !archive.link.startsWith("https://") || !/^[a-f0-9]{64}$/.test(archive.checksum || "")) throw new AppError(400, "JDK 官方下载元数据无效。");
  await mkdir(stage, { recursive: true });
  await download(archive.link, join(stage, "jdk.tar.gz"), options.signal, { algorithm: "sha256", value: archive.checksum });
  const unpacked = join(stage, "unpacked");
  await mkdir(unpacked, { recursive: true });
  const result = await runProcess("/usr/bin/tar", ["-xzf", join(stage, "jdk.tar.gz"), "-C", unpacked], { signal: options.signal, timeoutMs: options.timeoutMs });
  if (result.code !== 0) throw new AppError(400, "JDK 解压失败。");
  let directory;
  for (const name of await readdir(unpacked)) if (await available(join(unpacked, name, "Contents", "Home", "bin", "java"))) {
    directory = name;
    break;
  }
  if (!directory || !await javaVersion(join(unpacked, directory, "Contents", "Home"), options.signal)) throw new AppError(400, "下载的 JDK 不可用。");
  await mkdir(dirname(managed), { recursive: true });
  if (!await javaVersion(join(managed, "Contents", "Home"), options.signal)) {
    await rm(managed, { recursive: true, force: true });
    await cp(join(unpacked, directory), managed, { recursive: true });
  }
  return join(managed, "Contents", "Home");
}
async function sdkManager(sdk, options) {
  for (const version of ["latest", ...await readdir(join(sdk, "cmdline-tools")).catch(() => [])]) {
    const path2 = join(sdk, "cmdline-tools", version, "bin", "sdkmanager");
    if (await available(path2)) return path2;
  }
  const legacy = join(sdk, "tools", "bin", "sdkmanager");
  if (await available(legacy)) return legacy;
  options.onLine("正在从 Android 官方安装 Command-line Tools。", "stdout");
  const xml = (await remote("https://dl.google.com/android/repository/repository2-3.xml", options.signal, 16 * 1024 * 1024)).toString("utf8");
  const entry = /<remotePackage\b[^>]*\bpath="cmdline-tools;latest"[\s\S]*?<\/remotePackage>/.exec(xml)?.[0];
  const archive = selectMacCommandLineTools(entry || "");
  const url = /<url>([^<]+)<\/url>/.exec(archive || "")?.[1], checksum = /<checksum\b[^>]*>([^<]+)<\/checksum>/.exec(archive || "")?.[1];
  if (!url || !/^commandlinetools-mac(?:_(?:x86_64|arm64|aarch64))?-[\w.-]+\.zip$/.test(url) || !/^[a-f0-9]{40}$/i.test(checksum || "")) throw new AppError(400, "Android 官方 Command-line Tools 元数据无效。");
  const stage = join(options.taskDir, "tool-downloads", "android-cli");
  await mkdir(stage, { recursive: true });
  const path = join(stage, "tools.zip");
  await download(`https://dl.google.com/android/repository/${url}`, path, options.signal, { algorithm: "sha1", value: checksum });
  await extractGameZip(await readFile(path), stage, options.signal);
  const destination = join(sdk, "cmdline-tools", "latest");
  await mkdir(destination, { recursive: true });
  await cp(join(stage, "cmdline-tools"), destination, { recursive: true });
  return join(destination, "bin", "sdkmanager");
}
async function installed(sdk) {
  const ndk = await read(join(sdk, "ndk", GAME_ANDROID.ndk, "source.properties"));
  return javaProperty(ndk, "Pkg.Revision") === GAME_ANDROID.ndk && await available(join(sdk, "ndk", GAME_ANDROID.ndk, "toolchains", "llvm", "prebuilt", "darwin-x86_64", "bin", "clang")) && await available(join(sdk, "build-tools", GAME_ANDROID.buildTools, "aapt2")) && await available(join(sdk, "platforms", `android-${GAME_ANDROID.compileSdk}`, "android.jar"));
}
async function ensureGameTools(options) {
  const host = gameHostArchitecture();
  if (host.requiresRosetta) {
    const probe = await runProcess("/usr/bin/arch", ["-x86_64", "/usr/bin/true"], { signal: options.signal, timeoutMs: 15e3 }).catch(() => void 0);
    if (options.signal.aborted) throw new AppError(409, "任务已取消。");
    if (probe?.code !== 0) throw new GpInputRequired({ reason: "environment", question: "内置 Unity IL2CPP 工具需要 Rosetta 2。请先在终端运行 softwareupdate --install-rosetta，按提示安装后继续。", details: "桌面 App 和 JDK 使用原生 arm64；当前游戏模板内置的 IL2CPP deploy 为 x86_64。" });
    options.onLine("已确认 Rosetta 2 可运行内置 Intel IL2CPP 工具，JDK 使用 Apple 芯片版本。", "stdout");
  }
  try {
    const javaHome = await cancellable(javaLock.withWriteLock(() => ensureJava(options)), options.signal);
    const configured = javaProperty(await read(join(options.workspace, "local.properties")), "sdk.dir");
    const sdkPath = [process.env.ANDROID_SDK_ROOT, process.env.ANDROID_HOME, configured].find((value) => value && isAbsolute(value)) || join(homedir(), "Library", "Android", "sdk");
    let lock = sdkLocks.get(sdkPath);
    if (!lock) {
      lock = new PackageLock();
      sdkLocks.set(sdkPath, lock);
    }
    await cancellable(lock.withWriteLock(async () => {
      if (options.signal.aborted) throw new AppError(409, "任务已取消。");
      if (await installed(sdkPath)) return;
      await mkdir(sdkPath, { recursive: true });
      const manager = await sdkManager(sdkPath, options);
      const base = { signal: options.signal, timeoutMs: options.timeoutMs, env: { JAVA_HOME: javaHome }, onLine: options.onLine };
      options.onLine("正在接受 Android SDK 许可证并安装 Platform 36、Build Tools 36.1.0、NDK 29.0.14206865。", "stdout");
      const licenses = await runProcess("/bin/sh", [manager, `--sdk_root=${sdkPath}`, "--licenses"], { ...base, input: "y\n".repeat(200) });
      if (licenses.code !== 0) throw new AppError(400, "Android SDK 许可证处理失败，请查看工具链日志。");
      const packages = await runProcess("/bin/sh", [manager, `--sdk_root=${sdkPath}`, "platform-tools", `platforms;android-${GAME_ANDROID.compileSdk}`, `build-tools;${GAME_ANDROID.buildTools}`, `ndk;${GAME_ANDROID.ndk}`], base);
      if (packages.code !== 0 || !await installed(sdkPath)) throw new AppError(400, "Android 工具链安装未完成，请查看 sdkmanager 的实际日志。");
    }), options.signal);
    return { sdkPath, ndkPath: join(sdkPath, "ndk", GAME_ANDROID.ndk), javaHome };
  } catch (error) {
    if (options.signal.aborted || error instanceof GpInputRequired) throw error;
    throw new GpInputRequired({ reason: "environment", question: `工具链自动准备未完成：${error instanceof Error ? error.message : String(error)} 请恢复下载网络或处理日志中的环境条件后继续。` });
  }
}
async function ensureGameWrapper(options) {
  const wrapper = join(options.workspace, "gradlew"), jar = join(options.workspace, "gradle", "wrapper", "gradle-wrapper.jar");
  const script = await read(wrapper);
  if (script && (!script.includes("GradleWrapperMain") || await available(jar))) {
    await chmod(wrapper, 493);
    return;
  }
  const properties = await read(join(options.workspace, "gradle", "wrapper", "gradle-wrapper.properties"));
  const version = /gradle-([0-9]+\.[0-9]+(?:\.[0-9]+)?)-(?:bin|all)\.zip/.exec(javaProperty(properties, "distributionUrl") || "")?.[1];
  if (!version) throw new AppError(400, "缺少 Gradle Wrapper，且无法从 gradle-wrapper.properties 识别版本，需要修复工程的 Gradle 配置。");
  options.onLine(`正在补齐工程声明的 Gradle ${version} Wrapper。`, "stdout");
  const tag = version.split(".").length === 2 ? `${version}.0` : version;
  const source = `https://raw.githubusercontent.com/gradle/gradle/v${tag}`;
  async function gradleFile(path) {
    try {
      const json = JSON.parse((await remote(`https://api.github.com/repos/gradle/gradle/contents/${path}?ref=v${tag}`, options.signal)).toString("utf8"));
      if (json.type !== "file" || json.encoding !== "base64" || typeof json.content !== "string") throw new AppError(400, "Gradle 官方文件元数据无效。");
      return Buffer.from(json.content.replace(/\s/g, ""), "base64");
    } catch (error) {
      if (options.signal.aborted) throw error;
      return remote(`${source}/${path}`, options.signal);
    }
  }
  if (!await available(jar)) {
    const checksum = (await remote(`https://services.gradle.org/distributions/gradle-${version}-wrapper.jar.sha256`, options.signal)).toString("utf8").trim();
    if (!/^[a-f0-9]{64}$/i.test(checksum)) throw new AppError(400, "Gradle Wrapper 官方校验值无效。");
    const content = await gradleFile("gradle/wrapper/gradle-wrapper.jar");
    if (createHash("sha256").update(content).digest("hex") !== checksum.toLowerCase()) throw new AppError(400, "Gradle Wrapper 官方文件校验失败。");
    await mkdir(dirname(jar), { recursive: true });
    await writeFile(jar, content);
  }
  if (!script) {
    await writeFile(wrapper, await gradleFile("gradlew"));
    await chmod(wrapper, 493);
  }
}
export {
  ensureGameTools,
  ensureGameWrapper,
  gameHostArchitecture,
  selectMacCommandLineTools
};
