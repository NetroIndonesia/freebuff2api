# freebuff2api

A self-hosted gateway that exposes **Freebuff / Codebuff free coding models** as an **OpenAI- and Anthropic-compatible API**, with rotating proxy pools, multi-account session management, anti-ban heuristics, optional browser TLS fingerprinting, and a live dashboard — all in a single Node.js process.

> **⚠️ Terms-of-service risk.** This project talks to Freebuff/Codebuff upstream APIs using account tokens. Using it conflicts with their Terms of Service, and upstream abuse detection can rate-limit, demote, or permanently ban accounts. See [Account hygiene & ban avoidance](#account-hygiene--ban-avoidance) — nothing here can guarantee an account is never flagged.

---

## What is Freebuff / Codebuff?

[Freebuff](https://www.codebuff.com) (formerly Codebuff) is a free AI coding agent. Its client (a CLI/desktop/web app) gives free-tier accounts a set of coding models — DeepSeek V4 Flash/Pro, GPT-5.6 Luna, Minimax M3, MiMo 2.5, GLM 5.2, and others — served behind a **session-based protocol**, not a plain OpenAI REST API:

- A free account is admitted into a **session** (`/api/v1/freebuff/session`) bound to a model, then drives an **agent run** (`/api/v1/run`-style lifecycle) with a CLI-shaped request envelope, tool schemas, a canonical system prompt, and ad/usage/streak "normal client behavior" calls.
- Quota is counted in **sessions per day**, split into pools (premium, standard/limited, GLM referral), and reset on a Pacific-midnight cadence.
- Upstream enforces a **trust model**: egress IP class (VPN/proxy/Tor/hosting), foreign tool schemas, disposable-email domains, shared signup networks, and honeypot-model usage can cap or ban an account.

`freebuff2api` reimplements that client protocol server-side and re-exposes it as the standard HTTP APIs your tools already speak, while pooling many accounts and rotating proxies so quota and bans are absorbed behind one endpoint.

## Features

- **OpenAI-compatible** — `/v1/chat/completions` (streaming + non-streaming), `/v1/models`, `/v1/responses`
- **Anthropic-compatible** — `/v1/messages`, `/v1/messages/count_tokens`
- **Proxy rotation & pools** — HTTP / HTTPS (CONNECT) and SOCKS4a / SOCKS5 / SOCKS5h proxies, round-robin rotation, health tracking with exponential backoff (2s → 8s → 32s → 5m), direct-connection fallback, and optional per-account proxy pinning
- **Account pool** — multi-account rotation with per-account health, terminal-ban isolation, cooldown, circuit breaker, affinity decay, and quota-aware selection
- **Session & run lifecycle** — automatic session creation/reuse/caching, model-lock recovery (DELETE → re-POST), queued-waiting-room polling, and idle-run draining
- **Dynamic model registry** — pulls the official model catalog from the Freebuff client source (refreshes every 6h, falls back to a built-in list)
- **Anti-ban heuristics** — per-account & global RPM caps, stepped exponential backoff, terminal-account exclusion, and optional TLS fingerprinting
- **TLS stealth (optional)** — impersonate a real browser's TLS + HTTP/2 fingerprint (JA3/JA4) via libcurl-impersonate instead of Node's OpenSSL-shaped ClientHello
- **Streaming** — SSE passthrough with zero buffering; non-stream aggregation
- **Dashboard** — live overview, chat playground, models, sessions, proxies, accounts, and settings (all config editable without restart)

## How it works

```mermaid
graph TD
    Client[AI client / router<br/>OpenAI & Anthropic SDKs] -->|POST /v1/chat/completions| Proxy[freebuff2api<br/>localhost:8787]
    Proxy -->|1. pick account + proxy| Pool[Account pool + proxy pool]
    Pool -->|2. session & run lifecycle| Upstream[codebuff.com]
    Upstream -->|3. SSE stream| Proxy
    Proxy -->|4. OpenAI SSE chunks| Client
    Proxy -.->|GET /api/status, /api/quota| Dashboard[Web dashboard]
```

One chat request, end to end:

1. Your tool POSTs a standard OpenAI request.
2. The gateway picks a healthy account (skipping banned/rate-limited/cooled-down ones) and a proxy, then performs the upstream session handshake and agent-run lifecycle.
3. The upstream SSE stream is unwrapped and re-emitted as OpenAI `chat.completion.chunk` events in real time.
4. When a request finishes, the run is drained so the next request starts clean.

## Quick start

```bash
npm install
node server.js
```

On Windows, double-click `install.bat` instead — it checks Node 20+, runs `npm install`, creates `.env` from `.env.example`, loads it, and starts the server.

Open `http://localhost:8787` for the dashboard. Base URL for clients: `http://localhost:8787/v1`.

**Requirements:** Node.js ≥ 20.

## Configuration

Config is read from three file sources (merged, later wins): `config.json` → `credentials/` dir / `proxies.txt` → environment variables. After first run, runtime state (accounts, proxies, and every setting) lives in SQLite (`data.db`) and is edited from the dashboard **Settings** tab.

| Environment variable | Default | Purpose |
|---|---|---|
| `FREEBUFF_TOKEN` | — | Freebuff account token(s), comma/newline separated, `token` or `token:uid` |
| `FREEBUFF_API_KEY` / `API_KEY` | `freebuff-default-key` | API key protecting the OpenAI/Anthropic endpoints |
| `PROXIES` | — | Outbound proxies, comma/newline separated |
| `FREEBUFF_NO_DIRECT` | `false` | `true` = proxy-only; never fall back to a direct connection (keeps the VPS egress IP off upstream) |
| `ROTATION_MODE` | `pin` | `pin` (reuse a live session) or `roundrobin` (spread across accounts) |
| `SESSION_ROTATE_EVERY` | `0` | Rotate session every N requests (0 = off) |
| `TLS_STEALTH` | `false` | `true` = browser TLS/HTTP2 fingerprint impersonation (see below) |
| `TLS_PROFILE` | `chrome` | Browser profile: `chrome`, `chrome136`, `safari2601`, `firefox147`, `edge101`, … |
| `FREEBUFF_ACCT_RPM` | `60` | Per-account max chat requests/minute |
| `FREEBUFF_GLOBAL_RPM` | `300` | Global max chat requests/minute |
| `FREEBUFF_AFFINITY_MAX_USES` | `3` | Max consecutive reuse of one account+model session |
| `FREEBUFF_COOLDOWN_BASE_MS` | `30000` | Stepped backoff base |
| `FREEBUFF_COOLDOWN_CAP_MS` | `1800000` | Stepped backoff cap |
| `FREEBUFF_DEBUG` | `false` | Enable debug logs |
| `PORT` / `HOST` | `0.0.0.0:8787` | Listen address |
| `QUOTA_REFRESH_MS` | `300000` | Background quota-scan interval |
| `PROXY_REFRESH_MS` | `60000` | Background proxy health re-test interval |

### Tokens

Put one token per line in `credentials/` (any file) or `FREEBUFF_TOKEN`, or use the dashboard **Settings** tab:

```
token1
token2:optional-uid
```

### Proxies

Put one proxy URL per line in `proxies.txt`, `PROXIES`, or the dashboard **Proxies** tab:

```
http://host:port
https://user:pass@host:port
socks5://host:port
socks5h://user:pass@host:port
socks4a://host:port
```

Proxies rotate round-robin; a failing proxy is cooled off with exponential backoff and requests fall back to the next proxy or a direct connection. Individual accounts can be pinned to a specific proxy from the dashboard.

## TLS stealth

By default every outbound request uses Node/undici, whose TLS ClientHello has an unmistakable OpenSSL shape (48 cipher suites, extended-master-secret extension first) that JA3/JA4 fingerprinting instantly recognizes as "not a browser".

Set `TLS_STEALTH=true` to route all upstream traffic through **impers / libcurl-impersonate** with a real browser's TLS + HTTP/2 fingerprint. On Windows the libcurl-impersonate binary is auto-downloaded on first use; on other platforms set `LIBCURL_PATH` (or let impers download it). Fatal load failures fall back to the plain fetch path automatically.

This hides one detection signal. It does **not** change your egress IP.

## Account hygiene & ban avoidance

Stealth, jitter, and header sanitization only reduce risk — the two signals that matter most are **egress IP class** and **usage shape**:

- **Use a residential connection.** VPN / proxy / Tor / datacenter egress is a hard-block signal: it demotes accounts to the limited tier or a terminal `country_blocked`, and restricted cohorts get a steep daily spend ceiling.
- **Drain one account at a time.** Let the pool run an account until its daily quota is spent; aggressively round-robining many healthy accounts reads as account farming.
- **Don't hammer many tokens from one egress IP.** Upstream caps distinct active sessions per IP (`ip_capped`) and caps accounts that share a signup /24 or mailbox.
- **Register with real email addresses.** Disposable-mail registrations are a documented ban cohort.
- **Read `429` as quota, not ban.** `429` (resets at Pacific midnight) is normal end-of-day; the gateway locks the account locally and answers in `<1ms`. Only `403` `banned` / `country_blocked` is terminal.

## Management API

The dashboard uses these endpoints (most require the API key via `x-api-key` or `Authorization: Bearer`):

| Endpoint | Method | Description |
|---|---|---|
| `/healthz`, `/api/status` | GET | Service + account/proxy/session health (no auth) |
| `/metrics` | GET | Prometheus metrics — accounts, proxies, sessions, models, quota (no auth) |
| `/api/accounts` | GET | Account list with health state |
| `/api/models` | GET | Resolved model registry |
| `/api/sessions` | GET | Active cached sessions |
| `/api/session` | POST / DELETE | Force-create / delete a session `{ token, model }` |
| `/api/proxies` | GET | Proxy pool state |
| `/api/proxy` | POST / DELETE | Add / remove a proxy `{ url }` |
| `/api/proxy/test` | POST | Test one proxy `{ url }` → `{ ok, latencyMs }` |
| `/api/quota` | GET | Per-account/per-model quota snapshot |
| `/api/config` | GET / POST | Read / update tokens, proxies, debug, API key, rotation, stealth, and anti-ban tunables |

## Client integration

- **Base URL**: `http://host:8787/v1`
- **API Key**: `FREEBUFF_API_KEY` (default `freebuff-default-key`)

Works with any OpenAI SDK, Anthropic SDK, ChatGPT-Next-Web, LobeChat, one-api, and similar routers.

## Project layout

```
server.js        HTTP server, config, proxy rotation, management API, static serving
engine.js        gateway engine (OpenAI/Anthropic routes, session/model lifecycle, streaming)
stealth.js       optional TLS/HTTP2 fingerprint impersonation (impers/libcurl-impersonate)
proxy.js         proxy pool + CONNECT/SOCKS tunneling connectors
quota.js         per-account quota scanner
store.js         SQLite persistence (better-sqlite3)
public/          dashboard (index.html, style.css, app.js, icon.png)
install.bat      one-click Windows bootstrap
config.example.json / .env.example   example configuration
```

## Thanks to

Built on these excellent open-source dependencies:

| Project | Role |
|---|---|
| [lexiforest/curl-impersonate](https://github.com/lexiforest/curl-impersonate) | Browser TLS/HTTP2 fingerprint impersonation engine (a fork of [lwthiker/curl-impersonate](https://github.com/lwthiker/curl-impersonate)) |
| [lexiforest/impers](https://github.com/lexiforest/impers) | Node.js bindings to curl-impersonate via Koffi |
| [nodejs/undici](https://github.com/nodejs/undici) | HTTP client and the `buildConnector` primitives behind CONNECT/SOCKS proxy tunneling |
| [WiseLibs/better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | Fast synchronous SQLite persistence |

## Notes

- Freebuff enforces per-account daily session quotas (premium / standard / GLM pools); rotation is best-effort across accounts and never changes the model a caller requested.
- `engine.js` exposes an `internals` export that the management dashboard and management API consume.
- The reimplemented protocol can break when upstream changes; the dynamic registry and model catalog are refreshed periodically to track it.
