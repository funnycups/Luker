# 迭代工具函式庫（Iteration Library）

`context.iterationLibrary` 為 AI 驅動的迭代式編輯介面提供共享基礎設施：LLM 工具呼叫 runner、訊息與 diff 渲染、全螢幕對比浮層、用於審閱修改提案的 ProposalBus，以及與具體外掛解耦的世界書、技能、預設和上下文檢索工具集。

如需將可迭代編輯的目標直接接入 Luker 統一的**工作台 → AI 迭代**分頁，請透過 [`context.workbench.registerIterateTarget`](/zh-TW/development/extension-api/workbench#註冊-ai-迭代目標) 註冊 `IterateTarget`。外掛自行管理獨立彈窗或全螢幕開發環境如 CardApp Studio 時，直接呼叫 `context.iterationLibrary`。

## 接入方式

```js
// Layer 1 — ESM 匯入
import { runner, ui, proposalBus } from '/scripts/iteration-library/index.js';

// Layer 2 — lukerContext
const { runner, ui, proposalBus } = lukerContext.iterationLibrary;

// Layer 3 — getContext()
const { runner, ui, proposalBus } = Luker.getContext().iterationLibrary;
```

`iterationLibrary` 是凍結物件，Layer 2 與 Layer 3 回傳同一物件。

| 成員 | 類型 | 用途 |
| --- | --- | --- |
| `applyEdits`、`inverseEdit`、`registerOp`、`BUILT_IN_OPS`、`showConflictResolution` | 函式 / 陣列 | [Edits 函式庫](./edits-lib.md) |
| `render` | 命名空間 | 渲染訊息正文的 Markdown |
| `runner` | 命名空間 | 工具呼叫請求驅動、持久化工具呼叫訊息、中止輔助函式 |
| `textDiff` | 命名空間 | 並排文字 diff |
| `zoomOverlay` | 命名空間 | 文字 diff 的全螢幕檢視與分欄拖曳 |
| `ui` | 命名空間 | 訊息卡片、diff 卡片、共用樣式表 |
| `tools` | 命名空間 | 共用工具目錄與執行器 |
| `proposalBus` | 命名空間 | ProposalBus 工廠與 kind 描述符 |
| `bindIterWorkspaceResizer` | 函式 | 雙欄工作區的拖曳分隔條 |

ESM 入口另外匯出 `createRenderScheduler`。匯入 `/scripts/iteration-library/index.js` 會載入全部命名空間；只需個別輔助函式的模組直接匯入該函式所在檔案，例如 `/scripts/iteration-library/text-diff.js`。

以 `_` 開頭的成員用於單元測試重設模組快取，不屬於執行期契約。

## Edits

`applyEdits(edits, live)`、`inverseEdit(edit)`、`registerOp(name, handler)`、`BUILT_IN_OPS` 與 `showConflictResolution(conflicts, opts)` 即 [Edits 函式庫](./edits-lib.md) 的函式，在此重新匯出，工作台透過同一物件即可取得全部能力。

## render

| 成員 | 簽名 | 行為 |
| --- | --- | --- |
| `ensureMarkdownDeps` | `() => Promise<boolean>` | 載入 Markdown 轉換器與 HTML 淨化器，重複呼叫不重複載入。兩者就緒時解析為 `true`，載入失敗時解析為 `false`。 |
| `renderMessageMarkdown` | `(text) => string` | 回傳淨化後的 HTML。`ensureMarkdownDeps` 解析前回傳跳脫後的文字，並開始載入。 |

## runner

### `requestToolCallsWithRetry(context, settings, options)`

透過 `context.generateTask` 傳送請求；`context.isStreamingPresetEnabled(llmPresetName)` 為真時改用 `context.generateTaskStream`。隨後依工具 schema 驗證回傳的工具呼叫，失敗的嘗試依設定重試。

- `context` —— `Luker.getContext()` 回傳的物件。
- `settings` —— 讀取 `toolCallRetryMax` 作為重試次數，讀取 `rpmLimit` 作為 RPM 上限。缺少 `toolCallRetryMax` 時不重試，重試次數沒有上限；`rpmLimit: 0` 表示不限制。

| 選項 | 預設值 | 用途 |
| --- | --- | --- |
| `tools` | — | 必填，非空的 OpenAI 風格函式定義陣列 |
| `taskMessages` | `[]` | 作為任務傳送的聊天補全訊息 |
| `apiPresetName` | `''` | 連線設定檔；留空使用目前連線 |
| `llmPresetName` | `''` | 聊天補全預設；留空使用目前預設 |
| `runtimeWorldInfo` | `null` | 傳給 `generateTask` 的預解析世界書 |
| `allowedNames` | `null` | 陣列或 `Set`；非空時捨棄名稱不在其中的呼叫 |
| `retriesOverride` | `null` | 取代 `settings.toolCallRetryMax` |
| `abortSignal` | `null` | 中止請求；已中止的嘗試直接拒絕，不重試 |
| `includeAssistantText` | `false` | 解析為下文所述的物件形式 |
| `allowNoToolCalls` | `false` | 接受只有文字、沒有相符工具呼叫的回覆 |
| `allowEmptyResponse` | `false` | 接受任何沒有相符工具呼叫的回覆，無論是否帶有文字 |
| `substituteMacros` | `false` | 替換任務訊息中的巨集；編輯含巨集原始文字的工作台保持關閉 |
| `toolChoice` | `'auto'` | 傳送給服務商的工具選擇 |
| `requiredFunctionName` | `''` | 要求服務商呼叫的函式 |
| `reservedToolCallIds` | `null` | 會話已占用的工具呼叫 id 集合。設定後，回傳呼叫的 id 若已被占用、已出現在 `taskMessages` 中或在同一回覆內重複，則替換為新 id。 |
| `rpmBucket` | `'default'` | RPM 計數視窗；傳入相同鍵的呼叫方共用同一視窗 |
| `logLabel` | `'orchestrator'` | 重試警告的前綴 |
| `isControlCall` | `null` | `(call) => boolean`；相符的呼叫交給 `onControlCall` |
| `onToolCall` | `null` | `(call)`，依序逐一接收非控制呼叫 |
| `onControlCall` | `null` | `(call)`，逐一接收控制呼叫 |
| `onAssistantText` | `null` | `(text)`，在成功且文字非空的嘗試後呼叫 |
| `onUsage` | `null` | `(usage)`，傳入服務商回傳的 token 用量 |
| `onFirstChunk` | `null` | `()`，在嘗試收到首個串流片段時呼叫 |

回呼在驗證之後、Promise 解析之前執行。回呼拋出的例外只記錄日誌，不會導致請求失敗。

Promise 解析為 `{ name, args, id, raw }` 陣列；傳入 `includeAssistantText: true` 時解析為 `{ toolCalls, assistantText, rawAssistantText, reasoning, reasoningBlocks, reasoningDetails }`。`tools` 為空、缺少 `context.generateTask`、回覆沒有相符的工具呼叫且 `allowNoToolCalls` 與 `allowEmptyResponse` 均不接受，或末次重試仍未通過驗證時，Promise 拒絕。

### 持久化工具呼叫訊息

工作台會話以 OpenAI 格式的 `tool_calls` 與 `tool_results` 儲存 assistant 輪次，後續輪次據此回放聊天補全歷史。

| 成員 | 行為 |
| --- | --- |
| `buildPersistentToolCallsFromRawCalls(rawCalls = [])` | 將 runner 呼叫 `{ name, args, id }` 轉為 `{ id, type: 'function', function: { name, arguments } }`。工具名稱中的點號替換為底線，缺少的 id 自動產生，捨棄缺少名稱的呼叫。 |
| `buildExecutionToolCalls(rawCalls = [])` | 執行同樣的轉換，回傳帶已解析參數的 `{ id, name, args }`。 |
| `buildPendingToolResults(toolCalls = [], summaryText = '')` | 為各呼叫回傳 `{ tool_call_id, content }`；`content` 為 `{ ok: true, pending: true, summary }` 的 JSON，`summary` 預設為 `Pending review.` |
| `createPersistentToolTurnMessage({ messageId, assistantText, toolCalls, toolResults, toolSummary, toolState, auto, at, extra })` | 建立儲存用的 assistant 訊息 `{ id, role, content, auto, at, tool_calls, tool_results }`，`toolSummary` 與 `toolState` 非空時一併寫入，並合併 `extra` 的欄位。`toolCalls` 採用儲存格式；捨棄 `tool_call_id` 無對應呼叫的結果。 |
| `buildPersistentToolHistoryMessages(messages = [])` | 將同時帶呼叫與結果的儲存訊息展開為歷史：先是帶 `tool_calls` 的 assistant 訊息，再是各結果對應的 `tool` 訊息。 |
| `collectIterToolCallIds(messages = [])` | 回傳訊息中全部工具呼叫 id 的 `Set`，讀取 `toolCalls`、`tool_calls`、`toolResults` 與 `tool_call_id`。回傳值用作 `reservedToolCallIds`。 |
| `makeAiIterationMessageId(prefix = 'orch_msg')` | 回傳 `<prefix>_<time>_<random>`。 |

Layer 1 模組 `/scripts/lib/iter-tool-calling.js` 另外匯出：

| 成員 | 行為 |
| --- | --- |
| `normalizeToolCallRetryMax(value, fallback)` | `null`、`undefined` 與空白字串回傳 `fallback`，其餘值取整並限制為不小於 `0`；非數值回傳 `fallback` |
| `serializeToolResultContentPreferText(result)` | `result.toolResultText` 為非空字串時原樣回傳，否則將 `result` 轉為字串或縮排格式的 JSON |

### `runner.abortUtils`

| 成員 | 行為 |
| --- | --- |
| `isAbortSignalLike(value)` | 物件帶 `aborted` 屬性時為 `true` |
| `isAbortError(error, abortSignal = null)` | 訊號已中止、錯誤名稱為 `AbortError` 或錯誤訊息提及 abort 時為 `true` |
| `isStrictAbortError(error, signal = null)` | 錯誤名稱為 `AbortError` 或訊號已中止時為 `true`，不檢查錯誤訊息 |
| `createAbortError(message = 'Operation aborted.')` | 回傳名為 `AbortError` 的 `DOMException`；環境缺少 `DOMException` 時回傳同名 `Error` |
| `throwIfAborted(abortSignal, message = 'Operation aborted.')` | 訊號已中止時拋出 `createAbortError(message)` |
| `linkAbortSignals(...signals)` | 回傳 `{ signal, cleanup }`。任一輸入中止時 `signal` 隨之中止，`cleanup()` 移除監聽。沒有有效輸入時 `signal` 為 `null`，僅有唯一輸入時即為該訊號。 |
| `raceAbortSignal(promise, signal)` | 隨 `promise` 落定；`signal` 一旦中止即以中止錯誤拒絕。原 Promise 繼續執行。 |

## textDiff

| 成員 | 行為 |
| --- | --- |
| `renderInlineTextDiffHtml(beforeValue, afterValue, options = {})` | 回傳包含逐行逐詞並排 diff 的 `<details>` 區塊，全部文字均經 HTML 跳脫。選項：`fileLabel` 為全螢幕檢視的標題；`i18n` 為翻譯函式；`expandAffordance: false` 隱藏展開按鈕；`forceOpen: true` 預設展開。末位參數為字串時視作 `fileLabel`。呼叫時注入樣式表。 |
| `renderInlineTextDiffElement(beforeValue, afterValue, options = {})` | 將 `renderInlineTextDiffHtml` 生成的 `<details>` 區塊解析為 DOM 元素並回傳，參數與選項完全一致。 |
| `ensureStylesheetInjected()` | 注入 diff 樣式表 `<link>`，重複呼叫不重複注入 |
| `STYLESHEET_ID`、`STYLESHEET_HREF` | 該 `<link>` 的 id 與位址 |
| `sanitizeDiffPlaceholderValue(value)` | 空文字與英文、簡體中文、繁體中文的 `Not set` 預留位置回傳 `''`，其餘文字原樣回傳 |
| `formatDiffValue(value)` | 與 `sanitizeDiffPlaceholderValue` 相同 |

## zoomOverlay

| 成員 | 行為 |
| --- | --- |
| `attachZoomOverlay(popupRoot, options = {})` | 在 `popupRoot` 下綁定委派事件，`popupRoot` 可為元素、jQuery 物件或選擇器；沒有 id 的元素會被指派 id。點擊 `[data-luker-lib-action="expand-line-diff"]` 全螢幕開啟 diff；關閉按鈕、背景遮罩與 Esc 關閉全螢幕；拖曳 `.luker_lib_diff_splitter` 調整分欄。`options.namespace` 為 jQuery 事件命名空間，預設值 `.luker_lib_diff`；以相同命名空間再次綁定會取代先前的綁定，各彈窗應傳入各自的命名空間。`options.i18n` 翻譯全螢幕介面的文字。回傳解除綁定函式。 |
| `openExpandedDiff(rootElement, triggerElement, options = {})` | 在 `rootElement` 內全螢幕開啟包含 `triggerElement` 的 diff |

## ui

### `ui.message`

`renderMessageCard(message, opts = {})` 回傳單則對話訊息的 HTML。訊息欄位：`id`、`role`，取值 `'user'`、`'assistant'` 或 `'system'`，以及 `content`、`toolCalls`、形如 `{ tool_call_id, content, status }` 的 `toolResults`、`edits`、`appliedAt`、`appliedTarget`、`rolledBackAt`、`auto` 和推理欄位 `reasoning`、`reasoningBlocks`、`reasoningDetails`。

| 選項 | 用途 |
| --- | --- |
| `toolDisplay` | `{ [toolName]: { icon, label, type, summarize } }`。`type` 取 `'read'`、`'edit'` 或 `'control'`；`label` 為英文原始字串，渲染時經 `i18n` 翻譯；`summarize(args, result, i18n)` 回傳單行摘要。 |
| `renderEditCard` | `(edit, message) => html`，逐項處理 `message.edits` |
| `renderApplyControls` | `(message) => html`，置於編輯卡片與重新產生按鈕之間 |
| `renderMarkdown` | `(text) => html`；未提供時文字經跳脫輸出 |
| `i18n` | `(template, ...args) => string`，預留位置形如 `${0}` |
| `actionAttribute` | 按鈕使用的屬性名稱，預設 `data-luker-lib-action` |

按鈕透過該屬性攜帶 `regenerate` 或 `edit-user-message`，並附帶 `data-luker-lib-msg-id`。帶 `auto: true` 的使用者訊息與無可顯示內容的 assistant 訊息渲染為 `''`。

`bindChainBrokenBanner(root, bus, opts = {})` 監聽 bus 的 `bus:chain-broken` 事件，停用 `root` 內的 `[data-iter-input]` 並附加經 `opts.translate` 翻譯的橫幅。回傳解除綁定函式。

### `ui.diff`

`renderDiffCard(input, opts = {})`：

- `input` 為編輯陣列時，回傳逐筆編輯渲染的卡片 HTML 字串。
- `input` 為 ProposalBus 項目 `{ target, inverse }` 時，回傳 `Promise<string>`：透過目標註冊表讀取目前值，還原提案時的值並渲染改動；還原失敗時渲染原始記錄。

| 選項 | 用途 |
| --- | --- |
| `fieldLabels` | 欄位路徑到顯示標籤的對應 |
| `includeRawArgs` | 在卡片下附帶原始參數 |
| `live` | 字串類編輯據以解析路徑的值；待審編輯應傳入 |
| `i18n`、`translate` | 翻譯函式 |

### `ui.ensureUiStylesheetInjected()`

注入共用的 `luker_lib_*` 樣式表並安裝推理區塊複製按鈕的處理函式，重複呼叫不重複注入。

## tools

各工具命名空間提供工具名稱、可併入工作台工具目錄的 OpenAI 風格定義、判定函式與執行器。執行器接收 runner 呼叫 `{ id, name, args }`，解析為 `{ ok: true, result }` 或 `{ ok: false, error }`。`runCharacterPresetReadTool` 的全部失敗結果、`runLorebookReadTool` 執行期間拋出的失敗結果，以及世界書寫入與技能執行器因參數或目標出錯的失敗結果，另帶狀態錯誤碼 `reason` 與簡短的 `hint`，錯誤碼如 `VALIDATION_ARGS`、`CONFLICT`。

### `tools.lorebookReads`

| 成員 | 行為 |
| --- | --- |
| `LOREBOOK_READ_TOOL_NAMES` | `world_book_list`、`lorebook_list`、`lorebook_query`、`lorebook_get` |
| `LOREBOOK_READ_TOOL_DEFS` | 工具定義 |
| `isLorebookReadTool(name)` | 判定函式 |
| `runLorebookReadTool(call, { context, avatar = '' })` | 執行呼叫；`avatar` 指定 `world_book_list` 列出哪個角色的世界書 |

### `tools.lorebookWrites`

| 成員 | 行為 |
| --- | --- |
| `LOREBOOK_WRITE_TOOL_NAMES` | `lorebook_update_entry`、`lorebook_str_replace_in_entry` |
| `LOREBOOK_WRITE_TOOL_DEFS` | 工具定義 |
| `isLorebookWriteTool(name)` | 判定函式 |
| `runLorebookWriteTool(call, { context })` | 計算提案 `{ book_name, uid, kind, before, after, ... }`，不寫入；`before` 與 `after` 為完整條目 |

工作台以 `lorebookWrite` kind 與目標 `{ type: LOREBOOK_ENTRY_TARGET_TYPE, name: book_name, uid }` 將結果提交到 ProposalBus，由世界書條目目標寫入已批准的條目。

### `tools.characterPresetsReads`

| 成員 | 行為 |
| --- | --- |
| `CHARACTER_PRESET_READ_TOOL_NAMES` | `inspect_bound_preset` |
| `CHARACTER_PRESET_READ_TOOL_DEFS` | 工具定義 |
| `isCharacterPresetReadTool(name)` | 判定函式 |
| `runCharacterPresetReadTool(call, { context, avatar = '' })` | 列出或讀取角色卡內嵌的預設；`avatar` 預設為目前角色 |

### `tools.skillIterStudio`

| 成員 | 行為 |
| --- | --- |
| `SKILL_ITER_STUDIO_TOOL_NAMES`、`SKILL_ITER_STUDIO_TOOL_DEFS` | 技能盤點、撰寫、策略與遷移工具 |
| `isSkillIterStudioTool(name)` | 判定函式 |
| `runSkillIterStudioTool(call, mutationCtx = {})` | 解析為 `{ ok: true, result }`；修改工作 profile 時解析為 `{ ok: true, result, pendingEdit }`；撰寫提案時解析為 `{ ok: true, result, pendingSkillEdit }`；失敗時解析為 `{ ok: false, error }`。`mutationCtx.getWorkingProfile()` 回傳策略類與拼接類工具修改的 profile；`mutationCtx.defaultScope` 為呼叫省略 `scope` 時使用的技能作用域，未設定時使用全域作用域。 |
| `commitApprovedSkillProposal(op)` | 將已批准的撰寫操作 `{ name, args }` 重新套用到磁碟上的技能。失敗時拋出錯誤。校驗失敗拋出 `SkillProposalError`；`SKILL.md` 缺失，或技能在提案後於磁碟上發生變化導致伺服器拒絕寫入時，拋出 `reason` 為 `CONFLICT` 的 `SkillProposalError`。技能 API 的其他錯誤原樣拋出。 |
| `SkillProposalError` | 帶 `reason` 與 `hint` 的錯誤 |
| `applyFrontmatterPatch(content, patch)` | 回傳寫入補丁鍵後的 SKILL.md 內容；值為 `null` 時刪除該鍵 |
| `buildSkillVisibilityChange(beforeProfile, afterProfile, { kind, agentId, list })` | 描述策略修改如何改變某個模式或 agent 的可見與停用技能 |
| `ensureSkillRegistryTarget()` | 註冊 ProposalBus 目標 `skill-registry`，重複呼叫不重複註冊。目標位址為 `{ type: 'skill-registry', name, path, _op }`；批准時透過 `commitApprovedSkillProposal` 重新執行 `_op` 完成寫入。 |

### `tools.ctxAndDocsDiscovery`

只提供執行器，不附帶工具定義，工具名稱與 schema 由呼叫方決定。失敗時解析為 `{ ok: false, error }`。

| 成員 | 行為 |
| --- | --- |
| `listCtxKeys({ filter = '' } = {})` | 回傳頂層 context 鍵 `{ ok, count, keys: [{ key, type }] }` |
| `describeCtxPath({ path })` | 依點分路徑描述：函式給出類型、參數數目與預覽，物件給出鍵，純量給出值 |
| `listLukerDocs({ filter = '', includeTranslations = false, fetchImpl = null } = {})` | 回傳 `{ ok, count, totalCount, hiddenTranslations, files }`；預設隱藏譯文 |
| `readLukerDoc({ path, fetchImpl = null })` | 回傳 `docs/` 下單篇文件的 `{ ok, path, size, content }` |

## proposalBus

ProposalBus 保存工作台 AI 提出的修改，直至使用者批准、拒絕或回滾。項目儲存其改動的正向與逆向 JSON 補丁，讀寫經由目標處理器完成；寫入前，bus 核對改動涉及的路徑仍為預期值，不一致時項目進入 `conflict` 狀態。

### 工廠與 kind 描述符

| 成員 | 行為 |
| --- | --- |
| `createProposalBus({ i18n, onChange, onCommitted } = {})` | 掛載彈窗時建立專屬 bus。變更後呼叫 `onChange()`；正向寫入成功後呼叫 `onCommitted(entry)`。 |
| `profileEdit`、`lorebookWrite`、`skillAuthor`、`presetClone`、`customToolAuthor` | kind 描述符 `{ kind, targetType }`，取值見下表 |
| `createProfileEditHandler()`、`createLorebookWriteHandler()`、`createSkillAuthorHandler()`、`createPresetCloneHandler()`、`createCustomToolAuthorHandler()` | 回傳對應描述符 |

| 描述符 | `kind` | `targetType` | 回滾 |
| --- | --- | --- | --- |
| `profileEdit` | `profile-edit` | `profile` | 支援 |
| `lorebookWrite` | `lorebook-write` | `orch-lorebook` | 支援 |
| `skillAuthor` | `skill-author` | `skill-registry` | 不支援 |
| `presetClone` | `preset-clone` | `preset` | 不支援 |
| `customToolAuthor` | `custom-tool-author` | `orch-custom-tool` | 不支援 |

工作台透過 `bus.registerKind(kind, handler)` 註冊各 kind，重複註冊同一 kind 時拋出錯誤。處理器在描述符基礎上補充卡片渲染函式 `icon(entry)`、`label(entry)`、`target(entry)` 與 `renderDiffCard(entry, { escapeHtml, formatTime, i18n })`，供 `renderCardsForMessage` 呼叫。處理器帶 `inverseAvailable: false` 時，該 kind 已提交的項目不可逆：`rollback` 拒絕回滾，批次回滾方法略過這些項目。

### 目標

目標透過 Layer 1 模組 `/scripts/iteration-library/storage/target-registry.js` 註冊。

| 成員 | 行為 |
| --- | --- |
| `registerTarget(type, { read, write, describe })` | `read(target)` 回傳目前值，`write(target, next)` 寫入值，`describe(target)` 回傳顯示名稱。再次註冊同一類型時取代原處理器。 |
| `hasTarget(type)` | 判斷 `type` 是否已註冊處理器 |
| `resolveTarget(target)` | 回傳 `target.type` 對應的處理器；未註冊時拋出 `UnknownTargetError` |

Layer 1 模組 `/scripts/iteration-library/proposal-bus/targets/lorebook-entry.js` 提供 `lorebookWrite` kind 的目標：

| 成員 | 行為 |
| --- | --- |
| `LOREBOOK_ENTRY_TARGET_TYPE` | 世界書條目提案的目標類型 `'orch-lorebook'`；目標位址為 `{ type, name, uid }` |
| `ensureLorebookEntryTarget(context)` | 註冊世界書條目目標，重複呼叫不重複註冊，並綁定提供 `loadWorldInfo` 與 `saveWorldInfo` 的 `context`；再次呼叫時改為綁定新的 `context` |

### bus 方法

| 方法 | 行為 |
| --- | --- |
| `propose({ kind, target, before, after, sourceCallId, meta })` | 新增 `pending` 項目，解析為 `{ id, target }`。kind 或目標未知、`target.type` 與 kind 的 `targetType` 不一致時拋出錯誤。 |
| `approve(id)` | 寫入 `pending` 或 `conflict` 項目，解析為 `{ ok, status }`。成功時 `status` 為 `committed`；偵測到外部改動或寫入失敗時項目轉為 `conflict`，結果另帶 `reason`、`hint` 與 `error`。 |
| `reject(id)`、`reset(id)` | `pending` 或 `conflict` → `rejected`；`rejected` → `pending` |
| `rollback(id)` | 恢復 `committed` 項目寫入前的值並轉為 `rolledBack`。偵測到外部改動或寫入失敗時項目轉為 `conflict` 並派送 `bus:rollback-failed`；不可逆項目解析為 `{ ok: false, status, reason: 'not_reversible' }`。 |
| `forceDiscard(id)` | `conflict` → `rolledBack`，不寫入 |
| `exportRecord(id)` | 派送攜帶項目目標與逆向補丁的 `bus:export-record` |
| `approveAllPendingInTurn(message)`、`rejectAllPendingInTurn(message)`、`rollbackAllInTurn(message)` | 處理 `sourceCallId` 屬於 `message.toolCalls[].id` 的項目 |
| `rollbackAllInMessages(messages)` | 由新到舊回滾這些訊息中可逆的已提交項目，首次失敗即停止，解析為 `{ results, ok, failedAt }` |
| `countCommittedInMessages(messages)` | 這些訊息中可逆的已提交項目數 |
| `hasOutstanding()` | 判斷是否存在 `pending` 項目 |
| `listPending()` | 回傳待審項目 `[{ id, sourceCallId }]` |
| `listEntries()` | 依提案順序回傳全部項目的淺拷貝，包含 `id`、`kind`、`status`、`target`、`sourceCallId`、`meta`、`conflictError` 與時間戳 `createdAt`、`decidedAt`、`committedAt`、`rolledBackAt` |
| `discardEntries(ids)` | 將匹配的 `pending` 或 `conflict` 項目標記為 `rejected` 而不呼叫 `onChange`，移除匹配的待讀取結果，並回傳 `{ rejected, prunedOutcomes }` |
| `getCurrentPendingState(kind, target)` | 回傳疊加該 kind 待審提案後的 `target` 目前值；提案無法疊加時派送 `bus:chain-broken` |
| `drainOutcomes()` | 回傳並清空自上次讀取以來的處理結果 |
| `serialize()`、`hydrate(data)` | 會話持久化；序列化結果帶 `version: 3`。經 `hydrate` 恢復的待審項目可直接批准。 |
| `setAutoApprove(enabled)`、`isAutoApprove()` | 新提案加入後立即批准 |
| `renderCardsForMessage(messageOrCallId)` | 回傳訊息或工具呼叫 id 對應的提案卡片 HTML |
| `renderTurnActions(messageOrCallId)` | 回傳批次批准、拒絕與回滾按鈕的 HTML |
| `handleClick(event)`、`setMessageResolver(fn)` | 分派 `[data-proposal-action]` 上的點擊，其他點擊令 `handleClick` 解析為 `false`；`fn(messageId)` 回傳批次操作所針對的訊息 |
| `events` | 派送 `bus:chain-broken`、`bus:rollback-failed` 與 `bus:export-record` 的 `EventTarget` |

## 工作區輔助函式

| 成員 | 行為 |
| --- | --- |
| `bindIterWorkspaceResizer(workspaceRoot)` | 允許拖曳 `workspaceRoot` 內的 `.luker-iter-workspace-resizer` 調整 `.luker-iter-workspace-grid` 的分欄，分欄比例不儲存。回傳解除綁定函式。 |
| `createRenderScheduler({ handler, frameRequester, onError })` | 僅 Layer 1 提供。回傳 `{ schedule, flush, dispose }`：連續的 `schedule()` 合併為下一動畫影格內的 `handler()` 呼叫，`flush()` 立即執行已排定的呼叫，`dispose()` 取消待執行的工作。`onError(err)` 接收 `handler` 拋出的錯誤。 |

## 參考消費方

- **工作台迭代目標** —— `public/scripts/workbench/targets/`、`orchestrator/lens/iterate-target.js` 與 `memory-graph/lens/iterate-targets.js` 重用 `proposalBus`、`tools` 與 `runner` 輔助能力，同時由工作台統一託管視窗、目標切換和改動記錄。
- **CardApp Studio** —— `public/scripts/extensions/character-editor-assistant/studio/` 自行管理獨立全螢幕開發環境，並呼叫 `iterationLibrary` 處理工具重試、世界書與檢索工具、差異渲染及 `edits-lib` 套用與復原。

## 相關頁面

- [工作台 API](/zh-TW/development/extension-api/workbench) —— 向工作台註冊 AI 迭代目標
- [Edits 函式庫](/zh-TW/development/extension-api/edits-lib) —— 基於 op 的修補引擎與衝突解決
