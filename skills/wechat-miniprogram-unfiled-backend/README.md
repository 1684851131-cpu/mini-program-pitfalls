# 小程序 · 未备案后端连通方案

> 域名还没备案 / 真机连不上自建后端时，用云函数把请求送出去。
> Reach a self-hosted backend from a WeChat Mini Program **before** ICP filing lands.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## 问题 / The problem

小程序的 `wx.request` 只能请求**已备案的 HTTPS 域名**。备案没下来之前：

- 开发者工具正常（不校验域名）
- 真机永远"离线 / 连接不上服务器"
- 上传、登录、审核全部走不通

## 方案 / The approach

```
小程序 ──(wx.cloud.callFunction，微信私有通道)──► 云函数 ──HTTP──► 你的服务器 IP:端口
```

`wx.cloud.callFunction` 走微信私有通道，不受域名白名单与备案约束。云函数再用普通 HTTP 访问
你的服务器，所以**不需要域名，直接用 IP**。

三种传输通道：JSON 代理（普通接口）/ 云存储 `fileID`（照片、证件）/ CDN 标记（批量大图）。

## 快速开始 / Quick start

```bash
# 1. 拷云函数（零依赖，110 行）
cp assets/apiProxy.js  <your-project>/cloudfunctions/apiProxy/index.js

# 2. 部署（cloudbaserc.json 里填 envId）
tcb fn deploy apiProxy --force --dir cloudfunctions/apiProxy

# 3. 云函数环境变量
#    BACKEND_BASE = http://<SERVER_IP>:<PORT>
#    PROXY_KEY    = <随机长串>   ← 不配置会直接拒绝服务

# 4. 服务端加守门（见 SKILL.md 第 2 节，跳过 = 后端裸奔）

# 5. 客户端候选顺序：真机 = 云通道优先；开发工具 = 本机优先
```

## 目录 / Layout

```
SKILL.md                        英文主文档（agent 可直接加载）
SKILL.zh-CN.md                  中文完整版
assets/apiProxy.js              可直接部署的云函数（无密钥）
references/relay-design.md      设计推导与探测状态机
references/large-file-channels.md  三通道取舍、压缩阈值、云存储直传
references/pitfalls.md          症状 → 根因 → 修复
tests/apiProxy.test.js          16 项断言：转发、透传、路径守卫、fail-closed、超时
```

## 自测 / Test

```bash
node tests/apiProxy.test.js      # 期望 ALL PASS（含 20 秒超时用例）
```

## 适用边界 / Scope

**适合**：备案过渡期；已备案但需要兜底通道；真机需要提前验证完整链路。

**不适合**：替代备案；高并发业务网关；WebSocket（云函数不能保持连接）。

## 安全提示 / Security

- `PROXY_KEY` 必填，且**不要**在仓库里留默认值（历史上这类默认值导致过开放代理）
- 守门必须覆盖"浏览器拿不到凭据"的入口（静态页、图片、登录 POST），其余一律要密钥
- 中转只做传输，**不做鉴权**：身份头透传，授权仍必须在你后端做

## License

MIT
