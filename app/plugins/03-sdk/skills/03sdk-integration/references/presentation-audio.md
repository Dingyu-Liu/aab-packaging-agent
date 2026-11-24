# Loading、方向和音视频交接

## 覆盖与方向

系统LaunchScreen与运行期黑底白字Loading一致，运行期加转圈。原生遮罩在窗口首次可见前安装，Unity showGameUI/根视图置顶后继续在最上层。检查真实窗口和多scene，别把遮罩只挂在会被替换的旧root。若使用独立UIWindow，保持non-key且不挡ATT/系统授权；无需为套模板改掉已经可靠的覆盖方式。

游戏在后台初始化、归因协程照常走；用户不能点到底层游戏。不要通过UnityPause暂停整个播放器去静音，否则归因/等待流程可能停住。

原游戏方向从覆盖前的源设置/打包配置保存。Loading竖屏；网页默认采用业务约定且保留已有显式方向协议。原生application mask、控制器supported/preferred orientation、Unity Screen/autorotate开关必须一致协作。回退解除临时锁，恢复原固定方向或AutoRotation及全部开关。iOS16+ scene geometry request是异步的，掩码允许某方向不代表尺寸已经恢复。

## 音源清单必须完整

| 来源 | Loading/B面期间 | 回退原生游戏 |
| --- | --- | --- |
| AudioListener / Unity mixer | 保存volume/pause，静音/暂停音频，主循环继续 | 保留原用户静音与音量状态 |
| BGM AudioSource（含playOnAwake） | 保存mute/autoplay/播放意图，stop+mute，阻止新的Play | 恢复配置，只恢复本应播放的BGM |
| SFX / PlayOneShot | 拦截播放入口、停止正在响的短音效 | 恢复mute，丢弃积压音效 |
| VideoPlayer direct音轨 | 延后整个开场面板激活/Prepare/Play，不只设listener音量 | 游戏真正可见后按原流程激活一次 |
| 原生AVPlayer/FMOD/Wwise等 | 查实际组件的独立音轨/总线；用其API阻止后台A面声音 | 恢复该组件原状态 |
| WKWebView音频 | 与A面保护独立，不全局关AVAudioSession/系统音量 | 网页卸载时自然结束 |

新工程源C#使用公开AudioListener/AudioSource/VideoPlayer API。只有导出工程时才核对当前引擎binding/ABI；Racing的UnityUpdateMuteState只发通知不直接静音。不能复制原生C++签名假设所有Unity版本一致。捕获对象需有可靠生命周期/GC根，不长期存未经保护的managed指针；本案例依赖单例保存音源，布局保持不变。

原音乐开关是关就保持关，用户原volume=0/pause=true不要强行恢复为1/false。晚到的音乐开关或前后台音频重建不能打开保护；游戏阶段结束后也不能继续每帧覆盖用户设置。不要调用永久CloseBGM去实现临时Loading静音。

## 回退的可见性条件

先保持音视频阻止，确认：应用active，真实根控制器可见，无尚在dismiss的网页/其他阻挡模态或transition，Unity未skipRendering，方向/实际drawable尺寸一致。不能把以下任一事件单独视为游戏已显示：配置失败、PA completion、恢复方向请求返回、removeFromSuperview、GPU commandBuffer completed。

当前Metal导出的可靠交接：

1. 在主屏drawable present前注册`addPresentedHandler`；只有恢复尺寸的游戏帧实际present后才进入撤遮罩。
2. `CATransaction`提交Loading移除，并清理Unity自带indicator；保持音频静音。
3. 提交后再等一个新提交的游戏drawable实际present；检查generation、无遮罩/模态/旋转，再恢复源和延后视频。

记录提交时间，丢弃撤遮罩前已排队的帧。不要在重试耗尽后放开声音；可终止等待并报告可见性故障，或沿明确的产品兜底恢复游戏画面，声音始终以可见为准。不同渲染后端应选择对应的真实present回调，不强行引入Metal专用逻辑。

## 验收真实体验

冷启动、网页成功、配置失败、网页403/超时、Unknown回退、网页关闭、前后台分别检查。对照同一轮截图/录像、视图层级、回调和听感；音量0日志只是控制状态，**不是扬声器没声音的证据**。用户说仍有声音，视为验收失败，查独立视频/原生播放器，直到真实确认。Racing最终靠延后VideoPlayer解决，前两次误判要保留为教训。
