# Launch checklist — with verification steps

Print this. Every row needs **evidence**, not memory. "Configured" is not evidence;
"returned 200 from a non-loopback address" is.

Legend: 🔴 blocks launch · 🟡 fix within the first week · ⚪ nice to have

---

## A. Compliance & platform

| # | Check | How to verify | Pass when |
|---|---|---|---|
| A1 🔴 | Domain filed, entity matches | Fetch the filing record; compare entity name with the mini program's registered entity | Names match |
| A2 🔴 | Request allowlist complete | Open devtools → project settings; list every domain the code calls (API, maps, upload host) | Every host in code appears in the console list |
| A3 🔴 | Category matches functionality | Compare the console category with what the reviewer will see | No feature outside the declared category |
| A4 🔴 | Privacy policy accurate | Walk each collected field (phone, location, album, camera) and confirm it is declared | Every collected field is declared; nothing declared that you do not collect |
| A5 🟡 | Subscription templates approved | Console → subscribe message → template list; confirm each id used in code exists | No template id in code is missing from the console |
| A6 🔴 | Merchant products enabled | Merchant portal → product center; confirm JSAPI pay and merchant transfer are both "enabled" | Products show enabled, not just applied |
| A7 🔴 | Payment callback reachable | `curl -i -X POST https://<domain>/api/pay/notify` from the public internet | Returns a non-5xx (signature failure is expected), and response is not cached |
| A8 🔴 | Reviewer test account | Log in on a real device with the exact credentials you will send the reviewer | Full core flow works with no SMS step |
| A9 ⚪ | Account switch documented | Write the login path in the review notes | A stranger can follow it in 3 steps |

## B. Backend & data

| # | Check | How to verify | Pass when |
|---|---|---|---|
| B1 🔴 | Function/endpoint headroom | Count deployed functions | ≤70% of the platform cap |
| B2 🟡 | Batch jobs paged | Run the largest batch with a production-sized dataset | Completes without timeout, resumes after interrupt |
| B3 🔴 | Timeout fallbacks running | Read the logs of the timer, not the config | Each fallback produced at least one log line in the last 24 h |
| B4 🔴 | Writes are server-side | Grep the client for direct DB calls or unauthenticated write endpoints | Zero writes to money/stock/state from the client |
| B5 🔴 | Integer minor units | Grep for `parseFloat`/`toFixed` on amounts | No float arithmetic on money |
| B6 🔴 | Atomic persistence | Kill the process mid-write, restart, read the record | Old complete state or new complete state, never half |
| B7 🔴 | Backup restore | Restore the newest backup into a scratch environment | Row counts and key fields match |
| B8 🟡 | Capacity headroom | Check storage/database usage in the console | <70% of quota, with a growth estimate |
| B9 🟡 | Indexes on list queries | Run each list endpoint with `explain` or timing at 10× data | No full scan; latency flat as data grows |

## C. Money

| # | Check | How to verify | Pass when |
|---|---|---|---|
| C1 🔴 | Callback chain complete | Send a correctly signed callback for a known order | Order settles once; replaying it does not settle twice |
| C2 🔴 | Ownership check | Send a valid callback with a mismatched amount | Rejected, not settled |
| C3 🔴 | Refund idempotency | Create a refund, call the creation path twice | One job, one document number |
| C4 🔴 | Refund retry safety | Force a timeout after submit, then let the queue retry | It queries first; no second refund |
| C5 🔴 | 365-day window | Find the oldest paid order, attempt a refund | Blocked with a clear message, not a provider error |
| C6 🔴 | Payout freeze | Submit a payout, kill the process before confirmation | Balance still frozen after restart; reconciliation picks it up |
| C7 🔴 | Unknown ≠ failure | Point the provider at a black-hole host | Balance stays frozen; no release |
| C8 🔴 | Manual exit exists | Look at the admin screen for the manual-review list | List shows id, reason, amount, age; can be resolved |
| C9 🟡 | Daily reconciliation | Compare one day's local ledger with the platform bill | Diff is zero or has a documented explanation per line |
| C10 🔴 | Secrets server-side | Grep repo and built bundle for keys, merchant ids, private keys | Zero hits outside server-side config |

## D. Client & device

| # | Check | How to verify | Pass when |
|---|---|---|---|
| D1 🔴 | Full device pass | Real phone, mobile data (not Wi-Fi) | First screen, login, order, pay, upload, admin page all work |
| D2 🔴 | No http images | Search the client for `http://` image sources and check stored values | All user images are https or `cloud://` |
| D3 🔴 | Cloud init is real | `grep -n "cloud.init" src/` | A real call exists, inside try/catch, on first use |
| D4 🔴 | Status branches have UI | Simulate 401, 403, and a business error | Each shows a distinct message; none shows an endless spinner |
| D5 🟡 | Weak network | Throttle to 3G / lose packets | Timeout message within 10 s, retry available |
| D6 🟡 | First screen independent | Log out, cold start | Home renders without a login-only call |

## E. Release & rollback

| # | Check | How to verify | Pass when |
|---|---|---|---|
| E1 🔴 | Version single source | Change the version once, check the About page and the payloads | One edit propagates everywhere |
| E2 🟡 | Staged verification | Upload a trial build and open it on a non-developer phone | Identical behaviour to production build |
| E3 🔴 | Rollback plan written | Write down: previous build id, data compatibility, who executes | Someone other than you can execute it |
| E4 🔴 | Deploy probe | Hit a route that only exists in the new build | 401/auth error (reached the app) instead of 404 |
| E5 🔴 | Health endpoint | `curl /api/health` | Returns version, uptime, dependency status, key counters |
| E6 🟡 | Alerts | Check the alert rule exists and fired once in a test | Alert arrives within 5 minutes of a simulated failure |
| E7 ⚪ | Outage sentence | Write the first public message for an outage | One sentence, no jargon, says what works |

## F. First 24 hours

| # | Check | How to verify | Pass when |
|---|---|---|---|
| F1 🔴 | Core flow success rate | Count successes/failures per flow for 24 h | Login/order/pay each have a number, no unexplained drop |
| F2 🟡 | Error log quiet | Group exceptions by message | No new repeating group |
| F3 🔴 | Timers ran | Search today's logs for each fallback | Every fallback fired at least once (or was legitimately idle) |
| F4 🟡 | Backups exist | List backup files with timestamps | Newest is younger than the backup interval |
| F5 🔴 | No stuck records | Query for records in intermediate states older than the timeout | Zero, or each has a manual-review record |

---

## The five that actually cause incidents

If you only have an hour, verify these five — they account for most launch-day failures:

1. **A7** payment callback reachable and not cached
2. **C1/C2** callback settles once and only for the right order
3. **B3** timers actually running
4. **D1** real device on mobile data
5. **E4** the deploy probe proves the new code is live

## Turning this into automation

| Automatable | How |
|---|---|
| A2, A7 | Fetch each domain from outside; assert status and headers |
| B1 | Call the platform API for function count |
| B8 | Query storage/database usage |
| E5 | Poll `/api/health`, assert version and dependency fields |
| F4 | List backup files, assert max age |
| F5 | Query intermediate-state records, assert none older than timeout × 2 |

Everything else needs a human on a real device once per release. That is acceptable — just do not skip
it because the devtool looked fine.
