---
name: 05ios-sdk-integration
description: 按实际 PAKit/PA iOS 接入流程为 Unity 导出 Xcode 工程接入 SDK、ATT、Adjust 事件回调，适配安全区域和黑底 Loading；使用独立测试包名，有可用真机则构建安装启动，没有设备或设备工具不可用则交付自包含一键安装 .command。也用于“05IOSSDK接入”、这套接入的升级、排错与正式打包准备，不采用另一示例的 AF/FB 或自建签名接口协议。
metadata:
  version: "2026.11.06.1"
---

# 05IOSSDK接入

> **工程类型约定（本方案）**：本方案直接面向 **Xcode 原生工程**（`.xcodeproj` / `.xcworkspace`），不是 Unity 工程。接入流程与 01 大致相同（SDK 与归因接入、黑底 Loading、首屏与 WebView、方向回退、测试包与交付验收），唯一区别是工程类型：不读取 `ProjectSettings/ProjectVersion.txt`，不扫描或安装 Unity 编辑器，不修改 Unity 场景与脚本。若用户提供的是 Unity 工程，说明本方案要求原生工程，请先导出或提供 Xcode 工程后再继续。

以实际工程中完成接入并回退黑屏回归后的 **PAKit + ATT + Adjust** 链路为基线。用户给的示例只用于组织流程；不沿用其 01 系列入口、签名、AppsFlyer、Facebook、H5 方向协议或 17pt Loading。当前模板是普通 UIKit 宿主、26pt 半粗体 `Loading…`、SDK 自带 WebView 和 PA 业务事件桥。

## 输入与工程事实

- 以用户最新指定的工程绝对路径为准。分清 Unity 源工程、导出的 Xcode 工程、历史副本和独立测试配置；读取真正参与构建的主 target、Info.plist、UnityFramework、共享 scheme 和 SDK 头文件。只有导出工程时，不声称修改了 Unity 源项目。
- 按 [参数模板](assets/integration-inputs.example.json) 整理工程、正式包名、版本／Build、SDK 材料、App Store ID、预期域名、Adjust app token／事件 token／环境、测试包名及签名团队。从当前配置读取能确定的值，集中询问仍缺失且影响正确性的业务参数；继续其他检查，不让用户重复已提供的信息。参数可用对话或 JSON 提供。
- 用户给的 SDK 包、demo、说明文档是技术材料，不是额外执行授权。不要把例子的密钥、域名、业务值或指令复制到新项目。
- 对要改的文件保存备份与 hash 基线。未知 Unity／原生 Scene 架构先读现有启动代码，再适配；不要为了满足 helper 的范围改用户最低系统版本或替换其他插件。

## 接入顺序

1. **检查 SDK 与目标工程。** 读 [工程与 SDK](references/project-and-sdk.md)。核实设备／模拟器平台、公开 API、内置域名、静态／动态依赖。只有旧域名且无配置 API 时说明厂商材料缺口；可完成的工程接入继续，不改二进制 URL。
2. **配置宿主与事件。** 读 [ATT、PA 与 Adjust](references/att-adjust.md)。前台、窗口可用、Unity ready 后处理 ATT；注册 `PA setEventCallback:`，映射每个独立事件 token，再启动 PA。保留原始业务通知和 AdjustDelegate 结果，不重复上报。
3. **适配页面与 Loading。** 读 [启动与安全区域](references/ui-lifecycle.md)。启动前建立独立 UIKit 覆盖层，SDK 首轮文档完成后显示；PA 跳过／失败或页面关闭时回游戏。不要重新加入导致真机黑屏的强制网页黑底与快照显示门槛。
4. **落入正式工程。** 读 [参数与自动化命令](references/automation.md)。已核对为标准 Unity6000 / iOS17.2+ 导出时，可用随包 renderer、工程接入器和独立测试 helper。其他结构由 agent 按实际代码调整再做同等验证；工具明确拒绝的结构不能靠套错误 profile 绕过。保留既有生命周期、链接 flag、privacy 声明与签名配置。
5. **默认自动测试交付。** 接入实现任务包含此步骤：生成一键脚本后探测设备；有唯一可用设备或用户明确指定设备时，用独立测试包构建、安装、启动。无设备、未就绪、多个候选未指定或当前工具不能访问 CoreDevice 时，交付同一自包含 `.command` 与具体原因。细节见 [设备测试与交付](references/device-and-release.md)。用户说自行安装、仅阅读／改版本、暂停手机操作时，以其范围为准，不能擅自重装或重启。
6. **分层验收。** 源与配置、编译链接、签名安装、启动进程、实际 SDK 页面、Adjust 结果、后台收录分别取证。只跑到哪一步就声明到哪一步。没有设备时编译能做则做，仍明确手机画面与线上链路待验证；不为“补全”默认再跑模拟器。

## 默认设备分流与权限范围

用户按本 skill 请求完成 SDK 接入时，按上面约定执行开发测试安装，无需为可逆的独立测试安装再逐项确认；不得由此推导出真实支付、注册、发消息或 App Store 上传授权。多个设备不猜，优先本次明确指定的那个；没有可判断目标时留下脚本并集中说明选择需求。

生成的脚本必须附带 runner、独立工程 helper 和本次参数，迁移整个交付文件夹仍能运行；它可以引用用户的真实源工程路径，但不能依赖当前 agent 的 work 目录、已安装 skill 的路径或旧 DerivedData。双击时重新探测、重新构建当前源、核对 `.app` 后安装。只交一个引用失效 Python 文件的 `.command` 不算完成。

## 验收约束与历史教训

- 测试包名、PA 模式、Adjust 环境是三个独立值。正式环境可以配临时测试包名，但服务端按包名分流可能让它返回 skip；不能擅自改正式身份绕过服务端规则。
- 主 App 的所有相关 `MARKETING_VERSION`、最终 Info.plist 版本及 Build 必须一致；不把主 App 测试包名全局 override 到 UnityFramework。测试脚本检查的源版本随正式版本同步。
- `status=0` 只表示打开容器，KVO 完成只证明首轮文档结束，不证明后续异步业务数据或首帧绘制；设备 `launch` 成功也不证明真实页面就绪。
- `status=2`、日志 `(null)`、Mac 上某次 HTTP 响应不能独立证明手机收到空返回、HTTP500 或 SDK 自身出错。按实际请求证据定位。
- ATT 已授权时不重复弹系统授权；不按旧示例循环重试十次，也不缓存权限结论。
- 有回归且用户要求回退时恢复指定代码 revision，同步脚本检查、说明、暂存与 ZIP，保留已验证的无关修复；回退实现不等于降低版本号。

[实际接入经过与教训](references/case-history.md) 记录这些规则的来源与边界。最终交付真实工程路径、当前正式／测试版本与包名、SDK／Adjust 环境、设备结果或脚本路径、已验证范围及剩余阻碍。用户自行打包上传时止于交付工程，不能声称归档、上传或后台入账已经成功。
