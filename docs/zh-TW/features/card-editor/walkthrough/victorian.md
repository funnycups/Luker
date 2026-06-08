# 從零寫一個 CardApp

::: tip 這篇文件解決什麼問題
[CardApp Studio](/zh-TW/features/card-editor/studio) 的頁面講它有什麼能力，這篇用一個真實題材演示**怎麼讓 Studio 從零聯動起來**：自己設計記憶圖 schema、自己設計 orchestrator loop 編排、寫卡 + 寫卡專用世界書、最後再做一個會隨對話演進的 CardApp 視覺化面板。

讀完你能看到 Studio 怎麼把這幾層堆疊在一張卡上 — 全程不用自己寫程式碼，也不用手工去任何編輯器開關任何選項。
:::

## 你會得到什麼

最終成品是一張名叫「維多利亞案宗」的偵探題材角色卡。<code v-pre>{{char}}</code> 是 1888 年倫敦的福爾摩斯式獨立顧問，你扮演一位委託人（或蘇格蘭場來訪的探長）遞上案宗，跟他一起把案件查下去。

這張卡身上同時掛著：

- **記憶圖 schema 派生** — `suspect` / `clue` / `forensic_site` / `witness` 四類領域節點（不是預設 schema）。**這層是給 LLM 長期記憶用的**：AI 每聊一段就把對應實體抽出來歸檔，跨回合 recall 時圖譜有現成切片可喂回 prompt。
- **orchestrator loop 編排** — 每次 AI 回覆都跑 `draft → critique → revise` 三階段，critique 階段強制審視"是否遺漏線索 / 嫌疑人陳述是否牴觸 / 時代約束是否被違反"
- **卡專用世界書** — 「維多利亞案宗·倫敦檔案」，含維多利亞倫敦背景 + 偵探辦案規矩 + **狀態注入條目**（含 <code v-pre>{{getvar::case_*}}</code> 佔位 + 教 AI 用 <code v-pre>{{setvar}}</code> 改寫變數的指令），**不動你的全域性世界書**
- **「當前案宗」CardApp 面板** — 讀 chat 變數呈現案件狀態：案件名 / 當前階段 / 嫌疑人 / 線索 / 取證地點。**變數由 AI 在 reply 中透過 setvar 推進**；CardApp 讀 `ctx.getVariable` + `JSON.parse` 渲染。聊一句 → AI emit setvar → 面板下一幀就更新。

整個搭建過程只有 2 輪自然語言對話 — Studio 自己提案、自己寫檔案、自己綁欄位、自己造世界書。

## 前置條件

- 一個能跑的 Luker 執行個體
- 已配通的 LLM API，推薦工具呼叫強的模型（Claude / GPT-5 等）。Studio 的工具流非常依賴模型敢於用工具
- 角色卡編輯助手在擴充功能面板裡有"模型請求 LLM 預設" / "模型請求 API 預設"兩個選項，Studio 自己跑 AI 時用的就是這兩個

## 1. 建一張空白卡 → 進 Studio

開啟右側角色管理面板，點「新建角色」，起名「**維多利亞案宗**」 — 描述 / 第一條訊息 / 世界書繫結全部留白，這些都讓 Studio 來填。

接下來開啟「擴充功能」面板 → 拉到「角色卡編輯助手」一節展開 → 點 **「&lt;/&gt; CardApp Studio」**：

![Studio 入口](/images/walkthrough/victorian/step-01-studio-entry.png)

::: tip Studio 也能給沒啟用 CardApp 的卡用
"角色卡編輯助手"針對沒有 CardApp 的卡走[普通彈窗](/zh-TW/features/card-editor/popup)，含 CardApp 的卡走 Studio。但**這個 Studio 按鈕可以主動把任何卡拉進 Studio**，工具集是完整版（記憶圖 schema / orchestrator override / 正則指令碼 / 世界書 / 卡欄位全在），不像普通彈窗只夠改欄位和世界書條目。
:::

## 2. 一句題材需求 → Studio 自己提方案

點 Studio 左欄輸入框，描述題材就行，具體怎麼落地讓模型來想：

```
我要從零做一張維多利亞時代倫敦偵探題材的角色卡。這卡先天就需要：

1. 自定義記憶圖 schema（按這題材該有的派生節點型別，比如嫌疑人/線索/取證地點/證人等），不要用預設 schema
2. orchestrator loop 編排（draft → critique → revise），按你最佳實踐的預設來配
3. 一個繫結到這張卡的世界書（lore + 維多利亞倫敦背景 + 幾條偵探辦案規矩）
4. 一個簡潔的 CardApp，把"當前案宗"（嫌疑人 / 線索 / 取證地點）隨對話演進視覺化顯示出來

請按你認為合適的順序逐步落地。每一步先把你的方案告訴我讓我看一下，我點頭你再寫。
```

![輸入題材需求](/images/walkthrough/victorian/step-02-first-prompt.png)

發出去後，Studio 不會埋頭猛寫 — 它先把整個方案鋪開來給你看一遍。

## 3. Studio 提議記憶圖 schema

第一段它先講資料層，把這題材該有什麼節點型別推出來：Studio 主動給出四個派生型別（`suspect` / `clue` / `forensic_site` / `witness`），每個型別列出了相關的列（嫌疑人有 alibi / motive / suspicion_level、線索有 found_at / linked_suspects 等），並解釋了為什麼不加 `victim` / `theory`（避免 schema 膨脹，把推理留給 event 鏈承擔）。

::: tip "派生型別"是什麼
記憶圖預設有 `event` 這個核心型別（時間線脊柱），除此之外可以**按卡的題材自定義節點型別**。偵探卡需要的"嫌疑人 / 線索"等概念，就是這種派生型別 — 讓 AI 抽取記憶時按結構歸檔，不用全部塞進自由文本。詳見 [記憶圖](/zh-TW/features/memory-graph)。
:::

## 4. Studio 提議 orchestrator loop 編排

接著是生成層：它推薦 `loop` 模式 — 在速度和品質之間取一個平衡。

## 5. 同意後，Studio 一次性落地全部產物

回個"全部確認，按你這方案走，直接落地"，Studio 就開始批次發起工具呼叫：

![Studio 落地全部產物的工具呼叫](/images/walkthrough/victorian/step-05-tool-calls.png)

一輪裡它做完了：

- **`character_update_memory_graph_schema`** — 把四類派生節點 schema 寫進卡（只動這張卡，不汙染全域性）
- **`character_update_orchestrator`** — 把 draft / critique / revise 的三階段 loop 配置寫進卡（同樣 character-scoped）
- **`worldinfo_create_chat_book`** + **`worldinfo_replace_entries`** — 建立卡專用世界書 + 一次性寫入維多利亞倫敦背景 / 偵探辦案規矩 / **狀態注入條目**（含 <code v-pre>{{getvar::case_*}}</code> 佔位 + 教 AI 用 <code v-pre>{{setvar}}</code> 改寫變數的指令）/ 蘇格蘭場文化 / 白教堂區背景等條目
- **`character_update_fields`** — 寫 description / personality / first_mes / scenario / 把 `world` 欄位繫結到剛建的世界書

每個工具呼叫都會**彈出審批 + 完整 diff**讓你看清楚改了什麼 — 一般可以放心點"批准"全過。

::: tip 狀態注入條目是變數驅動 UI 的核心樞紐
"狀態注入"那條世界書條目裡同時含 <code v-pre>{{getvar::case_*}}</code>（讓 AI 在每次 prompt 裝配時看見當前案件狀態）和**教學用的 <code v-pre>{{setvar}}</code> 宏**（指引 AI 在它的 reply 裡發 setvar 來推進案件）。詳見[逐樓層變數](/zh-TW/features/variable-op-log)。
:::

::: tip 正則指令碼也能管
Studio 也能寫 / 改正則指令碼（裁掉 thinking 標籤、轉換顯示格式等），需要時讓它做即可 — 這張測試卡里我們沒用上，不需要也彆強加。
:::

## 6.（繼續）給案宗做一個會動的視覺化面板

最後一步發一句：

```
繼續。現在做最後一步——CardApp「當前案宗」視覺化面板。
讀 chat 變數呈現案件狀態：案件名 / 階段 / 嫌疑人 / 線索 / 取證地點。
佈局照之前的草案，每條 AI 訊息生成完畢後重新整理一次。
風格：維多利亞霧都氛圍（暗色羊皮紙紙感、襯線字型、暗紅/暗黃邊）。
樣式 / 配色 / 取值細節你定。所有 cardapp 檔案寫入審批我都批准。
```

Studio 就把 CardApp 寫出來了。它讀的是 chat 變數（`case_name` / `case_phase` / `case_suspects` / `case_clues` / `case_sites`）。

## 7. 端到端跑一次

退出 Studio，正常發 RP 訊息。我們丟一份倫敦白教堂的案宗給 <code v-pre>{{char}}</code>：

> "偵探，白教堂有人深夜被害，死在自家閣樓上。死者是 35 歲的私塾教師莫妮卡·惠勒，丈夫亨利·惠勒報的案。我剛從蘇格蘭場調檔過來，需要您一起把脈。"

### a. 聊天回覆 — 卡設定全部生效

![端到端聊天回覆](/images/walkthrough/victorian/step-07a-chat-reply.png)

回覆體現了所有層的協同：推理有據（具體物證 → 推理 → 下一步取證方向）、維多利亞階級氛圍、技術約束（沒有指紋比對、沒有電話）、<code v-pre>{{char}}</code> 自帶的"現場不破壞 + 證據鏈"辦案規矩。這些是世界書條目 + character 欄位 + orchestrator capsule 共同把控出來的。

### b. 看 orchestrator 在背後做了什麼

打開聊天區旁的**運行面板**（窄屏下從底部抽屜拉起），就能看到這次 loop 跑了哪些步、呼叫了哪些工具、最終如何 finalize：

![Orchestrator 運行面板](/images/walkthrough/victorian/step-07b-stage-output.png)

如果 loop 出錯（API 配置不對、超時等），這裡會標紅失敗點，並自動 fallback 到無 loop 的直生成 — 端到端體驗依然連續，你只是少了那一層 capsule。

### c. 看記憶圖在長期積累什麼

點擴充功能面板裡 Memory 一節 →「圖檢視」，能看到當前對話攢到的圖：

![記憶圖檢視](/images/walkthrough/victorian/step-07c-memory-graph.png)

節點是按之前設計的 schema 派生的（`suspect`、`clue`、`forensic_site`、`witness`、`event`），邊記錄關係。**但這是給 LLM 用的**——下次跨回合需要 recall 亨利·惠勒的相關上下文時，圖譜會把存的切片自動喂進 prompt。

## 8. 看 CardApp 面板隨聊天演進

繼續聊。每發一句，AI 在 reply 裡 emit <code v-pre>{{setvar::case_*::...}}</code> 等宏推進案件狀態，CardApp 的「當前案宗」面板就會重新整理：

![CardApp 面板第二輪後：嫌疑人 / 線索 / 取證地點 逐條浮現](/images/walkthrough/victorian/step-06b-cardapp-turn2.png)

## 提示詞小抄

跑過一輪你會發現，有效的 Studio prompt 的關鍵不是字數，而是**說清楚方向 + 把決定權放給 Studio**：

1. **題材 + 風格說清楚就行，實現交給 Studio**
   - ✓ "維多利亞倫敦偵探卡，需要記憶圖 schema 派生 + loop 編排 + 卡專用世界書 + 視覺化面板"
   - ✗ "在 character.data.extensions.memory_graph.schema 里加一個 type=suspect 的物件，欄位是 alibi、motive..."

2. **對 schema / loop 這種結構性決策，讓它先提案再落地**
   - 它預設就這麼做（系統提示詞內建了這個習慣），你只要在它提案時盯一眼，有意見就直接說
   - 覺得 schema 多了一類："witness 砍掉合併進 suspect" — Studio 會改
   - 覺得 loop 想換 agenda 模式："換 agenda，讓規劃階段決定優先查哪條線" — 它也會改

3. **同意後明確告訴它"不要再來確認"**
   - 不然每個工具呼叫都來一遍可能很慢
   - "按你這方案走，工具呼叫我都批准，直接落地"

4. **不會的就讓它解釋**
   - "為什麼 victim 不放進 schema?" — 它會告訴你"這種少量的固定資訊寫在 first_mes 或世界書 entry 裡更穩，放 schema 反而冗餘"

## 下一步

- [CardApp Studio](/zh-TW/features/card-editor/studio) — Studio 的能力清單、介面佈局、工具集
- [記憶圖](/zh-TW/features/memory-graph) — 記憶圖概念、預設 schema、派生型別機制
- [Loop 模式](/zh-TW/features/orchestrator/loop) — Orchestrator loop 編排詳解
- [逐樓層變數](/zh-TW/features/variable-op-log) — 變數 op-log、變數驅動 UI 場景
- [角色卡開發者指南](/zh-TW/development/card-developers) — `ctx` API 全集 + CardApp 創作約定
