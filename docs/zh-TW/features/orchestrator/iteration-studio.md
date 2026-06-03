# AI 迭代工作台

AI 迭代工作台是編排器的**主要定製方式**。99% 的人不需要手撸 stage / node 或者寫 Planner prompt——工作台讓你用一句話描述需求，AI 給你一份方案，你逐條審，穩定了點 Apply。Spec / Agenda / Loop 三種執行模式都共用這個工作台，只是產出物不同。

::: tip 先用它，搞不定再手搓
如果你正在打開編排器編輯器準備手動加節點，先停一下——你需要的事情大概率工作台幾秒鐘就能給你一份方案。手搓留給極致定製場景。
:::

## 打開工作台

切到你想要的執行模式（Spec / Agenda / Loop），從編排器面板下面的操作區點 **打開 AI 迭代工作台**。

![快速生成與迭代工作台按鈕](/images/orchestrator/orch-quickbuild-button.png)

會彈出一個面板。左邊是你和工作台 AI 的對話，右邊是當前編排的狀態。

![迭代工作台主視圖](/images/orchestrator/orch-iteration-studio.png)

## 描述你想要什麼

在輸入框裡寫一句話，描述你希望編排做什麼。越具體越好。

> 例：*「我希望 AI 在每次回覆前先回顧近期重要事件、保持人設一致性，並且不要輕易破規出戲。」*

![輸入框帶範例](/images/orchestrator/orch-iter-input.png)

點 **發送給 AI**。

## 看 AI 幹活

AI 回一段簡短計劃 + 一份方案，展示它打算改什麼。具體形態取決於當前模式：

- **Spec / Agenda 模式** — AI 產出一份 diff：綠色加號（新增）/ 紅色減號（刪除）/ 黃色（修改）。你可以逐條 批准 / 拒絕，或者放手讓它繼續——工作台會自動一輪接一輪推進直到穩定，每輪都有 diff 可看。
- **Loop 模式** — AI 透過工具呼叫直接 patch profile（`system_prompt` / 工具開關 / `max_rounds` / 預設路由）。無需逐條審批，AI 自行決定何時收尾。

![待審批 diff](/images/orchestrator/orch-iter-diff-inline.png)

哪條改動看不懂？點旁邊的放大鏡，左右對比看清楚。

![Diff side-by-side 詳情](/images/orchestrator/orch-iter-diff-side.png)

## 套用

AI 說沒什麼再改的了之後，點 **套用到全域**（到處都用）或 **套用到角色卡**（只對這張卡）。

## 工作台能幹什麼

- **多輪對話。** 一句反饋一輪，AI 提一個聚焦的改動方案，你審。
- **逐條審批（Spec / Agenda）。** 每條 diff 單獨 批准 / 拒絕，可以只接受一半。
- **程式驅動自動續輪。** 工作台在 AI 發出任意工具呼叫的回合裡自動續到下一輪,在 AI 只回純文字、不發工具的回合裡停下來。**沒有手動 Auto-Continue 開關,也沒有 AI 側的 continue / finalize 工具——工作台只看 AI 這輪有沒有呼叫工具。**
- **模擬測試。** 用當前真實的聊天上下文跑一遍工作流——就像你剛發了條新訊息一樣，世界書也會照常被啟用——但生成結果只展示給你看，*不影響*真實聊天。比如問「我加的 Constraint Agent 真的能擋住 OOC 嗎？」，工作台跑一遍流程，把每個節點輸出都擺給你看。
- **會話保存。** 每個作用域最多 24 個 session，不同卡 / 不同實驗各自一份。
- **回滾。** 已經套用的也能撤。
- **可摺疊思考。** 推理模型的 `<thought>` 標籤預設摺疊；超過 1200 字元的訊息也自動摺疊。

## 一個真實的迭代節奏（以 Spec 為例）

> **第 1 輪。** 你：*「AI 不要輕易出戲。」*
> AI：「在 Stage 2 加一個 Constraint Agent，加反破規檢查；啟用 Anti-Data Guard。」 Diff:1 個新節點 + 1 個開關。你 批准。
>
> **第 2 輪。** 你：*「讓它讀知識書，這樣它知道世界規則。」*
> AI：「在 Stage 1 加了一個 `lorebook_reader` 節點，這樣 Constraint Agent 就能看到啟用的世界規則。」 Diff:1 個新節點。批准。
>
> **第 3 輪。** 你：*「模擬一個明顯出戲的輸入，看 Constraint Agent 真能攔住嗎？」*
> AI：切到 模擬模式，用一段假的破規使用者訊息跑一遍工作流，把 Constraint Agent 的判定結果展示給你。

![Simulation 輸出](/images/orchestrator/orch-iter-simulation.png)

> **第 4 輪。** 穩定。點 **套用**。

每一步都是可見的、可中止的、可回退的。這是關鍵——你不是把控制權交給一個黑盒，而是讓 AI 提建議、你做主。

## 三種模式的產出差異

| 模式 | 工作台產出 | 你看到什麼 |
|---|---|---|
| **Spec** | Stage / Node 的 diff：加節點、刪節點、改 prompt 模板、調執行旗標、調 API/預設覆寫 | 綠/紅/黃 diff 列表，逐條審批 |
| **Agenda** | Planner Prompt 的 diff + Agent 池的 diff：加 Agent、改 Planner 調度邏輯 | 綠/紅/黃 diff 列表，逐條審批 |
| **Loop** | 直接透過工具呼叫 patch loop profile:`system_prompt` / 工具開關 / `max_rounds` / 預設路由 | 看不到 diff，AI 改完後告訴你結果 |

## Loop 模式的迭代提示

不會寫 system prompt？在 Loop 模式下打開工作台，用自然語言描述你想要的 agent 行為：

> 我希望這個 agent 先讀最近 5 樓，再去世界書查相關設定，最後去記憶圖找有沒有衝突，然後寫 capsule。不要它寫便箋。

工作台 AI 讀你當前的 profile,透過工具呼叫產出 patch。工作台只要 AI 這輪發了任何工具呼叫就會自動續到下一輪;一旦 AI 改回純文字、不再呼叫工具就停——AI 持續改,迭代就持續跑。

## 角色卡世界書衝突調和

在角色卡專屬編排會話裡打開工作台時，AI 還會順便對照這張卡綁定的世界書。格式相關的世界書條目分兩類，處理方式不一樣：

- **過程強制類**——條目在指揮*模型運行過程中怎麼思考*（強制思考模板、每輪必須打 CoT 前綴、「回答前先做 5W1H 檢查」、「按 1 至 N 步依次執行後再回答」等）。這類條目對編排是毒——它會在每一輪工具呼叫都觸發，把 agent 需要做規劃和工具呼叫的通道擠掉。工作台會摘掉那條格式約束，把作者真正想要的認知意圖（關心的話題、角度、人設習慣、場景錨點）作為敘事/人設/場景素材重寫進去，讓 agent 當作敘事輸入讀取，而不是當作新的輸出規則。
- **最終輸出形態類**——條目在描述*最終給用戶看到的那一條回覆長什麼樣*（「輸出必須用 markdown」、「用標籤包裹回覆」、「末尾附上一段總結」、「說話用詩的格式」等）。這類是合理的風格偏好，工作台會保留——只是改寫一下措辭，讓「最終出口」的語意明確，避免編排過程中的規劃節點、工具呼叫節點、複審節點也被這條形式約束綁住。

工作台首選只改寫衝突那一句、保留條目的其它資訊載荷；只有當整條幾乎就是純格式約束、沒有可保留的內容時才直接停用整條。任何情況都不會刪除條目。

**審批流程。** 世界書調整都是*提案*，不會立即落盤。每條提案以一張 diff 卡片的形式出現在產生它的助手訊息下方，帶**批准** / **拒絕**按鈕——和編排變更的逐條審查體驗一致。只有獲得批准的提案會在你點擊 **Apply** 時落到本地世界書；被拒絕的提案直接丟棄；未做決定的留在面板裡等你回來處理。輸入框上方有一行彙總，顯示待審批 / 已批准 / 已拒絕的計數；當只有世界書提案而沒有編排變更等著落地時，這一行還會出現一個「提交已批准的世界書改動」按鈕單獨提交。

全域編排會話不會動任何世界書——這套調和流程僅在角色卡範圍內生效。

## 用工作台編寫 skill

不想自己寫 SKILL.md？開啟工作台，告訴它你想要什麼。它替你起草、安裝，順便（如果你交代了）掛到對應位置——跟其他改動一樣的逐條審批流程。

一句話就夠，自然語言：

> 幫我寫一條 skill，讓導演避開翻譯腔。別讓角色對話出現「當 X 的時候」這種句式，不要用「——」破折號分隔短句，「是嗎？」改成「是吧？」這種更本地化的語氣詞。讓導演模式下所有 agent 都看到。

你審批之後，skill 立刻落盤可用。如果你順便交代了掛載（"讓所有 agent 看到"、"給 voice_critic 看"），它會一起掛好；否則之後你也可以自己在 [技能列表](/zh-TW/features/orchestrator/skills) 裡加。

![工作台跑完安裝](/_screenshots/skills/iter-studio-05-after-llm-round.png)

詳見 [《用 skills 調教 RP 輸出》](/zh-TW/recipes/rp-skills-walkthrough)。

## 會話管理

不同卡、不同實驗，各自一個 session。

![Session 列表](/images/orchestrator/orch-iter-sessions.png)

會話持久化，重新整理後還在，可以是全域作用域也可以綁到某張卡。每個作用域最多保留 24 個 session。

## 邊欄 — 快速生成（Spec / Agenda）

快速生成是迭代工作台的一鍵模式，適用於 Spec 與 Agenda。在編排編輯器頂部 **AI 生成目標** 文字框裡輸入需求，點 **AI 快速生成**:

![快速生成輸入區](/images/orchestrator/orch-quickbuild-input.png)

一次 LLM 呼叫之後，你直接拿到完整工作流：

![快速生成結果](/images/orchestrator/orch-quickbuild-result.png)

適合兩種場景：

1. 你已經用迭代工作台調過類似設定很多次，這次只想要個能跑的模板，不想再過流程
2. 你完全不在乎 AI 怎麼決定的，只要預設能用就行

其他場景下，**用迭代工作台更划算**。多花的 1–2 分鐘換來一個你能看懂、能調整的工作流。

::: info Loop 模式沒有 Quick Build
Loop 模式只能透過迭代工作台逐步迭代——沒有「一次生成完整 profile」的捷徑入口，因為 loop 的 system prompt 通常需要根據具體場景調，一次成型反而容易跑偏。
:::

## 相關頁面

- [編排器概覽](/zh-TW/features/orchestrator/) — 通用設定 / 觸發時機 / 角色卡綁定
- [Spec 模式](/zh-TW/features/orchestrator/spec) — 預設的 DAG 模式
- [單 Agent 模式](/zh-TW/features/orchestrator/single) — 退化的 Spec
- [Agenda 模式](/zh-TW/features/orchestrator/agenda) — Planner 動態調度
- [Loop 模式](/zh-TW/features/orchestrator/loop) — 單 Agent 工具循環
- [Skills 整合](/zh-TW/features/orchestrator/skills) — `skill_create` 寫入的物件
- [角色卡編輯器](/zh-TW/features/card-editor/) — 與迭代工作台共用 diff 引擎
