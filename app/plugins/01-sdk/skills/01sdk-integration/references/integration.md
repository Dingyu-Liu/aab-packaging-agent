# 参数、SDK 与启动接口

## 参数清单

使用 `../assets/integration-inputs.example.json` 作为记录格式；字段为空表示未知，不表示可以猜值。

| 范围 | 应确认的内容 |
|---|---|
| 工程 | 源工程、Demo、Unity 版本、目标平台、游戏入口 |
| 应用 | App Store 数字 ID、既有 Bundle ID、独立测试 Bundle ID |
| 归因 | AppsFlyer Dev Key / App ID，或 Adjust App Token / 环境；事件名称或 token 对照 |
| Facebook | App ID、Client Token、显示名、需要的事件 |
| 业务入口 | 完整 URL（含路径）、channel、归因字段结构、Content-Type、签名方式和样例、空归因约定 |
| iOS | ATT 文案与时序、开发团队、设备、开发包或发布包 |
| H5 | 指令名、参数类型、requestId、回执、外链/方向/业务消息行为 |

用户明确允许沿用 Demo 时，记录沿用的具体项。不能将这项授权延续到无关的新项目。App Store ID 不能替代 Bundle ID；只有明确采用下述 01 AF 契约或后台另行确认时，才使用 `appsflyer` 字段，不能仅由“SDK 换成 AF”推断。

未知的后台字段可作为明确标注、可配置的暂定适配，但保留失败兜底并报告未验证。不要把推测写成接口已经联调通过。

## 01 系列入口地址与签名配置

以下是用户确认的 **01 系列入口约定**，适用于明确沿用该协议的工程。域名、渠道和签名密钥取当前项目；其他供应商或已有不同协议的项目仍以其实际契约为准。已确认采用本约定、且项目已有密钥时，不要再次把接口路径或签名方式当成缺失信息询问。

### 完整配置示例

可直接参照 [配置示例 JSON](../assets/entry-api-config.example.json)：

```json
{
  "entryUrl": "https://jumpdashpixelescape.online/api_v1/system/get_system_info",
  "channel": "US_IOS_B_MJUMPDASH",
  "signingKey": "@1%ss(&@1v%mf-z5(#p26slu#&v-do9awafskpsytylw#6xp#s",
  "entryContentType": "application/x-www-form-urlencoded;charset=UTF-8"
}
```

- 地址规则：`https://{当前工程请求域名}/api_v1/system/get_system_info`。例如新工程域名为 `bounce.example.org`，则完整地址是 `https://bounce.example.org/api_v1/system/get_system_info`。
- 用户已提供完整 URL 时保留其路径，不再追加一次后缀；处理已带 `https://` 或尾斜杠的域名时避免重复协议、双斜杠和重复路径。不要自行增加 `www`、`api` 等子域名。
- `channel` 使用本工程渠道号，不能照搬示例中的 Jump Dash 渠道。
- 示例中的 `signingKey` 是全工程共享的 01 入口签名密钥，所有 01 系列工程统一使用该值。工程配置已有 `signingKey` 时必须与共享值一致；不一致时停止并报告，不要自行替换。不要把 AF Dev Key、FB Client Token 当成入口签名密钥；该密钥不得出现在交付报告、日志或对外消息中。
- 这是运行时的扁平字段示例；在 [输入模板](../assets/integration-inputs.example.json) 中对应 `entryApi.url`、`entryApi.channel`、`entryApi.signingKey`、`entryApi.contentType`。不要因为两份文件字段层级不同而漏配。

### 请求体与签名

本 AF 版本约定使用 **POST + UTF-8 JSON 请求体**，同时保留上述服务端实际采用的表单 Content-Type；不是 URL 编码后的表单体。不要擅自把请求头改成 `application/json`，也不要把 JSON 改成表单序列化。若新后台明确采用不同编码，则按新契约适配和验证。

| 请求字段 | 类型与来源 |
|---|---|
| `appsflyer` | SDK 真实 conversion data 的副本，补真实 `appsflyer_id`；均不可用时为 `""`，不伪造 Organic 等字段 |
| `channel` | 当前工程渠道字符串 |
| `os` | 本 iOS 接入固定为 `"ios"` |
| `params` | 该约定下的空对象 `{}`，不是空字符串 |
| `sys_l` | 真实系统语言，例如 `en-US`、`zh-CN` |
| `sign` | 下述算法生成的小写 MD5 字符串；签名密钥本身不进入请求体 |

签名步骤：

1. 先构造不含 `sign` 的请求对象；保持数字、布尔值、空字符串和对象的原始 JSON 类型。
2. 对顶层及嵌套对象的属性按 ordinal 排序；数组保留原顺序。组装顶层 `key=value` 时，顶层字符串取其值本身、不带外层引号；其他顶层值使用紧凑 JSON（无缩进、无多余空格），嵌套字符串仍保留合法 JSON 引号和转义。使用与当前工程相同的序列化规则；本示例对应 Newtonsoft `Formatting.None` 的默认转义，Unicode 不强制转为 ASCII `\u`，布尔值为 JSON 的 `true`/`false`。跨语言实现时另用 Unicode、嵌套字段和实际数值样例对照，不能仅凭空归因向量就认定所有签名一致。
3. 顶层按 `key=value` 组装，用 `&` 连接；末尾**直接追加**解析后的签名密钥，不额外加分隔符，不 `Trim`、不 URL 编码、不修改合法引号或空白。
4. 对整个字符串取 UTF-8 字节，计算 MD5 并输出小写十六进制；把结果写入请求的 `sign` 字段，再将完整请求序列化为 JSON——请求体必须使用与签名相同的递归排序序列化，见下条。
5. **请求体与签名原文必须同序。** 本类后台按请求体里的原始 JSON 文本复核签名，不会重新解析后再规范化。因此 `appsflyer` 等嵌套对象在请求体里也必须按 ordinal 排序输出，不能只让签名原文有序、请求体却沿用运行时的字典/插入顺序。2026-10-29 实测（Sprite Gold Spin Rush 真机）：iOS `NSJSONSerialization` 输出的归因字典键顺序与签名原文不同；同一 `sign` 下，嵌套键排序的请求体返回 `ret:0`，原生顺序与逆序的请求体都返回 HTTP 200 + `ret:994 Invalid parameter signature`。Editor 空归因时 `appsflyer` 为 `""`，不涉及嵌套顺序，所以这类缺陷只在带真实归因的真机上暴露。

下面的固定自检向量仅使用合成密钥，不能用来替换工程密钥：

```text
签名前缀：appsflyer=&channel=US_IOS_B_MJUMPDASH&os=ios&params={}&sys_l=en-US
合成密钥：DEMO_ONLY_NOT_A_REAL_KEY
期望 sign：27dbf0fd7d2eb6425473b6c8718fa73d
```

签名迁移仍需遵循下文的解析值/UTF-8 字节一致性检查，尤其不要把 YAML 的语法引号复制进实际密钥。

### 返回值与显示路由

```json
{"ret": 0, "data": {"spare_url": ""}}
```

在本约定中，`ret: 0` 表示本次业务请求成功；上例仍没有网页地址，应进入原生游戏。它不等于 SDK 没加载，也不等于网页加载成功。只有业务成功且 `data.spare_url` 为有效 HTTP/HTTPS URL，才开始加载网页；非零业务码、错误响应类型、缺失/无效 URL 和网络失败均进入兜底。返回 `time` 等额外字段时保留实际原始响应，不自行补造字段。

拿到 URL 后继续显示黑底 Loading，直到当前网页首帧可显示；具体规则见 [启动显示与刘海安全区](startup-presentation.md)。每次联调区分电脑空归因探测、真机真实归因请求、网页加载结果和 SDK 后台入库，不用历史响应替代本次结果。

## 工程与既有改动基准

在读取或评价事件解析之前记录当前工程绝对路径。用户引用另一对话或说“已加别名/已修模拟器请求”时，先读取引用，再读当前工程对应文件，比较启动脚本、事件解析、回包和配置。其他对话是定位线索；磁盘上的现版才是本次修改对象。保留已有兼容，并用回归用例覆盖；不能把旧包或旧目录中的缺失说成当前工程缺失。

反馈有歧义时先指出已验证的差异；不要把当前项目尚未读取的逻辑解释为不存在。修复前保存相关文件哈希或差异，交付时确认未回退别名、模拟器请求、原始参数和已修正的签名。

## 核对 Demo 的实际实现

沿调用链读取初始化组件、启动入口、配置资产、请求构造、UI 路由、原生插件和构建回调。重点识别：

- 文档默认值与配置资产实际值不同，例如归因等待超时。
- SDK 目录版本、unitypackage 文件名、原生 Pod/Maven 版本不同。
- 渠道或事件 token 硬编码在调用端，而非文档声称的配置处。
- 请求体是 JSON，Content-Type 却声明表单；以服务器契约和实际响应验证为准。
- 签名原文泄露密钥/设备 ID、无请求超时、回调永久等待。
- HTML 指令名与 native switch 不一致，例如 `openExternal` 与 `openURL`。
- 历史 C# DllImport 仍编入 iOS，但对应插件已禁用；编辑器可编译不代表 iOS 能链接。

依赖来自用户授权的 Demo 或官方发行源。固定项目选定版本并核对实际 API；不要把某次成功的版本固定成所有项目的“最新版”。Unity 插件与原生 SDK 的版本号分别记录。

## SDK 与生命周期

- AppsFlyer 的 `initSDK/startSDK` 等函数名属于特定版本，后续大版本可能不同。以已导入源码/官方对应版本说明为准。
- ATT 请求必须带用途说明并在合适的应用活跃状态进行。等待有上限；拒绝或未决定不能导致游戏一直停在启动画面。
- 授权可能晚于启动超时，或之后在系统设置里改变。回到前台时重读状态，再同步 SDK 支持的跟踪设置。
- 保证 native callback 接收对象稳定、常驻且方法未被 IL2CPP 裁剪。启用 AppsFlyer HTTP 响应事件时，检查当前 SDK 的 UnitySendMessage 接收组件是否也在目标对象上。
- 区分初始化完成、归因回调完成、SDK 请求响应。编辑器没有 native SDK 时如实表示归因/事件不可用，不伪造上报成功；这不等于跳过业务入口请求。是否请求入口按用户要求和平台实际网络能力决定。
- Facebook 初始化、应用激活与自定义事件按任务接入；无事件清单时不擅自设计收入/购买埋点。
- FacebookSettings 内存赋值不等于 Resources 已持久化；显式初始化参数、实际 `FB.AppId` 和请求路径也需一致。具体修复、自动事件开关判读和 TLS 归因见 [Facebook 配置、事件与 TLS](facebook-events.md)。

## 启动与回退

典型流程是：初始化/授权 → 有上限地等待归因 → 读取有效缓存或请求入口 → WebView 或原生游戏。01 默认系统启动页、黑底单一 Loading、默认网页均为 Portrait 竖屏，网页内容使用系统安全区；失败回退才恢复原生游戏方向。首帧设置与阶段规则见 [启动显示与刘海安全区](startup-presentation.md)。缓存和归因等待的先后关系按业务约定确定。

将项目的原生游戏创建逻辑接到路由决策之后。使用薄适配层连接现有 UI，不必搬入 Demo 的整套 UIManager。网络失败、配置无效、响应缺字段、网页超时、WebKit 内容进程终止均应有明确终态。

方向接回：默认启动与网页使用竖屏，进入原生游戏时交还游戏自己的契约。在施加任何竖屏启动覆盖前保存原方向与四个 `Screen.autorotateTo*` 开关；若导出已临时设为 Portrait，原值需从源工程捕获并独立写入随包配置，不能运行期再把覆盖后的 Portrait 记成游戏原方向。回退时使网页晚到回调失效，解除网页 UIKit 限制，再恢复原方向及开关。横屏游戏恢复原生横屏，竖屏/AutoRotation 游戏分别恢复自己的设置；改变游戏方向属于独立产品改动。H5 现有显式方向协议保留，详见 [分阶段方向实现](startup-presentation.md#按阶段控制方向)。

使用协程时，异常可能发生在 `MoveNext/Current` 和嵌套 IEnumerator 中。只在创建 IEnumerator 的调用外包一层 try/catch 不足以保护流程。销毁/取消时清理请求、事件订阅、回调和临时 UI。

缓存按应用/渠道隔离，首次网页加载成功后再记录；失败缓存需要失效策略。应用切换 SDK 或渠道时验证缓存不会绕过新流程。

## 签名规则

### 配置迁移先验证解析后的值

优先通过 Unity 的序列化对象/API 读取配置值；离线处理文本 `.asset`、YAML 或 JSON 时使用对应格式的解析器。只提取 `sign:` 后面的原始文本会把 YAML 语法当作密钥内容。不得以正则截取、`split(':')`、`strip("\"'")` 或统一 `Trim` 代替解析。

无密钥示例：

```yaml
sign: 'example-secret'
```

正确迁移为 `{"signingKey":"example-secret"}`；`{"signingKey":"'example-secret'"}` 多了两个实际字符。双引号转义、单引号内的 `''`、字符串本身包含的引号及前后空格应保留其解析后的真实内容。只有源配置证实它们是语法定界符时，才从迁移值中移除。

一次已证实的迁移故障中，正确解析后密钥长 50 个字符，目标值却长 52 个字符。多出的两个 YAML 单引号进入 MD5 原文，导致接口返回 HTTP 200、`ret: 994`、`Invalid parameter signature`。只修正这两个字符后，同一请求返回 `ret: 0` 和 `data.spare_url`；随后真实设备也通过验签并进入网页。**50/52、994/0 是这次案例的观测值，不是通用密钥长度或错误码规则。**

迁移时比较解析后字符串和 UTF-8 字节是否完全一致。报告只写一致性、字符/字节长度和错误分类，不打印密钥、完整签名原文或解析器带出的密钥行。可用 [只读密钥比较脚本](../scripts/check_signing_key.py)：

```sh
python3 scripts/check_signing_key.py --source /path/to/DemoConfig.asset --target /path/to/IntegrationConfig.json
```

默认字段为 `MonoBehaviour.sign` → `signingKey`，可通过 `--source-field` / `--target-field` 指定点分隔的映射路径。脚本支持普通 YAML 和 Unity 文本资产的文档头；多个文档同时命中字段、重复键、缺失字段、空字符串或非字符串都会报错，不替用户挑选或转换。二进制资产或特殊序列化结构应通过 Unity API 读取。

该脚本只读，依赖 PyYAML（见 [依赖文件](../scripts/requirements.txt)）；优先使用现有解析环境，缺少时在任务隔离环境安装。不会自动更改配置，也不会根据“看起来有引号”直接删字符。退出码 0=解析值相同，1=不同，2=依赖/输入/解析错误。`target_has_extra_outer_quotes` 仅标记目标恰好多包一对引号的情形；`backend_signature_verified` 始终为 false，因为文件相同不代表服务器已验签成功。

### 核对签名协议

从后台样例确认字段名、排序、空值、嵌套 JSON、大小写、UTF-8、转义、URL 编码和密钥拼接方式。不要从“使用 MD5”推导完整规则。

本类 Demo 常见的规则为：排除 `sign` → 顶层 ordinal 排序 → `key=value` 以 `&` 连接 → 追加签名字符串 → UTF-8 MD5 小写。该规则在本文件的 01 AF 契约中已具体化；其他后台仍需确认，不能仅凭 MD5 推导其协议。嵌套归因对象的排序与序列化尤其需要保持一致。使用独立样例构建固定预期值，覆盖空归因和 Unicode。

### 签名错误的受控排查

1. 保留本次真实返回，并先区分 DNS、TLS、HTTP 和业务错误。`Invalid parameter signature` 说明该接口报告验签失败，单凭这一条不能定位为 AF/FB 参数、后台配置或算法错误。
2. 先核对请求体与签名原文是否一致：后台按请求体里的原始 JSON 文本验签，嵌套对象（尤其 `appsflyer`）与顶层的键顺序都必须与签名时的排序一致。用同一个 `sign`、只改嵌套键顺序的对照请求即可确认。Editor 空归因探测（`appsflyer` 为 `""`）不会暴露这个问题，必须用带真实归因的真机请求验收。
3. 用解析器或 Unity API 核对迁移值；再检查字段名、类型、排序、空值、嵌套 JSON 序列化、编码、Content-Type 与密钥拼接方式。授权沿用 Demo 不等于从文件复制出的文本一定正确。
4. 在已授权的入口联调范围内做小范围对照：固定域名、渠道、语言、归因内容和其他字段，只改变已发现的不一致项。密钥对照应断言两个请求除了计算出的 `sign` 外完全相同；不同时换域名、SDK Key 和渠道来判断验签原因。没有依据时向后台索取有效样例，不猜测或枚举密钥。
5. 保存对照结果，区分电脑空归因探测与实际设备请求。即使电脑侧返回业务成功，也要重新构建并核对包内配置，以本次真机响应确认验签、有效 URL 及页面加载；SDK 后台归因与事件入库仍需另外验证。
6. 更新当前配置和文档，标明包含错误密钥的历史备份不能直接用于恢复。既有签名算法自测不能替代源配置一致性检查和真实后台响应。

## H5 协议与附带测试页

下面是本技能测试页采用的**项目 H5 契约示例**，不是 AppsFlyer 官方统一的 WebView 协议。先以用户/合作方确认的协议为准，再同步原生桥、网页和测试。截图说“新的归因格式”，先比较消息结构，不据此升级 SDK。H5 回包与后台入口的归因字段、签名协议是两层契约；只改 H5 时保护入口请求结构不变。

Unity 调用 `window.onUnityMessage(object)`；用 JSON 序列化保留原始类型，不手工拼接任意字符串。网页有 `requestId` 时原样回传；没有时不要求网页凭空提供。

### AF 归因

`uniwebview://getAppsFlyerData` 返回：

```json
{"type":"appsflyer","info":{"install_time":"SDK实际值","af_message":"organic install","af_status":"Organic","is_first_launch":false,"appsflyer_id":"SDK实际ID"}}
```

`info` 放 SDK 实际 conversion data 的副本，并补实际 `appsflyer_id`。`is_first_launch` 保持布尔值；保留其他真实 SDK 字段，不把对象变 JSON 字符串、不硬编码 Organic/安装时间、不让回包修改归因原对象。归因尚未返回时按约定给空数据/可用 ID 或明确等待状态，不伪造截图字段。

本契约不使用旧的 `appsFlyerInfo + conversionData + appsFlyerId` 外层结构；仅在项目明确要求旧契约时保留其独立适配，不能用同时接受所有旧格式的测试掩盖不匹配。

### AF 事件和已确认的别名

- AppsFlyer SDK 最终接收事件名。`eventToken` 可能是旧 Adjust 不透明 token，也可能是 H5 已约定的事件名别名；不能只看字段名决定删除或映射。
- 当前示例约定：非空 `eventName` 优先；缺失/空字符串时用 `eventToken`；对选中的值继续做同样的名称、参数、金额校验。保留已有明确优先级，不添加双次上报。
- `onEventJs` / `onAppsFlyerEvent` 的成功和失败都使用 `appsflyerEventAck`，`eventToken` 在顶层，不再藏在通用 `bridgeAck.data` 内。此示例回传最终选用的事件名；若合作方定义为原始 token 回显，按其约定并单独测试两字段同时存在的情况。

```json
{"type":"appsflyerEventAck","ok":true,"eventToken":"integration_bridge_test"}
```

```json
{"type":"appsflyerEventAck","ok":false,"eventToken":"invalid%name","error":"invalid_event_name"}
```

`ok:true` 表示客户端已接受并交给 SDK，不表示后台已入库。保留 `eventName`、仅 `eventToken`、空 eventName 回退、两者同时出现的优先级、错误参数和 SDK 不可用的回归用例。未知旧 Adjust token 没有事件名对照时不能自行猜测；已有确认的别名不因旧文档而移除。

### 其他消息与测试页行为

| action | 参数 / 回包 |
|---|---|
| getIntegrationStatus | `bridgeAck.data` 为非敏感状态对象，含 platform |
| onFacebookEvent | eventName、可选 params JSON/valueToSum；保留既有通用回执 |
| sendData | JSON payload；回 `bridgeAck.data.payload` |
| setOrientation | orientation；兼容已确认的 `landscape-left/right` 与 camelCase 别名，规范化调用平台、回执保留请求原值；仅表示命令接受 |
| openURL | HTTP/HTTPS URL；无效协议回 invalid_url |

方向参数映射、Unity/UIKit 时序和真实按钮验收见 [网页方向指令](webview-orientation.md)。读取当前页面的实际参数；模板传参正确不能证明线上按钮相同。

`../assets/bridge_test.html` 默认不自动执行；旧 `?autorun=1` 也不启动用例。由用户点击测试按钮，或由本次显式启动的外部测试驱动调用 `window.integrationBridge.runTests()`。不要把该调用放到普通包的启动钩子、轮询器或恢复回调里。

测试页采用上述 AF 契约，使用 requestId 匹配回调，严格拒绝旧 AF 类型和不匹配的回执。显式完整测试共有 16 项，其中 AF 两条、FB 一条不含金额的 `integration_bridge_test` 用例；界面必须如实说明这些副作用。其他金额/购买事件只按授权测试。结束发送 `integrationTestResult`，仅允许明确的测试构建/受控本地页收集；不能将远程页面自报 passed 视为原生验证。

测试页/离线 mock 只能验证通信契约；真实 WKWebView、SDK 响应和后台入库分开验收。网页套件最后会测试 auto；网页本身无法读取原生锁定模式和旋转允许掩码，因此报告始终标记 `cleanupCompleted:false`、`orientationRestoreRequired:true`，界面也提示恢复未验证。由外部驱动在运行前保存、结束后恢复实际页面、方向、旋转掩码和回调，再独立记录清理完成；拿不到原状态时不要猜测恢复值。不能把 16 项桥接 PASS 当成清理完成。普通交付包不包含测试页或启动测试器。

修改本模板后运行 `node --test tests/test_bridge_page.mjs`，同时运行 `python3 -m unittest discover -s tests -v`（先按 scripts/requirements.txt 准备依赖）。Node 用例使用离线响应夹具，验证新旧回包判定、别名、相关 ID 和不自动启动；它们不会发送真实 SDK 事件，不能替代真机测试。

离线网页测试另覆盖仅 eventToken、空 eventName 回退、eventName 优先级和 onAppsFlyerEvent 别名；16 项在线套件并非原生解析器所有分支的完整覆盖，修改解析器时仍需其实际 C# 回归测试。

方向测试的覆盖限制：当前 Node 夹具对 `setOrientation` 仅回显输入，且不执行真实 DOM 方向按钮绑定；它不能检出项目 C# 白名单拒绝或规范化错误。项目侧仍须验证原始 scheme 参数、平台规范值/回执原值、无效值无副作用，以及实际 WKWebView 中的原按钮链路；15 项离线测试通过不等于横屏问题已解决。
