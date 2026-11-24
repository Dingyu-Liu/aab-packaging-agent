# 工程与 SDK 检查

## 找对工程

读取最新用户指定路径和工程配置，确认主 target 的 `INFOPLIST_FILE`、`PRODUCT_NAME`、`PRODUCT_BUNDLE_IDENTIFIER`、`MARKETING_VERSION`、`CURRENT_PROJECT_VERSION`，以及共享 Scheme 的 Build／Archive target。`.xcodeproj` 目录本身不包含全部源代码；沿 `projectDirPath`、分组路径和引用找到真实工程根目录。

先搜索现有 PAKit、Adjust、ATT 与 `IMPL_APP_CONTROLLER_SUBCLASS`。已有 AppController 时合并生命周期 hook，不注册第二个替换类。不要另建一套重复初始化或重复事件上报。

## 审查输入包

先列 ZIP 条目，再解压到分开的工作目录。拒绝路径穿越条目；不要覆盖原工程。对新旧包分别记录文件清单和 SHA-256，确认后缀 `(1)` 的新包是否真的更新。

可用的本地检查方式：

```sh
/usr/bin/unzip -l '/path/to/sdk.zip'
/usr/bin/file '/path/to/libPAKit.a'
xcrun lipo -archs '/path/to/libPAKit.a'
xcrun otool -l '/path/to/libPAKit.a'
/usr/bin/strings -a '/path/to/libPAKit.a'
/usr/bin/shasum -a 256 '/path/to/libPAKit.a'
```

`arm64` 同时可能属于设备或 Apple Silicon 模拟器。结合对象的 `LC_BUILD_VERSION`／平台信息以及 XCFramework 的 `SupportedPlatformVariant` 识别，不把设备与模拟器 arm64 合为一个 lipo 库。核实公开头文件是否在各切片一致，SDK deployment target 是否与 App 兼容。

确认切片后，可按实际路径生成 XCFramework：

```sh
DEVELOPER_DIR='/Applications/Xcode.app/Contents/Developer' xcodebuild -create-xcframework   -library '/path/device/libPAKit.a' -headers '/path/device/Headers'   -library '/path/simulator/libPAKit.a' -headers '/path/simulator/Headers'   -output '/path/output/PAKit.xcframework'
```

已提供正确 XCFramework 时优先直接使用。当前模板来自静态 PAKit `.a`，不是动态嵌入框架；更换包装方式不应修改库二进制或 API。

## 域名与 API 合同

比对头文件和 demo。当前模板依赖：

```objc
[PA setPa:nullableIdentifierA b:nullableIDFA];
[PA setEventCallback:^(NSString *eventName, NSDictionary *params) { /* bridge */ }];
[PA st:mode a:trackingStatus u:installationID c:^(NSInteger status) { /* result */ }];
```

本案例头文件没有设置域名的公开方法。`Info.plist` 中 `PAKitExpectedConfigEndpoint` 只记录预期域名，不能改变 SDK 内置请求地址。若二进制中仍是旧域名，说明工程侧填写新地址不足以解决；继续完成可做的宿主接入，同时向用户说明需匹配的新 SDK、公开配置 API 或厂商源码。不要按字符串长度修改 Mach-O。

供应商 iOS 文档与 HTML demo 曾对 openWindow 默认拼参行为描述不一致，demo 还出现 Android AAR 字样。遇到此类冲突按当前 iOS 库与真实行为核实，不照搬其他平台说明。

用字符串可找到候选 URL，不足以证明实际使用哪个分支；必要时结合 SDK 文档、请求日志或真机网络结果核实。排查分别记录 DNS/TLS、HTTP 状态、响应字节数／类型、SDK 返回状态、最终页面加载，不把 HTTP 200 或空响应直接称作 SDK 正常／异常。

本模板使用 `st:0` 对应已核实的正式模式。其他 SDK 的模式数值、status 含义和回调时机必须由其当前材料确认，不机械复用。

## 链接与依赖

本案例五个 `.m/.mm` 宿主实现加入 `UnityFramework` Sources：Integration、AdjustIntegration、AppController、LoadingView、SafeAreaViewController；头文件只需正确引用。PAKit、AdjustSdk、AdjustSigSdk 静态 XCFramework 同样由该 target 链接，不设为动态 Embed。

在保留 `$(inherited)` 和 Unity 原有设置的基础上加入所需 header/library 搜索路径及 `-ObjC`。按实际 SDK 引用配置 WebKit、AppTrackingTransparency、AdSupport、CoreTelephony、Security、SystemConfiguration、StoreKit 等系统依赖；不要因为模板列表存在就无条件加所有 framework。

本案例曾使用 Adjust iOS SDK 5.8.0 与 Signature 5.0.0，模板采用 Adjust v5 的 `initSdk:` API。这是既有实现的兼容记录，不能宣称是最新版本。新任务优先采用项目已有兼容版本；用户要求下载／升级时核实 Adjust 官方仓库、发行信息、产物平台和校验值。需要网络但被拒绝时报告实际失败点，不换成来源不明的包。

保留 SDK 内的隐私清单与许可文件；如果本工程的静态链接方式需要将清单内容合并到最终 bundle，按已读 vendor 内容合并，保留 Unity 现有声明。不能从示例编造跟踪域名或 API 理由。打包带符号链接的 XCFramework 使用能保留链接的工具，如 macOS `ditto`。
