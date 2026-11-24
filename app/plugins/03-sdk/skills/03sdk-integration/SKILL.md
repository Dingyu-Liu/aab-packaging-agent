---
name: 03sdk-integration
description: "为 Unity 源工程或 iOS 导出工程接入 AppsFlyer 与 PA 类配置 SDK，完成竖屏 Loading、归因分流、网页首屏、游戏方向和音视频恢复，并自动交付独立测试包或一键安装 command。用户提到 03SDK接入时使用；其他 SDK 按实际供应商契约适配，不套用示例接口。"
metadata:
  version: "2026.11.12.1"
---

# 03SDK接入

> **工程类型约定（本方案）**：本方案直接面向 **Xcode 原生工程**（`.xcodeproj` / `.xcworkspace`），不是 Unity 工程。接入流程与 01 大致相同（SDK 与归因接入、黑底 Loading、首屏与 WebView、方向回退、测试包与交付验收），唯一区别是工程类型：不读取 `ProjectSettings/ProjectVersion.txt`，不扫描或安装 Unity 编辑器，不修改 Unity 场景与脚本。若用户提供的是 Unity 工程，说明本方案要求原生工程，请先导出或提供 Xcode 工程后再继续。

以 Racing 实际接入和真机修复为依据，完成新工程的 SDK → 归因 → 配置 → 网页/原生游戏全链路。用户提供本 skill 和参数即可执行到构建、测试交付；缺失值先从当前工程提取，只有影响业务契约或无法推断的参数才集中询问。示例只作结构参考，不给新工程授权、密钥或接口。

## 输入与工程事实

按 [接入参数模板](assets/integration-inputs.example.json) 整理参数；自然语言提供也可，不要求用户手填 JSON。先核实唯一工程路径、Unity 源工程还是 Xcode 导出、实际 SDK 头/库/版本、已有启动入口、真正承载网页的组件、事件/方向协议、签名与游戏音视频来源。已有依赖先复用，不能因目录有 UniWebView 就认定业务页面也由它打开。

有 Unity 源工程：改 C#、Plugins/iOS 与导出 postprocess，确保重导出保留改动。只有导出工程：备份后修改原生与生成 C++，不改 IL2CPP 对象/静态字段布局；记录重导出覆盖风险。哈希符号、引擎 native binding 和第三方私有 selector 都不可直接套到新版本。

首次接入或协议不清时读 [实际接入链与状态机](references/integration-flow.md)。需要追溯本次实现/问题时读 [Racing 事实与教训](references/racing-case.md)。这里没有固定的 01 系列 HTTP 路径、签名算法或 FB 参数；新项目以用户指定的 SDK/真实源码为准。当前 Racing 事实是 AppsFlyer + PurchaseConnector + 本地 PA 库，没有 FB 接入。

## 实施顺序

1. **锁定参数和契约**：识别 App Store 数字 ID、正式 Bundle ID、测试 Bundle ID、SDK devKey、业务 mode/归因值、持久 UID、事件映射。真实密钥引用用户参数、环境或原工程，不放入 skill、报告和通用模板。保留既有业务参数，不能为进 B 面伪造归因、绕过后台分流或修改网站防护。
2. **初始化与归因**：AppsFlyer 使用 `initSDK → waitForATT(30) → startSDK`（按实际版本 API）；原生 ATT 在 active 后请求且只发一次。区分“标识回调完成”和“标识非空”，拒绝授权也能完成启动。任何可能同步回调的 SDK 初始化前先关闭分流门；单一协调器等待后才能决定。Racing 协议仅明确 Non-organic=1、Organic=2；Unknown=0 本地保留并回退，不发旧接口。不同协议必须重新适配，不能沿用数值猜测。
3. **统一启动显示**：默认竖屏黑底，中心白字 `Loading` + 转圈，在 Unity 首帧/Logo前覆盖并挡住游戏操作。等待归因约35秒（含ATT最多30秒）、配置总阶段10秒、网页首屏另15秒；Waiting异常兜底50秒。明确失败提前结束，计时单调且阶段独立，旧回调不能打开网页或撤掉新阶段遮罩。参数明确覆盖默认值时按用户选择。
4. **网页与回退**：容器呈现不代表首屏成功；UIKit presentation 完成且首次有效 HTTP/HTTPS 导航完成才撤 Loading。转发原导航 delegate，正确处理取消跳转、主文档 HTTP错误、导航失败、WebKit进程退出和网页关闭。回退前使旧配置请求/呈现失效。临时方向锁只作用于启动/网页，回退恢复游戏原方向与全部自动旋转开关；保留项目已存在的网页显式方向指令。
5. **关闭 A 面声音直至游戏可见**：必须盘点 BGM、SFX、playOnAwake、VideoPlayer direct音轨、原生播放器/中间件。Loading 和 B 面不播放 A 面，网页音频独立。阻止/停止游戏源，保存恢复用户音量/静音/音乐偏好；短音效丢弃不补播。**开场视频延后整个激活/Prepare/Play流程**，不能只把 AudioListener 调成0。回退时先等模态/方向/渲染就绪、撤 Loading 提交和游戏实际帧呈现，再恢复音频与开场视频。不要暂停执行归因协程的 Unity 主循环。细节读 [画面、方向与音视频](references/presentation-audio.md)。
6. **构建与自动交付**：实现完成后直接执行下节默认交付，不把“是否继续构建安装”作为额外审批。用户指定自测/不操作手机时优先遵守。新供应商、新库版本或原生 ABI 必须先编译验证，不能用本案例通过记录代替新工程验证。

## 默认交付：有设备安装，无设备交一键脚本

读取 [iOS 构建与设备交付](references/ios-delivery.md)，将已解析参数转换成 [构建参数](assets/build-inputs.example.json)。使用 [交付脚本](scripts/ios_test_delivery.py) 创建独立测试工程和 `.command`，仅覆盖 App target 的包名/显示名/版本，保留正式工程与 SDK 业务标识。

```sh
python3 <本skill目录>/scripts/ios_test_delivery.py --config <本工程build-inputs.json>
```

- **有唯一可用 iOS 真机**：自动签名构建 `<正式BundleID>.sdktest`（或用户指定测试包名），安装、核对设备应用清单的包名/版本/Build，再启动并采集本次运行证据。多设备且未指定目标时明确列出候选，选择前不随便操作某台手机。
- **没有可用连接设备**：必须产出可双击的 `一键安装测试包.command` 及本地 companion 脚本/参数；随后可用 `--build-without-device` 完成免签编译验证。以后连机双击会重新查设备、签名构建安装，不把免签 .app 宣称为可安装包。默认不额外安装/运行模拟器。
- 脚本 `--prepare-only` / `--plan` 只生成和检查测试工程，不构建签名或操作设备。用于预演、代码审查和用户要求暂不安装的场景。
- helper 支持已完成接入的标准 Unity Xcode 导出 App target + Pods。Unity 源工程先自动导出；非标准工程、扩展/entitlements或自定义 workspace 按参考适配后再交付，不能以 helper 限制代替完成用户任务。它不负责自动猜 SDK 代码或供应商协议。
- 自动签名遇到法律协议、账号登录、手机信任/开发者模式等实际阻塞时，保留已构建产物/脚本，明确用户需完成的那一步及原因。团队按证书 OU/profile核对，不用证书名称括号猜测；无授权不代用户接受协议。不循环重建证书/重装来掩盖阻塞。

## 验收与收尾

按 [验收与排错](references/verification.md) 执行与改动相称的测试：归因分类/同步回调时序/时限/幂等；网页真实返回和首屏；Loading视图/方向；各类音源和视频；回退恢复。每轮证据绑定本次包、Build、运行时间或runId。完整请求/响应仅在本地诊断包临时采集，常规日志脱敏；正式构建无自动测试/注入/改色/旋转副作用。

真实手机听到声音，即使日志 `volume=0` 也判为未通过并继续定位；不能宣布已修好后把验收推给用户。没有听感能力时先完成代码、构建、安装与日志/画面检查，明确仅此项需要用户复听。配置JSON、PA状态、网页HTTP、首屏、后台归因/事件入库分别下结论；网站403或后台不可见如实报告，不强行显示错误页充当B面成功。

最终交付：源改动/备份与同步回源说明、版本/测试包名、测试 `.app`（签名状态）、一键 `.command` 及依赖参数、构建和本次真机日志、已通过/未验证/外部阻塞。不附真实SDK key；不把报告、HTTP200、安装成功或launch成功单独当全链路通过。
