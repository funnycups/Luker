# 多Agent上手：預設、記憶圖、網路搜尋

::: tip 這篇文件解決什麼問題
Luker 的[多 Agent 編排](/zh-TW/features/orchestrator/)、[記憶圖](/zh-TW/features/memory-graph)、[搜尋外掛](/zh-TW/features/search-tools)三塊功能各自獨立可用，但要讓它們協同形成一套完整流程——由 Agent 團隊抽取記憶、檢索同人設定、構思劇情走向、起草正文——需要按順序完成幾項配置。

這篇從一份空白配置出發，一步步引導你配完預設、Director、記憶與搜尋，不假設你看過上面三篇深入文件。完成後你會得到一份開箱即用的預設配置，之後隨時可以在迭代工作台裡讓 AI 幫你繼續調整。
:::

## 你會得到什麼

跑完這篇後，主對話發一條訊息，**主 LLM 不會立刻動筆**——Agent 團隊先進去做一輪：

- **`memory_scout`** 翻一遍記憶圖，撈出和當前劇情有關的角色 / 事件 / 地點
- **`canon_scout`**（必要時）聯網檢索當前題材的同人設定
- **`plot_brainstormer`** 按幾個不同角度並行出劇情結構草圖，主 Agent 從中挑
- **主 Agent** 拿著前面幾位的產出，直接把正文寫完交給你
- **`memory_curator`** 起草完之後把這一回合新出現的事實寫回記憶圖

記憶圖的**自動抽取 / 自動壓縮**完全交給 Agent，搜尋引擎預設走 DuckDuckGo——不用申請 API Key，不用配 embedding，不需要額外的 LLM 路由。

## 整體分工長這樣

```d2
direction: down

start: "你發一條訊息" { shape: oval }

orch: "Director 主 Agent 接管" {
  style.fill: "#e1f5ff"
  scouts: "起草前偵察\nmemory_scout · chat_scout ·\nlorebook_scout · canon_scout(必要時聯網)"
  brain: "中段頭腦風暴\nplot_brainstormer\n按多角度並行出劇情草圖"
  draft: "主 Agent 起草正文"
  curate: "起草後清理\nmemory_curator 把新事實寫回記憶圖"
}

end: "正文直接顯示在聊天裡\n(主 LLM 本回合不參與)" { shape: oval }

start -> orch.scouts -> orch.brain -> orch.draft -> orch.curate -> end
```

記憶圖自己的「自動抽取 / 自動壓縮」不再觸發——同一件事 Agent 已經在做了。搜尋一旦被啟用，`canon_scout` 才有能力聯網，否則它回傳零結果。

## 你需要先有什麼

- 已經能跑的 Luker 實例，主對話能正常發回覆
- 一份能用的 [RP 預設](/zh-TW/basics/presets)，最好已經調教過文風、越獄、NSFW 指導

## Step 1 — 挑一份起點預設

任何你日常用的 RP 預設都行。這一步只是確認你有一份調教好的寫作預設作為起點——下一步從它出發，準備 Director 要用的兩份預設。

## Step 2 — 配置預設助手，派生 Director 要用的兩份預設

Luker 的外掛裡呼叫 LLM 大致分**兩類**，要用的預設形態完全不同：一類是**外掛產出 RP 內容**的（比如 Director 的 Agent 團隊起草正文、評審子 Agent 複審等），需要帶越獄 / 文風 / 反八股的 RP 預設；另一類是**外掛的迭代 AI**（預設助手、記憶圖 Schema 工作台、CardApp Studio、Director 的迭代工作台等），它們用工具呼叫改配置或抽結構，不寫故事——任何 RP 指令漏進去都會干擾模型執行外掛指令，所以要掛一份**只保留越獄**的精簡預設。

Director 這條流程同時涉及這兩類：

| 路徑 | 給誰用 | 預設形態 |
|---|---|---|
| **Agent 路徑** —— 主 Agent + 子 Agent 起草正文 | 真正在寫內容的那批，產出物落進聊天框 | 一份調好可以走 tool calling 的 RP 預設：保留越獄 / 文風 / 反八股，關掉跟編排器搶話的佔位符和硬格式 |
| **迭代工作台路徑** —— 你跟它對話調編排時，工作台 AI 自己用 | 一個用工具改 JSON 配置的編輯器，完全不寫正文 | 一份**只保留越獄**的精簡預設——沒有文風指導、沒有 NSFW 寫作規則、沒有任何敘事元指令 |

::: tip 為什麼不一份預設兩邊都用
RP 預設預設假設「主 LLM 一個人獨自寫完整個回覆」，塞進 Agent 工具迴圈會：

- 跟 Agent 的 system prompt 搶話語權
- 把「必須輸出 schema」「強制思維鏈」這類格式約束塞進起草環節，頂壞 tool calling
- 讓佔位符（角色卡描述、人設、世界書條目）被編排器主路徑**重複注入**

迭代工作台更敏感——它根本不寫故事，只透過工具呼叫改一份 JSON 配置。任何 RP 指令漏進去，都會影響模型執行外掛指令。
:::

### 2a —— 配置預設助手本身

下一小節要用預設助手派生 Agent 預設，但**它本身也是一個 LLM 驅動的工具**——得先給它掛上自己用的迭代 AI 預設和 API 配置才能打開。

打開擴充套件抽屜（跟編排器、記憶、搜尋工具同一欄），找到**聊天補全預設助手**面板，把這兩欄配好：

- **迭代 AI 的提示詞預設（參數+提示詞）** —— 點這欄旁邊的 **?** 按鈕
- **迭代 AI 的 API 預設（連線設定）** —— 選任意一個能跑通的連線設定

![預設助手設定面板：迭代 AI 提示詞預設（帶 ? 按鈕）+ 迭代 AI API 預設](/images/recipes/agent-onboarding/step-02a-preset-help-button.png)

? 按鈕會彈出一個說明視窗，底部帶一個**匯入 plugin-only 預設**按鈕——點一下就把 Luker 內建的純淨預設匯入並自動選中。

![? 按鈕彈窗：解釋這一欄要掛什麼預設，底部一鍵匯入 plugin-only](/images/recipes/agent-onboarding/step-02a-help-popup.png)

Luker 內建的其他迭代 AI 入口（Director 的迭代工作台、記憶圖 Schema 工作台、CardApp Studio 等）旁邊都有同一個 **?** 按鈕——一鍵匯入操作完全一致。

### 2b —— 用預設助手派生 **Agent 路徑** 的預設

預設助手掛好之後，在同一個面板裡點**開啟助手**。在彈出的會話裡，把工具列頂部的**編輯模式**切到「**編排器適配**」，然後跟它說：

> 幫我把這個預設改成 Agent 專用預設

![編排器適配模式下的預設助手](/images/recipes/agent-onboarding/step-02-preset-assistant.png)

它預設會**派生一份新預設**（原名加 `-orchestrator` 後綴）——原預設保持不動。它會自動：

- 關掉跟編排器主路徑**重複注入**的佔位符：角色卡描述 / 人設 / 範例對話 / 顯式世界書拼接
- 把會干擾 tool calling 的強格式約束（強制 schema、固定思維鏈頭）從硬要求改寫成弱引導
- 把僅出現在最終成稿裡的指令（summary、風格收束之類）條件化到「最終提交訊息」階段
- **保留**聊天歷史、文風指令、越獄 / 反八股指令——主 Agent 起草和評審子 Agent 都會讀

跟著它的草稿 diff 看一遍，逐條點同意即可。

::: tip 順手讓它再幫你改造預設
「編排器適配」只是助手三種**編輯模式**裡的一種。把工具列的**編輯模式**切回預設的「**通用編輯**」開一個新會話，同一個助手就是一個通用預設編輯器——可以讓它「新增一個反八股指導並補充反面範例」「把文風指導從濃墨重彩改成克制細膩」「合併幾條意思重複的規則」之類。詳見[預設助手](/zh-TW/features/preset-assistant)。

「編排器適配」這趟還會**主動掃一遍預設裡那些可重用的文風 / 格式 / 寫作紀律規則**，按候選給你提案擷取成 Skills（原文照搬、綁當前預設作用域、原位置補一行指標）。每條獨立可審 —— 批、拒、或者全拒都可以，其餘適配照常生效。詳見[把預設裡的文風 / 輸出格式抽成 Skills](/zh-TW/features/preset-assistant#把預設裡的文風-輸出格式抽成-skills-agent-編排預設模式)（小改一句話不會觸發掃一遍）。
:::

## Step 3 — 切到 Director 模式，掛上兩份預設

打開擴充套件抽屜的**多智慧體編排**面板：

1. **執行模式** 切到 **Director（多代理）**
2. **API 預設** + **提示詞預設** 選 Step 2b 派生的那份 `-orchestrator` 預設
3. 找到 **AI 迭代工作台** 區域，把它的 **API 預設** + **提示詞預設** 選 Step 2a 匯入的 **plugin-only** 預設

## Step 4 — 把記憶圖的抽取與召回交給 Agent

打開擴充套件抽屜的**記憶**面板：

- **啟用** ✓ 保持開啟
- **自動抽取** ✗ 關掉（交給 Agent 團隊裡負責整理記憶的子 Agent）
- **自動壓縮** ✗ 關掉（同上，Agent 收尾時一併處理）
- **啟用記憶召回注入** ✗ 關掉（Agent 團隊會在起草前自己跑一輪召回，留著內建注入只會**重複一份**，汙染主 Agent 上下文）

![記憶面板：抽取、壓縮、召回都交給 Agent](/images/recipes/agent-onboarding/step-04-memory-toggles.png)

::: info 想完全走「記憶圖內建的抽取、召回和壓縮」
預設 Director 配置把抽取 / 召回 / 壓縮都攬過來了。如果你更信任記憶圖內建的鏈路（已經調好了多模型路由、Hybrid + Rerank 之類），那麼：

1. 把**自動抽取**、**自動壓縮**、**啟用記憶召回注入**三項重新打開
2. 在 [Step 6 的 AI 迭代工作台](#step-6) 裡告訴工作台 AI：「我不想讓 Agent 管理記憶，自己用內建的記憶圖就夠了」
3. 工作台 AI 會透過工具呼叫修改你的編排配置，逐條審完點儲存
:::

## Step 5 — 選一個搜尋引擎

打開擴充套件抽屜的**搜尋工具**面板，**搜尋提供方**預設是 `DuckDuckGo（無需登入）`——不動就行。需要更精細的可以切到 `SearXNG（自訂實例）`（填你自架的 URL）或 `Brave Search（API Key）`。

![搜尋引擎選擇](/images/recipes/agent-onboarding/step-05-search-provider.png)

::: info 頂部兩個開關跟這個流程的關係
**暴露工具給主模型** 和 **請求前執行搜尋 Agent** 是搜尋外掛**獨立**的兩種工作模式，跟 Director 沒關係——本流程靠 Director 裡的搜尋子 Agent 呼叫搜尋，這兩個開關都**不需要打開**。

如果你不用 Director 也想讓搜尋可用，再去看[搜尋外掛](/zh-TW/features/search-tools)的「兩種工作模式」。
:::

## Step 6 — 想改點什麼？去迭代工作台 {#step-6}

切到 Director 之後，在多智慧體編排面板下方點 **開啟 AI 迭代工作台**——這就是後續所有客製化的入口。

![AI 迭代工作台 — Director](/images/recipes/agent-onboarding/step-06-iter-studio-director.png)

打開時機決定改的是哪一份配置：

- **當前沒在任何角色卡聊天裡** → 工作台改的是**全域**預設配置，所有未做覆寫的卡都跟著走
- **當前在一張角色卡聊天裡** → 工作台改的是**這張卡的覆寫**，只對它生效，還會隨卡匯出 / 匯入

::: tip 卡上調出來的好編排，可以手動晉升為全域
如果你給某張卡迭代出一套特別合用的 Director 配置，**完全可以把它複製成新的全域預設**——在編排器面板上匯出這張卡的配置，清空當前聊天回到無卡狀態，再把那份配置匯入到全域即可。Schema 同理。
:::

### 全域作用域，你可以這麼說

- 「我不想讓 Agent 管理記憶，請去掉負責抽取和召回的 Agent」
- 「我不想讓 Agent 聯網搜尋同人設定，請去掉負責搜尋的 Agent」
- 「讀取世界書裡的圖像生成指導，加一個子 Agent，在正文起草完成後構思插畫的插入位置和提示詞」
- 「讀取世界書裡的變數更新指導，加一個子 Agent，在正文起草完成後構思變數如何更新」

### 角色卡作用域，你可以這麼說

- 「結合這張卡的世界觀和當前劇情，給主 Agent 加一段專門的寫作紀律」
- 「這張卡有自訂的體力 / 心情變數，負責整理記憶的子 Agent 抽取時優先填這幾個欄位」
- 任何跟當前角色卡題材強相關、不適合寫進全域配置的指令

工作台會一步步出 diff，逐條審完點儲存。改不順手隨時可以重置回預設 Director 配置。

## Step 7（可選）— 讓 AI 幫你迭代 Schema

記憶圖的 Schema 也能被 AI 迭代。打開**記憶**面板裡的 **AI 迭代 Schema**，跳轉到 **記憶圖 Schema 工作台**。

![記憶圖 Schema 工作台](/images/recipes/agent-onboarding/step-07-schema-studio.png)

跟編排配置一樣，Schema 也區分全域和角色卡作用域——卡上儲存的 Schema 會隨卡匯出。你可以在工作台裡針對題材做客製，例如：

- 修仙題材：給角色加「修為境界」「靈脈」欄位
- 政治題材：新增「派系」節點類型，記錄派系關係和敵對圖
- 生存題材：新增「物品」節點，追蹤每一件道具的耐久、狀態

::: tip 別忘了給記憶圖配迭代 AI 預設
記憶圖面板裡的 **Schema 迭代提示詞（schema-editor AI）** 那一欄走的就是 Step 2a 提到的「迭代 AI 路徑」——它的預設選擇器旁邊也有 **?** 按鈕，點開後選**匯入 plugin-only 預設**即可（如果你在 Step 2a 已經匯過了，這裡直接在下拉裡選即可）。
:::

## 開玩

回主對話發一條訊息，展開思考塊就能看到 Agent 團隊在即時幹活：

![Director 一回合內 Agent 團隊的產出](/images/orchestrator/director-takeover/director-real-final-body.png)

- **起草前偵察**：各自 5 條 `Item / Source / Why`，把跟當前劇情相關的角色、事件、世界書條目擺出來
- **中段頭腦風暴**：按幾個不同角度並行出劇情結構草圖供主 Agent 挑
- **起草後評審**：子 Agent 各自拍主 Agent 草稿，主 Agent 決定接受哪幾條改寫
- **收尾整理**：把這一回合新出現的事實寫回記憶圖

想看更細——每個 Agent 的具體模型思考、每次工具呼叫的請求和回應？打開聊天區旁的**運行面板**（窄屏下從底部抽屜拉起），展開任意一輪即可。

不滿意？這個思考塊就是 Agent 全程的執行記錄——定位是哪一步出了問題，然後回 [AI 迭代工作台](/zh-TW/features/orchestrator/iteration-studio) 用自然語言描述你想怎麼改。

## 下一步

- [多 Agent 編排概覽](/zh-TW/features/orchestrator/) — 觸發時機、capsule 注入、四種執行模式的全貌
- [Director 模式](/zh-TW/features/orchestrator/director) — 預設 12 個子 Agent 的職責分工
- [AI 迭代工作台](/zh-TW/features/orchestrator/iteration-studio) — 自然語言指揮工作台 AI 改配置
- [記憶圖](/zh-TW/features/memory-graph) — 節點類型、召回演算法、Schema 客製
- [搜尋外掛](/zh-TW/features/search-tools) — 三種搜尋引擎的差異 + 不走 Director 時的工具模式
- [預設助手](/zh-TW/features/preset-assistant) — 「編排器適配」之外的兩種會話模式
