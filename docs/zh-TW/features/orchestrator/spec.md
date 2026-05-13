# Spec 模式

Spec 是編排器的預設模式,也是其他模式的「基準」。它把工作流拆成一串 **階段(Stage)**,每個階段裡若干 **節點(Node)** 串行或並行跑;階段間嚴格串行,前一階段所有節點都收工後才進入下一階段。每個節點 = 一次 LLM 呼叫 + 一段 prompt 模板。最後一個階段產出「作業說明」注入主模型,前面所有階段都是為它做準備。

::: tip 你已經在用了
啟用編排器時預設就是 Spec,而且自帶一套能跑的工作流(distiller、規劃、約束、審查、合成器...)。這份文件的目標是:**改預設工作流、寫新工作流、理解為什麼預設這樣設計**。
:::

::: warning 99% 的人不該手撸
手撸 stage / node 之前先看一眼 [AI 迭代工作台](/zh-TW/features/orchestrator/iteration-studio)——一句話描述需求,AI 給方案,逐條審。手撸只在工作台搞不定的極致定製場景才用。
:::

## 概念速覽

到這一節,幾個術語開始派上用場。簡短定義:

- **Stage 階段** — 工作流的橫向切片。階段間嚴格串行,Stage 2 必須等 Stage 1 跑完才能開始。
- **Node 節點** — 階段內的執行單位。**一個節點 = 一次 LLM 呼叫 + 一段 prompt 模板**。
- **DAG** — 有向無環圖。說人話就是「有先後順序、不會繞回去的流程圖」。

每個階段有一個執行方式:

- **串行** — 階段內的節點一個接一個跑
- **並行** — 節點用 `Promise.all` 同時跑

每個節點要麼是 **worker**(幹活),要麼是 **review**(審查上一階段的輸出)。

## 手撸:Spec 工作流編輯器

工作台搞不定的極致定製場景,直接動 stage / node。從編排器面板打開:**打開編排編輯器**。

![Spec 編輯器](/images/orchestrator/orch-spec-editor.png)

左邊面板是工作流(階段及其節點)。右邊面板是 Agent 預設庫。每個節點引用一個預設,預設攜帶系統提示、使用者提示模板、可選的 API/Chat Completion 預設覆寫、執行旗標。

### 模板變數

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

## 常見場景配方

| 我想要 | 這樣做 |
|---|---|
| AI 回覆前先想清楚情節再寫 | [AI 迭代工作台](/zh-TW/features/orchestrator/iteration-studio)描述裡加「分兩階段:先規劃下一步,再寫文」 |
| AI 不要輕易出戲 | 啟用 Anti-Data Guard;[AI 迭代工作台](/zh-TW/features/orchestrator/iteration-studio)描述裡要求「加一個硬擋 meta 評論的 Constraint Agent」 |
| 同一個工作流跨卡通用 | 套用到全域,不要綁卡 |
| 不同卡用不同工作流 | 在角色卡選中狀態打開工作台,**套用到角色卡** |
| 太慢 / 太貴 | 見[概覽 → Step 2](/zh-TW/features/orchestrator/#step-2-給各-agent-選模型);或切到 [單 Agent 模式](/zh-TW/features/orchestrator/single) 只跑一個節點 |
| 想反覆除錯同一個工作流 | 工作台的 session 會話——它會持久化 |
| 換電腦用 | 見[概覽 → 匯入匯出](/zh-TW/features/orchestrator/#匯入匯出) |
| 全部重置 | 編排編輯器有 **重置全域** 按鈕 |

## Trace 面板

主回覆出來後在編排器面板點 **查看運行態軌跡**,Spec 的 trace 彈窗會按幾塊鋪出整次 run——頂部元資訊 + 流程圖、執行時間線、流程事件、對話與原始資料。

### 面板概覽 + 流程圖

頂部狀態摘要裡 Spec 模式相關的幾項:**節點執行次數**(所有 worker 跑了多少次)、**REVIEW 重跑次數**(審查節點驅動的重跑次數,預設上限 2 次,可在設定參考裡調到 0 關閉或 20 上限)。

緊跟在下面的「流程圖」視覺化整條 DAG:每個 stage 是一個色塊,內部按節點 id 排出 worker 卡片。點擊某張卡片可以在右側「執行時間線」裡跳到對應 worker 的詳情。

![Spec trace 面板:元資訊 + 流程圖 + 執行時間線右側展示 worker 詳情](/images/orchestrator/real-spec-meta.png)

### 執行時間線

「執行時間線」是右側詳情面板,展示選中 worker 的完整輸出。Spec 節點的輸出形態由節點的 prompt 模板決定——此例裡 distiller 節點輸出了一段 `summary` + 一段 `xml_guidance`(帶 `<story_state>` / `<location>` / `<key_items>` 這類 XML 標籤),後續 stage 可以解析它取出結構化欄位。

![Spec 執行時間線:展開 worker 詳情查看 summary 與 xml_guidance](/images/orchestrator/real-spec-timeline.png)

### 流程事件

「流程事件」按時間序號鋪出整條 DAG 的執行節奏:`Run started` → 每個 stage 的 `stage_started` → 各 worker 的 `worker_started` / `worker_completed`(同 stage 內並行的 worker 時間戳會很接近)→ `stage_completed` → 下一個 stage,最後 `Run completed`。

![Spec 流程事件:stage_started → worker_started/completed → stage_completed,串行展開整條 DAG](/images/orchestrator/real-spec-events.png)

如果某個 stage 觸發了審查重跑,事件流裡會看到該 worker 多次 `worker_started` / `worker_completed`——拿這個數和頂部 **REVIEW 重跑次數** 對一下就知道審查節點駁回了幾次。

### 原始軌跡

面板最底下「最新注入文本」是最後一個 stage 的輸出——也就是注入主模型的 capsule。再往下「原始運行態軌跡」是整次 run 的 JSON 形態,頂層欄位包含 `runId`、`chatKey`、`generationType`、`capsuleText` 等。

![Spec 原始軌跡 JSON 與最新注入文本](/images/orchestrator/real-spec-rawtrace.png)

報 bug 時點「匯出本次 run」會下載這份 JSON 的 jsonl 形式,直接附給開發者。

## Spec 設定參考

<details>
<summary>Spec 專屬設定</summary>

| 設定 | 說明 |
|---|---|
| 節點迭代最大輪數 | 單節點的迭代上限 |
| 審查重跑最大輪數 | 0 停用審查驅動的重跑;最大 20 |
| Anti-Data Guard | 預設 Spec 工作流裡的一個內建節點,屏蔽資料化 / 報告腔的散文(諸如 觀察 / 分析 / 評估 / 監測 / observation / analyze / metric / probability 這種把 RP 寫成觀察日誌或參數表的詞)。硬編碼約 18 個詞的詞典。不想要的話直接把這個節點從工作流裡刪掉。 |
| 節點 API 預設 | 節點級覆寫;留空 = 全域 |
| 節點 Chat Completion 預設 | 節點級覆寫;留空 = 全域 |

每個節點可以用不同的 API 和 Chat Completion 預設,所以你可以讓蒸餾器走便宜模型、合成器走高品質模型。

</details>

## 相關頁面

- [編排器概覽](/zh-TW/features/orchestrator/) — 通用設定 / 觸發時機 / 角色卡綁定
- [AI 迭代工作台](/zh-TW/features/orchestrator/iteration-studio) — AI 幫你改預設 Spec 流程(99% 場景下推薦)
- [單 Agent 模式](/zh-TW/features/orchestrator/single) — 退化的 Spec,只跑一個節點
- [Agenda 模式](/zh-TW/features/orchestrator/agenda) — Planner 動態調度版本
- [Loop 模式](/zh-TW/features/orchestrator/loop) — 單 Agent 工具循環
- [角色卡編輯器](/zh-TW/features/card-editor/) — 與迭代工作台共用 diff 引擎
