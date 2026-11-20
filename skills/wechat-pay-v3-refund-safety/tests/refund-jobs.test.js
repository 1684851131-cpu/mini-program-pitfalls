/* Functional test for the published refund-jobs reference implementation. */
const { requestRefund, processRefundJobs } = require(
  '../assets/refund-jobs.js'
);

const mkDb = () => ({
  orders: [{
    id: 'ORD-1', userId: 'u1', paymentStatus: 'paid', payChannel: 'wxpay',
    paidAmountFen: 1000, refundedAmountFen: 0, refundPendingFen: 0,
    refundStatus: 'none', paymentMchId: 'M1', paymentAppId: 'A1',
  }],
  users: [{ id: 'u1', balance: 0 }],
  refundJobs: [],
});

const cfg = { ready: true, mchId: 'M1', appId: 'A1' };
let saveCount = 0;
const save = () => { saveCount++; };

const assert = (cond, msg) => {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
  console.log('  ok -', msg);
};

(async () => {
  /* ---------- 1. create + idempotency ---------- */
  console.log('\n[1] create job / business idempotency');
  let db = mkDb();
  const o = db.orders[0];
  const j1 = requestRefund(db, o, 1000, 'timeout', 'cancel-timeout', false);
  const j2 = requestRefund(db, o, 1000, 'timeout', 'cancel-timeout', false);
  assert(j1 === j2, 'second call returns the same job object');
  assert(db.refundJobs.length === 1, 'only one job exists');
  assert(o.refundPendingFen === 1000, 'amount reserved in pending');
  assert(o.refundedAmountFen === 0, 'nothing counted as refunded yet');
  assert(o.refundStatus === 'requested', 'order marked requested');

  /* ---------- 2. submit: 200 accepted, still not settled ---------- */
  console.log('\n[2] submit returns ok but does not settle');
  const provider = {
    submitted: 0,
    refund: async () => { provider.submitted++; return { ok: true, refundId: 'WX-R1' }; },
    queryRefund: async () => ({ ok: false, status: 500 }),
  };
  await processRefundJobs(db, provider, () => cfg, save, Date.now());
  assert(provider.submitted === 1, 'provider called once');
  assert(j1.status === 'processing', 'job is processing after 200');
  assert(o.refundedAmountFen === 0, 'still nothing refunded');
  assert(o.refundPendingFen === 1000, 'still reserved');

  /* ---------- 3. unknown query result must NOT resend ---------- */
  console.log('\n[3] unknown query result blocks resubmission');
  await processRefundJobs(db, provider, () => cfg, save, Date.now() + 61_000);
  assert(provider.submitted === 1, 'no second submit while outcome unknown');
  assert(j1.error === 'REFUND_QUERY_UNCONFIRMED', 'job records the unconfirmed query');

  /* ---------- 4. receipt settles, four-field check ---------- */
  console.log('\n[4] matching receipt settles');
  provider.queryRefund = async () => ({
    ok: true,
    refund: {
      out_refund_no: j1.id, out_trade_no: o.id, refund_id: 'WX-R1',
      amount: { refund: 1000, total: 1000 }, status: 'SUCCESS',
    },
  });
  await processRefundJobs(db, provider, () => cfg, save, Date.now() + 122_000);
  assert(j1.status === 'success', 'job settled');
  assert(o.refundedAmountFen === 1000, 'moved to refunded');
  assert(o.refundPendingFen === 0, 'pending cleared');
  assert(o.refundStatus === 'success', 'order status success');

  /* ---------- 5. mismatched receipt -> manual review ---------- */
  console.log('\n[5] amount mismatch goes to manual review');
  db = mkDb();
  const o2 = db.orders[0];
  const j3 = requestRefund(db, o2, 300, 'partial', 'cancel-user', false);
  const p2 = {
    submitted: 0,
    refund: async () => { p2.submitted++; return { ok: true, refundId: 'WX-R2' }; },
    queryRefund: async () => ({
      ok: true,
      refund: {
        out_refund_no: j3.id, out_trade_no: o2.id, refund_id: 'WX-R2',
        amount: { refund: 999, total: 1000 }, status: 'SUCCESS',   // wrong refund amount
      },
    }),
  };
  await processRefundJobs(db, p2, () => cfg, save, Date.now());
  await processRefundJobs(db, p2, () => cfg, save, Date.now() + 61_000);
  assert(j3.status === 'manual_review', 'mismatch routed to manual review');
  assert(o2.refundedAmountFen === 0, 'nothing settled on a bad receipt');
  assert(o2.refundPendingFen === 300, 'reservation kept for the human');

  /* ---------- 6. ABNORMAL -> manual review, never retried ---------- */
  console.log('\n[6] ABNORMAL goes to manual review');
  db = mkDb();
  const o3 = db.orders[0];
  const j4 = requestRefund(db, o3, 500, 'x', 'dispute-lost', false);
  const p3 = {
    submitted: 0,
    refund: async () => { p3.submitted++; return { ok: true, refundId: 'WX-R3' }; },
    queryRefund: async () => ({
      ok: true,
      refund: {
        out_refund_no: j4.id, out_trade_no: o3.id, refund_id: 'WX-R3',
        amount: { refund: 500, total: 1000 }, status: 'ABNORMAL',
      },
    }),
  };
  await processRefundJobs(db, p3, () => cfg, save, Date.now());
  await processRefundJobs(db, p3, () => cfg, save, Date.now() + 61_000);
  assert(j4.status === 'manual_review', 'ABNORMAL -> manual_review');

  /* ---------- 7. amount guards ---------- */
  console.log('\n[7] amount guards');
  db = mkDb();
  const o4 = db.orders[0];
  let threw = 0;
  try { requestRefund(db, o4, 0, 'x', 'k', false); } catch (e) { threw++; }
  try { requestRefund(db, o4, 1001, 'x', 'k2', false); } catch (e) { threw++; }
  try { requestRefund(db, o4, 10.5, 'x', 'k3', false); } catch (e) { threw++; }
  assert(threw === 3, 'zero / over-refundable / non-integer all rejected');

  console.log('\nALL PASS');
})();
