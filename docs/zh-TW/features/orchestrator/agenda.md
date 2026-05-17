# Agenda 模式

Agenda 用一個 **Planner Agent** 替換 Spec 的靜態 DAG。Planner 維護 todo 列表,透過工具呼叫動態調度其他 Agent,讀它們的輸出,決定下一步派誰去——本質是一個 Agent loop。

什麼時候用 Agenda 而不是 Spec:

- 流程要根據中間結果決定下一步派誰。比如「先看看使用者輸入有沒有破規傾向,有的話才啟動 Constraint Agent」——這種「有條件觸發」在 Spec 的固定 DAG 裡很彆扭。
- 你想要更靈活的多 Agent 協作,而不是固定的 stage → node 拓撲。
- 用 [Function Call Runtime](/zh-TW/improvements/function-call-runtime) 的能力讓 Planner 自己組織調度。

::: tip Agenda 不是 Spec 的替代
Spec 的可預期性、prompt 快取友好度、debug 友好度都比 Agenda 強。絕大多數 RP 場景固定 DAG 已經夠用,Agenda 是給確實需要動態調度的場景準備的。
:::

::: warning 99% 的人不該手撸
手撸 Planner prompt 之前先看一眼 [AI 迭代工作台](/zh-TW/features/orchestrator/iteration-studio)——一句話描述需求,AI 給你一份 Planner + Agent 池的方案,逐條審。
:::

## Agenda 編輯器

切到 Agenda 模式後,從編排器面板點 **打開編排編輯器**。

![Agenda 編輯器](/images/orchestrator/orch-agenda-editor.png)

左邊是 **Planner Prompt** 設定區(API 預設、提示詞預設、System Prompt、Planner Prompt 模板);右邊是可用的 Agenda Agents 列表——Planner 透過工具呼叫從這個池子裡挑 Agent 派任務。

### Planner

Planner 是 Agenda 的核心,它做幾件事:

1. 讀最近聊天 + 使用者訊息
2. 維護一個 todo 列表(下一步該做什麼)
3. 調度 Agenda Agent 池裡的 Agent 去做任務
4. 收集 Agent 輸出
5. 根據收集到的內容決定下一步,或者認為足夠了就停下,把最後一個 Agent 輸出當 capsule 注入主模型

### Agenda Agents

每個 Agenda Agent 類似 Spec 的 Node:有自己的 System Prompt、User Prompt Template、可選的 API / Chat Completion 預設覆寫。區別在於 Agent 不綁死在某個 stage,**何時被呼叫、被呼叫幾次、是否被呼叫,都由 Planner 決定**。

### 三個運行時上限

Agenda 是動態調度,失控容易,所以有三道閘:

- **Planner 最大輪數** — Planner 調度的輪數上限
- **最大並發 Agent 數** — 同時跑的 Agent 數量上限(`Promise.all` 的並發度)
- **總執行次數上限** — 整次跑裡所有 Agent 呼叫次數總和

到任一上限就強制收尾。

## 預設編排流程

Agenda 把節奏交給 Planner Agent 來定,Planner 每輪從一個 worker 池裡挑人派活。預設 profile 自帶 Planner + 5 個 worker(`distiller`、`lorebook_reader`、`planner`、`critic`、`finalizer`);每輪 Planner 派出一個或多個 worker、讀回結果、必要時重新規劃,看板搞定後由 `finalizer` 落筆寫 capsule。

```d2
direction: down

start: "新一回合開始" {
  shape: oval
  style.fill: "#e8f5e9"
}

loop: "Planner 主導的動態調度" {
  style.fill: "#e1f5ff"

  driver: "Planner\n看一眼已完成的工作 · 更新 todo 看板 ·\n派 worker 處理任務 · 判斷何時收尾" {
    style.fill: "#fffde7"
  }

  pool: "預設 worker 池 —— Planner 按 todo 挑人派" {
    style.fill: "#fff3e0"
    distiller: "distiller\n緊湊的狀態讀取" {
      style.fill: "#fffde7"
    }
    lorebook_reader: "lorebook_reader\n當前世界書硬約束" {
      style.fill: "#fffde7"
    }
    planner: "planner\n下一拍進程規劃" {
      style.fill: "#fffde7"
    }
    critic: "critic\n審計指定材料" {
      style.fill: "#fffde7"
    }
  }

  driver -> pool: "平行派一個或多個"
  pool -> driver: "結果回收 · 必要時重新規劃"
}

finalizer: "finalizer\n讀完最終的看板 · 落筆寫編排指引 capsule" {
  style.fill: "#c8e6c9"
}

out: "capsule 注入下一句主回覆" {
  shape: oval
  style.fill: "#f3e5f5"
}

start -> loop.driver
loop.driver -> finalizer: "收尾"
finalizer -> out
```

預設 agent 在編排裡各自負責什麼:

| Agent | 作用 | 簡單範例(RP 場景) |
|---|---|---|
| `Planner`(迴圈駕駛員,非 worker) | 讀聊天和使用者訊息,維護 todo 看板(`add` / `set_status` / `drop`),每輪從下面的 worker 池裡挑一個或多個派活,讀回結果,決定是繼續規劃還是交給 `finalizer`。 | 第 1 輪:平行派 `distiller` + `lorebook_reader`。第 2 輪:讀完輸出,判斷還需要 `planner` 與 `critic`。第 3 輪:交給 `finalizer`。 |
| `distiller` | 緊湊、有據可查的場景狀態讀取(使用者意圖、當前張力、即時方向);寫給 Planner 與下游 agent 看,不直接面向玩家。 | 「林晚在試探使用者對洛陽話題的態度;如果使用者繞開,她會徹底換話題。」 |
| `lorebook_reader` | 只挑出本回合**真的有影響**的世界書 / world-info 約束,寫成可執行的寫作 / 行為約束,不抄世界書原文。 | 「洛陽被圍 —— 林晚不可能離開。文風:別用現代詞,她會說『不知怎的』而非『somehow』。」 |
| `planner` | 場景進程分析師 —— 提下一拍該走哪些 beat / 決策點,保留因果、不讓世界圍著使用者轉。 | 節拍:「使用者追問 → 她躲閃 → 換個角度再問 → 她漏出一個洛陽細節 → 回覆停在那」。 |
| `critic` | 審 Planner 派過來的材料(連續性斷裂、OOC 漂移、缺失硬約束、anti-data、不合理的因果),給審計結論;不親自改寫指引。 | 「這個計劃裡林晚說『沒什麼大不了』—— 現代腔調,這角色 OOC。其它通過。」 |
| `finalizer`(Final Agent —— 整個流程的最後一站,只跑一次) | 讀完最終的 todo 狀態和選定的歷次 run,合成一段簡潔、可直接拿來起稿下一回合的編排指引文字 —— 就是最後注入主回覆的那段 capsule。 | capsule:「林晚:躲閃 → 被追問 → 漏出一個洛陽姑姑的細節。用詞保持古樸;她還在被圍的洛陽城內。」 |

## AI 迭代工作台

和 Spec 一樣,Agenda 也有 AI 迭代工作台支援——自然語言描述 Planner 行為 / Agent 池構成,AI 幫你搭。詳見 [AI 迭代工作台](/zh-TW/features/orchestrator/iteration-studio)。Quick Build 也適用 Agenda。

## 與 Spec 的互轉

編排編輯器裡有 **複製 Spec Agents 到 Agenda** / **複製 Agenda Agents 到 Spec** 按鈕可以快速搬運 Agent 池(盡力而為)。**注意**:

- Spec → Agenda 時,stage 拓撲資訊丟失,需要你重新寫 Planner Prompt 描述調度邏輯
- Agenda → Spec 時,Planner 的動態調度無法完整對映到固定 DAG,需要你手動決定 stage 劃分

## Function Call Runtime 依賴

Agenda 模式的 Planner 調度透過 OpenAI 工具呼叫實現,依賴 Luker 的 [Function Call Runtime](/zh-TW/improvements/function-call-runtime) 框架。這意味著:

- Planner 用的連接設定必須支援 function calling(OpenAI / Claude / Gemini 都支援)
- 工具呼叫失敗時的重試由 Function Call Runtime 處理(詳見對應文件)

## Trace 面板

主回覆出來後在編排器面板點 **查看運行態軌跡**,Agenda 的 trace 彈窗會按幾塊鋪出整次 run——頂部元資訊 + 任務看板、Planner 每一輪的輸入輸出、流程事件時間線、原始 JSON。

### 面板概覽 + 任務看板

頂部狀態摘要裡 Agenda 模式獨有的一項是 **節點執行次數**——所有 worker 被調度的總次數,觸發「總執行次數上限」那道閘時看的就是這個。REVIEW 重跑次數對 Agenda 不適用,會一直是 0。

緊跟在下面的「任務看板」是 4 列 Kanban:**待辦 / 進行中 / 完成 / 阻塞**,每張卡片顯示 todo id、目標 agent 與 goal 描述。看板逐輪更新,run 結束後保留終態——看完成列裡 todo 的先後順序就能知道 Planner 實際派活的節奏。

![Agenda trace 面板:元資訊 + 任務看板四列狀態](/images/orchestrator/real-agenda-meta.png)

### Planner 輪次

「Planner 輪次」是 Agenda 最有價值的排錯視圖。每一輪裡左側是 Planner agent 本輪的輸出(`todo_ops` 列表:`set_status` / `add` / `set_goal` 等),右側是該輪被派發的 worker 們及它們各自的輸出。Planner 的「會話」也在這裡:`系統` 塊 + `使用者` 塊就是 Planner 收到的完整 prompt。

![Agenda Planner 輪次:第 1 輪的 Planner 輸出 + dispatch 出的 worker](/images/orchestrator/real-agenda-planner-rounds.png)

發現 Planner 派錯 agent / 漏掉某步 / 死循環時,直接對照這裡的 `todo_ops` 與 worker 輸出找根因。

### 流程事件

「流程事件」按時間序號鋪出每個事件:`Run started` → 多組 `worker started` / `worker completed`(每次 Planner 調度都是一對),最後 `Run completed`。

![Agenda 流程事件:Run started → 多組 worker_started/completed → Run completed](/images/orchestrator/real-agenda-events.png)

事件密度比 spec 高:Agenda 一次 run 通常會有 20+ 事件,Planner 輪次 + 各 agent 調度都會留下記錄。事件末尾出現的 `finalizer` 就是預設的 **Final Agent**,在設定參考裡能換成其他 agent id。

### 原始軌跡

面板最底下「最新注入文本」是 Final Agent 的輸出——也就是注入主模型的 capsule。再往下「原始運行態軌跡」是整次 run 的 JSON 形態,包含 `runId`、`chatKey`、`generationType`、`capsuleText`、`note` 等頂層欄位。

![Agenda 原始軌跡 JSON 與最新注入文本](/images/orchestrator/real-agenda-rawtrace.png)

報 bug 時點「匯出本次 run」會下載這份 JSON 的 jsonl 形式,直接附給開發者。

## Agenda 設定參考

<details>
<summary>Agenda 專屬設定</summary>

| 設定 | 說明 |
|---|---|
| Planner 最大輪數 | Planner 調度的輪數上限 |
| 最大並發 Agent 數 | 同時跑的 Agent 數量上限 |
| 總執行次數上限 | 整次跑裡所有 Agent 呼叫次數總和 |
| Planner API 預設 | Planner 節點用的 Connection profile |
| Planner Chat Completion 預設 | Planner 節點用的提示詞預設 |
| Planner System Prompt | Planner 的 system 指令 |
| Planner Prompt 模板 | Planner 的 user prompt 模板 |
| Final Agent | 收尾時把哪個 Agent 的輸出當 capsule |
| Agenda Agent 池 | 各 Agent 的預設 / prompt(可獨立覆寫 API 與 Chat Completion 預設) |

</details>

## 相關頁面

- [編排器概覽](/zh-TW/features/orchestrator/) — 通用設定 / 觸發時機 / 角色卡綁定
- [AI 迭代工作台](/zh-TW/features/orchestrator/iteration-studio) — AI 幫你寫 Planner + Agent 池(推薦)
- [Spec 模式](/zh-TW/features/orchestrator/spec) — 預設的 DAG 模式
- [Loop 模式](/zh-TW/features/orchestrator/loop) — 單 Agent 工具循環
- [Function Call Runtime](/zh-TW/improvements/function-call-runtime) — Planner 調度依賴此框架
