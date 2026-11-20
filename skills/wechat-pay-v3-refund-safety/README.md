# 微信支付 V3 · 退款与提现的资金安全实现

> 钱的终态只认收据，不认返回值。
> Money is settled by the receipt, never by the return value.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## 这个 skill 解决什么 / What it solves

写退款最容易犯的两个错：

1. 把"接口返回 200 / 受理成功"当成"钱已退回" → 账本虚报，用户没收到钱系统显示已退
2. 重试时换了 `out_refund_no` → **真的退了两笔**

这份文档把状态机、幂等分层、重试纪律、上线检查清单固定下来，并附一份零依赖的参考实现。

## 核心结论（先看这五条）

| # | 规则 | 违反的后果 |
|---|---|---|
| 1 | HTTP 200 只代表受理，结算只认收据 | 虚报退款 |
| 2 | 在途金额单独记（`pending`），不并入已退 | 账本永远不准 |
| 3 | 收据核四要素 + `refund_id` | 别人的回调能结算你的单 |
| 4 | 先查后重试，只有 404 才允许重发 | 重复退款 |
| 5 | 重试永远用原单号 | 重复退款（最贵的一种） |

## 目录 / Layout

```
SKILL.md                            英文主文档
SKILL.zh-CN.md                      中文完整版
assets/refund-jobs.js               零依赖持久退款任务（可直接参考/改造）
references/refund-state-machine.md  状态转移表 + 微信字段对照
references/idempotency-rules.md     四层幂等分别放在哪
references/payout-and-verification.md  提现、场景值、沙盒验证、20 项上线清单
tests/refund-jobs.test.js           20 项断言：幂等、预留、不重复提交、收据核对、人工复核
```

## 自测 / Test

```bash
node tests/refund-jobs.test.js   # 期望 ALL PASS（纯逻辑，不联网）
```

## 快速接入 / Quick start

```js
const { requestRefund, processRefundJobs } = require('./refund-jobs');

// 1) 业务要退款：只建任务，不直连微信
requestRefund(db, order, amountFen, 'Cancelled before fulfillment', 'cancel-timeout', false);
save();

// 2) 定时驱动（或每次写操作后）：它负责查单、重试、结算
setInterval(() => processRefundJobs(db, wxpay, getPayConfig, save), 15_000);

// 3) 回调：验签 → 解密 → 核归属 → applyProviderResult()
```

## 适用边界 / Scope

**适合**：任何接微信支付 V3 的 Node/Java/Python 后端；单进程 JSON 库或 MySQL 都适用
（`assets/refund-jobs.js` 是与存储无关的纯逻辑）。

**不适用**：V2 接口、跨境支付、分账出资退款（分账订单退款不从分账方扣回，需单独设计）。

## 安全提示 / Security

- 商户私钥、APIv3 密钥只放服务端，从环境变量/KMS 读，**永不进仓库、日志、接口响应**
- 验签失败一律中止，不记日志继续执行
- 金额全程整数分，中间任何一步用浮点，精度就已经丢了
- 关键字段（金额、商户号、用户标识）一律以后端数据为准，不信前端传值

## 与官方文档的关系 / vs. official docs

官方「开发接入检查用例」列了 40+ 条判定项，但它是**给人读的文档**；
这里把它变成**可执行的状态机 + 可复制的代码 + 上线勾选表**，并补上官方没写的部分：
两种运行时的落地差异、单进程 JSON 库怎么做到原子结算、崩溃后如何收敛。

## License

MIT
