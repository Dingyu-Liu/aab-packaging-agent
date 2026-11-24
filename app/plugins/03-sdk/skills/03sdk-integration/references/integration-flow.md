# 接入链、参数和状态机

## 最少输入

给出工程绝对路径、实际供应商 SDK/头文件/库或获取来源、SDK 应用参数、版本即可开始；已有工程能读到的值直接核对沿用。SDK本身未提供且必须接入时先列明缺失物，不捏造 API。用户自然语言参数等价于填写模板，不要求把所有可推断项重新问一遍。

`integration-inputs.example.json` 是 agent 的整理模板，不是直接可编译配置。模板中的 `read_from...` / `discover...` 必须解析成工程事实；构建 helper 只接受独立的 build-inputs（不含密钥）。不直接把模板中的占位文字写进工程。

| 参数 | 来源与处理 |
| --- | --- |
| project/root/kind | 检查 Assets+ProjectSettings 与 Xcode/IL2CPP；如都有，优先修改真正源工程并产出 export |
| production/test Bundle ID | 正式值沿用；测试默认加 `.sdktest`，不得和正式相同 |
| version / test Build | 用户指定或当前版本；测试迭代递增 Build，验设备实际安装值；不擅改正式发布版本 |
| app_store_id / devKey | 数字App Store ID不是Bundle ID；沿用现有业务参数或用户提供；测试包不换SDK身份 |
| routing header/library | 核对架构/最低OS/公开API/实际hash与版本，不仅凭文件名猜；mode必须有契约 |
| UID | 沿用安装级稳定UID，不在每次启动生成新UID破坏归因关联 |
| events/H5 | 只有本次实际需要才接；按已有契约核对参数/类型，不添加示例FB/Adjust事件 |
| team / device | 可为空由本机事实推断；多候选集中询问；不硬编码案例值 |
| timeout | 默认用户已选择的35+10+首屏15秒，各阶段独立，不把总等待写成固定45秒 |

## 先保存基线

记录当前版本、SDK版本/依赖图、正式包名、原游戏方向和自动旋转开关、音源/视频启动点。非Git工程备份所有要改文件并生成统一diff；Git工程保留用户现有改动。源工程要写导出脚本，不能手改一次Xcode后声称下次导出也生效。

检查 Podfile/lock、Xcode target membership、链接与嵌入：静态SDK只进入正确宿主一次，动态framework按依赖和架构嵌入签名。当前 Racing 依赖在 UnityFramework；不要无条件给新工程复制清理 xcconfig 的正则。

## 协调器逻辑

```text
BootLoading（遮罩+游戏音视频保护）
  → Resolving（initSDK，ATT wait，startSDK，active时ATT，等待归因/标识）
  → Config（仅协议明确支持的归因值）
  → LoadingWeb（容器present + 首屏导航）
  → Web（首屏就绪，遮罩消失；游戏音视频仍阻止）

Unknown/超时/配置失败/网页失败/网页关闭
  → RestoringGame（取消旧请求/呈现，释放方向锁，等游戏准备和呈现）
  → Game（遮罩删除已提交、后续游戏帧已显示，才开放声音/开场视频）
```

只有一个协调器拥有路由权限；SDK callback更新状态，不直接打开网页。`launchDecisionTaken` 含Unknown回退，一次启动只决定一次。网页关闭是恢复同一游戏，不重新请求归因或重新分流。每次异步操作捕获 generation/token，过期回调不撤遮罩、不弹网页。

### 同步回调与标识符

开始SDK之前：`waitStarted=false, waitComplete=false, launchDecisionTaken=false`。启动等待流程后才能把 `waitStarted` 标true；等待结果/超时结束才把 `waitComplete` 标true。AF-ready即使同步触发，也不满足开始分流的条件。检查构造初值、序列化字段和StartCoroutine立即执行的时机，不能只测“先创建等待协程，再触发回调”。

AppsFlyer API顺序：initSDK注册conversion listener → waitForATTUserAuthorization(30) → startSDK。原生ATT在UIApplication active时才发起，合并重复请求，处理scene/application activation。不同SDK版本按其公开文档适配。SDK start调用时刻不等于HTTP发出时刻。

AFID ready与IDFA ready单独记录；ATT拒绝/受限时IDFA可为空，全零UUID规范化为空。ready意味着回调已完成，不要求IDFA非空；真实AFID缺失按35秒上限回退。不能用授权状态的数值充当业务归因。

### 归因分类（Racing协议默认）

| 实际结果 | 客户端状态 | PA请求 |
| --- | --- | --- |
| 明确 Non-organic | 1 | 标识回调完成后请求 |
| 明确 Organic | 2 | 标识回调完成后请求 |
| null/缺字段/未识别/解析异常/conversion fail/超时 | Unknown=0 | 不请求，回退 |

接受哪些拼写由SDK契约决定；不能用“非Non-organic则Organic”的else。不要为了测试B面把Unknown或自然量改成付费量；用后台白名单或明确的独立测试入口，普通启动不夹带模拟响应。

### 预算

ATT等待最多30秒；归因及标识回调总等待35秒（包含ATT），明确unknown/fail可提前回退；Known但标识未就绪继续等待到上限。PA配置阶段总10秒，也核对库自己的网络timeout。网页开始呈现后改为首屏15秒，取代Waiting计时；Waiting50秒兜底只防缺失回调异常。请求失败提前结束，后台/恢复策略按业务要求，不让多个watchdog同时接管UI。

## PA的取消和网页接管

优先使用公开 cancel/session/lifecycle。当前案例的私有sessionToken adapter只对核对过hash的库成立；换库先核对异步请求、present completion、finish callback都检查token，不能只清completion而请求仍能present。无可靠取消时在呈现点阻止旧会话，并记录兼容性；不要声称公开API不存在时已靠猜测安全取消。

网页代理必须转发原库行为、保留decisionHandler恰好一次；正常重定向的NSURLErrorCancelled不作为失败。status0只是容器就绪；presentation完成+HTTP/HTTPS主文档didFinish才移除Loading。主文档HTTP>=400、网络/导航失败、WebKit内容进程退出、首屏超时均回退。about:blank不算有效业务首屏。网页关闭保留控制器引用到dismiss彻底完成，再恢复游戏。

统一日志以本次runId或时间串联：SDK初始化、ATT、AFID/IDFA ready（脱敏）、conversion分类、决策、PA调用参数/状态、选定URL字段、主文档status/host、首屏、回退原因、Loading交接、游戏音频/视频启动。常规包不打印SDK key、原始完整标识或归因payload。
