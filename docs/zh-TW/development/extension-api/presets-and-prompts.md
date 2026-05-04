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

如果不需要角色卡和世界書，可以跳過步驟 1-2，直接傳 messages 給 `sendOpenAIRequest`。`sendOpenAIRequest` 詳見 [生成請求](/zh-TW/development/extension-api/generation)。
