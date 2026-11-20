# Payouts, verification, and the pre-launch checklist

## Payout state machine

```
creating ──► waiting_confirm ──► SUCCESS        settle: frozen → spent
    │              │
    │              ├──────────► FAIL / CANCELLED release: frozen → balance (once)
    │              └──────────► in flight        query again later
    └──► failed (explicit 4xx)                   release immediately
```

Frozen balance is the whole design. Debit **before** calling the provider, so a crash can never leave
money both in the wallet and in WeChat.

| Outcome class | Examples | Action |
|---|---|---|
| Explicit failure | 400 param error, 403 scene not enabled, 401 signature | release the frozen amount, mark `refunded` once |
| Unknown | timeout, 5xx, response signature failed | keep frozen, keep in flight, query |
| Accepted | `WAIT_USER_CONFIRM` + `package` | wait for the user, do not retry |

Releasing on an unknown outcome is the dangerous one: the user could then withdraw the same balance
again while the first transfer is still in flight.

## Transfer specifics

- `POST /v3/fund-app/mch-transfer/transfer-bills`
- `out_bill_no`: **digits and letters only** — no hyphens, no underscores.
- `transfer_scene_id` must be one your merchant account has actually enabled. Documented scenes:
  - `1005` commission/reward → `report_infos` = `[{job_type}, {reward_desc}]`
  - `1000` cash marketing → `[{activity_name}, {reward_desc}]`
  The field names inside `report_infos` are fixed by the scene; inventing them fails validation.
- `state=WAIT_USER_CONFIRM` + `package_info` → mini program calls
  `wx.requestMerchantTransfer({ mchId, appId, package })`. Guard with `canIUse`.
- Query: `GET /v3/fund-app/mch-transfer/transfer-bills/out-bill-no/{no}`, **first query ≥ 60 s** and
  throttle to 60 s per bill. Query coverage is the last 30 days.
- Default per-transaction limit is 200 CNY; per-user daily 2,000; per-merchant daily 50,000.
  Funds come from the **operations account**, which must be funded separately.
- ≥ 2,000 CNY requires an encrypted `user_name`; small amounts may omit it.

## Verification recipes

### 1. Run the production branch locally

```bash
NODE_ENV=production HOST=127.0.0.1 PORT=3000 node index.js
```

`IS_DEVELOPMENT` becomes false, so every gate that is only exercised in production actually runs.
Most "works locally, dead online" financial bugs are a gate that opens under `IS_DEVELOPMENT`.

### 2. Fake credentials, real request path

Generate a throwaway RSA keypair, register the public half as the platform anchor, and point the
merchant config at it. You can then prove:

- the gate opens/closes correctly,
- the request actually leaves the process (a WeChat-side rejection proves the network path is live),
- the safety net holds (unknown outcome does not roll back).

Only the final "real money" link requires real credentials and an enabled product.

### 3. Assert the ledger, not the response

After each step, read the record:

```js
console.log(order.refundedAmountFen, order.refundPendingFen, order.refundStatus, job.status);
```

Expected sequence for one full refund of 1000 fen:

```
0   1000  requested          requested
0   1000  processing         processing      (provider accepted)
1000   0  success            success         (receipt matched)
```

If `refunded` moves before `success`, settlement is happening on the wrong event.

### 4. Prove the deployment

Prefer a behaviour only the new code can produce over a version string:

- new route returns `401` (auth layer reached) instead of `404` (old build),
- a status field that used to be hard-coded is now computed,
- a callback log line that did not exist before.

## Pre-launch checklist (20)

**Refunds**
1. `refundableFen` excludes both refunded and in-flight amounts.
2. One job per `(businessKey, orderId)`.
3. In-flight money is reserved, never counted as refunded.
4. Receipt compared on `out_refund_no`, `out_trade_no`, `amount.refund`, `amount.total`.
5. `refund_id` required before settling.
6. Query before resend; only 404 licenses a resubmit.
7. Resubmit uses the same `out_refund_no`.
8. `ABNORMAL` / `CLOSED` → manual review, no auto retry.
9. `paidAt` stored; 365-day window checked before submitting.
10. Partial refunds: new number each time, ≥ 1 minute apart, ≤ 50 per order.

**Callbacks**

11. Signature verified on raw body, then decrypted.
12. `out_trade_no` matched to a local order; amount, `mchid`, `appid` compared.
13. Idempotent hit still returns 200.
14. Ack within 5 s; heavy work runs asynchronously.
15. Provider transaction id persisted in full.

**Payouts**

16. Amount frozen before the provider call.
17. Explicit 4xx releases; unknown outcome does not.
18. First query ≥ 60 s; per-bill throttle 60 s.
19. `out_bill_no` alphanumeric only; scene id and `report_infos` match the enabled scene.
20. `WAIT_USER_CONFIRM` treated as in-flight, with a re-confirm path inside 24 h.

**Operational**

- Reconciliation job runs on a timer, not only on user action.
- Health endpoint reports `newPaymentAvailable`, `realPayoutAvailable`, `refundJobsPending`.
- Secrets loaded from env/file, never hard-coded, never logged, never returned by an API.
