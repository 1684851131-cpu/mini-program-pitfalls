---
name: wechat-miniprogram-unfiled-backend
description: Use when a mini program cannot reach an unfiled backend.
version: 1.0.0
author: open-source
license: MIT
metadata:
  hermes:
    tags: [wechat, miniprogram, cloudbase, cloud-function, proxy, icp, networking]
---

# Reaching a Self-Hosted Backend Before ICP Filing

A WeChat Mini Program can only call `wx.request` against a **filed (ICP) HTTPS domain** listed in
the console's *request 合法域名*. Until that filing lands, a real phone cannot reach your own server
at all — the developer tool works (it ignores the allowlist), every real device shows "offline".

This skill routes traffic through a cloud function instead: `wx.cloud.callFunction` rides WeChat's
private channel and is **not** subject to the domain allowlist, so the function can reach your server
by plain IP on your behalf.

> This is a **bridge, not a replacement**. File the domain anyway. Keep the bridge afterwards as a
> fallback channel — it also survives DNS, SNI and CDN problems that a filed domain still has.

## When to use

- Mini program + your own backend (Node/Java/Python behind nginx or a bare port) + no filed domain yet.
- Real device always shows offline / `ERR_CONNECTION_REFUSED` / "server not started", devtool is fine.
- You need image upload and display to work on a real device before filing completes.
- You want a fallback path for when the filed domain is blocked, rate-limited or misconfigured.

Do **not** use it as: a way to skip filing, a general API gateway for high-QPS traffic, or a
replacement for WebSocket (cloud functions cannot hold connections).

## Architecture

```
Mini program ──(wx.cloud.callFunction, WeChat private channel)──► cloud function
                                                                      │ HTTP
                                                                      ▼
                                                          your server  IP:port
```

Three transport modes exist, pick by payload size:

| Mode | Client sends | Ceiling | Use for |
|---|---|---|---|
| JSON proxy | `{path, method, data, headers}` | ~1 MB per call (callFunction limit) | normal API calls |
| Cloud storage (`fileID`) | `wx.cloud.uploadFile` → `cloud://…` | no callFunction limit | photos, ID documents |
| CDN marker (`fileCdn`) | `wx.cloud.CDN({type:'filePath'})` | large | bulk images |

See `references/large-file-channels.md` for the size/`compressImage` decision table.

## Build it

### 1. Cloud function (zero dependencies)

Copy `assets/apiProxy.js` (≈110 lines, Node built-ins only — no `npm install`, no bundling):

- accepts `{path, method, data, headers}`, rejects anything not `startsWith('/api/')` or containing `..`
- injects `x-proxy-key` (shared secret with your server) and forwards the caller's identity headers
- returns `{ok, status, ct, json, size}`; 20 s upstream timeout
- env vars: `BACKEND_BASE` (`http://<SERVER_IP>:<PORT>`, deliberately **not** a domain), `PROXY_KEY`

Deploy:

```bash
tcb fn deploy apiProxy --force --dir cloudfunctions/apiProxy   # cloudbaserc.json needs envId
```

First deploy right after creation may return `Creating` — wait ~25 s and retry.

### 2. Server-side gate (do not skip)

Exposing the port so the function can reach it also exposes it to the internet. Gate every request
that is not from loopback:

```js
const remote = String((req.socket && req.socket.remoteAddress) || '');
const isLocal = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';

// Paths that legitimately carry no credentials (browsers, <img>, login before any token exists)
const openPath =
     pathname === '/api/health' || pathname === '/' || pathname === '/index.html'
  || pathname === '/admin' || pathname === '/admin.html'
  || pathname === '/api/admin/login'        // ← login has no credential yet; blocking it breaks the admin UI
  || pathname.startsWith('/uploads/')
  || (pathname.startsWith('/api/') && !pathname.startsWith('/api/admin/'))  // app API: own uid/token auth
  || pathname.startsWith('/api/admin/mobile/');                             // mobile admin: own allowlist

const proxyOk = req.headers['x-proxy-key'] === PROXY_KEY;
if (!isLocal && !openPath && !proxyOk && !adminKeyOk(req)) {
  return fail(res, 403, 'PROXY_KEY_REQUIRED');
}
```

Two rules that cost real outages:

- **The allowlist must cover the whole app-API surface**, not just the admin surface. Listing only
  "management channels" makes phone-number verification, uploads and audit silently 403 on device
  while everything looks fine in the devtool.
- **`/api/admin/login` must be open.** The browser has no credential at that moment; behind the gate
  the UI reports it as "wrong admin key", so the user can never log in even with the right key.

### 3. Client: probe order differs per platform

```ts
const candidates = isDevTool
  ? [LAN_OR_LOCALHOST, PROD_DOMAIN, 'cloud://proxy']   // dev: local first
  : ['cloud://proxy', PROD_DOMAIN, LAN_OR_LOCALHOST];  // real device: cloud first
```

- Persist the resolved base; re-probe on network-level failure (`clearResolvedBase()`).
- **Lazy `cloud.init`**: on a real device WeChat does *not* inject a default cloud environment.
  Calling `callFunction` without an explicit `init({env})` fails the whole channel — and the devtool
  hides this because it auto-injects one. Init on first use, inside `try/catch`, not at app launch
  (launch-time init has its own `-80001` failure mode).
- `cloud.init` must exist as a real call. A boolean flag (`cloudInited = true`) without the call is a
  silent no-op — grep for the call itself.
- Mirror every status/error branch of the direct branch (`401/403/business codes`). A proxy path that
  only handles `200` turns auth failures into "no data".
- Use a probe endpoint **outside the open list** (e.g. `GET /api/schools`). Probing `/api/health`
  (which is open) proves nothing: the device then believes direct access works and all real calls 403.
- Show the active base in the UI ("cloud relay") so testers can tell which path a build used.

### 4. Kill switch

Leave `CLOUD_ENV_ID` empty → the relay is not even probed, client behaves as if it did not exist.
Keep the server gate unconditional: it only affects non-loopback traffic, so nginx, the browser admin
and the devtool keep working unchanged.

## Verify before shipping

```bash
# function alone, against a local server
BACKEND_BASE=http://127.0.0.1:3000 node -e "
const fn=require('./apiProxy.js');
(async()=>{ console.log(await fn.main({path:'/api/health',method:'GET'}));
           console.log(await fn.main({path:'/api/../etc',method:'GET'})); })();"
# expect a healthy JSON body, then BAD_PATH
```

Gate matrix — run each once against a **non-loopback** address (LAN IP impersonates "external"):

| Request | Expect |
|---|---|
| `GET /` | 200 (static page) |
| `GET /api/admin/config` no creds | 403 |
| `POST /api/admin/login` correct key | 200 + token (**not** 403) |
| `GET /api/schools` no creds | 200 (app API open, own auth) |
| `GET /api/admin/users` no creds | 403 |
| same with `x-proxy-key` | 200 |

Then on a **real device** (simulator cannot prove any of this): first screen loads, upload a photo,
open the admin page from the phone.

## Pitfalls

- **`cloud.init` never called** → the #1 cause of "cannot reach server" on device. Devtool masks it.
- **Probing an open endpoint** → device thinks direct works, every real call 403s.
- **`/api/admin/login` behind the gate** → login page reports "wrong key" forever.
- **Function timeout left at 3 s** (devtool default) → uploads time out. Raise to 20 s in the console.
- **HTTP images are rejected on device** (`<wx-image>: http not supported`). User photos must go to
  cloud storage (`cloud://`), not to your http IP. Devtool does not enforce this.
- **Each call is billed and counted**; do not poll faster than the business needs.
- **Cloud environments are per appid**; you cannot borrow another mini program's environment.
- **`tcb` behind a local proxy** → `ECONNREFUSED 127.0.0.1:7897`; `unset HTTP_PROXY HTTPS_PROXY ALL_PROXY` first.
- **Filing is still mandatory** for the domain you eventually list in the console.

## Files

- `assets/apiProxy.js` — copy-paste cloud function (no secrets, env-driven)
- `references/relay-design.md` — full design + server gate walkthrough
- `references/large-file-channels.md` — JSON vs fileID vs CDN, compression thresholds
- `references/pitfalls.md` — incident-shaped notes (symptom → root cause → fix)
