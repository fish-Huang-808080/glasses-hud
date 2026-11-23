package com.rayneo.customai;

import android.app.Application;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.SystemClock;
import android.util.Log;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ConcurrentLinkedQueue;

/**
 * ZCode HUD 常驻监视：轮询 bridge 的 /v1/hud（纯文本），
 * 内容变化时推送到眼镜提词器常驻页（LyricsTeleprompterBridge.pushHudTextToGlasses）。
 * URL/Key 复用 ⚡LLM 面板里已配置的 baseUrl 与 apiKey，无需额外配置。
 *
 * 切换视图（不依赖语音）：
 *  - 镜腿滚轮：onHudScroll(dir) 由提词器桥在 0x08 帧的 pageOffset 变化时调用
 *  - 通知栏：点通知本体 = 下一张；展开后的按钮直达某个视图
 */
public final class ZcodeHudBridge {
    private static final String TAG = "ZcodeHud";
    private static final long POLL_MS = 15000L;
    private static final long MIN_PUSH_GAP_MS = 45000L;

    private static volatile boolean running = false;
    private static HandlerThread thread;
    private static Handler handler;
    private static Context appCtx;
    private static String lastBody = "";
    private static long lastPushUptime = 0L;
    private static volatile boolean pushed = false;

    // 视图环：滚轮/通知本体点击按这个顺序循环
    private static final String[] VIEW_RING = { "home", "agents", "todos", "schedule" };
    private static volatile String currentView = "home";
    private static volatile long lastScrollSwitchAt = 0L;

    // 通知栏按钮
    private static final String VIEW_CH = "zcode_hud_view";
    private static final int VIEW_NID = 4102;
    private static volatile String viewLabel = "综合看板";

    // 诊断探针：把现场观测发到 bridge 的 /v1/probe（落盘 .state/probe.log），失败静默
    private static final ConcurrentLinkedQueue<String[]> probeQ = new ConcurrentLinkedQueue<>();
    private static final Runnable PROBE_FLUSH = new Runnable() {
        @Override public void run() { flushProbe(); }
    };

    private ZcodeHudBridge() {}

    public static synchronized void start(Application app) {
        if (running || app == null) return;
        appCtx = app.getApplicationContext();
        thread = new HandlerThread("zcode-hud");
        thread.start();
        handler = new Handler(thread.getLooper());
        running = true;
        handler.postDelayed(tick, 8000L); // 启动后等 App 稳定再开始
        postViewNotification();
        Log.i(TAG, "HUD poller started");
    }

    public static synchronized void stop() {
        running = false;
        if (handler != null) handler.removeCallbacksAndMessages(null);
        if (thread != null) { thread.quitSafely(); thread = null; }
        handler = null;
    }

    // ==================== 视图切换 ====================

    /** 滚轮滑一下 = 切到下一张/上一张卡片（dir: 1 下一张, -1 上一张）。 */
    public static void onHudScroll(int dir) {
        long now = SystemClock.elapsedRealtime();
        if (now - lastScrollSwitchAt < 400L) return;
        lastScrollSwitchAt = now;
        int idx = 0;
        for (int i = 0; i < VIEW_RING.length; i++) {
            if (VIEW_RING[i].equals(currentView)) { idx = i; break; }
        }
        int next = (idx + (dir > 0 ? 1 : -1) + VIEW_RING.length) % VIEW_RING.length;
        probe("scroll_view", VIEW_RING[next]);
        switchView(VIEW_RING[next]);
    }

    /** 切到指定视图；网络操作放到 HUD 线程，避免阻塞调用方（BLE 线程 / 广播）。 */
    public static void switchView(final String name) {
        currentView = name;
        Handler h = handler;
        if (h != null) {
            h.post(new Runnable() {
                @Override public void run() { doSwitchView(name); }
            });
        } else {
            doSwitchView(name);
        }
    }

    private static void doSwitchView(String name) {
        try {
            if (appCtx == null) return;
            CustomAiConfig cfg = CustomAiConfig.load(appCtx);
            String hudUrl = deriveHudUrl(cfg == null ? null : cfg.baseUrl);
            String key = cfg == null ? null : cfg.apiKey;
            if (hudUrl == null || key == null || key.trim().isEmpty()) { probe("view_skip", "no_config"); return; }
            // 按钮也能把看板叫出来（无需语音）：先开 HUD 模式，再切视图
            httpPost(hudUrl.replace("/v1/hud", "/v1/hud/on"), key.trim(), 4000);
            httpPostBody(hudUrl.replace("/v1/hud", "/v1/view"), key.trim(), "{\"name\":\"" + name + "\"}", 6000);
            probe("view_btn", name);
            viewLabel = labelFor(name);
            postViewNotification();
            pushNow(hudUrl, key);
        } catch (Throwable t) {
            probe("view_err", String.valueOf(t));
        }
    }

    private static String labelFor(String v) {
        if ("agents".equals(v)) return "AI进度";
        if ("todos".equals(v)) return "飞书待办";
        if ("schedule".equals(v)) return "日历日程";
        return "综合看板";
    }

    // ==================== 通知栏按钮 ====================

    /**
     * 常驻通知：点本体 = 下一张；展开后 4 个按钮直达视图。
     * PendingIntent 指向宿主 App 已声明的广播接收器
     * （dev.fluttercommunity.plus.share.SharePlusPendingIntent），
     * 由构建脚本在它的 onReceive 里注入 CustomAiHooks.onHudViewIntent —— 不需要改 AndroidManifest。
     * 注意：部分 ROM（如 MIUI）会把动作按钮折叠，所以“点本体 = 下一张”是必须保留的路径。
     */
    private static void postViewNotification() {
        try {
            if (appCtx == null) return;
            NotificationManager nm = (NotificationManager) appCtx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(VIEW_CH) == null) {
                NotificationChannel c = new NotificationChannel(VIEW_CH, "ZCode 看板切换", NotificationManager.IMPORTANCE_DEFAULT);
                c.setShowBadge(false);
                nm.createNotificationChannel(c);
            }
            if (Build.VERSION.SDK_INT >= 24 && !nm.areNotificationsEnabled()) {
                probe("notif_off", "notifications disabled");
                return;
            }
            Notification.Builder b = Build.VERSION.SDK_INT >= 26
                    ? new Notification.Builder(appCtx, VIEW_CH)
                    : new Notification.Builder(appCtx);
            b.setSmallIcon(android.R.drawable.ic_menu_view)
                    .setContentTitle("ZCode 看板：" + viewLabel)
                    .setContentText("点一下切下一张，展开可用按钮")
                    .setContentIntent(viewIntent("__next__"))
                    .setOngoing(true)
                    .setOnlyAlertOnce(true)
                    .addAction(0, "综合", viewIntent("home"))
                    .addAction(0, "AI", viewIntent("agents"))
                    .addAction(0, "待办", viewIntent("todos"))
                    .addAction(0, "日程", viewIntent("schedule"));
            nm.notify(VIEW_NID, b.build());
            probe("notif_post", viewLabel);
        } catch (Throwable t) {
            probe("notif_err", String.valueOf(t));
        }
    }

    private static PendingIntent viewIntent(String name) {
        Intent i = new Intent();
        i.setClassName(appCtx, "dev.fluttercommunity.plus.share.SharePlusPendingIntent");
        i.setAction("com.rayneo.customai.HUD_VIEW." + name);
        i.putExtra("zcode_view", name);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getBroadcast(appCtx, name.hashCode(), i, flags);
    }

    // ==================== 轮询与推送 ====================

    private static final Runnable tick = new Runnable() {
        @Override public void run() {
            if (!running) return;
            try {
                CustomAiConfig cfg = CustomAiConfig.load(appCtx);
                String hudUrl = deriveHudUrl(cfg == null ? null : cfg.baseUrl);
                String key = cfg == null ? null : cfg.apiKey;
                // 用户用镜腿退出提词器 → 通知 bridge 关闭 HUD 模式，恢复正常功能
                // （推送后 30 秒内不判定，避开握手期）
                if (pushed && SystemClock.elapsedRealtime() - lastPushUptime > 30000L
                        && !LyricsTeleprompterBridge.isSessionActive()) {
                    pushed = false;
                    lastBody = "";
                    if (hudUrl != null && key != null && !key.trim().isEmpty()) {
                        httpPost(hudUrl.replace("/v1/hud", "/v1/hud/off"), key.trim(), 4000);
                        Log.i(TAG, "glasses exited teleprompter -> HUD mode off");
                    }
                }
                if (hudUrl != null && key != null && !key.trim().isEmpty()) {
                    // 附带电量：gb=眼镜(标准BAS/GATT缓存) pb=手机；读不到传 -1
                    String withBat = hudUrl + "?gb=" + glassesBattery(appCtx) + "&pb=" + phoneBattery(appCtx);
                    String body = httpGet(withBat, key.trim(), 4500);
                    if (body != null) {
                        body = body.trim();
                        long now = SystemClock.elapsedRealtime();
                        if (!body.isEmpty()
                                && (!body.equals(lastBody))
                                && (lastPushUptime == 0L || now - lastPushUptime >= MIN_PUSH_GAP_MS)) {
                            lastBody = body;
                            lastPushUptime = now;
                            pushed = true;
                            LyricsTeleprompterBridge.pushHudTextToGlasses(appCtx, body);
                            probe("hud_push", "len=" + body.length());
                        }
                    }
                }
            } catch (Throwable t) {
                Log.w(TAG, "tick error: " + t);
            }
            if (running && handler != null) handler.postDelayed(this, POLL_MS);
        }
    };

    /** 立即拉取 /v1/hud 并推屏（绕过最小推送间隔，用于切视图后即时生效）。 */
    private static void pushNow(String hudUrl, String key) {
        try {
            String body = httpGet(hudUrl + "?gb=" + glassesBattery(appCtx) + "&pb=" + phoneBattery(appCtx), key.trim(), 6000);
            if (body == null) return;
            body = body.trim();
            if (body.isEmpty()) return;
            lastBody = body;
            lastPushUptime = SystemClock.elapsedRealtime();
            pushed = true;
            LyricsTeleprompterBridge.pushHudTextToGlasses(appCtx, body);
            Log.i(TAG, "HUD force-pushed");
        } catch (Throwable t) {
            probe("push_err", String.valueOf(t));
        }
    }

    // ==================== 探针 ====================

    /** 任意线程安全：入队后交给 HUD 线程发 HTTP，不阻塞调用方。 */
    public static void probe(String tag, String detail) {
        try {
            if (appCtx == null) return;
            if (probeQ.size() > 400) probeQ.poll();
            probeQ.add(new String[]{ String.valueOf(tag), String.valueOf(detail) });
            Handler h = handler;
            if (h != null) h.post(PROBE_FLUSH);
        } catch (Throwable ignored) {}
    }

    private static void flushProbe() {
        String[] e;
        while ((e = probeQ.poll()) != null) {
            try {
                CustomAiConfig cfg = CustomAiConfig.load(appCtx);
                String hudUrl = deriveHudUrl(cfg == null ? null : cfg.baseUrl);
                String key = cfg == null ? null : cfg.apiKey;
                if (hudUrl == null || key == null || key.trim().isEmpty()) continue;
                String json = "{\"tag\":\"" + esc(e[0]) + "\",\"detail\":\"" + esc(e[1]) + "\"}";
                httpPostBody(hudUrl.replace("/v1/hud", "/v1/probe"), key.trim(), json, 5000);
            } catch (Throwable ignored) {}
        }
    }

    private static String esc(String s) {
        if (s == null) return "";
        StringBuilder sb = new StringBuilder(Math.min(s.length(), 500));
        for (int i = 0; i < s.length() && sb.length() < 500; i++) {
            char c = s.charAt(i);
            if (c == '"' || c == '\\') sb.append('\\').append(c);
            else if (c < 0x20) sb.append(' ');
            else sb.append(c);
        }
        return sb.toString();
    }

    // ==================== 电量 ====================

    /** 眼镜电量：Android 13+ 的 BluetoothDevice.getBatteryLevel()（需设备暴露标准 Battery Service）。读不到返回 -1。 */
    private static int glassesBattery(Context ctx) {
        try {
            if (Build.VERSION.SDK_INT < 33) return -1;
            BluetoothManager bm = (BluetoothManager) ctx.getSystemService(Context.BLUETOOTH_SERVICE);
            BluetoothAdapter a = bm == null ? null : bm.getAdapter();
            if (a == null || !a.isEnabled()) return -1;
            for (BluetoothDevice d : a.getBondedDevices()) {
                String n = null;
                try { n = d.getName(); } catch (Throwable ignored) {}
                String alias = null;
                try { alias = d.getAlias(); } catch (Throwable ignored) {}
                String name = (n != null ? n : "") + " " + (alias != null ? alias : "");
                if (name.contains("RayNeo") || name.contains("iO") || name.contains("雷鸟") || name.contains("D099")) {
                    int lvl = batteryViaReflection(d);
                    if (lvl >= 0) return lvl;
                }
            }
        } catch (Throwable t) {
            Log.w(TAG, "glassesBattery: " + t);
        }
        return -1;
    }

    /** getBatteryLevel 是系统 API（公开 SDK 无），反射尝试；不可用返回 -1。 */
    private static int batteryViaReflection(BluetoothDevice d) {
        try {
            java.lang.reflect.Method m = BluetoothDevice.class.getMethod("getBatteryLevel");
            Object v = m.invoke(d);
            if (v instanceof Integer) return (Integer) v;
        } catch (Throwable ignored) {}
        return -1;
    }

    private static int phoneBattery(Context ctx) {
        try {
            Intent i = ctx.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            if (i == null) return -1;
            int lvl = i.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
            int scale = i.getIntExtra(BatteryManager.EXTRA_SCALE, 100);
            return lvl >= 0 && scale > 0 ? lvl * 100 / scale : -1;
        } catch (Throwable ignored) { return -1; }
    }

    // ==================== HTTP ====================

    /** baseUrl(如 https://x.ts.net/v1 或 .../v1/chat/completions) -> https://x.ts.net/v1/hud */
    private static String deriveHudUrl(String baseUrl) {
        if (baseUrl == null) return null;
        String b = baseUrl.trim();
        int idx = b.indexOf("/v1");
        if (idx >= 0) b = b.substring(0, idx);
        if (!b.startsWith("https://")) return null;
        return b + "/v1/hud";
    }

    private static void httpPost(String url, String bearer, int timeoutMs) {
        httpPostBody(url, bearer, "{}", timeoutMs);
    }

    private static String httpPostBody(String url, String bearer, String body, int timeoutMs) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(timeoutMs);
            c.setReadTimeout(timeoutMs);
            c.setRequestMethod("POST");
            c.setRequestProperty("Authorization", "Bearer " + bearer);
            c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            c.setDoOutput(true);
            byte[] b = (body == null ? "{}" : body).getBytes(StandardCharsets.UTF_8);
            c.setFixedLengthStreamingMode(b.length);
            OutputStream os = c.getOutputStream();
            os.write(b);
            os.close();
            InputStream in = c.getResponseCode() >= 400 ? c.getErrorStream() : c.getInputStream();
            if (in == null) return null;
            BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = r.readLine()) != null) {
                sb.append(line);
                if (sb.length() > 65536) break;
            }
            r.close();
            return sb.toString();
        } catch (Throwable t) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static String httpGet(String url, String bearer, int timeoutMs) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(timeoutMs);
            c.setReadTimeout(timeoutMs);
            c.setRequestMethod("GET");
            c.setRequestProperty("Authorization", "Bearer " + bearer);
            c.setInstanceFollowRedirects(false);
            int code = c.getResponseCode();
            if (code != 200) return null;
            InputStream in = c.getInputStream();
            BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = r.readLine()) != null) {
                sb.append(line).append('\n');
                if (sb.length() > 8192) break;
            }
            r.close();
            return sb.toString();
        } catch (Throwable t) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }
}
