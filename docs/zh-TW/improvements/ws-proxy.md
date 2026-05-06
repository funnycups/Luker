# WebSocket 代理

Luker 提供了 WebSocket（WS）代理功能，透過持久的 WebSocket 隧道傳輸 AI 生成請求，替代傳統的 HTTP 請求方式。這在網路不穩定或受限的環境中尤其有用。

## 什麼是 WS 代理

在傳統模式下，每次 AI 生成請求都是一個獨立的 HTTP 請求。如果網路出現波動，請求可能中斷，導致生成結果遺失。

WS 代理將這些請求透過一條**持久的 WebSocket 連線**進行傳輸。WebSocket 連線一旦建立，就會保持開啟狀態，所有的生成請求和回應都透過這條連線進行雙向通訊，無需反覆建立新連線。

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

WS 代理的伺服器端在轉發生成請求時，使用 `app.handle()` 直接調度 Express 路由，而非透過 HTTP 自請求存取 localhost。這樣請求依然會經過應用層中介軟體（cookie session、CSRF、登入檢查），但 Basic Auth 這層 HTTP 閘道會在 WS 升級階段一次性完成驗證，派發時不再重複挑戰。

### 工作原理

1. **升級階段鑑權**：當啟用 Basic Auth 時，`server.on('upgrade')` 複用 `tryBasicAuth(req)` 驗證 `Authorization` 標頭。驗證失敗立即寫入 401（帶 `WWW-Authenticate`）並關閉 socket，瀏覽器會回退到 HTTP 走原本的 Basic Auth 流程。
2. **派發請求**：從 WS 訊息提取 URL/方法/標頭/主體，構造 mock `IncomingMessage`（Readable socket，`req.push()` 注入 body）。
3. **派發標記**：在 mock 請求上掛 `WS_PROXY_AUTH_BYPASS`（Symbol，無法透過 header 或 query 偽造），表示此請求已透過 WS 通道鑑權。
4. **`app.handle(req, res)`**：進入 Express 中介軟體鏈——cookieSession 解析 cookie、CSRF 校驗 token、requireLogin 校驗登入狀態都正常運行；basicAuth 中介軟體讀到 Symbol 後直接放行。
5. **回應回流**：mock `ServerResponse` 把 status/headers/chunk 經 WS 隧道回傳給用戶端。

### 為什麼不用 self-fetch

透過 localhost HTTP 自請求會再走一遍完整的 HTTP 接入棧，等於讓 Basic Auth 中介軟體再要一次 `Authorization` 標頭——而 WS 用戶端在瀏覽器/WebView/隧道裡 **常常無法在升級階段附帶這個標頭**（iOS Safari 與套殼 WebView、frpc/cloudflared 之類的反向代理在 WebSocket 升級時會剝掉 `Authorization`），結果就是 401。所以鑑權放在 WS 升級階段集中校驗、派發時跳過重複挑戰，讓 WS 通道本身成為認證邊界。

### 安全邊界

- **WS 升級仍然受 Basic Auth 保護**：升級前需要通過 `tryBasicAuth` 驗證，未配置 Basic Auth 時則跳過這一層。
- **Symbol 不可偽造**：`WS_PROXY_AUTH_BYPASS` 是模組內部的 Symbol；任何 header、query、body 欄位都無法在 `request` 物件上設定同名 Symbol 屬性。
- **應用層中介軟體照常生效**：cookieSession、CSRF、requireLogin 在派發時全部運行，未登入或缺少 CSRF token 的請求依然會被拒絕。

### 連線健壯性

- **心跳保活**：用戶端和伺服器端定期交換心跳訊息，防止中間網路裝置因空閒逾時斷開連線
- **串流偏移恢復**：生成過程中如果連線短暫中斷，重連後可以從斷點繼續接收內容
- **作業清理**：使用 `lastActivity` 時間戳檢測過期作業，而非 `createdAt`，確保活躍中的長生成不會被誤清理

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
