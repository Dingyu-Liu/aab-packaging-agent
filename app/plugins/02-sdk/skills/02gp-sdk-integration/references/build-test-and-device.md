# 测试 APK、AAB 与真机验证

以下命令用变量占位，实际路径从参数文件读取。

```bash
UNITY_PROJECT=/path/to/UnityProject
UNITY=/path/to/Unity.app/Contents/MacOS/Unity
SDK=$HOME/Library/Android/sdk
JDK=/path/to/jdk-17
NDK=$SDK/ndk/27.2.12479018
OUTPUTS=/path/to/outputs
SERIAL=你的设备序列号
```

## 构建测试 APK

```bash
export ANDROID_HOME="$SDK"
export ANDROID_SDK_ROOT="$SDK"
export ANDROID_NDK_ROOT="$NDK"
export JAVA_HOME="$JDK"
export DOTNET_USE_POLLING_FILE_WATCHER=1

"$UNITY" -batchmode -nographics -quit \
  -projectPath "$UNITY_PROJECT" \
  -executeMethod Partner02Build.BuildAndroidTestApk \
  -logFile "$OUTPUTS/test-apk-build.log"
```

构建脚本应自动设置：

- applicationId：`{formal_application_id}.test`
- versionName/versionCode：来自参数；
- 测试签名；
- ARM64；
- portrait 和 Activity 硬件加速。

构建后复制 APK 到输出目录，并重新用实际包名/版本命名。

## APK 静态校验

```bash
BT=$(ls -d "$SDK"/build-tools/* | sort -V | tail -1)
"$BT/aapt" dump badging "$APK" | head -8
"$BT/aapt" dump xmltree "$APK" AndroidManifest.xml | grep -A8 'UnityPlayerGameActivity'
"$BT/apksigner" verify --print-certs "$APK"
unzip -l "$APK" | grep -E 'lib/arm64-v8a/(libpakit|libil2cpp|libunity|libmain)\.so'
```

必须确认：

- package 是测试包；
- versionName/versionCode 正确；
- Activity `hardwareAccelerated` 为 true；
- Activity 方向为 portrait；
- `libpakit.so` 存在；
- 签名是测试签名，不是正式证书。

## 真机安装与日志

只安装测试包。若用户明确禁止正式包，先确认设备上没有正式 applicationId；不要用正式包做对照测试。

```bash
adb devices -l
adb -s "$SERIAL" uninstall com.example.game.test 2>/dev/null || true
adb -s "$SERIAL" install "$APK"
adb -s "$SERIAL" logcat -c
```

某些设备默认不输出 Unity/AF INFO 日志，需要临时设置 tag：

```bash
for tag in Unity AppsFlyer_6.18.1 AFLogger; do
  adb -s "$SERIAL" shell setprop "log.tag.$tag" V
done
```

冷启动并抓本轮日志：

```bash
adb -s "$SERIAL" shell am force-stop com.example.game.test
adb -s "$SERIAL" shell am start -W -n com.example.game.test/com.unity3d.player.UnityPlayerGameActivity
sleep 20
PID=$(adb -s "$SERIAL" shell pidof com.example.game.test | tr -d '\r')
adb -s "$SERIAL" logcat -d --pid="$PID" > "$OUTPUTS/device-$PID.log"
```

AF 关键日志：

```text
[CFG] Cold start - fetching config
[General] Initializing AppsFlyer SDK
[General] Starting AppsFlyer
AppsFlyer ID 已获取并保存
POST .../androidevent?app_id=...
response code:200 / 404
onConversionDataSuccess / onConversionDataFail
```

PA 关键日志：

```text
[PA] Config request params: ... "version":"..."
[PA] Config HTTP status=200 ok=1
[PA] Config response ...
[PA] Opening WebView with URL: ...
```

## 真机方向验证

冷启动连续采样，不要只看最终画面：

```bash
for i in $(seq 1 80); do
  adb -s "$SERIAL" shell dumpsys window displays 2>/dev/null \
    | grep -m1 -oE 'mCurrentRotation=ROTATION_[0-9]+'
  sleep 0.06
done | sort | uniq -c
```

启动、Loading、PA WebView 阶段应始终为 `ROTATION_0`。切 HOME 再返回，不能误触发 `OnPAWebViewClosed` 或恢复横屏。

## AAB

```bash
"$UNITY" -batchmode -nographics -quit \
  -projectPath "$UNITY_PROJECT" \
  -executeMethod Partner02Build.BuildAndroidAab \
  -logFile "$OUTPUTS/aab-build.log"
```

用 bundletool 核对：

```bash
java -jar bundletool-all.jar dump manifest --bundle=app.aab --module=base
```

并核对包名、versionCode、versionName、`hardwareAccelerated="true"`、`screenOrientation="1"`、`libpakit.so` 和签名。AAB 不能 `adb install`。

## 交付

输出目录至少保留：

- `.test` APK；
- 构建日志；
- 包名/版本/签名校验记录；
- 真机日志（如果用户要求安装验证）。

不要交付构建缓存、`local.properties`、私钥或 Maven 明文密码。
