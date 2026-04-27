# 多 Agent 編排

多 Agent 編排（Orchestrator）是 Luker 的核心獨有功能之一，提供了一個靈活的多 AI Agent 協作框架。它允許使用者定義多個具有不同職責的 Agent——蒸餾器、約束 Agent、規劃器、記憶分析器、審查者、合成器等——按照預設的工作流協同處理每一次 AI 回覆的生成。編排器在 WorldInfo 解析完成後自動觸發，將多個 Agent 的協作結果注入到最終的提示詞中，引導主模型生成更高品質的回覆。

編排器完全運行在前端，無後端程式碼。角色卡級別的編排設定會隨角色卡一起儲存和匯出。

編排器支援五種生成類型的觸發：`normal`（普通生成）、`continue`（繼續）、`regenerate`（重新生成）、`swipe`（滑動切換）和 `impersonate`（扮演）。其他生成類型不會觸發編排流程。

## 三種執行模式

編排器提供三種執行模式，適應從簡單到複雜的不同場景：

```
spec    → 階段→節點 DAG，最靈活的靜態工作流
single  → 單節點簡化模式
agenda  → Planner 動態調度，最靈活的動態工作流
```

### Spec 工作流

Spec 工作流是最靈活的靜態模式，採用 **階段(Stage) → 節點(Node)** 的 DAG（有向無環圖）結構：

- **階段**：工作流的頂層組織單元，階段之間嚴格按順序串行執行
- **節點**：階段內的執行單元，每個節點引用一個 LLM 預設（Preset），負責特定任務
- **執行方式**：階段內的節點支援 `serial`（串行）和 `parallel`（並行，使用 `Promise.all`）兩種執行方式
- **節點類型**：`worker`（工作節點）和 `review`（審查節點）

每個節點執行時，系統會建構訊息列表（系統提示 + 使用者提示範本 + 上下文）呼叫 LLM，並支援節點迭代（受「節點迭代最大輪次」控制）。階段輸出彙總後自動傳遞給下一階段。

預設的 Spec 工作流包含以下 5 個階段結構：

1. **蒸餾器**（串行執行）
2. **知識書讀取器** + **約束 Agent**（並行執行）
3. **規劃器** + **記憶分析器**（並行執行）
4. **審查者**（串行執行）
5. **合成器**（串行執行）

#### 範本變數

節點的使用者提示範本支援以下佔位變數：

| 變數 | 說明 |
|------|------|
| <span v-pre>`{{recent_chat}}`</span> | 最近的聊天訊息 |
| <span v-pre>`{{last_user}}`</span> | 最後一條使用者訊息 |
| <span v-pre>`{{previous_outputs}}`</span> | 前序階段的輸出 |
| <span v-pre>`{{distiller}}`</span> | 蒸餾器輸出 |
| <span v-pre>`{{previous_orchestration}}`</span> | 上一次編排的結果（自動注入，無需手動編寫） |

其中 <span v-pre>`{{previous_orchestration}}`</span> 是自動注入變數，系統會在範本文字之前自動插入上一次編排的結果，無需使用者在範本中顯式引用。

### 單 Agent 模式

單 Agent 模式是 Spec 工作流的簡化版。系統內部自動建構一個只包含單節點的 Spec，然後走統一的執行流程。適合不需要多 Agent 協作的簡單場景，同時保留了 Spec 模式的所有設定能力（如自訂系統提示、API 路由等）。

### Agenda 規劃器

Agenda 規劃器是最動態的模式。一個 Planner Agent 透過工具呼叫（Function Calling）動態調度其他 Agent：

- Planner 維護一個 todo 列表，根據任務進展動態決定下一步呼叫哪個 Agent
- 每個 Agent 可以獨立設定系統提示、API 路由和 Chat Completion 預設
- 受三個參數限制運行邊界：
  - Planner 最大輪次：Planner 的最大調度輪次
  - 最大並行 Agent 數：同時運行的 Agent 上限
  - 最大總執行次數：所有 Agent 的總執行次數上限

Agenda 模式依賴 Luker 的[函式呼叫執行時](/zh-TW/improvements/function-call-runtime)框架來實現 Planner 的工具呼叫能力。

::: info Agenda 與 Spec 互轉
編排器支援 Agenda 和 Spec 兩種模式之間的設定互轉：

- 將 Agenda 模式下定義的 Agent 集合盡力轉換為 Spec 工作流結構
- 將 Spec 預設複製到 Agenda 編輯器
- 將 Agenda Agent 複製到 Spec 編輯器

注意：互轉是盡力而為的（best-effort），不保證完美還原。例如 Agenda 模式的動態調度邏輯無法完全對應到 Spec 的靜態 DAG 結構，轉換後可能需要手動調整。
:::

## 工作流編輯器

編排器提供了視覺化的工作流編輯器（支援在獨立彈窗中開啟），使用者可以：

- 新增、刪除、重新排列階段
- 在階段內新增、刪除、重新排列節點
- 為每個節點設定獨立的 LLM 預設和 API 預設
- 設定節點的系統提示詞和使用者提示範本
- 設定階段的執行方式（串行 / 並行）
- 標記節點為審查節點

每個預設可以獨立設定 API 路由，這意味著不同的 Agent 可以使用不同的 LLM 後端。例如：蒸餾器使用低成本模型降低開銷，而合成器使用高品質模型保證輸出品質。空值的 API 預設會回退到全域編排 API 預設，空值的 Chat Completion 預設會回退到全域編排預設。

Agenda 模式也有對應的編輯器面板，用於管理 Agent 列表和 Planner 設定。

## 審查節點

審查節點（Review Node）是 Spec 工作流中的特殊節點類型，用於對前序工作節點的輸出進行品質把關。審查節點透過兩個專用工具與工作流引擎互動：

| 工具 | 作用 |
|------|------|
| `luker_orch_review_approve` | 批准前序工作節點的輸出，工作流繼續執行下一階段 |
| `luker_orch_request_rerun` | 要求重跑指定的前序工作節點，並附帶修改建議 |

審查節點的關鍵約束：

- 只能審查**直接相鄰的前一個工作階段**的節點
- 重跑時只重跑指定的節點 ID，而非整個階段
- 重跑次數受「審查重跑最大輪次」限制（預設 0，最大 20）
- 重跑後審查節點會再次運行，形成「執行 → 審查 → 重跑 → 再審查」的循環，直到批准或達到輪次上限
- 審查節點必須輸出審查回饋

系統內建了多條審查節點提示工程規則，確保審查行為的一致性和可靠性。這些規則定義了審查節點必須包含的檢查門，用於 AI 生成審查節點設定時的約束。

## AI 生成設定

編排器提供兩種 AI 輔助設定生成方式，降低手動設定的門檻。

### AI Quick Build

一鍵生成完整的編排設定。使用者透過自然語言描述需求，AI 自動生成包含階段、節點、預設分配的完整工作流。生成過程會考慮知識書讀取節點和 Anti-Data Guard 節點，確保生成的設定包含必要的保護機制。

### AI 迭代工作台

AI 迭代工作台（AI Iteration Studio）提供多輪對話式的精細編輯能力，是比 Quick Build 更強大的 AI 輔助工具：

- **會話持久化**：迭代會話儲存到角色卡或全域設定，最多支援 **24 個會話**。會話可以載入、刪除和管理
- **模擬測試**：在不實際執行編排的情況下模擬工作流運行，驗證設定的正確性。例如你可以輸入「請使用『我走進了酒館，環顧四周』模擬當前使用者最新輸入」來測試編排在特定場景下的表現
- **自動繼續**：支援 AI 自動推進迭代過程，無需使用者手動觸發每一步
- **Diff 審批**：每次 AI 修改都會生成 diff，使用者可以逐項審批或拒絕
- **回滾**：支援撤銷已套用的 AI 修改
- **重新生成**：支援重新生成 AI 的回覆
- **`<thought>` 標籤剝離**：AI 回覆中的思考過程（`<thought>` 標籤內容）在顯示時自動移除
- **訊息折疊**：超過 1200 字元或 18 行的長訊息自動折疊，模擬上下文也會自動折疊

AI 迭代工作台的會話歷史會持久化到角色卡或全域設定中。這與運行態軌跡（僅儲存在記憶體中）是不同的概念。

## Diff 引擎

編排器內建了完整的 Diff 引擎，用於 AI 迭代工作台中的修改視覺化：

- **LCS 行級 diff**：基於最長公共子序列（Longest Common Subsequence）演算法的精確差異計算
- **內聯檢視（Inline Diff）**：在同一列中以顏色標記顯示增刪改
- **並排檢視（Side-by-Side Diff）**：左右對比顯示修改前後的內容
- **可拖曳分割條**：並排檢視中可自由調整左右面板寬度
- **展開 Diff**：支援展開折疊的 diff 區塊查看完整上下文
- **回滾支援**：可以撤銷已套用的修改，恢復到修改前的狀態

該 Diff 引擎與[角色卡編輯助手](/zh-TW/features/card-editor)共享。

## 結果注入與複用

編排結果會自動注入到 SillyTavern 的提示詞建構流程中。注入行為可透過以下設定項控制：

| 設定項 | 說明 | 預設值 |
|--------|------|--------|
| 注入位置 | 編排結果在提示詞中的插入位置 | `IN_CHAT` |
| 注入深度 | 編排結果的注入深度 | `1` |
| 注入角色 | 編排結果以哪個角色身分注入 | `SYSTEM`（也支援 `USER` / `ASSISTANT`） |
| 自訂指令前綴 | 注入文字前的自訂指令前綴 | `"Follow the orchestration guidance below and prioritize it when drafting the next in-character reply."` |

編排結果綁定到觸發編排的使用者訊息樓層。當使用者對同一樓層進行 swipe（滑動切換）時，系統會複用已有的編排結果，避免重複執行整個工作流。當設定變更時，系統會自動重新套用最新的編排結果。

運行態軌跡（每個節點的輸入輸出、執行時間等）僅儲存在記憶體中，聊天切換時自動清空，不持久化到磁碟。

### 編排結果事件下發

編排器會在每次運行結論產生後下發前端事件，外部外掛或腳本無需依賴 UI 內部狀態即可消費編排結果。

- 事件名：`luker.orchestrator.result`
- 下發通道：`getContext().eventSource`
- 觸發時機：編排狀態為 `completed`、`reused`、`cancelled`、`failed` 時

事件負載欄位：

| 欄位 | 型別 | 說明 |
|------|------|------|
| `module` | string | 固定為 `orchestrator` |
| `event` | string | 固定為 `luker.orchestrator.result` |
| `status` | string | `completed` / `reused` / `cancelled` / `failed` |
| `generationType` | string | 當前生成類型（`normal`、`continue` 等） |
| `chatKey` | string | 當前聊天鍵 |
| `at` | string | ISO 時間戳 |
| `anchorPlayableFloor` | number | 綁定的使用者樓層（不可用時為 0） |
| `anchorHash` | string | 錨點雜湊（用於校驗） |
| `capsuleText` | string | 最終注入提示詞的編排指導文字 |
| `stageOutputs` | array | 壓縮後的階段輸出（`completed` / `reused` 時提供） |
| `reviewRerunCount` | number | 審查重跑次數 |
| `reason` | string | 面向機器的取消/失敗/跳過原因 |
| `note` | string | 面向人的補充說明 |
| `error` | string | `failed` 時的錯誤訊息 |

訂閱範例：

```js
const context = getContext();
context.eventSource.on('luker.orchestrator.result', (evt) => {
  if (evt.status === 'completed' || evt.status === 'reused') {
    console.log('編排注入文字:', evt.capsuleText);
  }
});
```

## 匯入匯出

編排設定支援 JSON 檔案的匯入匯出，使用兩種格式標識：

| 格式 | 標識 | 適用模式 |
|------|------|----------|
| V1 | `luker_orchestrator_profile_v1` | Spec 工作流模式 |
| V2 | `luker_orchestrator_profile_v2` | Agenda 規劃器模式 |

匯出檔名格式為 `luker-orchestrator-[agenda-][global|character-{name}].json`，支援全域匯出和角色卡級別匯出。

匯入時系統會自動偵測檔案的模式（Spec / Agenda），並要求與當前執行模式匹配。使用者可以選擇將匯入的設定套用到全域或特定角色卡。

## 設定項列表

以下是編排器的主要設定項：

| 設定項 | 說明 | 預設值 / 範圍 |
|--------|------|---------------|
| 執行模式 | Spec / 單 Agent / Agenda | `spec` |
| 注入位置 | 編排結果在提示詞中的插入位置 | `IN_CHAT` |
| 注入深度 | 編排結果的注入深度 | `1` |
| 注入角色 | 編排結果以哪個角色身分注入 | `SYSTEM` / `USER` / `ASSISTANT` |
| 自訂指令前綴 | 編排結果自訂指令前綴 | 見上文 |
| Planner 最大輪次 | Agenda 模式 Planner 最大調度輪次 | — |
| 最大並行 Agent 數 | Agenda 模式最大並行 Agent 數 | — |
| 最大總執行次數 | Agenda 模式最大總執行次數 | — |
| 每分鐘請求限制 | 每分鐘請求數限制（並行節點節流） | — |
| Agent 逾時時間 | 單個 Agent 的執行逾時時間（秒） | — |
| 工具呼叫重試次數 | LLM 工具呼叫失敗時的重試次數 | — |
| 節點迭代最大輪次 | 單個節點的迭代輪次控制 | — |
| 審查重跑最大輪次 | 審查節點重跑最大輪次 | `0`（最大 20） |
| 全域 API 預設 | 全域預設 API 連線預設 | — |
| 全域 Chat Completion 預設 | 全域預設 Chat Completion 預設 | — |
| 包含世界書 | 是否在編排節點中包含世界書資訊 | — |
| Anti-Data Guard | 屏蔽特定詞彙（如 `OOC`、`meta`、`system note`、`author`） | 啟用 |
| `<thought>` 標籤剝離 | 是否從 AI 輸出中移除思考標籤 | — |
| 訊息折疊閾值 | 字元數 1200 / 行數 18 | — |
| 節點 API 預設 | 節點級 API 預設覆蓋 | 空（回退到全域） |
| 節點 Chat Completion 預設 | 節點級 Chat Completion 預設覆蓋 | 空（回退到全域） |

::: tip
編排器的每個節點都可以獨立設定 API 預設和 Chat Completion 預設，覆蓋全域預設值。這使得你可以為不同的 Agent 分配不同的模型和參數——例如用低成本模型處理蒸餾和約束任務，用高品質模型處理最終合成。
:::

## 與角色卡的整合

編排設定可以綁定到角色卡，隨角色卡一起儲存。綁定後：

- 編排設定隨角色卡匯出，其他使用者匯入角色卡時自動獲得推薦的編排工作流
- 角色卡創作者可以為角色定製最佳的多 Agent 協作方案
- 角色卡可以指定獨立的執行模式，切換角色時自動套用
- 角色卡覆蓋可以獨立啟用或停用
- 支援清除角色卡覆蓋（恢復使用全域設定）
- 使用者可以在角色卡綁定的設定基礎上進行個人化調整

## 相關頁面

- [函式呼叫執行時](/zh-TW/improvements/function-call-runtime) — Agenda 模式的 Planner 依賴此框架進行工具呼叫
- [角色卡編輯助手](/zh-TW/features/card-editor) — 與編排器共享 Diff 引擎
- [角色卡綁定預設與人設](/zh-TW/improvements/card-bound-presets) — 編排設定的角色卡綁定機制
