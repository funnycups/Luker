# WebSocket 代理

Luker 提供了 WebSocket（WS）代理功能，透過持久的 WebSocket 隧道傳輸 AI 生成請求，替代傳統的 HTTP 請求方式。這在網路不穩定或受限的環境中尤其有用。

## 什麼是 WS 代理

在傳統模式下，每次 AI 生成請求都是一個獨立的 HTTP 請求。如果網路出現波動，請求可能中斷，導致生成結果遺失。

WS 代理將這些請求透過一條**持久的 WebSocket 連線**進行傳輸。WebSocket 連線一旦建立，就會保持開啟狀態，所有的生成請求和回應都透過這條連線進行雙向通訊，無需反覆建立新連線。

```d2
direction: down

HTTP: "傳統 HTTP 模式：每次新連" {
  H_C1: "用戶端"
  H_S1: "伺服器端"
  H_C2: "用戶端"
  H_S2: "伺服器端"
  H_C3: "用戶端"
  H_S3: "伺服器端"

  H_C1 -> H_S1: "新建 TCP+TLS"
  H_S1 -> H_C1: "回應+斷開" {style.stroke-dash: 3}
  H_C2 -> H_S2: "新建 TCP+TLS"
  H_S2 -> H_C2: "回應+斷開" {style.stroke-dash: 3}
  H_C3 -> H_S3: "新建 TCP+TLS"
}

WS: "WS 代理：持久隧道" {
  W_C: "用戶端"
  W_S: "伺服器端"

  W_C <-> W_S: "建立一次 WS 連線"
  W_S <-> W_C: "心跳保活 + 多請求複用" {style.stroke-dash: 3}
}
```

簡單來說：

- **傳統 HTTP 模式**：每次生成 → 建立連線 → 發送請求 → 接收回應 → 關閉連線
- **WS 代理模式**：建立一次連線 → 所有生成請求複用這條連線 → 持續通訊

## 為什麼需要 WS 代理

### 網路不穩定環境

在行動網路、跨國網路或 Wi-Fi 訊號較弱的環境中，HTTP 長連線容易因為短暫的網路波動而中斷。WS 代理透過心跳保活和自動重連機制，能夠更好地應對這些情況。

### 防火牆和代理限制

某些網路環境中，防火牆或企業代理可能會對長時間的 HTTP 連線進行逾時斷開。WebSocket 協定在建立連線後的通訊方式不同於普通 HTTP，在部分場景下能夠繞過這些限制。

### 串流生成的可靠性

AI 生成通常使用串流傳輸（SSE），一次生成可能持續數十秒。WS 代理為串流傳輸提供了更可靠的底層通道。

## 重連與恢復能力

WS 代理內建了多項健壯性機制：

### 心跳保活

連線建立後，用戶端和伺服器端會定期交換心跳訊息，確保連線處於活躍狀態。如果一方長時間未收到心跳，會主動檢測連線狀態。

### 斷線自動重連

當 WebSocket 連線意外斷開時，用戶端會自動嘗試重新建立連線，無需使用者手動干預。

### 串流偏移恢復

如果在 AI 生成過程中連線短暫中斷，WS 代理支援**串流偏移恢復**——重連後從斷點處繼續接收生成內容，而不是從頭開始。這意味著即使網路閃斷，你也不會遺失已經生成的內容。

## 內部調度機制

WS 代理由兩段構成:**升級階段用一次性 ticket 完成鑑權**,**派發階段用 `app.handle()` 直接調度 Express 路由**。這樣請求依然會經過應用層中介軟體(cookie session、CSRF、登入檢查),但 Basic Auth 這層 HTTP 閘道只在 ticket 簽發時校驗一次,WS 通道本身就是認證邊界。

```d2
direction: down

LOGIN: "頁面已登入\nbasicAuth + cookie session 已建立"
TICKET_REQ: "用戶端 POST /api/ws-ticket\n(走完整 HTTP 中介軟體棧)"
TICKET_RESP: "伺服器端 mintTicket\n32 位元組隨機 hex,30s TTL,單次使用" {
  style.fill: "#fff3e0"
}
UP: "new WebSocket(url, [luker-ws-ticket.<ticket>])\nJS 把 ticket 塞進 Sec-WebSocket-Protocol"
GATE: "server.on('upgrade')\nparse 子協議 → consumeTicket" {
  style.fill: "#fff3e0"
}
WS_MSG: "WebSocket 訊息\n通道已被信任"

DISPATCH: "派發鏈路" {
  GOOD_MOCK: "構造 mock req/res\n打上 WS_PROXY_AUTH_BYPASS Symbol"
  GOOD_HANDLE: "app.handle(req, res)"
  GOOD_BASIC: "Basic Auth 中介軟體\n偵測到 Symbol → 直接放行"
  GOOD_REST: "cookieSession / CSRF /\nrequireLogin 正常執行"
  GOOD_RES: "串流 chunk 經 WS 隧道回傳" {
    style.fill: "#e8f5e9"
  }
  GOOD_MOCK -> GOOD_HANDLE -> GOOD_BASIC -> GOOD_REST -> GOOD_RES
}

LOGIN -> TICKET_REQ -> TICKET_RESP -> UP -> GATE
GATE -> WS_MSG: "通過"
WS_MSG -> DISPATCH.GOOD_MOCK: "派發請求"
```

### 為什麼用 ticket 而不是直接轉 Authorization

瀏覽器原生 `WebSocket` 建構器**不允許 JS 設定任何 HTTP header**,只能依賴底層環境自動從 Basic Auth 快取裡附帶——但 iOS Safari、WKWebView 套殼 app、frpc / cloudflared 之類的反向代理**在 WebSocket 升級時常常會剝掉 `Authorization` 標頭**,即便同源 HTTP 請求是有的。結果就是 WS upgrade 看似成功,後續派發卻因為缺 `Authorization` 在 basicAuth 中介軟體 401。

`Sec-WebSocket-Protocol` 是 WS 協議自身的欄位,JS 可以從 `new WebSocket(url, protocols)` 第二參數塞進去,反代和 WebView 都不會動它。所以:**ticket 走 HTTP(在那裡 Authorization 是可靠的)發放,鑑權訊號透過子協議進入 WS 通道**。繞開了「WebSocket 不能加 header」這個限制。

### 工作原理

1. **拿 ticket**:用戶端 `POST /api/ws-ticket`,該端點掛在 `setupPrivateEndpoints` 裡,過完整 HTTP 中介軟體棧(basicAuth + cookieSession + setUserData + requireLogin + CSRF)。伺服器端 `crypto.randomBytes(32)` 生成 64 字元 hex,存進行程內 `Map`,回傳 `{ ticket }`。
2. **塞子協議**:用戶端 `new WebSocket('/ws/proxy', [`luker-ws-ticket.${ticket}`])`。瀏覽器把它寫進 `Sec-WebSocket-Protocol` 請求標頭。
3. **升級階段驗證**:伺服器端 `server.on('upgrade')` 從該標頭提取 ticket,呼叫 `consumeTicket(ticket)`。校驗通過同時**刪除 entry**(單次使用)。失敗:寫 `HTTP/1.1 401`,關 socket。
4. **echo 子協議**:`wss.handleUpgrade` 內部呼叫 `handleProtocols`,把同一個 `luker-ws-ticket.<ticket>` 字串選回去,自動寫到 101 回應標頭,握手完成。
5. **派發請求**:從 WS 訊息提取 URL/方法/標頭/主體,構造 mock `IncomingMessage`(Readable socket,`req.push()` 注入 body)。
6. **派發標記**:在 mock 請求上掛 `WS_PROXY_AUTH_BYPASS`(模組私有 Symbol,無法透過 header / query / body 偽造)。
7. **`app.handle(req, res)`**:進入 Express 中介軟體鏈——cookieSession 解析 cookie、CSRF 校驗 token、setUserData 注入 `request.user`、requireLogin 校驗登入狀態都正常運行;basicAuth 中介軟體讀到 Symbol 後直接放行。
8. **回應回流**:mock `ServerResponse` 把 status/headers/chunk 經 WS 隧道回傳給用戶端。

### 安全邊界

| 攻擊面 | 現行 HTTP 路徑 | ticket 方案 |
|---|---|---|
| 匿名 | basicAuth 攔 | `/api/ws-ticket` 被 basicAuth 攔,拿不到 ticket |
| 偷 cookie 單獨 | basicAuth 攔(無 Auth 標頭) | `/api/ws-ticket` 被 basicAuth 攔,拿不到 ticket |
| 偷 basicAuth 單獨 | requireLogin 攔(無 session) | `/api/ws-ticket` 被 requireLogin 攔,拿不到 ticket |
| 兩者都偷 | 全套通過 | 全套通過(無新增攻擊面) |
| ticket 中間人竊聽 | N/A | 30s TTL + 單次使用,HTTPS 路徑下基本不可行 |
| ticket 重放 | N/A | 單次使用,伺服器端在 consume 時立即刪除 |

- **ticket 不綁用戶身份**,只授權「通道接入」。派發請求的用戶身份完全由 cookie session 決定(`setUserDataMiddleware` + `requireLoginMiddleware` 在派發鏈路上每次都跑)。即便 ticket 被偷,攻擊者還是要用自己的 cookie 才能派發,得不到任何越權能力。
- **Symbol 不可偽造**:`WS_PROXY_AUTH_BYPASS` 是模組內部的 Symbol;任何 header、query、body 欄位都無法在 `request` 物件上設定同名 Symbol 屬性。
- **應用層中介軟體照常生效**:cookieSession、CSRF、setUserData、requireLogin 在派發時全部運行,未登入或缺少 CSRF token 的請求依然會被拒絕。

### 連線健壯性

- **心跳保活**:用戶端和伺服器端定期交換心跳訊息,防止中間網路裝置因空閒逾時斷開連線
- **串流偏移恢復**:生成過程中如果連線短暫中斷,重連後可以從斷點繼續接收內容
- **作業清理**:使用 `lastActivity` 時間戳檢測過期作業,而非 `createdAt`,確保活躍中的長生成不會被誤清理
- **重連重新發 ticket**:每次斷線重連時用戶端會先 `POST /api/ws-ticket` 拿新 ticket,舊 ticket 已經被消費掉,無法重用。


## 使用場景

以下場景特別適合使用 WS 代理：

- **行動裝置使用** — 手機網路切換（Wi-Fi ↔ 行動數據）時保持生成不中斷
- **遠端伺服器部署** — Luker 部署在遠端伺服器上，透過不穩定的網路存取
- **長文字生成** — 生成較長的回覆時，減少因逾時導致的失敗
- **企業網路環境** — 繞過可能干擾長連線的網路設備

::: tip
WS 代理是 Luker 的內部傳輸最佳化，對使用者來說是透明的——你不需要進行額外設定，Luker 會在適當的時候自動使用。
:::

## 相關頁面

- [效能最佳化](/zh-TW/improvements/performance) — 其他效能改進
- [生成層](/zh-TW/improvements/generation-layer) — Luker 的統一生成架構
