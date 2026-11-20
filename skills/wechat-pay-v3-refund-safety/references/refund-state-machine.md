# Refund state machine, field by field

## Job states (yours)

| State | Set when | Money | Allowed next |
|---|---|---|---|
| `requested` | job created, amount reserved in `refundPendingFen` | reserved | `processing`, `success`, `manual_review` |
| `processing` | provider accepted the refund request | reserved | `success`, `manual_review` |
| `success` | a receipt matched on all four fields | moved to `refundedAmountFen` | terminal |
| `manual_review` | receipt mismatch, `ABNORMAL`, `CLOSED`, order missing, credentials changed | still reserved or unknown | human |

`requested` and `processing` look identical to a user and are completely different to you: the
first has never been submitted, the second has been accepted and must be confirmed. Keep them
separate so a crash between "submitted" and "confirmed" does not resend blindly.

## Provider statuses (theirs)

| `resource.status` | Meaning | What you do |
|---|---|---|
| `SUCCESS` | money returned | settle (after the four-field check) |
| `PROCESSING` | accepted, not finished | keep `processing`, query again |
| `ABNORMAL` | card cancelled/frozen, money stuck in the refund intermediate account | `manual_review` + apply-abnormal-refund or manual handling |
| `CLOSED` | 7 days in PROCESSING with insufficient balance | `manual_review`; recharge, then a **new** refund number |

Never map `PROCESSING` to success "because it usually finishes". The usual case is not a state
machine.

## Receipt fields you must compare

| Field | Compare with | Failure means |
|---|---|---|
| `out_refund_no` | job id | this receipt belongs to another refund |
| `out_trade_no` | order id | right job, wrong order |
| `amount.refund` | job.amountFen | partial-refund arithmetic drifted |
| `amount.total` | job.totalFen | order total changed under you |
| `refund_id` | must exist | receipt is not a real settlement |

`amount.total` is the **original payment total**, not the refunded amount. Comparing it to the refund
amount is a classic mistake that makes every partial refund look like a mismatch.

## Where to put the mutation

```js
function onRefundNotify(resource) {
  const job = db.refundJobs.find(j => j.id === resource.out_refund_no);
  if (!job) return ack();                       // unknown job: still 200, stop retries
  const order = db.orders.find(o => o.id === job.orderId);
  try {
    applyProviderResult(order, job, resource);  // throws on mismatch
  } catch (e) {
    job.status = 'manual_review';               // never retry a mismatch
    order.refundStatus = 'manual_review';
  }
  save();
  return ack();                                 // ack within 5 s, always
}
```

Acknowledge even when you cannot process the message. Returning 5xx makes WeChat retry, which
multiplies the ambiguity you are trying to resolve.

## Timers that matter

| Timer | Value | Consequence of getting it wrong |
|---|---|---|
| Callback ack | ≤ 5 s | retries, duplicate work |
| First reconcile query (refund) | ~60 s | unnecessary load, not harmful |
| First reconcile query (payout) | **≥ 60 s** | false "document does not exist" |
| Refund validity window | 365 days from payment | `TRADE_OVERDUE`, silently not delivered via callback |
| `PROCESSING` → `CLOSED` | 7 days | money never leaves the intermediate account |
| Payout confirmation window | 24 h | `WAIT_USER_CONFIRM` expires into a terminal state |

## Partial refunds

- One order supports up to 50 partial refunds.
- Each partial refund needs a **new** `out_refund_no`, and consecutive ones must be ≥ 1 minute apart.
- `refundableFen = paidAmountFen - refundedAmountFen` — note: it excludes in-flight amounts, so also
  check that `refunded + pending <= paid` before creating a job.
- Report `refundStatus = 'processing'` while any job is unsettled, `'success'` only when none are.
