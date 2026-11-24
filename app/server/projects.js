import { lstat, realpath, readFile, access, readdir } from "node:fs/promises";
import { join, basename, isAbsolute } from "node:path";
import { spawn } from "node:child_process";
import { unityEditorInstallationIssue } from "../shared/unity.js";
import { AppError } from "./errors.js";
import { inspectUnityToolchain, parseUnityProjectVersion } from "./unity-editor.js";
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
async function canonicalDirectory(input) {
  if (typeof input !== "string" || !input.trim() || !isAbsolute(input) || input.includes("\0")) throw new AppError(400, "请选择一个有效的绝对项目路径。");
  let path;
  try {
    path = await realpath(input.trim());
  } catch {
    throw new AppError(400, "项目目录不存在或无法访问。");
  }
  if (!(await lstat(path)).isDirectory()) throw new AppError(400, "项目路径必须是目录。");
  return path;
}
async function readSmall(path) {
  try {
    if ((await lstat(path)).size > 2e6) return "";
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}
async function inspectProject(input, options = {}) {
  const path = await canonicalDirectory(input);
  const unity = await exists(join(path, "ProjectSettings", "ProjectVersion.txt"));
  const gradleFiles = ["settings.gradle", "settings.gradle.kts", "build.gradle", "build.gradle.kts", "gradlew", "app/build.gradle", "app/build.gradle.kts", "launcher/build.gradle", "unityLibrary/build.gradle"];
  const buildFiles = [];
  for (const file of gradleFiles) if (await exists(join(path, file))) buildFiles.push(file);
  const xcodeFiles = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/\.(?:xcodeproj|xcworkspace)$/.test(entry.name)) continue;
    const marker = entry.name.endsWith(".xcodeproj") ? "project.pbxproj" : "contents.xcworkspacedata";
    if (await exists(join(path, entry.name, marker))) xcodeFiles.push(`${entry.name}/${marker}`);
  }
  const type = unity ? "unity" : xcodeFiles.length ? "xcode" : buildFiles.length ? "android" : "unknown";
  if (type === "xcode") buildFiles.push(...xcodeFiles);
  const report = { path, exists: true, name: basename(path), type, buildFiles, checks: [], scannedAt: (/* @__PURE__ */ new Date()).toISOString() };
  report.checks.push({ label: "项目目录", status: "pass", detail: path });
  if (unity) {
    const version = await readSmall(join(path, "ProjectSettings", "ProjectVersion.txt"));
    const recorded = parseUnityProjectVersion(version);
    report.unityVersion = recorded.version;
    report.unityRevision = recorded.revision;
    report.unityDistribution = recorded.distribution;
    if (options.unityToolchain) {
      report.unityToolchain = await inspectUnityToolchain(recorded, { refresh: options.refreshUnityToolchain });
      const editor = report.unityToolchain.matchingEditor;
      report.checks.push({ label: "匹配的 Unity 编辑器", status: editor ? "pass" : "warn", detail: editor ? `${editor.path}；接入前仍需验证平台模块可用性` : recorded.versionIssue || unityEditorInstallationIssue(report.unityToolchain) });
    }
    if (recorded.versionIssue) report.checks.push({ label: "Unity 版本记录", status: "warn", detail: recorded.versionIssue });
    const settings = await readSmall(join(path, "ProjectSettings", "ProjectSettings.asset"));
    const rawOrientation = /\bdefaultScreenOrientation:\s*(\S+)/.exec(settings)?.[1];
    const switches = [...settings.matchAll(/\b(allowedAutorotateTo\w+):\s*(\S+)/g)].map((match) => `${match[1]}=${match[2]}`);
    report.orientation = rawOrientation ? `defaultScreenOrientation=${rawOrientation}${switches.length ? "；" + switches.join("，") : ""}` : "未读取到原始方向，接入时需检查 Player Settings";
    report.checks.push({ label: "Unity 工程", status: "pass", detail: report.unityVersion ? `编辑器版本 ${report.unityVersion}` : "已发现 ProjectSettings" });
    for (const folder of ["Assets", "Packages", "ProjectSettings"]) report.checks.push({ label: folder, status: await exists(join(path, folder)) ? "pass" : "warn", detail: await exists(join(path, folder)) ? "目录已找到" : "目录缺失，请核对工程完整性" });
    report.checks.push({ label: "原始游戏方向", status: rawOrientation ? "pass" : "warn", detail: report.orientation });
    const packages = await readSmall(join(path, "Packages", "manifest.json"));
    const providers = ["appsflyer", "adjust", "facebook"].filter((name) => packages.toLowerCase().includes(name));
    if (providers.length) report.checks.push({ label: "包清单中的 SDK", status: "pass", detail: providers.join("、") });
    report.checks.push({ label: "构建环境", status: "warn", detail: "本次仅检查工程文件；实际构建还需匹配的 Unity、平台模块和签名配置。" });
  } else if (type === "xcode") {
    report.checks.push({ label: "Xcode 工程", status: "pass", detail: xcodeFiles.join("、") });
    for (const file of ["Podfile", "Podfile.lock", "Package.swift"]) if (await exists(join(path, file))) report.buildFiles.push(file);
    report.checks.push({ label: "构建环境", status: "warn", detail: "已识别原生 iOS 工程；接入时由 AI 检查 Xcode、依赖与签名配置。" });
  } else if (type === "android") {
    report.checks.push({ label: "Android / Gradle 工程", status: "pass", detail: buildFiles.join("、") });
    let deps = "";
    for (const file of buildFiles.filter((file2) => file2.endsWith(".gradle") || file2.endsWith(".kts"))) deps += await readSmall(join(path, file));
    const found = [...new Set(deps.match(/com\.(?:pakit|appsflyer|adjust|google\.android\.gms)[^\s"']*/g) || [])];
    if (found.length) report.checks.push({ label: "已有 SDK 依赖", status: "pass", detail: found.join("、") });
    report.checks.push({ label: "构建环境", status: "warn", detail: "工程可识别；JDK、Android SDK 和签名需在执行阶段验证。" });
  } else report.checks.push({ label: "工程类型", status: "fail", detail: "未发现 Unity、Xcode 或 Android Gradle 配置，请选择包含 ProjectSettings、.xcodeproj / .xcworkspace 或 Gradle 配置的工程根目录。" });
  return report;
}
async function directoryDialog(kind) {
  if (process.platform !== "darwin") throw new AppError(400, "当前系统请直接输入本地绝对路径。");
  const expression = kind === "directory" ? 'POSIX path of (choose folder with prompt "选择项目目录")' : 'POSIX path of (choose file with prompt "选择同步脚本")';
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/osascript", ["-e", expression], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (chunk) => out += chunk);
    child.stderr.on("data", (chunk) => err += chunk);
    const timer = setTimeout(() => child.kill("SIGTERM"), 12e4);
    child.on("error", () => {
      clearTimeout(timer);
      reject(new AppError(400, "无法打开目录选择器，请直接输入路径。"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ path: out.trim(), cancelled: false });
      else if (err.includes("-128") || code === null) resolve({ path: null, cancelled: true });
      else reject(new AppError(400, "目录选择器不可用，请直接输入路径。"));
    });
  });
}
export {
  canonicalDirectory,
  directoryDialog,
  exists,
  inspectProject
};
