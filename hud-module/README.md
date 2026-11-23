# hud-module

把 `/v1/hud` 的文本推送到雷鸟 iO 提词器常驻页的 App 侧模块。
目标宿主：[LovelyRayNeoio](https://github.com/Tokeii0/LovelyRayNeoio) 补丁版雷鸟 AI。

> 本文件只说明集成点。请自行从官方渠道获取雷鸟 AI APK，并按 LovelyRayNeoio
> 的许可与步骤构建补丁版；本仓库不提供 APK、签名或固件。

## 0. 它做什么

- 每 15 秒轮询 `GET {baseUrl}/v1/hud`，内容变化时推到眼镜提词器常驻页
- **镜腿滚轮**：滑一下切到下一张/上一张卡片
- **通知栏**：点通知本体 = 下一张；展开后 4 个按钮直达某个视图
- 用户用镜腿退出提词器后，自动通知 bridge 关闭 HUD 模式

眼镜上**不接收语音指令**：提词器在屏时，眼镜固件不会打开语音通道
（实测：看板显示期间 `VOICE_ASSISTANT` 业务帧为 0），所以切视图全部走
滚轮和手机，不依赖语音。

## 1. 放入源码

把 `ZcodeHudBridge.java` 复制到：

```
LovelyRayNeoio/custom_ai_mod/src/com/rayneo/customai/ZcodeHudBridge.java
```

构建脚本会自动把它编进追加 DEX（`SRC_DIR.rglob("*.java")`）。

## 2. 启动钩子

在 `CustomAiHooks.onAppCreate(Application app)` 里，紧跟
`LyricsTeleprompterBridge.init(app);` 之后加一行：

```java
ZcodeHudBridge.start(app);
```

## 3. 提词器桥与构建脚本的改动

`ZcodeHudBridge` 依赖宿主里的几处小改动，全部列在
[`PATCHES.md`](PATCHES.md)：提词器桥的 3 处基础改动、滚轮处理的 3 处改动、
以及通知按钮需要的 1 处 smali 注入 + 1 个 Java 方法。
按里面的**最小 diff** 逐处改，不要整文件覆盖宿主文件。

## 4. 行为细节

- 内容变化且距上次推送 ≥45 秒时，调用 `pushHudTextToGlasses` 重绘看板；
  **切视图会绕过这个间隔**，立即生效。
- 推送后 30 秒起检测 `isSessionActive()`；若会话已被用户用镜腿退出，则
  `POST /v1/hud/off` 把 bridge 的 HUD 模式关掉，眼镜回到原生功能。
- `GET /v1/hud` 返回 503 时（模式关闭）不推送。点通知按钮会顺带
  `POST /v1/hud/on`，所以不说话也能把看板叫出来。
- 滚轮方向是推断出来的，不是协议给的（见 `PATCHES.md` 第 6 节）。
  已知边界：若一张卡片超过一屏，`pageOffset` 会落在中间，此时滑动方向按
  位置变化判断是准的；只有卡片不超过一屏时才依赖"在边界上"的推断。
- 诊断：所有关键动作会 `POST {baseUrl}/v1/probe`，bridge 把它写到
  `.state/probe.log`。排查时先看这个文件。

## 5. 构建

```bash
python custom_ai_mod/patch_apk.py /path/to/RayNeo_AI_<version>.apk
```

LovelyRayNeoio 的脚本会在本地生成签名密钥并输出可安装 APK。**首次安装需要卸载
官方 App**（签名不同）；之后用同一把密钥覆盖安装即可。

改自己的代码时不必每次都跑完整流程：我们自己的 Java 全部编进追加的那一个
DEX（`classes8.dex`，约 350KB），官方的几个 DEX 只在换官方版本时才需要重新
反汇编/注入。把已打补丁的 DEX 缓存下来、只重编追加 DEX 再替换进 APK，
一轮构建可以从十几分钟降到 1~2 分钟。
