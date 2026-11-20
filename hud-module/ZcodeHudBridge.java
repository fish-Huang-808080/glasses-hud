package com.rayneo.customai;

import android.app.Application;
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
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * ZCode HUD 常驻监视：轮询本机 bridge 的 /v1/hud（纯文本），
 * 内容变化时推送到眼镜提词器常驻页（LyricsTeleprompterBridge.pushCustomTextToGlasses）。
 * URL/Key 复用 ⚡LLM 面板里已配置的 baseUrl 与 apiKey，无需额外配置。
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

    private ZcodeHudBridge() {}

    public static synchronized void start(Application app) {
        if (running || app == null) return;
        appCtx = app.getApplicationContext();
        thread = new HandlerThread("zcode-hud");
        thread.start();
        handler = new Handler(thread.getLooper());
        running = true;
        handler.postDelayed(tick, 8000L); // 启动后等 App 稳定再开始
        Log.i(TAG, "HUD poller started");
    }

    public static synchronized void stop() {
        running = false;
        if (handler != null) handler.removeCallbacksAndMessages(null);
        if (thread != null) { thread.quitSafely(); thread = null; }
        handler = null;
    }

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
                        String offUrl = hudUrl.replace("/v1/hud", "/v1/hud/off");
                        httpPost(offUrl, key.trim(), 4000);
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
                            Log.i(TAG, "HUD pushed");
                        }
                    }
                }
            } catch (Throwable t) {
                Log.w(TAG, "tick error: " + t);
            }
            if (running && handler != null) handler.postDelayed(this, POLL_MS);
        }
    };

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
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(timeoutMs);
            c.setReadTimeout(timeoutMs);
            c.setRequestMethod("POST");
            c.setRequestProperty("Authorization", "Bearer " + bearer);
            c.setRequestProperty("Content-Type", "application/json");
            c.setDoOutput(true);
            c.getOutputStream().write("{}".getBytes(StandardCharsets.UTF_8));
            c.getResponseCode();
        } catch (Throwable ignored) {
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
