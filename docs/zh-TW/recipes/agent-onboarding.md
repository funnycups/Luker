# 多Agent上手：預設、記憶圖、網路搜尋

::: tip 這篇文件解決什麼問題
Luker 的[多 Agent 編排](/zh-TW/features/orchestrator/)、[記憶圖](/zh-TW/features/memory-graph)、[搜尋外掛](/zh-TW/features/search-tools)三項功能各自獨立可用，但要讓它們協同形成一套完整流程——由 Agent 團隊抽取記憶、檢索同人設定、構思劇情走向、起草正文——需要按順序完成幾項配置。

這篇從一份空白配置出發，逐步引導你完成預設、Director、記憶與搜尋的配置，不假設你已經看過上述三篇深入文件。完成後你將獲得一份可用的預設配置，之後隨時可以在迭代工作台裡繼續調整。
:::

## 你會得到什麼

完成本文配置後，在主對話傳送一則訊息，**主 LLM 不會立刻開始寫作**——Agent 團隊會先執行一輪編排：

- **`memory_scout`** 掃描記憶圖，檢索與當前劇情相關的角色 / 事件 / 地點
- **`canon_scout`**（必要時）聯網檢索當前題材的同人設定
- **`plot_brainstormer`** 從多個不同角度並行起草劇情結構草圖，由主 Agent 從中選擇
- **主 Agent** 根據前序 Agent 的產出直接完成正文寫作
- **`memory_curator`** 在起草完成後將本回合新出現的事實寫回記憶圖

記憶圖的**自動抽取 / 自動壓縮**完全交由 Agent 處理，搜尋引擎預設使用 DuckDuckGo——無需申請 API Key，無需配置 embedding，也不需要額外的 LLM 路由。

## 整體分工結構

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

記憶圖自身的「自動抽取 / 自動壓縮」不再觸發——Agent 已經在執行同樣的工作。搜尋功能啟用後，`canon_scout` 才能執行聯網檢索，否則它回傳零結果。

## 你需要先有什麼

- 可正常運行的 Luker 實例，主對話能夠正常生成回覆
- 一份可用的 [RP 預設](/zh-TW/basics/presets)，最好已經配置好文風、越獄、NSFW 指導

## Step 1 — 選擇起始預設

任何日常使用的 RP 預設均可。本步驟僅確認你有一份可用的寫作預設作為起點——下一步將在此基礎上派生 Director 所需的兩份預設。

## Step 2 — 配置預設助手，派生 Director 要用的兩份預設

Luker 的外掛呼叫 LLM 大致分**兩類**，需要的預設形態完全不同：一類是**外掛產出 RP 內容**的（比如 Director 的 Agent 團隊起草正文、評審子 Agent 複審等），需要帶越獄 / 文風 / 反八股的完整 RP 預設；另一類是**外掛的迭代 AI**（預設助手、記憶圖 Schema 工作台、CardApp Studio、Director 的迭代工作台等），它們透過工具呼叫修改配置或抽取結構化資料，不寫故事——任何混入的 RP 指令都會干擾模型執行外掛指令，所以這些位置需要一份**只保留越獄**的精簡預設。

Director 這條流程同時涉及這兩類：

| 路徑 | 給誰用 | 預設形態 |
|---|---|---|
| **Agent 路徑** —— 主 Agent + 子 Agent 起草正文 | 實際負責撰寫內容的 Agent，產出直接進入聊天介面 | 一份調好可用於 tool calling 的 RP 預設：保留越獄 / 文風 / 反八股，移除與編排器衝突的佔位符和硬格式限制 |
| **迭代工作台路徑** —— 你與它對話調整編排時，工作台 AI 自身使用 | 一個透過工具修改 JSON 配置的編輯器，完全不寫正文 | 一份**只保留越獄**的精簡預設——沒有文風指導、沒有 NSFW 寫作規則、沒有任何敘事元指令 |

::: tip 為什麼不能兩條路徑共用一份預設
RP 預設預設假設「主 LLM 獨立完成整個回覆」，將其放入 Agent 工具迴圈後會出現以下問題：

- 與 Agent 的 system prompt 爭奪注意力
- 把「必須輸出 schema」「強制思維鏈」這類格式約束強加進起草環節，破壞 tool calling
- 讓佔位符（角色卡描述、人設、世界書條目）被編排器主路徑**重複注入**

迭代工作台對此更為敏感——它完全不寫故事，只透過工具呼叫修改 JSON 配置。任何混入的 RP 指令都會干擾模型執行外掛指令。
:::

### 2a —— 配置預設助手本身

下一小節將使用預設助手派生 Agent 預設，但**它本身也是 LLM 驅動的工具**——需要先為它配置專用的迭代 AI 預設與 API 配置才能開啟。

打開擴充套件抽屜（與編排器、記憶、搜尋工具位於同一抽屜），找到**聊天補全預設助手**面板，配置以下兩項：

- **迭代 AI 的提示詞預設** —— 點擊該項旁邊的 **?** 按鈕
- **迭代 AI 的 API 預設** —— 選擇任意一個可正常運作的連線設定

![預設助手設定面板：迭代 AI 提示詞預設（帶 ? 按鈕）+ 迭代 AI API 預設](/images/recipes/agent-onboarding/step-02a-preset-help-button.png)

**?** 按鈕會開啟一個說明彈窗，底部有一個**匯入 plugin-only 預設**按鈕——點擊即可匯入 Luker 內建的乾淨預設並自動選中。

![? 按鈕彈窗：解釋該位置需要掛什麼預設，底部可匯入 plugin-only](/images/recipes/agent-onboarding/step-02a-help-popup.png)

Luker 內建的其他迭代 AI 入口（Director 的迭代工作台、記憶圖 Schema 工作台、CardApp Studio 等）旁邊都有同一個 **?** 按鈕——匯入操作完全一致。

### 2b —— 用預設助手派生 **Agent 路徑** 的預設

預設助手配置完成後，在同一個面板裡點擊**開啟助手**。在彈出的會話裡，將工具列頂部的**編輯模式**切換為「**編排器適配**」，然後輸入以下指令：

> 幫我把這個預設改成 Agent 專用預設

![編排器適配模式下的預設助手](/images/recipes/agent-onboarding/step-02-preset-assistant.png)

它預設會**派生一份新預設**（原名加 `-orchestrator` 後綴）——原預設保持不動。它會自動執行以下操作：

- 關閉會與編排器主路徑**重複注入**的佔位符：角色卡描述 / 人設 / 範例對話 / 顯式世界書拼接
- 把會干擾 tool calling 的強格式約束（強制 schema、固定思維鏈頭）從硬要求改寫成弱引導
- 將僅在最終成稿中生效的指令（summary、風格收束等）條件化到「最終提交訊息」階段
- **保留**聊天歷史、文風指令、越獄 / 反八股指令——主 Agent 起草與評審子 Agent 均會讀取

逐條審閱其 diff 並確認通過即可。

::: tip 可在同一會話中繼續改造預設
「編排器適配」只是助手三種**編輯模式**之一。將工具列的**編輯模式**切回預設的「**通用編輯**」並新建會話，同一個助手即成為通用預設編輯器，例如可以讓它「新增一個反八股指導並補充反面範例」「把文風指導從濃墨重彩改為克制細膩」「合併幾條意思重複的規則」。詳見[預設助手](/zh-TW/features/preset-assistant)。

「編排器適配」過程還會**主動掃描預設中可重用的文風 / 格式 / 寫作紀律規則**，作為候選提案擷取為 Skills（原文照搬、綁定當前預設作用域、在原位置補充一行指標）。每條提案均可獨立審閱——核准、拒絕或全部忽略，其餘適配內容仍會正常生效。詳見[把預設裡的文風 / 輸出格式抽成 Skills](/zh-TW/features/preset-assistant#把預設裡的文風-輸出格式抽成-skills-agent-編排預設模式)（單次小幅修改不會觸發掃描）。
:::

## Step 3 — 切換到 Director 模式並配置兩份預設

打開擴充套件抽屜的**多智能體編排**面板：

1. **執行模式** 切換為 **導演模式（Director）**
2. **API 預設（Connection profile）** + **提示詞預設** 選擇 Step 2b 派生的 `-orchestrator` 預設
3. 找到 **AI 迭代工作台配置** 區域，將**迭代 AI 的 API 預設** + **迭代 AI 的提示詞預設**設定為 Step 2a 匯入的 **plugin-only** 預設

## Step 4 — 將記憶圖的抽取與召回交給 Agent

打開擴充套件抽屜的**記憶**面板：

- **啟用** ✓ 保持開啟
- **自動抽取** ✗ 關閉（交給 Agent 團隊裡負責整理記憶的子 Agent）
- **自動壓縮** ✗ 關閉（Agent 收尾時一併處理）
- **啟用記憶召回注入** ✗ 關閉（Agent 團隊會在起草前自行執行一輪召回，保留內建注入只會**重複召回**並汙染主 Agent 上下文）

![記憶面板：抽取、壓縮、召回都交給 Agent](/images/recipes/agent-onboarding/step-04-memory-toggles.png)

::: info 想完全使用「記憶圖內建的抽取、召回和壓縮」
預設 Director 配置將抽取 / 召回 / 壓縮納入自身職責。如果你更信任記憶圖內建的鏈路（已經配置好多模型路由、Hybrid + Rerank 等），則：

1. 將**自動抽取**、**自動壓縮**、**啟用記憶召回注入**三項重新啟用
2. 在 [Step 6 的 AI 迭代工作台](#step-6) 裡告訴工作台 AI：「我不想讓 Agent 管理記憶，自己用內建的記憶圖就夠了」
3. 工作台 AI 會透過工具呼叫修改你的編排配置，逐條審閱後儲存
:::

## Step 5 — 選一個搜尋引擎

打開擴充套件抽屜的**搜尋工具**面板，**搜尋提供方**預設是 `DuckDuckGo（無需登入）`——保持預設即可。如需更精細的檢索，可切換為 `SearXNG（自訂實例）`（填寫自架的 URL）或 `Brave Search（API Key）`。

![搜尋引擎選擇](/images/recipes/agent-onboarding/step-05-search-provider.png)

::: info 頂部兩個開關跟這個流程的關係
**將工具暴露給主模型** 和 **在請求前執行搜尋 Agent** 是搜尋外掛**相互獨立**的兩種工作模式，與 Director 無關——本流程透過 Director 的搜尋子 Agent 執行搜尋，這兩個開關都**無需啟用**。

如果不使用 Director 也需要搜尋能力，請參閱[搜尋外掛](/zh-TW/features/search-tools)的「兩種工作模式」。
:::

## Step 6 — 想修改配置？開啟迭代工作台 {#step-6}

切換到 Director 後，在多智能體編排面板下方點擊 **開啟 AI 迭代工作台**——這是後續所有自訂的入口。

![AI 迭代工作台 — Director](/images/recipes/agent-onboarding/step-06-iter-studio-director.png)

工作台編輯的配置範圍取決於開啟它的時機：

- **當前沒在任何角色卡聊天裡** → 工作台編輯的是**全域**預設配置，所有未做覆寫的卡都會繼承該配置
- **當前在一張角色卡聊天裡** → 工作台編輯的是**這張卡的覆寫**，僅對該卡生效，並隨卡匯出 / 匯入

::: tip 在角色卡上調出的優秀編排可以手動晉升為全域
如果為某張卡迭代出一套特別合用的 Director 配置，可以**手動晉升為全域**：在編排器面板匯出該卡的配置，清空當前聊天回到無卡狀態，再將這份配置匯入全域。Schema 同理。
:::

### 全域作用域：可使用的指令

- 「我不想讓 Agent 管理記憶，請去掉負責抽取和召回的 Agent」
- 「我不想讓 Agent 聯網搜尋同人設定，請去掉負責搜尋的 Agent」
- 「讀取世界書裡的圖像生成指導，加一個子 Agent，在正文起草完成後構思插畫的插入位置和提示詞」
- 「讀取世界書裡的變數更新指導，加一個子 Agent，在正文起草完成後構思變數如何更新」

### 角色卡作用域：可使用的指令

- 「結合這張卡的世界觀和當前劇情，給主 Agent 加一段專門的寫作紀律」
- 「這張卡有自訂的體力 / 心情變數，負責整理記憶的子 Agent 抽取時優先填這幾個欄位」
- 任何與當前角色卡題材強相關、不適合放入全域配置的指令

工作台會逐條展示 diff，審閱並儲存即可。如果結果與預期不符，可隨時重設回預設 Director 配置。

## Step 7（可選）— 讓 AI 迭代 Schema

記憶圖的 Schema 也能被 AI 迭代。打開**記憶**面板裡的 **AI 迭代 Schema**，跳轉到 **記憶圖 Schema 工作台**。

![記憶圖 Schema 工作台](/images/recipes/agent-onboarding/step-07-schema-studio.png)

與編排配置一樣，Schema 也區分全域與角色卡作用域——卡上儲存的 Schema 會隨卡匯出。可以在工作台裡針對題材進行客製，例如：

- 修仙題材：給角色加「修為境界」「靈脈」欄位
- 政治題材：新增「派系」節點類型，記錄派系關係和敵對圖
- 生存題材：新增「物品」節點，追蹤每一件道具的耐久、狀態

::: tip 不要忘記為記憶圖配置迭代 AI 預設
記憶圖面板裡的 **Schema 迭代提示詞（Schema 編輯 AI）** 一欄屬於 Step 2a 提到的「迭代 AI 路徑」——其預設選擇器旁邊也有 **?** 按鈕，點擊後選擇**匯入 plugin-only 預設**即可（如果已在 Step 2a 匯入過，直接在下拉中選擇即可）。
:::

## 實際執行

返回主對話傳送一則訊息，展開思考塊即可看到 Agent 團隊的即時執行過程：

![Director 一回合內 Agent 團隊的產出](/images/orchestrator/director-takeover/director-real-final-body.png)

- **起草前偵察**：各自 5 條 `Item / Source / Why`，列出與當前劇情相關的角色、事件、世界書條目
- **中段頭腦風暴**：從多個角度並行起草劇情結構草圖，供主 Agent 選擇
- **起草後評審**：子 Agent 對主 Agent 的草稿提出評審意見，由主 Agent 決定採納哪些修改
- **收尾整理**：把這一回合新出現的事實寫回記憶圖

如需查看更詳細的內容——每個 Agent 的具體模型思考、每次工具呼叫的請求和回應——可在聊天區旁點擊 **顯示運行面板**（窄屏下為底部抽屜），展開任意一輪即可。

如果結果不滿意，該思考塊即 Agent 全程的執行記錄——可據此定位問題所在，然後回到 [AI 迭代工作台](/zh-TW/features/orchestrator/iteration-studio) 用自然語言描述期望的修改。

## 下一步

- [多 Agent 編排概覽](/zh-TW/features/orchestrator/) — 觸發時機、capsule 注入、五種執行模式的全貌
- [Director 模式](/zh-TW/features/orchestrator/director) — 預設 12 個子 Agent 的職責分工
- [AI 迭代工作台](/zh-TW/features/orchestrator/iteration-studio) — 用自然語言讓工作台 AI 修改配置
- [記憶圖](/zh-TW/features/memory-graph) — 節點類型、召回演算法、Schema 客製
- [搜尋外掛](/zh-TW/features/search-tools) — 三種搜尋引擎的差異 + 不使用 Director 時的工具模式
- [預設助手](/zh-TW/features/preset-assistant) — 「編排器適配」之外的兩種會話模式
