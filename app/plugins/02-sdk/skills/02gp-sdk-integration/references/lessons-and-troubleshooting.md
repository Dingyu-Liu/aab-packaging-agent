# 教训与常见故障

## 版本漂移

`ProjectSettings.asset`、测试构建方法、正式 AAB 方法可能保存不同的 versionName/versionCode。修改版本时三处都要检查，最后以 aapt/bundletool 读到的产物为准。测试构建方法如果仍是旧常量，会生成“看起来新、实际旧版本”的包。

## 测试包 AF 404

AF SDK 初始化和 AF ID 获取成功不代表归因成功。测试包 `...test` 必须被 AppsFlyer 后台识别，否则 Launch 请求会返回 404。日志中的 `app_id` 必须与测试包名完全一致。解决方式是让后台识别该测试包，或使用明确授权的对应包名；不要在代码里把测试包伪装成正式包。

## 后台配置已关闭但网页仍打开

先看 PA 日志中的 `Config request params`、HTTP 状态和响应，不要直接猜缓存。请求中的 `version` 必须与后台配置版本一致；`status=0` 只表示 WebView 展示成功，不表示配置仍然有效。

## Loading 先竖屏后闪横屏

根因通常是 Unity Manifest 启动方向或 `Awake` 设置了横屏，而不是 Java bridge。必须同时保证：

- `ProjectSettings.asset` 启动方向为 Portrait；
- 导出 Manifest Activity 为 portrait；
- `Awake` 不设置 Landscape；
- 游戏横屏只在 PA 失败或 WebView 关闭后恢复。

## WebView 切后台后变横屏

Activity 失焦时 WebView 可能 `isShown()==false`。如果把这种短暂隐藏当成关闭，就会发 `OnPAWebViewClosed` 并恢复游戏横屏。关闭监控必须检查 Activity 是否可交互，并连续多次确认。

## 硬件加速写错层级

`android:hardwareAccelerated="true"` 必须写在 `UnityPlayerGameActivity` 的 `<activity>` 节点。只写 `<application>` 不会达到要求。Unity 重新导出可能覆盖，所以用 Gradle 后处理在生成后修正，并检查最终 APK/AAB。

## Maven 凭据

不要把 Maven 用户名/密码写进 Skill、公开工程或交付 ZIP。使用环境变量或本机私有 properties。导出的 `settings.gradle` 如果被历史后处理直接写入明文，迁移时优先修复。

## NDK 与 Gradle

- 不使用 NDK 28；当前使用 `27.2.12479018`。
- `android.uniquePackageNames=false` 必须保留。
- Unity 构建后 adb server 可能被重启，设备会短暂消失；重新启动 adb 通常可恢复。
- 如果 SDK manager 的远程 `--list` 卡在 SSL，而 `--list_installed` 正常，这是环境网络问题；可临时用本地已安装包列表完成构建，结束后恢复原 sdkmanager。不要把临时 wrapper 交付给用户。
- Gradle native 库或缓存权限问题优先修复缓存/权限，不要靠升级整个工具链掩盖。

## AF debug 与正式包

AF debug 只在 development 构建开启。正式 AAB 使用 `BuildOptions.None`/development false，不能输出 AF DEBUG 日志。测试包可临时设置 log tag 抓详细日志，但不要把 debug 开关带到正式发布配置。

## 正式包和测试包

- 用户要求测试包时，只安装 `.test`，不要用正式包名做“对照”，尤其用户明确禁止时。
- 正式包使用正式签名；测试包使用独立测试签名。
- `.test` 应用和正式应用可以共存，但不要把两者的包名、AF 配置或版本文件混用。

## Android Studio 导出

导出工程不要包含 `local.properties`、`ndkPath`、`build/`、`.gradle/`、`.cxx/`。保留 `ndkVersion`。给 Android Studio 工程补 `gradlew` wrapper，但不要伪造或内置正式私钥。

## 停止条件

同一外部问题在没有新配置、新代码或新日志证据时，不要无限重试或切换 Mock。保留构建产物和失败日志，明确需要后端/后台确认的具体项。
