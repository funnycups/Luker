# 多 Agent 編排

是不是有過這種情況:你精心設置了一個場景——劍拔弩張的對峙、微妙的政治談判、慢熱的浪漫——AI 的回覆卻跳過了你剛鋪墊的節奏、忘了兩段以前確立的世界規則、突然出戲跳出來給你做總結、或者把不該這一回合解決的伏筆倉促收尾了。這不是模型笨,是它一次只能想一件事,而你讓它在一次回覆裡同時幹太多了:守人設、調上下文、守世界觀、規劃下一步、*還要*把文筆寫好。

編排器解決這件事的方法是——在主模型動筆之前,先派一支小隊進去。一個 Agent 把最近聊天裡的關鍵狀態抽出來。一個查當前啟用了哪些世界規則。一個起草這一回合該推進什麼。一個審查它們的活兒。最後一個 Agent 把全隊的成果打包成一份精簡的「作業說明」。等到主模型開始寫回覆,它已經拿到了這份說明(並且只是這份),所以可以把它的預算都花在文筆上,而不是繁瑣的核對工作。

**編排器自帶一套能跑的預設 Spec 工作流——你不用先設計什麼,啟用就能用。** 後面想換玩法、想自己改,各執行模式都有獨立編輯器。

::: info 它什麼時候觸發?
編排器在五種生成類型上觸發:`normal`(普通生成)、`continue`(繼續)、`regenerate`(重新生成)、`swipe`(滑動切換)和 `impersonate`(扮演)。它在世界書解析**之後**、主模型回覆**之前**運行。運行軌跡只儲存在記憶體中,切換聊天時會清空。
:::

## 5 分鐘跑起來(用預設編排)

不用先選模式、不用先寫工作流——預設 Spec 已經能跑。下面這一節帶你把它啟動起來,看清楚它到底替你幹了什麼。

### Step 0 — 你需要先有什麼

- 你的主對話已經能正常用 Chat Completion API 出回覆
- 當前對話至少有 3 輪以上聊天記錄(沒有內容,工作流沒什麼可規劃的)

### Step 1 — 啟用編排器

打開頂欄的擴展抽屜,找到 **多智能體編排** 那一節。把 **啟用** 開關打開。

![編排器開關與預設](/images/orchestrator/orch-toggle.png)

### Step 2 — 給各 Agent 選模型

在同一面板裡繼續往下看,找到 **LLM 節點 API 預設** 和 **AI 生成 API 預設**。這兩個欄位告訴編排器各 Agent 用哪個 API、哪個 Chat Completion 預設。

::: tip 這裡能省錢
編排器一次跑會調 5–10 次 LLM(每個節點一次)。如果主對話用的是 Claude Opus 這種貴的,這裡挑一個便宜模型——Haiku、Gemini Flash 之類——能省 70% 以上成本。如果需要更高品質,可以給不同節點配不同模型(每個節點都能單獨覆寫 API/預設)。
:::

### Step 3 — 直接發一條訊息

回主對話發條訊息——不用動其他設定。主模型回覆之前,預設 Spec 工作流會自動在後台跑一遍。第一次跑會比平時慢一點(順序調 5–10 個 Agent),後續就習慣了。

### Step 4 — 看它替你幹了什麼

回覆出來後,在編排器面板裡點 **查看運行態軌跡**。

![運行態軌跡總覽](/images/orchestrator/orch-runtime-trace.png)

每個節點卡顯示它產出了什麼。第一階段的 distiller 把最近聊天提煉成一段緊湊的狀態:

![Distiller 節點詳情](/images/orchestrator/orch-runtime-trace-distiller.png)

**這段文字 *不是* 注入主模型的內容。** 它是給下一階段當輸入用的。真正變成「作業說明」注入主模型的,是**最後一階段**節點的輸出:

![最後階段輸出](/images/orchestrator/orch-runtime-trace-laststage.png)

最後一階段的輸出——只有最後一階段——會被打包成一段文字,插到主模型的上下文裡。前面所有階段都是為它做準備。

這就是「AI 想清楚再回覆」的物理含義。如果回覆不對,你可以打開軌跡看清楚是哪一步出了問題。

到這裡你已經在用編排器了。下面三件事按需選:

- 預設 Spec 流程不夠用,想自己 / 讓 AI 幫你改 → [Spec 模式](/zh-TW/features/orchestrator/spec)
- 流程要根據情況動態變,不能寫死 DAG → [Agenda 模式](/zh-TW/features/orchestrator/agenda)
- 想讓一個 Agent 反覆呼叫工具(查記憶、查世界書...)直到它自己說「夠了」 → [Loop 模式](/zh-TW/features/orchestrator/loop)

::: tip 不管你選哪種模式,定製都從這裡開始
**[AI 迭代工作台](/zh-TW/features/orchestrator/iteration-studio)** 是編排器的核心定製工具——一句話描述需求,AI 給方案,逐條審。Spec / Agenda / Loop 三種模式都共用這個工作台,**99% 的定製場景下都比手撸划算**。
:::

## 選你的執行模式

| 模式 | 是什麼 | 何時用 | 詳細文件 |
|---|---|---|---|
| **Spec**(預設) | 固定的 Stage → Node DAG | 預設。你要一個可預期的管道 | [Spec 模式](/zh-TW/features/orchestrator/spec) |
| **單 Agent** | 只有一個節點的 Spec | 便宜快。不需要多 Agent 協作 | [單 Agent 模式](/zh-TW/features/orchestrator/single) |
| **Agenda** | 一個 Planner Agent 透過工具呼叫動態調度其他 Agent | 流程要動態決定運行什麼,像 Agent loop | [Agenda 模式](/zh-TW/features/orchestrator/agenda) |
| **Loop** | 單 Agent 在同一會話裡循環呼叫工具,自己決定何時 `finalize` | 速度與效果之間想要平衡;探索性研究、動態決策 | [Loop 模式](/zh-TW/features/orchestrator/loop) |

切換模式:擴展抽屜裡 **執行模式** 下拉。Spec 與 Agenda 之間可以從編輯器裡互轉(盡力而為);Loop 模式結構差異較大,沒有這種互轉入口。

::: tip 想定製?優先用 AI 迭代工作台
切到任何模式後,**[AI 迭代工作台](/zh-TW/features/orchestrator/iteration-studio)** 都是優先選擇。Spec / Agenda 給你 diff,Loop 直接 patch profile,流程一致。
:::

## 通用設定

無論選哪種模式,以下設定都共享。

### 結果注入

編排器的最終輸出(「capsule」)會被注入到主模型 prompt 裡。設定:

| 設定 | 預設 | 說明 |
|---|---|---|
| 注入位置 | `atDepth` | capsule 在 prompt 裡的位置 |
| 注入深度 | `0` | 在該位置的深度 |
| 注入角色 | `SYSTEM` | `SYSTEM` / `USER` / `ASSISTANT` 之一 |
| 自定義指令前綴 | (預設一句話) | 加在 capsule 文字前面 |

capsule 綁定到觸發編排的使用者訊息樓層。同一樓層 swipe 時,系統會複用現有 capsule 而不是重跑。設定變更時,系統會重新套用最新結果。

### 角色卡綁定

編排設定可以綁到角色卡。綁定後:

- 設定隨卡匯出。別人匯入卡片自動獲得推薦工作流
- 卡作者可以為自己的角色定製最優工作流
- 切換到這張卡自動套用其工作流
- 卡可以指定自己的執行模式(Spec / 單 Agent / Agenda / Loop 都支援)
- 卡覆寫可以獨立啟用 / 停用,不影響全域
- 「清除卡覆寫」恢復到全域設定
- 你可以在卡綁定設定上層疊個人調整

四種模式現在都支援卡覆寫。

### 匯入匯出

Spec 與 Agenda 設定以 JSON 匯出。

| 格式 | 標識 | 適用 |
|---|---|---|
| V1 | `luker_orchestrator_profile_v1` | Spec 模式 |
| V2 | `luker_orchestrator_profile_v2` | Agenda 模式 |

檔名形如 `luker-orchestrator-[agenda-][global|character-{name}].json`。匯出器同時支援全域和角色卡作用域。

匯入時,檔案的模式(Spec / Agenda)必須和你當前執行模式一致。你選擇套用到全域或某張特定的卡。

::: info Loop 模式的匯入匯出
Loop 模式當前還沒接入檔案級的 Profile 匯入匯出按鈕,改用 [AI 迭代工作台](/zh-TW/features/orchestrator/iteration-studio) 複用工作流。
:::

### 通用設定參考

最常用的幾項:

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
| Agent 逾時 | 單 Agent 逾時秒數 |
| 工具呼叫重試次數 | 工具呼叫失敗的重試次數 |
| 全域 API 預設 | 預設 API 連接預設 |
| 全域 Chat Completion 預設 | 預設 Chat Completion 預設 |
| 包含世界書 | 節點是否能看到世界書 |
| `<thought>` 標籤剝離 | 從 Agent 輸出剝離思考標籤 |
| 訊息摺疊閾值 | 1200 字元 / 18 行 |

模式專屬的參數(節點 / 審查 / Planner / Loop 工具開關...)在各自的子頁面裡詳述。

</details>

## 事件 / 二開 API

<details>
<summary>給其他擴展和腳本</summary>

編排器在每次運行結果後會派發一個前端事件,其他程式碼可以消費編排結果而不必讀 UI 內部狀態。

- **事件名:** `luker.orchestrator.result`
- **頻道:** `getContext().eventSource`
- **觸發時機:** `completed` / `reused` / `cancelled` / `failed` 時

事件載荷欄位:

| 欄位 | 型別 | 說明 |
|---|---|---|
| `module` | string | 始終為 `orchestrator` |
| `event` | string | 始終為 `luker.orchestrator.result` |
| `status` | string | `completed` / `reused` / `cancelled` / `failed` |
| `generationType` | string | 觸發的生成類型 |
| `chatKey` | string | 當前聊天 key |
| `at` | string | ISO 時間戳 |
| `anchorPlayableFloor` | number | 綁定的使用者回合樓層(不可用時為 0) |
| `anchorHash` | string | 用於校驗的 anchor hash |
| `capsuleText` | string | 最終注入的引導文字 |
| `stageOutputs` | array | 緊湊的階段輸出(`completed` / `reused` 時存在) |
| `reviewRerunCount` | number | 審查重跑次數 |
| `reason` | string | 取消 / 失敗的機器可讀原因 |
| `note` | string | 人類可讀說明 |
| `error` | string | `failed` 時的錯誤訊息 |

訂閱範例:

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

- [AI 迭代工作台](/zh-TW/features/orchestrator/iteration-studio) — 編排器核心定製工具,所有模式共用
- [Spec 模式](/zh-TW/features/orchestrator/spec) — 預設 DAG 工作流
- [單 Agent 模式](/zh-TW/features/orchestrator/single) — 退化的 Spec,只跑一個節點
- [Agenda 模式](/zh-TW/features/orchestrator/agenda) — Planner 動態調度
- [Loop 模式](/zh-TW/features/orchestrator/loop) — 單 Agent 工具循環
- [Function Call Runtime](/zh-TW/improvements/function-call-runtime) — Agenda / Loop 模式都依賴此框架
- [角色卡編輯器](/zh-TW/features/card-editor/) — 與迭代工作台共用 diff 引擎
- [卡內綁定預設與人格](/zh-TW/improvements/card-bound-presets) — 編排設定如何隨角色卡走
