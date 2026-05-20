# WebSocket 代理

Luker 提供了 WebSocket（WS）代理功能，通过持久的 WebSocket 隧道传输 AI 生成请求，替代传统的 HTTP 请求方式。这在网络不稳定或受限的环境中尤其有用。

## 什么是 WS 代理

在传统模式下，每次 AI 生成请求都是一个独立的 HTTP 请求。如果网络出现波动，请求可能中断，导致生成结果丢失。

WS 代理将这些请求通过一条**持久的 WebSocket 连接**进行传输。WebSocket 连接一旦建立，就会保持打开状态，所有的生成请求和响应都通过这条连接进行双向通信，无需反复建立新连接。

```d2
direction: down

HTTP: "传统 HTTP 模式：每次新连" {
  H_C1: "客户端"
  H_S1: "服务端"
  H_C2: "客户端"
  H_S2: "服务端"
  H_C3: "客户端"
  H_S3: "服务端"

  H_C1 -> H_S1: "新建 TCP+TLS"
  H_S1 -> H_C1: "响应+断开" {style.stroke-dash: 3}
  H_C2 -> H_S2: "新建 TCP+TLS"
  H_S2 -> H_C2: "响应+断开" {style.stroke-dash: 3}
  H_C3 -> H_S3: "新建 TCP+TLS"
}

WS: "WS 代理：持久隧道" {
  W_C: "客户端"
  W_S: "服务端"

  W_C <-> W_S: "建立一次 WS 连接"
  W_S <-> W_C: "心跳保活 + 多请求复用" {style.stroke-dash: 3}
}
```

简单来说：

- **传统 HTTP 模式**：每次生成 → 建立连接 → 发送请求 → 接收响应 → 关闭连接
- **WS 代理模式**：建立一次连接 → 所有生成请求复用这条连接 → 持续通信

## 为什么需要 WS 代理

### 网络不稳定环境

在移动网络、跨国网络或 Wi-Fi 信号较弱的环境中，HTTP 长连接容易因为短暂的网络波动而中断。WS 代理通过心跳保活和自动重连机制，能够更好地应对这些情况。

### 防火墙和代理限制

某些网络环境中，防火墙或企业代理可能会对长时间的 HTTP 连接进行超时断开。WebSocket 协议在建立连接后的通信方式不同于普通 HTTP，在部分场景下能够绕过这些限制。

### 流式生成的可靠性

AI 生成通常使用流式传输（SSE），一次生成可能持续数十秒。WS 代理为流式传输提供了更可靠的底层通道。

## 重连与恢复能力

WS 代理内置了多项健壮性机制：

### 心跳保活

连接建立后，客户端和服务端会定期交换心跳消息，确保连接处于活跃状态。如果一方长时间未收到心跳，会主动检测连接状态。

### 断线自动重连

当 WebSocket 连接意外断开时，客户端会自动尝试重新建立连接，无需用户手动干预。

### 流偏移恢复

如果在 AI 生成过程中连接短暂中断，WS 代理支持**流偏移恢复**——重连后从断点处继续接收生成内容，而不是从头开始。这意味着即使网络闪断，你也不会丢失已经生成的内容。

## 内部调度机制

WS 代理由两段构成：**升级阶段用一次性 ticket 完成鉴权**，**派发阶段用 `app.handle()` 直接调度 Express 路由**。这样请求依旧经过应用层中间件（cookie session、CSRF、登录检查），但 Basic Auth 这一层 HTTP 网关只在 ticket 签发时校验一次，WS 通道本身就是认证边界。

```d2
direction: down

LOGIN: "页面已登录\nbasicAuth + cookie session 已建立"
TICKET_REQ: "客户端 POST /api/ws-ticket\n(走完整 HTTP 中间件栈)"
TICKET_RESP: "服务端 mintTicket\n32 字节随机 hex,30s TTL,单次使用" {
  style.fill: "#fff3e0"
}
UP: "new WebSocket(url, [luker-ws-ticket.<ticket>])\nJS 把 ticket 塞进 Sec-WebSocket-Protocol"
GATE: "server.on('upgrade')\nparse 子协议 → consumeTicket" {
  style.fill: "#fff3e0"
}
WS_MSG: "WebSocket 消息\n通道已被信任"

DISPATCH: "派发链路" {
  GOOD_MOCK: "构造 mock req/res\n打上 WS_PROXY_AUTH_BYPASS Symbol"
  GOOD_HANDLE: "app.handle(req, res)"
  GOOD_BASIC: "Basic Auth 中间件\n检测到 Symbol → 直接放行"
  GOOD_REST: "cookieSession / CSRF /\nrequireLogin 正常执行"
  GOOD_RES: "流式 chunk 经 WS 隧道回传" {
    style.fill: "#e8f5e9"
  }
  GOOD_MOCK -> GOOD_HANDLE -> GOOD_BASIC -> GOOD_REST -> GOOD_RES
}

LOGIN -> TICKET_REQ -> TICKET_RESP -> UP -> GATE
GATE -> WS_MSG: "通过"
WS_MSG -> DISPATCH.GOOD_MOCK: "派发请求"
```

### 为什么用 ticket 而不是直接转 Authorization

浏览器原生 `WebSocket` 构造器**不允许 JS 设置任何 HTTP header**，只能依赖底层环境自动从 Basic Auth 缓存里附带——但 iOS Safari、WKWebView 套壳 app、frpc / cloudflared 之类的反向代理**在 WebSocket 升级时常常会剥掉 `Authorization` 头**，即便同源 HTTP 请求是有的。结果就是 WS upgrade 看似成功，后续派发却因为缺 `Authorization` 在 basicAuth 中间件 401。

`Sec-WebSocket-Protocol` 是 WS 协议自身的字段，JS 可以从 `new WebSocket(url, protocols)` 第二参数塞进去，反代和 WebView 都不会动它。所以：**ticket 走 HTTP（在那里 Authorization 是可靠的）发放，鉴权信号通过子协议进入 WS 通道**。绕开了"WebSocket 不能加 header"这个限制。

### 工作原理

1. **拿 ticket**：客户端 `POST /api/ws-ticket`，该端点挂在 `setupPrivateEndpoints` 里，过完整 HTTP 中间件栈（basicAuth + cookieSession + setUserData + requireLogin + CSRF）。服务端 `crypto.randomBytes(32)` 生成 64 字符 hex，存进进程内 `Map`，返回 `{ ticket }`。
2. **塞子协议**：客户端 `new WebSocket('/ws/proxy', [`luker-ws-ticket.${ticket}`])`。浏览器把它写进 `Sec-WebSocket-Protocol` 请求头。
3. **升级阶段验证**：服务端 `server.on('upgrade')` 从该头提取 ticket，调 `consumeTicket(ticket)`。校验通过同时**删除 entry**（单次使用）。失败：写 `HTTP/1.1 401`，关 socket。
4. **echo 子协议**:`wss.handleUpgrade` 内部调 `handleProtocols`，把同一个 `luker-ws-ticket.<ticket>` 字符串选回去，自动写到 101 响应头，握手完成。
5. **派发请求**：从 WS 消息提取 URL/方法/头/体，构造 mock `IncomingMessage`（Readable socket，`req.push()` 注入 body）。
6. **派发标记**：在 mock 请求上挂 `WS_PROXY_AUTH_BYPASS`（模块私有 Symbol，无法通过 header / query / body 伪造）。
7. **`app.handle(req, res)`**：进入 Express 中间件链——cookieSession 解析 cookie、CSRF 校验 token、setUserData 注入 `request.user`、requireLogin 校验登录态都正常运行；basicAuth 中间件读到 Symbol 后直接放行。
8. **响应回流**:mock `ServerResponse` 把 status/headers/chunk 经 WS 隧道返回给客户端。

### 安全边界

| 攻击面 | 现行 HTTP 路径 | ticket 方案 |
|---|---|---|
| 匿名 | basicAuth 拦 | `/api/ws-ticket` 被 basicAuth 拦，拿不到 ticket |
| 偷 cookie 单独 | basicAuth 拦（无 Auth 头） | `/api/ws-ticket` 被 basicAuth 拦，拿不到 ticket |
| 偷 basicAuth 单独 | requireLogin 拦（无 session） | `/api/ws-ticket` 被 requireLogin 拦，拿不到 ticket |
| 两者都偷 | 全套通过 | 全套通过（无新增攻击面） |
| ticket 中间人窃听 | N/A | 30s TTL + 单次使用，HTTPS 路径下基本不可行 |
| ticket 重放 | N/A | 单次使用，服务端在 consume 时立即删除 |

- **ticket 不绑用户身份**，只授权"通道接入"。派发请求的用户身份完全由 cookie session 决定（`setUserDataMiddleware` + `requireLoginMiddleware` 在派发链路上每次都跑）。即便 ticket 被偷，攻击者还是要用自己的 cookie 才能派发，得不到任何越权能力。
- **Symbol 不可伪造**:`WS_PROXY_AUTH_BYPASS` 是模块内部的 Symbol；任何 header、query、body 字段都无法在 `request` 对象上设置同名 Symbol 属性。
- **应用层中间件照常生效**:cookieSession、CSRF、setUserData、requireLogin 在派发时全部运行，未登录或缺少 CSRF token 的请求依然会被拒绝。

### 连接健壮性

- **心跳保活**：客户端和服务端定期交换心跳消息，防止中间网络设备因空闲超时断开连接
- **流偏移恢复**：生成过程中如果连接短暂中断，重连后可以从断点继续接收内容
- **作业清理**：使用 `lastActivity` 时间戳检测过期作业，而非 `createdAt`，确保活跃中的长生成不会被误清理
- **重连重新发 ticket**：每次断线重连时客户端会先 `POST /api/ws-ticket` 拿新 ticket，旧 ticket 已经被消费掉，无法重用。


## 使用场景

以下场景特别适合使用 WS 代理：

- **移动设备使用** — 手机网络切换（Wi-Fi ↔ 蜂窝）时保持生成不中断
- **远程服务器部署** — Luker 部署在远程服务器上，通过不稳定的网络访问
- **长文本生成** — 生成较长的回复时，减少因超时导致的失败
- **企业网络环境** — 绕过可能干扰长连接的网络设备

::: tip
WS 代理是 Luker 的内部传输优化，对用户来说是透明的——你不需要进行额外配置，Luker 会在适当的时候自动使用。
:::

## 相关页面

- [性能优化](/zh-CN/improvements/performance) — 其他性能改进
- [生成层](/zh-CN/improvements/generation-layer) — Luker 的统一生成架构
