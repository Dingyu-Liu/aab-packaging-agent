# 新工程接入实施手册

## 1. 读取参数与建立基线

先读取 `assets/integration-params.example.json` 并执行 `scripts/validate_params.py`。确认：

- Unity 源工程绝对路径；
- 正式和测试 applicationId 不同；
- versionName/versionCode；
- PA Maven 坐标和仓库；
- AppsFlyer Dev Key 来源；
- 签名方式；
- 测试 APK 输出目录；
- 是否要求安装和真机验证。

然后检查当前工程是否已有同类实现，不要重复创建第二个 PA 初始化入口或第二个 AppsFlyer 服务。

## 2. Gradle 后处理

在 `Assets/Editor` 中增加或更新 `IPostGenerateGradleAndroidProject`：

1. 在 `settings.gradle` 的 `dependencyResolutionManagement.repositories` 注入私有 Maven 仓库。
2. 在 `unityLibrary/build.gradle` 注入 PA 和 GAID 依赖。
3. 注入 AppsFlyer 的 Unity Android 依赖。
4. 写入或保持 `android.uniquePackageNames=false`。
5. 将 `unityLibrary/src/main/AndroidManifest.xml` 的 Activity `hardwareAccelerated` 改为 `true`。

凭据优先从环境变量或本机私有 properties 读取。若现有工程仍有硬编码凭据，迁移时不要把密码复制到 Skill、日志或交付包。

## 3. Android PA Bridge

Bridge 放在 `Assets/Plugins/Android/...` 的 Java 源码中，使用 Unity 当前 Activity，不另建宿主 Activity。至少提供：

- `requestAdvertisingId(Activity)`：后台获取 GAID，晚到后可更新 PA，不能重启 SDK；
- `setAppsFlyerId(Activity, String)`：把 AF ID 交给 `PA.setPa`；
- `lockStartupPortrait(Activity)`：启动即锁竖屏；
- `start(Activity, int att, String uid)`：主线程调用 `PA.st(0, att, uid, callback, activity)`；
- `reportStatus(int)`：通过 `UnitySendMessage` 回传 0/1/2/3/4；
- 方向监控：Activity 可交互且 WebView 真正消失后才恢复游戏横屏。

UI 线程、Activity 是否 finishing/destroyed、重复 start 都要做保护。所有异常回传失败状态，不让游戏卡在 Loading。

## 4. Unity 启动状态机

不要直接在 `Awake()` 调 SDK。采用以下阶段：

1. `Awake`：竖屏、读取本地 UID、准备 Loading。
2. `Start`：并行请求 GAID、初始化 AppsFlyer、准备 IDFA。
3. AF 归因等待：设置明确超时（参考工程为 5 秒），超时后用 `att=2` 继续。
4. `PA.setPa(AF ID, GAID)` 后启动 `PA.st(0, att, uid, callback, activity)`。
5. 收到 `status=0` 关闭 Loading；其他状态回到游戏。
6. 保持 Loading 页面和 WebView 竖屏，直到失败或关闭。

如果新工程没有 Loading 页面，创建最小覆盖层并让它监听同一 PA 状态；不要把 SDK 页面直接塞进游戏 UI 层级。

## 5. AppsFlyer

- 使用 Unity AppsFlyer 插件；初始化前设置日志级别：仅 development 构建启用 debug。
- `getAppsFlyerId()` 非空是 SDK 初始化的直接证据。
- `onConversionDataSuccess` 才证明归因请求拿到有效响应；`onConversionDataFail` 记录原始错误。
- 测试包名必须在 AF 后台注册；否则 Launch 请求可能 404，但这不是 SDK 初始化失败。
- 不要把 AF 404 改写成空成功值，也不要用正式包名冒充测试包。

## 6. Loading、方向和硬件加速

- Android Manifest 启动方向设为 `portrait`。
- Unity `Awake` 不设置横屏；只在 PA 非 0 或 WebView 关闭后恢复游戏方向。
- WebView 监控不能把 Activity 后台当成关闭：Activity 失焦时跳过关闭判定并重置隐藏计数。
- 关闭判定连续多次成立才恢复横屏并发 `OnPAWebViewClosed`。
- `hardwareAccelerated="true"` 必须写在 `UnityPlayerGameActivity` 的 Activity 节点上，并通过最终 APK/AAB Manifest 核对。

## 7. 测试包构建接口

在工程 Editor 构建脚本中提供稳定入口，例如：

```text
Partner02Build.BuildAndroidTestApk
```

方法必须从参数设置：

- `{formal_application_id}.test`；
- 参数中的 versionName/versionCode；
- 测试 keystore 或 Unity debug signing；
- ARM64；
- portrait；
- hardwareAccelerated true；
- `.test` APK 输出文件名。

构建成功后自动复制到参数指定输出目录。默认不在接入完成后装正式包；用户要求真机验证时只安装测试包。

## 8. Android Studio 与 AAB 只在要求时执行

- Android Studio 导出使用正式 applicationId 和参数版本；不要交付 `local.properties`、`ndkPath` 或构建缓存。
- AAB 使用正式包名、正式版本、正式 keystore；targetSdk/minSdk/ABI 按参数。
- APK 和 AAB 是不同产物：AAB 不能直接 `adb install`。

## 9. 完成条件

至少完成测试 APK 的真实构建和静态校验。用户要求安装时，再完成安装与真机启动。不要因为 SDK 页面能打开就跳过包名、版本、硬件加速和 PA native 校验。

## 模板参数替换

如果直接使用 `assets/Partner02Build.cs.template`，按以下方式替换：

| 参数 | 模板 token |
| --- | --- |
| 测试 applicationId | `__TEST_APPLICATION_ID__` |
| 正式 applicationId | `__FORMAL_APPLICATION_ID__` |
| versionName | `__VERSION_NAME__` |
| versionCode | `__VERSION_CODE__` |
| minSdk / targetSdk | `__MIN_SDK__` / `__TARGET_SDK__` |
| 测试 APK 输出路径 | `__TEST_APK_OUTPUT_PATH__` |
| AAB 输出路径 | `__AAB_OUTPUT_PATH__` |
| Android Studio 输出目录 | `__ANDROID_STUDIO_OUTPUT_PATH__` |
| 正式 keystore / alias | `__FORMAL_KEYSTORE_PATH__` / `__FORMAL_KEY_ALIAS__` |

keystore 密码不填进模板，构建时从 `PARTNER02_KEYSTORE_PASSWORD` 环境变量读取。模板只负责构建；Gradle 依赖注入、Manifest 方向/硬件加速由 `Partner02AndroidBuild` 后处理负责。
