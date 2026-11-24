# 真实工程基线

本文件记录 Lucky Quest Squad / Partner 02 的实际接入形态，用来理解流程。新工程的值以参数文件为准。

## 当前应用身份

| 用途 | applicationId | 版本 |
| --- | --- | --- |
| 正式包 | `com.LuckyQuestSquadSynthesize.Squad` | `1.0.7 (9)` |
| 测试包 | `com.LuckyQuestSquadSynthesize.Squad.test` | 测试构建方法当前仍可能保留上一版本；接到任务时先从参数更新 |

重要教训：源工程 `ProjectSettings.asset`、测试构建方法、正式 AAB 构建方法可能各自保存版本号。只看其中一个会误判。产物必须用 aapt/bundletool 核对实际包名和版本。

## SDK 与依赖

- PA Maven：`com.pakit.02:squad:1.0.0`
- GAID：`com.google.android.gms:play-services-ads-identifier:18.0.0`
- AppsFlyer Android：`6.18.1` 系列
- Gradle：`android.uniquePackageNames=false`
- 私有 Maven 仓库：使用 `Partner02AndroidBuild.cs` 中的仓库地址；账号密码应来自私有配置，不写入 Skill 或交付 ZIP

## Unity 启动链

1. `AppBootstrap.Awake()` 设置竖屏并调用 `PAIOSNative.LockPortrait()`。
2. `Start()` 并行请求 GAID、初始化 AppsFlyer、处理 IDFA。
3. AppsFlyer 归因最多等待约 5 秒。
4. `PA.setPa(AppsFlyerId, GAID)`。
5. `PA.st(0, att, businessUid, callback, currentActivity)`，其中 `att=1` 表示有归因响应，否则 `att=2`。
6. PA 回调 `status=0` 时关闭 Loading 并显示 WebView；非 0 时回到游戏并恢复横屏。
7. WebView 关闭后恢复游戏横屏。

## 实际代码入口

| 功能 | 文件 |
| --- | --- |
| Unity 启动、归因等待、PA 启动 | `Assets/Scripts/AppBootstrap.cs` |
| AF 初始化和归因回调 | `Assets/Scripts/DemoAppsFlyerService.cs` |
| Unity 到 Android 的调用 | `Assets/Scripts/PAIOSNative.cs` |
| Android PA bridge、GAID、方向监控 | `Assets/Plugins/Android/com/luckyquestsquad/bridge/PAAndroidBridge.java` |
| Gradle 依赖注入和 Manifest 修正 | `Assets/Editor/Partner02AndroidBuild.cs` |
| 测试 APK、AAB、Android Studio 导出 | `Assets/Editor/AutoChessBuild.cs` |
| Loading 页面和主场景方向 | `Assets/Scripts/AutoChessPrototype.cs` |

如果新工程的启动脚本不同，保留同样的阶段和状态机，而不是照抄类名。

## 当前 Android 行为

- Manifest 启动 Activity：`com.unity3d.player.UnityPlayerGameActivity`
- Loading 和 PA WebView：竖屏 `portrait`
- Activity 硬件加速：`true`
- 游戏横屏：只在 PA 失败或 WebView 关闭后恢复
- `hardwareAccelerated` 必须在 `<activity>` 上，不是 `<application>` 上

`Partner02AndroidBuild.cs` 在 Gradle 生成后把 unityLibrary Manifest 的 `android:hardwareAccelerated="false"` 替换成 `true`。这段逻辑应保留，否则 Unity 重新导出会回到默认值。

## 真实证据样例

测试包在真机上的 AF 日志曾出现：

- `AppsFlyer SDK 版本：version: 6.18.1 (build 383)；debugLog=True`
- `AppsFlyer ID 已获取并保存`
- `POST .../androidevent?...app_id=com.LuckyQuestSquadSynthesize.Squad.test`
- `response code:404 Not Found`
- `Launch status code: 404`

结论：SDK 初始化和 AF ID 获取成功，但测试包名没有被 AF 后台识别，归因失败。不要把这个 404 误判为 SDK 没初始化。

## 构建设备与工具链

- Unity 6000.3.20f1（以实际工程为准）
- JDK 17
- Android NDK r27c：`27.2.12479018`
- targetSdk 36、minSdk 25、ARM64
- 测试 APK 可使用 Unity debug signing；正式 AAB 使用工程上传证书
