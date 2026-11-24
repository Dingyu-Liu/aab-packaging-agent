# Racing：本 skill 的事实来源与可迁移边界

## 实际工程

这是 Unity 6000.3.20f1 / IL2CPP 导出的 iOS 工程，缺原始 C#。代码入口：`AppBootstrap`、`AppsFlyerService`、`PaState`、`PAIOSNative`（在生成的 Assembly-CSharp.cpp）；原生桥 `PAUnityBridge.mm`，协调器 `RacingStartup.h/.mm`，PA 的 `PAWebViewController` / WKWebView。工程存在 UniWebView 不代表本分流由它承载。

Podfile.lock：AppsFlyerFramework 6.18.1、PurchaseConnector 6.18.2；本地 libPAKit.a。依赖链接 UnityFramework，避免主 App 再链接同一静态 SDK 引起重复 Objective-C 类。未接 Facebook；不能从用户示例推断需要 FB、Adjust、01 系列 HTTP 签名协议。

本次直接修改了导出文件；重新导出覆盖生成 C++ 与部分原生文件。新工程优先修改 C# 和 iOS 导出 postprocess，仅有导出工程时才做最小导出层补丁；保持 IL2CPP 布局，不能搬哈希符号/字段偏移。

## PA 的本次契约（不是所有 PA 版本的通用 API）

```objc
[PA setPa:afid b:idfa];
[PA st:0 a:attribution u:persistentUid c:^(NSInteger status) { /* main-thread dispatch */ }];
```

公开头仅这两个方法。`mode=0` 是实测真实配置路径，其他 mode 无通用定义。`a` 是业务归因，和 Apple 的 ATT 授权数值无关。1=Non-organic，2=Organic，0=客户端 Unknown，0 不传到只支持 1/2 的服务。

| status | 本库行为 | 客户端处理 |
| --- | --- | --- |
| 0 | 网页控制器呈现完成 | 继续 Loading，等首屏成功 |
| 1 | 选定配置字段不是有效 HTTP/HTTPS 地址 | 回退游戏 |
| 2 | 请求失败/无数据 | 回退游戏 |
| 3 | 配置为空或 JSON 无法解析 | 回退游戏 |
| 4 | 网页呈现失败 | 回退游戏 |

真实网页字段在该库中是 `privacy.contact`；曾返回 `Mariner Support Desk`，后来 IP 放行时返回 URL。字段名和服务地址属于该库/该项目，不能自动套给下一工程。配置接口请求和签名藏在二进制，未建立可复用的手写 HTTP 协议，因此本 skill 不编造 endpoint、密钥或请求签名。

本次库没有公开取消 API，针对核对过的二进制使用 `sharedManager.state.sessionToken` 递增并清空 completion 使旧请求失效，且先检查 selector。当前 SHA256 为 `d4bc074984513f882ef7ad2341e016ce93f724e66a9b557fdd278b123a58469b`。这是自有库内部适配，不是 Apple 私有 API；换版本必须重新验证或改用供应商公开取消 API。呈现保护也只过滤 PAWebViewController，不得普遍拦截其他 UIKit 模态框。

## 经真机发现的教训

| 触发 | 误判/缺陷 | 最终修正与下次要求 |
| --- | --- | --- |
| SDK 初始化同步调用 AF-ready | 等待标志默认 true，归因协程还没开始就回退，根本没发 PA 请求 | 构造默认 false，在任何 SDK 初始化前关闭门；必须 waitStarted && waitComplete；测试同步回调顺序 |
| 缺字段、异常、超时 | 把“不是非自然量”当自然量会错报 | Unknown 独立建模，回退；禁止伪造 Organic/Non-organic |
| ATT 拒绝、全零 IDFA | 把空 IDFA 等同未就绪可能卡启动 | 全零规范化为空；回调完成即 ready，非空与就绪分开 |
| PA status=0 | 只证明容器已开，网页仍可能 403/失败 | presentation 完成且首次 HTTP/HTTPS didFinish 才显示网页 |
| 配置放行后仍打不开网页 | 误以为 SDK 未返回网址 | 当次 JSON 已给 URL，但手机主文档 Cloudflare 403；记录 host/status/server/Ray ID，配置接口与网站放行分别查；不拿 Mac curl 代替手机证据 |
| 先恢复音频后等待旋转/撤遮罩 | 有声音但画面仍在 Loading | 方向/模态/skipRendering 就绪；主屏 drawable 呈现→Loading 删除提交→后续新游戏帧呈现，才恢复 |
| volume=0, pause=true 日志看似静音 | 用户仍听到声音 | 开场 VideoPlayer 约 2.5 秒后自动激活，direct 音轨绕过 AudioListener；延后整段视频激活，B 面不启动；再加 BGM/SFX source stop/mute 与播放入口门 |
| 网页成功时永久 CloseBGM | 返回游戏没声音 | 保存并恢复原状态，不永久改音乐开关，不补播积压短音效 |
| 证书 CN 括号与工程 Team 看似不一致 | 括号后缀并非团队 ID | 查证书 OU、profile TeamIdentifier/Devices/有效期与实际签名产物 |
| 公司账号 PLA 更新 | 自动签名不能建 profile | 不代签法律协议；已授权的可用测试团队可替代，记录个人 profile 到期时间 |

`UnityUpdateMuteState` 在本引擎只通知 managed 层，不能作为静音 API。当前导出补丁调用了本引擎的 AudioListener/AudioSource native bindings；下一工程有 C# 时用公开 API，导出层必须重新核对 ABI。

## 真正完成和仍待验证

最终测试包 1.0.2 Build 4，独立 `.sdktest` 包名；正式源 Info.plist 保持 1.0.2 Build 2。全工程构建、分类/时限/同步回调保护、音频和视频延后测试通过。用户实际确认：**Loading 已无声音，进入游戏才有**。前两版“混音器已静音”的日志不能算静音验收通过。

付费点击、后台 restricted/Meta 回传、首次 ATT 允许/拒绝完整矩阵、B 面成功首屏与关闭、H5 方向、iOS15/16、完整断网/前后台矩阵未证实。库按 iOS17.2 构建而项目部署15.0是已知风险，跑通 iOS18不证明低版本兼容。

本 skill 的新项目默认流程来自用户明确要求，但具体供应商、标识、服务协议、iOS 最低版本仍由新工程参数和事实决定。不要复制 Racing 的 URL、App Store ID、SDK key、团队、设备或渠道。
