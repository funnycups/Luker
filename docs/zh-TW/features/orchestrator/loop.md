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

## 預設編排流程

Loop 模式只跑一個 Agent。它讀一眼手頭已有的資訊,決定是再去取點上下文,還是直接落筆寫 capsule,如此往復直到主動 `finalize`。

```d2
direction: down

start: "新一回合開始\n(為下一句回覆準備編排指引)" {
  shape: oval
  style.fill: "#e8f5e9"
}

loop: "一個 Agent 單幹" {
  style.fill: "#e1f5ff"

  think: "看一眼到目前為止已收集到的資訊,\n決定下一步動作" {
    style.fill: "#fffde7"
  }

  decide: "可以下筆寫 capsule 了嗎?" {
    shape: diamond
  }

  tool: "呼叫一個工具\n翻聊天 · 查世界書 · 翻記憶圖 ·\n記便箋 · 聯網搜尋\n—— 結果直接落進會話裡" {
    style.fill: "#fff3e0"
  }

  finalize: "寫下編排指引 capsule\n並 finalize 收尾" {
    style.fill: "#c8e6c9"
  }

  think -> decide
  decide -> tool: "還不行 —— 再取點上下文"
  decide -> finalize: "可以"
  tool -> think: "下一步"
}

out: "capsule 注入下一句主回覆" {
  shape: oval
  style.fill: "#f3e5f5"
}

start -> loop.think
loop.finalize -> out
```

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

工具走 OpenAI function-calling 協議,結果以 `role: tool` 訊息形式回到 Agent 的下一輪上下文。共 23 個可選工具 + 1 個強制 `finalize`:

| 工具 | 作用 | 簡單範例(RP 場景) |
|---|---|---|
| `note_open(text)` | 開啟一條**劇情作者線索**(伏筆、承諾、章節大綱)。便箋會在之後每次 loop 啟動時出現在 agent 的 "## Open Notes" 區塊,直到被關閉。單條上限 16KB。 | agent 發現自己剛埋了一個設定,呼叫 `note_open('林晚:外祖母在洛陽——下次見面兌現')`;之後幾輪 loop 都能看到這條線索。 |
| `note_close(id, reason?)` | 按 id 關閉一條已開啟的便箋(已兌現、不再需要等)。便箋從 "## Open Notes" 區塊中消失,但仍歸檔保留。 | 章節節拍落地後,`note_close('o_a3f2', '林晚見到外祖母,floor 73')`。 |
| `chat_read_range(start, end)` | 讀 chat 樓層範圍。負數從末尾倒數,單次最多 50 樓。 | `chat_read_range(-10, -1)` 讀最近 10 樓複習上下文。 |
| `chat_search(query, limit)` | 全聊天 substring 搜尋(大小寫不敏感),返回樓層 + 內容預覽。 | `chat_search('青冥劍')` 找出之前所有提到「青冥劍」的樓層。 |
| `lorebook_search(query, limit)` | 在所有啟用的世界書裡 substring 搜尋條目。**預設排除本回合已啟用的條目**(那些已經被注入主上下文,再返回會浪費 token)。返回 `entries` + `excluded_active_count`。 | `lorebook_search('落雁城')` 翻出未啟用的「落雁城」相關設定。 |
| `lorebook_get(entry_key)` | 按 key 拉取條目全文。**不去重**——允許 agent 精確引用某條已啟用條目以保持術語一致。 | `lorebook_get('落雁城-主城')` 把這一條全文調出來引用。 |
| `memory_list_candidates(seq_window?, types?, exclude_recent_messages?)` | 列舉可見的記憶圖候選池——與記憶圖自身召回 LLM 看到的同一組。回傳 `{ candidates: [{ id, type, level, title, seqTo, semanticDepth }] }`,按時間倒序。**召回流水線的第一步**。 | `memory_list_candidates({ types: ['event'] })` 回傳召回 LLM 會考慮的最近事件節點。 |
| `memory_keyword_search(query, types?, k?)` | 按 token 比對 title + 欄位值,無需 profile。回傳 `{ results: [{ id, type, title, seqTo, score, scoreMode: 'keyword' }] }`,按 score 降序。按關鍵字或短語查時用。 | `memory_keyword_search({ query: 'family secret', k: 8 })` |
| `memory_vector_search(query, types?, k?)` | 按設定的 embedding profile 做語義相似度搜尋。未設定 embedding profile 時直接拋 `NO_EMBEDDING_PROFILE`,不靜默 fallback;需要時手動回落到 `memory_keyword_search`。 | `memory_vector_search({ query: 'the moment she chose forgiveness', k: 5 })` |
| `memory_find_by_name(query, types?)` | 在 title + primary key 欄(通常含 aliases)上做大小寫不敏感子串比對。回傳 `{ matches: [...] }`。**建立角色 / 地點前先呼叫它確認實體不存在** —— 名稱去重時比 search 更便宜也更可靠。 | `memory_find_by_name({ query: 'Eileen', types: ['character_sheet'] })` |
| `memory_compaction_candidates(type, depth?)` | 純讀:查哪些節點群目前可做層級壓縮。回傳 `{ groups: [{ depth, childIds, fanIn }] }`,搭配 `memory_compact_nodes` 用。`compression.mode === 'none'` 的型別會回傳空 groups。 | `memory_compaction_candidates({ type: 'event' })` |
| `memory_node_create({ type, title, fields, links?, ref? })` | 建立新語義節點。節制使用 — 先呼叫 `memory_find_by_name` 確認實體不存在。回傳 `{ ok, id }`。 | `memory_node_create({ type: 'character_sheet', title: 'Marcus', fields: { traits: 'warrior, terse' } })` |
| `memory_node_edit({ node_id, set_fields?, clear_fields?, title? })` | 給已有節點打欄位補丁。`fields` 的 key 必須在該 type 的 `tableColumns` schema 裡(用 `memory_schema` 確認)。回傳 `{ ok }`。 | `memory_node_edit({ node_id: 'n_eileen', set_fields: { goal: 'reach the summit' } })` |
| `memory_node_delete({ node_id })` | 按 id 刪節點。僅當節點顯然過期 / 重複 / 錯誤時用。回傳 `{ ok }`。 | `memory_node_delete({ node_id: 'n_stale_dup' })` |
| `memory_link_upsert({ source_node_id\|source_ref, links })` | 在節點間加 relation 邊。必須使用規範的 relation 詞表。允許同一對節點上多種 relation 並存(複合狀態)。回傳 `{ ok, applied }`。 | `memory_link_upsert({ source_node_id: 'n_eileen', links: [{ target_node_id: 'n_protag', relation: 'partner_of' }] })` |
| `memory_link_delete({ source_node_id, target_node_id, relation, direction? })` | 刪 relation 邊。該方向上的 relation 不再成立時用(關係破裂、債務償清)。**不要為「替換」而刪** —— 複合多邊狀態本身就是合法的。回傳 `{ ok, removed }`。 | `memory_link_delete({ source_node_id: 'n_eileen', target_node_id: 'n_protag', relation: 'sworn_to' })` |
| `memory_compact_nodes({ type, child_ids, summary, fields? })` | 建立一個高層 rollup 節點,把指定 children reparent 進來;同時加 `semantic_contains` 邊。在 `memory_compaction_candidates` 回傳 groups 後呼叫。回傳 `{ ok, rollup_node_id }`。 | `memory_compact_nodes({ type: 'event', child_ids: ['e1', 'e2', 'e3'], summary: '時間：Day 1-3；...' })` |
| `memory_node_brief(node_id, include_edge_summary?, edge_summary_limit?)` | 節點的標準化 brief(title、summary、key/row 欄位、子節點數、exposure、edge summary、alwaysInject)——與召回 LLM 看到的單行格式一致。 | 搜尋拿到短名單後,`memory_node_brief({ node_id: 'evt_42' })` 拉一個節點的完整 brief。 |
| `memory_edge_summary(node_id, edge_types?, limit?)` | 只回傳邊摘要 `{ degree, relations, sample_neighbors }`。只想判斷「這是不是個 hub」而不要整個 brief 時用。 | `memory_edge_summary({ node_id: 'evt_42' })` 只取拓撲訊號。 |
| `memory_expand_seeds(seed_ids, hops?, edge_types?, include_children?)` | 從種子 id 沿子節點 + 投影邊做 BFS 擴展。當某節點主題相關但具體細節大機率在子節點或相關 rollup 時用。 | `memory_expand_seeds({ seed_ids: ['evt_42'], hops: 1, include_children: true })` 浮現 `evt_42` 的子節點。 |
| `memory_schema()` | 一輪一次:有哪些節點型別,哪些欄位是 key vs detail,哪些型別走 hierarchical compression。讓你能正確解讀其他 memory_* 工具的回傳。 | 召回開始前 `memory_schema()` 一次,瞭解可用的型別集。 |
| `search_search(query)` | **聯網搜尋**,轉發給 [Search Tools](/zh-TW/features/search-tools) 外掛(DuckDuckGo / SearXNG / Brave)。預設開啟,但需要 search-tools 擴展已載入並設定好 provider——否則 Agent 會收到 `SEARCH_UNAVAILABLE` / `SEARCH_DISABLED` 並自行改用其他工具。 | `search_search('某某新聞最新進展')` 返回 provider 形態的結果(通常是 `{title, url, snippet}` 列表)。 |
| `search_visit(url)` | 抓取 `search_search` 命中的某個頁面,返回可讀正文。 | 拿到搜尋結果後,`search_visit('https://example.com/article')` 把整篇正文拉回來。 |
| `finalize(capsule_text)` | **終止訊號**(強制啟用)。`capsule_text` 直接注入主模型 prompt。 | `finalize('林晚此刻心情焦慮:剛得知外祖母身世,可能在下一句對白中引出洛陽話題。')` |

工具呼叫結束後,結果以淺黃色 `工具結果` 塊掛在對話流裡,agent 下一段 `助手` 塊的思考就能直接基於它繼續推進。這種「調工具 → 看結果 → 繼續 → 適時 finalize」的節奏正是 loop 與 spec / agenda 拉開差距的地方:整段上下文留在 messages 裡,沒有 stage 之間的斷流。

![Loop 對話流:工具結果回到 agent 下一輪思考](/images/orchestrator/real-loop-conversation-tool.png)

## 失控保護(5 層,按觸發優先級)

1. **abort signal**:使用者點「停止」 / 上層取消 → 立即中止;trace 記 `cancelled`,**不**注入半成品 capsule。
2. **wall_clock_budget_ms**:到點立即 break。
3. **max_rounds**:硬輪次上限(預設 20,最多 50)。
4. **Agent 不呼叫工具**:連續 3 輪沒呼叫任何工具 → 提前 break(防止 agent「光說話不動手」耗光預算)。任意一輪呼叫到工具,streak 歸零。

觸發任一兜底時,loop 會把最後一次 agent 的自然文字作為 capsule 兜底,保證至少有產出送給主模型。

## Trace 面板

主回覆出來後在編排器面板點 **查看運行態軌跡** 就能開啟 loop run 的 trace 彈窗。它把整次 loop 拆成幾塊呈現——頂部元資訊、Agent 對話、流程事件時間線、原始資料——下面按面板順序逐塊看。

### 面板概覽

最上面一行是狀態摘要:狀態(已完成 / 取消 / 預算耗盡)、模式(`loop`)、生成類型(`normal` / `continue` / `regenerate` / `swipe` / `impersonate`)、目標樓、節點執行次數、REVIEW 重跑次數、更新時間。

![Loop trace 面板頂部元資訊](/images/orchestrator/real-loop-meta.png)

### Agent 對話

「Agent 對話」一欄按訊息順序鋪出整輪 loop 的 messages 陣列——`系統` 塊是 system prompt,`助手` 塊是 agent 那一輪的思考與工具呼叫(參數直接展開,不用看 raw json),後接 `工具結果` 塊。整次 loop 的所有上下文都在這裡看,對照 prompt 找 agent 跑岔的根因。

![Agent 對話:system 提示詞 + 第一輪思考 + chat_read_range 工具呼叫](/images/orchestrator/real-loop-conversation-system.png)

下一輪裡 agent 拿到上一次工具的返回,補一段思考,調 `finalize`。`finalize` 也走 tool_call 通道,`capsule_text` 直接展開成結構化文本——就是會注入主模型的那段。

![Agent 對話:finalize 呼叫與 capsule_text 全文](/images/orchestrator/real-loop-conversation-assistant.png)

### 流程事件

「流程事件」一欄按時間序號排出每個 trace event,帶 ISO 時間戳。run 起止、每輪 llm_request / llm_response、每次 tool_call / tool_result / tool_error 都各佔一行;觸發兜底時會有 `budget_exhausted` 行,帶具體 reason。

![Loop 流程事件:run_started → llm_request/response → tool_call/result → Run completed](/images/orchestrator/real-loop-events.png)

事件類型速查:

- `run_started` / `run_finished`:run 開始 / 結束(含狀態:`completed` / `budget_exhausted` / `cancelled`)
- `llm_request` / `llm_response`:每輪的請求 / 回應(含 `message_count`、`tool_call_count`)
- `tool_call` / `tool_result` / `tool_error`:每次工具呼叫的輸入和結果(`finalize` 也走這條;空 `capsule_text` 報 `code: FINALIZE_EMPTY`)
- `agent_no_tool_call`:agent 這一輪沒呼叫工具(含連續計數)
- `budget_exhausted`:觸發兜底時的具體 reason(`max_rounds` / `wall_clock` / `no_tool_call_streak`)

### 原始軌跡 / 匯出

面板最底下「最新注入文本」是 capsule 終態;接著的「原始運行態軌跡」是整次 run 的 JSON 形態——`runId`、`chatKey`、`generationType`、`capsuleText` 等頂層欄位都在這裡。報 bug 時點「匯出本次 run」會下載這份 JSON 的 jsonl 形式,直接附給開發者。

![Loop 原始軌跡 JSON 與最新注入文本](/images/orchestrator/real-loop-rawtrace.png)

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

**Q:`memory_list_candidates` 返回空怎麼辦?**
A:先確認 memory-graph 擴展是否啟用、當前 chat 是否真的有記憶節點。返回空也可能是這個 chat 還很早、還沒產生候選節點;可以用 `memory_schema` 確認型別表已經填充。

**Q:`lorebook_search` 為什麼排除已啟用條目?**
A:那些條目已經透過 worldInfo 主流程注入了主模型上下文,loop agent 再把它們返回到自己的循環裡只是浪費 token。**用 `lorebook_get` 才能精確引用已啟用條目原文**,比如保持術語一致。

**Q:loop 跑到一半我想停下來怎麼辦?**
A:點工具列的 stop 按鈕(與 spec / agenda 一致)。loop runtime 在每輪頂部檢查 abort signal,立即中止;trace 寫 `cancelled`,不會注入半成品 capsule。

**Q:便箋是否跨 chat 共享?**
A:不會——便箋保存在當前 chat 的持久化狀態裡。floor-state 的 settle 機制會自動處理分支和刪除。

**Q:連續 3 輪不呼叫工具被打斷了怎麼辦?**
A:檢查 system prompt 是否給了 agent 明確的「產出格式」。多數情況是 agent 在「思考」但不知道何時該 finalize;在 prompt 裡加一條「當你掌握的資訊足以寫出 capsule 時,立即呼叫 finalize」通常能解決。

**Q:勾選了 `search_search`,Agent 卻收到 `SEARCH_UNAVAILABLE` / `SEARCH_DISABLED`?**
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
- [Notes](/zh-TW/features/orchestrator/notes) — open/close 便箋模型的面板使用與概念詳解
