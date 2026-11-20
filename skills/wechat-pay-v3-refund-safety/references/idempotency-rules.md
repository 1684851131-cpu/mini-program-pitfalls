# The four idempotency layers

Most "duplicate refund" incidents come from putting idempotency in the wrong layer, or in only one.
These four are independent; you need all of them, and each must be keyed on the right thing.

| # | Layer | Key | Stops | Does **not** stop |
|---|---|---|---|---|
| 1 | HTTP request | `out_refund_no` | same request retried | a second request from another code path |
| 2 | Business job | `(businessKey, orderId)` | two jobs for one business fact | duplicate settlement of one job |
| 3 | Notification | message/notification id | same callback delivered twice | a resend after a timeout |
| 4 | Ledger write | order status + amount check, in one atomic step | double settlement of one job | creating a second job |

## Layer 1 — document number

The provider guarantees "same `out_refund_no`, one refund". This is why rule 5 exists: retries keep
the number, only a genuinely new business intent gets a new one.

Note the asymmetry with partial refunds: multiple partial refunds on **one order** legitimately use
**different** numbers (up to 50, ≥ 1 minute apart). The key is the refund intent, not the order.

## Layer 2 — business key

```js
const existing = db.refundJobs.find(
  j => j.businessKey === businessKey && j.orderId === order.id
);
if (existing) return existing;
```

`businessKey` should name the *reason*, not the request: `cancel-timeout`, `cancel-user`,
`dispute-lost`, `item-unavailable`. Two different reasons on one order are two legitimate refunds.

Anti-pattern: keying on `requestId` or `Date.now()`. Both make every call unique, which is the
opposite of idempotency.

## Layer 3 — notification dedupe

Worth having (cheap, prevents wasted work) but never sufficient:

- A notification can arrive after your handler already timed out — dedupe by message id does not know
  the business already completed.
- A manual retry or a reconcile query produces settlement attempts that are not notifications at all.

**Dedupe on the business state**, not on the message:

```js
if (job.status === 'success') return ack();   // already settled, still ack
```

And: an idempotent hit must still answer **200**. Throwing "already processed" turns into a 5xx, which
triggers provider retries — the exact loop you were avoiding.

## Layer 4 — atomic settle

The check and the write must be one step. In a single-process store, "one step" means the operation is
synchronous between the check and the mutation (no `await` in between). With SQL:

```sql
UPDATE orders
   SET refunded_fen = refunded_fen + :amt,
       pending_fen  = pending_fen  - :amt
 WHERE id = :id
   AND pending_fen >= :amt
   AND refunded_fen + :amt <= paid_fen;
-- 0 rows affected => someone else settled it, or the arithmetic is wrong
```

In JSON-file backends the equivalent discipline is: one process owns the file, mutations are
synchronous, and the job's `status` is flipped in the same tick as the order's counters.

## Failure handling per layer

| Situation | Layer that catches it | What you do |
|---|---|---|
| Same callback twice | 3 (then 4) | settle once, ack both |
| Timeout after submit | 4 (provider-side: 1) | query, do not resend on a new number |
| User taps refund twice | 2 | second call returns the existing job |
| Two admin tabs, same order | 2 + 4 | one job, one settlement |
| Crash between submit and confirm | 1 + state | resume as `processing`, query |
| Network error mid-request | none | unknown outcome → `processing`, query later |

The last two are the ones tests usually miss: kill the process between `provider.refund()` returning
and `save()` completing, then restart and confirm the job converges to `success` (or `manual_review`)
without a second refund.
