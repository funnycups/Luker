# Loop 模式

Loop 模式讓一個 Agent 在同一會話裡反覆呼叫工具，自己決定何時結束。它適合需要邊查邊想的回合：先讀最近聊天，再查世界書和記憶圖，最後寫出一段編排結果交給主模型。

```d2
direction: down

start: "新回合開始" {
  shape: oval
  style.fill: "#e8f5e9"
}

loop: "單一 Agent 持續工作" {
  style.fill: "#e1f5ff"

  think: "讀取已收集的資訊\n決定下一步" {
    style.fill: "#fffde7"
  }

  decide: "可以寫出編排結果了嗎？" {
    shape: diamond
  }

  tool: "呼叫工具\n讀取近期聊天 · 查詢世界書 ·\n檢索記憶 · 記錄筆記 · 網路搜尋\n結果回到同一會話" {
    style.fill: "#fff3e0"
  }

  finish: "寫出編排結果並結束" {
    style.fill: "#c8e6c9"
  }

  think -> decide
  decide -> tool: "資訊不足"
  decide -> finish: "資訊足夠"
  tool -> think: "繼續"
}

out: "注入主模型的提示詞" {
  shape: oval
  style.fill: "#f3e5f5"
}

start -> loop.think
loop.finish -> out
```

## 與 Spec、Agenda 的區別

Spec 和 Agenda 依預先寫好的流程逐個階段執行。每個階段切換預設，提示詞快取難以重複使用，階段之間只傳遞結構化輸出，Agent 的中間思考會遺失。

Loop 只有一個 Agent 和一個持續成長的會話。工具呼叫與結果都留在上下文中，提示詞快取持續命中，因此速度更快；下一步查什麼由 Agent 依上一輪結果決定，不依賴固定流程。

需要可重現的固定流程時用 Spec；需要動態決定執行哪些 Agent 時用 Agenda；需要單一 Agent 自主研究並給出結論時用 Loop。

## 開始使用

1. 在**工作台 → 編排**頂列的模式選擇器中選為**循環**（Loop）。
2. 在**流程**或**準備階段**編輯研究員的角色設定，說明任務和結束條件。
3. 在**流程**中選擇循環模式使用的連線設定與生成預設，留空時沿用**編排 → 設定**中的全域預設。
4. 在**準備階段**的工具開關中勾選本輪需要的工具組。
5. 正常聊天，在**執行面板**懸浮窗或**編排 → 執行**查看查詢過程和最終結果。

## 編輯器

- **角色設定**：Agent 的角色、任務和結束條件。多數 Loop 卡住不結束，都是因為提示詞沒有說明什麼時候可以提交結果。
- **循環最大輪數**（**編排 → 設定**）：預設 40。一輪包含一次模型請求與一次工具處理。
- **循環時間預算（秒）**（**編排 → 設定**）：預設 300 秒。到時終止，不等待剩餘輪次。
- **工具開關**（**準備階段**）：依組啟用。未勾選的組不會出現在 Agent 的工具清單中。
- **模型**（**流程**）：可以讓 Loop 單獨使用成本較低的模型。

## 可用工具

工具依用途分組，勾選後 Agent 才能使用：

- **聊天**：讀取指定範圍的樓層，依正規表達式搜尋全部樓層。
- **世界書**：搜尋已啟用的條目，讀取條目全文，或把本輪未啟用的條目強制加入主模型上下文。
- **記憶圖**：查看候選節點，依關鍵字或語意搜尋，依名稱尋找實體，建立、編輯、刪除節點與關係，查看類型設定，壓縮事件層級。
- **便箋**：開啟和關閉劇情線索，讓後續回合能夠追蹤伏筆與承諾。
- **網路搜尋**：呼叫搜尋外掛查找資料並開啟頁面正文。
- **提交結果**：寫出最終編排結果並結束本輪。該工具始終啟用。

工具的具體數量與名稱會隨安裝的外掛變化。Agent 只能呼叫已勾選且目前可用的工具。

## 保護機制

執行會在以下情況停止：

- 你點擊停止，或上層取消生成。
- 達到時間預算。
- 達到最大輪次。
- Agent 連續多輪沒有呼叫任何工具，表示它已經不再查詢，只是重複輸出文字。

若你的 agent 需要內建之外的能力，參見[自訂工具](./custom-tools.md)。

## 失控保護（按觸發優先級）

1. **abort signal**：使用者點「終止」 / 上層取消 → 立即中止；trace 記 `cancelled`，**不**注入半成品 capsule。
2. **wall_clock_budget_ms**：到點立即 break。
3. **max_rounds**：輪次上限（預設 40）。
4. **Agent 不呼叫工具**：連續 3 輪沒呼叫任何工具 → 提前 break（防止 agent「光說話不動手」耗光預算）。任意一輪呼叫到工具，streak 歸零。

觸發任一兜底時，loop 會把最後一次 agent 的自然文字作為 capsule 兜底，保證至少有產出送給主模型。

## 看一次 loop 跑

[執行面板](/zh-TW/features/orchestrator/#step-4) 會即時顯示 loop 運行過程。Agent 的推理是一張卡片，展開就能看 agent 當時怎麼想、調了哪些工具。Loop 模式可以重點關注：

- **思考 + 工具呼叫** —— 該輪 agent 的思考，跟著是它派發的工具。工具參數就地展開，不用看 raw JSON。
- **工具結果反哺下一輪** —— 每個工具的回傳也在這張卡片裡。對照 system prompt 找 agent 跑岔的位置。
- **`finalize`** —— agent 呼叫 `finalize` 工具時 loop 結束。它的 `capsule_text` 參數就是注入主模型的那段文字。
- **兜底** —— 任一兜底觸發（`max_rounds` / 牆鐘逾時 / 連續不呼叫工具）時，面板會直接顯示具體原因，loop 會用 agent 上一次的自然文字作為 capsule 兜底。

面板頂部的**匯出**按鈕把整次 run 下載為 JSON（便於回報問題）。

::: warning persistTrace 是實驗性開關
設定裡的 `persistTrace` 可以讓所有 run 自動落盤到擴展資料目錄。**目前是實驗性的**——沒有跨平台穩定的寫盤 helper，開關預設關。日常用執行面板的按需匯出就夠；只有需要持續追蹤某個 chat 的 loop 行為時才打開。
:::

## AI 迭代工作台用法

不會寫 system prompt？打開 loop popup → 點 **打開 AI 迭代工作台**，用自然語言描述你想要的 agent，AI 會讀你當前的 profile，用工具呼叫產出 patch（修改 `system_prompt` / 工具開關 / `max_rounds` / 預設路由）。詳見 [AI 迭代工作台](/zh-TW/features/orchestrator/iteration-studio#loop-模式的迭代提示)。

## 角色卡綁定

Loop 現已支援卡覆寫。在角色卡選中狀態打開編排編輯器，會出現 **儲存到角色卡覆寫** / **清除角色卡覆寫** 按鈕——和 Spec / Agenda 的體驗一致。綁定後這套 loop 設定會隨卡匯出，卡作者可以為自己的角色推薦「讀什麼、記什麼、何時 finalize」。

::: info 與 spec / agenda 的差異
Loop popup 當前沒有 **匯出 Profile** / **匯入 Profile** 按鈕，跨電腦同步先用 AI Iteration Studio 複用工作流。檔案級匯入匯出會等後續。
:::

## 與 spec / agenda 模式對比

| 維度 | spec / single | agenda | loop |
|---|---|---|---|
| 設定成本 | 需畫 DAG + 每節點 prompt | 寫 Planner prompt + worker prompts | 寫一段 system prompt + 勾工具 |
| Agent 數量 | 多（每 stage / 節點一個） | Planner + 多 worker | 單 agent |
| Preset 切換 | 多次 | 多次 | 一次 |
| 流程可變 | 拓撲固定 | Planner 決定調度 | agent 自己決定下一步 |
| 上下文連續性 | 透過 `previous_outputs` 傳變數 | 同 spec | 工具結果天然在 messages 裡 |
| 失敗處理 | 節點失敗直接傳播 | worker 失敗由 Planner 重試 | 工具失敗結構化注回，agent 自糾 |
| 角色卡覆寫 | ✅ | ✅ | ✅ |
| 檔案級匯入匯出 | ✅ | ✅ | ❌（用 Iteration Studio 複用） |
| 適合場景 | 流程明確、stage 固定 | 複雜任務需要調度 | 速度與效果平衡；探索性研究、動態決策、prompt cache 重要 |

## Loop 設定參考

<details>
<summary>Loop 專屬設定</summary>

| 設定 | 說明 |
|---|---|
| `max_rounds` | loop 最多跑多少輪（預設 40） |
| `wall_clock_budget_ms` | 整個 loop 的牆鐘預算（預設 300000 ms / 5 分鐘） |
| `system_prompt` | loop agent 的 system 指令 |
| `tools.<namespace>.<verb>` | 每個工具的啟用開關（`finalize` 強制 true） |
| `apiPresetName` / `promptPresetName` | 單 agent 用的 API 與提示詞預設 |
| `capsule_inject` | 與 spec 模式一致的位置 / 深度 / 角色 / 自定義指令設定 |

</details>

## 常見問題

### Agent 一直不結束

在系統提示詞裡明確寫出結束條件，例如「收集到目前場景所需的資訊後，提交編排結果，不要繼續查詢」。減少勾選的工具組也能降低它反覆探索的傾向。

### 工具沒有出現

檢查工具開關是否勾選，以及對應外掛是否啟用。網路搜尋還需要在搜尋外掛中設定可用的 provider。

### 執行太慢或太貴

改用較小的模型，只勾選本輪真正需要的工具組，並降低最大輪次。記憶圖的向量檢索依賴嵌入設定檔，未設定時會提示無法使用。

### 結果沒有注入主模型

確認 Loop 已啟用、執行模式選擇正確，並查看執行面板是否顯示了最終結果。取消或失敗的執行不會注入未完成的內容。

## 相關頁面

- [多 Agent 編排概覽](/zh-TW/features/orchestrator/) —— 模式選擇與通用設定
- [編排 AI 迭代](/zh-TW/features/orchestrator/iteration-studio) —— 用自然語言修改 Loop 設定
- [自訂工具](/zh-TW/features/orchestrator/custom-tools) —— 給 Agent 增加內建之外的能力
- [便箋](/zh-TW/features/orchestrator/notes) —— 劇情線索的儲存與追蹤
- [記憶圖](/zh-TW/features/memory-graph) —— Loop 可查詢的長期記憶
