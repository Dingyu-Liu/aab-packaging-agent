# Facebook 配置、事件与 TLS 排查

适用于 Unity/iOS 的 FB 事件缺失、`FB.IsInitialized` 为真但后台无事件、App ID 变成 `0`、`/0/activities`、`FBSDK secure network request failed`、`Flush Result : No Connectivity`。

以下具体 API/行为已核对 Facebook Unity SDK 18.1.1 的 `FacebookSettings.cs`、`FB.cs`、`FBUnityInterface.mm`，以及 iOS SDK 18.1.0 的 `FBSDKAppEvents.m`、`FBSDKGraphRequestConnection.m`。其他版本先查当前工程实际源码/API；不要因此升级或固定所有项目的 SDK 版本。

## 先核对实际应用身份

| 层级 | 要核对的证据 |
|---|---|
| 工程输入 | 当前项目的 FB App ID、客户端口令及所选应用索引；沿用已经授权的参数 |
| Unity Resources | 持久化的 `FacebookSettings.asset`，能够在重新打开 Editor 或新进程后被 `Resources.Load` 找到；值与输入一致 |
| 导出及签名包 | 实际 `.app/Info.plist` 的 Facebook App ID/客户端口令；口令只输出相等/不等结果 |
| 初始化后 | 记录实际 `FB.AppId` 并与配置比较；`FB.IsInitialized` 单独为真不够 |
| 本次原生请求 | 从 SDK 日志确认真实主机及 `/{appId}/activities` 等请求中的目标 ID；不能用自己构造的 URL 代替实际请求 |

**Info.plist 正确不能排除 Unity 初始化覆盖它。** 在上述 Unity SDK 中，`FacebookSettings.Instance` 找不到 Resources 资源时只会 `CreateInstance` 一个内存对象，默认 App ID 是 `"0"`。`SetDirty` 与 `SaveAssets` 不会把尚未属于 AssetDatabase 的对象自动创建成资源。编辑器当次会话的值可能正确，重新启动或真机却回到默认值。

无参数配置的 `FB.Init(callback)` 读取 `FacebookSettings`；iOS 桥又把传入 ID 写入原生 `FBSDKSettings`。因此启动早期可以使用正确 Info.plist，随后请求却变成 `/0/activities`。发现 TLS 报错后仍需核对这些身份层级，配置错误与网络错误可以同时存在。

## 配置持久化与显式初始化

复用现有设置资源，避免制造多个同名 Resources 资源。仅当实例尚未持久化时才创建资源；路径已存在却不能加载时先诊断，不能覆盖未知资产。多应用设置按已选槽位更新，不用下面的单应用示例清空其他应用。

Editor 侧示例（放在 Editor 程序集，`config` 是当前项目已解析的配置）：

```csharp
// Assets/Resources 已存在；没有时先用 AssetDatabase 创建该文件夹。
var settings = FacebookSettings.Instance;
if (!AssetDatabase.Contains(settings)) {
    const string path = "Assets/Resources/FacebookSettings.asset";
    if (System.IO.File.Exists(path))
        throw new BuildFailedException("Existing Facebook settings could not be loaded.");
    AssetDatabase.CreateAsset(settings, path);
}
FacebookSettings.SelectedAppIndex = 0;
FacebookSettings.AppIds = new List<string> { config.facebookAppId };
FacebookSettings.ClientTokens = new List<string> { config.facebookClientToken };
EditorUtility.SetDirty(settings);
AssetDatabase.SaveAssets();
```

运行时优先使用当前 SDK 支持的显式参数重载，并在回调验证实际身份：

```csharp
FB.Init(appId: config.facebookAppId,
        clientToken: config.facebookClientToken,
        onInitComplete: () => {
    bool ready = FB.IsInitialized && string.Equals(
        FB.AppId, config.facebookAppId, StringComparison.Ordinal);
    // ready 为真后才进入现有 ATT 状态同步和激活流程。
    // 不匹配时记录失败，不能发送事件或返回初始化成功。
});
```

显式传参和持久化都要处理：前者避免运行时误用默认值，后者保证 Editor、SDK 构建回调和重新导出使用一致配置。已经初始化的分支也检查实际 App ID；发现不一致时检查更早的初始化来源，不假装重新调用一定能重置 SDK。

自动事件和初始广告 ID 收集设置按当前项目策略同步；真实跟踪状态沿用已有 ATT 流程。不要为了排查而强制允许跟踪或打开所有自动埋点。在已核对的 iOS SDK 18.1.0 中，关闭自动事件不等于关闭显式 `FB.ActivateApp()`；后者仍走安装发布和会话激活逻辑。无明确业务事件清单时，不新增购买、收入或自定义测试事件。

## 事件证据逐层验证

依次分清：初始化完成 → 实际 App ID 正确 → ATT 状态与激活调用 → 事件产生/交给 SDK → 正确目标请求 → SDK 发送结果 → 后台事件记录。

- `FB.ActivateApp()` 被调用、`FB.LogAppEvent()` 返回、桥回执 `ok:true` 都不是后台收数证明。
- 观察到 `fb_mobile_activate_app` 或 `MOBILE_APP_INSTALL` 说明对应事件出现在本次 SDK 流程中，仍需检查目标 ID 和发送结果。批次可能含缓存事件，不能把全部事件都算作本次触发；核对事件时间/关联标识。
- `Flush Result : No Connectivity` 是发送未成功的证据；初始化已成功也可能出现它。`Flush Result : Success` 也需关联本次应用、事件/批次，后台入库和归因仍单独验收。
- 自定义 H5 事件先查网页是否实际调用 `onFacebookEvent`，以及原生回执；不能只冷启动就宣称购买/注册等业务事件已测。
- 验收时间覆盖当前 SDK 的异步初始化、批量发送和请求超时；网页几秒内打开不代表 FB 请求已完成。日志记录 runId、观察起止时间，停止采集后统一统计，或保留明确的窗口快照，避免后续追加日志与早期计数混用。

## TLS 归因：主机、设备和请求阶段必须一致

在已核对的 iOS SDK 18.1.0 中，`FBSDK secure network request failed` 对应安全连接失败（`NSURLErrorDomain` / `kCFURLErrorSecureConnectionFailed`，-1200）；-1001 是超时。核对当前版本和实际原生错误链，不把任意 SDK 报错都归为 TLS。

1. 从失败请求提取实际主机、错误域/码、时间及是否已有 HTTP 响应。Facebook SDK 可能访问 `ep1.facebook.com`、`ep2.facebook.com`，不能只检查 `graph.facebook.com`，也不能把这些示例固定为所有版本的端点。
2. 分开记录业务入口域名、Facebook 域名、AppsFlyer 域名。业务入口 HTTP 200 或网页打开，不能证明 FB 链路正常；FB 主机握手失败，也不能据此认定用户的业务后台故障。
3. 电脑通过同一 FB 主机的 TLS，只证明电脑这条链路；手机 -1200 时优先做同一手机/同一主机的网络或代理对照，区分设备、网关/运营商、代理和远端握手差异。仅凭一条错误不能断言某个具体责任方。未明确授权，不改变用户整机网络或代理设置。
4. 匿名探测得到 HTTP 400 可说明已经完成 TLS 并到达 HTTP 阶段，不说明业务请求成功。用 App ID/客户端口令做只读应用身份查询得到 200，只支持该次查询，不等于手机事件发送或后台入库。
5. App ID 错误与 TLS 错误分别修复、分别验收。修正 `/0/activities` 不等于 TLS 已恢复；不能用关闭证书校验、扩大 ATS 例外或任意更换 SDK 服务端点掩盖握手错误。无新证据或网络状态变化时，不重复构建/重装碰运气。

## 诊断、回归与普通包收尾

- 必要时显式启用当前 SDK 支持的事件/网络日志；本版本支持 Info.plist 的 `FacebookLoggingBehavior`，值可含 `app_events`、`network_requests`、`developer_errors`。保存原值，只用于本次诊断；诊断包与普通包的身份/哈希、安装记录分开。
- 网络日志可能含客户端口令、访问令牌、设备标识和事件参数。原始日志保存在受控的本地工作目录；共享报告只保留脱敏的应用身份匹配、主机、阶段、错误码和发送结果。skill 中只使用配置变量或占位符。
- 配置回归测试检查真实 Resources 资源、AssetDatabase 持久化、重新加载后的 App ID/口令一致性。口令断言比较布尔结果，不能让失败输出泄露值。先复现缺资源失败，再验证修复；源码 grep 或当次静态单例值不能代替它。
- 真机回归核对初始化后的实际 App ID、正确 `/{appId}/activities` 请求、零 ID 请求消失、激活事件及发送结果。若只修复了应用身份且网络仍失败，明确交付“身份已修复，发送/后台未确认”。
- 按 [交付收尾](delivery.md) 恢复本次增加的详细日志、临时入口和测试行为，安装已核验的普通包并再次冷启动。只恢复源代码或导出 Info.plist 不证明手机已经换回普通包。
- Editor 回归测试随源码交付，不能进入 Player。检查测试类未编入 Player 时，只扫描 app/IL2CPP/原生二进制；不要将合法 Editor 测试类加入整个源码 ZIP 的禁止标识或从交付工程删掉测试。

可在 [输入模板](../assets/integration-inputs.example.json) 的 `facebook.verification` 记录结果；未测项保持 false/null，不据这些字段自动宣称后台通过。
