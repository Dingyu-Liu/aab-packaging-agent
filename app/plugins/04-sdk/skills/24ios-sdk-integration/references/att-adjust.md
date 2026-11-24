# ATT 与 Adjust

## 启动顺序

当前 Unity 模板在 `startUnity` 和 `applicationDidBecomeActive:` 之后调度检查，只有主线程、App active、窗口显示、Unity `engineLoadState` 达到 AppReady 才开始。不会把等待 ATT 的时间计入网页 60 秒超时。

- `notDetermined`：每次启动最多发起一次系统请求，记录请求进行中；回调切回主线程并再次检查前台和实际状态。
- 已授权：读取 IDFA，拒绝空值或全零值，再向当前 SDK 传入。
- 拒绝／受限／未得到授权：删除历史 IDFA 缓存并传空值，继续正常启动。不要每 0.5 秒重试十次，也不要仿制系统授权弹窗。
- 前台恢复时重新读取权限；`dispatch_once` 仅控制 SDK 初始化，不把第一次授权状态永久缓存。

主 App 的最终 Info.plist 必须有符合实际用途的 `NSUserTrackingUsageDescription`。模板源实现已在 iOS 17.2+ 工程编译，未包含 iOS 14 以下的完整兼容分支。新工程若支持更旧系统，按 deployment target 为 ATT 访问加 availability 分支，并验证 SDK 本身可运行；不要为了省事提高用户最低版本。

系统跟踪列表里 App 已开启时不再弹一次并不代表接入失败。排查时区分系统总开关、App 单独状态、是否已有授权、App 是否 active、最终安装包是否含用途说明。不要让用户重装或重置所有隐私设置来代替读取当前授权证据。

## 业务事件桥

先注册 `PA setEventCallback:`，再启动 PA。模板在主线程转交 Adjust，并发布 App 内 `PAKitDidReceiveEventNotification`。保留原始业务参数，日志不打印 IDFA、账号标识或支付 payload。

事件名区分大小写，当前已核实的桥包括：

| 业务事件 | 配置项 |
|---|---|
| `firstrecharge` | 对应的首次充值事件 token |
| `login` | 对应的登录事件 token |
| `rechargeClick` | 对应的充值点击事件 token |
| `register` | 对应的注册事件 token |
| `registerClick` | 对应的注册点击事件 token |

Adjust App token 用来初始化；每种事件使用各自 event token，不能用 App Store ID 或 App token 代替。用户 demo 若还有其他事件，按实际合同补齐映射。未配置的事件不编造 token；可以继续走 App 业务通知。

`openWindow` 在该 PA 头文件合同中不经此业务回调处理；不要替换其 WebKit 委托、JavaScript handler 或自行发明回调协议。

## Adjust 初始化与结果

模板采用 Adjust v5：`ADJConfig`、`ADJEnvironmentProduction/Sandbox`、`[Adjust initSdk:config]`、`ADJEvent`、`[Adjust trackEvent:event]`。ATT 结束后初始化一次，保留现有 App 的 delegate／业务处理，必要时做代理分发，不能覆盖其他集成。

SDK 模式、Adjust 环境、正式／测试包名独立配置。用户要求正式环境时，即使 Debug 或临时测试包名也使用 Production；没有要求时根据项目已有约定明确选定，不能让宏静默覆盖。

`firstrecharge` 显式 `success=false/0/no` 不应算首次付款；缺少 success 是否可依赖事件名，需要 demo 合同支持。本模板沿用已核实的该合同。金额以 demo 定义的单位读取，不自动除以 100；有效有限正数和合法格式的三位币种才调用 `setRevenue`。金额缺失或无效仍可发业务事件，不伪造收入。不同 SDK 的成功和单位语义必须重新核实。

Adjust 上报成功／失败由 `AdjustDelegate` 处理，并通过 `PAKitAdjustDidTrackEventNotification` 发给 App，包含 token、对应事件名、success、失败的 willRetry。它与网页支付成功是不同层次。Adjust 自己管理重试，delegate 失败回调不要再次 `trackEvent`；没有文档协议时不向网页注入“确认上报”JS。

模板 `setPa:nil b:idfa` 未配置 AppsFlyer；不要把 Adjust device ID 填入供应商参数 a，除非新 SDK 文档明确要求。安装 UUID 仅是安装标识，不是登录用户 ID，也不保证跨卸载保留。

## 验证范围

检查事件从 PA 回调到 token 映射、Adjust 调用及 delegate 结果的完整链路。模拟调用只能证明桥接代码，不能证明 Adjust 线上收录；业务页面和归因后台结果需实际观察。不要为测试主动产生真实支付、注册或对外消息，除非用户已授权该操作。
