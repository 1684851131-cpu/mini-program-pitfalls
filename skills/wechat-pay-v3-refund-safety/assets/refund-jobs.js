'use strict';
/**
 * refund-jobs.js — reference implementation of a persistent, receipt-driven refund queue.
 *
 * Dependency-free. Drop into any backend that keeps its data in memory and persists it (JSON file,
 * SQLite, whatever). The only requirement is that `save()` durably writes `db`.
 *
 * Data model used here:
 *   db.orders[]      { id, paidAmountFen, refundedAmountFen, refundPendingFen, refundStatus,
 *                      paymentStatus, payChannel, paymentMchId, paymentAppId, refundedAt }
 *   db.users[]       { id, balance }                       // only used by the mock channel
 *   db.refundJobs[]  { id, orderId, businessKey, amountFen, totalFen, status, attempts, nextAt, ... }
 *
 * Invariants this file enforces:
 *   1. One job per (businessKey, orderId) — business-level idempotency.
 *   2. In-flight money is reserved, never counted as refunded.
 *   3. A job is only settled by a receipt matching all four fields.
 *   4. Query before resend; only a 404 licenses resubmission, with the same document number.
 *   5. ABNORMAL / CLOSED go to manual review, never to automatic retry.
 */

const refundableFen = (order) =>
  Math.max(
    0,
    Math.round(Number(order.paidAmountFen) || 0) - Math.round(Number(order.refundedAmountFen) || 0)
  );

/**
 * Create (or return) a refund job. Does not call the provider — the queue does that.
 * @param {object} db
 * @param {object} order
 * @param {number} amountFen      integer fen, > 0, <= refundable
 * @param {string} reason         <= 80 chars (provider limit)
 * @param {string} businessKey    stable id of the business fact, e.g. 'cancel-timeout'
 * @param {boolean} allowMock     true only in development
 */
function requestRefund(db, order, amountFen, reason, businessKey, allowMock) {
  db.refundJobs = Array.isArray(db.refundJobs) ? db.refundJobs : [];

  const existing = db.refundJobs.find(
    (j) => j.businessKey === businessKey && j.orderId === order.id
  );
  if (existing) return existing;

  if (!Number.isSafeInteger(amountFen) || amountFen <= 0 || amountFen > refundableFen(order)) {
    throw new Error('REFUND_AMOUNT_INVALID');
  }
  if (order.financialReviewRequired || order.paymentStatus !== 'paid') {
    throw new Error('FINANCIAL_REVIEW_REQUIRED');
  }

  const job = {
    id: order.id + '-R' + (db.refundJobs.filter((j) => j.orderId === order.id).length + 1),
    orderId: order.id,
    businessKey,
    amountFen,
    totalFen: order.paidAmountFen,
    channel: order.payChannel,
    mchId: order.paymentMchId || '',
    appId: order.paymentAppId || '',
    reason: String(reason || 'Order refund').slice(0, 80),
    status: 'requested',
    attempts: 0,
    createdAt: new Date().toISOString(),
    nextAt: Date.now(),
  };

  if (order.payChannel === 'mock' && allowMock) {
    const user = db.users.find((u) => u.id === order.userId);
    if (!user) throw new Error('REFUND_USER_MISSING');
    user.balance = Math.round((Number(user.balance || 0) + amountFen / 100) * 100) / 100;
    job.status = 'success';
    job.completedAt = new Date().toISOString();
    order.refundedAmountFen = Number(order.refundedAmountFen || 0) + amountFen;
    order.refundStatus = 'mock_success';
    order.refundedAt = job.completedAt;
  } else if (order.payChannel === 'wxpay') {
    order.refundPendingFen = Number(order.refundPendingFen || 0) + amountFen; // reserve
    order.refundStatus = 'requested';
  } else {
    throw new Error('REFUND_CHANNEL_UNKNOWN');
  }

  order.refundAmount =
    (Number(order.refundedAmountFen || 0) + Number(order.refundPendingFen || 0)) / 100;

  db.refundJobs.push(job);
  return job;
}

/**
 * Apply a provider receipt. Throws on any mismatch — the caller turns that into manual review.
 * `resource` is the decrypted/queries refund object from WeChat Pay V3.
 */
function applyProviderResult(order, job, resource) {
  if (!resource) throw new Error('REFUND_RECEIPT_MISMATCH');
  if (resource.out_refund_no !== job.id) throw new Error('REFUND_RECEIPT_MISMATCH');
  if (resource.out_trade_no !== job.orderId) throw new Error('REFUND_RECEIPT_MISMATCH');
  if (Number(resource.amount && resource.amount.refund) !== job.amountFen) {
    throw new Error('REFUND_RECEIPT_MISMATCH');
  }
  if (Number(resource.amount && resource.amount.total) !== job.totalFen) {
    throw new Error('REFUND_RECEIPT_MISMATCH');
  }

  job.providerRefundId = String(resource.refund_id || job.providerRefundId || '');
  if (!job.providerRefundId) throw new Error('REFUND_RECEIPT_MISSING');

  if (resource.status === 'SUCCESS') {
    if (job.status !== 'success') {
      order.refundPendingFen = Math.max(0, Number(order.refundPendingFen || 0) - job.amountFen);
      order.refundedAmountFen = Number(order.refundedAmountFen || 0) + job.amountFen;
      job.status = 'success';
      job.completedAt = new Date().toISOString();
      order.refundedAt = job.completedAt;
    }
    order.refundStatus = Number(order.refundPendingFen || 0) ? 'processing' : 'success';
  } else if (['CLOSED', 'ABNORMAL'].includes(resource.status)) {
    job.status = 'manual_review';
    order.refundStatus = 'manual_review';
  } else {
    job.status = 'processing';
    order.refundStatus = 'processing';
  }
}

/**
 * Drive the queue. Call every N seconds (or after every mutation); it is cheap when empty.
 *
 * @param {object}   db
 * @param {object}   provider   { refund(cfg, p), queryRefund(cfg, p) }
 * @param {function} getConfig  () => payCfg | null   (must include mchId, appId, and ready)
 * @param {function} save       () => void            (durable write)
 * @param {number}   now        injectable clock for tests
 */
async function processRefundJobs(db, provider, getConfig, save, now = Date.now()) {
  for (const job of db.refundJobs || []) {
    if (job.channel !== 'wxpay') continue;
    if (!['requested', 'processing'].includes(job.status)) continue;
    if (Number(job.nextAt || 0) > now) continue;

    const order = db.orders.find((o) => o.id === job.orderId);
    if (!order) {
      job.status = 'manual_review';
      save();
      continue;
    }

    const cfg = getConfig();
    if (!cfg || !cfg.ready || !job.mchId || cfg.mchId !== job.mchId || cfg.appId !== job.appId) {
      job.error = 'REFUND_CREDENTIALS_MISMATCH';
      job.nextAt = now + 60000;
      save();
      continue;
    }

    const previouslyAttempted = job.attempts > 0;
    job.attempts += 1;
    job.nextAt = now + 60000;                 // back off before the next round
    job.lastAttemptAt = new Date(now).toISOString();
    save();

    try {
      /* Rule 4: query first. Only "definitely absent" (404) licenses a resend. */
      if (previouslyAttempted || job.providerRefundId) {
        const q = await provider.queryRefund(cfg, { outRefundNo: job.id });
        if (q.ok) {
          applyProviderResult(order, job, q.refund);
          job.error = '';
          save();
          continue;
        }
        if (q.status !== 404) {
          job.error = 'REFUND_QUERY_UNCONFIRMED';   // unknown outcome: do NOT resend
          save();
          continue;
        }
      }

      /* Rule 5: same out_refund_no, always. Returns 200 = accepted, not settled. */
      const r = await provider.refund(cfg, {
        outTradeNo: order.id,
        outRefundNo: job.id,
        totalFen: job.totalFen,
        refundFen: job.amountFen,
        reason: job.reason,
      });
      if (!r.ok) {
        job.error = 'REFUND_REQUEST_FAILED';
        save();
        continue;
      }
      job.providerRefundId = r.refundId;
      job.status = 'processing';
      order.refundStatus = 'processing';
      job.error = '';
      save();
      /* Deliberately no settlement here: the next round must confirm with a receipt. */
    } catch (e) {
      const msg = String((e && e.message) || 'REFUND_RETRY_REQUIRED');
      if (msg.startsWith('REFUND_RECEIPT')) {
        job.status = 'manual_review';
        order.refundStatus = 'manual_review';
      }
      job.error = msg.slice(0, 80);
      save();
    }
  }
}

module.exports = { requestRefund, applyProviderResult, processRefundJobs, refundableFen };
