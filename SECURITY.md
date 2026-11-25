# Security notes

This project runs a small HTTP service on your computer. Read this before exposing it.

## Defaults

- The bridge binds `127.0.0.1` unless you pass `--host 0.0.0.0`.
- All `/v1/*` endpoints except `/health` require `Authorization: Bearer <token>`.
- The bridge opens ZCode's SQLite database **read-only**. It never writes to it.
- `/v1/hook` is a local-only entry point and rejects non-loopback callers.

## Two tokens

There are two tokens, generated on first run (mode 0600, git-ignored, never logged):

| Token | File | Scope |
|---|---|---|
| **display** | `.state/display.token` | Glasses / phone only: read the HUD, switch views, turn the HUD on/off, send diagnostics |
| **full** | `.state/bridge.token` | Everything, including the chat endpoint (which can create and complete Feishu to-dos) and the full session snapshot |

Put the **display** token into the phone app. If the phone is lost or its token leaks,
the holder can see what is on your HUD (task titles, to-do summaries, balance) and
flip views, but cannot read transcripts, create to-dos or query session details.
Anything outside the display allow-list returns `403 display_token_readonly`.

To revoke a token, delete its file and restart the bridge; a new one is generated.

## Personal data stays out of git

`lark-cli minutes +detail` writes meeting transcripts into `./minutes/` in the
current directory. `.gitignore` also excludes `knowledge/`, `raw/`, `notes/`,
`index/` and `*.har` for the same reason. These contain real conversations with
colleagues and family. Check `git status` before committing after running any
lark-cli command inside the repository.

## Never commit

- `.state/` (tokens, cached weather/balance, logs)
- API keys (DeepSeek / TinyFish / Feishu)
- Tailnet hostnames or public URLs that identify your machines
- Transcripts, capture files, or any exported personal data

## Exposure

If you need access away from home, use a private overlay network (e.g. Tailscale
`serve`) rather than port-forwarding. If you expose the bridge publicly you must
add TLS and rotate both tokens.

## Reporting

Open a private security advisory on GitHub, or email **fish.h@foxmail.com**.
Please do not include real tokens or personal data in reports.
