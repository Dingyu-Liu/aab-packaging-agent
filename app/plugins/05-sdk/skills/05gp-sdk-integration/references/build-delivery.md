# 自动测试 APK、正式 AAB 与设备验证

## 先构建哪一份

先把接入落实到用户指定原工程，保留其已确认正式配置。默认测试产物通过已存在的专用测试 variant 或隔离副本生成；不要把测试包名临时写进原工程后忘记还原。按实际模块/variant 构建：Unity 示例是 `:launcher`，普通 App 常为 `:app`。

`prepare_test_project.py` 用途：复制当前源码与必需资源到新的工作目录；去掉构建缓存和正式签名私钥；保留内层 `IL2CPP/build/deploy`；创建独立 debug key、测试构建 JSON 和 Gradle init 脚本。它不改原工程、PA mode、Adjust 环境、namespace、ABI 或 minSdk，也不运行构建/安装。准备后核对 `omitted_paths`，确认仅省略缓存、历史产物与构建签名材料；若源码/资源内有疑似私钥资产，助手会提前报告相对路径，由执行者查明用途后适配，不能静默删除运行时资源。

```sh
python3 /path/to/05gp-sdk-integration/scripts/prepare_test_project.py \
  --config /private/work/params.json \
  --destination /private/work/gp-test-project
```

随后在生成目录运行输出的命令。测试覆盖依赖 `--init-script`，直接在 Android Studio 对该副本点构建不会激活此覆盖；需要 IDE 直接测试构建时改用项目专用的显式 test variant。常规示例：

```sh
./gradlew --init-script gp-test.init.gradle :launcher:assembleDebug --console=plain
```

目标为标准无 flavor 应用；复杂 flavors、特殊变体插件或多 App 模块由执行者读取实际 DSL 后适配。不要在错误提示后静默构建另一 module/variant。Groovy 与 Kotlin 主工程均可使用 init script，但仍须确认当前 AGP 支持相关 API。

初次准备不得覆盖已有目录；同一个测试项目继续构建时复用其独立 key，保证可覆盖安装。更新测试源码时先核对旧副本的归属与基线，保留已确认测试 key，不另生成 key。实际用户选了既有测试 key 时沿用它；不要拿正式 key 做默认测试签名。Debug 是否独立签名必须看 DSL 与最终 APK，实测原工程 debug 绑定过 release key。

工作副本可能保留源码中本来就有的签名配置文本或本机 Maven 配置以便解析；它们不是可直接分发的源码 ZIP。脚本不打印秘密，私有文件仅本机保存。APK 默认交付不附带整个工作副本。

## 工具与构建

- 发现当前 wrapper/AGP、Android SDK、Build Tools、NDK/CMake、Gradle JDK。历史成功组合：Gradle 8.13 / AGP 8.10.0 / JDK21，源码兼容17，SDK/Build Tools36，NDK27.2.12479018、CMake3.22.1；只作为诊断参考，不强制覆盖新工程。
- 依赖齐全时可用 `--offline --no-daemon --no-watch-fs --console=plain`；缺包时正常拉取用户指定版本。不要在线初始化卡住后无限重跑，也不要在 offline 下把缺缓存当成不存在的制品。
- 工程设置了 `abortOnError=false` 时读本次 Lint XML/文本中的 Error/Fatal。只处理影响接入/本次构建的问题，不将现存警告全部扩大为整顿任务。
- 应用 versionName/code 同步真正生效的 launcher、unityLibrary 和 Unity Gradle 属性；minSdk 调整也核对 native target。不要对整个项目全文替换所有数字或包字符串。
- 构建日志和产物时间/散列属于本次运行；Gradle 失败后即使输出目录里有 APK 也不能交付旧文件冒充新结果。

## Unity 原生库与 deploy

保留游戏 assets、cpp、java、jniLibs、jniStaticLibs、resources/res、IL2CPP 输出、libs、symbols、必要 tools，以及 wrapper、shared/keepUnitySymbols.gradle、launcher/setupSymbols.gradle、模块 metadata 文件。

默认复用已验证的预编译 `libil2cpp.so`。更换 deploy、生成 C++ 或 baselib 后，先查现有任务跳过策略；本工程的 `-PrebuildIl2Cpp=true` 会失效任务、绕过复用并添加 `--forcerebuild`。这是本工程的定制开关，新工程没有就不要直接假定支持。

本轮新 deploy 曾默认目标 API22，而 baselib 需要 API23+ 的 `__gnu_strerror_r`，最终 compiler/linker 都设 `--target=aarch64-linux-android${minSdk}` 对齐 API24。不能只把 Manifest 改24而让自定义编译器继续用22。工具按当前主机架构处理；本工程的 x64 dotnet 分支针对 Intel Mac，不宣称 Windows/Linux/Apple Silicon 可原样强制重编译。

16KB 对齐需核验 ELF LOAD/包内布局；不要仅由 NDK 版本推断。使用 `llvm-readelf` 时不先解析其符号链接成 `llvm-readobj` 再沿用 readelf 文本解析，argv[0] 可能影响输出。

## 验 APK

```sh
python3 /path/to/05gp-sdk-integration/scripts/verify_apk.py /private/work/new-test.apk \
  --build-tools /actual/Android/sdk/build-tools/36.0.0 \
  --expected-package com.actual.game.sdktest \
  --expected-version 1.0.2 --expected-version-code 2 \
  --expected-min-sdk 24 \
  --expected-cert-sha256 ACTUAL_TEST_CERTIFICATE_SHA256 \
  --expected-abi arm64-v8a \
  --report /private/work/apk-validation.json
```

以上只是参数位置示例，不能照抄 package、版本、ABI 和证书。证书从本次独立测试 key 获取，另外确认不等于正式证书。`--expected-min-sdk` 是等值检查，按本次实际目标填写。

可选加 `--sdk-aar`、`--expected-domain`、`--no-toast-class`、`--lint-report`。当 AGP strip 改变 `.so` 字节时，指定本次 `--merged-native-root` 和 `--stripped-native-root`，走 AAR→merged、stripped→APK 的实际来源核验，不要求 AAR 与 stripped 成品强行逐字节相同。该比对需结合本次构建日志，不能从两个匹配端点自行推导任意 merged 与 stripped 的关系。

另跑当前 variant 的 `dependencyInsight --dependency ammo` / `adjust-android`，核对真实解析版本；核验实际 Manifest 的 Application/唯一 launcher/Provider authority，以及新宿主类和 Adjust 环境/Token映射。校验脚本不声称自己覆盖所有集成逻辑。

将 APK 复制到 `delivery.output_dir`，名称区分 App 版本、code、PA版本和测试包，例如 `05GP-App-1.0.2-code2-PA1.0.3-test.apk`，必要时增加时间/序号避免覆盖。源和交付文件 SHA-256 一致。默认报告可简短：链接、实际包名/版本、PA模式、Adjust环境、编译和验包结果、未执行的设备/后台阶段；详细证据留在工作目录。

## 正式 AAB / 源码 ZIP（仅明确要求时）

AAB 在正式配置工程使用原有 release/upload key 构建 `bundleRelease`；核验 package/version/minSdk/ABI 与证书。使用 bundletool `validate`、`dump manifest --module=base`，以及 jarsigner/keytool；不能把 AAB 交给 APK 验证器或 `adb install`。普通 Maven bundletool jar 可能不是独立 all-jar，可使用已解析 AGP 的完整运行 classpath，无需为验包升级插件。

工程 ZIP 去掉 `.gradle/.cxx/.idea`、模块生成 build、旧 APK/AAB、本机 SDK 路径、Maven凭据、正式私钥和签名密码，但保留内层 `IL2CPP/build/deploy` 和执行权限。若原 build.gradle 内嵌签名密码，导出副本改为从本机 properties 读取并给空值 `.example`；附恢复说明。原工程不因此被修改，不能宣称去掉凭据后无需配置即可在新机器签名。

## 真机（按明确请求）

只在本次明确要求或仍有效安装授权时用 `adb devices -l` 选择设备；多个设备指定 serial。核对 ABI/API 后 `install -r`，签名冲突、版本降级或需要清数据时不自动卸载，保留手机状态并给出原因。连接手机本身不授权业务注册、充值或生产归因测试。

分阶段取本次日志/画面：进程启动 → 请求/返回正文 → 解析/路由 → WebView → 页面/桥就绪 → PA事件 → Adjust提交 → SDK回执。HTTP200空正文和 status2是配置失败；解除IP限制后也需真实返回证据。相同外部失败没有新的配置/代码/网络证据时只作一次针对性重试，然后报告具体阶段并交付已验 APK，不能切 Mock 或伪造 package/标识绕过策略。
