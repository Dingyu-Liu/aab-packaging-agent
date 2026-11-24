# 从实际工程沉淀的流程和教训

这是技能的来源记录，不是新项目参数表。原始证据来自这轮 Android 工程的 Demo、宿主源码、Gradle、已交付包和验证记录；不依赖复制机器绝对路径、真实 Token 或私钥才能使用本技能。

## 实际过程

1. 先读 HTML 与 Android ZIP Demo，确认 PA 的真实 Maven/API、H5 ready/事件桥和模式。随后在 Unity 导出的 `launcher + unityLibrary` 中扩展原 GameActivity，使用正常模式请求，先用独立测试包。
2. SDK 从用户指定的 1.0.1 更新到1.0.2、1.0.3；App 版本独立切换1.0.0、1.0.2/code2。过程包含网络/IP问题、宿主 Toast 排查与移除。
3. 按 Demo 的业务事件入口接入 Adjust，最初讨论沙盒，随后用户明确改为正式环境和正式包名。在 Application 初始化，Activity 监听 PA，五类业务事件逐个映射 Token，记录成功/失败回调；不实现未经确认的收入协议。
4. 正式 AAB 在 Android Studio 原工程构建，测试 APK 在隔离副本构建；两者包名与证书分别核验。Play automatic protection 报 min23 后把本工程相关 minSdk 同步24。
5. 更换 deploy 后发现旧 native 复用策略会跳过编译；强制重建时发现 native API22 与 baselib 符号不匹配，修复到当前min24后完成 native 构建，并核对新库进入包。
6. 正式包名后来按用户原样改为 `com.InfiniteAmmoSupplyWheel.Ammo`，保留大小写，完成新 AAB。最终工程 ZIP 保留原生资源/工具，去掉机密和缓存。
7. 用户提出黑底 Loading 后又明确“上一条不用管，直接打包”；最终工程未加入 Loading。不要把需求讨论、未实施的方案或 iOS 示例能力写成已有成果。

## 失败 → 规则

| 观察或失败 | 后续要怎么做 |
| --- | --- |
| README/HTML坐标与实际Gradle不一致 | 检查本次解析的AAR/POM/API，以用户目标版本为准，不根据标题选择依赖。 |
| 早期缺少 AdvertisingIdClient | 按实际缺类补兼容GMS依赖，确认运行依赖，不伪造GAID。 |
| HTTP200但正文为空、PA status2 | 只证明收到了HTTP响应；记录无有效配置，不能宣布开关成功。 |
| 用户解除IP限制后仍无有效配置 | 真实重试并核对正文/后台策略；不把“权限已解除”当结果。 |
| 每次点击都有提示 | Toast来自当时宿主接入层；移除宿主提示、保留事件处理/日志。不要不经检查就修改SDK。 |
| “正式Token”与测试包、debug混淆 | 包名、PA mode、Adjust环境、构建variant四者分别确认，沿用明确选择。 |
| Adjust未在PA业务回调接上 | 接入从实际 `setEventListener` 到Token映射再到trackEvent，不能只添加依赖或初始化。 |
| 充值样例含金额却没有正式协议 | 先报次数，金额/币种/订单去重后续按契约接，不猜业务语义。 |
| 只改测试副本，用户原工程未更新 | 实际工程落实接入，副本只承担测试包构建；交付时明确源工程。 |
| debug也绑定release签名 | 默认测试需独立签名，核对实际APK证书，不能仅靠assembleDebug任务名。 |
| 正式ID看似拼写或大小写异常 | 按用户原文与当前源码，不擅自把大写改小写或将l/I互换。测试AppID可与代码namespace不同。 |
| GameActivity子类缺父类依赖 | 只暴露必要公开继承链的api依赖，保留游戏入口、native lib元数据和生命周期。 |
| Lint exit0但abortOnError=false | 读取本次Error/Fatal；现有警告不等同构建失败。 |
| deploy更新但libil2cpp未变 | 检查跳过策略、原生输入和散列；需重编译时用本工程实际支持的强制路径。 |
| 链接 __gnu_strerror_r 失败 | 检查自定义native target，编译器和链接器同时与minSdk匹配，别只改Manifest。 |
| AAR与APK内.so字节不同 | 排查strip，记录AAR→merged→stripped→成品来源，不直接判错版本。 |
| readelf解析器读到意外格式 | 工具符号链接和argv[0]会改变格式；不要resolve后把readobj当readelf。 |
| 全局排除build目录打包 | `IL2CPP/build/deploy`是必须输入，只去掉确认的生成缓存。 |
| 在线同步卡在初始化 | 查缓存/仓库可达性和实际缺包；缓存完整才offline，不无限refresh或盲升工具链。 |
| 工程zip有内嵌签名密码 | 只在导出副本外置机密并附空模板，不复制私钥；原工程签名保持有效。 |

## 最后一次可核实基线

本工程最后正式配置：应用1.0.2/code2、min24、target/compile36、ARM64，PA1.0.3正常模式，Adjust5.8.0 production。正式包名如上；测试包是当时明确指定的独立 `com.pakit.ammo.sdktest`，并非新项目默认值。

证据包括原工程 `PA_ADJUST_INTEGRATION.md` 和本轮工作记录 `aab-package-InfiniteAmmoSupplyWheel/validation.json`、`test-apk-new-deploy/delivery-validation.json`、`aab-deploy-rebuild/validation.json`、`project-export-2026-10-25/export-validation.json`。这些相对记录名用于追溯来历，不要求新环境存在该目录。

已证明：对应版本构建、Manifest/签名/ABI/native来源检查，以及源码 ZIP CRC/逐文件校验。最新正式Adjust接入未有真机/后台收数通过记录；旧PA联调结果不升级成新版本成功结论。技能也不把“0错误编译”“PA status0”“Adjust提交”和“后台报表”合并成一句已全链路通过。

## 若新任务要求 Loading

先按新任务检查SDK是否有页面就绪/失败契约，明确遮罩覆盖Unity SurfaceView/系统启动窗口的方式和撤除条件。status0仅表示WebView展示，不能据此假设网页首帧。处理不打开、失败、浏览器返回和重建，避免永久黑屏或重新露游戏；需要真实画面验证。不要把iOS的UIWindow/17pt/方向策略直接搬到Android，也不要因接入本skill自动增加此功能。
