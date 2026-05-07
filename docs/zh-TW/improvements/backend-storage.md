# 後端即時儲存

Luker 重新設計了資料持久化架構，將資料變更的儲存職責從前端轉移到後端，實現即時持久化，從根本上消除因瀏覽器當機、網路中斷或意外關閉導致的資料遺失風險。

## 問題背景

在 SillyTavern 中，資料儲存由前端觸發：前端將完整的聊天資料序列化後傳送到後端覆蓋寫入。這種模式存在嚴重的資料安全隱患：

- **瀏覽器當機** — 如果在儲存請求發出前瀏覽器當機，所有未儲存的修改都會遺失
- **網路中斷** — 儲存請求可能因網路問題失敗，而前端可能不會重試
- **生成中斷** — AI 生成過程中如果連線斷開，已生成的內容可能無法儲存
- **競態條件** — 多個儲存請求並行時可能產生資料覆蓋

Luker 透過後端即時儲存徹底解決了這些問題。

## 資料變更即時持久化

所有透過[增量同步](/zh-TW/improvements/incremental-sync)端點到達後端的資料變更，都會立即寫入磁碟。後端不使用記憶體快取或延遲寫入——每次追加、修補或更新中繼資料操作完成後，資料已經安全地持久化到檔案系統中。

寫入完成後，後端更新聊天狀態檔案，記錄新的 integrity UUID 和時間戳，確保後續操作能正確偵測並行衝突。

## 聊天狀態檔案 {#chat-state-file}

每個聊天檔案都有一個對應的狀態檔案，儲存在與聊天檔案相同的目錄中。狀態檔案記錄：

- **integrity** — 當前檔案的 integrity UUID，用於[並行衝突偵測](/zh-TW/improvements/incremental-sync#integrity-hash-並行衝突偵測)
- **updated_at** — 最後一次寫入的時間戳

狀態檔案與聊天檔案分離儲存，避免了在聊天檔案中頻繁更新 integrity 值導致的全檔案重寫。

```d2
direction: right

DIR: "chats/<角色名>/"
CHAT: "{chat}.jsonl" {
  style.fill: "#e1f5ff"
}
STATE: "{chat}.luker-state.chat_sync.json" {
  style.fill: "#fff3e0"
}
NS1: "{chat}.luker-state.memory_graph__meta.json"
NS2: "{chat}.luker-state.luker_orchestrator__schema.json"

DIR -> CHAT
DIR -> STATE
DIR -> NS1
DIR -> NS2
```

- `{chat}.jsonl` — 聊天主檔案
- `{chat}.luker-state.chat_sync.json` — integrity + updated_at（同步中繼資料）
- `{chat}.luker-state.<namespace>.json` — 各外掛的 namespace 狀態（每個外掛一份獨立 sidecar）

如果狀態檔案不存在（例如從舊版本遷移的聊天），系統會自動回退處理，並在首次寫入時自動建立狀態檔案。

## Generation Acknowledge

在 AI 生成場景中，Luker 的統一生成層實作了 Generation Acknowledge 機制。當後端完成一次生成並將結果持久化後，會在回應中確認生成結果已被伺服器端安全儲存。

```d2
shape: sequence_diagram

FE: "前端"
BE: "後端（統一生成層）"
LLM: "上游 LLM"
Disk: "磁碟"

FE -> BE: "發起 AI 生成請求"
BE -> LLM: "轉發請求"
LLM -> BE: "串流回應"
BE -> Disk: "即時持久化生成結果"
Disk -> BE: "寫入完成"
BE -> FE: "回傳回應 + acknowledge"
FE -> FE: "更新本地 integrity 狀態"

BE."即使前端在收到 ack 後當機,資料已落盤"
```

這意味著即使前端在收到生成結果後立即當機，資料也不會遺失——因為後端已經在回傳回應之前完成了持久化。前端收到確認後更新本地的 integrity 狀態，保持與伺服器端的同步。

::: tip 與傳統模式的對比
在 SillyTavern 中，AI 生成的結果先到達前端，由前端決定何時儲存。如果前端在儲存前當機，生成的內容就會遺失。Luker 的 Generation Acknowledge 將儲存時機提前到了後端回應之前，從根本上消除了這個窗口期。
:::

## 序列化聊天寫入 {#序列化聊天寫入}

為了防止並行寫入導致檔案損壞，Luker 在前端（透過 `runSerializedChatWrite`）對聊天寫入任務做串行化，同時由後端對每次寫入執行 integrity 校驗。

當多個寫入操作短時間內同時觸發時（例如使用者快速編輯多條訊息，或生成完成與手動編輯同時發生），流程為：

1. 前端將寫入任務按到達順序排隊
2. 按順序逐一呼叫增量端點執行寫入
3. 每次寫入成功後，後端更新聊天狀態 sidecar 中的 integrity UUID
4. 若排隊中的請求攜帶過期 integrity，後端回傳 `409 Conflict`

這種「前端串行 + 後端校驗」的組合可保障寫入順序與一致性，而不依賴後端記憶體寫入佇列。

## 與增量同步的協作

後端即時儲存與[增量同步](/zh-TW/improvements/incremental-sync)緊密配合：

- 增量同步負責「傳什麼」— 只傳輸變更的資料
- 後端即時儲存負責「怎麼存」— 確保資料安全持久化
- 聊天狀態檔案是兩者的橋樑 — 透過 integrity UUID 協調前後端狀態

兩者共同構成了 Luker 的資料安全基礎設施。

## 相關頁面

- [增量同步](/zh-TW/improvements/incremental-sync) — 後端即時儲存的前端配合機制
- [改進總覽](/zh-TW/improvements/overview) — 所有技術改進的概述
