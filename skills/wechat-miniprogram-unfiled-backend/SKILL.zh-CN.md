---
name: wechat-miniprogram-unfiled-backend
description: 小程序后端域名未备案时的连通方案（云函数中转）。
version: 1.0.0
author: open-source
license: MIT
metadata:
  hermes:
    tags: [wechat, miniprogram, cloudbase, proxy, icp, networking]
---

# 域名备案前，让小程序连上自建后端

微信小程序的 `wx.request` 只能打**已备案的 HTTPS 域名**（后台「request 合法域名」）。
备案没下来之前，真机完全连不上你自己的服务器：开发者工具正常（它不校验域名），
手机上永远是"离线 / 连接不上服务器"。

本方案让流量走云函数：`wx.cloud.callFunction` 走**微信私有通道**，不受域名白名单与备案约束，
云函数再用普通 HTTP 去访问你的服务器（可以直接用 IP，不经过域名）。

> 这是**过渡桥，不是替代品**。备案该做还要做。桥保留下来当兜底通道——已备案域名也会遇到
> DNS、SNI、CDN 故障，这条通道照样能用。

## 什么时候用

- 小程序 + 自建后端（Node/Java/Python，跑在 nginx、进程管理器或裸端口上都一样）+ 域名还没备案
- 真机一直"连接不上服务器"、`ERR_CONNECTION_REFUSED`，开发者工具却一切正常
- 备案完成前就需要真机验证：下单、上传照片、审核员扫码
- 给已备案域名留一条备用通道（主域名被拦/限流/配置错时自动切）

**不要**用它：替代备案、扛高并发业务流量、或者当 WebSocket 用（云函数不能保持连接）。

## 架构

```
小程序 ──(wx.cloud.callFunction，微信私有通道)──► 云函数 ──HTTP──► 你的服务器 IP:端口
```

三种传输通道，按数据量选：

| 通道 | 客户端发什么 | 上限 | 用途 |
|---|---|---|---|
| JSON 代理 | `{path, method, data, headers}` | 单次约 1MB（callFunction 限制） | 普通接口 |
| 云存储 `fileID` | `wx.cloud.uploadFile` → `cloud://…` | 不受 callFunction 限制 | 照片、证件、凭证 |
| CDN 标记 `fileCdn` | `wx.cloud.CDN({type:'filePath'})` | 大文件 | 批量图片 |

## 落地四步

### 1. 云函数（零依赖）

直接拷 `assets/apiProxy.js`（约 110 行，只用 Node 内置 `http/https`，不用 `npm install`）：

- 入参 `{path, method, data, headers}`；`path` 必须 `startsWith('/api/')` 且不含 `..`，否则 `BAD_PATH`
- 转发时注入 `x-proxy-key`（与服务端共享的密钥），透传调用方的身份头
- 返回 `{ok, status, ct, json, size}`；上游超时 20 秒
- 环境变量：`BACKEND_BASE`（`http://<服务器IP>:<端口>`，**故意不用域名**）、`PROXY_KEY`

```bash
tcb fn deploy apiProxy --force --dir cloudfunctions/apiProxy   # cloudbaserc.json 里填 envId
```

刚创建就部署可能返回 `Creating`，等 25 秒重试。

> `PROXY_KEY` 未配置时**直接拒绝服务**（fail-closed）。不要留默认密钥串——仓库里出现过一次，
> 就等于把守门钥匙公开了。

### 2. 服务端守门（跳过这步等于把后端裸奔在公网）

为了云函数够得着，端口必须对公网放行；放行之后所有人都够得着。所以非本机请求一律校验：

```js
const remote = String((req.socket && req.socket.remoteAddress) || '');
const isLocal = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';

// 天然没有凭据的入口（浏览器、<img>、还没拿到 token 的登录请求）
const openPath =
     pathname === '/api/health' || pathname === '/' || pathname === '/index.html'
  || pathname === '/admin' || pathname === '/admin.html'
  || pathname === '/api/admin/login'        // ← 登录此刻没有凭据，挡了就等于后台永不能登录
  || pathname.startsWith('/uploads/')
  || (pathname.startsWith('/api/') && !pathname.startsWith('/api/admin/'))  // 应用接口：自带 uid/token 鉴权
  || pathname.startsWith('/api/admin/mobile/');                             // 手机版后台：自带白名单

const proxyOk = req.headers['x-proxy-key'] === PROXY_KEY;
if (!isLocal && !openPath && !proxyOk && !adminKeyOk(req)) {
  return fail(res, 403, 'PROXY_KEY_REQUIRED');
}
```

两条用事故换来的规则：

- **放行清单必须覆盖整个应用接口面**，不能只列管理接口。只放开"管理通道"的后果：
  手机号验证、图片上传、审核提交全部静默 403，而开发者工具里一切正常（它就是本机）——
  用户感知是"手机端功能时好时坏"。
- **`/api/admin/login` 必须放行**。浏览器此刻还没有任何凭据；被门挡住后前端把它显示成
  "密钥错误，请重试"，用户输对密钥也永远进不去后台。

### 3. 客户端：探测顺序要按平台分叉

```ts
const candidates = isDevTool
  ? [LAN_OR_LOCALHOST, PROD_DOMAIN, 'cloud://proxy']   // 开发工具：本机优先
  : ['cloud://proxy', PROD_DOMAIN, LAN_OR_LOCALHOST];  // 真机：云通道优先
```

- 解析成功后持久化；网络级失败时清掉重新探测
- **`cloud.init` 必须懒加载真调用**：真机不会像开发者工具那样自动注入默认云环境，
  没 `init({env})` 整条通道失效；而开发者工具会替你补，所以永远测不出来。
  首次取用时 `try/catch` 里 init，**不要**放在 app 启动时（启动即 init 会触发 `-80001`）。
- `init` 必须是真调用。只有 `cloudInited = true` 标志位、没有实际调用 = 静默失效
  （去 grep `cloud.init` 本身，别 grep 标志位）
- 代理分支的状态码/错误码判定要和直连分支**逐条对齐**（401/403/业务码一个不漏），
  只处理 200 的代理会把鉴权失败变成"没有数据"
- 探活端点要选**不在放行清单里**的路径（如 `GET /api/schools`）。
  用 `/api/health` 探活没有意义：它本身放行，探测通过 ≠ 真实请求能过，
  手机会据此认定直连可用，随后所有接口 403
- 界面上显示当前走的通道（"云函数中转"），测试时一眼能看出这包用的哪条路

### 4. 回退开关

`CLOUD_ENV_ID` 留空 → 云通道压根不会被探测，客户端行为与没做过这个功能完全一致。
服务端守门保持无条件：它只影响非本机流量，nginx、浏览器后台、开发者工具链路零改动。

## 上线前验证

```bash
# ① 云函数单独跑（打本地服务，验证转发/头部/错误分支）
BACKEND_BASE=http://127.0.0.1:3000 node -e "
const fn=require('./apiProxy.js');
(async()=>{ console.log(await fn.main({path:'/api/health',method:'GET'}));
           console.log(await fn.main({path:'/api/../etc',method:'GET'})); })();"
# 期望：正常 JSON，然后 BAD_PATH
```

守门矩阵——每条都用一个**非本机地址**（用局域网 IP 冒充"外部"）跑一遍：

| 请求 | 期望 |
|---|---|
| `GET /` | 200（静态页） |
| `GET /api/admin/config` 无凭据 | 403 |
| `POST /api/admin/login` 正确密钥 | 200 + token（**不是** 403） |
| `GET /api/schools` 无凭据 | 200（应用接口放行，自带鉴权） |
| `GET /api/admin/users` 无凭据 | 403 |
| 同上带 `x-proxy-key` | 200 |

最后**真机**复测（模拟器证明不了任何一条）：首屏能出、上传一张照片、手机上打开后台页。

## 坑（症状 → 根因）

- 真机"连接不上服务器" → `cloud.init` 从没被调用；开发者工具替你兜了底
- 时好时坏、登录能过但手机号/上传全灭 → 探活用了放行路径，探测结论是假的
- 后台一直提示"密钥错误" → `/api/admin/login` 被守门挡了
- 上传接口超时 → 云函数超时还是默认 3 秒，去控制台改 20 秒
- 真机图片空白、日志 `http not supported` → `<Image>` 不接受 http；用户图必须走云存储 `cloud://`
- `tcb` 报 `ECONNREFUSED 127.0.0.1:7897` → 本机代理残留，先 `unset HTTP_PROXY HTTPS_PROXY ALL_PROXY`
- 云环境是按 appid 隔离的，借不了别人的

## 文件

- `assets/apiProxy.js` — 可直接部署的云函数（无密钥、全部走环境变量）
- `references/relay-design.md` — 完整设计与守门推导
- `references/large-file-channels.md` — 三通道取舍与压缩阈值
- `references/pitfalls.md` — 按"症状 → 根因 → 修复"组织的排障表
