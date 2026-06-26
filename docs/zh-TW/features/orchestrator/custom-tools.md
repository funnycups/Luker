# 自訂工具

自訂工具讓你給編排器的 agent 加新能力——超出 Luker 內建的 chat / lorebook / note / memory 工具範圍。一共支援三條來源通道，四種編排模式（loop / spec / agenda / director）看到它們的方式完全一致。

## 自訂工具的來源

**來自其他 Luker 擴充。** 像 memory-graph、search-tools 這類擴充在啟動時註冊自己的工具。你什麼都不用做——這些工具會出現在編排編輯器的「自訂工具 → 擴充（來自其他外掛）」裡，新建編排時預設啟用。

**來自 SillyTavern。** SillyTavern 本身也有 function tool 系統，其他外掛會用它註冊工具。要把這些工具暴露給編排器 agent，開啟編排編輯器，點「橋接 SillyTavern 工具……」——挑你想要的工具，給每個工具選「讀」或「寫」模式，儲存。它們會出現在「自訂工具 → 來自 SillyTavern」分組裡。

**在本編排裡手寫。** 上面兩條通道都覆蓋不到的一次性需求，你可以現寫一個工具。在編排編輯器的「自訂工具」區點「新增自訂工具」。這種方式定義的工具會跟著編排走——全域編排裡寫的就全域生效，角色卡覆寫裡寫的就會隨角色卡一起匯出。

## 「新增自訂工具」對話框

- **工具名** —— `a-z`、`A-Z`、`0-9`、`_`，最長 64 個字元。必須以字母開頭，不能跟內建工具或同一編排裡別的工具重名。
- **顯示名** —— 在編排編輯器的工具列表裡顯示。LLM 看到的仍然是上面那個技術名。
- **描述** —— 寫給 LLM 看的工具說明，不是寫給你自己看的。
- **模式**
  - **讀（無副作用）** —— 模擬評審期總是真實執行。
  - **寫（修改狀態）** —— 模擬評審期會跳過，除非你提供了模擬本體。
- **參數（OpenAI JSON Schema）** —— LLM 傳入參數的 JSON Schema 描述。儲存時會按 JSON 解析驗證。
- **函式本體** —— 非同步 JavaScript,兩個參數:
  - `args` —— LLM 傳過來已解析的參數。
  - `ctx` —— SillyTavern `getContext()` 那個物件,外加編排執行時掛的幾個欄位。完整欄位列表見下面 [ctx 上有什麼](#ctx-上有什麼)。

  你 `return` 什麼,LLM 就看到什麼作為工具結果。`throw` 會把錯誤拋回給 agent。
- **模擬本體** —— 選填,簽名同函式本體。模擬評審期間對寫工具用,讓模擬跑出來的結果形狀跟真實執行一致,但不會改任何真實狀態。

### ctx 上有什麼

`ctx` 原型鏈上繼承 SillyTavern `getContext()` 回傳的所有欄位,外加編排執行時掛的幾個內部欄位。

來自 SillyTavern(用法跟 `getContext()` 完全一樣):

- `ctx.chat` —— 即時聊天陣列,最新一則在最後
- `ctx.characters`、`ctx.characterId` —— 目前角色卡清單與索引
- `ctx.groups`、`ctx.groupId` —— 群聊時的目前群組與索引
- `ctx.name1`、`ctx.name2` —— `{{user}}` 與 `{{char}}` 解析後的目前名字
- `ctx.eventSource`、`ctx.eventTypes` —— 發送 / 訂閱執行時事件
- `ctx.getExtensionApi(name)` —— 呼叫其他擴充功能發布的 API(例如 `ctx.getExtensionApi('memory-graph')`)
- `ctx.registerOrchestrationTool`、`ctx.bridgeSillyTavernTool` 等 —— 同 [編排器工具 API](/zh-TW/development/extension-api/orchestrator-tools) 文件描述的那一套

編排執行時掛的(只在編排過程中存在):

- `ctx.__lukerRun` —— 本次 run 的執行時狀態。值得一提的是 `ctx.__lukerRun.activatedEntryKeys` 是一個 `Set`,裡面是本輪已經被注入的 World Info 條目 key(你的工具若要再呈現 lorebook 內容可據此去重)。
- `ctx.__floorStateForNotes` —— `note_open` / `note_close` 工具底層用的 floor-state 實例。想跟便箋系統協作的工具可以讀它。
- `ctx.__customToolRegistry` —— 你的工具被編譯進的那個 per-run Layer-3 註冊表。大多數工具用不到,留給少數進階情境(例如反向列舉本編排裡的其他手寫工具)。
- `ctx.__memoryGraphSession` —— 由第一次 `memory_*` 工具呼叫 lazy 開啟;本輪跑過至少一次 memory 工具之後才會出現。

欄位命名衝突:SillyTavern 占頂層名字空間;編排執行時只掛 `__` 前綴的欄位,所以兩邊互不踩。

最小例子:

```js
// 讀目前角色名
return { char: ctx.characters[ctx.characterId]?.name };

// 呼叫另一個擴充功能的 API
const mg = ctx.getExtensionApi('memory-graph');
const session = await mg.openSession(ctx);

// 發出事件,別處可以訂閱
ctx.eventSource.emit('my_tool_fired', { args });

// 協作式取消:檢查本 run 的 abort signal
if (ctx.__lukerRun?.abortSignal?.aborted) {
    throw new Error('aborted');
}
```

### 安全提示

函式本體跑在頁面 context 裡，權限和任何 Luker 模組一樣大。它可以發起任意 URL 請求、改全域狀態、讀你的私聊內容。**只貼上你信任的程式碼。**

當你正在匯入的角色卡帶了自訂工具，Luker 會先彈一個審查對話框，把每個工具的名字、描述、模式、完整程式碼都列出來再問你要不要匯入。你可以點「匯入並套用工具」全盤接收，「匯入但不套用工具」只匯入角色卡本身丟掉這些工具，或者展開每一項先把程式碼看一遍。

## 啟用與停用

編排編輯器的「自訂工具」核取方塊面板控制每個工具在本編排下要不要餵給 LLM。取消勾選不會刪除定義，之後隨時可以再勾回來。

子代理的工具覆寫（spec 節點 / agenda agent / director 子代理）對自訂工具的處理跟內建工具一樣——單節點的覆寫會覆蓋編排預設值。

## 模擬評審

自訂工具會進入 [AI 迭代工作台](./iteration-studio.md) 用來在不寫真實狀態的前提下、把工作流跑在你目前聊天上的那條模擬管線。讀工具總是真實派發到你的程式碼。寫工具如果你寫了模擬本體就走模擬本體；否則回傳標準佔位 `{ ok: true, simulated: true, unvalidated: true }`，trace 裡會標成「未驗證」。

## 迭代工作台

AI 迭代工作台直接在工作 profile 上讀寫自訂工具的 Layer-3 定義。它有完整的讀 / 寫 / 檢查表面，外加沙箱 dry-run 和發現工具，這樣它能在請你確認前先用真實的 `ctx` 把程式碼校驗過。

讀工具（結果直接回傳，無需審閱）：

- `luker_orch_list_custom_tools` —— 列出 profile 上的工具，帶模式 / 描述 / 是否有模擬本體 / 一行參數 schema 摘要。
- `luker_orch_get_custom_tool` —— 按名稱回傳某個工具的完整內容（含函式本體）。
- `luker_orch_dry_run_custom_tool` —— 在沙箱裡編譯 + 執行函式本體（可傳入實參），回傳 `{ok, result, error, logs, durationMs}`；硬牆時長 3 秒；`console.log/warn/error` 會被捕獲。`name`（跑 profile 上現存工具）或 `body`（編譯內聯函式本體）二選一。
- `luker_ctx_list_keys` / `luker_ctx_describe` —— 列舉 / 鑽入執行時 `ctx`（就是 SillyTavern/Luker 擴充透過 `getContext()` 拿到的那個物件）。回傳型別 / 函式 arity / 原始碼預覽 / 子鍵。
- `luker_docs_list` / `luker_docs_read` —— 列出和讀取 `docs/` 下的 markdown 文件（預設隱藏 zh-CN / zh-TW 翻譯）。推薦起步：`features/orchestrator/custom-tools.md`、`development/extension-api/chat-and-state.md`、`development/extension-api/generation.md`、`development/extension-api/world-info.md`、`development/extension-api/orchestrator-tools.md`。

寫工具（在迭代工作台的 ProposalBus 上掛一張待審 card；你不點同意就什麼都不會落到 profile）：

- `luker_orch_set_custom_tool` —— 新建或整體覆蓋一條工具。掛卡前函式本體會做一次編譯校驗；語法錯的話立刻被拒絕、不掛卡。
- `luker_orch_patch_custom_tool_body` —— 對現有函式本體做 find/replace 局部補丁（預設要求 `oldString` 命中唯一一處；`replaceAll: true` 才允許多處替換）。補丁後的函式本體也會被再次編譯校驗。微調時優先用它，可避免重新提交大段函式本體。
- `luker_orch_patch_custom_tool_schema` —— 只替換參數 JSON-Schema，函式本體保持不變。
- `luker_orch_remove_custom_tool` —— 按名稱刪除一條工具。審閱 card 會把即將被刪的函式本體顯示出來，方便你確認。

每次 `set` 提案被你接受後，迭代工作台會同時把模式對應的啟用開關（loop / director 是 `tools.custom.<name>`，agenda 是 `defaultTools.custom.<name>`，spec 是 `spec.defaultTools.custom.<name>`）切到 `true`，這樣新工具立刻就會餵給執行時 agent。

來自其他擴展（Layer-2）的工具定義不能在工作台裡改——那些定義在註冊它們的擴展裡，工作台只能切它們的啟用開關。

## 相關頁面

- [編排器概覽](./) —— 通用設定 / 觸發時機 / 角色卡綁定
- [AI 迭代工作台](./iteration-studio.md) —— 讓 AI 幫你決定工具開關
- [Loop 模式](./loop.md) —— 單 agent 工具循環，是自訂工具最能發揮的地方
- [Director 模式](./director.md) —— 主代理 + 子代理，全部都能呼叫自訂工具
- [編排器工具 API](/zh-TW/development/extension-api/orchestrator-tools) —— 想從自己的擴充註冊工具的外掛開發者看這裡
