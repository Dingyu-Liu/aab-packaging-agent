import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { inspectUnityToolchain } from "./unity-editor.js";
import { UnityConfigurationRequired } from "./errors.js";
import { runProcess } from "./processes.js";
import { unityEditorInstallationIssue, unityPlatformModule } from "../shared/unity.js";
class MissingUnityModule extends Error {
}
class UnityInstallationRequired extends UnityConfigurationRequired {
}
class UnityPreparation {
  constructor(options = {}) {
    this.options = options;
  }
  options;
  async prepare(input) {
    const { report, platform, signal } = input;
    const recorded = { version: report.unityVersion, revision: report.unityRevision, distribution: report.unityDistribution ?? "unknown", versionIssue: report.unityToolchain?.versionIssue };
    let state = { workflowVersion: 2, status: "checking", version: recorded.version, revision: recorded.revision, distribution: recorded.distribution, platform, detail: "重新扫描工程要求的 Unity 编辑器和平台模块。", updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
    const update = (status, detail) => {
      state = { ...state, status, detail, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
      input.update(state);
    };
    const inspect = (extra) => this.options.inspect ? this.options.inspect(recorded, extra) : inspectUnityToolchain(recorded, { extraEditors: extra ? [extra] : [], refresh: true });
    const verify = this.options.verify ?? verifyUnityPlatform;
    const module = unityPlatformModule(platform);
    const installationRequired = (reason) => new UnityInstallationRequired(`${reason}
工程要求：${recorded.distribution === "china" ? "国内版" : "国际版"} Unity ${recorded.version}${recorded.revision ? `（revision：${recorded.revision}）` : ""}；模块：${module}。
请自行下载并安装准确版本及模块；自定义安装目录请在 Unity Hub 中定位该编辑器。安装完成后点击“已安装，确认并重新扫描”，检查通过后自动继续当前接入。`);
    update("checking", state.detail);
    try {
      signal.throwIfAborted();
      if (!recorded.version || recorded.versionIssue || recorded.distribution === "unknown") throw new UnityConfigurationRequired(recorded.versionIssue || "无法确认当前工程的 Unity 完整版本，请核对 ProjectSettings/ProjectVersion.txt 后点击确认并重新扫描。");
      const found = await inspect(input.previous?.editorPath);
      signal.throwIfAborted();
      await writeFile(join(input.taskDirectory, "unity-toolchain-scan.json"), JSON.stringify(found, null, 2) + "\n");
      const editor = found.matchingEditor;
      if (!editor) {
        const reason = `${unityEditorInstallationIssue(found)}${found.scanWarnings.length ? "\n扫描问题：" + found.scanWarnings.join("；") : ""}
本次扫描详情保存在 unity-toolchain-scan.json。`;
        if (found.versionCandidates.some((candidate) => !candidate.revision) || !found.versionCandidates.length && found.scanWarnings.length) throw new UnityConfigurationRequired(reason);
        throw installationRequired(reason);
      }
      state.editorPath = editor.path;
      if (!editor.moduleDirectories[platform].length) throw installationRequired("已找到匹配的 Unity 编辑器，但缺少目标平台模块。");
      const fingerprint = await editorFingerprint(editor);
      if (input.previous?.workflowVersion === 2 && input.previous.status === "ready" && input.previous.version === recorded.version && input.previous.revision === recorded.revision && input.previous.platform === platform && input.previous.editorFingerprint === fingerprint) {
        state = { ...state, status: "ready", editorFingerprint: fingerprint, verifiedAt: input.previous.verifiedAt, detail: "已重新扫描本机工具链，沿用本任务中仍有效的平台验证记录。" };
        input.update(state);
        return state;
      }
      update("verifying", "已找到匹配的编辑器和模块，验证实际平台支持能力。");
      try {
        await verify(editor, platform, input.taskDirectory, signal);
      } catch (error) {
        if (error instanceof MissingUnityModule) throw installationRequired(error.message);
        throw error;
      }
      signal.throwIfAborted();
      state.editorFingerprint = await editorFingerprint(editor);
      state.verifiedAt = (/* @__PURE__ */ new Date()).toISOString();
      update("ready", "匹配编辑器与平台模块已验证，继续 SDK 接入。");
      return state;
    } catch (error) {
      update(signal.aborted ? "cancelled" : error instanceof UnityInstallationRequired ? "waiting_installation" : error instanceof UnityConfigurationRequired ? "needs_configuration" : "failed", error instanceof Error ? error.message : "Unity 前置检查未完成。");
      throw error;
    }
  }
}
async function editorFingerprint(editor) {
  const hash = createHash("sha256").update(JSON.stringify(editor));
  for (const file of [join(editor.path, "Contents", "MacOS", "Unity"), join(editor.path, "Contents", "Info.plist"), ...editor.moduleDirectories.ios, ...editor.moduleDirectories.android]) {
    try {
      const info = await stat(file);
      hash.update(`${file}\0${info.size}\0${info.mtimeMs}`);
    } catch {
      hash.update("missing:" + file);
    }
  }
  return hash.digest("hex");
}
async function verifyUnityPlatform(editor, platform, taskDirectory, signal) {
  const root = join(taskDirectory, "unity-platform-probe"), output = join(root, "result.json"), log = join(taskDirectory, "unity-platform-probe.log");
  for (const folder of ["Assets/Editor", "Packages", "ProjectSettings"]) await mkdir(join(root, folder), { recursive: true });
  await writeFile(join(root, "Packages", "manifest.json"), '{"dependencies":{}}\n');
  await writeFile(join(root, "ProjectSettings", "ProjectVersion.txt"), `m_EditorVersion: ${editor.version}
${editor.revision ? `m_EditorVersionWithRevision: ${editor.version} (${editor.revision})
` : ""}`);
  await writeFile(join(root, "Assets", "Editor", "PartnerAgentUnityPlatformProbe.cs"), `using System;
using System.IO;
using UnityEditor;
using UnityEngine;
public static class PartnerAgentUnityPlatformProbe {
 public static void Run() {
  bool supported = BuildPipeline.IsBuildTargetSupported(BuildTargetGroup.${platform === "ios" ? "iOS" : "Android"}, BuildTarget.${platform === "ios" ? "iOS" : "Android"});
  File.WriteAllText(Environment.GetEnvironmentVariable("PARTNER_UNITY_PROBE_OUTPUT"), supported ? "true" : "false");
  EditorApplication.Exit(supported ? 0 : 23);
 }
}
`);
  const { rm } = await import("node:fs/promises");
  await rm(output, { force: true });
  const result = await runProcess(join(editor.path, "Contents", "MacOS", "Unity"), ["-batchmode", "-nographics", "-quit", "-projectPath", root, "-executeMethod", "PartnerAgentUnityPlatformProbe.Run", "-logFile", log], { signal, timeoutMs: 6e5, env: { PARTNER_UNITY_PROBE_OUTPUT: output }, maxOutput: 12e3 });
  let supported = "";
  try {
    supported = (await readFile(output, "utf8")).trim();
  } catch {
  }
  if (result.code === 0 && supported === "true") return;
  if (supported === "false" || result.code === 23) throw new MissingUnityModule(`Unity API 确认 ${platform} 平台不可用，需要修复或补齐对应模块。`);
  let details = result.stdout + result.stderr;
  try {
    details += (await readFile(log, "utf8")).slice(-3e4);
  } catch {
  }
  if (/No valid licen[cs]e|licen[cs]e[^\r\n]*(?:fail|invalid|expired|not found|not active)|activation[^\r\n]*(?:fail|required)|entitlement[^\r\n]*(?:missing|not found|fail)/i.test(details)) throw new UnityConfigurationRequired("匹配编辑器已找到，但 Unity 平台验证受许可证/激活状态阻塞。请在 Unity Hub 完成登录和许可证激活，再在当前任务继续。日志保存在本任务 unity-platform-probe.log。");
  throw new UnityConfigurationRequired(`Unity 平台验证未完成（退出码 ${result.code}）。请检查本任务 unity-platform-probe.log 中的编辑器启动或系统授权问题，再继续；本次未将平台支持标记为通过。`);
}
export {
  MissingUnityModule,
  UnityPreparation,
  verifyUnityPlatform
};
