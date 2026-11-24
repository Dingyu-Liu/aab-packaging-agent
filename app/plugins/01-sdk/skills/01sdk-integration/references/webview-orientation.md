# 网页方向指令与实际按钮验证

用于“left/right 按钮无反应”“回执成功但页面没转”“进入网页仍锁竖屏”等问题。只处理当前产品支持的方向；修改安全区不自动授权改变游戏方向或重做启动 Loading。

## 先确定当前阶段的预期

本用户 01 系列的系统启动页、Loading 与默认网页为 `Portrait`；游戏原方向仅在回退游戏时恢复。已约定的 H5 显式指令可改变网页方向，不能因用户要求默认网页竖屏而删除这些指令、统一返回锁竖错误，或把宿主与 AppDelegate 永久固定为 Portrait。只有用户明确要求禁用网页旋转时才实施该限制。游戏横屏不改变默认网页竖屏；修按钮也不意味着默认开启 AutoRotation。首帧配置与游戏方向的独立保存见 [启动显示](startup-presentation.md#按阶段控制方向)。

## 先对齐实际网页契约

读取用户当前加载页面的按钮 handler、构造的消息和实际传输通道。截图按钮标题只能帮助定位，不能代替参数值；skill 自带测试页也不能代替已部署页面。优先复现一次真实点击，区分以下链路：

`按钮 → JS 参数 → URL scheme / postMessage → 原生来源检查 → 本工程分发（C# 或原生）→ 网页宿主方向 → UIKit 布局 → 网页 viewport`

本系列已遇到并兼容的方向名如下。先核对当前产品已有约定，再增补兼容，不移除已验证别名，不为未知值猜测映射。

| 网页请求 | Unity 规范值 | 回执 `data.orientation` |
|---|---|---|
| `portrait` | `portrait` | 原请求值 |
| `landscape` | 沿用产品约定的一侧横屏 | 原请求值 |
| `landscape-left` / `landscapeLeft` | `landscapeLeft` | 原请求值 |
| `landscape-right` / `landscapeRight` | `landscapeRight` | 原请求值 |
| `auto` / `autorotate` | `auto` | 原请求值 |

在分发边界规范化后调用平台接口；回执保留网页请求值，避免 requestId 正确但方向 echo 不匹配。无效值在修改任何方向设置前拒绝。`portrait-upside-down`、`lock-portrait` 等自定义输入不是默认必需支持项。

回归用例至少覆盖本次有问题的真实参数、保留的 camelCase 别名、错误值无副作用，以及 JSON 与实际使用的 `uniwebview://setOrientation?...` 路径。测试需断言平台收到的规范值和回执的原请求值，不能只断言 `ok:true`。

## 分清三个方向约束层

1. **应用允许范围**：核对 `UISupportedInterfaceOrientations`、设备专用键和实际 AppDelegate 返回值。静态 plist 含横屏不代表已开启旋转；采用代理动态选择方向时，也不能只看 plist 就断言运行期限制。Unity 早期启动代理可能仍返回游戏根控制器 mask，需要识别网页/Loading 窗口并返回其当前有效范围。
2. **Unity**：`Screen.orientation` 与 `Screen.autorotateTo*` 控制运行期，默认启动/网页使用 Portrait。只有产品明确要求随设备旋转或收到已约定的 H5 显式请求时才改变网页模式。游戏原方向在启动覆盖前捕获；若构建时已临时改为 Portrait，运行期读取独立随包配置，不能把当前 Portrait 当成原生游戏配置。回退时恢复原始方向及全部开关；H5 的显式锁定只属于网页阶段。
3. **UIKit**：检查真实根/呈现控制器的 `supportedInterfaceOrientations`、首选方向、应用代理允许范围和当前 `windowScene`。启动 mask 选择 Portrait；有效网页请求更新对应宿主与应用范围后再请求几何变更；回退前释放网页限制。读到期望 mask 或 Screen.orientation 不能代替真实窗口和尺寸证据。

原生独立 WKWebView 宿主可单独控制网页方向，保持 Unity 游戏方向不变；不强制增加无关 C# 路径。Loading 期间收到的有效网页方向请求可延后至网页显示后执行，保持 Loading 首帧竖屏；主导航重建时按该阶段默认规则处理。恢复前台时保留当前网页选择，不能在每次 `applicationDidBecomeActive` 无条件重新设为 Portrait。

Unity 对 `Screen.orientation` 的提交可能延迟到后续帧。同一次调用里立即发 iOS 16+ `requestGeometryUpdate`，可能仍碰到旧的控制器 mask；遇到方向拒绝（例如错误 101）时，先对照本次 mask 与日志，不把所有失败都归因于它。

需要同步时，以**实际控制器已经支持请求方向**为条件，在主线程限时等待，再调用公开的 UIKit 方向 API；固定延迟若没有条件检查不能证明同步完成。为请求分配代次，新请求、关闭网页或回退取消旧等待，晚到的错误回调也检查代次。超时报告真实失败，不无限重试或强改设备私有 orientation 属性。iOS 版本较低时按当前工程的公开 API 路径处理。

Unity 的设备方向命名与 UIKit 的 interface orientation 的 left/right 可能相反。读取该工程导出的 `ConvertToIosScreenOrientation` 等实现后核对，不能凭名字直接一一映射。

## 验证用户点击的同一条路径

- 直接调用原生方向函数，只能证明原生能力；它绕过网页 handler、参数解析和消息通道，不能验收“按钮已修好”。
- 在实际 WKWebView 中人工点击，或用本次显式驱动对**已读取到的现有 DOM 按钮**执行 `.click()`。记录按钮实际参数、是否触发 handler、回执与最终界面方向。不要注入新的 `rotate` 实现、改写页面参数或直接发规范值来替代原按钮。
- 桌面 WKWebView 可读取已部署页面并点击其原始 DOM，检查 handler 与原始 scheme 参数；该结果不包含 iPhone UIKit 旋转或真机视口证据。修正版未安装时保留“手机仍为旧构建”，不把这类检查报告为手机按钮已修复。
- 保留桥接的可信主帧、origin、document token 与导航代次限制。不要为方便测试关闭这些限制。
- 实际方向完成后，比较同一坐标系下的根 bounds、原生 WebView frame、系统 safe area、允许方向 mask 和 JS viewport。按真实 scale 换算误差，不把 CSS px、UIKit pt 和物理像素直接混比。
- 测自动安全区更新时，先测 UIKit 自然布局，再单独验证显式 Refresh；断言前调用 Refresh/layout 修正 frame 会掩盖“只能手工刷新”的回归。
- 覆盖本次相关的左右横屏、恢复竖屏、再次切换/请求被替代和自动旋转模式恢复。自动 mask 正确证明模式已设置；传感器随手机转动仍需相应实测。稳定截图不能证明所有中间帧无闪白。
- 回退进原生游戏时检查方向是否恢复到游戏自己的契约：固定竖屏游戏保持竖屏；支持横屏或跟随旋转的游戏不应被 SDK 回退逻辑压成竖屏。这一项以实际转动手机后的画面为准，日志只用于核对恢复后的模式。

开始真机自动方向序列前说明可见操作和大致窗口；用户同时点击或转动造成干预时记录该事实，不能把一次失败或成功直接归因于源码。测试器显式触发、限时、隔离及恢复普通包，遵循 [交付收尾](delivery.md)。

## 最小证据记录

每个方向保存当前 runId、请求原值、实际按钮/通道、最终方向、允许 mask、frame/safe area、JS viewport 和结果。分别记录普通包的构建号、源码对应关系和安装启动证据。检查器不支持当前报告 schema 时写明转换关系或直接校验真实字段；不补造数据凑模板。
