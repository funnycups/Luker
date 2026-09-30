# 多 Agent 編排

精心設置的場景——劍拔弩張的對峙、微妙的政治談判、慢熱的浪漫——仍可能被回覆破壞：它跳過你剛鋪墊的節奏、忘了兩段以前確立的世界規則、出戲做總結、或者把不該這一回合解決的伏筆倉促收尾。這不是模型能力的問題，而是它一次只能關注一件事，而你讓它在一次回覆裡同時處理太多事：守人設、調上下文、守世界觀、規劃下一步、*還要*把文筆寫好。

編排器的做法是在主模型動筆之前先派遣一支小隊。一個 Agent 提取最近聊天裡的關鍵狀態。一個確定當前生效的世界規則。一個起草這一回合應推進的內容。一個審查全隊的工作。最後一個 Agent 把全隊的產出整合為一份精簡的「作業說明」。等到主模型開始寫回覆，它已收到這份說明（且僅有這份），因此可以把預算用於文筆，而不是繁瑣的核對工作。

**編排器自帶一套可用的預設 Spec 工作流，無需先行設計，啟用即可運行。** 後續需要不同形態時，各執行模式都有獨立編輯器。

::: info 它什麼時候觸發？
編排器在五種生成類型上觸發：`normal`（普通生成）、`continue`（繼續）、`regenerate`（重新生成）、`swipe`（滑動切換）和 `impersonate`（扮演）。它在世界書解析**之後**、主模型回覆**之前**運行。運行面板只儲存在記憶體中，切換聊天時會清空。
:::

## 5 分鐘跑起來（用預設編排）

無需先選模式，也無需先編寫工作流——預設 Spec 已經配置好。本節只介紹如何啟用它，以便觀察它的實際行為。

### Step 0 — 你需要先有什麼 {#step-0}

- 你的主對話已經能正常用 Chat Completion API 出回覆
- 當前對話至少有 3 輪以上聊天記錄（沒有內容，工作流沒什麼可規劃的）

### Step 1 — 啟用編排器 {#step-1}

打開頂欄的擴展抽屜，找到 **多智能體編排** 那一節。把 **啟用** 開關打開。

![編排器啟用開關](/images/orchestrator/orch-toggle.png)

### Step 2 — 給各 Agent 選模型 {#step-2}

在同一面板裡繼續往下看，找到 **LLM 節點 API 預設** 和 **AI 生成 API 預設**。這兩個欄位告訴編排器各 Agent 用哪個 API、哪個 Chat Completion 預設。

::: tip 這裡能省錢
編排器每回合會呼叫 LLM 5–10 次（每個節點一次）。如果主對話使用的是 Claude Opus 這類昂貴模型，為編排器選擇更便宜的模型——如 Haiku、Gemini Flash——可節省 70% 以上的成本。如果需要更高的品質，可以為不同節點配置不同模型（每個節點都能單獨覆寫 API/預設）。
:::

### Step 3 — 直接發一條訊息 {#step-3}

在主對話中發送一則訊息，無需調整其他設定。主模型回覆之前，預設 Spec 工作流會自動在後台執行。首次運行會比平時慢一些（順序呼叫 5–10 個 Agent），後續運行會更快。

### Step 4 — 看它替你幹了什麼 {#step-4}

運行一開始，**運行面板**就會從聊天區右側滑入（窄屏上從底部升起）。面板即時更新：每一輪都是一張可折疊的卡片，展開後就能看到模型當時怎麼想、呼叫了哪些工具、工具回傳了什麼。

![編排器開始運行時的面板](/_screenshots/run-panel/01-panel-initial.png)

模型流式輸出時，面板在原地即時更新——不閃屏、也不會打亂聊天區：

![流式過程：思考、文字與工具分節即時填充](/_screenshots/run-panel/02-panel-streaming.png)

展開任意工具呼叫，能看到它的傳入參數和回傳：

![工具呼叫展開——參數與結果](/_screenshots/run-panel/03-panel-tool-expanded.png)

窄屏下面板變成底部抽屜，可以上拉展開或下滑關閉：

![窄屏下的運行面板（抽屜佈局）](/_screenshots/run-panel/05-panel-drawer.png)

面板僅儲存在記憶體中。切換聊天或重新整理頁面會清空；聊天記錄裡只保留最終回覆，且逐字保留——不會被過程資訊撐大。還可以執行以下操作：

- 運行中**停止**
- **複製**任意分節的原始內容
- 把整次運行**匯出**為 JSON（便於分享或回報問題）
- 一鍵**全部收起**所有卡片

這就是「AI 在回覆前先思考」在實際中的體現。如果回覆不理想，打開面板就能定位問題出在哪一步。

至此編排器已啟用。接下來根據需求有三個方向：

- 預設 Spec 流程不夠用，需要自行或由 AI 協助定製 → [Spec 模式](/zh-TW/features/orchestrator/spec)
- 流程需要根據情況動態變化，無法預先寫死 DAG → [Agenda 模式](/zh-TW/features/orchestrator/agenda)
- 希望單一 Agent 反覆呼叫工具（查記憶、查世界書……）直到自行判定完成 → [Loop 模式](/zh-TW/features/orchestrator/loop)

::: tip 不管你選哪種模式，定製都從這裡開始
**[AI 迭代工作台](/zh-TW/features/orchestrator/iteration-studio)** 是編排器的核心定製工具——用一句話描述目標，AI 傳回方案，逐條審批。Spec / Agenda / Loop / Director 四種模式共用同一個工作台，**在 99% 的定製場景下都優於手動編輯**。
:::

## 選你的執行模式

| 模式 | 是什麼 | 何時用 | Skill | 詳細文件 |
|---|---|---|---|---|
| **Spec**（預設） | 固定的 Stage → Node DAG | 預設。你要一個可預期的管道 | 每節點注入目錄；每節點 `skills.visible` 覆寫 | [Spec 模式](/zh-TW/features/orchestrator/spec) |
| **單 Agent** | 只有一個節點的 Spec | 成本低、速度快。不需要多 Agent 協作 | 在那一個節點上注入目錄 | [單 Agent 模式](/zh-TW/features/orchestrator/single) |
| **Agenda** | 一個 Planner Agent 透過工具呼叫動態調度其他 Agent | 流程要動態決定運行什麼，像 Agent loop | Planner + 每個被派遣 worker 上注入目錄 | [Agenda 模式](/zh-TW/features/orchestrator/agenda) |
| **Loop** | 單 Agent 在同一會話裡循環呼叫工具，自己決定何時 `finalize` | 速度與效果之間想要平衡；探索性研究、動態決策 | 在 loop agent 上注入目錄 | [Loop 模式](/zh-TW/features/orchestrator/loop) |
| **Director** | 主代理 + 子代理團隊直接寫正文 | 接管模式，用於高品質長篇 RP；出廠自帶預繫結 24 個 Skill | 主代理 + 每次子代理派遣時注入目錄 | [Director 模式](/zh-TW/features/orchestrator/director) |

切換模式：擴展抽屜裡的 **執行模式** 下拉。Spec 與 Agenda 可以在編輯器中互相轉換（盡力而為）；Loop 結構差異較大，沒有對應的互轉入口。

::: tip 想定製？優先用 AI 迭代工作台
切到任何模式後，**[AI 迭代工作台](/zh-TW/features/orchestrator/iteration-studio)** 都是優先選擇。Spec / Agenda 提供 diff 供審批，Loop 直接 patch profile，兩者的面板與工作流程一致。
:::

::: info Skill 這一列
五種模式共用同一套 Skill 策略形狀（模式級 `skills.visible` / `skills.deny`、每 agent 可選的 `+` 繼承覆寫）。完整模型見 [編排器整合](/zh-TW/features/skills/orchestrator-integration)。Director 是唯一在出廠設定中預繫結預設 Skill 的模式；其它模式起步為 `visible: ["*"]`（所有已安裝 Skill 可見）。
:::

## 通用設定

無論選哪種模式，以下設定都共享。

### 結果注入

編排器的最終輸出（「capsule」）會被注入到主模型 prompt 裡。設定：

| 設定 | 預設 | 說明 |
|---|---|---|
| 注入位置 | `atDepth` | capsule 在 prompt 裡的位置 |
| 注入深度 | `0` | 在該位置的深度 |
| 注入角色 | `SYSTEM` | `SYSTEM` / `USER` / `ASSISTANT` 之一 |
| 自定義指令前綴 | （預設一句話） | 加在 capsule 文字前面 |

capsule 綁定到觸發編排的使用者訊息樓層。同一樓層 swipe 時，系統會複用現有 capsule 而不是重跑。設定變更時，系統會重新套用最新結果。

### 角色卡綁定

編排設定可以綁到角色卡。綁定後：

- 設定隨卡匯出。別人匯入卡片自動獲得推薦工作流
- 卡作者可以為自己的角色定製最優工作流
- 切換到這張卡自動套用其工作流
- 卡可以指定自己的執行模式（Spec / Agenda / Loop / Director 都支援）
- 從卡的下拉中選擇某個預設後，這次聊天會立即切換到它；無論怎麼選，卡上的庫都會保留
- 「清除這張卡上的預設」恢復到全域設定
- 你可以在卡綁定設定上層疊個人調整

卡上預設四種模式都支援。

### 匯入匯出

Spec 與 Agenda 設定以 JSON 匯出。

| 格式 | 標識 | 適用 |
|---|---|---|
| V1 | `luker_orchestrator_profile_v1` | Spec 模式 |
| V2 | `luker_orchestrator_profile_v2` | Agenda 模式 |

檔名形如 `luker-orchestrator-[agenda-][global|character-{name}].json`。匯出器同時支援全域和角色卡作用域。

匯入時，檔案的模式（Spec / Agenda）必須和你當前執行模式一致。你選擇套用到全域或某張特定的卡。

::: info Loop 模式的匯入匯出
Loop 模式目前尚未提供檔案級的 Profile 匯入匯出按鈕，可透過 [AI 迭代工作台](/zh-TW/features/orchestrator/iteration-studio) 複用工作流。
:::

### 通用設定參考

最常用的幾項：

| 設定 | 預設 |
|---|---|
| 執行模式 | `spec` |
| 注入位置 | `atDepth` |
| 注入深度 | `0` |
| 注入角色 | `SYSTEM` |

<details>
<summary>完整設定參考</summary>

| 設定 | 說明 |
|---|---|
| 執行模式 | Spec / 單 Agent / Agenda / Loop |
| 注入位置 | capsule 在主 prompt 中的位置 |
| 注入深度 | 注入深度 |
| 注入角色 | `SYSTEM` / `USER` / `ASSISTANT` |
| 自定義指令前綴 | 加在 capsule 前的前綴文字 |
| RPM 限制 | 並行節點的速率限制 |
| 工具呼叫重試次數 | 工具呼叫失敗的重試次數 |
| 全域 API 預設 | 預設 API 連接預設 |
| 全域 Chat Completion 預設 | 預設 Chat Completion 預設 |
| 包含世界書 | 節點是否能看到世界書 |
| `<thought>` 標籤剝離 | 從 Agent 輸出剝離思考標籤 |
| 訊息摺疊閾值 | 1200 字元 / 18 行 |

模式專屬的參數（節點 / 審查 / Planner / Loop 工具開關...）在各自的子頁面裡詳述。

</details>

## 事件 / 二開 API

<details>
<summary>給其他擴展和腳本</summary>

編排器在每次運行結果後會派發一個前端事件，其他程式碼可以消費編排結果而不必讀 UI 內部狀態。

- **事件名：** `luker.orchestrator.result`
- **頻道：** `getContext().eventSource`
- **觸發時機：** `completed` / `reused` / `cancelled` / `failed` 時

事件載荷欄位：

| 欄位 | 型別 | 說明 |
|---|---|---|
| `module` | string | 始終為 `orchestrator` |
| `event` | string | 始終為 `luker.orchestrator.result` |
| `status` | string | `completed` / `reused` / `cancelled` / `failed` |
| `generationType` | string | 觸發的生成類型 |
| `chatKey` | string | 當前聊天 key |
| `at` | string | ISO 時間戳 |
| `anchorPlayableFloor` | number | 綁定的使用者回合樓層（不可用時為 0） |
| `anchorHash` | string | 用於校驗的 anchor hash |
| `capsuleText` | string | 最終注入的引導文字 |
| `stageOutputs` | array | 緊湊的階段輸出（`completed` / `reused` 時存在） |
| `reviewRerunCount` | number | 審查重跑次數 |
| `reason` | string | 取消 / 失敗的機器可讀原因 |
| `note` | string | 人類可讀說明 |
| `error` | string | `failed` 時的錯誤訊息 |

訂閱範例：

```js
const context = getContext();
context.eventSource.on('luker.orchestrator.result', (evt) => {
    if (evt.status === 'completed' || evt.status === 'reused') {
        console.log('Orchestrator capsule:', evt.capsuleText);
    }
});
```

</details>

## 相關頁面

- [AI 迭代工作台](/zh-TW/features/orchestrator/iteration-studio) — 編排器核心定製工具，所有模式共用
- [Spec 模式](/zh-TW/features/orchestrator/spec) — 預設 DAG 工作流
- [單 Agent 模式](/zh-TW/features/orchestrator/single) — 退化的 Spec，僅執行一個節點
- [Agenda 模式](/zh-TW/features/orchestrator/agenda) — Planner 動態調度
- [Loop 模式](/zh-TW/features/orchestrator/loop) — 單 Agent 工具循環
- [Director 模式](/zh-TW/features/orchestrator/director) — 多 Agent 接管；出廠自帶 24 個 Skill
- [Skills 概覽](/zh-TW/features/skills/) — 所有模式共用的知識包底層素材
- [便箋 — 作者側劇情線索](/zh-TW/features/orchestrator/notes) — 以 agent 為作者的線索追蹤器，作用域為當前聊天
- [Function Call Runtime](/zh-TW/improvements/function-call-runtime) — Agenda / Loop 模式都依賴此框架
- [角色卡編輯器](/zh-TW/features/card-editor/) — 與迭代工作台共用 diff 引擎
- [卡內綁定預設與人格](/zh-TW/improvements/card-bound-presets) — 編排設定如何隨角色卡一同分發
