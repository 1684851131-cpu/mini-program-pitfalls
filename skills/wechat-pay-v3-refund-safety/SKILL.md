---
name: wechat-pay-v3-refund-safety
description: Use when handling WeChat Pay V3 refunds or payouts.
version: 1.0.0
author: open-source
license: MIT
metadata:
  hermes:
    tags: [wechat-pay, refund, idempotency, payout, payments, fintech]
---

# WeChat Pay V3: refunds and payouts that cannot double-spend

One rule drives everything here:

> **Money is settled by the receipt, never by the return value.**
> HTTP 200 means "the request was accepted". It never means "the money moved".

Every incident in this domain comes from a program that treated a successful API call as a completed
refund, or that retried with a new document number. This skill encodes the state machine and the
retry discipline that prevent both.

## When to use

- Implementing or reviewing `POST /v3/refund/domestic/refunds` and its callback.
- Building a payout / withdrawal flow on `POST /v3/fund-app/mch-transfer/transfer-bills`.
- Reviewing code that says `if (res.ok) order.refunded = true` — that line is the bug.
- Debugging "user says refunded, money not received" or "refunded twice".

## The state machine

Refunds have exactly four terminal states. Model them explicitly; do not collapse to a boolean.

```
requested ──► processing ──► success          (receipt says SUCCESS)
    │              │
    │              └────────► manual_review    (ABNORMAL / CLOSED / receipt mismatch)
    └──────────────────────► manual_review    (job cannot be matched to an order)
```

- `requested` — job persisted, money **reserved** (`pending`), not yet refunded.
- `processing` — provider accepted; keep querying. Still not refunded.
- `success` — a receipt matched this job on all four fields. Only now move reserved → refunded.
- `manual_review` — a human must look. Never auto-retry into this state.

See `references/refund-state-machine.md` for the full transition table with the provider's fields.

## Seven rules

### 1. Idempotency is keyed on the business fact, not the request

```js
// wrong: a duplicate callback or a retry creates a second job
// right: one job per (businessKey, orderId)
const existing = db.refundJobs.find(j => j.businessKey === businessKey && j.orderId === order.id);
if (existing) return existing;
```

Notification-ID dedupe only stops the same *notification* twice. It does not stop a second refund
originating from a retry, a manual action, or a different code path.

### 2. Reserve in-flight money, do not count it as refunded

```js
order.refundPendingFen += amountFen;       // in flight
order.refundStatus = 'requested';
// ...only on a matching receipt:
order.refundPendingFen -= amountFen;
order.refundedAmountFen += amountFen;
```

A single `refunded` counter forces you to either over-report (money not yet returned) or lose track
(no record of the in-flight amount). Two counters keep the ledger honest at every instant.

### 3. Validate the receipt on four fields, plus the provider id

```js
if (resource.out_refund_no !== job.id)                       throw 'RECEIPT_MISMATCH';
if (resource.out_trade_no !== job.orderId)                   throw 'RECEIPT_MISMATCH';
if (Number(resource.amount?.refund) !== job.amountFen)       throw 'RECEIPT_MISMATCH';
if (Number(resource.amount?.total)  !== job.totalFen)        throw 'RECEIPT_MISMATCH';
if (!resource.refund_id)                                     throw 'RECEIPT_MISSING';
```

Signature verification only proves the message came from WeChat. It does not prove the message is
about *this* order. Without the four-field check, a valid callback for someone else's refund can
settle yours.

### 4. Query before retrying; only 404 licenses a resend

```js
if (previouslyAttempted || job.providerRefundId) {
  const q = await provider.queryRefund(cfg, { outRefundNo: job.id });
  if (q.ok) { applyReceipt(order, job, q.refund); return; }
  if (q.status !== 404) { job.error = 'QUERY_UNCONFIRMED'; return; }  // unknown: wait
}
const r = await provider.refund(cfg, { outTradeNo: order.id, outRefundNo: job.id, ... });
```

- `404 RESOURCE_NOT_EXISTS` = the provider definitely has no such refund → safe to submit with the
  **same** `out_refund_no`.
- Anything else (timeout, 5xx, signature failure) = the outcome is unknown. Resending risks a second
  refund. Wait, query again later.

### 5. Never change the document number on retry

`out_refund_no` is the idempotency key. The provider guarantees "same number, one refund". A new
number is a new refund. This is the single most expensive mistake in the domain — it is also the one
that looks most like a harmless fix ("the old one errored, let me try a fresh id").

### 6. ABNORMAL and CLOSED go to a human

- `ABNORMAL` — the card was cancelled/frozen; the money sits in the refund intermediate account.
  Requires `POST /v3/refund/domestic/refunds/{no}/apply-abnormal-refund` or manual handling.
- `CLOSED` — the refund was in PROCESSING for 7 days with insufficient balance. Recharge, then create
  a **new** refund with a **new** number (this is the one legitimate place a new number is correct).

Neither should be retried automatically.

### 7. The 365-day window is your problem, not the provider's

Refunds can only be requested within 365 days of payment success. `TRADE_OVERDUE` is returned by the
API and **is not delivered via the refund callback** — so a batch job that refunds old orders fails
silently. Store `paidAt`, check it before submitting, and route expired orders to a manual process.

## Payment callbacks (the other half)

| Rule | Why |
|---|---|
| Verify the signature *and* the decrypted resource | Signature proves origin only |
| Match `out_trade_no` to a local order, then compare `amount.total`, `mchid`, `appid` | Prevents settling the wrong order |
| Treat client-side "payment success" as a UI event, never as payment | The cashier closing is not the money arriving |
| Answer within 5 s, then process asynchronously | WeChat retries on timeout; slow handlers cause duplicate work |
| Persist the provider transaction id in full | Overwriting it causes cross-order reconciliation failures |
| A cancelled order that receives a successful payment → auto-refund immediately | Otherwise it is an orphan payment |

## Payouts / withdrawals (merchant transfer)

Payouts are refunds in reverse, with a stricter rule: **freeze first, settle on receipt**.

```
creating ──► waiting_confirm ──► SUCCESS        (settle: debit frozen)
                    │
                    ├──────────► FAIL/CANCELLED (release: credit back, mark refunded once)
                    └──────────► stays in flight (never roll back, never re-issue)
```

- Reserve the amount before calling the provider. Do not debit on success — by then the user may
  already have the money.
- **Explicit failure** (4xx parameter/permission) → release the frozen amount, idempotently.
- **Unknown outcome** (network error, 5xx, signature failure) → keep it frozen, keep it in flight,
  let the reconciliation job query it. Rolling back here lets the user withdraw the same balance twice.
- **First query must be ≥ 60 s after submission.** Querying earlier returns a misleading
  "document does not exist".
- `out_bill_no` accepts digits and letters only — no hyphens.
- Terminal states are `SUCCESS`, `FAIL`, `CANCELLED`; everything else means "still in flight".
  `WAIT_USER_CONFIRM` is *not* a failure — the user has 24 h to confirm in WeChat.
- The confirmation callback proves the confirm page opened, not that money arrived.

Details and scenario ids: `references/payout-and-verification.md`.

## Verify like it is production

Unit tests with a mocked provider prove nothing about this class of bug. Do these three:

1. **Run production code paths locally.** Restart with `NODE_ENV=production HOST=127.0.0.1` — this
   flips every `IS_DEVELOPMENT` branch, exposing gates that silently never open in production.
2. **Assert on the ledger, not the response.** After each step, read the order/user record directly
   and check `refundedAmountFen`, `refundPendingFen`, job status. Error responses often omit the
   object you need to verify.
3. **Prove the deployed build is the one you tested.** Look for a behaviour only new code produces
   (a new route returning 401 instead of 404), not a version string someone forgot to bump.

See `references/payout-and-verification.md` for fake-credential sandbox recipes and the 20-item
pre-launch checklist.

## Files

- `assets/refund-jobs.js` — dependency-free reference implementation of the job queue
- `references/refund-state-machine.md` — transitions, provider fields, code anchors
- `references/idempotency-rules.md` — the four idempotency layers and where each belongs
- `references/payout-and-verification.md` — payouts, scenario ids, sandbox verification, checklist
