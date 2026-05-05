# 多 Agent 編排

是不是有過這種情況:你精心設置了一個場景——劍拔弩張的對峙、微妙的政治談判、慢熱的浪漫——AI 的回覆卻跳過了你剛鋪墊的節奏、忘了兩段以前確立的世界規則、突然出戲跳出來給你做總結、或者把不該這一回合解決的伏筆倉促收尾了。這不是模型笨,是它一次只能想一件事,而你讓它在一次回覆裡同時幹太多了:守人設、調上下文、守世界觀、規劃下一步、*還要*把文筆寫好。

編排器解決這件事的方法是——在主模型動筆之前,先派一支小隊進去。一個 Agent 把最近聊天裡的關鍵狀態抽出來。一個查當前啟用了哪些世界規則。一個起草這一回合該推進什麼。一個審查它們的活兒。最後一個 Agent 把全隊的成果打包成一份精簡的「作業說明」。等到主模型開始寫回覆,它已經拿到了這份說明(並且只是這份),所以可以把它的預算都花在文筆上,而不是繁瑣的核對工作。

你不需要自己設計這一切。編排器自帶一套能跑的預設工作流,**AI 迭代工作台** 讓你用一句話描述需求,然後親眼看著 AI diff-by-diff 把工作流給你搭出來。從打開到能跑,五分鐘。下面這一節帶你走一遍。

::: info 它什麼時候觸發?
編排器在五種生成類型上觸發:`normal`(普通生成)、`continue`(繼續)、`regenerate`(重新生成)、`swipe`(滑動切換)和 `impersonate`(扮演)。它在世界書解析**之後**、主模型回覆**之前**運行。運行軌跡只儲存在記憶體中,切換聊天時會清空。
:::

## 5 分鐘跑起來

這一節用迭代工作台走通,因為它的 diff-by-diff 操作能讓你看見 AI 在幹什麼——快速生成更快,但是黑盒。快速生成後面會單獨講。

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

### Step 3 — 打開 AI 迭代工作台

往下滾到操作按鈕區,點 **打開 AI 迭代工作台**。

![快速生成與迭代工作台按鈕](/images/orchestrator/orch-quickbuild-button.png)

會彈出一個面板。左邊是你和工作台 AI 的對話,右邊是當前編排的狀態。

![迭代工作台主視圖](/images/orchestrator/orch-iteration-studio.png)

### Step 4 — 描述你想要什麼

在輸入框裡寫一句話,描述你希望編排做什麼。越具體越好。

> 例:*「我希望 AI 在每次回覆前先回顧近期重要事件、保持人設一致性,並且不要輕易破規出戲。」*

![輸入框帶示例](/images/orchestrator/orch-iter-input.png)

點 **發送給 AI**。

### Step 5 — 看 AI 幹活

AI 回一段簡短計劃 + 一份 diff,展示它打算改什麼。每條改動是綠色加號(新增)/ 紅色減號(刪除)/ 黃色(修改)。你可以逐條 批准 / 拒絕,或者放手讓它繼續——工作台會自動一輪接一輪推進直到穩定,每輪都有 diff 可看。

![待審批 diff](/images/orchestrator/orch-iter-diff-inline.png)

哪條改動看不懂?點旁邊的放大鏡,左右對比看清楚。

![Diff side-by-side 詳情](/images/orchestrator/orch-iter-diff-side.png)

### Step 6 — 應用

AI 說沒什麼再改的了之後,點 **應用到全域**(到處都用)或 **應用到角色卡**(只對這張卡)。

### Step 7 — 看效果(關鍵)

回主對話發一條訊息。主模型回覆出來之前,編排器會先在後台跑一遍工作流。回覆完後,在編排器面板裡點 **查看運行態軌跡**。

![運行態軌跡總覽](/images/orchestrator/orch-runtime-trace.png)

每個節點卡顯示它產出了什麼。第一階段的 distiller 把最近聊天提煉成一段緊湊的狀態:

![Distiller 節點詳情](/images/orchestrator/orch-runtime-trace-distiller.png)

**這段文字 *不是* 注入主模型的內容。** 它是給下一階段當輸入用的。真正變成「作業說明」注入主模型的,是**最後一階段**節點的輸出:

![最後階段輸出](/images/orchestrator/orch-runtime-trace-laststage.png)

最後一階段的輸出——只有最後一階段——會被打包成一段文字,插到主模型的上下文裡。前面所有階段都是為它做準備。

這就是「AI 想清楚再回覆」的物理含義。如果回覆不對,你可以打開軌跡看清楚是哪一步出了問題,然後把這個觀察反饋給迭代工作台。

## 迭代工作台詳解

一旦你開始調整工作流,迭代工作台是你最常用的工具。它也是最適合教學的功能——每一步都看得見。

### 它能幹什麼

- **多輪對話。** 一句反饋一輪,AI 提一個聚焦的改動方案,你審。
- **逐條審批。** 每條 diff 單獨 批准 / 拒絕,可以只接受一半。
- **模擬測試。** 用當前真實的聊天上下文跑一遍工作流——就像你剛發了條新訊息一樣,世界書也會照常被啟用——但生成結果只展示給你看,*不影響*真實聊天。比如問「我加的 Constraint Agent 真的能擋住 OOC 嗎?」,工作台跑一遍流程,把每個節點輸出都擺給你看。
- **會話保存。** 每個作用域最多 24 個 session,不同卡 / 不同實驗各自一份。
- **回滾。** 已經 Apply 的也能撤。
- **可摺疊思考。** 推理模型的 `<thought>` 標籤預設摺疊;超過 1200 字元的訊息也自動摺疊。

### 一個真實的迭代節奏

> **第 1 輪。** 你:*「AI 不要輕易出戲。」*
> AI:「在 Stage 2 加一個 Constraint Agent,加反破規檢查;啟用 Anti-Data Guard。」 Diff:1 個新節點 + 1 個開關。你 批准。
>
> **第 2 輪。** 你:*「讓它讀知識書,這樣它知道世界規則。」*
> AI:「在 Stage 1 加了一個 `lorebook_reader` 節點,這樣 Constraint Agent 就能看到啟用的世界規則。」 Diff:1 個新節點。批准。
>
> **第 3 輪。** 你:*「模擬一個明顯出戲的輸入,看 Constraint Agent 真能攔住嗎?」*
> AI:切到 模擬模式,用一段假的破規使用者訊息跑一遍工作流,把 Constraint Agent 的判定結果展示給你。

![Simulation 輸出](/images/orchestrator/orch-iter-simulation.png)

> **第 4 輪。** 穩定。點 **應用**。

每一步都是可見的、可中止的、可回退的。這是關鍵。

### 會話管理

不同卡、不同實驗,各自一個 session。

![Session 列表](/images/orchestrator/orch-iter-sessions.png)

會話持久化,刷新後還在,可以是全域作用域也可以綁到某張卡。

### 邊欄 — 快速生成是什麼

快速生成是迭代工作台的一鍵模式。在編排編輯器頂部 **AI 生成目標** 文字框裡輸入需求,點 **AI 快速生成**:

![快速生成輸入區](/images/orchestrator/orch-quickbuild-input.png)

一次 LLM 呼叫之後,你直接拿到完整工作流:

![快速生成結果](/images/orchestrator/orch-quickbuild-result.png)

適合兩種場景:

1. 你已經用迭代工作台調過類似配置很多次,這次只想要個能跑的模板,不想再過流程
2. 你完全不在乎 AI 怎麼決定的,只要預設能用就行

其他場景下,**用迭代工作台更划算**。多花的 1–2 分鐘換來一個你能看懂、能調整的工作流。

## 常見場景配方

| 我想要 | 這樣做 |
|---|---|
| AI 回覆前先想清楚情節再寫 | 迭代工作台描述裡加「分兩階段:先規劃下一步,再寫文」 |
| AI 不要輕易出戲 | 啟用 Anti-Data Guard;迭代工作台描述裡要求「加一個硬擋 meta 評論的 Constraint Agent」,參考上面「一個真實的迭代節奏」 |
| 同一個工作流跨卡通用 | 應用到全域,不要綁卡 |
| 不同卡用不同工作流 | 在角色卡選中狀態打開迭代工作台,**應用到角色卡** |
| 太慢 / 太貴 | 見 [Step 2 省錢提示](#step-2-給各-agent-選模型);或把執行模式從 Spec 切到 單 Agent(只跑一個節點) |
| 想反覆除錯同一個工作流 | 迭代工作台的 session 會話——它會持久化 |
| 換電腦用 | 見下面「匯入匯出」 |
| 全部重置 | 編排編輯器有 **重置全域** 按鈕 |

## 自定義工作流(手搓路線)

到這一節,Stage / Node / DAG 這些術語開始派上用場。簡短定義:

- **Stage 階段** — 工作流的橫向切片。階段間嚴格串行,Stage 2 必須等 Stage 1 跑完才能開始。
- **Node 節點** — 階段內的執行單位。**一個節點 = 一次 LLM 呼叫 + 一段 prompt 模板。**
- **DAG** — 有向無環圖。說人話就是「有先後順序、不會繞回去的流程圖」。

### 三種執行模式

| 模式 | 是什麼 | 何時用 |
|---|---|---|
| **Spec**(預設) | 固定的 Stage → Node DAG。最靈活的靜態工作流。 | 預設。你要一個可預期的管道。 |
| **單 Agent** | 只有一個節點的 Spec——跑一次 LLM,沒有編排開銷。 | 便宜快。不需要多 Agent 協作。 |
| **Agenda** | 一個 Planner Agent 透過工具呼叫動態調度其他 Agent。 | 最靈活。Planner 根據情況決定運行什麼,像個 Agent loop。 |

可以從編輯器的 **複製 Spec Agents 到 Agenda** / **複製 Agenda Agents 到 Spec** 按鈕在兩種模式間轉換(盡力而為)。轉換不完美——Agenda 的動態調度不能完全映射到 Spec 的靜態 DAG。

### Spec 工作流編輯器

從編排器面板打開:**打開編排編輯器**。

![Spec 編輯器](/images/orchestrator/orch-spec-editor.png)

左邊面板是工作流(階段及其節點)。右邊面板是 Agent 預設庫。每個節點引用一個預設,預設攜帶系統提示、使用者提示模板、可選的 API/Chat Completion 預設覆寫、執行旗標。

每個階段有一個執行方式:

- **串行** — 階段內的節點一個接一個跑
- **並行** — 節點用 `Promise.all` 同時跑

每個節點要麼是 **worker**(幹活),要麼是 **review**(審查上一階段的輸出)。

#### 模板變數

使用者提示模板支援以下佔位符:

| 變數 | 含義 |
|---|---|
| <span v-pre>`{{recent_chat}}`</span> | 最近的聊天訊息 |
| <span v-pre>`{{last_user}}`</span> | 最後一條使用者訊息 |
| <span v-pre>`{{previous_outputs}}`</span> | 前序階段的輸出 |
| <span v-pre>`{{distiller}}`</span> | 蒸餾器節點的輸出 |
| <span v-pre>`{{previous_orchestration}}`</span> | 上一回合的編排結果。**運行時自動注入,模板裡一般不用寫。** |

### 審查節點

審查節點檢查上一個工作階段的輸出,透過兩個專用工具呼叫與運行時互動:

| 工具 | 作用 |
|---|---|
| `luker_orch_review_approve` | 工作合格,推進到下一階段 |
| `luker_orch_request_rerun` | 一個或多個節點需要重做,附帶修改建議 |

約束:

- 審查節點只能審 **直接相鄰的前一個工作階段** 的節點
- 重跑作用於具體節點 ID,不是整個階段
- 重跑次數受 **審查重跑最大輪數** 控制(預設 2,最大 20)。設為 0 時,審查節點只能「通過或失敗」,不能重跑
- 重跑後審查節點重新跑,形成「執行 → 審查 → 重跑 → 再審查」的循環,直到通過或達到上限
- 審查節點必須輸出審查反饋

### Agenda 模式

Agenda 用一個 Planner Agent 替換靜態 DAG,Planner 透過工具呼叫其他 Agent。

![Agenda 編輯器](/images/orchestrator/orch-agenda-editor.png)

Planner 維護 todo 列表,讀每個 Agent 的輸出,決定下一步派誰去。三個運行時上限:

- **Planner 最大輪數** — Planner 調度的輪數上限
- **最大並發 Agent 數** — 同時跑的 Agent 數量上限
- **總執行次數上限** — 整次跑裡所有 Agent 呼叫次數總和

Agenda 模式依賴 Luker 的 [Function Call Runtime](/improvements/function-call-runtime) 框架。

## 角色卡綁定

編排配置可以綁到角色卡。綁定後:

- 配置隨卡匯出。別人匯入卡片自動獲得推薦工作流
- 卡作者可以為自己的角色定製最優工作流
- 切換到這張卡自動套用其工作流
- 卡可以指定自己的執行模式(Spec/Single/Agenda)
- 卡覆寫可以獨立啟用 / 停用,不影響全域
- 「清除卡覆寫」恢復到全域配置
- 你可以在卡綁定配置上層疊個人調整

## 匯入匯出

配置以 JSON 匯出。

| 格式 | 標識 | 適用 |
|---|---|---|
| V1 | `luker_orchestrator_profile_v1` | Spec 模式 |
| V2 | `luker_orchestrator_profile_v2` | Agenda 模式 |

檔名形如 `luker-orchestrator-[agenda-][global|character-{name}].json`。匯出器同時支援全域和角色卡作用域。

匯入時,檔案的模式(Spec/Agenda)必須和你當前執行模式一致。你選擇套用到全域或某張特定的卡。

## 結果注入

編排器的最終輸出(「capsule」)會被注入到主模型 prompt 裡。配置:

| 設定 | 預設 | 說明 |
|---|---|---|
| 注入位置 | `atDepth` | capsule 在 prompt 裡的位置 |
| 注入深度 | `0` | 在該位置的深度 |
| 注入角色 | `SYSTEM` | `SYSTEM` / `USER` / `ASSISTANT` 之一 |
| 自定義指令前綴 | (預設一句話) | 加在 capsule 文字前面 |

capsule 綁定到觸發編排的使用者訊息樓層。同一樓層 swipe 時,系統會複用現有 capsule 而不是重跑。配置變更時,系統會重新套用最新結果。

## 配置參考

最常用的幾項(Quick Start 已涵蓋):

| 設定 | 預設 |
|---|---|
| 執行模式 | `spec` |
| 注入位置 | `atDepth` |
| 注入深度 | `0` |
| 注入角色 | `SYSTEM` |
| 節點迭代最大輪數 | — |
| 審查重跑最大輪數 | `2`(最大 20) |

<details>
<summary>完整配置參考</summary>

| 設定 | 說明 |
|---|---|
| 執行模式 | Spec / 單 Agent / Agenda |
| 注入位置 | capsule 在主 prompt 中的位置 |
| 注入深度 | 注入深度 |
| 注入角色 | `SYSTEM` / `USER` / `ASSISTANT` |
| 自定義指令前綴 | 加在 capsule 前的前綴文字 |
| Planner 最大輪數 | 僅 Agenda 模式 |
| 最大並發 Agent 數 | 僅 Agenda 模式 |
| 總執行次數上限 | 僅 Agenda 模式 |
| RPM 限制 | 並行節點的速率限制 |
| Agent 超時 | 單 Agent 超時秒數 |
| 工具呼叫重試次數 | 工具呼叫失敗的重試次數 |
| 節點迭代最大輪數 | 單節點的迭代上限 |
| 審查重跑最大輪數 | 0 停用審查驅動的重跑;最大 20 |
| 全域 API 預設 | 預設 API 連接預設 |
| 全域 Chat Completion 預設 | 預設 Chat Completion 預設 |
| 包含世界書 | 節點是否能看到世界書 |
| Anti-Data Guard | 預設 Spec 工作流裡的一個內建節點,屏蔽資料化 / 報告腔的散文(諸如 觀察 / 分析 / 評估 / 監測 / observation / analyze / metric / probability 這種把 RP 寫成觀察日誌或參數表的詞)。硬編碼約 18 個詞的詞典。不想要的話直接把這個節點從工作流裡刪掉。 |
| `<thought>` 標籤剝離 | 從 Agent 輸出剝離思考標籤 |
| 訊息摺疊閾值 | 1200 字元 / 18 行 |
| 節點 API 預設 | 節點級覆寫;留空 = 全域 |
| 節點 Chat Completion 預設 | 節點級覆寫;留空 = 全域 |

每個節點可以用不同的 API 和 Chat Completion 預設,所以你可以讓蒸餾器走便宜模型、合成器走高品質模型。

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

- [Function Call Runtime](/improvements/function-call-runtime) — Agenda 模式的 Planner 依賴此框架
- [角色卡編輯器](/features/card-editor) — 與迭代工作台共用 diff 引擎
- [卡內綁定預設與人格](/improvements/card-bound-presets) — 編排配置如何隨角色卡走
