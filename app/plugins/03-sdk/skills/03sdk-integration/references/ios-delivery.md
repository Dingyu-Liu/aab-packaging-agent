# iOS 构建、测试包与一键安装

## 范围与默认执行

用户以本skill要求接入时，完成代码、相关测试和构建后，有可用设备就默认安装独立测试包并验证；没有设备就交付可双击 `.command`，并完成可行的免签编译检查。用户明确不操作手机/自行安装/暂停设备测试时遵守新指令。本skill不要求发布App Store、改后台、提交法律协议或发送外部消息。

附带helper `scripts/ios_test_delivery.py` 只处理**已完成接入的 Unity iOS Xcode 导出工程**：复制项目描述成独立测试工程、保留原SRCROOT引用，只覆盖App target；其他target保持Bundle ID，源文件沿用本次改动，不复制整个游戏。Unity源工程先选当前正确编辑器导出，不能把旧导出当新代码。复杂workspace、App Extension、特殊entitlements由agent先适配测试工程/helper，不能无条件删除能力换取签名通过。

## 参数与调用

从 `assets/build-inputs.example.json` 生成本次 `build-inputs.json`，它只含构建/安装参数，不接受SDK key。必要字段：

| 字段 | 用途 |
| --- | --- |
| project_root | iOS导出工程绝对路径；也支持相对于参数文件 |
| xcode_project / app_target | 相对于root的.xcodeproj、App target名；不能传UnityFramework |
| test_bundle_id | 独立测试包名，默认由agent取正式包名+.sdktest；helper拒绝与正式相同 |
| version / build_number | 具体数值，测试迭代Build递增；不是模板说明文字 |
| test_display_name | 可空，默认现显示名加Test；用户给了就保持原空格和文字 |
| development_team | 可空：优先正式工程团队有本机有效身份，否则唯一可用团队；多团队必须显式选 |
| device_id | 可空：唯一候选自动选；多候选必须选；支持CoreDevice ID或UDID |
| output_dir | 相对root或绝对目录；默认root旁的交付目录；不能等于root |
| developer_dir | 可空：环境/当前完整Xcode/标准Xcode路径，逐命令DEVELOPER_DIR |
| allow_provisioning_updates | 默认true，授权Xcode为测试App/设备更新开发描述文件 |
| launch_after_install | 默认true；用户只要安装或自己操作时false |
| info_plist / production_bundle_id | 复杂变量解析时显式填写；不能指向另一个旧工程 |
| dependency_projects | 可选额外依赖工程；默认自动加入root下Pods/Pods.xcodeproj |

```sh
# 正常交付：连机则构建签名安装；无设备则立即交付一键脚本
python3 /path/to/03sdk-integration/scripts/ios_test_delivery.py --config /path/to/build-inputs.json

# 无设备时仍做generic iOS免签编译验证，然后交付相同一键脚本
python3 /path/to/03sdk-integration/scripts/ios_test_delivery.py --config /path/to/build-inputs.json --build-without-device

# 只生成可审查的测试工程与command，绝不构建、签名或操作设备
python3 /path/to/03sdk-integration/scripts/ios_test_delivery.py --config /path/to/build-inputs.json --prepare-only
```

输出含：`TestProject/`、`DerivedData/`（构建后）、`一键安装测试包.command`、本地 `ios_test_delivery.py`、解析后的 `build-inputs.json`、`logs/<UTC运行ID>/`。`.command`可双击，脚本自身不依赖该skill仍被安装；它会在将来连机时重新签名构建安装，而不是对无设备时期的免签包执行必然失败的install。

此command用于当前Mac/当前源码路径，依赖macOS、完整Xcode、Python3、原工程/Pods和可用Apple开发者签名。它不是跨机器的OTA安装链接；迁机需同步工程及依赖、更新project_root和签名配置。不可承诺无Xcode/无证书的Mac双击即可签名。如果仅交现成签名包，仍需核对该手机在profile内且未过期，过期/新增设备必须重签构建。

## 设备判断

使用 `devicectl list devices --json-output`，不解析表格stdout。过滤真实iOS设备；有线已配对但`no DDI`/tunnel未连接的设备仍需探测，`device info details`可促成挂载。不仅凭tunnelState筛选：wire/connected tunnel/DDI服务均是候选依据。缓存的已配对无线设备、当前tunnel disconnected且无DDI，不算现在连接。

有唯一可用候选自动继续；多候选且用户没指定就列出必要名字/ID集中选择，不能默认第一台。开发者模式、解锁/配对/信任未完成时给具体手机步骤，保留脚本待重试。当前无候选就是无设备分支，不自动装模拟器。工具不支持或列表结构变化时先检查Xcode版本/JSON，不能宣称没有设备或安装成功。

## 签名事实与失败处理

- `security find-identity -v -p codesigning`只说明本机私钥身份有效。证书CN括号后缀不是可靠Team ID，核对证书subject OU、profile TeamIdentifier、app identifier、ProvisionedDevices与有效期。
- 优先用户指定团队，其次原工程团队在本机可用，再其次唯一本机有效团队。多团队或账号权限冲突需明确选择。个人团队期限通常短，记录实际profile到期时间，不硬写固定7天。
- Xcode使用自动签名和允许的profile/device registration；不把全局`PRODUCT_BUNDLE_IDENTIFIER=测试值`传给所有target，避免框架也被改成相同包名。只在独立测试App配置改包名/显示名/版本。
- 测试包沿用业务AFID配置、App Store ID、devKey、PA参数；测试包可能触发服务端不同策略，这个区别要记入证据。不能靠换SDK应用身份冒充正式归因测试。
- 公司PLA待接受时不能代签法律协议；已有明确授权的测试团队可另选，不替用户接受。缺账号/身份则在Xcode正常配置后重试；脚本不无限造证书、不静默换团队。
- 安装前 `codesign --verify --deep --strict`，检查最终Info.plist版本、签名profile的bundle/team、设备是否包含及有效期。安装后再用设备apps JSON确认Bundle/version/Build。
- launch拒绝提示签名/entitlement/trust时，不直接断言代码坏了；先对照本地校验和手机的信任开发者步骤。LaunchServicesDataMismatch需等安装完成后再launch，不并发依赖操作。
- 不改变全局xcode-select。完整Xcode已装但默认CommandLineTools时，给命令设置DEVELOPER_DIR；不为此重装Unity/Xcode。

## 构建与证据

开发构建按真实依赖/架构做arm64 iPhoneOS全编译，免签通过不等于可安装。静态/动态SDK重复链接、framework嵌入、Swift运行时、最低iOS版本、`-ObjC`按实际依赖检查。当前库最低17.2而目标15.0的警告不可靠一次iOS18成功消除；新工程要取得兼容库或明确最低版本决策。

helper只验证安装与launch结果。接入agent还要采集本次console/本地日志、实际配置响应、Web主文档、首屏/回退、画面和声音。可用：

```sh
DEVELOPER_DIR=/path/to/Xcode.app/Contents/Developer xcrun devicectl device process launch \
  --device <selected-device-id> --console --terminate-existing <test-bundle-id>
```

console长期进程要在工具中非阻塞运行/限时轮询，记录PID和日志，不在主线程睡眠数分钟。没有新增关注点就不反复冷启动/重装。用户选择自行复测后，不再沿默认规则重启他正在用的手机。

交付说明精确写“构建通过/签名校验通过/安装并启动/首屏成功/听感用户确认/后台未验证”，不要把launchJSON success当端到端验收。
