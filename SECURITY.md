# Security notes

This project runs a small HTTP service on your computer. Read this before exposing it.

## Defaults

- The bridge binds `127.0.0.1` unless you pass `--host 0.0.0.0`.
- All `/v1/*` endpoints except `/health` require `Authorization: Bearer <token>`.
- The token is generated on first run at `.state/bridge.token` (mode 0600). It is
  git-ignored and never logged.
- The bridge opens ZCode's SQLite database **read-only**. It never writes to it.
- `/v1/hud/off` and `/v1/hook` are local-only entry points; `/v1/hook` additionally
  rejects non-loopback callers.

## Never commit

- `.state/` (token, cached weather/balance, logs)
- API keys (DeepSeek / TinyFish / Feishu)
- Tailnet hostnames or public URLs that identify your machines

## Exposure

If you need access away from home, use a private overlay network (e.g. Tailscale
`serve`) rather than port-forwarding. If you expose the bridge publicly you must
add TLS and rotate the token.

## Reporting

Open a private security advisory on GitHub, or email **fish.h@foxmail.com**.
Please do not include real tokens or personal data in reports.
