# iOS 构建、签名、安装

## 默认路径：直接装真机测试包，不额外跑模拟器

任务包含设备测试且用户未指定自行安装/自测时，默认从独立测试包直接安装到已配对真机；不要为了“补全”再安排一轮模拟器测试。用户正在手动测试或明确暂停设备操作时，保留当前运行状态，修复/构建可按范围继续，覆盖安装需有后续授权。只有没有可用设备、设备无法信任，或用户明确要求时才使用模拟器。

1. `xcrun devicectl list devices` 确认设备为 `available (paired)`；记录型号、系统版本与标识。设备不可用时如实报告未验证，不用模拟器结果替代真机结论。
2. 测试包使用独立 Bundle ID，沿用项目既有约定（如 `<正式BundleId>.sdktest`）。显示名遵循用户给定名称与空格，未约束时才可加测试标记；编号、脚本名和压缩包名不自动加到显示名上。AppsFlyer/Facebook App ID、App Store 数字 ID、渠道与入口参数保持正式值，不用测试 Bundle ID 替换。
3. 测试包名通过环境变量或临时设置注入导出流程；不要写进正式配置。01 默认的 App 首帧、Loading 与默认网页为 Portrait；需要临时覆盖构建方向时，先捕获源工程的游戏原方向/自动旋转开关，独立写入随包配置供回退读取。覆盖前后的值分别记录，导出成功或失败都在 `finally` 中恢复 PlayerSettings，再核对正式 Bundle ID、产品名、游戏原方向与开关。具体见 [启动方向](startup-presentation.md#按阶段控制方向)。
4. 复用用户已安装的 Apple Development 团队自动签名；个人团队配置通常 7 天到期：
   ```sh
   xcodebuild -project Unity-iPhone.xcodeproj -scheme Unity-iPhone -configuration Release \
     -sdk iphoneos -destination 'generic/platform=iOS' \
     DEVELOPMENT_TEAM=<TEAM_ID> CODE_SIGN_STYLE=Automatic -allowProvisioningUpdates build
   ```
   记录实际签名身份、Team、Profile 名称与到期时间。
5. 安装后用 `devicectl` 核对实际 Bundle ID，再单独记录启动：
   ```sh
   xcrun devicectl device install app --device <DEVICE_ID> <App.app>
   xcrun devicectl device process launch --device <DEVICE_ID> --console --terminate-existing <testBundleId>
   ```
6. 启动前记录 UTC 时间；从 console 日志取本次 runId，确认 ATT、SDK 初始化、归因等待、入口请求、`Web active` 或原生回退的实际顺序。方向按阶段记录实际窗口和 Unity 宽高：Loading/默认网页为 Portrait，回退游戏为其原契约，不能只看最后网页或一个 Screen.orientation 设置值。交给用户自测时，保留已安装测试包，抓完启动证据后断开 console 连接即可。
7. 报告区分测试包 Bundle ID、正式 Bundle ID 与手机实际安装的包；正式包未安装时明确写出。

## 原生启动故障与包内依赖

原生 SDK 或启动 UI 修改后，编译、签名和安装成功仍可能在首帧前退出。先关联本次 Bundle ID、构建号、启动时间与进程，再取 console、加载器错误或 `.ips` 堆栈；退出码 0 也可能是 UnityFramework 加载失败后走到正常返回路径。没有崩溃记录、进程不在或手机断开时，保留已确认的安装/启动命令状态，不能仅凭这些现象确定根因或宣布修好。

### 动态框架必须进入最终应用

- 以实际 Mach-O 依赖为准，例如用 `otool -L` 查看 `UnityFramework` 与依赖框架，递归核对最终 `.app` 中的非系统强依赖及真实 `@rpath`/`@loader_path`。Podfile 的 `use_frameworks! :linkage => :static` 不保证 vendored XCFramework 本身为静态库；只在编译时找得到 SDK，不能证明运行时已嵌入。
- 典型故障是 UnityFramework 依赖的 FB 动态框架没有进入应用。按本工程实际依赖嵌入相应框架及其传递依赖，并配置主 App target 的复制/签名步骤（如 `CodeSignOnCopy`）。实际为静态的 AF/PurchaseConnector 库沿所用集成方式链接，避免同时在多个 target 重复链接；不要把所有 SDK 一律当动态框架嵌入。
- 修复应落到实际使用的 Unity 导出后处理或 CocoaPods 集成钩子，重新导出后仍然生效。只手工复制到某次 `.app` 或 DerivedData 不构成修复。构建/安装脚本在接受新产物和复用旧包前检查依赖完整性；缺失强依赖就停止安装，签名验证与依赖检查分别通过。

### Objective-C 可见性方法与属性 setter 分开命名

`@property UIView *loading` 会生成 `setLoading:`。再定义 `- (void)setLoading:(BOOL)visible` 就会占用同一个 selector，`self.loading = ...` 可反复进入可见性方法，造成递归与栈溢出；Objective-C 不按参数类型重载方法。使用不同名称，例如：

```objc
@property(nonatomic, strong) UIView *loadingView;
- (void)setLoadingVisible:(BOOL)visible;
```

检查自有原生类的新方法与属性访问器是否冲突，将该类参数类型冲突视为编译失败，例如对相关源码启用 `-Werror=mismatched-parameter-types`。不要靠忽略 warning 放过冲突，也不必为此把第三方 SDK 的所有警告升级为错误。堆栈反复出现同一可见性方法时，先核对 selector 与属性赋值，再排查布局；早期强制布局的键盘断言另见 [早期布局](startup-presentation.md#早期布局的启动崩溃)。

修复后的正常包须在本次授权范围内重新构建并单独验证启动；没有设备证据时仅报告源码/构建通过。正常启动的判定见 [正常启动证据](verification.md#正常启动证据)。

## 一键安装脚本的设备与签名判断

- 消费本次 `devicectl` 结构化 JSON。已配对的有线 iPhone 可能仍是 `tunnelState=disconnected`，不能据此直接筛掉；先选候选设备，再用有超时的设备详情/连接命令建立开发连接，核对实际可达性、开发者模式和 DDI 状态。缓存中的 paired/wired 也不等于本次一定可达。
- 显式 `--team` 或环境配置优先；默认测试团队从当前 Xcode 已登录且适用的团队选择，匹配可用开发证书和描述文件。只有一个合适团队时可直接使用；多个团队无法唯一判断时要求指定。不能因工程/旧脚本写着某团队，就在另一个可用团队已登录时反复尝试失败或笼统要求重新登录；正式应用身份及用户指定团队不静默切换。
- 分别核对 Xcode 账号团队、证书 Team 与可安装描述文件。Team ID 从实际团队元数据、证书组织单元或描述文件读取，不从证书显示名括号中的标识猜测。安装前检查签名、证书指纹匹配、Bundle ID、有效期和目标设备；安全拒绝启动仍需结合手机提示，不自动宣称是某一个原因。
- 分阶段落盘构建、安装、启动结果；启动请求时间在请求前保存，失败时保留已安装状态和真实错误。命令超时仍写入已捕获输出、超时阶段和日志路径，不能只留下空目录或输出“检查通过”。脚本成功构建后还要校验本次产物；旧 `.app` 不作为本次成功证据。

## 确认工具链，避免重复安装

1. 读取项目版本、编辑器 Info.plist 和实际路径。macOS 两处模块位置均检查：
   - `Unity.app/Contents/PlaybackEngines/iOSSupport`
   - `Unity.app` 同级的 `PlaybackEngines/iOSSupport`
2. 用选定 Editor 的构建支持 API 或真实导出验证。模块目录存在只是线索；一个位置缺失也不是缺模块的结论。
3. 读取 `xcodebuild -version`、当前设备列表、开发模式、可用签名身份和有效描述文件。证书、App Store ID、Bundle ID、Team ID、设备 UDID 各自核对。
4. 有配置好的 Unity REST/CLI 时使用其实际健康检查和 schema。未安装插件时，不宣称相关 API 可用，不仅为此次操作强制安装插件。文件/Editor 构建入口也是可用方案。

只补齐当前任务需要的缺失工具。模块和 SDK 应来自官方或已授权来源，校验与编辑器匹配的版本；不要为了“最新”升级现有工程。

## 更换 App 图标时

- 确认用户给出的主图、尺寸、方向与透明度；图标按项目既有目标设备族设置，素材有 iPad 目录不代表需要新增 iPad 支持。使用原素材，不擅自重绘/改变图案。替换现有图片时保留 `.meta` GUID；缺少尺寸可从足够清晰的主图等比缩放。
- iOS 图标需要不透明输出。仅当 alpha 所有像素已为不透明时，去除 alpha 才能保持颜色无损；存在透明区域时按已确认背景合成，不能直接丢弃 alpha 得到黑边。
- 用当前 Unity 支持的 PlayerSettings/PlatformIcon API 设置默认及 iOS 图标槽，保存设置，检查导入尺寸/压缩没有损坏主图。不要只替换文件却漏掉图标槽；槽位数量以该 Unity/iOS target 为准，不硬编码某次工程的数量。
- 核对实际使用的导出入口：手动 Build、01 导出和旧发布脚本可能各自覆盖图标。查看导出的 `AppIcon.appiconset/Contents.json`、实际图片、App target 的 AppIcon 选择及签名包；项目有图不等于安装包用了它。
- 增加可辨识构建号并核对实际安装版本。遇到旧图标/系统缓存先查产物和版本，不默认卸载清空用户数据。只有当前任务明确包含的其他平台/官网图标才一并更新。

## 模拟器（仅在无设备或明确要求时）

有已配对真机时跳过本节，直接按上面的真机测试包路径执行。以下规则用于设备不可用或用户明确要求模拟器的情形。

- 真机通常为 arm64；模拟器独立确认宿主/运行架构（Intel x86_64 或 Apple Silicon arm64）及 runtime，不能从手机架构反推模拟器。
- 选择 XCFramework 切片时同时匹配 `SupportedPlatform=ios`、模拟器 variant 和目标架构；只筛 simulator/arm64 可能误选 tvOS 切片。链接缺符号按当前 SDK/框架依赖排查，不用空实现绕过。
- boot、install、launch、拷贝报告和等待回调分别限时，长命令用可取消的后台进程保持沟通。Data Migration、BackBoard、工具握手或 AssetCatalogSimulatorAgent 等阻塞先保存日志；只清理本任务启动的进程/模拟器，不重置共享服务或终止其他工程。
- 首次失败后按新证据重试，设定尝试上限。仍不可用时转向已授权的真实设备，或如实报告未验证，不能反复重装/重启碰运气。记录编译前源码哈希并在编译后确认未变，不能用后来修改的源码哈希证明旧二进制。
- `devicectl device process launch` 的设备/JSON输出/超时/环境等选项放在 bundle ID **之前**；bundle ID 后的位置可能被解析成应用启动参数。以当前 CLI help 为准，读取结构化结果。记录“已安装”后再单独记录“已启动”，避免启动失败时错报清理状态。

## 导出独立测试包

- 先保存可恢复的包名、产品名、签名、构建平台和依赖设置快照；已有未保存的用户场景不能被丢弃。
- 给测试包独立 Bundle ID，显示名遵循用户要求；允许区分时再加测试标记。App Store 数字 ID保持对应 SDK 配置，不用测试 Bundle ID 替换它。
- 使用设备 SDK、arm64、IL2CPP 和 Development Build。按项目支持的方向保留旋转设置，不为了测试解锁产品本来禁止的方向。
- 测试器用专属编译定义，但编译定义本身不限制运行次数。创建测试对象前还需本次显式触发/一次性标记；普通测试包和发布包均不包含自动 QA。不要让 AfterSceneLoad 在每次启动重新跑旋转、白色对照或测试事件。
- 路由结束后测试器暂存并恢复页面、方向、输入和其他运行状态。若暂停整个游戏对象，注意音频等状态需要恢复。
- 输出目录属于本次生成产物，避免覆盖用户已有手工改动的 Xcode 工程；重复构建优先复用有效缓存。
- 每个阶段写带运行标识的状态文件。开始新阶段时清理/替换旧状态，不能拿前一次 result.json 的 success 当本次成功。

## CocoaPods

先尝试现有可用 CocoaPods；固定依赖版本并检查 Podfile/lock。生成 Podfile、完成 pod install、生成 workspace 是三个不同状态，导出成功并不保证后两步完成。后续从 `.xcworkspace` 构建。

需要处理环境错误时：

- 先保留真实错误。Ruby 头文件找不到、依赖 Ruby 版本不兼容、TLS/下载失败、Xcode 格式错误应分别处理。
- 使用隔离依赖目录时，向相关子进程明确传递 GEM_HOME/GEM_PATH 等配置；不要改写 HOME 或覆盖其他项目的工具。
- 系统 Ruby 的架构头目录可能与当前 Xcode SDK 不匹配。先检查实际 `ruby/config.h` 和 RbConfig，再做仅限该工具进程的路径适配；不要把某台机器的 darwin 目录写死为通用方案。
- 某些旧 EDM4U 即使关闭自动安装选项，构建回调仍会安装旧 gems。核对实际版本代码；需要外部解析时，可暂设 `CocoapodsIntegrationMethodPref=None`、保留 Podfile 生成功能，在外部显式执行 pod install，最后恢复设置。
- 只有收到过期证书/账户登录、设备信任等真实阻塞时才要求用户完成相应操作。不要尝试绕过签名或信任机制。

下载确实成为阻塞时，可以使用同一官方发行版本的单独 framework/xcframework 归档与官方 podspec，校验发行哈希后在生成工程中使用本地 Pod 路径。保留所选架构、依赖、资源、隐私清单及许可；记录来源。不要省略资源换取“链接通过”，不要关闭 TLS 校验。不要默认启用大量并行下载或任意镜像。

## 原生链接与签名

- 编辑器编译与 iOS 条件编译不是完整 IL2CPP/Xcode 链接。
- 遇到 undefined symbols，沿符号追踪 C# DllImport、插件导入设置和 Xcode target。若历史预览 C# 引用已禁用插件，确认没有运行/序列化引用后从对应 Player 编译中排除；不能加空 stub 来伪装成功，也不能随意启用旧游戏启动路径。
- 对导出的 Info.plist 核对 ATT 文案、Facebook 配置/URL scheme，保留其他 URL schemes；检查所需 framework、SDK 原生库和 IL2CPP 回调保留。
- 自动签名使用当前用户已配置且适用的团队。签名私钥、密码和账户凭据不放入 skill、命令日志或分发包。
- 安装前确认构建成功、目标 app 的 Bundle ID 和签名。残留的 `.app` 文件不证明最近一次构建成功。

## 安装后验证

以本机 `xcrun devicectl help` 为具体命令依据，设备标识由本次枚举获得。采用结构化 JSON 结果：

1. 安装到用户指定或本次确认的设备。
2. 明确启动；安装 success 不代表启动 success。
3. 手机若拒绝启动，检查描述文件日期、设备包含关系、签名证书指纹与 entitlements，再结合手机上的实际提示处理信任/联网验证。用户说已信任后无需重复索要同一授权。
4. 记录本次启动 UTC 时间或 runId，然后才采集 app 专属数据容器内的结果。不能根据文件存在就接受旧报告。
5. 专用 QA 包可保留显式重跑入口；普通包不保留自动启动入口。完成本轮状态恢复后，按 [交付收尾](delivery.md)构建、检查、安装普通包，再验证至少两次冷启动。只读取本任务 app 的报告、截图与相关日志。

交付记录应用显示名、测试包名、设备型号/系统、构建/安装/启动结果、测试签名期限、验证范围与剩余阻塞。不把任务延伸为正式发布或 App Store 提交。

不要把“已剔除 ZIP 内的测试文件”写成“手机已无自动测试”。实际安装产物中的元数据/原生符号、安装启动记录和冷启动表现需要分别核对；交付时说明用户手机最后保留的包类型。
