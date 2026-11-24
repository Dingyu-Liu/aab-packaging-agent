---
name: 01sdk-integration
description: Use when a Unity project needs AppsFlyer/AF or Adjust attribution, Facebook/FB integration or event troubleshooting, iOS ATT, an entry-API WebView/native-game flow, notch/Dynamic Island layout, H5 bridge testing/rotation buttons, iOS app icons during integration, or a device test build. Also use when the user requests “01SDK接入”.
metadata:
  version: "2026.11.11.1"
---

# 01SDK接入

在现有 Unity 工程或其 Xcode 导出工程中完成 SDK、启动接口与 WebView 接入，并提供能区分本地功能、真机行为和后台收数的验证证据。用户只要求阅读 Demo 时停在分析；实现、构建、安装按本次任务范围执行。用户明确自行测试或暂停设备操作后，保留当前手机状态，后续源码修复、构建和交付按其新要求继续，不再沿用默认流程重装、重启或自动点击手机。

## 先建立项目事实

- 先确定本次唯一修改工程的**绝对路径**：核对运行中的 Unity 工程、用户最近使用的副本；有引用对话时先读取，再核对磁盘现状。没有运行中的编辑器时，以用户确认的工程及实际文件为准。不能用 Downloads 的旧副本否定 Desktop 的新改动。
- 先区分 Unity 源工程与已导出的 Xcode 工程，再读取实际存在的版本信息、SDK/API、启动脚本和 H5 桥，比较既有别名、模拟器入口修改与交付版本；先保存差异基线再修改。仅有 Xcode 导出时，不因缺少 `ProjectSettings/ProjectVersion.txt` 改用其他旧副本，也不声称已修改 Unity 源工程。Demo、旧备份、测试工程和其他对话结论均不代替当前源码。
- macOS 的 iOS 模块可能在 `.app` 内，也可能在编辑器安装目录的 `PlaybackEngines/iOSSupport`。可运行 [只读检查脚本](scripts/inspect_unity.py)，最后通过目标编辑器的 `BuildPipeline.IsBuildTargetSupported` 或真实导出确认，不能仅凭一个目录缺失就重装。
- 区分 App Store 数字 ID、Bundle ID、SDK 应用 ID、设备标识。保留已有业务标识；测试包使用明确且独立的包名。显示名按用户给定值保留空格；工程编号用于脚本、文件夹或压缩包命名时，不自动拼入应用显示名。
- 迁移签名密钥时比较源配置与目标配置的**解析后字符串/UTF-8 字节**，不要复制 YAML 的原始值文本。YAML 的外层单/双引号可能只是语法；密钥本身的引号、空格和转义也可能有效，不能统一 `Trim` 或去引号。详见 [签名迁移与排查](references/integration.md#签名规则)。

## 01 系列约定

- **全局共享签名密钥**：01 系列入口签名密钥由所有工程共享，统一使用：

```text
@1%ss(&@1v%mf-z5(#p26slu#&v-do9awafskpsytylw#6xp#s
```

工程配置（例如 `Assets/Resources/Integration01Config.json` 的 `signingKey`）已有值时必须与该共享值一致；缺失时直接把这一个值写入项目配置。不要把 AF Dev Key、FB Client Token 当成入口签名密钥；该密钥不得出现在交付报告、对话总结或对外发送的消息中。

- 标准入口为 `https://{本工程请求域名}/api_v1/system/get_system_info`。完整配置、请求字段和签名向量见 [接口与签名配置](references/integration.md#01-系列入口地址与签名配置)；可用 [扁平配置示例](assets/entry-api-config.example.json)。替换本工程域名和渠道；签名密钥使用下方「全局共享签名密钥」，工程已配置 `signingKey` 时必须与其一致，不一致时停止并报告，不要自行替换。请求体必须用与签名相同的递归排序序列化（后台按请求体原文验签），空归因探测不覆盖嵌套对象的顺序问题。
- 本系列默认全程黑底、屏幕中央单行 `Loading…`（系统 Regular 17pt）；iOS 的 Unity 层只画黑底。网页首帧就绪才显示网页，失败后等游戏准备好才显示游戏；网页内容约束到系统安全区。实施前读取 [Loading 与刘海适配](references/startup-presentation.md)，当前用户明确指定的其他设计优先。只请求刘海/方向或图标修改时，采用相关规则，不据此重做无关启动流程。

- **方向按阶段和显式指令控制**：系统启动页、Loading、首次显示的默认网页使用竖屏 `Portrait`，保留已约定的 H5 横屏、左右横屏、竖屏及自动旋转指令；默认不跟随设备旋转。工程已有网页方向协议时，用户要求“页面竖屏”应保留该协议，不能顺带把宿主控制器和 AppDelegate 永久锁成 Portrait、拒绝全部非竖屏请求；只有用户明确要求全程锁定并禁用网页旋转时才采用该限制。网页方向与游戏方向独立，回退时恢复游戏原方向及自动旋转开关。用户反馈方向异常时先核对所处阶段及真实按钮参数。实施见 [启动方向与回退](references/startup-presentation.md#按阶段控制方向) 和 [网页显式方向契约](references/webview-orientation.md)。

## 按问题读取

- 网页横屏按钮、方向回执或旋转不同步：先读 [实际网页方向契约](references/webview-orientation.md)，核对线上按钮原始参数及 Unity/UIKit 时序。
- 更换图标或设备工具阻塞：读 [iOS 构建参考](references/ios-device.md)，检查图标槽位/导出产物、实际架构与限时工具调用。

## 接入顺序

1. **核对参数和协议**：按 [输入模板](assets/integration-inputs.example.json) 整理已提供、已确认沿用、缺失和假设项。对已明确采用上述 01 约定的工程，直接按该约定补全路径和协议；只集中询问仍缺失的项目参数，同时继续独立工作。真实密钥只进入项目配置，skill 示例使用占位符，不写进报告或公共产物。
2. **选择 SDK 并适配启动**：按用户指定供应商接入。替换 Adjust 为 AppsFlyer 时，同时调整 SDK API、归因字段、事件名称及 H5 协议；先确认 `eventToken` 是旧 Adjust token 还是已约定的 AF 事件名别名；保留用户已有且已验证的兼容，不擅自删除。读取 [接入与协议参考](references/integration.md)；涉及 FB 初始化或事件排查时，同时读取 [Facebook 配置、事件与 TLS](references/facebook-events.md)。
3. **控制启动和恢复**：由单一入口协调授权、初始化、归因、接口、WebView/游戏路由；在竖屏启动覆盖生效前保存游戏原方向，分别控制竖屏启动、网页默认/显式方向与原方向回退。设定实际超时；捕获嵌套协程异常；网页失败或渲染进程终止可回到游戏。复用项目 UI 适配点，在首场景第一帧前遮住游戏，按上述 Loading/安全区约定交接；仅暂停数据加载并不能隐藏场景画面。用户要求 Editor/Device Simulator 请求入口时，将“SDK 不可用”与“是否请求业务接口”分开；正常启动不插入本地测试页或自动桥接用例。
4. **构建与真机安装**：任务需要时，读取 [iOS 构建参考](references/ios-device.md)。先复用已有编辑器、模块和证书。任务包含设备测试且用户未指定自行安装/自测时，默认构建独立测试包（如 `<正式BundleId>.sdktest`，显示名遵循用户要求）并安装到已连接真机验证。设备候选不能仅凭 `tunnelState=connected` 筛选；测试签名团队从本次显式选择或当前可用 Xcode 配置确定，不照搬示例团队。具体判断见 [iOS 构建参考](references/ios-device.md#一键安装脚本的设备与签名判断)。不额外安排模拟器测试；模拟器只在没有可用设备或用户明确要求时使用。测试包保持 AF/FB App ID、App Store ID 与入口参数不变；安装后记录 Bundle ID、Profile 到期时间、本次启动时间与 runId。临时设置需可恢复，导出后确认 PlayerSettings 已恢复正式包名。
5. **分层验证与交付**：读取 [验收参考](references/verification.md)。可适配 [测试网页](assets/bridge_test.html)；真实网页往返、实际旋转、SDK HTTP 响应、业务接口与平台后台记录分别报告。执行 [交付收尾检查](references/delivery.md)：分别核对当前源码、交付 ZIP 和手机已安装包，不能只清理 ZIP。

## 关键验收约束

- 合作方截图是 H5 通信契约的证据；“旧归因格式”不自动意味着 SDK 版本旧。按实际指令、回包类型/层级/JSON 类型核对，维护测试页和回归用例，不能让旧测试页决定新协议。
- **Loading 覆盖完整启动链**：要求统一 Loading 时，原生遮罩须在 Unity 启动动画首帧前生效，并覆盖真实启动/渲染窗口；仅在 C# `Awake` 创建或根视图内置顶不能证明已遮住 Logo。独立覆盖窗口应保持非 key，不抢占授权、Unity 或 WebView 焦点；只在当前网页首帧或回退游戏就绪后撤下，旧回调不得撤新遮罩。实施与画面验收见 [覆盖 Unity 启动动画](references/startup-presentation.md#覆盖-unity-启动动画)。
- 黑边要求要在 WebView 首次 `Load/Show` 前设置正确背景；先查测试器是否主动旋转、染白或注入脚本，再查原生背景、安全区和网页 CSS。方向成功回执和稳定后的截图都不能排除旋转过程闪白。
- 自动测试须显式触发并限定本次运行；普通包不得随冷启动自动旋转、改颜色或发送测试事件。恢复一次颜色/方向不能替代移除再次启动的入口。测试结束换回普通包，并验证再次冷启动；详见交付检查。

- Editor/Device Simulator 的平台分支可能直接进游戏且没有发请求。iOS 构建与 iOS 模拟器/真机是另外的路径，原因必须根据代码和本次日志判断。
- 有已配对真机时，接入后的实际测试从独立测试包安装开始；不要为了“补全”再额外跑一遍模拟器。模拟器结果不能替代真机；设备不可用时如实标记未验证。
- **启动闪退与正常启动分别取证**：任务涉及 iOS 原生 SDK 构建时，核对最终 `.app` 的动态依赖及嵌入签名，检查自有 Objective-C 方法与属性 setter 的 selector 冲突。编译、安装、`launch` 成功或退出码 0 均不能代替本次运行就绪证据；先取日志/堆栈定位，再修复和按授权复测。见 [原生启动故障与包内依赖](references/ios-device.md#原生启动故障与包内依赖)。设备信任拒绝仍结合本地签名、描述文件和实际手机提示判断。
- 每次启动记录运行 ID 或时间。报告必须属于本次运行；仅“不同于上一份报告”仍可能读到另一份旧报告。
- 原生直接旋转成功不证明网页按钮可用；实际点击要经过页面原有 handler 和传输通道，兼容已验证的方向拼写并保留回执原值。桌面 WKWebView 的真实按钮调用检查只能证明相应 H5/协议路径；方向回执、编译通过或桌面检查均不证明手机画面已旋转。真机还需检查实际窗口方向、原生 Frame 和 JS 视口；经 Unity 控制方向时同时检查 `Screen.orientation` 与尺寸。CSS 像素、设备像素和刘海安全区不能直接按全屏比例混比。
- 竖屏启动覆盖与原生游戏契约分别保存。若导出时临时设为 `Portrait`，必须在覆盖前从源工程捕获游戏方向及全部自动旋转开关，并随包提供给运行期；不能在运行期把已经覆盖后的 `Screen.orientation` 当作游戏原方向。回退时解除网页阶段的 UIKit 限制，恢复游戏原有方向/开关，再等实际尺寸和 mask 一致后显示游戏。固定竖屏、固定横屏和 AutoRotation 游戏分别还原，不替游戏重定方向。导出成功或失败均还原源工程设置；验收分别记录 Loading、网页、回退游戏的真实方向与尺寸。
- Facebook 同时核对 Resources 设置持久化、原生配置、初始化后的 `FB.AppId` 与实际请求目标。Info.plist 正确或 `FB.IsInitialized` 为真不能排除 App ID 被默认值 `0` 覆盖；TLS 错误与应用身份错误分别取证、分别验收。
- `SDK initialized`、`event queued`、HTTP 200、归因回调、后台事件入库是不同证据。HTTP 200 不证明后台归因/收数已完成，NXDOMAIN 时不能宣布正式入口已打通。
- 入口返回“签名无效”时，先检查迁移值是否与源配置实际值一致，再核对签名协议。通过只改一个变量的对照定位原因；修复后还需确认本次真机的业务码、实际 `spare_url` 和 WebView 状态，不能仅凭 HTTP 200 宣布成功。真机归因非空时还要核对**请求体本身与签名原文同序**：后台按请求体里的原始 JSON 文本验签，嵌套 `appsflyer` 的键顺序不同会返回 HTTP 200 + `ret:994`，而 Editor 空归因探测（`appsflyer` 为 `""`）看不到这个问题，必须用带真实归因的真机请求验收。

[结果检查脚本](scripts/check_device_report.py) 适用于本参考格式的全屏测试报告，需传入本次启动时间；它不会执行设备操作，也不会将本地报告升级为后台验收结论。脚本及网页契约见各参考文件。优先实际验证，不为套用模板重构无关游戏系统。
