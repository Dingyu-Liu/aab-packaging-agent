const MAC_ARCHITECTURES = Object.freeze({
  x64: Object.freeze({ arch: 'x64', macho: 'x86_64', label: 'Intel Mac', directory: 'macos-intel', opencode: 'opencode-darwin-x64-baseline', guide: 'macos-intel.md' }),
  arm64: Object.freeze({ arch: 'arm64', macho: 'arm64', label: 'Apple 芯片 Mac', directory: 'macos-arm64', opencode: 'opencode-darwin-arm64', guide: 'macos-arm64.md' }),
});
function macArchitecture(arch = process.arch) {
  if (!Object.hasOwn(MAC_ARCHITECTURES, arch)) throw new Error(`不支持的 Mac 架构：${arch}；请选择 x64 或 arm64。`);
  return MAC_ARCHITECTURES[arch];
}
function releaseFeed(arch) { return macArchitecture(arch).arch === 'x64' ? 'release.json' : 'release-arm64.json'; }
function archivedRelease(version, arch) { return macArchitecture(arch).arch === 'x64' ? `${version}.json` : `${version}-arm64.json`; }
module.exports = { MAC_ARCHITECTURES, macArchitecture, releaseFeed, archivedRelease };
