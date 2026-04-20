# 擴充 API 參考

本文檔是 Luker 擴充功能 API 的完整參考，面向外掛開發者。所有 API 均透過 `Luker.getContext()` 暴露。

## 全局入口

```js
const context = Luker.getContext();
```

| 別名 | 說明 |
|------|------|
| `Luker.getContext()` | 推薦使用 |
| `SillyTavern.getContext()` | 相容別名 |
| `st.getContext()` | 相容別名 |

新外掛應統一使用 `Luker.getContext()`。相容別名僅為遷移期保留。

## 與 SillyTavern 的 API 差異

Luker 基於 SillyTavern 建構，但在 API 層面有以下主要差異：

| 領域 | SillyTavern | Luker |
|------|-------------|-------|
| 聊天持久化 | 整檔覆寫 | Patch-first（RFC 6902 增量更新） |
| 聊天綁定狀態 | 僅 `chat_metadata` | 新增聊天狀態機制 |
| 預設管理 | 直接匯入內部模組 | `context.presets.*` 統一 API |
| 提示詞組裝 | 需要手動拼接 | `buildPresetAwarePromptMessages()` |
| 世界書模擬 | 無 | `simulateWorldInfoActivation()` |
| 生成鉤子 | 基礎事件 | 新增 `GENERATION_CONTEXT_READY`、`GENERATION_BEFORE_WORLD_INFO_SCAN` 等細粒度鉤子 |
| 事件排序 | 註冊順序 | 支援 `priority`、`pluginOrder`、`makeFirst`/`makeLast` |
| 正則執行時 | 無外掛 API | `registerManagedRegexProvider()` |
| 搜尋工具 | 無外掛 API | `Luker.searchTools` 全域 API |
| 函數呼叫 | 基礎 `ToolManager` | 純文字模式支援 + 連線級獨立開關 + `sendOpenAIRequest` 預設覆寫 |
| 連線設定 | 全域單一 | `context.presets.resolve()` 支援按預設解析連線設定 |

> [!IMPORTANT]
> 優先使用 `Luker.getContext()` 提供的 API，而非直接呼叫底層 HTTP 端點。Context API 封裝了 patch-first 語義、衝突處理和重試邏輯，直接呼叫端點需要自行處理這些細節。

## 聊天資料（唯讀）

以下屬性提供當前聊天的唯讀存取：

| 屬性 | 類型 | 說明 |
|------|------|------|
| `context.chat` | `ChatMessage[]` | 當前聊天訊息陣列 |
| `context.characters` | `Character[]` | 角色列表 |
| `context.groups` | `Group[]` | 群組列表 |
| `context.name1` | `string` | 使用者名稱 |
| `context.name2` | `string` | 角色名 |
| `context.characterId` | `number` | 當前角色 ID |
| `context.groupId` | `string` | 當前群組 ID |
| `context.chat_metadata` | `object` | 當前聊天的中繼資料 |
| `context.online_status` | `string` | API 連線狀態 |

## 訊息 API

Luker 提供了統一的高層訊息操作 API。每個操作都是完整的一條龍流程：記憶體更新 + DOM 渲染 + 事件觸發 + 持久化。

### addMessages

```ts
addMessages(
 messages: ChatMessage | ChatMessage[],
 options?: { scroll?: boolean, silent?: boolean }
): Promise<number | number[]>
```

新增一條或多條訊息到聊天中。

- 自動 push 到 `chat[]`、渲染 DOM、觸發 `MESSAGE_SENT`/`MESSAGE_RECEIVED` 和 `MESSAGE_RENDERED` 事件、持久化到後端
- 傳入陣列時批次操作，只觸發一次持久化
- 回傳新訊息的索引（單條回傳 `number`，批次回傳 `number[]`）

```js
// 新增單條訊息
const index = await context.addMessages({
 name: 'System',
 mes: '這是一條系統訊息',
 is_system: true,
});

// 批次新增
const indices = await context.addMessages([
 { name: 'User', mes: '你好', is_user: true },
 { name: 'Assistant', mes: '你好！有什麼可以幫你的？', is_user: false },
]);
```

### updateMessages

```ts
updateMessages(
 updates: { index: number, patch: object } | { index: number, patch: object }[],
 options?: { rerender?: boolean, silent?: boolean }
): Promise<void>
```

更新一條或多條訊息的內容並持久化。

- `patch` 物件的欄位會合併到 `chat[index]` 中
- 自動重新渲染 DOM、觸發 `MESSAGE_EDITED` 和 `MESSAGE_UPDATED` 事件、透過 RFC 6902 增量持久化
- 批次操作時合併為一次持久化呼叫

```js
// 更新單條訊息
await context.updateMessages({
 index: 4,
 patch: { mes: '修改後的內容' },
});

// 批次更新
await context.updateMessages([
 { index: 3, patch: { mes: '新內容 A' } },
 { index: 5, patch: { mes: '新內容 B', extra: { model: 'gpt-4o' } } },
]);
```

### deleteMessages

```ts
deleteMessages(
 index: number | number[],
 options?: { swipe?: number, silent?: boolean }
): Promise<ChatMessage | ChatMessage[]>
```

刪除一條或多條訊息。

- 自動從 `chat[]` 移除、清理 DOM、觸發 `MESSAGE_DELETED` 事件、透過 RFC 6902 增量持久化
- 批次刪除時自動處理索引偏移
- 指定 `swipe` 選項時，只刪除該訊息的特定 swipe 而非整條訊息
- 回傳被刪除的訊息物件

```js
// 刪除單條訊息
const deleted = await context.deleteMessages(5);

// 批次刪除
const deletedList = await context.deleteMessages([3, 5, 7]);

// 只刪除特定 swipe
await context.deleteMessages(5, { swipe: 2 });
```

### getMessage

```ts
getMessage(index: number): Readonly<ChatMessage> | null
```

取得指定索引的訊息（唯讀）。回傳一個 Proxy 物件，嘗試修改屬性會拋出錯誤並引導使用 `updateMessages()`。

### getMessageCount

```ts
getMessageCount(): number
```

回傳當前聊天的訊息總數。

---

::: warning 已棄用的底層 API
以下函式仍然可用但已標記為 deprecated，外掛開發者應使用上述統一 API：

- `addOneMessage()` → 使用 `addMessages()`
- `deleteLastMessage()` → 使用 `deleteMessages(chat.length - 1)`
- `deleteMessage()` → 使用 `deleteMessages()`
- `updateMessageBlock()` → 使用 `updateMessages()`
- `patchChatMessages()` → 底層 RFC 6902 傳輸層，使用 `updateMessages()` / `deleteMessages()`
- `appendChatMessages()` → 底層追加傳輸層，使用 `addMessages()`
:::

## 聊天持久化

### saveChatMetadata

```ts
saveChatMetadata(withMetadata?: object): Promise<boolean>
```

儲存聊天中繼資料。如果傳入 `withMetadata`，會先合併到 `chat_metadata` 再儲存。

## 聊天狀態

聊天狀態是 Luker 新增的聊天綁定狀態機制，讓外掛可以將結構化資料綁定到特定聊天，而不是塞進 `chat_metadata`。

### getChatState

```ts
getChatState(
  namespace: string,
  options?: { target?: ChatTarget }
): Promise<any | null>
```

讀取指定命名空間的聊天狀態。回傳 `null` 表示該命名空間無資料。

- `namespace`：外掛的唯一識別碼，建議使用外掛名
- `target`：可選，指定目標聊天（用於跨聊天讀取，如分支場景）

### getChatStateBatch

```ts
getChatStateBatch(
  namespaces: string[],
  options?: { target?: ChatTarget }
): Promise<Record<string, any>>
```

批次讀取多個命名空間的聊天狀態。回傳一個以命名空間為鍵的物件。

### updateChatState

```ts
updateChatState(
  namespace: string,
  updater: (current: any) => any,
  options?: { target?: ChatTarget }
): Promise<{ ok: boolean }>
```

**推薦的讀-改-寫方式。** `updater` 函數接收當前狀態，回傳新狀態。系統會自動處理並行衝突。

```js
await context.updateChatState('my-plugin', (current = {}) => ({
  ...current,
  counter: (current.counter || 0) + 1,
  lastUpdated: Date.now(),
}));
```

### deleteChatState

```ts
deleteChatState(
  namespace: string,
  options?: { target?: ChatTarget }
): Promise<{ ok: boolean }>
```

刪除指定命名空間的聊天狀態。

### 最佳實踐

- 使用 `updateChatState()` 進行讀-改-寫，而非手動鏈式呼叫 `getChatState()` + `patchChatState()`
- 保持 payload 為可 JSON 序列化的純物件
- 處理 `ok: false` 回傳值，保持外掛 UI 的彈性
- 對於大型外掛資料，優先使用聊天狀態而非 `chat_metadata`

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
  target?: PresetRef,
  options?: object
): ConnectionProfile
```

解析預設對應的連線設定（API 端點、模型、金鑰等）。這是外掛進行獨立 API 呼叫時取得連線資訊的推薦方式。

回傳的 `ConnectionProfile` 包含：

| 欄位 | 說明 |
|------|------|
| `requestApi` | 規範化的 API 類型（如 `'openai'`） |
| `requestModel` | 模型名稱 |
| `requestUrl` | API 端點 URL |
| `secretId` | 金鑰識別碼 |

### presets.state

```ts
presets.state.update(
  namespace: string,
  updater: (current: any) => any,
  options?: { target: PresetRef }
): Promise<void>
```

管理綁定到預設的外掛執行時/會話資料。這些資料不會隨預設匯出，僅用於外掛的執行時狀態。

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

如果不需要角色卡和世界書，可以跳過步驟 1-2，直接傳 messages 給 `sendOpenAIRequest`。

## 正则執行時 API

外掛可以透過 `registerManagedRegexProvider()` 註冊託管的正則處理器，參與 Luker 的正則處理流程。該函數從正則引擎模組匯出：

```js
import { registerManagedRegexProvider } from '../../extensions/regex/engine.js';

const handle = registerManagedRegexProvider('my-plugin', {
  reloadOnChange: true,
});

// 添加正则脚本
handle.upsertScript({
  id: 'my-rule-1',
  scriptName: 'My Regex Rule',
  findRegex: 'foo',
  replaceString: 'bar',
  // ...其他正則腳本欄位
});

// 卸载时取消註冊
handle.unregister();
```

`registerManagedRegexProvider` 回傳的句柄提供 `upsertScript`、`removeScript`、`setScripts`、`clearScripts` 和 `unregister` 方法。

## 搜尋工具 API

搜尋外掛透過 `Luker.searchTools` 全域物件暴露 API，供其他外掛呼叫搜尋能力：

```js
// 檢查搜尋外掛是否可用
if (globalThis?.Luker?.searchTools) {
  // 取得可用的搜尋工具名稱列表
  const toolNames = Luker.searchTools.toolNames;
  // 取得工具定義（用於函數呼叫）
  const toolDefs = Luker.searchTools.getToolDefs();
  // 檢查某個工具名是否屬於搜尋工具
  const isSearchTool = Luker.searchTools.isToolName('web_search');
}
```

`Luker.searchTools` 暴露的是工具定義中繼資料，實際的搜尋執行透過內部的工具呼叫迴圈完成。詳見[搜尋外掛](/zh-TW/features/search-tools)。

## 發送 LLM 請求

外掛可以使用 `sendOpenAIRequest` 發送獨立的 LLM 請求，這是核心的生成函數。

### 基本用法

對於不需要角色卡或世界書的簡單 LLM 呼叫：

```js
import { sendOpenAIRequest } from '../../../openai.js';

const result = await sendOpenAIRequest('quiet', [
    { role: 'system', content: '你是一個翻譯助手。' },
    { role: 'user', content: '翻譯這段文字...' },
], signal, {
    requestScope: 'extension_internal',
});
```

第一個參數 `'quiet'` 表示這是一個背景請求，不會出現在聊天 UI 中。

### 預設覆寫

`sendOpenAIRequest` 接受覆寫參數來控制使用哪個模型、API 端點和生成設定：

```js
const result = await sendOpenAIRequest('quiet', messages, signal, {
    llmPresetName: 'my-low-temp',       // 覆寫生成參數（溫度、top_p 等）
    apiSettingsOverride: profileOverride, // 覆寫連線設定（模型、API URL 等）
    requestScope: 'extension_internal',
});
```

| 參數 | 用途 |
|------|------|
| `llmPresetName` | 載入 LLM 預設來覆寫**生成參數**（溫度、top_p、frequency_penalty、max_tokens 等）。不影響連線欄位。 |
| `apiPresetName` | 載入 API 預設來覆寫**連線欄位**（chat_completion_source、模型、API URL、reverse_proxy 等）。不影響生成參數。 |
| `apiSettingsOverride` | 直接用物件覆寫連線設定（通常來自連線管理員的設定解析）。 |
| `requestScope` | 設為 `'extension_internal'` 可跳過主聊天的 CHAT_COMPLETION 鉤子。 |

### 工具呼叫

在請求中包含工具定義：

```js
const result = await sendOpenAIRequest('quiet', messages, signal, {
    tools: [
        {
            type: 'function',
            function: {
                name: 'search_web',
                description: '搜尋網頁取得資訊',
                parameters: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', description: '搜尋關鍵字' },
                    },
                    required: ['query'],
                },
            },
        },
    ],
    toolChoice: 'auto',
    functionCallMode: 'native',  // 或 'prompt_xml' 使用純文字模式
    requestScope: 'extension_internal',
});
```

這些 `tools` 僅用於本次請求，與全域工具註冊表（見下方[工具註冊](#工具註冊)）是分開的。

### 配合 Prompt 組裝

對於需要融入角色卡、世界書或 prompt 範本的請求，先使用 `buildPresetAwarePromptMessages` 組裝訊息：

```js
const context = Luker.getContext();

// 第一步：解析世界書
const worldInfo = await context.resolveWorldInfoForMessages(rawMessages);

// 第二步：按 prompt 預設佈局組裝訊息
const messages = context.buildPresetAwarePromptMessages({
    messages: [
        { role: 'system', content: taskSystemPrompt },
        { role: 'user', content: taskUserPrompt },
    ],
    envelopeOptions: {
        includeCharacterCard: true,
        api: 'openai',
    },
    runtimeWorldInfo: worldInfo,
});

// 第三步：發送組裝好的訊息
const result = await sendOpenAIRequest('quiet', messages, signal, {
    llmPresetName,
    apiSettingsOverride,
    requestScope: 'extension_internal',
});
```

`buildPresetAwarePromptMessages` 按照當前 prompt 預設的 `prompt_order` 排列訊息，可選地注入角色卡和世界書條目。它控制**發送什麼**；`sendOpenAIRequest` 的預設參數控制**怎麼發送**（模型、溫度、連線）。

## 工具註冊

外掛可以透過 `getContext()` 將工具註冊到全域工具註冊表。註冊的工具會出現在主聊天的工具呼叫流程中——模型可以在正常對話中呼叫它們。

```js
const context = Luker.getContext();

context.registerFunctionTool({
    name: 'my_plugin_tool',
    displayName: 'My Tool',
    description: '執行某個有用的操作',
    parameters: {
        type: 'object',
        properties: {
            input: { type: 'string', description: '輸入文字' },
        },
        required: ['input'],
    },
    action: async (args) => {
        // 執行工具並回傳結果字串
        return `結果：${args.input}`;
    },
    formatMessage: (args) => {
        // 可選：格式化一條人類可讀的訊息顯示在聊天中
        return `使用了工具，輸入：${args.input}`;
    },
    shouldRegister: async () => {
        // 可選：回傳 false 可條件性地跳過註冊
        return true;
    },
    stealth: false, // 可選：為 true 時工具結果不會顯示在聊天中
});
```

移除已註冊的工具：

```js
context.unregisterFunctionTool('my_plugin_tool');
```

工具相關方法：

| 方法 | 說明 |
|------|------|
| `context.registerFunctionTool(tool)` | 將工具註冊到全域註冊表 |
| `context.unregisterFunctionTool(name)` | 從全域註冊表移除工具 |
| `context.isToolCallingSupported()` | 檢查當前 API/模型是否支援工具呼叫 |
| `context.canPerformToolCalls(type)` | 檢查指定請求類型是否可以執行工具呼叫 |

::: warning 全域工具 vs 單次請求工具
`registerFunctionTool` 將工具新增到**全域註冊表**——它們在主聊天中可供模型呼叫。`sendOpenAIRequest` 的 `tools` 參數僅為**該次請求**提供工具，不影響全域註冊表。
:::

## 連線設定解析

當外掛需要使用非當前預設的連線設定時，使用 `presets.resolve()`：

```js
const profile = context.presets.resolve(
  { collection: 'openai', name: 'My Preset' }
);

// profile 包含：
// - requestApi: 'openai'
// - requestModel: 'gpt-4o'
// - requestUrl: 'https://api.openai.com/v1'
// - secretId: '...'
```

`secret_id` 請求覆蓋：在 chat-completions 請求體中，可以透過 `secret_id` 欄位指定使用哪個金鑰，覆蓋全域選擇。這在多 Agent 場景中特別有用——不同的 Agent 可以使用不同的 API 金鑰。

## 角色狀態

角色狀態是綁定到角色卡本身的持久化儲存，在該角色的所有聊天之間共享。與聊天狀態（僅在單個聊天內有效）不同，角色狀態適合儲存跨聊天的角色級別設定。

### getCharacterState

```ts
getCharacterState(namespace: string): Promise<any | null>
```

讀取指定命名空間下的角色狀態資料。如果該命名空間沒有儲存過資料，回傳 `null`。

| 參數 | 說明 |
|------|------|
| `namespace` | 儲存命名空間，通常使用外掛名稱（如 `'my-extension'`） |

### setCharacterState

```ts
setCharacterState(namespace: string, data: any): Promise<void>
```

寫入指定命名空間下的角色狀態資料。傳入 `null` 作為 `data` 可以刪除該命名空間的狀態。

| 參數 | 說明 |
|------|------|
| `namespace` | 儲存命名空間 |
| `data` | 要儲存的資料（任意可序列化物件），傳 `null` 刪除 |

### 使用範例

```js
const context = Luker.getContext();

// 讀取角色狀態
const state = await context.getCharacterState('my-extension');
console.log(state); // { someConfig: true } 或 null

// 寫入角色狀態
await context.setCharacterState('my-extension', {
  someConfig: true,
  lastUpdated: Date.now(),
});

// 刪除角色狀態
await context.setCharacterState('my-extension', null);
```

### 角色狀態 vs 聊天狀態

| | 角色狀態 | 聊天狀態 |
|------|------|------|
| 作用範圍 | 綁定到角色卡，所有聊天共享 | 綁定到單個聊天 |
| 典型用途 | 角色級別的外掛設定、CardApp 應用狀態 | 聊天內的臨時資料、對話上下文 |
| API | `getCharacterState` / `setCharacterState` | `getChatState` / `getChatStateBatch` / `updateChatState` / `deleteChatState` |
| 儲存位置 | 角色卡 JSON 檔案 | 聊天中繼資料 |

## 擴充功能間通訊

### registerExtensionApi

```js
context.registerExtensionApi('my-plugin', {
  doSomething: () => { /* ... */ },
  getData: () => myData,
});
```

### 查詢其他外掛的 API

```js
const api = context.getExtensionApi('other-plugin');
if (api) {
  api.doSomething();
}
```

## 事件系統

### eventSource

```js
// 監聽
context.eventSource.on(eventName, handler, options?);

// 取消監聽
context.eventSource.off(eventName, handler);

// 確保最先執行
context.eventSource.makeFirst(eventName, handler);

// 確保最后執行
context.eventSource.makeLast(eventName, handler);

// 查看監聽器資訊（除錯用）
context.eventSource.getListenersMeta(eventName);

// 設定外掛排序
context.eventSource.setOrderConfig(config);
```

### 監聽器選項

```js
context.eventSource.on(eventName, handler, {
  priority: 10,  // 數字越大越先執行
});
```

### 事件類型

所有事件類型透過 `context.eventTypes` 存取。完整的事件列表和回呼參數請參閱[外掛開發基礎](/zh-TW/development/plugin-basics#事件系統)。

## 世界書讀寫

外掛可以透過 context API 讀寫世界書條目。

## 底層端點參考（進階 / 除錯用）

> [!WARNING]
> 以下端點僅供進階除錯和無法使用 `Luker.getContext()` 的整合場景參考。它們是同源 Web 應用路由，不是主要的外掛 API 契約。正常外掛開發應使用上述 Context API。

### 角色聊天

| 方法 | 路徑 | 說明 |
|------|------|------|
| POST | `/api/chats/save` | 儲存聊天（patch-first） |
| POST | `/api/chats/get` | 取得聊天列表 |
| POST | `/api/chats/delete` | 刪除聊天 |
| POST | `/api/chats/rename` | 重新命名聊天 |
| POST | `/api/chats/export` | 匯出聊天 |

### 群組聊天

| 方法 | 路徑 | 說明 |
|------|------|------|
| POST | `/api/chats/group/save` | 儲存群組聊天 |
| POST | `/api/chats/group/get` | 取得群組聊天列表 |
| POST | `/api/chats/group/delete` | 刪除群組聊天 |

### 聊天狀態

| 方法 | 路徑 | 說明 |
|------|------|------|
| POST | `/api/chats/state/get` | 批次讀取狀態 |
| POST | `/api/chats/state/patch` | 增量更新狀態 |
| POST | `/api/chats/state/delete` | 刪除狀態 |

### 設定

| 方法 | 路徑 | 說明 |
|------|------|------|
| POST | `/api/settings/save` | 儲存設定（patch-first） |
| POST | `/api/settings/get` | 取得設定 |

### 世界書

| 方法 | 路徑 | 說明 |
|------|------|------|
| POST | `/api/worldinfo/save` | 儲存世界書（patch-first） |
| POST | `/api/worldinfo/get` | 取得世界書 |

### 搜尋/存取

| 方法 | 路徑 | 說明 |
|------|------|------|
| POST | `/api/plugins/search/search` | 執行搜尋 |
| POST | `/api/plugins/search/visit` | 存取 URL 並提取內容 |

### Patch 操作格式

訊息 patch 使用 RFC 6902 JSON Patch 格式：

```json
[
  { "op": "replace", "path": "/4/mes", "value": "新內容" },
  { "op": "add", "path": "/4/extra/note", "value": "備註" },
  { "op": "remove", "path": "/4/extra/old_field" }
]
```

物件 patch（`meta/patch`、`state/patch`、`settings/patch`、`worldinfo/patch`）也使用相同的 RFC 6902 格式。

### Patch 衝突與完整性語義

- 伺服端會驗證 patch 操作的路徑是否存在
- `replace` 操作要求目標路徑已存在
- `add` 操作會建立不存在的路徑
- 衝突時回傳錯誤，用戶端應重試或回退到全量儲存

### Chat-Completions 請求體

```json
{
  "messages": [...],
  "model": "gpt-4o",
  "secret_id": "optional-override"
}
```

`secret_id` 欄位允許在請求級別覆蓋使用的 API 金鑰，適用於多 Agent 編排等需要不同金鑰的場景。

## 相關頁面

- [外掛開發基礎](/zh-TW/development/plugin-basics) — 外掛結構、事件系統、UI 整合
- [角色卡開發](/zh-TW/development/card-developers) — 角色卡擴充功能欄位和 CardApp
- [增量同步](/zh-TW/improvements/incremental-sync) — 增量儲存的技術細節
- [預設解耦](/zh-TW/improvements/preset-decoupling) — 預設與 API 選擇的解耦機制
