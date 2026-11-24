---
name: 02gp-sdk-integration
description: Use when a Unity Android project needs 02GP / Partner 02 PA SDK, AppsFlyer and GAID integration, a .test-package APK, Android Studio export, or a signed AAB. Handles parameter-driven onboarding, loading/WebView portrait, Activity hardware acceleration, build validation and device testing. Also use when the user requests “02GPSDK接入”.
metadata:
  version: "2026.11.12.1"
---

# 02GPSDK接入

> **工程类型约定（本方案）**：本方案直接面向 **Android 原生工程**（Gradle / Android Studio），不是 Unity 工程。接入流程与 01 大致相同（SDK 与归因接入、黑底 Loading、首屏与 WebView、方向回退、测试包与交付验收），唯一区别是工程类型：不读取 `ProjectSettings/ProjectVersion.txt`，不扫描或安装 Unity 编辑器，不修改 Unity 场景与脚本。若用户提供的是 Unity 工程，说明本方案要求原生工程，请先导出或提供 Android 工程后再继续。

## 目标

把一个新 Unity Android 工程接入为当前 02 系列的真实形态：PA SDK + AppsFlyer + GAID，按参数生成独立测试包，并在接入完成后默认交付可安装的 `.test` APK。用户明确要求时才追加 Android Studio 工程或正式 AAB。

输入优先使用参数文件 [assets/integration-params.example.json](assets/integration-params.example.json)。先执行 [参数校验脚本](scripts/validate_params.py)，再开始修改工程。参数缺失时从实际工程读取；只有密钥、签名密码等无法从工程安全取得的字段才向用户询问。

## 适用范围与边界

- 适用于 Unity Android 工程、Unity 导出的 Gradle 工程，以及已有 02/PA 接入的升级。
- 当前真实链路是 **PA + AppsFlyer + GAID**，不是 Adjust。用户没有明确要求时，不添加 Adjust SDK、Token 或事件映射。
- Demo、旧 ZIP、另一个构建副本和聊天中的历史结论不能代替当前源码。先确认唯一要修改的 Unity 源工程。
- 用户只要测试包时，不安装正式包；用户只要 AAB 时，不自动安装 APK。

## 真实工程事实（作为基线，不是所有新项目的硬编码值）

当前参考工程的可复用模式：

- PA：`com.pakit.02:squad:1.0.0`，私有 Maven 仓库注入到 Gradle。
- GAID：`com.google.android.gms:play-services-ads-identifier:18.0.0`。
- AppsFlyer：Unity 插件，当前 Android 端为 `6.18.1`。
- 测试包和正式包必须是两个不同 applicationId；测试包使用独立 debug 签名。
- PA 启动固定为 `mode=0`，根据 AppsFlyer 归因结果传 `att=1` 或 `att=2`。
- Loading 和 PA WebView 竖屏；游戏只在 PA 失败或 WebView 真正关闭后恢复横屏。
- `android:hardwareAccelerated="true"` 必须加在 `UnityPlayerGameActivity` 上，不能只加在 `<application>`。
- 当前实际文件、包名、版本历史和代码入口见 [真实工程基线](references/real-project-baseline.md)。

新项目必须使用参数文件中的值覆盖这些示例值；不要照抄 Lucky Quest Squad 的包名或版本。

## 不可违反的规则

1. **先改真实 Unity 源工程**。构建副本可以用于隔离，但最终代码必须同步回源工程。
2. **测试包名和正式包名分离**。接入完成后默认输出 `{formal_application_id}.test` 的测试 APK；不要把正式包名装到测试设备上，除非用户明确要求。
3. **测试包不覆盖正式签名**。测试 APK 使用 debug/测试证书；正式 AAB 使用参数中指定的 keystore。
4. **Maven 凭据不写进 Skill 或公开源码**。使用环境变量或本机私有 properties；交付 ZIP 不含凭据。
5. **PA 的 `setPa` 参数不混用**：第一个是 AppsFlyer ID，第二个是 GAID；业务 UID 只传 `PA.st`。
6. **PA `status=0` 只表示 WebView 已展示**，不表示网页加载完成。Loading 当前以 status 0 关闭，必须保留这个语义说明。
7. **后台切换不是 WebView 关闭**：Activity 失焦时 WebView 也可能 `isShown()==false`。方向监控只在 Activity 可交互时判定关闭，并连续确认。
8. **不要添加 Toast**。事件、状态和错误只保留日志或业务 UI。
9. **硬件加速只改 Activity 属性**。不要把它误写到 application 节点。
10. **不要用 NDK 28**。当前 Unity 工程使用 `27.2.12479018`（r27c）；NDK 28 会导致 IL2CPP 构建失败。
11. **保持 `android.uniquePackageNames=false`**。AppsFlyer 与 purchase-connector 存在重复 namespace。
12. **不要伪造 AF 归因成功**。AF 初始化成功、AF ID 取得、Launch 请求 404/200、网页打开是不同证据。

## 参数驱动接入流程

1. 读取并校验参数文件，确认 `project_path`、Unity 编辑器、正式/测试包名、版本、PA 坐标、AppsFlyer、签名和输出目录。
2. 检查源工程是否已有 PA、AppsFlyer、GAID、Gradle 后处理、Loading 和方向代码；先保存既有差异基线。
3. 完成 Android 接入：私有 Maven、PA 依赖、GAID、AppsFlyer 依赖、Manifest Activity 硬件加速、Java PA bridge。
4. 完成 Unity 启动链路：并行的 GAID/AppsFlyer/IDFA 初始化、归因等待、`PA.setPa`、`PA.st(0, att, uid, callback, activity)`、状态回调和 Loading 关闭。
5. 完成方向控制：启动 Activity/Loading/PA WebView 竖屏；PA 异常或 WebView 关闭后恢复游戏横屏；后台返回不误触发横屏。
6. 构建测试 APK：使用 `.test` applicationId、独立测试签名、参数版本；先核对最终 APK，不拿旧产物顶替。
7. 用户要求时安装真机，按 PID 抓 PA 和 AppsFlyer 日志；最后按交付清单说明已验证和未验证的部分。

详细实现顺序、代码位置和参数映射见 [接入实施手册](references/integration-playbook.md)。

## 默认交付

如果用户说“接入好并给测试包”，默认完成：

```text
{outputs}/{product}-{version}-code{code}-test.apk
```

并在交付中写明：

- 实际测试 applicationId、versionName、versionCode、ABI；
- 测试签名和是否安装到真机；
- PA SDK 解析版本、`libpakit.so` 是否在包内；
- Manifest 是否 Activity 竖屏、Activity 是否开启硬件加速；
- AF 是否初始化、AF ID 是否取得、归因是否成功或 404；
- 哪些只是构建通过，哪些是网络/真机验证通过。

## 参考文件

- [真实工程基线与代码地图](references/real-project-baseline.md)
- [从新工程开始的接入实施手册](references/integration-playbook.md)
- [测试 APK、AAB、真机与日志](references/build-test-and-device.md)
- [教训与常见故障](references/lessons-and-troubleshooting.md)
- [参数模板](assets/integration-params.example.json)
- [测试 APK / AAB / Android Studio 构建脚本模板](assets/Partner02Build.cs.template)
- [参数校验脚本](scripts/validate_params.py)
