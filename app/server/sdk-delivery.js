import { access, chmod, copyFile, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, relative, isAbsolute } from "node:path";
import { isWithin } from "./workspaces.js";
import { runProcess } from "./processes.js";
import { UnityConfigurationRequired } from "./errors.js";
class DeliveryRepairRequired extends Error {
}
const sdkDeliveryFiles = ["01SDK最终交付.zip", "最终Unity工程.zip", "最终Xcode工程.zip", "一键安装测试包.command", "install-ios-test.py", "delivery-config.json", "交付说明.md", "delivery-report.json", "installation-result.json", "archive-manifest.json"];
class SdkDelivery {
  constructor(appRoot, options = {}) {
    this.appRoot = appRoot;
    this.options = options;
  }
  appRoot;
  options;
  async complete(input) {
    let state = { workflowVersion: 1, status: "preparing", unityProjectPath: input.workspace, installStatus: "not_attempted", detail: "检查最终 Unity、Xcode 工程和安装交付内容。", updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
    const update = (status, detail) => {
      state = { ...state, status, detail, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
      input.update(state);
    };
    const directory = join(input.taskDirectory, "delivery");
    state.deliveryDirectory = directory;
    update("preparing", state.detail);
    try {
      for (const folder of ["Assets", "Packages", "ProjectSettings"]) if (!await exists(join(input.workspace, folder))) throw new UnityConfigurationRequired("01 最终交付需要 Unity 源工程和 Xcode 工程。当前缺少 Unity 源工程，请提供包含 Assets、Packages、ProjectSettings 的完整工程后继续。");
      let metadata = {}, xcode = "", facts;
      for (; ; ) {
        input.signal.throwIfAborted();
        try {
          try {
            metadata = JSON.parse(await readFile(join(input.workspace, ".partner-agent", "delivery.json"), "utf8"));
          } catch {
            metadata = {};
          }
          if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || ["xcodeProjectPath", "scheme", "applicationTarget", "testBundleIdentifier", "installRequestId", "developmentTeam"].some((key) => metadata[key] !== void 0 && typeof metadata[key] !== "string") || metadata.autoInstall !== void 0 && typeof metadata.autoInstall !== "boolean") throw new DeliveryRepairRequired("交付清单字段格式无效，请按当前实际工程重新写入 delivery.json。");
          xcode = await locateXcode(input.workspace, metadata.xcodeProjectPath);
          facts = await (this.options.inspectXcode ?? inspectXcodeDelivery)(xcode, metadata, input.signal);
          if (await exists(join(xcode, "Podfile")) && (!await exists(join(xcode, "Podfile.lock")) || !facts.workspaceFile)) throw new DeliveryRepairRequired("Xcode 工程存在 Podfile，但尚未交付已解析的 Pods、Podfile.lock 和 workspace。请完成实际依赖安装后再交付。");
          break;
        } catch (error) {
          if (!(error instanceof DeliveryRepairRequired)) throw error;
          update("exporting", error.message);
          const result = await input.repair(error.message);
          if (result.outcome === "needs_user") throw new UnityConfigurationRequired(result.message);
        }
      }
      const production = facts.productionBundleIdentifier, test = metadata.testBundleIdentifier ?? production + ".sdktest";
      if (!bundleId(test) || production === test) throw new UnityConfigurationRequired("请使用与正式应用不同的有效测试 Bundle ID，并在交付配置中记录。");
      state = { ...state, xcodeProjectPath: xcode, productionBundleIdentifier: production, testBundleIdentifier: test };
      const fingerprint = await deliveryFingerprint(input.workspace, xcode, metadata);
      const cached = input.previous?.fingerprint === fingerprint && await exists(join(directory, "archive-manifest.json")) && await exists(join(directory, "最终Unity工程.zip")) && await exists(join(directory, "最终Xcode工程.zip"));
      await mkdir(directory, { recursive: true });
      await copyFile(join(this.appRoot, "server", "install-ios-test.py"), join(directory, "install-ios-test.py"));
      await writeFile(join(directory, "一键安装测试包.command"), '#!/bin/zsh\nset -eu\nSCRIPT_DIR="${0:A:h}"\ncd "$SCRIPT_DIR"\n/usr/bin/python3 "$SCRIPT_DIR/install-ios-test.py" "$@"\n', { mode: 493 });
      await chmod(join(directory, "一键安装测试包.command"), 493);
      if (!cached) {
        update("packaging", "生成最终 Unity 与 Xcode 工程 ZIP，并验证文件清单和 CRC。");
        if (this.options.packageProjects) await this.options.packageProjects(input.workspace, xcode, directory, input.signal);
        else {
          const result = await runProcess("/usr/bin/python3", [join(this.appRoot, "server", "sdk-delivery-files.py"), "--unity", input.workspace, "--xcode", xcode, "--out", directory], { signal: input.signal, timeoutMs: 18e5, onLine: (line) => update("packaging", line) });
          if (result.code) throw new DeliveryRepairRequired("交付归档未通过完整性检查：" + result.stderr.slice(-1800));
        }
      }
      const archives = JSON.parse(await readFile(join(directory, "archive-manifest.json"), "utf8"));
      await writeFile(join(directory, "delivery-config.json"), JSON.stringify({ schemaVersion: 1, ...facts, testBundleIdentifier: test, ...metadata.developmentTeam ? { explicitDevelopmentTeam: metadata.developmentTeam } : {}, xcodeArchiveSha256: archives.xcode.sha256 }, null, 2) + "\n");
      await writeFile(join(directory, "交付说明.md"), `# 01 SDK 最终交付

正式包名：\`${production}\`

测试包名：\`${test}\`

- 最终Unity工程.zip：本次 SDK 接入后的 Unity 源工程，保留 Assets、Packages、ProjectSettings 和 .meta；打开工程后由 Unity 恢复依赖。
- 最终Xcode工程.zip：本次从最终工程导出的 Xcode 工程与依赖。
- 双击「一键安装测试包.command」：自动寻找并确认可达的已配对设备，在独立副本中使用测试包名构建、签名并安装。正式 Unity/Xcode 包名保持原值。
- 无手机时保留脚本，连接、解锁并信任电脑后重试；需要 Xcode 和可用的 Apple Development 签名身份。
- 多设备或多团队时可在终端传入 --device 与 --team。
- 安装脚本、Python 文件、delivery-config.json 和最终Xcode工程.zip 放在同一目录；下载「01SDK最终交付.zip」后整体解压即可。
- installation-result.json 按本次运行记录构建、签名、安装状态；安装成功不代表已验证启动画面、SDK 后台收数或归因。
`);
      if (metadata.autoInstall === false) state.installationMessage = "本次已明确关闭自动安装，已交付一键安装脚本。";
      else if (cached && input.previous?.installStatus === "installed") {
        state.installStatus = "installed";
        state.installationMessage = input.previous.installationMessage;
      } else {
        update("installing", "工程已归档，正在检查连接设备并尝试测试包安装。");
        const progress = (line) => update("installing", line);
        let installed;
        if (this.options.install) installed = await this.options.install(join(directory, "install-ios-test.py"), xcode, directory, input.signal, progress);
        else {
          const runId = randomUUID(), resultFile = join(directory, "installation-result.json");
          await rm(resultFile, { force: true });
          const result = await runProcess("/usr/bin/python3", [join(directory, "install-ios-test.py"), "--project", xcode, "--non-interactive", "--run-id", runId, "--json-result", resultFile], { signal: input.signal, timeoutMs: 24e5, onLine: progress });
          let receipt;
          try {
            receipt = JSON.parse(await readFile(resultFile, "utf8"));
          } catch {
            throw new UnityConfigurationRequired("安装脚本未留下可核对的本次结果，请检查交付目录中的安装日志。");
          }
          if (receipt.runId !== runId || receipt.testBundleIdentifier !== test) throw new UnityConfigurationRequired("安装回包不属于本次运行或测试包名，未标记安装成功。");
          installed = receipt;
          if (result.code === 0 !== (installed.status === "installed") || installed.status === "no_device" && result.code !== 2 || installed.status === "repair_required" && result.code !== 4) throw new UnityConfigurationRequired("安装进程与本次结果不一致，未标记安装成功。");
        }
        if (installed.status === "repair_required") throw new DeliveryRepairRequired((installed.error || "测试构建需要修复。") + ` 实际日志位于 ${directory} 下的 install-*.log，请读取本次 installation-result.json 指向的日志。`);
        state.installStatus = installed.status === "installed" && installed.installed ? "installed" : installed.status === "no_device" ? "no_device" : "needs_user";
        state.installationMessage = state.installStatus === "installed" ? `测试包 ${test} 已安装；启动和后台收数请分别验收。` : installed.error || "安装需要补充设备或签名条件。";
      }
      state.fingerprint = fingerprint;
      update(state.installStatus === "needs_user" ? "needs_configuration" : "ready", state.installStatus === "needs_user" ? state.installationMessage : "Unity、Xcode 工程与一键安装脚本已交付。");
      await writeFile(join(directory, "delivery-report.json"), JSON.stringify(state, null, 2) + "\n");
      if (this.options.bundle) await this.options.bundle(directory, input.signal);
      else {
        const result = await runProcess("/usr/bin/python3", [join(this.appRoot, "server", "sdk-delivery-files.py"), "--out", directory, "--bundle"], { signal: input.signal, timeoutMs: 18e5 });
        if (result.code) throw new UnityConfigurationRequired("最终交付包生成失败，请检查交付目录中的独立工程与脚本。");
      }
      if (state.installStatus === "needs_user") throw new UnityConfigurationRequired(state.installationMessage);
      return state;
    } catch (error) {
      if (!input.signal.aborted && error instanceof DeliveryRepairRequired) {
        update("exporting", error.message);
        const repaired = await input.repair(error.message);
        if (repaired.outcome === "ready") return this.complete({ ...input, previous: void 0 });
        update("needs_configuration", repaired.message);
        throw new UnityConfigurationRequired(repaired.message);
      }
      update(input.signal.aborted ? "cancelled" : error instanceof UnityConfigurationRequired ? "needs_configuration" : "failed", error instanceof Error ? error.message : "最终交付未完成。");
      throw error;
    }
  }
}
function bundleId(value) {
  return typeof value === "string" && value.length <= 255 && /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(value);
}
async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
async function locateXcode(workspace, requested) {
  const root = await realpath(workspace);
  if (requested) {
    let path;
    try {
      path = await realpath(isAbsolute(requested) ? requested : join(root, requested));
    } catch {
      throw new DeliveryRepairRequired("交付配置中的 Xcode 工程目录不存在，请完成真实 Unity iOS 导出。");
    }
    if (!isWithin(root, path) || path === root) throw new DeliveryRepairRequired("Xcode 工程必须是当前工程副本内独立、完整的导出目录。");
    if (!(await readdir(path)).some((name) => name.endsWith(".xcodeproj"))) throw new DeliveryRepairRequired("所选目录没有 Xcode 工程，请实际导出而非仅创建目录。");
    return path;
  }
  const found = [];
  async function visit(directory, depth) {
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.some((entry) => entry.isDirectory() && entry.name.endsWith(".xcodeproj"))) {
      if (directory !== root) found.push(directory);
      return;
    }
    if (depth >= 3) return;
    for (const entry of entries) if (entry.isDirectory() && !["Assets", "Library", "Packages", "ProjectSettings", "Temp", ".git", ".opencode", ".partner-agent", "Pods"].includes(entry.name)) await visit(join(directory, entry.name), depth + 1);
  }
  await visit(root, 0);
  if (found.length !== 1) throw new DeliveryRepairRequired("需要交付实际的最终 Xcode 工程，并在 .partner-agent/delivery.json 中记录 xcodeProjectPath、scheme 和 applicationTarget。");
  return found[0];
}
async function inspectXcodeDelivery(directory, metadata, signal) {
  const names = await readdir(directory), projects = names.filter((name) => name.endsWith(".xcodeproj"));
  if (projects.length !== 1) throw new DeliveryRepairRequired("Xcode 导出根目录需要唯一主工程，或先整理完整导出目录。");
  const workspaces = names.filter((name) => name.endsWith(".xcworkspace"));
  const workspace = workspaces.length === 1 ? workspaces[0] : void 0;
  const developer = "/Applications/Xcode.app/Contents/Developer";
  const env = process.env.DEVELOPER_DIR || !await exists(developer) ? {} : { DEVELOPER_DIR: developer };
  const container = workspace ?? projects[0], flag = workspace ? "-workspace" : "-project";
  const listed = await runProcess("/usr/bin/xcrun", ["xcodebuild", flag, join(directory, container), "-list", "-json"], { signal, env, timeoutMs: 6e4 });
  if (listed.code) throw new DeliveryRepairRequired("最终 Xcode 工程无法列出方案，请修复实际导出与依赖：" + listed.stderr.slice(-2e3));
  let info;
  try {
    info = JSON.parse(listed.stdout);
  } catch {
    throw new DeliveryRepairRequired("Xcode 工程未返回可识别的方案列表。");
  }
  const schemes = (info.workspace ?? info.project)?.schemes ?? [];
  const scheme = metadata.scheme ?? (schemes.includes("Unity-iPhone") ? "Unity-iPhone" : schemes.length === 1 ? schemes[0] : void 0);
  if (!scheme || !schemes.includes(scheme)) throw new DeliveryRepairRequired("请在交付清单中记录当前工程实际可构建的 App scheme。");
  const settings = await runProcess("/usr/bin/xcrun", ["xcodebuild", flag, join(directory, container), "-scheme", scheme, "-configuration", "Debug", "-showBuildSettings", "-json", "-disableAutomaticPackageResolution"], { signal, env, timeoutMs: 9e4 });
  let targets;
  try {
    targets = JSON.parse(settings.stdout);
  } catch {
    throw new DeliveryRepairRequired("无法解析最终 Xcode App target 的构建配置：" + settings.stderr.slice(-2e3));
  }
  const apps = targets.filter((target) => target.buildSettings.WRAPPER_EXTENSION === "app" && (!metadata.applicationTarget || target.target === metadata.applicationTarget));
  if (settings.code || apps.length !== 1 || !bundleId(apps[0].buildSettings.PRODUCT_BUNDLE_IDENTIFIER)) throw new DeliveryRepairRequired("未能唯一核对 App target 或正式 Bundle ID，请修复实际 Xcode 导出配置并补充 applicationTarget。");
  return { projectFile: projects[0], ...workspace ? { workspaceFile: workspace } : {}, scheme, applicationTarget: apps[0].target, productionBundleIdentifier: apps[0].buildSettings.PRODUCT_BUNDLE_IDENTIFIER, preferredDevelopmentTeam: apps[0].buildSettings.DEVELOPMENT_TEAM || void 0, configuration: "Debug" };
}
async function deliveryFingerprint(unity, xcode, metadata) {
  const hash = createHash("sha256").update(JSON.stringify(metadata));
  const skip = /* @__PURE__ */ new Set([".git", ".opencode", ".partner-agent", "Library", "Temp", "Logs", "Obj", "node_modules", ".DS_Store", "xcuserdata", "DerivedData"]);
  let count = 0;
  async function visit(root, current, first, isUnity) {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (skip.has(entry.name) || first && isUnity && ["Build", "Builds", "build", "UserSettings"].includes(entry.name) || first && !isUnity && entry.name === "build") continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(root, path, false, isUnity);
      else {
        if (++count > 2e5) throw new UnityConfigurationRequired("交付文件超过扫描上限，请检查是否混入构建缓存。");
        const value = await stat(path);
        hash.update(`${relative(root, path)}\0${value.size}\0${value.mtimeMs}\0`);
      }
    }
  }
  await visit(unity, unity, true, true);
  await visit(xcode, xcode, true, false);
  return hash.digest("hex");
}
const sdkDeliveryRepairSchema = { type: "object", additionalProperties: false, required: ["outcome", "message"], properties: { outcome: { type: "string", enum: ["ready", "needs_user"] }, message: { type: "string" } } };
function sdkDeliveryInstructions() {
  return `01 最终交付要求：完成接入后保留完整 Unity 工程，并使用本次已验证编辑器实际导出包含 SDK 与依赖的最终 iOS Xcode 工程。不要只给 changes.patch 或口头总结；导出到当前工程副本的独立子目录。保持正式 Bundle ID、产品名和游戏方向；测试包使用独立 Bundle ID，默认 <正式BundleId>.sdktest，不改写正式 PlayerSettings。输出 .partner-agent/delivery.json，内容为 {"schemaVersion":1,"xcodeProjectPath":"实际导出目录的相对路径","scheme":"实际App方案","applicationTarget":"实际App target","testBundleIdentifier":"独立测试BundleId","autoInstall":true}。用户明确要求暂停设备操作时将 autoInstall 设为 false；明确重新安装时更新 installRequestId。完成真实 CocoaPods/原生依赖解析，保留普通运行行为，不留下自动 QA 驱动。无法导出时说明真实证据及需要补充的信息。后端会独立检查工程、生成并校验 Unity/Xcode ZIP 和一键安装脚本，检查设备后构建/签名并尝试安装；模型不要自行安装或启动手机上的应用。`;
}
export {
  DeliveryRepairRequired,
  SdkDelivery,
  inspectXcodeDelivery,
  sdkDeliveryFiles,
  sdkDeliveryInstructions,
  sdkDeliveryRepairSchema
};
