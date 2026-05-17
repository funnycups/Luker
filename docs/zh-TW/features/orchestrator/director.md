# Director 模式

Director 是編排器裡唯一一種**接管(takeover)模式** —— 這一回合的最終訊息正文不再由主 LLM 寫,而是由編排器內部的一支 Agent 團隊直接產出並提交。其它三種模式(spec / agenda / loop)的產物是緊湊的「作業說明」(capsule),要餵給主 LLM 才出成稿;Director 跳過這一步,Agent 自己把正文寫完。

## 它和其它編排模式的核心差別

| 維度 | spec / agenda / loop | director |
|---|---|---|
| 誰寫正文 | 主 LLM(讀 capsule 後落筆) | 編排器內的主代理(直接寫) |
| Agent 的產出 | 緊湊的 capsule 文本 | 完整可傳送的訊息正文 |
| 主 LLM 在本回合 | 出最終回覆 | **不被呼叫** |
| 適合的場景 | 讓主 LLM 在已有 prompt cache 上穩定出活 | 讓一支多視角的寫作團隊**直接交一稿** |

從使用者視角看,Director 給你的是「AI 內部一整支團隊在協作,你只看到他們交付的最終 RP 回覆」的體驗:草稿、評審、修訂、定稿的所有過程在思考摺疊裡展開,主聊天窗口裡只出現成型的那一段敘事。

## 適合的場景

- **高質量長篇 RP**:角色一致性、文風一致性、連續性同時重要,單一視角顧不過來。
- **想要「草稿 → 評審 → 修訂」被強制寫進流程**,不靠主 LLM 自覺。
- **需要不同視角各跑自己的模型 / preset**——例如規劃用便宜模型,評審用強模型。

不適合:

- 只想讓主 LLM 用得更聰明一些 —— 用 [loop](/zh-TW/features/orchestrator/loop) / [spec](/zh-TW/features/orchestrator/spec) / [agenda](/zh-TW/features/orchestrator/agenda),讓主 LLM 接 capsule 寫。
- 想要毫秒級延遲 —— Director 一回合內部要跑若干輪工具呼叫 + 若干次子代理派遣,牆鍾開銷顯著。

## 跑起來是什麼樣

下面這一組截圖來自一次真實的 Director 回合。主代理排程了預設 profile 自帶的三個子代理(`chat_scout` / `voice_critic` / `continuity_critic`),完整跑完了「偵察 → 起草 → 評審 → 修訂 → 定稿」流程。

### 第一步:派遣前置偵察

主代理打開回合後,先派遣 `chat_scout` 掃近期聊天,得到 5 條 `Item / Source / Why` 形式的關鍵狀態摘要。這些摘要進入思考摺疊裡 `chat_scout` 自己的命名區段(錨點 `### [<handleId>: chat_scout]`),主代理後續起草時能直接讀到。

![Director 派遣 chat_scout,5 段偵察輸出](/images/orchestrator/director-takeover/director-real-scout-dispatch.png)

### 第二步:起草後雙 critic 並行評審

主代理用偵察結果起草一段中文敘事寫入正文(`write_message`),然後**並行**派遣兩個後置評審子代理:

- `voice_critic`:人性 & 口吻 —— 揪出「資料人」式描寫(冷觀察動詞 / 資料詞彙 / 彙報式對白)與冷設定誤讀(讓科學家"分析"戀人、人造人在親密中"掃描評估"、三無角色內心被寫成真的空白)。
- `continuity_critic`:硬衝突 —— 草稿說 X 而聊天 / 記憶 / 世界書明確說過 NOT-X 時才 flag,以及角色認知邊界違規(讓角色知道他沒被告知過的事)。

兩個 critic 在思考摺疊裡各自有一段同時生長的命名區,字元級別互不錯位(每個區段的位元組由 JavaScript 單執行緒事件迴圈保證連續)。

![voice_critic + continuity_critic 並行評審](/images/orchestrator/director-takeover/director-real-critic-loop.png)

### 第三步:迭代修訂與收尾

主代理讀兩位 critic 的反饋,把它認可的批評透過 `apply_message_patches` 打補丁到正文裡,自己判斷不靠譜的直接忽略——可以再起一輪迭代(再起一個 critic、再回讀一遍稿子)。當主代理判斷「可以收尾」時調 `finalize`,handle 進入終態、儲存到聊天、UI 解鎖。摺疊下方就是最終發出的中文正文。

![finalize 之後:摺疊下方是最終正文](/images/orchestrator/director-takeover/director-real-final-body.png)

整個回合使用者只在主對話裡看到最終那一段敘事,所有過程性產出停留在摺疊裡,展開可讀。

## 怎麼切到 Director

在擴充套件抽屜的「多智慧體編排」面板裡,把**執行模式**設為 **Director(多代理)**。切到 Director 後,spec / agenda / loop 的設定卡片會自動收起,Director 自己的設定卡片出現。

::: tip 99% 的人不該手搓主代理 system prompt
預設主代理系統提示詞與預設的八個子代理 id **強耦合**——它已經按「先派偵察、起草、再派評審、迭代修訂」的紀律調好了。要改的話推薦用 [AI 迭代工作台](/zh-TW/features/orchestrator/iteration-studio)用自然語言描述需求,讓它透過工具呼叫 patch 你的 profile。
:::

## 工作流梗概

```d2
direction: down

start: "新一回合開始\n(本回合主 LLM 不參與 ——\n編排器自己寫正文)" {
  shape: oval
  style.fill: "#e8f5e9"
}

loop: "主代理坐在寫作台前" {
  style.fill: "#e1f5ff"

  think: "看一眼當前草稿,\n決定下一步動作" {
    style.fill: "#fffde7"
  }

  decide: "主代理\n下一步要做什麼?" {
    shape: diamond
  }

  consult: "找位顧問(預設 profile 自帶 8 個子代理)" {
    style.fill: "#fff3e0"
    pre: "起草前偵察\nchat_scout · memory_scout ·\nlorebook_scout · epistemic_scout ·\ncanon_scout(按需)" {
      style.fill: "#fffde7"
    }
    mid: "plot_brainstormer\n結構草圖 —— 可按不同角度\n平行派出多份" {
      style.fill: "#fffde7"
    }
    post: "起草後評審\nvoice_critic · continuity_critic" {
      style.fill: "#fffde7"
    }
  }

  research: "查點東西\n翻聊天 · 翻記憶 · 查世界書 ·\n聯網 · 記便箋" {
    style.fill: "#fffde7"
  }

  write: "動筆寫或改正文\n續寫 · 定點打補丁 ·\n回讀自己的草稿" {
    style.fill: "#fffde7"
  }

  finalize: "收筆 · finalize 正文" {
    style.fill: "#c8e6c9"
  }

  think -> decide
  decide -> consult: "找顧問"
  decide -> research: "查資料"
  decide -> write: "下筆"
  decide -> finalize: "finalize"
  consult -> think: "顧問返稿"
  research -> think: "下一步"
  write -> think: "下一步"
}

out: "成稿正文發到聊天\n(沒有 capsule —— 正文就是輸出)" {
  shape: oval
  style.fill: "#f3e5f5"
}

start -> loop.think
loop.finalize -> out
```

1. **主代理在一個工具迴圈裡跑**。每一輪它可以調若干工具,直到主動調 `finalize`、到達輪次上限、或被使用者中止。

2. **主代理能用的工具組**:
   - **迴圈工具**(在 profile 裡勾選啟用)—— 跟 loop 模式同源:`chat_*` / `lorebook_*` / `memory_*` / `note_*` / `search_*`,用來收集上下文。
   - **協作工具** —— `dispatch_subagent(subagentId, task)` 按 id 啟動 profile 預定義的子代理;`dispatch_inline_subagent(systemPrompt, task, ...)` 啟動一次性 ad-hoc 子代理;`await_subagents(handles)` 阻塞等子代理完工;`cancel_subagent(handle)` 中止跑到一半的子代理。
   - **訊息產出工具** —— `write_message(text, mode?)` 寫正文(`mode='replace'` 覆寫、`mode='append'` 追加);`apply_message_patches(patches)` 做定點的 context-replace 補丁;`get_draft()` 回讀當前草稿;`finalize()` 提交併收尾。

3. **子代理是「一次性顧問」**:派遣時拿到當前聊天快照 + 主代理寫的任務簡報 + 自己的系統提示詞 + 啟用的迴圈工具 + `get_draft()`。子代理彼此看不到對方的存在,看不到主代理的推理,**不能再向下派遣**,也**不能直接寫正文**——它們只產出文本,主代理決定怎麼用。

4. **預設 profile 自帶 8 個為 RP 最佳化過的子代理**:

   | 子代理 | 作用 | 簡單範例(RP 場景) |
   |---|---|---|
   | `chat_scout` | 起草前單源偵察 —— 掃近期聊天,挑出主代理起草要靠的載體狀態。 | 返回 5 段 `Item / Source / Why`,例如「林晚的焦慮 / 第 42 樓 / 會把對話引回家族話題」。 |
   | `memory_scout` | 起草前單源偵察 —— 在記憶圖裡找本回合相關的節點。 | 「第 18 樓外祖母線索是當前情感主線;第 3 樓茶道閒筆休眠中。」 |
   | `lorebook_scout` | 起草前單源偵察 —— 拉啟動之外的世界書條目。 | 「『洛陽主城』條目尚未進上下文;相關性:林晚的外祖母在那。」 |
   | `epistemic_scout` | 起草前跨源偵察 —— 把聊天(每個角色經歷過什麼)與世界書 / 記憶(世界裡能知道什麼)交叉,給出每個角色的「知道 / 不知道 / 上帝視角陷阱」清單。 | 「林晚**不知道**使用者是圍城將軍的兒子 —— 她只見過他兩次,帶話的人還沒出場。」 |
   | `canon_scout` | 按需的外部偵察 —— 同人 / 公共 IP 設定考據,底層走迴圈工具 `search_search` / `search_visit`。需要 profile 裡啟用 `search.search` / `search.visit`,否則返回零條結果。原創世界跳過。 | 觸到火影設定:「中忍考試不是考的,是推薦 —— 相關:若林晚自稱中忍候選則要修正。」 |
   | `plot_brainstormer` | 中段頭腦風暴 —— 每個角度產出一份結構草圖。可按不同角度平行派多份拿到真正不同的選項。 | 角度 A「正面衝突」 / 角度 B「沉默本身成為節拍」 / 角度 C「她藉轉向洛陽話題躲避」。 |
   | `voice_critic` | 起草後評審 —— 人性 & 口吻。揪出「資料人」式描寫(冷觀察動詞 / 資料詞彙 / 彙報式對白等動情時刻應該燙的地方卻寫得冷)和冷設定誤讀(冷設定角色被寫成真的冷,而不是「冷皮包熱瓤」)。口吻語域錯配是次要維度。 | 「草稿裡林晚『以臨床抽離的姿態觀察對象的微表情漂移』—— 這是傳感器筆法,不是活人筆法。換成她真的有的某個感覺,即使表面仍然剋制。」 |
   | `continuity_critic` | 起草後評審 —— 僅查硬衝突。預設信任 draft;只有當聊天 / 記憶 / 世界書明確說過相反事實時才 flag。例外:角色認知邊界違規(角色知道了沒人告訴過他的事)永遠要 flag。 | 「草稿裡林晚認出對方掛墜上的家紋,但聊天裡這個掛墜對她而言只被描述成『一枚銀盤』。認知邊界:她沒被告知這是家紋,更沒被告知是誰的。」 |

   預設主代理系統提示詞與這 8 個 id **強耦合**,按 id 指名排程,併為每個寫好了 task brief 的樣式。改子代理時,主代理提示詞也要同步改。

5. **主代理對每個子代理的可見資訊只有 `id` + `description`**——使用者寫的 `systemPrompt` **不會**洩露進主代理的提示詞。description 是它「點菜」時唯一的依據,所以預設 description 寫成三段式:角色 / 不知道什麼 / 任務簡報每次該帶哪些欄位。Studio 的迭代系統提示詞把這一約定教給 AI,讓它編輯 profile 時新建出的子代理 description 真能被主代理用起來。

## 配置

開啟「多智慧體編排」面板裡那個 profile 的編輯器(把模式設為 **Director(多代理)** 後會看到對應的編輯卡片)。

### 主代理

- **API 預設** —— 主代理 `generateTaskStream` 呼叫走的連線配置。
- **提示詞預設** —— 主代理用的 Chat Completion 預設(取樣器、溫度等),決定主代理這一側的 prompt 結構;**這就是下一節「推薦預設配置」裡要討論的那一個**。
- **主代理系統提示詞** —— 建立編排時預設文本會被直接寫入這個欄位。執行時**只看欄位裡的當前內容**——留空就發空指令,沒有隱藏回退。可以自由編輯;**重置為預設值**按鈕會把欄位內容寫回內建預設。除非有明確理由,預設值是按「強制 critique 紀律」調校過的,值得先用預設跑兩輪再決定要不要改。

### 子代理

每個子代理一行,欄位:

- **子代理 ID** —— 在 profile 內唯一。主代理呼叫形式是 `dispatch_subagent({ subagentId: "<這個 id>", task: "..." })`。
- **描述** —— 作為工具文件的一部分展示給主代理,讓它知道這個子代理擅長什麼、何時該派。
- **系統提示詞** —— 這個子代理扮演的角色 / 視角。例如:「你是口吻評審,主代理會給你這一回合的草稿——列出任何感覺不像說話人的句子。」
- **API 預設** + **提示詞預設** —— 子代理獨立的路由,可以讓規劃類子代理走快/便宜的模型,評審類子代理走強模型。

### 上限

- **工具呼叫最大輪數** —— 主代理迴圈的硬上限。
- **同時派遣的子代理最大數** —— `dispatch_subagent` 的併發數。
- **本回合子代理呼叫總數上限** —— 累計的子代理啟動次數。

### 中斷時的行為

- **中斷時丟棄半成品訊息** 關閉(預設):使用者中途停止時,半成品訊息保留並提交,摺疊裡追加一段 `### [aborted]` 標記。
- **中斷時丟棄半成品訊息** 開啟:半成品訊息丟棄,訊息槽回到 placeholder 狀態。

## 推薦的 Chat Completion 預設配置

主代理用的那個 Chat Completion 預設,**跟主對話裡日常用的預設不是一個東西**——它給主代理的工具迴圈用,不直接產出最終回覆。預設裡的佔位符提示詞只有在跟「主代理的思考方式」或「最終正文的語言風格」直接相關時才有價值,其它的會汙染主代理的上下文。

### 建議關閉

下面這些都關掉,原因都是同一個——**重複注入**:ST 主流程已經把這些內容寫進主代理看到的聊天上下文,預設佔位符再注一份就是重複。

- **角色卡欄位**(description / personality / scenario / first message / example messages)
- **使用者人設**(persona)
- **示例對話**(example messages)
- **世界書佔位符**(預設裡的顯式 worldInfo 拼接節點)

### 建議保留

| 提示詞項 | 為什麼留 |
|---|---|
| **聊天歷史** | 主代理 prompt 實際通過這個槽位傳遞給 LLM。關掉=主代理什麼都看不到。 |
| **文風指令** | 主代理 `write_message` 起草、給 `voice_critic` 寫任務簡報時都會讀。 |
| **越獄 / 解除拘束指令** | 一旦主代理中途被審查策略卡住,「偵察 → 起草 → 評審」整條鏈就到不了 finalize。 |
| **反八股指令** | 與文風指令同源,主代理起草與 critic 評審都會讀。 |

## 進階:把 Director 用作單 Agent 迭代寫手

Director 預設是「主代理 + 多子代理」的工作流,但有一種 power-user 用法是把它**退化成單 Agent 多輪迭代創作**——沒有 critic,只有一個主代理自己寫、自己改、自己拍板。

**適合的場景**:你已經知道想要什麼風格,不需要 critic 視角,只想讓一個強模型用工具迴圈(讀上下文、讀世界書、自己起草、自己回讀、自己改)直接產出一稿。本質上是把 director 的「主代理」單拎出來當 loop 模式的 agent 用,但保留 director 直接寫正文(不出 capsule)的接管特性。

**用 [AI 迭代工作台](/zh-TW/features/orchestrator/iteration-studio) 改。** 跟它說類似「把當前 profile 改成單 Agent 迭代寫手:移除所有子代理,主代理 prompt 簡化為 draft → 回讀 → 修訂 → finalize,保留 `chat_*` / `memory_*` / `lorebook_*` 工具」。Studio 認識這種變體,會透過工具呼叫 patch 你的 profile——審一下 diff,批准,儲存。這是推薦路徑,下面的手動步驟只給想自己接線的使用者。

::: details 手動改法(Studio 已搞定的話可跳過)

1. 在主代理系統提示詞裡,刪掉所有「派遣子代理」相關的紀律,改寫成「你自己起草、自己回讀、自己改,認為可以了就 `finalize`」。
2. 在 profile 裡把所有子代理刪掉(或者把它們的 ID 全部從主代理 prompt 裡摘乾淨)——這樣 `dispatch_subagent` 工具不會出現在主代理的工具列表裡,只剩 `dispatch_inline_subagent`(可以保留或不保留,看你想不想讓主代理在特殊場景臨時拉 ad-hoc 子代理)。
3. 主代理的工具組裡至少保留:`write_message` / `apply_message_patches` / `get_draft` / `finalize`,以及你想讓它用的幾個迴圈工具(典型組合是 `chat_*` + `memory_*` + `lorebook_*`)。
4. 視情況把「工具呼叫最大輪數」往下調一些(預設 20 對單 agent 來說偏多)。

:::

**注意**:這種模式下沒有 critic 兜底,主代理的判斷就是終審。建議跑兩輪先看主代理在你的 prompt 下能不能穩定 finalize,再決定是不是把這套配置存為新 profile。

## 限制與約束

- 適用於 `normal` / `regenerate` / `swipe` / `continue` 四種生成型別。`quiet` 與 `impersonate` 不觸發 Director。
- 要求當前啟用的連線配置屬於 OpenAI 家族(Anthropic / OpenAI / Gemini / OpenRouter 等)——底層流式 API 暫不支援 kobold / textgen。
- Director 啟用的回合裡,capsule 注入路徑自動停用(兩者概念上互斥:正文本身就是產出)。
- **子代理深度為 1**:不能再向下派遣子代理。它們共享主代理啟用的迴圈工具——profile 裡 chat / lorebook / memory / note / search 哪幾個開了,子代理就能調哪幾個。子代理的自然終止條件是「某一輪沒有呼叫任何工具」:那一輪的文本就是它返回給主代理的答案。
- Director 遵循編排器現有的 **使用流式傳輸** 開關:開啟時主代理與子代理都走流式 API;關閉時使用普通非流式呼叫。
- **訊息氣泡在主代理工作過程中即時更新**。主代理每次調 `write_message` / `apply_message_patches` 時,氣泡的正文都會被重繪——你能看到訊息隨工具呼叫一步步生長、被打補丁、被改寫。粒度是「每次工具呼叫」,不是「每個 token」。
- **子代理的輸出即時進入思考摺疊**。每個派遣出去的子代理在摺疊裡有一段命名區(錨點 `### [<handleId>: <subagentId>]`)。開啟流式傳輸時,每個子代理的 token 抵達即落入它自己的區段——同一回合並行派出的多個子代理會以「多個區段同時各自生長」的形式呈現,字元級互不錯位(各區段定位依靠 JavaScript 單執行緒事件迴圈,保證每個 producer 的位元組都連續)。關閉流式時,區段一次性收到子代理的終態全文。區段標題在子代理工作期間帶 `(running)` 字尾,完成後清除(失敗時替換為 `(error: ...)`)。
- 主代理在工具呼叫之間的解釋也以 `### [main-N]` 段落形式進入思考摺疊,讓使用者能順著讀完跨輪的推理。

## 角色卡繫結

Director profile 跟 spec / agenda / loop 一樣支援角色卡覆寫。在選中角色卡的狀態下開啟編排編輯器,會看到 **儲存到角色卡覆寫** / **清除角色卡覆寫** 按鈕——繫結後這套 director 配置會隨卡匯出,卡作者可以為自己的角色推薦一整套「主代理 + 子代理 + 上限」配置。

::: info 跟 spec / agenda / loop 一致
Director 跟其他模式一樣支援 **匯出 profile** / **匯入 profile** 按鈕。匯出檔案是一份自包含的 JSON 載荷(`format: luker_orchestrator_profile_v3`),覆蓋當前選中的作用域(全域或角色卡覆寫)。匯入時如果檔案裡的執行模式與當前模式不匹配,會拒絕載入——切換到對應模式後再匯入。
:::

## 相關頁面

- [編排器概覽](/zh-TW/features/orchestrator/) — 通用配置 / 觸發時機 / 角色卡繫結
- [AI 迭代工作台](/zh-TW/features/orchestrator/iteration-studio) — AI 幫你寫主代理 / 子代理 system prompt(強烈推薦)
- [Loop 模式](/zh-TW/features/orchestrator/loop) — 單 Agent 跑工具迴圈、產出 capsule
- [Spec 模式](/zh-TW/features/orchestrator/spec) — 預設 DAG,多 Agent 各 stage 產出 capsule
- [Agenda 模式](/zh-TW/features/orchestrator/agenda) — Planner 動態排程 Worker,產出 capsule

