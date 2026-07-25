# 請求檢查器

請求檢查器（Request Inspector）是 Luker 的核心後端模組之一，用於追蹤每個 AI 生成請求從發起到完成的完整生命週期，並記錄詳細的 Token 用量資料。它是生成診斷能力的基礎設施。

## 問題背景

在 SillyTavern 中，AI 生成請求發出後，後端不會系統性地記錄請求的 Token 消耗。使用者無法得知每次生成實際花費了多少 Token，管理員也無法追蹤多使用者場景下的資源使用情況。

Luker 實現了一套完整的請求生命週期追蹤系統，涵蓋文字生成、圖像生成、向量嵌入 / 重排三類請求。

## 核心能力

### 請求生命週期追蹤

每個 AI 生成請求都會經歷以下狀態流轉：

1. **開始** — 記錄請求中繼資料，標記請求進入追蹤
2. **完成** — 請求成功回傳，記錄 Token 用量
3. **失敗** — 請求出錯，記錄錯誤資訊
4. **中止** — 使用者主動取消生成

```d2
direction: down

start: "" {
  shape: circle
  width: 20
  style.fill: "#222"
}
in_progress: "進行中"
done: "完成"
failed: "失敗"
aborted: "中止"
end_: "" {
  shape: circle
  width: 20
  style.fill: "#222"
}

note: "串流回應從串流的最後一個 SSE 事件中擷取用量" {
  shape: text
  style.fill: "#fff8d4"
}

start -> in_progress: "記錄中繼資料"
in_progress -> done: "記錄 Token 用量"
in_progress -> failed: "記錄錯誤訊息"
in_progress -> aborted: "使用者取消"
done -> end_
failed -> end_
aborted -> end_
in_progress -- note: {style.stroke-dash: 3}
```

### Token 用量統計

請求檢查器記錄每次生成的詳細 Token 資料：

- **Prompt Tokens** — 輸入提示詞消耗的 Token 數
- **Completion Tokens** — 模型生成內容消耗的 Token 數
- **Total Tokens** — 總用量

這些資料從 API 回應中提取，並與使用者帳戶關聯，用於用量統計和診斷分析。

### 串流回應的 Token 統計

對於串流（SSE）回應，Token 用量資訊通常包含在最後一個 SSE 事件中。請求檢查器會從 SSE 事件流中擷取 `usage` 欄位，確保串流生成也能準確統計 Token 消耗。

### 圖像生成請求追蹤

除文字生成外，請求檢查器還追蹤圖像生成請求，涵蓋所有圖像生成後端。

### 向量嵌入與重排請求追蹤

請求檢查器同樣涵蓋向量子系統，記錄發往所有遠端向量提供方（OpenAI、Cohere、Jina、Ollama、VLLM、Voyage 等）的嵌入、查詢與重排呼叫，以及 KoboldCpp 直連嵌入橋接。僅在本機行程內推理的來源不會離開本機，因此會被跳過，讓環形緩衝專注於真正的上游流量。

## 與儲存配額的關係

請求檢查器追蹤的 Token 用量是獨立的統計功能，用於幫助使用者和管理員了解 AI 生成的資源消耗情況。這與[認證與配額](/zh-TW/improvements/auth-and-quota)中的儲存配額管理是兩個獨立的系統：

- **Token 用量統計**：請求檢查器記錄每次 AI 生成的 Token 消耗，提供用量視覺化和診斷資料
- **儲存配額管理**：管理檔案儲存空間的分配和限制

> [!TIP]
> 請求檢查器會隨伺服器自動啟用，無需額外配置。
