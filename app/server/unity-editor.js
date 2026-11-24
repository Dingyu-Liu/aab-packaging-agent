import { access, readFile, readdir, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { runProcess } from "./processes.js";
const versionPattern = /^\d+\.\d+\.\d+[abfp]\d+(?:c\d+)?$/;
function parseUnityProjectVersion(text) {
  const version = /^m_EditorVersion:[\t ]*([^\r\n]*)/m.exec(text)?.[1].trim();
  const recorded = /^m_EditorVersionWithRevision:[\t ]*([^\r\n]*)/m.exec(text)?.[1].trim();
  const revisionRecord = recorded ? /^(\S+)[\t ]+\(([\w.-]+)\)$/.exec(recorded) : void 0;
  const result = { version, revision: revisionRecord?.[2], distribution: "unknown" };
  if (!version || !versionPattern.test(version)) result.versionIssue = "缺少有效的 m_EditorVersion，需核对工程与官方发行记录，不能猜测版本或下载地址。";
  else if (recorded && (!revisionRecord || revisionRecord[1] !== version)) result.versionIssue = "m_EditorVersion 与 m_EditorVersionWithRevision 不一致或格式无法识别，需先核实完整版本与 revision。";
  else result.distribution = /c\d+$/.test(version) ? "china" : "international";
  return result;
}
async function smallFile(file) {
  if ((await stat(file)).size > 512e3) throw new Error("metadata-too-large");
  return readFile(file, "utf8");
}
async function present(directory) {
  try {
    return (await stat(directory)).isDirectory();
  } catch {
    return false;
  }
}
function plistString(xml, key) {
  return new RegExp(`<key>\\s*${key}\\s*</key>\\s*<string>([^<]*)</string>`).exec(xml)?.[1].trim();
}
async function editorMetadata(app, inspectedPaths, scanWarnings) {
  let path = app, resolved = false;
  try {
    path = await realpath(app);
    resolved = true;
    try {
      await access(join(path, "Contents", "MacOS", "Unity"), constants.X_OK);
    } catch (error) {
      if (error.code === "ENOENT" && basename(path) !== "Unity.app") return void 0;
      throw error;
    }
    inspectedPaths.add(path);
    const plist = join(path, "Contents", "Info.plist");
    let version, revision;
    const content = await smallFile(plist);
    if (content.startsWith("bplist")) {
      const result = await runProcess("/usr/bin/plutil", ["-convert", "json", "-o", "-", plist], { timeoutMs: 5e3, maxOutput: 512e3 });
      if (result.code !== 0) throw new Error(`Info.plist 解析失败：${result.stderr.trim() || result.stdout.trim() || result.code}`);
      const data = JSON.parse(result.stdout);
      version = typeof data.CFBundleVersion === "string" ? data.CFBundleVersion.trim() : void 0;
      revision = typeof data.UnityBuildNumber === "string" ? data.UnityBuildNumber.trim() : void 0;
    } else {
      version = plistString(content, "CFBundleVersion");
      revision = plistString(content, "UnityBuildNumber");
    }
    if (!version || !versionPattern.test(version)) {
      scanWarnings.push(`无法识别 Unity 编辑器版本：${path}（Info.plist 的 CFBundleVersion 缺失或无效）`);
      return void 0;
    }
    const moduleDirectories = { ios: [], android: [] };
    for (const [platform, module] of [["ios", "iOSSupport"], ["android", "AndroidPlayer"]]) {
      for (const folder of [join(path, "Contents", "PlaybackEngines", module), join(dirname(path), "PlaybackEngines", module)]) {
        if (await present(folder)) moduleDirectories[platform].push(folder);
      }
    }
    return { path, version, ...revision ? { revision } : {}, moduleDirectories };
  } catch (error) {
    const code = error.code;
    if (resolved || code !== "ENOENT") {
      inspectedPaths.add(path);
      const reason = code === "EACCES" || code === "EPERM" ? "没有读取或执行权限" : code === "ENOENT" ? "缺少编辑器可执行文件或 Info.plist，安装可能未完成" : error instanceof Error ? error.message.slice(0, 500) : "读取失败";
      scanWarnings.push(`无法检查 Unity 编辑器：${path}（${reason}）`);
    }
    return void 0;
  }
}
function installationPath(value) {
  if (!isAbsolute(value) || value.includes("\0")) return void 0;
  return normalize(value).replace(/\/$/, "") || "/";
}
function collectInstallationPaths(value, collect, depth = 0) {
  if (depth > 8) return;
  if (typeof value === "string") {
    const path = installationPath(value);
    if (path) collect(path);
  } else if (Array.isArray(value)) {
    for (const item of value.slice(0, 200)) collectInstallationPaths(item, collect, depth + 1);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value).slice(0, 200)) {
      const path = installationPath(key);
      if (path) collect(path);
      if (/^(?:location|path|installPath|installLocation|editorPath|secondaryInstallPath)$/i.test(key) || item && typeof item === "object") collectInstallationPaths(item, collect, depth + 1);
    }
  }
}
let registeredCache;
let registeredScan;
async function registeredEditorPaths(refresh = false) {
  if (process.platform !== "darwin") return [];
  if (refresh && registeredScan) await registeredScan;
  if (!refresh && registeredCache && Date.now() - registeredCache.at < 3e4) return registeredCache.paths;
  if (registeredScan) return registeredScan;
  registeredScan = (async () => {
    const paths = /* @__PURE__ */ new Set();
    const results = await Promise.allSettled([
      (async () => {
        for (const cli of [join(homedir(), ".unity/bin/unity"), "/Applications/Unity Hub.app/Contents/Resources/unity"]) {
          try {
            await access(cli, constants.X_OK);
            const result = await runProcess(cli, ["editors", "--installed", "--json", "--non-interactive", "--no-banner", "--no-pager"], { timeoutMs: 2500, maxOutput: 512e3, env: { ELECTRON_RUN_AS_NODE: void 0, NODE_OPTIONS: void 0, NODE_PATH: void 0 } });
            if (!result.code) collectInstallationPaths(JSON.parse(result.stdout), (path) => paths.add(path));
            break;
          } catch {
          }
        }
      })(),
      (async () => {
        const result = await runProcess("/usr/bin/mdfind", ['kMDItemCFBundleIdentifier == "com.unity3d.UnityEditor5.x"'], { timeoutMs: 2500, maxOutput: 128e3 });
        if (!result.code) {
          for (const entry of result.stdout.split("\n")) if (entry.endsWith("/Unity.app") && isAbsolute(entry) && !/\/(?:\.Trash|\.Trashes)\//.test(entry)) paths.add(entry);
        }
      })()
    ]);
    for (const result of results) if (result.status === "rejected") continue;
    const found = [...paths];
    registeredCache = { at: Date.now(), paths: found };
    return found;
  })().finally(() => {
    registeredScan = void 0;
  });
  return registeredScan;
}
async function inspectUnityToolchain(recorded, options = {}) {
  const roots = /* @__PURE__ */ new Set();
  const candidates = /* @__PURE__ */ new Set();
  const inspectedPaths = /* @__PURE__ */ new Set();
  const scanWarnings = [];
  const register = (value) => {
    const path = installationPath(value);
    if (!path) return;
    if (/\.app$/i.test(path)) candidates.add(path);
    else if (/\.app\/Contents\/MacOS\/Unity$/i.test(path)) candidates.add(dirname(dirname(dirname(path))));
    else roots.add(path);
  };
  for (const root of options.installRoots ?? (process.platform === "darwin" ? [
    "/Applications/Unity/Hub/Editor",
    "/Applications/Unity",
    "/Applications",
    join(homedir(), "Applications/Unity/Hub/Editor"),
    join(homedir(), "Applications/Unity"),
    join(homedir(), "Applications")
  ] : [])) register(root);
  for (const path of options.extraEditors ?? []) register(path);
  const hubRoot = join(homedir(), "Library", "Application Support", "UnityHub");
  const hubFiles = options.hubFiles ?? (process.platform === "darwin" ? ["editors-v2.json", "editors.json", "secondaryInstallPath.json"].map((name) => join(hubRoot, name)) : []);
  if (options.installRoots === void 0 && options.hubFiles === void 0) for (const path of await registeredEditorPaths(options.refresh)) register(path);
  const hubReads = await Promise.allSettled(hubFiles.map(async (file) => collectInstallationPaths(JSON.parse(await smallFile(file)), register)));
  for (const [index, result] of hubReads.entries()) {
    if (result.status === "rejected" && result.reason?.code !== "ENOENT") scanWarnings.push(`无法读取 Hub 安装登记：${hubFiles[index]}`);
  }
  const registeredCandidates = [...candidates];
  const rootReads = await Promise.allSettled([...roots].map(async (root) => {
    candidates.add(join(root, "Unity.app"));
    for (const entry of (await readdir(root, { withFileTypes: true })).slice(0, 200)) {
      if (entry.isDirectory() || entry.isSymbolicLink()) candidates.add(/\.app$/i.test(entry.name) ? join(root, entry.name) : join(root, entry.name, "Unity.app"));
    }
  }));
  for (const [index, result] of rootReads.entries()) {
    if (result.status === "rejected" && result.reason?.code !== "ENOENT") scanWarnings.push(`无法扫描安装位置：${[...roots][index]}`);
  }
  const editors = await Promise.all([...candidates].map((app) => editorMetadata(app, inspectedPaths, scanWarnings)));
  const versionCandidates = [...new Map(editors.filter((editor) => Boolean(editor && editor.version === recorded.version)).map((editor) => [editor.path, editor])).values()];
  const matchingEditor = recorded.versionIssue ? void 0 : versionCandidates.find((editor) => !recorded.revision || editor.revision === recorded.revision);
  return { distribution: recorded.distribution, ...recorded.versionIssue ? { versionIssue: recorded.versionIssue } : {}, ...matchingEditor ? { matchingEditor } : {}, versionCandidates, searchedPaths: [.../* @__PURE__ */ new Set([...roots, ...registeredCandidates, ...inspectedPaths])], scanWarnings };
}
function is01Sdk(plugin, profile) {
  return plugin.id !== "gp-build" && (profile.partner === "01" || plugin.id === "01sdk");
}
function sdkUnityPreparationPolicy(plugin, profile, report) {
  if (!is01Sdk(plugin, profile)) return "";
  if (report && report.type !== "unity") return "01 前置检查：当前选择的是原生工程，沿用原生工具链。";
  return `01 Unity 前置流程（优先于通用工具链安装规则）：
1. 读取当前工程 ProjectSettings/ProjectVersion.txt 的完整版本与 revision，保留 c1 等全部后缀。由后端重新扫描本机常用安装目录、Unity Hub 安装登记及自定义安装位置，核对编辑器真实版本和 ${profile.platform} 平台模块，最终通过编辑器 API 验证平台支持。
2. 已有准确版本和可用模块时，使用后端记录的编辑器路径继续接入；不更换国内/国际发行版，不去掉 c1 后缀，不升级工程。
3. 缺少编辑器或模块时，由用户自行下载并安装。必须明确告知完整版本、revision、发行版和所需平台模块，等待用户点击“已安装，确认并重新扫描”；用户确认不能代替实际检查，重新扫描及平台验证通过后才继续。
4. 01 流程不自动下载或安装 Unity 编辑器及平台模块，不使用或控制 VPN/代理。下载、安装和许可证激活由用户完成；不得把 Unity 缺项当作已授权的自动依赖安装。普通 SDK 依赖仍按任务要求处理。
5. 后端前置状态未 ready 时不能修改 SDK 工程或声称可构建；版本记录矛盾、许可证或系统授权问题说明具体原因，等待用户处理后重新扫描。`;
}
export {
  inspectUnityToolchain,
  is01Sdk,
  parseUnityProjectVersion,
  sdkUnityPreparationPolicy
};
