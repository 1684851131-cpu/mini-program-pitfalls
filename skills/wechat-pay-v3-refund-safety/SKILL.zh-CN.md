---
name: wechat-pay-v3-refund-safety
description: 微信支付 V3 退款与提现的资金安全实现。
version: 1.0.0
author: open-source
license: MIT
metadata:
  hermes:
    tags: [wechat-pay, refund, idempotency, payout, payments]
---

# 微信支付 V3：不会重复出款的退款与提现

整篇只有一个总原则：

> **钱的终态只认收据，不认返回值。**
> HTTP 200 只代表"请求被受理"，永远不代表"钱已经动了"。

这个领域的所有事故都长一个样：要么把"接口返回成功"当成退款到账，要么重试时换了单号。
这份文档把状态机和重试纪律固定下来，堵住这两个口子。

## 什么时候用

- 正在实现或审查 `POST /v3/refund/domestic/refunds` 及其回调
- 正在做提现 / 打款（`POST /v3/fund-app/mch-transfer/transfer-bills`）
- 代码里出现 `if (res.ok) order.refunded = true` —— 这一行就是 bug 本身
- 排查"用户说退了但没收到钱"或"退了两笔"

## 退款状态机（只有四种终态，别用布尔值）

```
requested ──► processing ──► success          （收据 status=SUCCESS）
    │              │
    │              └────────► manual_review    （ABNORMAL / CLOSED / 收据不符）
    └──────────────────────► manual_review    （任务对不上订单）
```

- `requested`：任务已落库，金额**预留在途**，还没退
- `processing`：微信已受理，继续查。仍然不算退成功
- `success`：收据四要素全部对上。**只有到这一步**才把在途金额转入已退
- `manual_review`：必须人工看。永远不要自动重试进这个状态

## 七条铁律

### 1. 幂等键是业务事实，不是请求

```js
// 错：回调重发、重试、另一个入口各建一条任务
// 对：一个 (businessKey, orderId) 只有一条任务
const existing = db.refundJobs.find(j => j.businessKey === businessKey && j.orderId === order.id);
if (existing) return existing;
```

通知 ID 去重只能挡住"同一条通知到达两次"，挡不住"从别处又发起了一次退款"。

### 2. 在途金额单独记，不并入已退

```js
order.refundPendingFen += amountFen;      // 在途
// ……只有收据匹配后才：
order.refundPendingFen -= amountFen;
order.refundedAmountFen += amountFen;
```

只用一个 `refunded` 计数器，结果只有两种：要么虚报（钱还没回去就显示已退），
要么丢账（在途那笔没地方记）。两个计数器才能让账本在任何瞬间都是真的。

### 3. 收据必须核四要素 + 退款单号

```js
if (resource.out_refund_no !== job.id)                 throw 'RECEIPT_MISMATCH';
if (resource.out_trade_no !== job.orderId)             throw 'RECEIPT_MISMATCH';
if (Number(resource.amount?.refund) !== job.amountFen) throw 'RECEIPT_MISMATCH';
if (Number(resource.amount?.total)  !== job.totalFen)  throw 'RECEIPT_MISMATCH';
if (!resource.refund_id)                               throw 'RECEIPT_MISSING';
```

验签只证明"报文来自微信"，不证明"这笔钱属于这个订单"。少了四要素核对，
一条别人的合法回调就能把你的订单改成已退款。

### 4. 先查后重试；只有 404 才允许重发

```js
if (previouslyAttempted || job.providerRefundId) {
  const q = await provider.queryRefund(cfg, { outRefundNo: job.id });
  if (q.ok) { applyReceipt(order, job, q.refund); return; }
  if (q.status !== 404) { job.error = 'QUERY_UNCONFIRMED'; return; }  // 结果不明：等
}
// 只有"微信确认没有这笔退款单"才重发，且单号不变
```

### 5. 重试永远用原单号

`out_refund_no` 就是幂等键。微信保证"同号只退一笔"，换号 = 新的一笔退款。
这是这个领域最贵的一个错误，也是最像"无害修复"的一个动作（旧单报错了，换一个新 id 试试）。

### 6. ABNORMAL / CLOSED 交给人

- `ABNORMAL`：用户卡作废/冻结，钱停在退款中间账户 → 调「发起异常退款」或人工处理
- `CLOSED`：处理中超过 7 天且余额不足 → 充值后用**新单号**重新发起（这是唯一该换号的场景）

这两种都不要自动重试。

### 7. 365 天窗口是你的事，不是微信的

退款只能针对支付成功 365 天内的订单。超期返回 `TRADE_OVERDUE`，而且**这个拒绝不会通过退款回调下发**
——所以批量退历史订单会静默失败。存好 `paidAt`，提交前先判断，超期的走人工。

## 支付回调的另一半

| 规则 | 原因 |
|---|---|
| 验签 + 解密之后还要核对归属 | 验签只证明来源 |
| 用 `out_trade_no` 找到本地订单，再比 `amount.total`、`mchid`、`appid` | 防止把别人的钱记到这笔单上 |
| 前端"支付成功"只是 UI 事件 | 收银台关闭 ≠ 钱到账 |
| 5 秒内先应答，再异步处理 | 超时微信会重发，慢处理会造成重复劳动 |
| 完整持久化微信侧交易号 | 覆盖写会导致后续对账串单 |
| 已取消订单收到支付成功 → 立即原路退款 | 否则就是一笔孤儿款 |

## 提现 / 商家转账：先冻结，见收据才落定

```
creating ──► waiting_confirm ──► SUCCESS        （落定：扣掉冻结）
                    │
                    ├──────────► FAIL/CANCELLED （释放：原额退回，refunded 幂等防双退）
                    └──────────► 一直挂在在途（绝不回滚，绝不换单重发）
```

- 发起前先冻结。**不要**等成功才扣——那时钱可能已经在用户零钱里了
- **明确失败**（4xx 参数/权限）→ 释放冻结，原额退回，`refunded` 标记防双退
- **结果不明**（网络错、5xx、验签失败）→ 保持冻结、保持挂起，交给兜底查单。
  这里回滚 = 用户可以凭同一笔余额再提一次
- **首次查单必须 ≥ 60 秒**。受理后 60 秒内查会假报"单据不存在"
- `out_bill_no` 只能数字+字母，不能带连字符
- 终态只有 `SUCCESS` / `FAIL` / `CANCELLED`；`WAIT_USER_CONFIRM` 不是失败，
  用户在微信里有 24 小时确认窗口
- "拉起确认页成功"的回调 ≠ 到账

## 像生产一样验证

用 mock provider 跑单测，对这类 bug 是无效的。必须做这三件：

1. **本地跑生产分支**：`NODE_ENV=production HOST=127.0.0.1 node index.js`，
   把所有 `IS_DEVELOPMENT` 分支翻过来——线上永远打不开的闸门只有这样才会暴露
2. **断言账本，不信响应体**：每步之后直读订单/用户记录里的
   `refundedAmountFen`、`refundPendingFen`、任务状态。错误响应通常不带你要核的对象
3. **证明线上跑的是你测的那份**：找一个只有新代码才有的行为（新路由返回 401 而不是 404），
   别信版本号（它可能忘了改）

## 文件

- `assets/refund-jobs.js` — 零依赖的持久退款任务参考实现
- `references/refund-state-machine.md` — 完整转移表与微信字段对照
- `references/idempotency-rules.md` — 四层幂等分别放在哪
- `references/payout-and-verification.md` — 提现、场景值、沙盒验证、上线检查清单
