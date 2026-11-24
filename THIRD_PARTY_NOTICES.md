# 第三方组件说明

本项目通过公开 SDK 和包管理器调用组件，没有 fork 或打包其完整产品界面。源码包不包含 node_modules；安装和分发依赖时应保留各包附带的许可证、版权和 NOTICE。

| 组件 | 固定版本 | 许可证 | 官方仓库 |
| --- | --- | --- | --- |
| OpenCode CLI / SDK | 1.19.5 | MIT | https://github.com/anomalyco/opencode |
| React / React DOM | 19.3.1 | MIT | https://github.com/facebook/react |
| Electron | 45.2.3 | MIT；运行时另含 Chromium 等组件声明 | https://github.com/electron/electron |
| Vite | 8.3.6 | MIT | https://github.com/vitejs/vite |
| TypeScript | 7.0.2 | Apache-2.0 | https://github.com/microsoft/TypeScript |
| tsx | 4.23.15 | MIT | https://github.com/privatenumber/tsx |
| qrcode.react | 4.2.0 | ISC | https://github.com/zpao/qrcode.react |
| Lucide React | 1.70.0 | ISC | https://github.com/lucide-icons/lucide |

合作方 skill 来源于本次用户提供/授权的本地技能资产，保留原版本与说明；除下述 GP 游戏配套资源外，不包含 SDK 发行二进制；不包含模型服务密钥、飞书认证、签名证书或实际游戏项目。Dify、Codex、OpenHands 仅作选型参考，不是首版运行依赖。

GP 游戏流程内置用户提供的 deploy.zip 和 Firebase.zip；deploy 按原始 ZIP 字节分片，Firebase 为原归档。原文件 SHA-256 及分片顺序记录在 plugins/gp-build/skills/gp-build/assets/resources.json。归档包含 Unity IL2CPP/.NET 宿主组件及 Firebase Unity 13.6.0 本地 Maven 组件，用于用户规定的 Mac Intel 游戏构建流程；随附版权、许可证与声明保留在原归档中。
