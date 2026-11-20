# Relay design notes

## Why a cloud function and not something else

| Option | Works on device before filing? | Why / why not |
|---|---|---|
| `wx.request` to your IP | No | Allowlist requires a filed HTTPS domain; IPs are rejected outright |
| Unfiled domain | No | WeChat validates ICP status for mainland-facing traffic |
| Overseas domain + CDN | Sometimes | Still needs a domain in the allowlist; latency and stability vary |
| **`wx.cloud.callFunction`** | **Yes** | Private channel, not subject to the allowlist |
| WeChat CloudRun (`callContainer`) | Yes | Better long-term choice: keep your framework, no filing for the platform domain — but it means running inside their container platform |

The relay is the smallest change: one function, no migration, and it keeps working as a fallback
after filing. If you are starting from scratch and do not need your own host, CloudRun is cleaner.

## Request lifecycle

```
client                          function                        server
  │ request(path,method,data)      │                               │
  ├────── callFunction ───────────►│                               │
  │                               │ assert path starts /api/, no ..│
  │                               │ attach x-proxy-key             │
  │                               ├──────── HTTP(S) ──────────────►│
  │                               │                               │ gate: loopback? open? key?
  │                               │◄──────── status + body ────────┤
  │◄────── {ok,status,json} ──────┤                               │
```

Identity headers (`x-token`, `x-user-id`, `x-device-id`, `x-school-id`, …) pass through untouched:
the relay is a transport, not a trust boundary. Authorization stays in your backend.

## The gate, derived

The port must be public for the function to reach it. That has three consequences:

1. **Anything the browser needs must be reachable without a key** — pages, static assets, `<img>`
   URLs, and the admin login POST. Browsers cannot attach custom headers to those requests.
2. **The app API must be reachable without a key** — the phone has no key to give. Its authorization
   is per-user (`x-token`), which is stronger than a shared secret for this purpose.
3. **Everything else must require the key** — i.e. the admin API surface, which a browser reaches
   *with* `x-admin-key`/`x-admin-token` and can therefore satisfy.

That yields exactly the allowlist in `SKILL.md`. Two corollaries people get wrong:

- Adding a new open path to the app API is free; adding one to the admin API is not.
- `/api/health` is open, so it is useless as a probe (see below).

### Probe correctness

A probe must exercise a path that **requires** the key. If you probe an open path, the device
concludes "direct works", locks that base in, and every subsequent real call fails with 403 —
manifesting as "sometimes works, sometimes doesn't" and "login fine, phone verification dead".

Pick a cheap authenticated endpoint, e.g. `GET /api/schools` with a token, or any app endpoint that
403s without one.

## Client state machine

```
        ┌──────────────┐  network-level failure   ┌──────────────┐
        │ direct(base) │ ───────────────────────► │  re-probe    │
        └──────┬───────┘                          └──────┬───────┘
               │ all candidates fail                     │
               ▼                                         │
        ┌──────────────┐   ok                            │
        │ cloud relay  │ ────────────────────────────────┘
        └──────────────┘
```

Rules:

- Persist the resolved base so the first screen does not pay the probe cost on every launch.
- Clear it on network-level failure only — never on a business error (401/403 means the transport
  worked; clearing would silently downgrade to the relay for an auth problem).
- The relay's error branches must mirror direct's, code for code.
- Surface the active channel in the UI. Every debugging session starts with "which path is this build on?"

## Cost and limits

- Every relayed call counts as one `callFunction` invocation and adds a hop (~50–200 ms).
- ~1 MB per call over the JSON channel. Photos must use cloud storage, not base64.
- Function timeout defaults to 3 s for devtool-created functions; raise it to 20 s.
- No WebSocket. Poll instead, and poll slower than you would with a direct connection.

## Rollback

Set `CLOUD_ENV_ID` to empty in the client config. The relay is never probed; behaviour is identical
to a build that never had the feature. The server gate stays as is — it only affects non-loopback
traffic and is safe to keep permanently.
