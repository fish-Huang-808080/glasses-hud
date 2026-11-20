# 设计笔记：把 HUD 塞进雷鸟 iO 的提词器通道

这些是实测踩出来的约束。改版式或换通道前请先读一遍。

## 通道选择

- 对话页（模型回复渲染的地方）由**官方宿主**控制生命期：流没有 `finish_reason`
  就结束会触发 `incomplete_stream`，页面回待机。**无法从 bridge 侧延寿**。
- 提词器是唯一可由插件驱动的**常驻页**：`LyricsTeleprompterBridge` 用 CoreConnect
  通道（`TELEPROMPTER = 0x14`）握手，支持 1 小时 lifetime 与逐行推进。
- 代价：**提词器与语音互斥**（推送前会等 `voiceAssistantBusy` 清零，且显示会话被
  提词器占用）。所以做成显式模式开关，而不是常驻后台。

## 文本排版（提词器页）

以 `MAX_LINE_HALF_WIDTH = 34` 为单行上限，按“汉字=2、ASCII=1”估宽：

| 规则 | 原因 |
|---|---|
| 右列与左列之间不要有多个连续空格以外的东西 | 空格是渲染层的换行点，长内容会在空格处断行 |
| 右列尽量用 ASCII（`>` `.` `!`） | `▶`、`·` 等符号宽度不确定；emoji（`☀🌙🌡`）无字形 |
| 时长压缩（秒/分/时+分） | `1分59秒` 变长会把整行撑爆；固定长度才能保持对齐 |
| 方块字符按 2.5~3 单位估 | `█/░` 比汉字更宽，6 格 + 百分比曾导致换行；最终用 10 格且不带百分比 |
| 右边界统一 33 | 34 是理论上限，实际渲染在 34 附近会换行；33 稳定 |
| 标题行要避免 | `buildCustomNoteManuscript` 会自动加 `[提词] 标题` 首行；HUD 需要无标题变体 |

## 对齐调试法

1. 先让 `.state/hud` 输出纯文本，本地 `curl` 数宽度；
2. 真机上每次只调 1~2 格，记录哪一行先断；
3. 三行用同一个右边界后，若仍有 1 格偏差，多半是 `°`/全角冒号等字符的度量差异，
   单独给该行补空格即可。

## 电量

- 标准 `BluetoothDevice.getBatteryLevel()` 是系统 API（公开 SDK 无此方法），
  反射调用在实机上返回 `0`，即设备没有可用的 Battery Service 数据。
- Turbo-IO 证明可以用 OTA 通道的只读 `type=2` 帧读 `BatteryLevel`，但需要移植
  `OtaFrame`/`NavReflect`/`HostAbi`/`NativeTransfer.otaConnection`（300+ 行），
  且与提词器共用蓝牙链路有冲突风险。**未采用**。

## 飞书

- 未读数：开放平台服务端**没有**未读接口（只有客户端小程序 `getChatInfo().badge`）。
- 可行替代：`lark-cli task +get-my-tasks --complete=false --page-all` 的未完成总数
  （含“来自会话”任务），与飞书“我负责的”数字一致。
- 若只想列手写待办，过滤 `summary` 含“来自会话”的条目（本项目“我的待办”语音指令如此）。

## 移植到其他眼镜（仅记录，未实现）

本项目只验证过雷鸟 iO。若要换设备，需要替换的是**眼镜侧通道**，数据侧可以保留：

| 层 | 是否可复用 | 说明 |
|---|---|---|
| `bridge`（状态模型、`/v1/hud` 文本、天气/余额/待办） | ✅ | 纯文本输出，任何能显示文本的设备都能接 |
| 版式经验（宽度、ASCII 符号、时长压缩） | ✅ | 与具体设备无关的排版原则 |
| 提词器推送（`hud-module` + LovelyRayNeoio） | ❌ | 依赖 iO 的 CoreConnect 0x14 通道与雷鸟 AI App |
| 设备配对 / 常驻显示 | ❌ | X3 系列跑独立系统（如 Everyday 这类原生 App），Air 系列没有屏显能力，其他品牌各有 SDK |

换句话说：**HUD 的数据和排版可以搬，眼镜端的接入要按目标设备重写**。

- bridge 对 SQLite 只读；ZCode 升级改表结构时先跑 `/health` 与 `/v1/state` 自检。
- `session_input` 里 `sendText` / `backgroundNotification` 是消息流，不是“等你确认”，
  需要过滤 + 15 秒停留门槛，否则会误报。
