# 参数、默认值与启动方式

本技能由 Codex 执行工程检查、按实际 DSL 合并接入、运行构建和验包。辅助脚本负责可重复且容易出错的部分；不是将任意 Android 工程交给一个全局字符串替换脚本。

## 用户最少给什么

```text
使用 05GPsdk接入。
工程：/绝对路径/AndroidProject
PA Maven 坐标：本次指定的 group:artifact:version
开关域名：本次后台域名（用于核验目标 SDK，而不是创造 setDomain API）
Maven 仓库：地址；凭据从指定本机文件或环境变量读取
Adjust：App Token、每个事件名对应的 Token、sandbox 或 production；不接则明确关闭
测试包名：可省略，默认正式 applicationId + .sdktest
应用版本：可省略，沿用当前工程
交付：默认测试 APK；若还需要安装到手机请明确说明
```

既有工程中的 repository、正式包名、Adjust Token/环境或版本已经有效且用户要沿用时直接读取。不要把上一款游戏参数变成下一款默认值。用户说“不要 Adjust”时不为了套模板强行引入。用户只说更新 PA，保留其已确认的 Adjust；不要重复初始化。

## JSON 约定

[参数模板](../assets/integration-inputs.example.json) 是完整的录入外形。自然语言也可使用，先由执行者结合源码转换为本次 `params.json`。根路径必须是绝对路径；本机 JSON 可含本次真实 Token，应存工作区私有文件并设置合理权限，不随通用 skill 导出。

| 字段 | 处理 |
| --- | --- |
| `project_dir` | 原工程，不是 Downloads 旧副本；校验需存在 `settings.gradle` 或 `settings.gradle.kts`。 |
| `production_application_id` | 当前正式 App ID，按实际值保留大小写，不能用样例 `com.example.game`。 |
| `test_application_id` | 可为 null，由正式值加 `.sdktest`；必须与正式值不同。 |
| `app_version_name` / `app_version_code` | 可为 null，构建沿用实际值。显式给 code 必须为正整数。 |
| `pa.maven_coordinate` / `repository_url` | 当前坐标和真实仓库；仅接受已核实契约，版本不存在不能自动降级。 |
| `pa.expected_domain` | 可为 null；已知时用于 AAR/运行行为核验，不代表有运行时 setter。 |
| `pa.mode` / `att` | 默认 0 / 1；明确 Mock 请求才更改 mode，模式和构建类型相互独立。 |
| `pa.identity_policy` | `persistent_installation`：无原生账号时稳定本地安装标识；`existing_provider`：读取现有运行时业务 UID。后者须合并原账号逻辑，不能用模板静态替换。 |
| `adjust.enabled` | 明确不接时 false；已有接入且沿用时保留。 |
| `adjust.maven_coordinate` / `environment` | 当前确定版本与 sandbox/production，模板示例版本不是未来最新版承诺。 |
| `adjust.app_token` / `event_tokens` | 启用时必须有真实 App Token；只有明确提供 Token 的事件才上报，event_tokens 可以为空字典但需说明未接事件。null 占位项必须补齐或在本次明确不接该事件时移除。 |
| `host.package_name` / `base_activity` | 由 namespace 和真实父类确定，仅模板生成时必填。存在原 Application/Activity 时优先合并现有文件。 |
| `build.module` / `build_type` | 默认 `:launcher` / `debug` 只针对模板；普通原生工程常为 `:app`，必须实际识别。测试助手支持单应用无 flavor 工程，其他 variant 由执行者适配。 |
| `build.sdk_dir` | 可空并沿用源本机 `local.properties`；跨机器需填本机 SDK 位置。Gradle JDK/缓存由实际机器发现，不记录他人绝对路径。 |
| `delivery.output_dir` | 本次产物输出目录；其余临时源码、日志放工作目录。 |
| `delivery.install` / `aab` | 默认 false；只有本次明确要求或仍有效的授权才为 true。手机已连接本身不是安装请求。 |

## 推荐调用

```sh
python3 /path/to/05gp-sdk-integration/scripts/project_inputs.py /private/work/params.json
python3 /path/to/05gp-sdk-integration/scripts/render_host_sources.py --config /private/work/params.json --output /private/work/generated-host
python3 /path/to/05gp-sdk-integration/scripts/prepare_test_project.py --config /private/work/params.json --destination /private/work/gp-test-project
```

先阅读当前 API 和宿主，再按需运行 renderer；不是每次都生成一套新入口。输出目录不存在时才创建，脚本不覆盖现有工程。`prepare_test_project.py` 只建立测试副本、签名及 Gradle init 脚本；随后必须执行它给出的构建命令并校验 APK，才能结束默认任务。

用户说“只初始化 Adjust，不接事件”时，将 `event_tokens` 规范化为 `{}`；不保留模板里的五个 null，也不为这些未请求事件追问 Token。

主机参数不明时自行发现 Gradle wrapper、Android SDK、Build Tools、JDK、NDK/CMake。离线缓存完整可使用 `--offline`；依赖不存在需正常解析私有仓库，不能以离线失败宣称 SDK 不存在。缺少凭据只报告参数名或配置位置，不回显密码。后台需允许测试 applicationId 才能验证对应开关路径；未放行时交付已验 APK 并说明请求阶段失败，不伪装请求中的包名为正式值。
