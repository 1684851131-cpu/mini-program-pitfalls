---
name: mini-program-pitfalls
description: Use when shipping a mini program backend to production.
version: 1.0.0
author: open-source
license: MIT
metadata:
  hermes:
    tags: [wechat, miniprogram, launch, checklist, pitfalls, production]
---

# Common Pitfalls for Early-Stage Mini-Program Development

Twenty-five failures that look random until you see which layer they come from, each written as
**symptom → cause → proof of fix**. Ends with a launch checklist you can tick off.

This is the entry point. Two deep dives sit beside it:
`../wechat-miniprogram-unfiled-backend/` (reaching an unfiled backend) and
`../wechat-pay-v3-refund-safety/` (refunds that cannot double-spend).

## When to use

- A mini program is about to go to review or launch and you want to know what is missing.
- Everything "works" but the same bug keeps coming back in a different shape.
- You inherited someone else's backend and need a first-pass health check.
- Post-incident: decide whether it was bad luck or a structural gap.

## The three layers

Most "random" bugs are one layer you were not looking at:

| Layer | What you think it controls | What it actually controls | Symptom |
|---|---|---|---|
| **Runtime** | your code | quotas, cold start, timeouts, process liveness | fine at noon, dead at midnight |
| **Data** | what you wrote | who may write, who wins a race, how you recover | totals drift, records vanish |
| **Channel** | the API reaches the server | filing, allowlists, protocol, caching | devtool fine, phone dead |

**Debug channel → runtime → data, in that order.** Reverse it and you lose the most time, because a
broken channel looks exactly like a business bug.

---

## 1. Channel

### 1. Devtool fine, real device dead
Devtool does not check the request allowlist, does not block http images, and injects a default cloud
environment. A phone checks all three.
**Proof of fix:** on device — first screen renders, one image uploads, admin page opens.

### 2. Images blank on device, log says http not supported
`<Image>` accepts only https on device; devtool renders http happily.
**Proof of fix:** every user-supplied image is `cloud://` or https; no `http://IP` anywhere.

### 3. Admin page insists the key is wrong
The login POST has no credential yet, so a gate that requires one blocks it — and the UI reports the
403 as "wrong key".
**Proof of fix:** from a non-loopback address, `POST /api/admin/login` with the right key returns
200 + token.

### 4. One endpoint works intermittently
The probe hit an endpoint that is already allowlisted, so "reachable" was a false positive and every
real call then 403s.
**Proof of fix:** the probe endpoint requires auth; failure triggers a real fallback.

### 5. Service-account push fails with 40164
The caller's egress IP must be allowlisted, and a cloud function's egress IP is not stable.
**Proof of fix:** a tiny relay on a fixed-IP host does the WeChat call; the function only forwards.

## 2. Runtime

### 6. Hit the cloud-function count limit
The per-environment function cap is a system parameter (50 on the platform this was learned on), not
a billing tier.
**Proof of fix:** a function inventory, ≥30% headroom, new features merged into existing functions as
an action rather than a new function.

### 7. Batch jobs blow up
Per-invocation memory is capped (256 MB class) and default timeouts are short.
**Proof of fix:** paging (100–200 per page), a cursor, resumable, idempotent.

### 8. Everything returns 451 one morning
Balance exhausted or quota consumed at the platform level; the code did not change.
**Proof of fix:** balance/quota alerting exists, and there is a prepared "platform-side outage"
message.

### 9. Orders stuck in intermediate states forever
No timer exists anywhere — cloud functions have no trigger by default, and a long-running process
needs an explicit interval.
**Proof of fix:** three fallbacks running: unpaid timeout cancel, unhandled timeout, unconfirmed
timeout auto-complete. All idempotent, all able to catch up after a restart by comparing timestamps.

### 10. Data wrong after one crash
In-memory state never reached disk, or reached it partially.
**Proof of fix:** atomic writes (temp file + fsync + rename, or a transaction) and a startup pass that
re-enqueues stuck jobs.

## 3. Data

### 11. The client can write core tables
Stock decrement and order-state transitions performed client-side lose races and can be bypassed.
**Proof of fix:** money, stock and state change only on the server; the client submits intent
("2 bottles"), never a new total.

### 12. "Only the super admin can do this"
The permission check reads a field (`storeId`) the write path never set (it only wrote the display
name).
**Proof of fix:** every field read by a check is written by the writer; existing rows backfilled from
the related table; the check also falls back to that table.

### 13. New config value saves but never takes effect
The value is filtered by four allowlists: client params → server save → server response → client
parse.
**Proof of fix:** one definition referenced by all four sites; verified by "write a value, read it
back immediately".

### 14. Batch operations always affect 0 rows
A gateway or proxy serialized arrays/objects into JSON strings, so `Array.isArray()` was false and the
code silently processed an empty list.
**Proof of fix:** every array/object parameter is normalized once at the entry point.

### 15. Backups exist but cannot restore
Only "file exists" was ever verified.
**Proof of fix:** restore into a scratch environment once, compare row counts and key fields; keep a
window longer than the worst realistic mistake (≥24 h).

## 4. Money

### 16. "API returned 200" treated as "money moved"
A refund request returning success means *accepted*, not refunded.
**Proof of fix:** settlement happens only when a receipt matches on all fields.

### 17. Retried with a new document number, refunded twice
A new `out_refund_no` is a new refund.
**Proof of fix:** retries read the number from the job record, never generate one on the spot; query
first, resend only on a definitive "does not exist".

### 18. Settled on a signature-valid callback
A signature proves origin, not ownership.
**Proof of fix:** order id, amount, merchant id and app id are all compared before settling.

### 19. Payout rolled back, user withdrew twice
An unknown outcome (timeout/5xx) was treated as failure and the balance released while the transfer
was still in flight.
**Proof of fix:** freeze first; release only on an explicit 4xx; unknown keeps the freeze and goes to
reconciliation; first query ≥60 s.

### 20. No manual escape hatch
`ABNORMAL` / `CLOSED` jobs sit forever because only the happy path was implemented.
**Proof of fix:** a manual-review state and an admin list showing id, reason, amount, age.

## 5. Release & ops

### 21. nginx says reload succeeded but nothing changed
The reload failed at bind time (usually a config `listen`ing on an occupied port); the master keeps
running the old config and only error_log records it.
**Proof of fix:** after every change, check the tail of error_log and whether worker start time moved.
`exit 0` is not proof.

### 22. Reverse-proxy cache serves another user's data
**Proof of fix:** refresh the health endpoint — uptime must increase every time; two accounts must see
different data. Disable caching on API paths explicitly.

### 23. Not sure production runs the build you tested
Version strings lie (someone forgot to bump them).
**Proof of fix:** probe a behaviour only new code produces — a new route returning 401 instead of 404,
a field that changed from hard-coded to computed.

### 24. Review rejected: "cannot experience the feature"
Reviewers have no phone number, no approval, no balance.
**Proof of fix:** a config-gated test account (account + password, not SMS), pre-seeded data, and a
written path through the product.

### 25. No observability
**Proof of fix:** `/api/health` returns version, uptime and dependency status; errors are searchable
by time; one metric per core flow is logged every minute.

---

## Launch checklist

Full printable version with a "how to verify" column: `references/launch-checklist.md`.

### A. Compliance & platform
- [ ] Domain filed, filing entity matches the mini program entity
- [ ] Request allowlist includes the API domain and every third-party domain (maps, etc.)
- [ ] Category matches actual functionality (payment/medical/education have extra requirements)
- [ ] Privacy policy filled in and matches the fields you actually collect
- [ ] Subscription-message templates approved; template ids in config
- [ ] Merchant account has the products you use enabled (JSAPI, merchant transfer)
- [ ] Payment callback reachable over public HTTPS and not cached
- [ ] Reviewer test account prepared, not SMS-dependent

### B. Backend & data
- [ ] Function/endpoint count has ≥30% headroom
- [ ] Batch jobs paged and resumable
- [ ] ≥3 timeout fallbacks running, idempotent, catch-up after restart
- [ ] Writes only server-side; client never mutates state or stock
- [ ] Amounts are integer minor units end to end
- [ ] Critical writes atomic; persistence failure stops business rather than continuing
- [ ] Backups restored successfully at least once
- [ ] Storage/database capacity has headroom
- [ ] List endpoints are indexed, no full scans

### C. Money
- [ ] Callback: verify → decrypt → check ownership → idempotent settle
- [ ] Refund: request, idempotency, result confirmation, state persistence
- [ ] Refund retries reuse the original document number, after a query
- [ ] 365-day refund window checked before submitting
- [ ] Payout: freeze first, settle on receipt, never roll back on an unknown result
- [ ] ABNORMAL/CLOSED reachable from an admin screen
- [ ] Daily reconciliation: local ledger vs platform bill, diff list produced
- [ ] Secrets server-side only; not in repo, logs, or API responses

### D. Client & device
- [ ] Device: first screen, login, order, pay, image upload, admin page
- [ ] All user images over https or `cloud://`
- [ ] `cloud.init` is a real call, not just a flag
- [ ] Every status branch (401/403/business error) has UI
- [ ] Weak network and timeouts show a message, not a spinner
- [ ] First screen does not require a login-only endpoint

### E. Release & rollback
- [ ] Version number has a single source of truth, shown in the About page
- [ ] A staged or trial-build verification path exists
- [ ] Rollback plan: previous build + data compatibility
- [ ] Deploy probe proves the new code is live
- [ ] Health endpoint exposes version, dependencies, key counters
- [ ] Alerts on balance, quota, certificate expiry
- [ ] A prepared first sentence for "we are down"

### F. First 24 hours
- [ ] Success rate measured for login / order / pay / refund
- [ ] No new repeating exception in logs
- [ ] Timers actually ran (proved by logs, not by config)
- [ ] Backups generated
- [ ] No pile-up of intermediate-state records

---

## How to use this

1. Do A and D first (without them you cannot ship), then C (most expensive to get wrong), then B and E.
2. Every item needs evidence. "Configured" is not evidence; "returned 200 from outside" is.
3. Turn the automatable items into a script: health, domain reachability, function count, backup age.
4. Add one new check per release, not ten. A checklist nobody reads protects nothing.

## Files

- `references/launch-checklist.md` — printable checklist with verification steps
- `../wechat-miniprogram-unfiled-backend/` — channel layer, in depth
- `../wechat-pay-v3-refund-safety/` — money layer, in depth
