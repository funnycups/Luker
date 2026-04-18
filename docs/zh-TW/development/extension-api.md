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

## 与 SillyTavern 的 API 差異

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
| 函數呼叫 | 無共享執行時 | `requestToolCallsWithRetry()` 共享執行時 |
| 連線設定 | 全域單一 | `context.presets.resolve()` 支援按預設解析連線設定 |

> [!IMPORTANT]
> 優先使用 `Luker.getContext()` 提供的 API，而非直接呼叫底層 HTTP 端點。Context API 封裝了 patch-first 語義、衝突處理和重試邏輯，直接呼叫端點需要自行處理這些細節。

## 聊天資料（只读）

以下屬性提供當前聊天的只读存取：

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

> **模組來源**：`scripts/messages.js` → `getContext()`

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

列出指定集合的所有已儲存預設。`collection` 为預設集合名（如 `'openai'`）。

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

基於當前預設設定，將聊天訊息組裝為可發送給 API 的提示詞訊息列表。這是外掛進行獨立 LLM 呼叫時最核心的 API。

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
const response = await context.generateQuietPrompt(promptMessages);
```

::: tip 關於重寫指令（postActivationHook）
`resolveWorldInfoForMessages` 的 `postActivationHook` 參數允許你在世界書啟動後、注入前修改條目的位置。這在外掛場景中很有用——例如記憶圖將 depth 類型的世界書條目重寫到 after 位置，避免插入到聊天深度中干擾外掛自己的指令。
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
| `options.postActivationHook` | 啟動後的鉤子函數，可以修改條目的注入位置 |

回傳的物件包含 `worldInfoBeforeEntries`、`worldInfoAfterEntries`、`worldInfoDepth` 等欄位，可以直接傳給 `buildPresetAwarePromptMessages` 的 `runtimeWorldInfo` 參數。

::: tip 世界書重掃
`resolveWorldInfoForMessages` 本質上就是對自訂訊息進行世界書重掃。外掛可以用它來：
- 為獨立的 LLM 呼叫取得相關的世界書條目
- 測試特定訊息會觸發哪些世界書條目
- 在不影響主對話的情況下進行世界書啟動模擬
:::

### 推薦的彈窗生成模式

當外掛需要進行獨立的 LLM 呼叫（如彈窗中的 AI 輔助功能）時，推薦以下模式：

```js
const context = Luker.getContext();

// 1. 解析世界書啟動結果
const wi = await context.resolveWorldInfoForMessages(myCustomMessages, {
  type: 'quiet',
  fallbackToCurrentChat: false,
});

// 2. 組裝提示詞
const requestMessages = context.buildPresetAwarePromptMessages({
  messages: myCustomMessages,
  runtimeWorldInfo: wi,
});

// 3. 發送請求（使用當前預設的連線設定）
const response = await fetch('/api/backends/chat-completions/generate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ messages: requestMessages }),
});
```

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

`Luker.searchTools` 暴露的是工具定義中繼資料，實際的搜尋執行透過 `requestToolCallsWithRetry()` 的工具呼叫迴圈完成。詳見[搜尋外掛](/zh-TW/features/search-tools)。

## 函數呼叫共享執行時

Luker 提供了共享的函數呼叫執行時，外掛可以複用它來實現工具呼叫迴圈：

```js
import { requestToolCallsWithRetry } from '../search-tools/main.js';

const result = await requestToolCallsWithRetry({
  messages: requestMessages,
  tools: myToolDefinitions,
  maxRounds: 3,
  // 連線設定（可選，預設使用當前預設）
  requestApi: profile.requestApi,
  requestModel: profile.requestModel,
  requestUrl: profile.requestUrl,
  secretId: profile.secretId,
});
```

> [!NOTE]
> `requestToolCallsWithRetry` 不在 `Luker.getContext()` 上，而是從 `search-tools/main.js` 模組匯出的函數。其他內建外掛（如 orchestrator、memory-graph）透過 ES Module import 使用它。

這個執行時處理了工具呼叫的完整迴圈：發送請求 → 解析工具呼叫 → 執行工具 → 將結果注入訊息 → 再次請求，直到模型不再呼叫工具或達到最大輪次。

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

```js
// 讀取角色級別的持久化狀態
const state = context.getCharacterState(namespace);

// 寫入角色級別的持久化狀態
await context.setCharacterState(namespace, newState);
```

角色狀態綁定到角色卡，在所有聊天之間共享。適合儲存角色級別的外掛設定（如 CardApp 的應用狀態）。

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
