# 統一生成層

統一生成層（Unified Generation Layer）是 Luker 引入的後端架構改進，將分散在各個 API 端點中的生成邏輯收斂到一個共享模組中，實現多後端的統一封裝。

## 問題背景

在 SillyTavern 中，不同的 AI 後端（OpenAI、Anthropic、Google、Kobold 等）各自擁有獨立的程式碼路徑。每個後端端點檔案獨立處理請求建構、串流回應解析、錯誤處理等邏輯。這導致了以下問題：

- **重複程式碼** — 相似的串流處理、錯誤重試邏輯在多個檔案中重複實作
- **不一致的行為** — 不同後端的 Token 統計、錯誤回應格式各不相同
- **難以擴充** — 新增後端需要從頭實作完整的請求/回應處理鏈
- **無法統一計量** — 缺少跨後端的 Token 用量追蹤能力

## 解決方案

Luker 新增了統一生成層端點（`/api/backends/luker-generation`），作為前端發起 AI 生成請求的主要路徑。該端點接收前端的生成請求，根據當前的 Chat Completion Source 轉發到對應的上游 API，並在統一的處理管線中完成串流回應、Token 計量、生成確認和持久化。

### 多後端統一封裝

統一生成層支援以下後端的統一處理：

- **OpenAI** 及其相容 API
- **Anthropic**（Claude）
- **Google**（Gemini / Vertex AI）
- **Kobold** / **TabbyAPI**
- 其他 Chat Completion 相容後端

前端透過統一生成層發起生成請求，由該端點負責路由到正確的上游服務，而非前端直接呼叫各個後端的獨立端點。各個後端的獨立端點（`chat-completions.js`、`kobold.js` 等）仍然存在並獨立整合了請求檢查器，但統一生成層提供了更完整的處理管線。

### 共享 Token 計量

統一生成層在生成請求的前後自動呼叫[請求檢查器](/zh-TW/improvements/request-inspector)：

1. 串流傳輸完成後呼叫 `completeInspectionFromStream` 從串流事件中記錄 Token 用量
2. 生成失敗時呼叫 `failInspection` 記錄錯誤資訊
3. 生成中止時呼叫 `abortInspection` 記錄中斷

注意：`startInspection` 由後端端點（如 `chat-completions.js`）呼叫，而非由生成層本身呼叫。

這確保了無論使用哪個後端，Token 消耗都能被準確追蹤。

### 統一串流處理

對於 SSE 串流回應，統一生成層提供共享的串流解析邏輯：

- 解析不同後端的 SSE 事件格式
- 從串流事件中提取 Token 用量資訊
- 統一的串流中斷和恢復處理
- 與 [WebSocket 代理](/zh-TW/improvements/ws-proxy)配合支援串流偏移恢復

### 統一錯誤處理

不同後端回傳的錯誤格式各異，統一生成層將它們規範化為一致的錯誤回應結構，簡化前端的錯誤處理邏輯。

## 架構關係

```d2
direction: down

FE: "前端發起 AI 生成請求"
EP: "各後端端點檔案\nchat-completions.js / kobold.js / ..." {
  shape: diamond
}
UL: "統一生成層\n/api/backends/luker-generation" {
  style.fill: "#e1f5ff"
}
INSP: "請求檢查器\nToken 計量" {
  style.fill: "#fff3e0"
}
SSE: "SSE 串流解析\n統一串流處理"
ERR: "錯誤規範化"
UPSTREAM: "上游 AI 服務\nOpenAI / Anthropic / Google / Kobold ..."

FE -> EP
EP -> INSP: "startInspection"
EP -> UL
UL -> SSE
UL -> INSP
UL -> ERR
UL -> UPSTREAM
UPSTREAM -> SSE: "串流回應" {style.stroke-dash: 3}
SSE -> INSP: "completeInspectionFromStream"
ERR -> INSP: "failInspection"
```

> [!NOTE]
> 統一生成層是一個內部模組，對前端透明。使用者無需關心它的存在，只需享受它帶來的一致體驗。

## 與其他模組的關係

- **[請求檢查器](/zh-TW/improvements/request-inspector)** — 統一生成層是請求檢查器的主要呼叫方
- **[認證與配額](/zh-TW/improvements/auth-and-quota)** — 儲存配額中介軟體在統一生成層之前執行，攔截超額請求
- **`chats.js`** — 生成完成後觸發 `acknowledge-generation` 流程，將生成結果與聊天記錄關聯
