# 参数与自动化命令

## 参数来源与范围

复制 [integration-inputs.example.json](../assets/integration-inputs.example.json)，替换本次工程／SDK路径和业务参数。用户可直接在对话给表格，agent整理为同样JSON，不让用户为了工具重复填写。

| 对象 | 核心字段及来源 |
|---|---|
| project | path、主target、framework_target、shared scheme；从用户路径和工程读 |
| app | 正式bundle_id、version、build、真实tracking_usage_description |
| sdk | 已核实xcframework、数字app_store_id、expected_config_endpoint、start_mode；可选供应商privacy_manifest |
| adjust | sdk_xcframework、可选signature_xcframework、app_token、environment、event_tokens；可选同版本privacy_manifest和signature_privacy_manifest |
| runtime | unity_profile；标准helper须已核实为unity6000-ios17，不凭文件名填 |
| ui | startup_loading、safe_area、initial_page_timeout_seconds（默认60） |
| test | 独立bundle_id；可省version/build继承正式；team_id/device_id可空，从当前可用配置／唯一设备确定 |
| xcode | developer_dir，默认本机/Applications/Xcode.app/Contents/Developer |

路径可相对参数文件，统一入口会归一为绝对路径。原始zip由agent先按 [project-and-sdk.md](project-and-sdk.md) 检查并包装，xcframework路径是准备结果。没有厂商SDK、app token或事件token时如实标材料未齐，不用过去项目的业务值补齐。总入口省略test.bundle_id时按正式包名加`.sdktest`；单步delivery要求明确填写，agent先补全。已有本次约定则沿用。总入口在正式源码写入前校验测试身份与参数，错误不应留到安装阶段才发现。

版本、team和设备都不从skill示例硬编码。测试环境不由Debug推导；Production只是本例用户要求的环境样式，新任务按实际输入。模板占位值故意不能直接执行通过。

## 一次运行：标准Unity导出

```sh
python3 '/PATH/05ios-sdk-integration/scripts/run_integration.py' \
  --config '/PATH/本次接入参数.json' \
  --output-dir '/PATH/本次接入工作与交付'
```

顺序：参数渲染 → 只读工程预检 → 正式工程接入 → 先生成测试安装文件夹再探测设备 → 有唯一可用设备就用测试包构建安装启动；其他情况保留脚本并运行可用的未签名arm64编译。签名测试构建已经完成时不重复本地编译。

`--plan-only`：只渲染模板和只读预检，不修改工程、不构建、不访问设备。适用于先检查材料和可支持性。

`--script-only`：仍落地正式接入并本地编译，只交付一键脚本，不探测／安装设备。用户说自己测试时用这个模式。

输出每次位于`output-dir/runs/<UTC时间>-<短ID>/`，`latest.json`指向本次结果。阻断报告只说明缺什么，不代表已完成接入；需要agent继续适配，不能把blocked当成功交差。现有无关AppController、不同Unity入口、xcconfig、多工程workspace或未知接入不由脚本盲改。

创建／编辑技能本身的任务，不运行默认入口来安装当前设备；只能对隔离fixture执行离线测试，或用plan-only。只有用户本次确实要接入工程时才按默认流程操作。

## 单步使用与排错

```sh
python3 '/PATH/skill/scripts/render_host_sources.py' \
  --config '/PATH/参数.json' --output '/PATH/work/GeneratedHost' --include-launch-storyboards
python3 '/PATH/skill/scripts/integrate_xcode.py' \
  --config '/PATH/参数.json' --generated-host '/PATH/work/GeneratedHost' \
  --output-report '/PATH/work/preflight.json' --check-only
python3 '/PATH/skill/scripts/integrate_xcode.py' \
  --config '/PATH/参数.json' --generated-host '/PATH/work/GeneratedHost' \
  --output-report '/PATH/work/integration-report.json'
python3 '/PATH/skill/scripts/delivery.py' \
  --config '/PATH/参数.json' --output-dir '/PATH/outputs/测试安装'
```

最后一条加`--script-only`只生成完整安装文件夹，连设备探测也不执行。这与总入口的script-only不同：delivery脚本单步不会替你编译验证源代码。

`render_host_sources.py`不改项目，输出9个宿主文件、Info.plist.fragment、manifest及可选launch storyboard。fragment是合并材料，不能替换整个App Info.plist。renderer拒绝覆盖非空目录，重生成用新目录。

`integrate_xcode.py`将五个实现加入UnityFramework Sources并设置文件级ARC，静态XCFramework加入Link；保留其他target、IL2CPP flags、已有资源。主App所有相关配置与Info设置正式bundle/version/build。统一Loading会同步已有的iPhone／iPod设备专用启动页键，避免旧页覆盖默认值。PAKit相关目录由管理manifest跟踪，外部修改／类名碰撞／其他来源接入会blocked，由agent核查并合并。

预检检查静态容器和XCFramework元数据，空archive或只有占位头信息不构成可运行SDK；它不代替对真实对象的lipo/otool检查、API核验和arm64编译。fixture里的空ar仅用于结构测试，不能拿来完成真实接入。

标准支持：已核验Unity6000、iOS17+、App+UnityFramework、显式Info、单project shared scheme，实际存在本案controller/rootView接口。模板验证来源为iOS17.2；>=17门槛只是自动工具的初筛，不保证新的导出完全兼容。已支持本案单窗口UnityScene：保留manifest，并核验源码对AppController的生命周期转发和初始化；自定义SceneDelegate、多场景、原生App、已有自定义AppController、xcconfig、生成式Info、多工程scheme必须按实际结构适配。不能为了通过预检修改版本声明／删除插件。

工程接入器在`.05ios-sdk-integration/`存管理manifest和逐次备份。先预检、暂存与hash核对再写入；失败自动恢复，重复无变化执行不重复引用。需要回退时按本次backup rollback.json恢复精确文件，保留用户后续无关变化；不要全目录覆盖。备份和本次参数仅保存在工程／工作目录，不混进通用技能包。

静态依赖会合并UnityFramework已有PrivacyInfo，保留原声明。缺Adjust同版本privacy时明确阻断，可给官方manifest路径；PA包无清单时只记录缺失事实，发布前需要核对，不能编造。涉及业务含义的缺口不是脚本能推导的。

## 只准备独立测试副本

```sh
python3 '/PATH/skill/scripts/prepare_test_project.py' \
  --project '/PATH/Unity-iPhone.xcodeproj' --output-dir '/PATH/work/TestProject' \
  --bundle-id 'com.example.game.sdktest' --version '1.0.4' --build '2' \
  --target 'Unity-iPhone' --configuration 'Debug' --scheme 'Unity-iPhone'
```

副本projectDirPath指向源；仅改选定App配置，Info-test.plist为独立副本，shared scheme引用副本绝对路径。所有副本scheme action均指向测试configuration，避免误用正式Archive。此helper不构建／连接设备／签名／安装。

## 不夸大自动化结果

run结果installed_and_launched代表签名测试包安装和launch命令完成；script_ready代表交付脚本已存在，查evidence判断编译是否通过；validation_blocked要报告具体限制。线上SDK画面、ATT新授权、Adjust成功callback和后台记录需本次运行证据，不能由退出码0推导。
