# 提词器桥改动清单

`ZcodeHudBridge` 依赖宿主 `LyricsTeleprompterBridge.java` 里的几处小改动。
下面是**逐处**的最小 diff，对照你本地 LovelyRayNeoio 工作副本改即可
（不要整文件覆盖：宿主版本不同，行号和周边代码会有差异）。

## 1. 会话状态查询

```java
/** 提词器显示会话是否仍活跃（用于检测用户是否已用镜腿退出）。 */
public static boolean isSessionActive() { return sessionState != SESSION_IDLE; }
```

## 2. 抽出公共推送方法

把原 `pushCustomTextToGlasses(Context, String, String)` 的方法体整体移入
`pushManuscript`，并让原方法委托：

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

## 3. 无标题文稿

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

## 4. 滚轮 → 切卡片（新增字段）

在类的静态字段区加三个：

```java
// HUD 滚轮：眼镜滑动会发 0x08，pageOffset 变化即一次手势
private static int lastHudPageOffset = -1;
private static long lastHudScrollAt = 0L;
private static long lastHudPushAt = 0L;
```

## 5. 滚轮 → 切卡片（推送时重置基线）

在 `pushManuscript` 的工作线程 runnable 里，`customOverrideManuscript = noteMs;`
之后加两行：

```java
customOverrideManuscript = noteMs;
lastHudPageOffset = -1;
lastHudPushAt = SystemClock.uptimeMillis();
```

## 6. 滚轮 → 切卡片（处理 0x08 帧）

在 `handleIncomingTeleprompterPayload` 的 `switch (msg.type)` 里，
把 `case MSG_PROGRESS_UPDATE` 改成：

```java
case MSG_PROGRESS_UPDATE: {
    if (action == 1 && isLyricsDid(did) && !deviceId.isEmpty()) {
        sendBleTeleprompter(
                encodeGlassesMsg(MSG_PROGRESS_UPDATE, buildSimpleAckJson(did), null, 0),
                deviceId, false);
    }
    // 滚轮：pageOffset 是绝对位置；位置不变时按边界判断方向
    if (action == 1 && isLyricsDid(did)
            && activeManuscript != null && activeManuscript.isCustomNote) {
        int off = JsonMini.getInt(jb, "pageOffset", -1);
        if (off >= 0) {
            long nowUp = SystemClock.uptimeMillis();
            int maxOff = 0;
            try { maxOff = activeManuscript.lineByteOffsets[activeManuscript.lineByteOffsets.length - 1]; } catch (Throwable ignored) {}
            if (nowUp - lastHudPushAt < 2500L) {
                lastHudPageOffset = off; // 推送后的同步帧，不算手势
            } else if (lastHudPageOffset < 0) {
                lastHudPageOffset = off;
            } else {
                int dir = 0;
                if (off != lastHudPageOffset) dir = off > lastHudPageOffset ? 1 : -1;
                else if (off <= 0) dir = -1;               // 顶部继续上滑
                else if (off >= maxOff) dir = 1;           // 底部继续下滑
                if (dir != 0 && nowUp - lastHudScrollAt > 500L) {
                    lastHudScrollAt = nowUp;
                    ZcodeHudBridge.onHudScroll(dir);
                }
                lastHudPageOffset = off;
            }
        }
    }
    break;
}
```

> 为什么这么绕：`pageOffset` 是**绝对位置**不是方向。看板只有 4 行时，
> 滚一下就从 0 跳到 36（一行）；到了顶部再上滑位置不变，只能靠"在边界上"来推断意图。

## 7. 通知栏按钮 → 视图（改 smali，构建脚本里做）

通知按钮用 `PendingIntent.getBroadcast` 指向宿主 App **已声明**的接收器
`dev.fluttercommunity.plus.share.SharePlusPendingIntent`，
这样不用改 `AndroidManifest.xml`。构建时在它的 `onReceive` 开头注入一行：

```smali
.method public final onReceive(Landroid/content/Context;Landroid/content/Intent;)V
    .registers 4

    invoke-static {p1, p2}, Lcom/rayneo/customai/CustomAiHooks;->onHudViewIntent(Landroid/content/Context;Landroid/content/Intent;)V
    ...
```

对应 `patch_apk.py` 里的片段：

```python
share_rel = "dev/fluttercommunity/plus/share/SharePlusPendingIntent.smali"
share_cand = smali_dir / share_rel
if share_cand.exists():
    st = share_cand.read_text(encoding="utf-8")
    if "onHudViewIntent" not in st:
        sig = ".method public final onReceive(Landroid/content/Context;Landroid/content/Intent;)V"
        sig_idx = st.find(sig)
        reg_idx = st.find(".registers", sig_idx) if sig_idx >= 0 else -1
        if reg_idx >= 0:
            line_end = st.find("\n", reg_idx)
            inject = ("\n\n    invoke-static {p1, p2}, Lcom/rayneo/customai/CustomAiHooks;->"
                      "onHudViewIntent(Landroid/content/Context;Landroid/content/Intent;)V")
            st = st[:line_end] + inject + st[line_end:]
            share_cand.write_text(st, encoding="utf-8")
```

注入点必须在 `.registers` 之后、第一条指令之前（先只注入在方法签名后面会落到
`.registers` 前面，smali 汇编会失败）。

## 8. 通知栏按钮 → 视图（CustomAiHooks 里加一个方法）

```java
/** 由 SharePlusPendingIntent.onReceive 注入调用：读取 zcode_view 并切换看板视图。 */
public static void onHudViewIntent(Context ctx, Intent intent) {
    try {
        if (intent == null) return;
        String v = intent.getStringExtra("zcode_view");
        if (v == null || v.isEmpty()) return;
        if ("__next__".equals(v)) ZcodeHudBridge.onHudScroll(1);
        else ZcodeHudBridge.switchView(v);
    } catch (Throwable ignored) {}
}
```

`CustomAiHooks` 需要 `import android.content.Intent;`。
