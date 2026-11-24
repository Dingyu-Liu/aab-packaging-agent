# 实际接入经过与教训

这份记录来自当前项目源码、接入文档、安装脚本及本次对话，不来自示例 skill 的技术假设。它解释为何本 skill 采用当前流程；不是把过去的包名、token、团队或测试结果作为新项目默认。

## 接入如何形成

1. **确认工程与 SDK。** 最初提供一个 Unity-iPhone 工程，之后用户纠正为真正的 iOSRelease 4 工程。两份旧SDK都需核查真实内置地址；收到更新压缩包后才换到匹配域名的版本。公开 PA.h 没有域名配置 API，不能靠往 Info.plist 填 URL 修改库内部配置。
2. **真机与 ATT。** 用户要求临时包名安装。安装曾被 Apple 开发者 Program License Agreement 更新阻塞，随后还有自动签名／设备服务问题；这些不是手机应用权限不足。ATT 依旧示例在 didFinishLaunching 多次重试不可靠，最终采用前台、窗口可用、Unity ready 后一次请求。手机列表里该 App 已开启跟踪时不会再弹窗，不算接入失败。
3. **真正业务桥与 Adjust。** demo 有 H5 事件示例，没有现成 Adjust 实现。通过 PA 的业务 callback 把 five events 映射到各自 token，Adjust v5 初始化并接收成功／失败 delegate；不是向 demo 注入一份网页上报逻辑。正式模式／Production 与临时包名可同时使用。
4. **安全区域。** SDK 页面返回按钮与时间状态栏重叠。用户明确要求不动 SDK，所以由 App 子控制器容器将整个 SDK viewport 放进系统 safeArea，保留厂商 JS 和导航代理。
5. **Loading 与游戏回退。** 用户不希望请求时露出游戏，要求黑底、中间较大的 Loading；随后明确请求失败或不打开SDK就进游戏。最初 UIView 遮罩仍在 Unity Metal 初始化期间透出游戏。通过原生 UIKit root host、同级盖住原 render view、显式 drawRect 画黑，保留 `_unityView`、更新 `_rootView` 解决该类透出。
6. **一帧白闪引发回归。** 后来为一帧白闪加入强制 SDK/WK 背景黑色和快照 gate，模拟器替身通过，但真实设备 Loading 后持续黑屏、黑色文字不可见。用户要求回退，恢复网络文档完成就显示的上版逻辑，保留前面的独立宿主修复。
7. **正式与测试交付。** 一直维护正式工程与独立测试配置；只让主 App 测试配置改bundle/version，避免污染UnityFramework。正式版本最终1.0.4 (2)。改版本时还同步安装脚本原版本检查和交付ZIP，避免脚本拒绝已正确更新的工程。

## 具体教训如何进入自动化

| 实际问题 | 工具／执行约束 |
|---|---|
| 同名工程接错 | 每次用最新绝对路径和真实 target/sourceRoot建立事实 |
| 包名 arm/x86 或新版文件名误导 | 查切片平台和内容hash，不按名称猜 |
| 库内部旧域名 | 宿主预期字段不当作setter，不改二进制字符串 |
| ATT未弹与已有授权混淆 | 读系统授权状态；只notDetermined请求，不循环轰炸 |
| PLA/profile失败 | 明确账号／签名阻塞，保留脚本和完整日志 |
| CoreDevice环境受限 | 无设备和工具不可用区分，仍生成自包含.command |
| CoreDevice UUID/UDID不同 | 查询JSON提取两个值，同机匹配分别传对应工具 |
| tunnelState单条件筛选 | 有线、配对、开发状态和Xcode destination结合判断 |
| main bundle全局override | 只生成选定App配置副本，不改其他target身份 |
| 游戏透过Loading | 同级UIKit host + opaque drawRect；不只在Metal内加子view |
| 白闪修补导致黑屏 | 不强制网页黑底，不等快照才揭罩；回归恢复精确revision |
| 回退源后脚本仍要求快照 | 源、脚本检查、说明、暂存与ZIP一起同步 |
| 网页KVO完成被夸大 | 仅称首轮文档完成，不称真实首帧或业务ready |
| PA status2/(null)被当成空响应 | 无手机请求数据时不推断HTTP/body/后端根因 |
| 编译或launch成功被夸大 | 分层报告进程、页面、Adjust结果与后台入账 |

## 当前实现的边界

当前宿主来自 Unity6000.0.77f1 / iOS17.2+，识别PAWebViewController，Adjust v5，静态XCFramework。60秒超时只管容器显示后的首轮网页，不是全链路watchdog。手机运行日志／视频优先于假体测试结论。用户示例里AF/FB、自建签名API、屏幕方向JS、独立非key窗口等，不是本案现有事实，不因“看起来更完整”就移植进来。
