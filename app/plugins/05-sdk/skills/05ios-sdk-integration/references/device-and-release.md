# 设备测试、正式交付与一键脚本

## 默认分流

用户调用本 skill 完成接入且未要求自行测试时，测试安装是接入任务的一部分。先生成自包含 `.command` 文件夹，再探测；不等到工具失败才匆忙交一个依赖消失路径的脚本。

- 唯一可用已配对真机：构建独立测试包、校验产物、安装、启动，保留本次独立记录。
- 明确指定device：只匹配它，不静默换手机；不满足条件时保留脚本与具体原因。
- 多个设备但没有目标：不随机安装，交脚本并说明需选定设备。
- 无设备／锁定／未配对／开发模式或DDI不就绪／CLI不可访问：写明实际类别，交脚本。当前工具不可用不等于物理上没连接。
- 用户明确自行运行、只改版本或暂停手机操作：只做对应范围，后续不能以默认流程再安装。

安装过程中不会替用户同意Apple条款或更改手机权限，不关闭系统安全机制。PLA Update、无可用profile由用户账号完成必要步骤后复测；现有有效账号、team与自动签名沿用，不复制过去项目team。

## 交付工具的行为

`scripts/delivery.py` 按 [automation.md](automation.md) 调用，生成的文件夹包括 `.command`、运行参数、runner、独立工程helper。原项目路径保存在参数中，可以修改；移动整个交付文件夹后仍能运行，不依赖当前skill安装目录。保留macOS可执行位；用户双击.command后重新探测而非固定旧设备ID或旧.app。

CoreDevice `identifier` 用于devicectl，hardwareProperties.udid用于xcodebuild；结合设备JSON、配对/开发就绪及实际destination匹配。不能只凭`tunnelState=connected`，也不能把有线但tunnel未连视作绝对不可用。检测有合理timeout，失败结束本次流程，避免轮询占满终端。

构建使用独立project、Info-test.plist、DerivedData、Apple Development自动签名，team来自本次test参数或当前主App选定配置。不要为了测试强制改正式target签名。每次用新的时间戳/run记录目录，锁住并发执行；只有本次真实构建/安装/启动JSON可用作结果。

验证实际`.app/Info.plist`的测试bundle、version/build、本次ATT文案、PA开关和AppID／预期域名；按参数逐值核对Loading／安全区域／超时，不能只看key存在。UnityFramework保持其原bundle身份，并核对最终PrivacyInfo.xcprivacy与本次源清单一致；缺失／不一致时停止安装，需定位实际资源路径。安装之后launch命令成功标为 installed_and_launched，不能自动标“SDK已显示／后端正常”。如果能取得进程日志／截图，就记录本次运行对应证据；否则如实标待真机画面确认。

脚本涉及源工程的自定义IL2CPP构建阶段可能在其原有位置写产物，独立配置只保证helper自己不改正式pbxproj/Info.plist，不承诺所有第三方build script绝不写源目录。任务结束核对受保护源配置hash。

## 常见错误定位

| 输出 | 下一步 |
|---|---|
| PLA Update available / membership resource | 开发者账号条款，不能归因手机权限 |
| No profiles found | 核对测试bundle、team、账号、自动签名与条款 |
| 系统拦截IL2CPP工具 | 核对实际受阻文件，用户处理后重试该构建，不全局关闭安全设置 |
| 编译失败 | 报编译／链接错误和日志路径，不继续安装旧.app |
| .app版本/包名不符 | 停止安装，修复副本与最终Info，不安装缓存包 |
| CoreDevice查询失败 | 脚本后备，区分无设备与CLI限制 |
| SDK直接进游戏 | 查PA status与测试包服务端规则，不用画面断言未初始化 |
| SDK长期黑屏 | 查是否误带黑底覆盖／快照gate；也查请求是否从不callback |
| Adjust queued但无后台事件 | 不自行循环补发，核实delegate与后台实际记录 |

## 正式版本与上传

只把主App所有相关configuration和真实Info.plist改为本次正式bundle/version/build。版本字段变更做结构diff、plist语法、showBuildSettings即可；宿主源/依赖变动做相应编译。不能把UnityFramework版本字段也机械改成App版本。

Archive scheme引用正式project与Release，不含Info-test、临时bundle或测试宏。PA模式和Adjust环境按本次输入独立核对。签名策略保持正确team，不从范例硬编码。更新版本后同步安装脚本的源版本前置条件。

交付工程改动ZIP时同步真实源、pbxproj、Info、privacy和说明，保留静态框架symlink；排除DerivedData、历史手机日志和凭据。用户说自行编译上传时不要自动上传。报告要区分：源码更新完成、未签名编译通过、签名归档成功、设备已安装启动、实际SDK画面、后台收录；只声明证据支持的层级。
