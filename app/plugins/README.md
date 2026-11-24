# 合作方 Agent 插件

清单使用 schemaVersion:1，以应用 shared/contracts.ts 和 docs/api-contract.md 为准。每个模块子目录包含 manifest.json；SDK 的 skill.path 是模块内部相对路径，必须指向 SKILL.md。

当前附带 finance-sync、h5-sync、gp-build、website-generator 四个模块。

SDK 接入页保留 01、02、03、04、05 五种合作方类型。原有 SDK 接入 Skill、方案清单和配套资源已清空，等待逐个上传。上传时通过 profile.partner 对应合作方编号；有可用方案后，页面显示版本选择、工程、参数和接入对话。asset-sources.json 仅记录当前保留的 SDK Skill 来源及 SHA-256。

GP 打包使用独立页面，以及 gp-build/manifest.json 与 skills/gp-build/SKILL.md。

用户模块放在应用 dataDir/plugins。修改模块后提升 manifest.version，通过仓库管理发布或 POST /api/plugins/reload 重载；新任务使用新版本，已有任务保留原有快照。目录结构、参数和更新要求见 docs/plugin-authoring.md。
