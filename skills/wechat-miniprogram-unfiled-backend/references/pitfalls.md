# Symptom → cause → fix

Every entry below is shaped like a real incident: what you see, what it actually is, what to change.
Read the *symptom* column first — that is all you have when it breaks.

## Device cannot reach the backend at all

| Symptom | Cause | Fix |
|---|---|---|
| Device shows offline / `ERR_CONNECTION_REFUSED`; devtool fine | `cloud.init` is never actually called. Devtool injects a default environment, real devices do not | Lazy-init on first use: `cloud.init({ env, traceUser: false })` inside `try/catch` |
| `grep cloud.init` finds nothing but a `cloudInited` flag | Flag without the call — a silent no-op | Replace the flag with the real call |
| Devtool throws `-80001` when you init at launch | Launch-time init conflicts with the injected environment | Move init to first use, not `app.tsx` top level |
| Works on Wi-Fi, fails on cellular | Candidates are LAN-only | Order candidates: relay → domain → LAN on device |
| Everything 403s after a "successful" probe | Probe hit an open path (`/api/health`), so the app believes direct access works | Probe an endpoint that requires auth, e.g. `GET /api/schools` |

## Admin / login broken

| Symptom | Cause | Fix |
|---|---|---|
| Admin page says "wrong key" forever, even with the right key | `POST /api/admin/login` is behind the gate; the browser has no credential yet | Add it to the open list |
| Login works locally, 403 online | Same as above, and local requests are loopback so the gate never ran | Test the gate from a non-loopback address |
| New admin feature 404/403 in production only | New route not covered by the gate's allowlist logic | Re-read the allowlist; admin routes need the key, app routes do not |

## Uploads

| Symptom | Cause | Fix |
|---|---|---|
| Upload times out only via relay | Function timeout still 3 s (devtool default) | Raise to 20 s in the cloud console |
| `FILE_DOWNLOAD_FAIL` | `cloud://` id from a different appid/environment | Re-upload in the target environment |
| `CDN_DOWNLOAD_FAIL_403` | CDN URL expired before the function fetched it | Fetch immediately; do not queue the URL |
| Avatar saved but empty | Server validator rejects `cloud://` and drops the field silently | Widen the regex; keep the same rule in every copy of it |

## Images

| Symptom | Cause | Fix |
|---|---|---|
| Device log: `图片链接 http://... 不再支持 HTTP 协议` | `<Image>` refuses http on device (devtool does not) | Serve user images from cloud storage (`cloud://`) |
| Admin page shows broken images for `cloud://` values | Browsers cannot open `cloud://` | `/api/file-url?fid=…` → `302` to a temporary HTTPS URL, cached |
| Images fine on Wi-Fi, blank on cellular | Still pointing at a LAN IP | Absolute public URL or cloud storage |

## Tooling

| Symptom | Cause | Fix |
|---|---|---|
| `tcb` exits with `ECONNREFUSED 127.0.0.1:7897` | Local proxy env vars leak into the CLI | `unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy` |
| Deploy fails with `Creating` | Function still provisioning | Wait ~25 s, retry |
| `tcb fn list` shows functions you do not recognise | You are looking at another mini program's environment | Environments are per appid; open cloud devtools from the target mini program |
| `node -e "…"` fails with `stdin is not a tty` in git-bash | Quoting/`$` mangling | Write the script to a `.mjs` file and run the file |

## Design mistakes that look like bugs

- **Relay as the only path.** Without a filed domain you have no fallback when the relay misbehaves.
  Keep both, and keep the kill switch.
- **Relay as a general gateway.** Every call is billed and adds a hop. Use it to bridge, not to scale.
- **Trusting the relay for identity.** Identity headers pass through; authorization must still be
  enforced in the backend. A client can forge any header it likes.
- **Open proxy.** A relay with no `PROXY_KEY` (or a default one in the repo) turns your server into
  an anonymous egress point.
