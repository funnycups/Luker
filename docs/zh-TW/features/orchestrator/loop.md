# Loop 模式

Loop 模式讓單個 Agent 在同一會話裡透過工具呼叫循環推進,自己決定何時收尾——不畫 DAG、不寫 Planner,只寫一段 system prompt + 勾幾個工具就能跑。

**Loop 模式在速度與效果之間取得平衡**:比單 Agent 智能(可以呼叫工具迭代查記憶 / 查世界書 / 翻聊天),比 Spec / Agenda 快(同一會話同一 preset,prompt cache 持續命中,不像 spec 每個 stage 切 preset 都要重建 cache)。

適合的場景:你想讓一個 agent 像研究員那樣工作——讀最近聊天、查世界書、翻記憶圖、記便箋,最後產出一段精煉的 capsule 注入主對話;過程中需要它自己根據中間發現決定下一步,而不是按固定流程走完所有 stage。

::: tip 與 Spec / Agenda 的關係
loop 模式和 spec / agenda 共存。已有的 spec / agenda profile 不受影響。
:::

::: warning 99% 的人不該手撸 system prompt
不會寫 system prompt?直接打開 [AI 迭代工作台](/zh-TW/features/orchestrator/iteration-studio)——用自然語言描述你想要的 agent,AI 透過工具呼叫直接 patch profile。
:::

## 是什麼 / 為什麼

Spec / Single / Agenda 三種模式都是「多 agent 協作生成單條主回覆」,stage 間透過 `previousNodeOutputs` 傳結構化輸出。這套設計在以下場景出現摩擦:

- **設定門檻高**:spec 需要畫 DAG,agenda 需要寫 Planner 提示詞。
- **stage 切換開銷**:每個 stage 重建 system prompt / 切預設,prompt cache 難命中,端到端延遲累加。
- **上下文斷層**:stage 間只透傳 `previous_outputs`,agent 中間的思考過程會丟失。
- **流程僵化**:DAG 拓撲寫死,agent 無法根據中間發現動態調整路徑。

Loop 模式針對這些點做單 agent + 工具循環:同一會話、一套 preset、訊息陣列持續累加,agent 根據上一輪工具結果決定下一步呼叫什麼工具,主動呼叫 `finalize(capsule_text)` 時停下。core benefit 是上下文連續性——工具呼叫與結果天然在 messages 裡,不需要手工傳變數。

## 切到 Loop

擴展抽屜裡把執行模式選成 **單 Agent 循環 (loop)**。spec / agenda 的 board 自動收起,出現一個獨立的 Loop board。

![執行模式選成 Loop](/images/orchestrator-loop/orch-loop-mode-select.png)

![Loop 設定面板](/images/orchestrator-loop/orch-loop-board.png)

## 編輯器

點 **打開編排編輯器** 彈出一個左右兩列的工作區——左邊是單個 Agent 的預設 + 系統提示詞 + 兩個保護參數,右邊是按命名空間分組的工具開關。

![Loop 編輯器](/images/orchestrator-loop/orch-loop-editor.png)

關鍵欄位:

- **Loop 系統提示詞**:Agent 的角色與任務說明。要明確告訴它「何時該呼叫 `finalize`」——多數翻車都來自 agent 不知道何時收尾。
- **Loop 最大輪次**(預設 20,上限 50):一輪 = 一次 LLM 請求 + 處理它返回的 tool call。
- **Loop 牆鐘預算**(預設 300 秒):整個 loop 的牆鐘上限,無論已跑多少輪,到點 break。
- **工具開關**:勾掉的命名空間不會出現在 agent 的工具 schema 裡。`finalize` 強制啟用、不可關閉。
- **Loop API 預設 / Loop 提示詞預設**:留空 = 用全域編排預設。和 spec / agenda 的預設路由一致,能讓 loop 單獨走更便宜的模型。

## 內建工具

工具走 OpenAI function-calling 協議,結果以 `role: tool` 訊息形式回到 Agent 的下一輪上下文。共 10 個可選工具 + 1 個強制 `finalize`:

| 工具 | 作用 | 簡單範例(RP 場景) |
|---|---|---|
| `note.add(text)` | 寫一條**持久化便箋**,綁定當前 chat。下一次 loop 啟動時,這些便箋會自動注入 system prompt。單條上限 1KB,最多保留 50 條 LRU。 | agent 在「林晚提到她的外祖母在洛陽」那一輪呼叫 `note.add('林晚的家族線索:外祖母→洛陽')`,幾次對話後再啟 loop 時仍能看到這條便箋。 |
| `chat.read_range(start, end)` | 讀 chat 樓層範圍。負數從末尾倒數,單次最多 50 樓。 | `chat.read_range(-10, -1)` 讀最近 10 樓複習上下文。 |
| `chat.search(query, limit)` | 全聊天 substring 搜尋(大小寫不敏感),返回樓層 + 內容預覽。 | `chat.search('青冥劍')` 找出之前所有提到「青冥劍」的樓層。 |
| `lorebook.search(query, limit)` | 在所有啟用的世界書裡 substring 搜尋條目。**預設排除本回合已啟用的條目**(那些已經被注入主上下文,再返回會浪費 token)。返回 `entries` + `excluded_active_count`。 | `lorebook.search('落雁城')` 翻出未啟用的「落雁城」相關設定。 |
| `lorebook.get(entry_key)` | 按 key 拉取條目全文。**不去重**——允許 agent 精確引用某條已啟用條目以保持術語一致。 | `lorebook.get('落雁城-主城')` 把這一條全文調出來引用。 |
| `memory.search(query, limit)` | 在記憶圖(memory-graph)做 lexical 搜尋,**不依賴 vector 設定**。同樣預設排除已注入節點。 | `memory.search('家族秘密')` 找歷史事件節點。 |
| `memory.list_recent(limit)` | 時間倒序瀏覽記憶節點,看看最近發生了什麼。 | `memory.list_recent(10)` 取最近 10 個事件節點。 |
| `memory.get(node_id)` | 按 id 拉節點本身 + 直連鄰居 id 列表(不含完整鄰居節點)。 | 看完 `memory.search` 拿到一個節點 id,用 `memory.get` 看它和誰相關。 |
| `search.search(query)` | **聯網搜尋**,轉發給 [Search Tools](/zh-TW/features/search-tools) 外掛(DuckDuckGo / SearXNG / Brave)。預設開啟,但需要 search-tools 擴展已載入並設定好 provider——否則 Agent 會收到 `SEARCH_UNAVAILABLE` / `SEARCH_DISABLED` 並自行改用其他工具。 | `search.search('某某新聞最新進展')` 返回 provider 形態的結果(通常是 `{title, url, snippet}` 列表)。 |
| `search.visit(url)` | 抓取 `search.search` 命中的某個頁面,返回可讀正文。 | 拿到搜尋結果後,`search.visit('https://example.com/article')` 把整篇正文拉回來。 |
| `finalize(capsule_text)` | **終止訊號**(強制啟用)。`capsule_text` 直接注入主模型 prompt。 | `finalize('林晚此刻心情焦慮:剛得知外祖母身世,可能在下一句對白中引出洛陽話題。')` |

## 失控保護(5 層,按觸發優先級)

1. **abort signal**:使用者點「停止」 / 上層取消 → 立即中止;trace 記 `cancelled`,**不**注入半成品 capsule。
2. **wall_clock_budget_ms**:到點立即 break。
3. **max_rounds**:硬輪次上限(預設 20,最多 50)。
4. **單工具呼叫 timeout**:複用 orchestrator 的 `agentTimeoutSeconds`;逾時即 `ToolError` 注回 agent。
5. **Agent 不呼叫工具**:連續 3 輪沒呼叫任何工具 → 提前 break(防止 agent「光說話不動手」耗光預算)。任意一輪呼叫到工具,streak 歸零。

觸發任一兜底時,loop 會把最後一次 agent 的自然文字作為 capsule 兜底,保證至少有產出送給主模型。

## Trace 排錯

orchestrator 的 trace 面板會逐輪記錄 loop 事件:

- `run_started` / `run_finished`:run 開始 / 結束(含狀態:`completed` / `budget_exhausted` / `cancelled`)
- `llm_request` / `llm_response`:每輪的請求 / 回應(含 `message_count`、`tool_call_count`)
- `tool_call` / `tool_result` / `tool_error`:每次工具呼叫的輸入和結果(`finalize` 也走這條;空 `capsule_text` 報 `code: FINALIZE_EMPTY`)
- `agent_no_tool_call`:agent 這一輪沒呼叫工具(含連續計數)
- `budget_exhausted`:觸發兜底時的具體 reason(`max_rounds` / `wall_clock` / `no_tool_call_streak`)

報 bug 給開發者時,可以在 trace 面板點「匯出本次 run」下載 jsonl 檔案附上。

::: warning persistTrace 是實驗性開關
設定裡的 `persistTrace` 可以讓所有 run 自動落盤到擴展資料目錄。**目前是實驗性的**——沒有跨平台穩定的寫盤 helper,開關預設關。日常用按需匯出就夠;只有需要持續追蹤某個 chat 的 loop 行為時才打開。
:::

## AI 迭代工作台用法

不會寫 system prompt?打開 loop popup → 點 **打開 AI 迭代工作台**,用自然語言描述你想要的 agent,AI 會讀你當前的 profile,用工具呼叫產出 patch(修改 `system_prompt` / 工具開關 / `max_rounds` / 預設路由)。詳見 [AI 迭代工作台](/zh-TW/features/orchestrator/iteration-studio#loop-模式的迭代提示)。

## 角色卡綁定

Loop 現已支援卡覆寫。在角色卡選中狀態打開編排編輯器,會出現 **儲存到角色卡覆寫** / **清除角色卡覆寫** 按鈕——和 Spec / Agenda 的體驗一致。綁定後這套 loop 設定會隨卡匯出,卡作者可以為自己的角色推薦「讀什麼、記什麼、何時 finalize」。

::: info 與 spec / agenda 的差異
Loop popup 當前沒有 **匯出 Profile** / **匯入 Profile** 按鈕,跨電腦同步先用 AI Iteration Studio 複用工作流。檔案級匯入匯出會等後續。
:::

## 與 spec / agenda 模式對比

| 維度 | spec / single | agenda | loop |
|---|---|---|---|
| 設定成本 | 需畫 DAG + 每節點 prompt | 寫 Planner prompt + worker prompts | 寫一段 system prompt + 勾工具 |
| Agent 數量 | 多(每 stage / 節點一個) | Planner + 多 worker | 單 agent |
| Preset 切換 | 多次 | 多次 | 一次 |
| 流程可變 | 拓撲固定 | Planner 決定調度 | agent 自己決定下一步 |
| 上下文連續性 | 透過 `previous_outputs` 傳變數 | 同 spec | 工具結果天然在 messages 裡 |
| 失敗處理 | 節點失敗直接傳播 | worker 失敗由 Planner 重試 | 工具失敗結構化注回,agent 自糾 |
| 角色卡覆寫 | ✅ | ✅ | ✅ |
| 檔案級匯入匯出 | ✅ | ✅ | ❌(用 Iteration Studio 複用) |
| 適合場景 | 流程明確、stage 固定 | 複雜任務需要調度 | 速度與效果平衡;探索性研究、動態決策、prompt cache 重要 |

## Loop 設定參考

<details>
<summary>Loop 專屬設定</summary>

| 設定 | 說明 |
|---|---|
| `max_rounds` | loop 最多跑多少輪(預設 20,上限 50) |
| `wall_clock_budget_ms` | 整個 loop 的牆鐘預算(預設 300000 ms / 5 分鐘) |
| `system_prompt` | loop agent 的 system 指令 |
| `tools.<namespace>.<verb>` | 每個工具的啟用開關(`finalize` 強制 true) |
| `apiPresetName` / `promptPresetName` | 單 agent 用的 API 與提示詞預設 |
| `capsule_inject` | 與 spec 模式一致的位置 / 深度 / 角色 / 自定義指令設定 |

</details>

## 常見問題

**Q:`memory.search` 返回空怎麼辦?**
A:先確認 memory-graph 擴展是否啟用、當前 chat 是否真的有記憶節點。返回空也可能是查詢詞太具體;試試 `memory.list_recent` 看時間線,再決定下一步。

**Q:`lorebook.search` 為什麼排除已啟用條目?**
A:那些條目已經透過 worldInfo 主流程注入了主模型上下文,loop agent 再把它們返回到自己的循環裡只是浪費 token。**用 `lorebook.get` 才能精確引用已啟用條目原文**,比如保持術語一致。

**Q:loop 跑到一半我想停下來怎麼辦?**
A:點工具列的 stop 按鈕(與 spec / agenda 一致)。loop runtime 在每輪頂部檢查 abort signal,立即中止;trace 寫 `cancelled`,不會注入半成品 capsule。

**Q:便箋會跨 chat 共享嗎?**
A:不會。`note.add` 寫入的是**當前 chat** 的 floor-state 命名空間,跨 chat 之間互不可見。刪除樓層 / swipe 走 floor-state 的 settle 機制——綁定到該樓的便箋會自動消失。

**Q:連續 3 輪不呼叫工具被打斷了怎麼辦?**
A:檢查 system prompt 是否給了 agent 明確的「產出格式」。多數情況是 agent 在「思考」但不知道何時該 finalize;在 prompt 裡加一條「當你掌握的資訊足以寫出 capsule 時,立即呼叫 finalize」通常能解決。

**Q:勾選了 `search.search`,Agent 卻收到 `SEARCH_UNAVAILABLE` / `SEARCH_DISABLED`?**
A:web 工具是把請求轉發給 [Search Tools](/zh-TW/features/search-tools) 外掛的。`SEARCH_UNAVAILABLE` 表示外掛沒載入;`SEARCH_DISABLED` 表示外掛載入了但被關掉了。打開 search-tools 設定面板,選好 provider(DuckDuckGo / SearXNG / Brave)、把總開關打開,再重試即可。

## 效能 trade-off

Loop 模式與 spec / agenda 在效能上有結構性差異:

- **延遲**:loop 一套 preset 跑全程,每輪 LLM 請求複用同一個 prompt cache 前綴,理論上端到端比 spec 快(spec 每個 stage 切 preset,cache 幾乎重建)。
- **token 用量**:loop **不一定省**。工具呼叫結果累加在同一個 messages 陣列裡,到第六、七輪時上下文已經顯著膨脹;spec 模式 stage 間斷流,每個 stage 的 prompt 較短。
- **失敗率**:loop 是新模式,可能比成熟的 spec 不穩定,agent 偶爾會跑岔。建議從短任務(`max_rounds=5`)開始試。

::: info 待手測驗證
具體延遲差距、capsule 主觀品質、token 總用量在不同 character / 不同模型下的實際表現,需要真實 LLM 呼叫做對比測試,目前文件裡的相對預期還沒有大規模量化資料。歡迎在用過幾天 loop 模式之後反饋你的感受。
:::

## 相關頁面

- [編排器概覽](/zh-TW/features/orchestrator/) — 通用設定 / 觸發時機 / 角色卡綁定
- [AI 迭代工作台](/zh-TW/features/orchestrator/iteration-studio) — AI 幫你寫 system prompt(推薦)
- [Spec 模式](/zh-TW/features/orchestrator/spec) — 預設的 DAG 模式
- [單 Agent 模式](/zh-TW/features/orchestrator/single) — 退化的 Spec
- [Agenda 模式](/zh-TW/features/orchestrator/agenda) — Planner 動態調度
- [Function Call Runtime](/zh-TW/improvements/function-call-runtime) — loop 工具呼叫走的運行時
- [記憶圖](/zh-TW/features/memory-graph) — `memory.*` 工具背後的資料源
