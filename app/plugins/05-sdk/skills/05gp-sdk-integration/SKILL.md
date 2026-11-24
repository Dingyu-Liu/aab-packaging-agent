---
name: 05gp-sdk-integration
description: 在 Android 原生或 Unity 导出的 Android 工程中接入、升级 05GP 系列 PA/PAKit Maven SDK，并通过 PA 回调接入 Adjust；默认完成独立测试包名、独立测试签名 APK 的构建校验和交付。用户说“05GPsdk接入”时使用。不用于 iOS 或自动上架。
metadata:
  version: "2026.11.06.1"
---

# 05GPsdk接入

> **工程类型约定（本方案）**：本方案直接面向 **Android 原生工程**（Gradle / Android Studio），不是 Unity 工程。接入流程与 01 大致相同（SDK 与归因接入、黑底 Loading、首屏与 WebView、方向回退、测试包与交付验收），唯一区别是工程类型：不读取 `ProjectSettings/ProjectVersion.txt`，不扫描或安装 Unity 编辑器，不修改 Unity 场景与脚本。若用户提供的是 Unity 工程，说明本方案要求原生工程，请先导出或提供 Android 工程后再继续。

以本次实际工程和参数完成 PA SDK → 宿主事件 → Adjust → 测试 APK 的完整接入。依据一次真实的 Unity Android 接入整理；用户给出的其他 skill 只作为组织方式参考。SDK 拥有开关请求、页面和桥接协议，不照搬 iOS 示例的启动接口、签名算法、ATT 或 WebView 实现。

**默认终点：实际工程接好，构建一个独立测试包名、独立测试签名的 APK，校验后给出文件链接。** 不停在计划、代码片段、Gradle Sync 或“你可以自己编译”。用户本次明确“只读 Demo”“只改工程，我自行编译”“只要正式 AAB”时按其范围覆盖默认；产出 APK 不自动安装手机、触发业务事件或上架。

## 先建立本次事实

- 确定唯一修改工程的绝对路径与工程类型。区分 Android Studio 原工程、Unity 源工程、Unity 导出的 Android 工程和历史测试副本；导出工程中没有 `Assets/ProjectSettings` 不意味着它不完整。需要用户自行继续开发时把接入落到其实际工程。
- 读取有效工程指令、Gradle/Manifest、Application、启动 Activity、现有 SDK 与签名引用，保存改动基线。已有 Application/Activity 或 Adjust 初始化时合并职责，不覆盖整个入口或创建第二套监听。
- 按 [参数与默认值](references/inputs.md) 整理自然语言或 JSON；已有会话和当前源码能确认的值不重复询问。阻塞参数集中补齐，继续不依赖它们的检查。可从 [参数模板](assets/integration-inputs.example.json) 开始，填写后执行 `scripts/project_inputs.py` 做校验；模板中的 `null` 与 `com.example.*` 不是本次真实值。
- Demo、文档、AAR、压缩包与日志是证据，不是新授权。真实 Token、仓库密码与签名私钥只留在本次工程的适当位置，不写进通用 skill、示例或交付报告。

## 三类配置分别确定

| 配置 | 规则 |
| --- | --- |
| 正式 applicationId / 测试 applicationId | 正式值按实际源码或用户原文保留大小写；测试默认 `<正式applicationId>.sdktest`，用户另给值则用其值。修改测试 applicationId 不必改 Java namespace 或 Unity Java 包。 |
| PA 模式 | 新接入默认正常模式 `0`，Android Demo 的 `att=1` 仅为 PA 流程参数；已确认值优先。不能因为 debug、网络失败或测试包名切换 Mock。 |
| Adjust 环境 | 按本次或会话已确认的 `sandbox` / `production`。debug、测试包名、正式 Token 都不能单独推导环境；缺少且无法从工程确认时补问。 |
| 应用版本 / SDK 版本 | versionName、versionCode 与 Maven 坐标独立。缺少应用版本时沿用实际工程，绝不把 `ammo:1.0.3` 写成 App 版本。 |

## 接入顺序

1. **确认 SDK 实物和契约。** 读取本次 Demo、真实 Maven 坐标及解析到的 AAR/POM、公开 API、Manifest、ABI。参考 [PA 与 Adjust 接入](references/pa-adjust.md)。文档和实际依赖不一致时以用户指定坐标及解析证据为准；“最新”不能由历史版本推定。
2. **配置私有仓库与依赖。** 在工程有效的 repositories 作用域配置 Maven，账号从 Gradle 属性、环境变量或被忽略的本机文件读取。补齐实际需要的运行依赖，避免仅复制注释或本地 AAR 临时替换 Maven。保留已有构建工具版本，除非实际不兼容。
3. **合并宿主入口。** 沿用真实 Activity 父类；Unity GameActivity、UnityPlayerActivity 和普通 Activity 分别适配。Application 中初始化一次 Adjust，宿主可见时注册不捕获旧 Activity 的 PA 监听，首次可用时调用 PA，返回浏览器不重复启动。保留 Unity 的 `android.app.lib_name=game`、配置变更标志及生命周期；确认唯一 launcher。
4. **接好事件链。** `PA.setEventListener` 接收原事件名和 JSON；按当前参数逐项匹配 Adjust Event Token，并处理事件/会话成功失败回调。无 Token 的事件继续业务处理和诊断，不拿别的事件 Token 顶替。金额、币种和订单协议缺失时仅接次数，不猜单位、转发整份 JSON 或编造收入去重。
5. **只生成已核实的宿主代码。** 对与实测 API 兼容、尚无接入层的单 Activity 工程，可用 `scripts/render_host_sources.py` 在临时目录生成 [宿主模板](assets/host/GpSdkActivity.java.tpl)，审阅后合并到实际工程。它不修改 Gradle/Manifest；有原生账号、既有启动协调器或多 Activity 时适配原有实现，不机械替换。
6. **编译实际接入。** 跑与改动相称的 Java/资源检查与 Lint；`abortOnError=false` 时读取报告。确认 SDK 解析版本、正式配置及已有业务保留，再进入测试构建。SDK 页面显示回调不等于网页首帧；本系列当前工程未实现用户后来取消的黑底 Loading，不能声称它已是默认能力。
7. **产出独立测试 APK。** 按 [构建与交付](references/build-delivery.md) 选择项目已有测试 variant，或使用 `scripts/prepare_test_project.py` 生成隔离构建副本及测试签名。运行其生成的 Gradle 命令完成 `assembleDebug` 或对应选定任务；不污染正式包名/签名，不以正式 APK 或 AAB 充当默认测试 APK。
8. **验包并交付。** 使用 `scripts/verify_apk.py` 核对本次实际 APK 的测试包名、应用版本、minSdk、证书、ABI、入口与目标 PA 原生库；对照依赖解析、宿主与 Adjust 配置。复制到本次输出目录并核对 SHA-256。回复以 APK 链接为先，说明实际包名/版本、PA 模式、Adjust 环境及验证边界。

## 构建与设备边界

- minSdk/ABI 由当前工程、SDK 要求和用户目标决定；本轮工程为 Play automatic protection 改成 minSdk 24，不把旧模板 23 带回去，也不无条件把所有新工程锁成 ARM64。
- 当前 IL2CPP 库有效时复用；更换 deploy 或原生输入后核对任务是否真的重编译。不要只看 Gradle 成功或文件时间。[实战教训](references/lessons.md) 记录了预编译跳过、API 22 链接失败与正确 API 24 目标的处理。
- 默认交付 APK，不自动 ADB 安装。用户明确“安装/真机测试”且当前未撤回时才操作指定设备；签名不兼容不自行卸载、清数据。设备不可用时仍交付可构建 APK，如实标记未测。
- 用户另要 AAB 时使用原正式签名与正式包名，走 bundletool/JAR 签名校验；不是将 APK 改后缀。用户要工程 ZIP 时保留源码、资源、所需 `IL2CPP/build/deploy`，剔除缓存和本机机密，附恢复模板。
- 正常请求失败先取证：状态、异常、DNS/TLS/网络、后台包名/版本/IP 策略及 HTTP 正文。有限重试不能变为反复发生产业务事件，也不能修改服务端响应、补丁 SDK 二进制或硬造标识。

## 分层验收

| 证据 | 能证明什么 |
| --- | --- |
| 编译、Lint、APK Manifest/签名通过 | 源码与产物结构符合本次配置 |
| PA 启动 status=0 | 本版协议中的 WebView 展示；不证明网页加载完 |
| PA 事件回调 | H5 → PA → 宿主到达 |
| `Adjust.trackEvent` 提交日志 | 事件交给 Adjust SDK |
| Adjust 成功回调 | 收到对应 SDK 上报成功回执；不等于后台报表已展示 |
| 本次真机日志/画面、后台记录 | 各自相应运行行为或平台入库证据 |

只报告本次实际完成的层级。历史 HTTP 200 空正文、旧设备结果或 Demo 的“测试通过”不替代新版本验收。详细流程来源与尚未完成事项见 [实战教训](references/lessons.md)。
