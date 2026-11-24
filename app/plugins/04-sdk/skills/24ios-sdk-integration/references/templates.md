# 宿主模板与配置

## 适用范围

`assets/unity-host/Classes/PAKit/` 包含 9 个宿主头文件／实现文件，基于本次完成回退的代码。它们依赖当前 Unity 导出源码、PA 公开头文件和 Adjust v5；没有携带任何供应商二进制。模板验证来源为 Unity 6000.0.77f1 / iOS 17.2+，不能声称适配所有 Unity 版本或低版本系统。

在复制之前检查当前项目是否已有同名类、AppController 宏、Adjust delegate、事件观察者；合并已有处理，避免替换掉其他插件。原生项目仅参考独立的 ATT、事件桥和页面容器，不使用 `PAKitAppController.mm`。

## 生成参数化宿主

复制 `assets/integration-config.example.json` 到本次工作目录，填入用户真实配置。示例值故意不能直接通过校验，不会默认复用过去项目的 token、域名、账号或 App ID。

```sh
python3 '/path/to/24ios-sdk-integration/scripts/render_host_sources.py'   --config '/path/to/work/integration-config.json'   --output '/path/to/work/generated-host'
```

需要统一 launch storyboard 时加 `--include-launch-storyboards`。输出目录必须不存在或为空，脚本不会直接修改 Xcode 工程。之后按需要把生成文件加入真实工程，设置正确的 target membership 与依赖。

配置说明：

| 字段 | 用途 |
|---|---|
| `app_store_id` | 记录本次 App Store ID，独立于 bundle、安装 UUID、Adjust token |
| `expected_config_endpoint` | 记录 SDK 预期域名，不能改变库内部请求 URL |
| `tracking_usage_description` | 实际 App 的 ATT 用途说明 |
| `adjust_app_token` | Adjust 初始化 token |
| `adjust_environment` | `production` 或 `sandbox`，按本次用户要求 |
| `pa_start_mode` | 已按供应商文档核实的整数；本案例正式模式为 0 |
| `adjust_event_tokens` | 事件名→token 字典；只填真实已知映射，保留大小写 |

生成的 `Info.plist.fragment` 包含接入开关、App ID／预期域名记录和 ATT 文案，是合并材料，不能替换原 Info.plist。PA 公开 API 没有这些配置 setter 时，两个记录字段不能覆盖 SDK 内部配置。

`INTEGRATION-MANIFEST.json` 记录模板来源、环境和生成文件 hash，用于核对交付；不替代编译与真机验证。配置可能包含业务 token，交付时只放本次需要的材料，不把其他项目配置混进通用技能。

## 把文件接入工程

- 新增 source ref／build file 时只加入实际编译目标；当前 Unity 模板是 UnityFramework，主 App 保持原本的 framework 嵌入关系。
- 将 AppController 与现有导出生命周期合并；检查 SDK `PAWebViewController` 呈现路径。确认公开 PA 头文件的方法签名仍匹配。
- 合并 Info.plist、隐私清单、系统依赖、静态库路径，保留已有设置。不要覆盖现有 app 图标、启动页或方向，除非本次用户要求。
- 使用可定位的备份／diff 验证；新导出 Unity 项目可能覆盖手工修改，若用户要求跨导出持久化，再将同样逻辑转为 Unity PostProcessBuild，不能静默扩展到 C# 原项目。

## 实际测试边界

资产逻辑来自已编译的项目，生成器本身只做参数渲染和输入验证。把 token 替换成功不代表新项目已经构建；更换 Unity、SDK 或最低系统版本都需重新验证。不要把示例工程测试结果复制成新项目的测试报告。
