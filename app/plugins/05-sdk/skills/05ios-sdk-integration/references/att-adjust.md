# ATT、PA 与 Adjust 的真实链路

## 授权与启动

实际启动时序：Unity 引擎 ready → UIWindow 可用且 App active → 主线程 ATT → 合法 IDFA → Adjust 初始化 → `PA setPa` → 注册 PA 事件 callback → `PA st` 一次。生命周期多次进入时做 in-flight / once 防重入，回调切回主线程并复查 active。

NotDetermined 只请求一次；已授权取非空、非全零 IDFA；拒绝／受限／未授权传 nil 并清除旧 UserDefaults `IDFA`。缓存不等于当前授权，回前台重新读取，不重复初始化 SDK。系统总跟踪开关与 App 单独开关分开核实；App 已开启时不弹窗是正常状态。

主 App 最终 Info.plist 合并 `NSUserTrackingUsageDescription`。模板来自 iOS17.2+，低于 iOS14 的工程需要 availability 分支及厂商兼容验证；不要无脑复制或擅自提高最低系统版本。本案 UUID 是安装级标识，不是用户账户、App Store ID 或跨卸载稳定标识。

## 业务事件与结果回调

真正的接入点是 `PA setEventCallback:`，demo 展示的是 H5→PA 桥，不含 Adjust 上报实现。事件名保持大小写，不替换 SDK navigationDelegate／JS handler，`openWindow` 由 SDK 外跳，不映射 Adjust。

| 事件 | 本案用途与规则 |
|---|---|
| firstrecharge | 首次充值；使用独立 event token，合法金额／币种时附 revenue |
| login | 登录，独立 token |
| rechargeClick | 充值点击，独立 token |
| register | 注册，独立 token |
| registerClick | 注册点击，独立 token |

新 demo 若有其他事件，只有已提供 token 才增加映射；没有 token 的 logout/recharge 等仍发布 App 业务通知，不猜 token 或滥用 login token。App token 用于 ADJConfig，不能当 event token。

模板 firstrecharge 的 `success` 显式 false/0/no 时不计成功事件；缺少 success 按本案事件名合同处理。金额接受有限正数／完整数字字符串，拒绝 Bool/NaN/Inf/尾部垃圾，currency trim+upper 后三位 A-Z。金额按本案币种单位，不擅自 /100；字段无效仍发业务事件但不伪造收入。换供应商／协议要重新核实。没有订单合同就不编造订单去重。

原始 params 保留给 `PAKitDidReceiveEventNotification`，不整体塞进 Adjust 或打印身份／支付 payload。模板仅添加 `pa_event` 标记。

Adjust v5：`ADJConfig` 与 `initSdk:` 初始化一次，delegate 用强引用单例。`adjustEventTrackingSucceeded:` / `adjustEventTrackingFailed:` 发 `PAKitAdjustDidTrackEventNotification`，携 token、映射事件名、success，失败附 willRetry。Adjust 管理自身重试；失败 delegate 不能再发一次 trackEvent。没有已约定的 H5 结果协议时不注入网页 ACK。

PA 模式与 Adjust environment 独立输入。Debug／测试包不自动切 Sandbox；用户要求正式就用 Production。本案 `setPa:nil b:idfa` 没配 AppsFlyer，不能拿 Adjust ADID 随意填 a。

## 证据边界

业务付款成功、PA callback、Adjust queued、Adjust 结果回调、平台后台入库是不同层。新项目编译和模拟事件只证明桥接代码，不能证明线上收数。不通过真实支付／注册来强行补验证，除非用户明确授权。
