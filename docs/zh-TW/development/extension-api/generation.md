# 生成請求

發送 LLM 請求、向全域工具註冊表註冊工具、解析連線設定的相關 API。

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
| `llmPresetName` | 載入 chat completion preset 來覆寫**生成參數**（溫度、top_p、frequency_penalty、max_tokens 等）。不影響連線欄位。 |
| `apiPresetName` | 載入 **chat completion preset 的連線欄位**（chat_completion_source、模型、API URL、reverse_proxy 等）。**只接受 chat completion preset 名稱，不接受 connection profile 名稱**——後者請用下方 `apiSettingsOverride`（搭配 [`context.connectionProfiles.resolve`](#連線設定connection-profile解析)）。不影響生成參數。 |
| `apiSettingsOverride` | 直接用物件覆寫連線設定（通常來自 `context.connectionProfiles.resolve(...)`）。 |
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

`buildPresetAwarePromptMessages` 按照當前 prompt 預設的 `prompt_order` 排列訊息，可選地注入角色卡和世界書條目。它控制**發送什麼**；`sendOpenAIRequest` 的預設參數控制**怎麼發送**（模型、溫度、連線）。組裝詳情見 [預設與提示詞](/zh-TW/development/extension-api/presets-and-prompts)。

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

## 連線設定（Connection Profile）解析

Connection profile 是 Luker 連線管理員管理的一組**連線設定**（API 類型、模型、金鑰、代理等），與 chat completion preset 是**兩個獨立的東西**——前者描述「連到哪」，後者描述「按什麼參數生成」，可自由組合。

當外掛需要讓使用者從 connection profile 中挑一個發請求時（例如自帶「使用哪個 API 設定」的下拉選單），用 `context.connectionProfiles`：

```ts
context.connectionProfiles.list(): ConnectionProfile[]

context.connectionProfiles.resolve({
  profileName?: string,    // 使用者挑的 profile 名稱；空字串表示不切換
  defaultApi?: string,     // 當 profile 沒指定 api 時的回退，預設 'openai'
  defaultSource?: string,  // 當無法從 profile.api 推斷時，chat_completion_source 的回退值
}): {
  profile: object | null,            // 原始 profile，未匹配時為 null
  requestApi: string,                 // 'openai' / 'kobold' / 'novel' / 'textgenerationwebui'
  apiSettingsOverride: object | null  // 可直接傳給 sendOpenAIRequest
}
```

`list()` 用於填充 UI 下拉選單。`resolve(...)` 把一個 profile 名稱解析成 `sendOpenAIRequest` 能吃的 `apiSettingsOverride`——這是把「UI 選的 profile 名稱」接到「實際請求」的**唯一正確路徑**。

### 端到端範例

```js
import { sendOpenAIRequest } from '../../../openai.js';
const context = Luker.getContext();

const { apiSettingsOverride } = context.connectionProfiles.resolve({
    profileName: userSelectedProfileName,                                   // 例如 'claude'
    defaultApi: context.mainApi || 'openai',
    defaultSource: context.chatCompletionSettings?.chat_completion_source || '',
});

const result = await sendOpenAIRequest('quiet', messages, signal, {
    llmPresetName: userSelectedPresetName,  // 只覆寫生成參數，例如 'Default'
    apiSettingsOverride,                     // 上一步解析得到，覆寫連線欄位
    requestScope: 'extension_internal',
});
```

::: warning 不要把 connection profile 名稱傳給 apiPresetName
`apiPresetName` 接受的是 chat completion preset 名稱（查 `openai_setting_names`），**不是** connection profile 名稱。如果傳錯，會看到 `Preset 'X' not found` 警告，請求會靜默退回到當前 connection 設定——不報錯，但路由錯了。要走 connection profile，必須先用 `context.connectionProfiles.resolve`。
:::

`secret_id` 請求覆蓋：在 chat-completions 請求體中，可以透過 `secret_id` 欄位指定使用哪個金鑰，覆蓋全域選擇。`connectionProfiles.resolve` 回傳的 `apiSettingsOverride` 已經包含了 profile 關聯的 `secret_id`，通常不需要單獨處理。
