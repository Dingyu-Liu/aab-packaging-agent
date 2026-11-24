# 启动 Loading、安全区域与回退

按用户本次需求启用这部分。模板来源于 Unity 6000.0.77f1、最低 iOS 17.2 的导出工程，SDK 页面 runtime 类为 `PAWebViewController`。新版本要核实 controller 创建、窗口显示、`_rootView`／`_unityView` 的关系和 SDK 实际呈现路径。

## 黑底覆盖的正确层级

只把 Loading 当作 Unity Metal view 的子视图，曾出现游戏画面从文字下面透出的真机问题。现有模板在 `willStartWithViewController:` 调用 super 后、窗口首次显示前建立普通 UIKit 宿主：

```text
Unity root controller.view = native host
  ├─ original Unity render view（保持原来的 _unityView）
  └─ opaque PAKitLoadingView（同级上方、全屏、拦截底层触摸）
```

同步 `_rootView = controller.view`，保留 Unity 原有渲染对象、drawable、缩放、输入和通知 delegate；`startupHostInstalled` 避免回游戏后重复包裹或重复加罩。对其他 Unity 版本，先读实际导出源再适配，不照抄私有成员假设。

`PAKitLoadingView` 四边约束填满宿主，`drawRect:` 使用 `kCGBlendModeCopy` 填充不透明黑像素，`UIViewContentModeRedraw`，中间白色 `Loading…`，26pt semibold。iPhone／iPad launch storyboard 使用同样画面；模板里的 storyboard 是可选替换资源，只有用户要求统一启动画面时使用。

原生 iOS 项目把等价状态机放入现有 AppDelegate／Scene 与根控制器，不引入 Unity 类。SDK 禁用时，启动遮罩也不应出现。

## SDK 页面与安全区域

`PAKitSafeAreaViewController` 只包装识别出的 SDK 页面或其导航容器，对其他 present 保持原行为。使用正规子控制器 containment：`addChildViewController`、加入 view、四边约束、`didMoveToParentViewController`。让整个 SDK viewport 处于 `safeAreaLayoutGuide` 四边内部，保留原方向策略与状态栏行为。

不要仅调 scrollView contentInset 来解决网页 fixed 返回按钮与状态栏重叠；也不要改厂商二进制、替换 navigationDelegate、注入网页 CSS/JS。SDK runtime 类改名、从别的 controller 呈现、使用自定义 window 时需要重新识别实际路径，不能假定容器已生效。

## 何时揭罩与何时回游戏

| 信号 | 本流程的宿主行为 |
|---|---|
| ATT 等待／PA 配置请求中 | 保留启动 Loading |
| PA `status=0`（opened） | 保留底层游戏遮罩，SDK 容器继续显示独立首屏 Loading |
| 容器已 appeared、观察到首次导航、URL 非空、`loading=NO`、`estimatedProgress >= 1` | 移除页面 Loading，停止首次导航 KVO，显示 SDK |
| PA `1=skip`、`2=request failed`、`3=parse failed`、`4=presentation failed` | 移除启动遮罩，正常进入游戏 |
| SDK 关闭／容器消失 | 通知宿主移除底层遮罩，返回游戏 |
| 首轮网页超过 60 秒未完成 | 当前模板关闭 SDK 页面并回游戏 |

这是本案例确认的状态合同和用户要求的失败策略。新 SDK 的值不同则修改映射；60 秒是宿主策略，可按需求调整，不是 PA 固定规范。

WKWebView 新建时就可能 `loading=NO`，不能立即视为成功。观察的是公开 loading／estimatedProgress／URL，初始 KVO 同步通知要延后到主队列处理，避免注册中就移除 observer；页面揭罩和 controller dealloc 时清理。网页后续异步 JS／业务数据不在这套首次导航判定的保证范围内。

## 已撤回的黑屏回归

曾为处理一帧白闪同时加入以下改动：强制 SDK content root、WKWebView、scrollView 和 underPageBackgroundColor 为黑；设置 webView 非 opaque；等 `takeSnapshotWithConfiguration:` 成功后才揭罩并重试。

用户真机随后报告 Loading 后持续黑屏、SDK 黑色文字无法看清。这组改动已经按用户要求撤回。**本技能资产采用回退后的版本，不以网页快照作为必须通过的显示条件，不强制覆盖 SDK 内容背景。** 黑色只属于宿主背景与加载画面；网页维持自己的外观。

不能因为模拟器快照测试通过就恢复这套组合。需要再处理白闪时，先从视频逐帧区分系统切换画面、启动页、native 容器和网页实际背景，收集真实 SDK 场景证据再做单一、可回退的调整。

用户要求回退时保存问题版本，恢复精确上版宿主源，并同步安装脚本的特征检查、说明、暂存及 ZIP；不能源代码回退后仍要求脚本找到 snapshot 方法。代码回退与版本号回退是不同操作，按用户说明分别处理。
