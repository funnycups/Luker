# 預設與提示詞

預設管理 API，以及把訊息組裝成帶角色卡和世界書的提示詞的相關 API。

## 預設 API

`context.presets` 提供了統一的預設管理介面，替代直接匯入 `PresetManager` 內部模組。

### presets.list

```ts
presets.list(collection?: string): Array<PresetRef>
```

列出指定集合的所有已儲存預設。`collection` 為預設集合名（如 `'openai'`）。

### presets.getSelected

```ts
presets.getSelected(collection?: string): PresetRef | null
```

取得當前選中的預設參照。如果當前選中的是角色卡綁定的執行時預設，回傳 `null`。

### presets.getLive

```ts
presets.getLive(collection?: string): PresetBody | null
```

取得當前 UI 中正在編輯的預設內容（包括未儲存的修改）。適合需要讀取當前實際生效設定的場景。

### presets.getStored

```ts
presets.getStored(ref: { collection: string, name: string }): PresetBody | null
```

取得指定預設的已儲存內容。適合跨預設比較或複製內容。

### presets.save

```ts
presets.save(
  ref: { collection: string, name: string },
  body: PresetBody
): Promise<void>
```

儲存預設內容。

### presets.resolve

```ts
presets.resolve(
  target?: PresetRef | string,
  options?: { collection?: string, defaultCollection?: string, allowMissingName?: boolean }
): { collection: string, name: string } | null
```

把一個預設引用規範化成 `{ collection, name }`。這是純粹的名稱解析輔助函式，**不會**回傳連線資訊。可傳入 `PresetRef`、表示集合名稱的字串（解析成該集合當前選中的預設）、或 `null`（依 `options.collection` 解析當前選中的預設）。無法確定 collection 或 name 時回傳 `null`。

::: tip 想找連線設定解析？
這個函式**不會**回傳 API 端點、模型或金鑰資訊。要把 connection manager 的 profile 解析成 `sendOpenAIRequest` 能吃的連線設定，請用 [`context.connectionProfiles.resolve`](/zh-TW/development/extension-api/generation#連線設定connection-profile解析)。
:::

### presets.state

綁定到預設的外掛執行時/會話資料。State sidecar 與預設檔案並排存放，**不會隨預設一起匯出**，僅供外掛側執行時使用（例如編排器的「按預設記憶 agent 覆寫」、預設助手的「上次使用的範本」）。不要把外掛資料塞進預設 body，用 `presets.state.*`。

所有方法都接受 `options.target`（`PresetRef`）和 `options.collection` 做跨預設讀寫；兩者預設指向當前選中的預設。

::: warning 行為變更（2026-06-28）
預設狀態的讀寫 API（`get`、`getBatch`、`update`、`patch`、`delete`、`deleteAll`）在 HTTP 失敗時不再拋出例外，改為回傳 `{ok, ...}` envelope（與聊天狀態一致）。如果你的外掛原本寫了 `try { await ctx.presets.state.get(...) } catch (e) { ... }`，請改用 `if (!result.ok) { ... }`。
:::

#### presets.state.get

```ts
presets.state.get(
  namespace: string,
  options?: { target?: PresetRef, collection?: string }
): Promise<
  | { ok: true, state: object | null }
  | { ok: false, state: null, reason: string, hint: string }
>
```

讀取指定命名空間下的預設狀態。成功時回傳 `{ok: true, state}`，其中 `state` 是儲存的值，命名空間無資料時為 `null`。失敗時回傳 `{ok: false, state: null, reason, hint}` —— 見下方[錯誤原因](#錯誤原因)。

#### presets.state.getBatch

```ts
presets.state.getBatch(
  namespaces: string[],
  options?: { target?: PresetRef, collection?: string }
): Promise<
  | { ok: true, results: Map<string, { ok: true, state: object | null }> }
  | { ok: false, results: Map<string, never>, reason: string, hint: string }
>
```

單次請求批次讀取多個命名空間。成功時回傳 `{ok: true, results}`，其中 `results` 是以命名空間為鍵的 `Map`；每個條目本身為 `{ok: true, state}`，不存在的命名空間對應 `{ok: true, state: null}`。失敗時（無作用預設、傳輸錯誤、HTTP 錯誤）回傳 `{ok: false, results: <空 Map>, reason, hint}`。

#### presets.state.update

```ts
presets.state.update(
  namespace: string,
  updater: (current: any) => any,
  options?: { target?: PresetRef, collection?: string, maxOperations?: number, maxRetries?: number }
): Promise<
  | { ok: true, state: object | null, updated: boolean }
  | { ok: false, reason: string, hint: string }
>
```

**推薦的讀—改—寫介面。** `updater` 取得目前狀態（不存在時為 `{}`），回傳下一份狀態。系統底層自動計算最小增量 patch，只有變化的那部分上網。回傳 `null` / `undefined` 視為「無變更」，結果為 `{ok: true, updated: false}`。409 衝突（並行改動）會自動重試；重試預算由 `options.maxRetries` 控制（預設 1）。失敗時回傳 `{ok: false, reason, hint}` —— 見下方[錯誤原因](#錯誤原因)。該函式永不拋出；reducer 內部拋出的例外會被捕獲並以 `reason: 'VALIDATION_ARGS'` 形式回報。

```js
await context.presets.state.update('my-plugin', (current = {}) => ({
  ...current,
  lastUsedTemplate: 'compact',
  updatedAt: Date.now(),
}));
```

#### presets.state.patch

```ts
presets.state.patch(
  namespace: string,
  operations: object[],
  options?: { target?: PresetRef, collection?: string }
): Promise<
  | { ok: true }
  | { ok: false, reason: string, hint: string }
>
```

直接施加 RFC 6902 patch 操作。典型的讀—改—寫流程優先用 `update()`；只有當你已有操作列表（例如重放此前計算好的 diff）時才用 `patch()`。成功時回傳 `{ok: true}`；失敗時回傳 `{ok: false, reason, hint}` —— 見下方[錯誤原因](#錯誤原因)。

#### presets.state.delete

```ts
presets.state.delete(
  namespace: string,
  options?: { target?: PresetRef, collection?: string }
): Promise<
  | { ok: true }
  | { ok: false, reason: string, hint: string }
>
```

刪除指定命名空間的預設狀態。冪等 —— sidecar 不存在時也會成功回傳。成功時回傳 `{ok: true}`；失敗時回傳 `{ok: false, reason, hint}` —— 見下方[錯誤原因](#錯誤原因)。

#### presets.state.deleteAll

```ts
presets.state.deleteAll(target?: PresetRef | string | null): Promise<
  | { ok: true }
  | { ok: false, reason: string, hint: string }
>
```

清空指定預設下的所有命名空間。慎用 —— 通常只在預設本身被刪除或重設時呼叫。成功時回傳 `{ok: true}`；失敗時回傳 `{ok: false, reason, hint}` —— 見下方[錯誤原因](#錯誤原因)。

#### 最佳實踐

- 優先用 `presets.state.update()`，不要手動串 `get()` + 整份覆寫 —— helper 只發 diff，並替你處理 409 重試。
- 負載保持為可 JSON 序列化的普通物件；頂層陣列或基本型別不支援。
- 一個命名空間裝一片邏輯狀態，不要把無關資料塞同一個命名空間。
- 處理 `ok: false` 回傳值，保持外掛 UI 的彈性 —— 依 `reason` 分支處理，不要翻譯 `hint`（見[錯誤原因](#錯誤原因)）。

#### 錯誤原因

預設狀態的讀寫方法（`get`、`getBatch`、`update`、`patch`、`delete`、`deleteAll`）失敗時會回傳 `{ok: false, reason, hint}`。`reason` 欄位沿用與[聊天狀態](/zh-TW/development/extension-api/chat-and-state#錯誤原因)相同的詞彙表：

| Reason | 觸發時機 | 建議處理 |
|---|---|---|
| `VALIDATION_ARGS` | 參數錯誤（命名空間為空、updater 非函式、operations 非陣列、reducer 拋錯） | 修正呼叫端 —— 這是程式碼 bug |
| `VALIDATION_TARGET` | 無作用預設（apiId/name 解析失敗） | 跳過寫入，等使用者選定預設後再試 |
| `VALIDATION_COMMIT` | 僅樓層狀態（不適用於預設狀態） | —— |
| `INSTANCE_DESTROYED` | 僅樓層狀態（不適用於預設狀態） | —— |
| `CONFLICT` | 重試後仍是 HTTP 409 | 重新讀取當前狀態後再試 |
| `HTTP_ERROR` | 其他非 2xx 回應 | 檢查 `hint` 中的狀態碼，可向使用者彈 toast |
| `TRANSPORT_ERROR` | fetch 拋錯（網路、CORS、abort） | 重試或向使用者顯示網路錯誤 |
| `REPLAY_BROKEN` | 僅樓層狀態（不適用於預設狀態） | —— |
| `LOG_WRITE_FAILED` | 僅樓層狀態（不適用於預設狀態） | —— |

`hint` 欄位是英文、不超過 120 字元的可操作診斷資訊。它不會被在地化 —— 面向使用者的在地化文案請依 `reason` 切換，而不是翻譯 `hint`。

### 使用規則

- `list()` 和 `getSelected()` 只回傳已儲存的預設
- 編輯中的預設用 `getLive()`
- 角色卡綁定的執行時預設不算「已儲存」，`getSelected()` 回傳 `null`，但 `getLive()` 仍可讀取
- 不要將外掛執行時資料塞進預設 body，使用 `presets.state.*`

## 提示詞與世界書組裝

### buildPresetAwarePromptMessages

```ts
buildPresetAwarePromptMessages(options: {
  messages: Array<{ role: string, content: string }>,
  envelopeOptions?: {
    includeCharacterCard?: boolean,
    api?: string,
    promptPresetName?: string,
  },
  promptPresetName?: string,
  runtimeWorldInfo?: object,
}): PromptMessage[]
```

基於當前預設設定，將外掛的訊息按照 prompt 預設的排列順序組裝為可發送給 API 的提示詞訊息列表。這是一個**可選的**組裝工具——簡單的 LLM 呼叫不需要它，只有當你需要複用角色卡、世界書或 prompt 範本時才需要使用。

**參數說明：**

| 參數 | 說明 |
|------|------|
| `messages` | 要發送的訊息陣列，每條訊息包含 `role`（`'system'`/`'user'`/`'assistant'`）和 `content` |
| `envelopeOptions.includeCharacterCard` | 是否在提示詞中包含當前角色卡的設定（預設 `true`） |
| `envelopeOptions.api` | 指定使用的 API 類型（如 `'openai'`），不指定則使用當前連線 |
| `envelopeOptions.promptPresetName` | 指定使用的預設名稱，不指定則使用當前預設 |
| `promptPresetName` | 與 `envelopeOptions.promptPresetName` 相同，頂層快捷方式 |
| `runtimeWorldInfo` | 預先解析好的世界書啟動結果（透過 `resolveWorldInfoForMessages` 取得） |

**關鍵行為：**

- 保留活躍預設中聊天歷史以外的內容（系統提示、角色描述等）
- 僅替換聊天歷史部分為你提供的 `messages`
- 如果提供了 `runtimeWorldInfo`，世界書條目會被注入到對應位置
- 如果指定了 `promptPresetName`，會使用該預設的提示詞範本而非當前預設

**實際使用範例**（參考記憶圖外掛的召回流程）：

```js
// 1. 先解析世界書啟動結果
const runtimeWorldInfo = await context.resolveWorldInfoForMessages(
  resolverMessages,
  {
    type: 'quiet',
    fallbackToCurrentChat: false,
    postActivationHook: rewriteDepthWorldInfoToAfter, // 重寫指令：將 depth 類型的世界書條目移到 after 位置
  }
);

// 2. 組裝提示詞
const promptMessages = context.buildPresetAwarePromptMessages({
  messages: [
    { role: 'system', content: '你是一個記憶分析助手...' },
    { role: 'user', content: '請分析以下對話中的關鍵資訊...' },
  ],
  envelopeOptions: {
    includeCharacterCard: true,
    api: envelopeApi,
    promptPresetName: selectedPromptPresetName,
  },
  promptPresetName: selectedPromptPresetName,
  runtimeWorldInfo: runtimeWorldInfo,
});

// 3. 發送給 LLM
import { sendOpenAIRequest } from '../../../openai.js';
const response = await sendOpenAIRequest('quiet', promptMessages, signal, {
 requestScope: 'extension_internal',
});
```

::: tip 關於後處理鉤子（postActivationHook）
`resolveWorldInfoForMessages` 的 `postActivationHook` 參數允許你在世界書啟動後、注入前對條目進行任意修改——包括修改內容、調整注入位置和深度、甚至增刪條目。hook 接收歸一化後的完整世界書 payload 並回傳修改後的版本。例如記憶圖外掛利用此鉤子將 depth 類型的世界書條目重寫到 after 位置，避免插入到聊天深度中干擾外掛自己的指令。
:::

### resolveWorldInfoForMessages

```ts
resolveWorldInfoForMessages(
  messages: Array<{ role: string, content: string }>,
  options?: {
    type?: string,
    fallbackToCurrentChat?: boolean,
    postActivationHook?: (entries: object) => object,
  }
): Promise<object>
```

對指定訊息執行世界書啟動掃描，回傳啟動結果。這相當於對自訂訊息進行一次世界書「重掃」。

**參數說明：**

| 參數 | 說明 |
|------|------|
| `messages` | 用於觸發世界書關鍵詞匹配的訊息列表 |
| `options.type` | 啟動類型（如 `'quiet'` 表示靜默掃描，不影響主對話） |
| `options.fallbackToCurrentChat` | 如果 messages 為空，是否回退到當前聊天訊息 |
| `options.postActivationHook` | 啟動後的鉤子函數，接收完整的世界書 payload，可以修改條目的內容、位置、深度，或增刪條目 |

回傳的物件包含 `worldInfoBeforeEntries`、`worldInfoAfterEntries`、`worldInfoDepth` 等欄位，可以直接傳給 `buildPresetAwarePromptMessages` 的 `runtimeWorldInfo` 參數。

::: tip 世界書重掃
`resolveWorldInfoForMessages` 本質上就是對自訂訊息進行世界書重掃。外掛可以用它來：
- 為獨立的 LLM 呼叫取得相關的世界書條目
- 測試特定訊息會觸發哪些世界書條目
- 在不影響主對話的情況下進行世界書啟動模擬
:::

### 推薦的獨立 LLM 呼叫模式

當外掛需要進行獨立的 LLM 呼叫（如彈窗中的 AI 輔助功能）時，推薦以下模式：

```js
import { sendOpenAIRequest } from '../../../openai.js';
const context = Luker.getContext();

// 1. 解析世界書啟動結果
const wi = await context.resolveWorldInfoForMessages(myCustomMessages, {
 type: 'quiet',
 fallbackToCurrentChat: false,
});

// 2. 組裝提示詞（注入角色卡、世界書、按 prompt_order 排列）
const requestMessages = context.buildPresetAwarePromptMessages({
 messages: myCustomMessages,
 runtimeWorldInfo: wi,
});

// 3. 發送請求
const result = await sendOpenAIRequest('quiet', requestMessages, signal, {
 requestScope: 'extension_internal',
});
```

如果不需要角色卡和世界書，可以跳過步驟 1-2，直接傳 messages 給 `sendOpenAIRequest`。`sendOpenAIRequest` 詳見 [生成請求](/zh-TW/development/extension-api/generation)。

## 提示詞信封檢視

對於診斷型 UI 和「預覽即將發送內容」工具，外掛可以讀取已組裝的 prompt 信封與排版，而不發起請求。

### getActivePromptPresetEnvelope

```ts
getActivePromptPresetEnvelope(options?: {
    includeCharacterCard?: boolean,
    api?: string,
    promptPresetName?: string,
    completionPresetName?: string,
    contextPresetName?: string,
    instructPresetName?: string,
    syspromptPresetName?: string,
    reasoningPresetName?: string,
}): PromptPresetEnvelope
```

回傳已解析 prompt 設定的快照，包含：

- `mainApi` / `completionApi` —— 活躍的 API 識別碼
- `presetRefs` —— 已解析的 completion / context / instruct / sysprompt / reasoning 預設名稱
- `promptCore` —— 每個預設中提取出的 prompt 相關欄位
- `promptLayout` —— 合併後的 Luker 排版（來自 `extensions.luker.prompt_layout`）
- `promptCatalog` —— `prompt.identifier` → `{ name, role, content, marker, systemPrompt }` 的映射
- `characterCard` —— 當前角色欄位（當 `includeCharacterCard !== false` 時）

這就是 `buildPresetAwarePromptMessages` 內部使用的同一份資料。在發送前向使用者展示「外掛的請求會長什麼樣」時很有用。

### getActivePromptLayout

```ts
getActivePromptLayout(options?: object): PromptLayoutEntry[]
```

便利存取器，僅回傳合併後的 prompt 排版。每個條目包含 `id`、`enabled`、`order`、`role`、`phase`、`source`、`content`、`path`、`promptIdentifier`、`tags`。

### formatPromptPresetEnvelope

```ts
formatPromptPresetEnvelope(envelope?: object, options?: { label?: string }): string
```

把信封格式化成 `[[LABEL]]\n<json>` 形式以嵌入到另一個 prompt 中（例如委派給需要對使用者 prompt 設定進行推理的 meta-LLM）。未提供時預設取當前信封。

```js
const ctx = Luker.getContext();
const envelope = ctx.getActivePromptPresetEnvelope({ includeCharacterCard: true });
const serialized = ctx.formatPromptPresetEnvelope(envelope);
console.log(serialized);
```

## 推理

推理輔助函式用於解析和渲染推理模型（Claude reasoning、DeepSeek-R1、o1 等）發出的 `<thinking>...</thinking>` 風格區塊。

### parseReasoningFromString

```ts
parseReasoningFromString(
    text: string,
    options?: { strict?: boolean },
    template?: ReasoningTemplate | null,
): { reasoning: string, content: string } | null
```

依照推理範本（或當前活躍的 `power_user.reasoning` 範本）的 `prefix` 與 `suffix`，把模型輸出字串切成 `reasoning` 與 `content`。範本缺 prefix / suffix 或解析失敗時回傳 `null`。

| 選項 | 說明 |
|------|------|
| `strict` | 為 `true`（預設）時，prefix 必須出現在開頭（在空白之後）。為 `false` 時，會在任何位置查找 |

### getReasoningTemplateByName

```ts
getReasoningTemplateByName(name: string): ReasoningTemplate
```

按名稱查找推理範本。找不到時擲出 `Error('Unknown reasoning template name: "<name>"')`。回傳的範本應視為唯讀。

### updateReasoningUI

```ts
updateReasoningUI(
    messageIdOrElement: number | HTMLElement | JQuery,
    options?: { reset?: boolean },
): void
```

觸發某條訊息推理區塊的 UI 重新整理。可傳聊天索引、原始 DOM 元素或 JQuery 包裝物件。`reset: true` 會跳過讀取訊息當前的推理狀態——在 swipe 期間新推理還沒寫入時用得到。

```js
const ctx = Luker.getContext();
const parsed = ctx.parseReasoningFromString(modelOutput);
if (parsed) {
    console.log('Reasoning:', parsed.reasoning);
    console.log('Final answer:', parsed.content);
}
```

## 設定視圖（唯讀）

下面這些屬性暴露實時設定物件。它們是可變的參照——只能透過正規 API（`presets.save`、`saveSettingsDebounced` 等）寫入。直接突變可能無法正確持久化。

### chatCompletionSettings

```ts
context.chatCompletionSettings: object
```

`oai_settings` 的參照。唯讀視圖，用於檢視當前活躍的 chat completion source、模型與參數。

### textCompletionSettings

```ts
context.textCompletionSettings: object
```

`textgenerationwebui_settings` 的參照。當前 text completion 後端的唯讀視圖。

### powerUserSettings

```ts
context.powerUserSettings: object
```

`power_user` 的參照。持有 tokenizer 選擇、推理範本選擇、訊息顯示偏好和其他使用者級設定。

::: warning 透過 API 寫入而非直接突變
這些視圖僅為檢視而暴露。直接寫入它們可能繞過防抖儲存邏輯。要更改連線或模型，請使用面向使用者的 UI 或 [`presets.save`](#presets-save)。要更改生成參數，請使用 chat completion 預設。
:::

## 連線相關輔助

### context.openai

```ts
context.openai: {
    proxies: Array<{ name: string, url: string, ... }>,
    ZAI_ENDPOINT: Record<string, string>,
    stripPresetConnectionFields(preset: object): object,
}
```

處理 chat completion 連線狀態的輔助集合。`proxies` 是使用者設定的反向代理實時清單;`ZAI_ENDPOINT` 列出已知的智譜 / Z.AI 端點 URL;`stripPresetConnectionFields` 回傳去掉連線相關欄位（API source、模型、proxy 等）的預設複本——匯出「不同使用者環境也能用」的預設時使用。

```js
const ctx = Luker.getContext();
const portable = ctx.openai.stripPresetConnectionFields(preset);
const json = JSON.stringify(portable, null, 2);
```

### context.textCompletion

```ts
context.textCompletion: {
    types: Record<string, string>,
}
```

`textCompletion.types` 列舉支援的 text-completion 後端識別碼（`OOBA`、`MANCER`、`APHRODITE`、`KOBOLDCPP`……）。在按當前 text-completion provider 分支行為時使用。
