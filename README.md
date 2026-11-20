# Common Pitfalls for Early-Stage Mini-Program Development

> 早期小程序开发的常见坑 + 上线前清单。
> Three agent skills distilled from two real mini-program launches — one on a serverless platform,
> one on a self-hosted Node process. Same pitfalls on both, so only the overlapping lessons survived.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## 三个 skill / Three skills

| Skill | 解决什么 | 什么时候加载 |
|---|---|---|
| [`mini-program-pitfalls`](skills/mini-program-pitfalls/) | 25 个分层坑 + **上线前清单（40 项）** | 准备上线 / 交接体检 / 事故复盘 |
| [`wechat-miniprogram-unfiled-backend`](skills/wechat-miniprogram-unfiled-backend/) | 域名没备案，真机连不上自建后端 | 真机离线、免备案隧道、大图上传 |
| [`wechat-pay-v3-refund-safety`](skills/wechat-pay-v3-refund-safety/) | 退款/提现的幂等与收据核对 | 退款状态机、重复出款、提现冻结 |

**建议加载顺序**：先 `mini-program-pitfalls`（建立全局图和验收标准），撞到具体问题时再进另外两个。

### 为什么是三个包 / Why three packages

触发场景正交：一个管"该检查什么"，一个管"连不上"，一个管"钱算错"。
塞进一个包会有三个问题：description 只有 60 字符检索位、加载时上下文互相污染、改一个场景动到另一个。

所以：**`skills/` 下三个独立 skill，仓库只有一个**。
装一次全装，用的时候各按各的触发加载。

## 安装 / Install

```bash
# macOS / Linux / git-bash
bash install.sh
# 指定目录
bash install.sh /path/to/skills
```

```powershell
# Windows PowerShell
.\install.ps1
# 指定目录
.\install.ps1 -Dest "D:\HermesData\skills"
```

脚本会：探测默认 skills 目录 → 已存在同名目录先备份成 `.bak-<时间戳>` → 复制三个包 → 打印落点。
不覆盖、不静默：出问题可以从备份目录原样退回。

手动安装就是把 `skills/` 下的三个目录整个复制到你的 skills 目录。

## 结构 / Layout

```
.
├── README.md                  ← 你在这里
├── LICENSE
├── install.sh                 安装（bash）
├── install.ps1                安装（PowerShell）
└── skills/
    ├── mini-program-pitfalls/          ← 入口：25 个坑 + 上线清单
    │   ├── SKILL.md                   英文主文档（agent 加载这个）
    │   ├── SKILL.zh-CN.md             中文完整版
    │   ├── README.md                  包内说明
    │   └── references/launch-checklist.md   40 项可打印清单
    ├── wechat-miniprogram-unfiled-backend/
    │   ├── SKILL.md / SKILL.zh-CN.md
    │   ├── README.md
    │   ├── assets/apiProxy.js         可直接部署的云函数
    │   ├── references/                设计、通道取舍、排障表
    │   └── tests/                     16 项断言
    └── wechat-pay-v3-refund-safety/
        ├── SKILL.md / SKILL.zh-CN.md
        ├── README.md
        ├── assets/refund-jobs.js
        ├── references/                状态机、幂等、提现与验证
        └── tests/                     20 项断言
```

## 上线前清单 / Launch checklist

[`skills/mini-program-pitfalls/references/launch-checklist.md`](skills/mini-program-pitfalls/references/launch-checklist.md)
—— 40 项，分 6 组（资质 / 后端数据 / 资金 / 前端真机 / 发布回退 / 上线后 24h），
每项带**怎么验证**和**通过标准**。

只有一小时就验这六项：

1. 支付回调公网可达且不被缓存
2. 回调只结算一次（重放不重复入账）
3. 回调核对归属（订单号 / 金额 / 商户号 / AppID）
4. 定时兜底真的在跑（看日志，不看配置）
5. 真机用移动流量跑通全链路
6. 部署探针证明线上跑的是新代码

## 自测 / Test

```bash
cd skills/wechat-miniprogram-unfiled-backend && node tests/apiProxy.test.js   # 16 断言
cd skills/wechat-pay-v3-refund-safety     && node tests/refund-jobs.test.js   # 20 断言
```

两个都无第三方依赖，`node` 直接跑，不联网（中转测试会起本地回环服务）。

## 内容边界 / Scope

- 不含任何真实服务器地址、密钥、商户号、AppID
- 不含任何具体项目、品牌或商品信息
- 所有示例值是占位符或假值（`<SERVER_IP>`、`<PORT>`、`test-secret`）

## License

MIT
