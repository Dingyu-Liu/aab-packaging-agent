# 工程与 SDK：先建立事实

## 原工程与参数

用户第一次曾提供另一个同名 Xcode 工程，之后纠正为实际 iOS 导出工程。不能从历史对话选一个熟悉的路径继续做；每次核对最新 `.xcodeproj`／`.xcworkspace`、`projectDirPath`、主 App target、UnityFramework target、共享 scheme 与 `INFOPLIST_FILE`。没有当前 UI 证据时不能说“看到了 Xcode 正打开哪个工程”。

检查现有 `IMPL_APP_CONTROLLER_SUBCLASS`、ATT 入口、Adjust 初始化、PA 回调，避免第二个替换类或多份事件上报。Unity 原生插件的通知、方向和已有启动处理保留。原生 App / SceneDelegate 项目需按实际入口适配，本包标准工程接入器不支持时由 agent 修改相应部分，不复制 Unity 私有成员。

App Store 数字 ID、Bundle ID、Adjust app token、event token、安装 UUID、CoreDevice ID 和硬件 UDID 各有用途，不能互换。显示名沿用用户要求，不因测试包或 skill 编号加前缀。

## SDK 输入与架构

SDK zip 先列条目，解压到独立目录，拒绝绝对路径／`..` 穿越；记录 SHA256，不覆盖源工程。对名字带 `(1)` 的新包按内容比较，不能认为文件名就是版本。

```sh
unzip -l '/path/pa-arm.zip'
file '/path/libPAKit.a'
xcrun lipo -archs '/path/libPAKit.a'
xcrun otool -l '/path/libPAKit.a'
strings -a '/path/libPAKit.a'
shasum -a 256 '/path/libPAKit.a'
```

本案实际是设备 arm64 与模拟器 arm64+x86_64。arm64 可能属于两个平台，结合对象 `LC_BUILD_VERSION` 和 XCFramework `SupportedPlatformVariant` 判断；不把两种 arm64 用 lipo 合成一个库。公开头文件要对应本次库，切片 header 一致性可 hash 比较。

用户只提供两份 `.a` 包时，确认平台后生成标准 XCFramework：

```sh
DEVELOPER_DIR='/Applications/Xcode.app/Contents/Developer' xcodebuild -create-xcframework   -library '/path/device/libPAKit.a' -headers '/path/device/Headers'   -library '/path/simulator/libPAKit.a' -headers '/path/simulator/Headers'   -output '/path/work/PAKit.xcframework'
```

`integration-inputs` 中 `sdk.xcframework` 填准备好的目录。可先从对话收原始包路径，再由 agent 完成上面的核验和包装，用户不必自己打 XCFramework。已有正确包不重复改包装。Adjust 缺包时读取现有版本或按当前厂商官方发行说明获取兼容静态库，不把本案曾用的 v5.8.0 / Signature5.0.0 声称为最新。

## PA API 与域名

当前宿主基于这三个公开方法：

```objc
[PA setPa:optionalIdentifierA b:optionalIDFA];
[PA setEventCallback:^(NSString *eventName, NSDictionary *params) { /* bridge */ }];
[PA st:mode a:trackingStatus u:installationUUID c:^(NSInteger status) { /* status */ }];
```

实际包没有公开域名 setter。`PAKitExpectedConfigEndpoint` 是审计记录，`PAKitAppStoreID` 同样只是宿主配置记录，不会覆盖 SDK 内部变量。内置地址不匹配且没有公开配置方法时需厂商新包／源码；不能二进制字符串替换。先说明材料问题，同时继续不依赖新版的工作。

`strings` 能发现候选 URL，不足以证明实际分支；SDK 文档和 demo 曾对 `openWindow` 默认拼参有冲突，HTML 还出现 AAR 字样。按当前 iOS 实现验证，不搬 Android 或另一示例的协议。不能构造 `/api_v1/system/get_system_info`、签名或 H5 ACK 来代替 PA 内部请求。

## 链接和隐私

本案 PAKit、AdjustSdk、AdjustSigSdk 都是静态 XCFramework，和五个宿主实现一起由 UnityFramework 编译链接；主 App 负责 Info.plist、签名及嵌入 UnityFramework。静态库不重复动态 Embed。保留 `-ObjC`、ARC 与 `$(inherited)`，只补实际需要的 header 路径和系统 framework。

系统依赖按头文件和实际 undefined 符号／厂商资料确认，当前用到 WebKit、AppTrackingTransparency、AdSupport，以及需要的 StoreKit、Security、CoreTelephony、SystemConfiguration 等。不要清空 Unity IL2CPP 链接 flag。

保留供应商 privacy manifests 和许可。需要合并到最终静态链接 bundle 时按原文内容合并、保留 Unity 已有声明；不能编造 required-reason code、跟踪域名或把对方整个清单覆盖现有文件。验证最终包，而不只查源文件。拷贝和打包框架保留 symlink，使用 `shutil.copytree(..., symlinks=True)` / `ditto` 等。

标准工程接入器见 [automation.md](automation.md)。它只处理明确支持的结构，不会自动修正厂商 API／域名合同。
