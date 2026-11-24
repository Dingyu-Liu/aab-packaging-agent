# 验收、诊断和教训

## 最小自动化验证

对真实实现逻辑或可注入SDK/时钟执行行为测试，不只匹配源码字符串：

- 明确Organic、Non-organic、null、缺字段、未知/解析异常/conversion fail；Unknown不请求旧接口。
- SDK初始化同步触发ready，等待尚未started/complete时不消费分流；随后合法结果只请求一次。测试实际初始化顺序，不只手动模拟标志。
- ATT允许/拒绝/受限、全零IDFA与空IDFA但回调完成；Known但AFID未就绪继续等；35秒边界、提前失败。
- 重复回调、回退后迟到归因/配置/present completion；旧请求不能弹网页/撤新遮罩。
- 网页容器成功但未首屏、重定向取消、HTTP主文档错误、首次导航失败/超时、进程退出；保留原delegate和唯一decisionHandler。
- 游戏原volume/mute/pause/音乐关；BGM/SFX播放入口阻止/恢复；视频direct音轨的**面板激活延后**；视频只在回退游戏可见后启动一次，进入B面不启动；不补播短音效。
- 真机有/无设备、缓存无线离线、wired noDDI、多设备选择、签名团队OU与profile匹配、缺证书、过期profile和.command含空格路径。

新的接入helper改动要实际执行验证，可运行 `scripts/test_ios_test_delivery.py`。skill格式通过 `skill-creator` 的quick_validate，不能将它视为SDK/设备验证。

## 真机矩阵

新测试包独立Bundle ID，版本和Build来自本次参数。至少冷启动一次并按实际变更覆盖失败回退和相关功能；无需为了模板强制全量设备矩阵。影响音视频/方向时相应场景不能仅靠编译：Loading全程游戏无声/不可点、默认portrait；配置成功的B面真实首屏；失败后恢复原游戏方向/自动旋转；游戏画面可见才有声音；网页关闭回退；前后台不漏音/不重复请求。

没有设备时记录未真机验证，交付command；连机后自动安装再测。无法录音/主观听感时，完成可测工作后请用户确认这一具体项；用户仍听到声音必须继续修复。先前Racing Build2/3未通过听感，Build4用户已明确通过，不得倒写前版本为通过。

## 没进B面的分层排查

1. **有没有发配置请求**：查归因、标识ready、wait started/complete、决策、PA调用；AF-ready不代表归因完成。同步回调提前触发回退时，请求并不存在，不能推断服务端拒绝。
2. **配置返回什么**：抓本次SDK status、原始JSON（本地诊断）、选定keyPath和取值；有效URL检查schema/host。返回普通文字是配置无效，并不意味着网络失败。
3. **容器是否呈现**：PA status0/presentation completion属于此层，检查真实控制器是否显示，不把它当网页成功。
4. **网页主文档返回什么**：记录手机status、host、错误domain/code；403的server/Ray ID可在诊断版补充。配置接口白名单不等于目标网站CDN/WAF放行。Mac curl只辅助，不代替手机路径。
5. **首屏与音画是否成功**：presentation+didFinish、无仍在转圈、实际截图/方向/听感。黑屏也可能是视频/Unity层，需要看视图和实际画面而非只看delegate。
6. **后台归因/事件**：SDK初始化、HTTP200、conversion回调、AF后台/Meta回传是不同证据。客户端不能保证清除restricted或后台立刻可见。

不为进B面伪造Non-organic，不跳过403失败规则，不关闭证书校验，不重放有副作用请求。后台白名单/业务服务/Cloudflare需对方处理时保存具体证据并明确外部阻塞。

## 临时诊断与收尾

SDK公开log/response callback优先；无公开接口时在测试构建有界记录或LLDB观察真实response/parser，使用当前版本核对的selector，原方法继续执行，不改变返回值/分流。全局NSURLSession hook会影响其他SDK，优先限定具体PA调用链。仅为诊断才获取原始JSON，敏感字段脱敏，key与完整标识不进入skill/公共压缩包。

临时原始响应日志、截图定时器、hook、模拟响应、强制方向和自动事件测试不进正常交付构建。如需保留诊断版，明确标为诊断包；最终普通测试包重建并核对仍是同一实现/包名/版本。不能只清ZIP而源码继续自动运行测试入口。

最终报告只记录本次运行结果；成功项和未覆盖项分开。至少提供：源与导出路径、SDK/二进制版本、改动/备份、正常测试包名/版本/Build、签名profile有效期、设备型号/OS、本次日志位置、配置/网页结果、听感来源、外部阻塞、后续Unity重导出维护点。
