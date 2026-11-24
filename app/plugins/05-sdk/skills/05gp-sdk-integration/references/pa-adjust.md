# PA、Unity 宿主和 Adjust 的实际接入

## 适用版本与证据

本节基于实测 `com.pakit.05:ammo:1.0.3`、Adjust Android `5.8.0` 及 Unity `UnityPlayerGameActivity`。新版本先检查实际 AAR/classes.jar/POM/Manifest；这些数字不是未来的“最新版”。模板与以下 API 兼容时才复用。实测 Demo 曾有 README 坐标与 Gradle 坐标不一致，不能靠页面标题确认依赖。

实际链路是：

```text
Application.onCreate → Adjust 初始化
Activity 首次可用 → 注册 PA 业务监听 → PA.setPa → PA.st
PA 自行请求开关 → 挂载其 WebView / 选择不打开
H5 jsBridge.postMessage → PA.setEventListener → 宿主按事件名查 Token
→ Adjust.trackEvent → Adjust 成功或失败回调
```

宿主不直接实现示例 iOS skill 的 `/api_v1/system/get_system_info`、MD5/JSON 排序验签、Facebook 或 ATT。实际 PA SDK 拥有配置请求与网页桥接，不能用另一套 WebView 或 Mock 测试页代替它。

## 依赖与仓库

在 `dependencyResolutionManagement.repositories` 或当前工程真正有效的作用域添加用户的私有 Maven；PREFER_SETTINGS 时只改无效的模块 repositories 不够。可使用 `maven.aliyun.com/repository/public` 镜像，但私有仓库地址按本次参数。

```groovy
// settings.gradle：工程实际结构不同则调整作用域；私有文件不提交。
def gpMavenLocal = new Properties()
def gpMavenFile = file('pakit-maven.local.properties')
if (gpMavenFile.isFile()) {
    gpMavenFile.withInputStream { gpMavenLocal.load(it) }
}
// 放入有效的 repositories { ... } 中
maven {
    url = uri(actualRepositoryUrl)
    credentials {
        username = providers.gradleProperty('pakitMavenUsername')
            .orElse(providers.environmentVariable('PAKIT_MAVEN_USERNAME'))
            .getOrElse(gpMavenLocal.getProperty('pakitMavenUsername', ''))
        password = providers.gradleProperty('pakitMavenPassword')
            .orElse(providers.environmentVariable('PAKIT_MAVEN_PASSWORD'))
            .getOrElse(gpMavenLocal.getProperty('pakitMavenPassword', ''))
    }
    content { includeGroup 'com.pakit.05' }
}
```

`actualRepositoryUrl` 必须替换为本次变量或真实配置，不能把未定义示例直接粘贴进工程。Maven 坐标使用本次指定值。`pakit-maven.local.properties` 设为仅用户读写，并在 `.gitignore` 排除。

实测运行依赖有 `com.android.installreferrer:installreferrer:2.2`、`com.google.android.gms:play-services-ads-identifier:18.2.0`；后者解决过 SDK 反射调用 `AdvertisingIdClient` 缺类。先看目标 AAR/POM、依赖树和实际缺类，避免冲突或无理由升级。Adjust 5.8.0 实际解析到 signature 5.0.0，不用旧版文档另行拼一套签名 SDK。

## PA 入口和生命周期

```java
PA.setPa(afUid, gaid);
PA.setEventListener((eventName, paramsJson) -> { /* 现有业务及 Adjust 适配 */ });
PA.st(mode, att, businessUid, status -> { /* 诊断与实际路由处理 */ }, activity);
```

- `setPa` 的两个参数分别是 AF UID 与 GAID；`st` 的 UID 是业务身份。已有真实账号源时读取其运行时值。无原生账号时，实测工程在 SharedPreferences 持久化 `install-UUID` 作为安装身份；它不是登录用户、广告 ID 或归因 ID。
- 未拿到 AF UID/GAID 时按本版契约传空，不能把 Adjust ADID 或随机 UUID 冒充它们。“宿主传空”也不能推断 SDK 永远不会自己采集。
- `mode=0` 正常请求；原 Demo 的 1/2 为 Mock 不开页/开页；`att=1` 在 Android 只是 PA 参数，不表示申请 iOS ATT 或 Android 权限。
- 使用当前有效 Activity。实测在 `onResume` 注册监听、每个 Activity 实例仅首次通过 decorView.post 启动 PA；启动前检查 finishing/destroyed。浏览器返回只恢复生命周期，不重复发起启动。
- 多 Activity 和重建时明确监听所有权。静态事件适配器不捕获 Activity；旧 Activity 的 `onDestroy` 不得无条件 `setEventListener(null)` 抹掉新 Activity 的监听。也不能简单用静态 `started=true` 永远绑定旧 Activity。
- WebView 调试只随实际 `FLAG_DEBUGGABLE` 开启；事件、启动状态和错误只写必要日志，不添加 Toast，不记录完整业务 JSON、广告 ID 或 Token。

原 Demo 状态：0 WebView 已展示；1 无效配置未打开；2 请求失败；3 解析失败；4 WebView 展示失败。0 不代表 `onPageFinished`、首帧或 H5 `pakitready`。新版本状态以实际契约为准。

PA 1.0.1–1.0.3 的公开 API 没有 domain setter；域名可在 `libpakit.so` 中看到。`strings` 只证明字符串存在，不能证明实际请求/包名白名单已通过。目标域名不匹配时检查制品或向提供方取得正确版本，不补丁二进制 URL，也不编造 `PA.setDomain`。

## Unity 入口与 Manifest

保持真实父类：GameActivity 项目继承 `UnityPlayerGameActivity`；其他 Unity 导出保留其实际类。普通原生工程合并到已有 Application/Activity，不引入 Unity 依赖。

- `android:name` 指向本次 Application/Activity 的真实 Java 类；确认唯一 MAIN/LAUNCHER。必要时对 Unity 库旧 launcher filter 用 manifest merger 精准移除，不能删掉 Unity 库全部配置。
- GameActivity 保留 `android.app.lib_name=game`、`unityplayer.UnityActivity`、原 theme、screenOrientation、configChanges、launchMode 等有意配置。
- applicationId 用于安装身份，namespace/Java package 用于代码解析；测试包可只改前者。Provider authority 应使用 `${applicationId}` 或本次可并存的 authority；硬编码正式 authority 会让测试包与正式包冲突。
- 子类公开继承链缺类时只把必要的 Unity JAR、GameActivity/AppCompat/Core 依赖调整为可见的 `api`；不全局替换 implementation，也不因此升级整个工具链。

## Adjust 适配

实测 `AmmoApplication.onCreate()` 调用适配器初始化一次，5.8.0 的 provider 会注册 Activity 生命周期；检查实际合并 Manifest/API 后决定是否需要手动生命周期，不能同时复制旧 `onResume/onPause` 逻辑造成重复。

```java
AdjustConfig config = new AdjustConfig(application, appToken, chosenEnvironment);
config.setOnEventTrackingSucceededListener(result -> logAcknowledgement(result.callbackId));
config.setOnEventTrackingFailedListener(result -> logFailure(result.callbackId, result.willRetry));
// session 成功/失败监听同样配置；以上 log... 是宿主实现的示意方法。
Adjust.initSdk(config);
```

PA callback 中按精确事件名查当前 `event_tokens`：`firstrecharge`、`login`、`rechargeClick`、`register`、`registerClick` 是本次实际接过的名称，不是只允许这五个事件的全局白名单。用户给了其他事件 Token 则按同样方式扩展；同名参数拼写不能偷偷改成另一事件。

```java
AdjustEvent event = new AdjustEvent(tokenForExactEventName);
event.setCallbackId(eventName);
Adjust.trackEvent(event);
```

未配置的 `logout/recharge/enterGame` 和自定义事件仍保留原业务处理及简短诊断，不传空 Token、不复用充值 Token。发生 `RuntimeException` 时记录上报失败，不能让 H5 桥事件导致宿主崩溃。

`setCallbackId` 仅关联回调，不是订单去重 ID。失败回调 `willRetry=true` 时不要无条件再次调用 `trackEvent`，避免与 SDK 自身重试叠加。

当前只接次数。需要收入或去重时先核实金额类型、最小单位/主单位、币种和真实订单 ID；按实际 SDK 的 revenue/去重 API 实现，并确保同一订单规则清楚。不能从 Demo 的金额样例推定正式协议。

H5 本版等待 `pakitready` 并检查 `window.PAKit.ready` / `window.jsBridge.postMessage` 后发原始事件和 JSON。`openWindow` 按 SDK 的 HTTP(S) 浏览器规则处理，不自行将它转为 Adjust 业务事件。不要为了证明回调就实际提交生产充值或注册。
