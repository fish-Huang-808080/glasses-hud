# hud-module

把 `/v1/hud` 的文本推送到雷鸟 iO 提词器常驻页的 App 侧模块。
目标宿主：[LovelyRayNeoio](https://github.com/Tokeii0/LovelyRayNeoio) 补丁版雷鸟 AI。

> 本文件只说明集成点。请自行从官方渠道获取雷鸟 AI APK，并按 LovelyRayNeoio
> 的许可与步骤构建补丁版；本仓库不提供 APK、签名或固件。

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

## 3. 提词器桥的三处小改动

`ZcodeHudBridge` 依赖提词器桥的 3 个入口，请在
`LyricsTeleprompterBridge.java` 中补上。

### 3.1 会话状态查询

```java
/** 提词器显示会话是否仍活跃（用于检测用户是否已用镜腿退出）。 */
public static boolean isSessionActive() { return sessionState != SESSION_IDLE; }
```

### 3.2 抽出公共推送方法

把原 `pushCustomTextToGlasses(Context, String, String)` 的方法体整体移入一个新的
私有方法，并让原方法委托：

```java
public static String pushCustomTextToGlasses(Context ctx, String title, String content) {
    return pushManuscript(ctx, buildCustomNoteManuscript(title, content));
}

/** HUD 专用：无首行标题，正文即全部内容。 */
public static String pushHudTextToGlasses(Context ctx, String content) {
    return pushManuscript(ctx, buildHudManuscript(content));
}

private static String pushManuscript(Context ctx, final LyricsManuscript noteMs) {
    // 原 pushCustomTextToGlasses 的方法体原样放在这里
}
```

### 3.3 无标题文稿

```java
/** HUD 文稿：不加 [提词] 标题行，正文逐行原样。 */
public static LyricsManuscript buildHudManuscript(String rawContent) {
    String body = sanitizeBmpText(rawContent == null ? "" : rawContent)
            .replace("\r\n", "\n").replace('\r', '\n').trim();
    if (body.isEmpty()) body = "ZCode 空闲";
    List<String> finalLines = new ArrayList<>();
    List<Long> finalTimes = new ArrayList<>();
    List<Boolean> finalCompanions = new ArrayList<>();
    for (String para : body.split("\n")) {
        String trimmed = para.trim();
        if (trimmed.isEmpty()) continue;
        for (String wl : wrapLineToHudWidth(trimmed, MAX_LINE_HALF_WIDTH)) {
            finalLines.add(wl);
            finalTimes.add(0L);
            finalCompanions.add(Boolean.FALSE);
        }
    }
    return packManuscript(
            "zcode_hud|" + System.currentTimeMillis(), LYRICS_SLOT_DID, "ZCode HUD", "",
            finalLines, finalTimes, finalCompanions,
            true, "ZcodeHud", MODE_ORIGINAL, true);
}
```

## 4. 行为

- 每 15 秒 `GET {baseUrl}/v1/hud`（`baseUrl` 复用 ⚡LLM 面板配置，自动截到 `/v1`）。
- 内容变化且距上次推送 ≥45 秒时，调用 `pushHudTextToGlasses` 重绘看板。
- 推送后 30 秒起检测 `isSessionActive()`；若会话已被用户用镜腿退出，则
  `POST /v1/hud/off` 把 bridge 的 HUD 模式关掉，眼镜回到原生功能。
- `GET /v1/hud` 返回 503 时（模式关闭）不推送，因此说“提词器”才会启动。

## 5. 构建

```bash
python custom_ai_mod/patch_apk.py /path/to/RayNeo_AI_<version>.apk
```

LovelyRayNeoio 的脚本会在本地生成签名密钥并输出可安装 APK。**首次安装需要卸载
官方 App**（签名不同）；之后用同一把密钥覆盖安装即可。
