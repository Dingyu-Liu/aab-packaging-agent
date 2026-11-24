function unityPlatformModule(platform) {
  return platform === "ios" ? "iOS Build Support" : "Android Build Support（含 SDK、NDK 和 OpenJDK）";
}
function unityProjectRequirement(report, platform) {
  const edition = report.unityDistribution === "china" ? "国内版" : report.unityDistribution === "international" ? "国际版" : "发行版待核实";
  return `${edition} Unity ${report.unityVersion || "版本待核实"}${report.unityRevision ? `（revision：${report.unityRevision}）` : ""} · ${unityPlatformModule(platform)}`;
}
function unityEditorInstallationIssue(toolchain) {
  if (toolchain?.matchingEditor) return void 0;
  if (toolchain?.versionCandidates.length) {
    if (toolchain.versionCandidates.some((editor) => !editor.revision)) return "已找到同版本的 Unity 编辑器，但部分编辑器无法读取 revision，尚不能确认与工程匹配。请查看扫描详情并核对安装。";
    return "已找到同版本的 Unity 编辑器，但 revision 与工程记录不匹配。请查看扫描详情并安装工程要求的准确版本。";
  }
  if (toolchain?.scanWarnings.length) return "Unity 编辑器扫描遇到读取或权限问题，暂时无法确认安装状态。请查看扫描详情，处理后重新扫描。";
  return "本机未找到与工程完整版本及 revision 匹配的 Unity 编辑器，请自行下载并安装。仅下载 .pkg/.dmg 安装包不会完成编辑器安装。";
}
function unityInstallationIssue(report, platform) {
  if (report.type !== "unity") return void 0;
  if (report.unityToolchain?.versionIssue) return report.unityToolchain.versionIssue;
  if (!report.unityVersion || !report.unityDistribution || report.unityDistribution === "unknown") return "无法确认工程的完整 Unity 版本，请核对 ProjectSettings/ProjectVersion.txt 后重新扫描。";
  const editor = report.unityToolchain?.matchingEditor;
  if (!editor) return unityEditorInstallationIssue(report.unityToolchain);
  if (!editor.moduleDirectories[platform].length) return `已找到匹配的 Unity 编辑器，请自行补装 ${unityPlatformModule(platform)}。`;
  return void 0;
}
export {
  unityEditorInstallationIssue,
  unityInstallationIssue,
  unityPlatformModule,
  unityProjectRequirement
};
