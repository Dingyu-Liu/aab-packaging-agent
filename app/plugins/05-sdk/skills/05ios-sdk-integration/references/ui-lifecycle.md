# 启动与安全区域：以回退后的实现为准

## 已验证结构及可移植范围

原工程 Unity6000.0.77f1 / iOS17.2+，含单窗口UnityScene；自动接入器仅放行经核验仍转发AppController生命周期的该Scene结构，保留其manifest。宿主依赖 `willStartWithViewController:`、`createUnityViewControllerDefault`、`engineLoadState`、`_rootView` 与 `_unityView`。模板的自动 profile 只用于这些入口实际存在且适用的导出工程；其他 Unity／低版本固定方向或原生 App 由 agent 查实际入口合并，不注册第二个 AppController、不改引擎指针来强行匹配。

在调用 super 后、Unity window 首次显示前：普通 UIKit root host 包含原 Unity Metal render view，Loading 作为其同级上方视图；`_rootView` 同步 host，`_unityView` 仍指向原渲染对象。guard 防止回游戏后重复包裹。26pt semibold 白色 `Loading…`，黑底 opaque view 以 `drawRect:` + `kCGBlendModeCopy` 画黑色像素。仅把普通 UIView 放进 Metal view 里曾真机透出游戏，替身 UIView 测试未覆盖此问题。

可配置 `ui.startup_loading` / `ui.safe_area`。统一 Loading 时同时适配 iPhone/iPad launch storyboard；关闭时不替换用户启动页。模板中新增的 Info flags 只控制宿主，不能改变厂商 SDK 请求。

## SDK 容器与揭罩

仅包装实际 SDK `PAWebViewController` 或其导航容器。正规 child-controller containment，将整个 viewport 约束到 safeArea 四边。单调 scroll inset 无法约束 H5 fixed 返回按钮。原有 orientation mask／通知 delegate 保留，不搬示例的竖屏锁和旋转 JS 契约。

PA status0 opened 保留底层游戏 Loading，SDK 容器另盖首轮文档 Loading。公开 WKWebView loading、estimatedProgress、URL 的 KVO 表明：容器已 appeared、确实发生导航、URL存在、loading为NO、progress>=1 后移除页面 Loading，并清理observer。新建 WKWebView 初始 loading为NO 不能立即算完成；初始KVO延后主队列，避免注册中移除。

PA 1 skip、2请求失败、3解析失败、4呈现失败，或页面关闭时移除底层遮罩回游戏。这是本次确认的厂商状态值；换库必须核对。

当前模板首轮网页超时默认60秒，可配5–300秒，从容器显示开始，不计ATT。它**不包含 PA 配置请求完全不回调的宿主 watchdog**。不能宣称任何网络异常都保证60秒回游戏；有需要再按SDK取消／迟到回调合同实现额外状态机，避免旧回调盖住新状态。

KVO只证明文档加载，不证明绘制首帧或后续JS数据都ready。现有模板的网络完成揭罩是回退后的选择，不能夸大为“真正网页首帧握手”。

## 禁止误恢复的回归组合

实际曾为一帧白闪同时强制SDK root/WKWebView/scroll/underPageBackground为黑色，设置非opaque，并等待takeSnapshot成功后才揭罩。用户真机结果是持续黑屏、SDK黑色文字看不清；已按要求撤回。

本技能保留宿主黑底与独立Loading，不改SDK内容背景，不把快照当显示门槛。再处理闪白先逐帧定位系统切换／启动图／网页／容器；不要凭模拟器通过恢复上述组合。出现回归且用户要回退时，源与安装脚本特征检查、文档和ZIP一起恢复；保留早先解决游戏穿透的修复。
