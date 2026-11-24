# 独立测试、设备安装与正式交付

## 独立测试配置

正式工程不需要临时改包名再改回。使用随技能提供的 helper：

```sh
python3 '/path/to/24ios-sdk-integration/scripts/prepare_test_project.py'   --project '/path/to/iOS Export/Unity-iPhone.xcodeproj'   --output-dir '/path/to/work/test-project'   --bundle-id 'com.example.app.pakitdev'   --version '1.0.4'   --target 'Unity-iPhone'   --configuration 'Debug'   --scheme 'Unity-iPhone'
```

版本只是示例，按用户输入填写；可加 `--build` 指定测试 Build，否则保留源值。helper 只生成配置，不连接设备、不构建、不安装。运行后以其实际返回路径为准。

它读取指定 target/config，创建独立 xcodeproj 和 Info-test.plist，仅覆盖主 App 的选定配置；其他 target，尤其 UnityFramework 的 bundle ID 不受影响。副本的 `projectDirPath` 指向正式源目录，共享 scheme 的原工程引用重定向至绝对副本路径，避免仍然构建原项目。原始项目和 Info.plist 内容应保持一致。

此 helper 针对标准 Unity 导出结构。自定义 workspace、构建生成 Info.plist、xcconfig 多层间接值、外部 scheme target 等必须先读它的拒绝提示和当前工程结构，扩展实现或手工准备等价副本；不能遇到错误后直接改正式工程来绕过隔离。原工程的其他构建阶段仍可能写入源目录，本 helper 只保证自身不改源配置。

## 安装脚本的职责

用户要安装时，可从以上副本继续生成 `.command` 或执行设备流程；用户只要脚本时交付脚本，由用户运行。不自动把准备配置当成已经安装成功。

生成脚本应明确项目绝对路径、主 target、scheme、测试版本／包名、独立 DerivedData、签名团队与时间戳日志目录。用可检查的参数或 JSON 配置传值，不把未转义路径插入 shell；路径含空格和 `$` 时仍应正确。每次执行只允许一个实例，设置合理操作超时，输出失败原因和完整日志路径。

设备流程沿用本机 Xcode CLI，先查询实际工具能力与设备状态，不能假定之前连接的 device ID 仍有效。典型命令形态：

```sh
DEVELOPER_DIR='/Applications/Xcode.app/Contents/Developer' xcrun devicectl list devices --json-output '/path/to/devices.json'
DEVELOPER_DIR='/Applications/Xcode.app/Contents/Developer' xcodebuild   -project '/path/to/test-project/Unity-iPhone.xcodeproj'   -scheme 'Unity-iPhone' -configuration Debug   -destination 'id=ACTUAL_DEVICE_UDID' -derivedDataPath '/path/to/test-derived-data'   -allowProvisioningUpdates build
DEVELOPER_DIR='/Applications/Xcode.app/Contents/Developer' xcrun devicectl device install app   --device 'ACTUAL_DEVICE_ID' '/path/to/Products/Debug-iphoneos/App.app'
DEVELOPER_DIR='/Applications/Xcode.app/Contents/Developer' xcrun devicectl device process launch   --device 'ACTUAL_DEVICE_ID' --terminate-existing 'com.example.app.pakitdev'
```

CoreDevice 的 identifier 与 Xcode destination UDID 可能是不同字段。用设备 JSON 的真实字段交叉匹配，不能将第一个 UUID 任意代入所有命令。多台设备时依用户指定选择；未指定时展示可区分设备，不偷偷选一台。不要给 xcodebuild 全局传 `PRODUCT_BUNDLE_IDENTIFIER`，这可能同时污染 framework target。

构建成功后从真实 `.app/Info.plist` 验证版本、Build、主 bundle、ATT 文案、PA 开关；检查嵌入的 UnityFramework bundle ID、实际签名身份及依赖。通过后才安装和启动，日志分别记录每一步状态。错误或超时停止，不无限重试。

工具环境无法访问 CoreDevice 时，保留可复现命令／安装脚本，说明需要用户在普通 Mac 终端运行；不能声称扩大文件权限就能解决所有系统服务访问问题。

## 常见失败的判断

| 证据 | 判断与下一步 |
|---|---|
| `PLA Update available`、会员资源无权访问 | 开发者账号协议未完成；由用户账号完成后再重试，不归因手机权限 |
| 缺少测试 bundle 的 provisioning profile | 确认 Team、账号和自动签名能力及包名；协议问题先处理 |
| IL2CPP／构建工具被系统阻止 | 核对受阻文件与来源；用户已解除后重试该构建，不关闭整个系统安全机制 |
| CLI 不能列设备但 Xcode／普通终端可以 | 记录执行环境限制，交付同一脚本，不用旧设备记录冒充当前连接 |
| 测试包直接进游戏 | 检查 PA 返回状态、正式／测试 bundle 的服务端规则、网络与解析结果；不是仅靠界面断言 SDK 未运行 |
| ATT 没再弹但系统 App 跟踪已开启 | 读取当前状态；已有授权时不应反复请求 |
| Loading 后 SDK 文本黑到看不见 | 查是否误启用了已撤回的网页黑底／快照 gate，并按用户要求回退 |

## 正式版本与打包

主 App 全部相关配置的 `PRODUCT_BUNDLE_IDENTIFIER` 应为用户正式包名。更新版本时同步 `MARKETING_VERSION` 与实际 Info.plist 的 `CFBundleShortVersionString`；Build 是独立字段，只有用户要求或当前任务确需且已明确时才改。不要顺带把 UnityFramework 自己的版本改成 App 版本。

Archive scheme 使用用户期望的 Release 配置，引用正式工程与正式 Info.plist；检查没有临时 bundle、Info-test 路径、测试宏混入。PA 正式模式与 Adjust Production 以本次要求为准。签名策略沿用正确团队，不从他人项目拷贝 provisioning profile 或凭据。

测试脚本若检查源工程版本，正式版本变更时同步该检查及错误消息，不能继续写死旧版本而导致脚本中止。文档明确当前版本，历史测试记录保留当时配置，不把旧编译结果改写为新版本实测。

## 验证、同步和打包

- 仅版本／配置修改：解析 plist 与 pbxproj，比较只发生预期字段变化，必要时 `xcodebuild -showBuildSettings -json` 核实 Release 生效值。
- 新增／修改宿主或链接：做适当的 arm64 编译。未签名 build 能验证编译链接，不代表已签名归档。
- UI／启动问题：真实 SDK 真机冷启动和连续启动验证；本地网页、Metal 替身和模拟器只能证明覆盖到的场景。
- 用户自己上传：交付工程和检查结果，不自行执行 Archive 分发／上传。仅在用户授权归档、安装或上传时执行对应外部操作。

更新交付暂存中的源、Info.plist、pbxproj、说明，并校验 ZIP 里的关键文件与正式工程一致。包含 XCFramework symlink 时用 `ditto -c -k` 等保留链接的方式；不混入 DerivedData、签名凭据、手机日志或临时测试工程。最终说明实际改动和已验证范围，不能只交计划。
