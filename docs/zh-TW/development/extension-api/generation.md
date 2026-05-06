# 生成請求

發送 LLM 請求、向全域工具註冊表註冊工具、解析連線設定的相關 API。

## 發送 LLM 請求

推薦使用 `context.generateTask` —— 一次呼叫同時處理 profile 解析、世界書啟用、prompt 組裝、分派與回應正規化。Luker 內建的 search-tools、completion-preset-assistant、character-editor-assistant、memory-graph、orchestrator 都透過它發起 LLM 請求。第三方外掛也應該用這個 API,而不是自己拼裝 `sendOpenAIRequest` + `buildPresetAwarePromptMessages` + `connectionProfiles.resolve`。

::: info 為什麼要統一成一個 API
手動拼裝意味著每個外掛都得自己重做 profile 解析、世界書啟用、家族分派(openai vs kobold/novel/textgen)、回應解析。`generateTask` 把這些都收斂到一處,無論底層 API 家族是哪一種,都回傳正規化的結果結構。
:::

### 快速開始

最簡單的純文字請求 —— 自動遵循當前 prompt preset、角色卡與聊天世界書:

```js
const context = Luker.getContext();

const result = await context.generateTask({
    taskMessages: [
        { role: 'system', content: '你是一個翻譯助手。' },
        { role: 'user', content: '把這句話翻譯成法文:hello world。' },
    ],
    worldInfoSource: 'chat',  // 基於當前聊天歷史啟用世界書
    abortSignal: controller.signal,
});

console.log(result.assistantText);
```

### 選項參考

```ts
context.generateTask({
    taskMessages: Array<{role, content, ...}>,   // 必填:system / user / assistant / tool 訊息
    includeCharacterCard?: boolean = true,        // 是否在 envelope 中帶上角色卡
    worldInfoSource?: 'none' | 'task' | 'chat' | 'custom' = 'none',
    customWorldInfoMessages?: Array | null = null, // worldInfoSource 為 'custom' 時必填
    runtimeWorldInfo?: object | null = null,      // 已預先解析的快照,會跳過啟用流程
    forceWorldInfoResimulate?: boolean = false,
    worldInfoType?: string = 'quiet',
    apiPresetName?: string = '',                  // 連線設定名稱(例如 'claude')
    llmPresetName?: string = '',                  // chat completion preset 名稱(例如 'low-temp')
    tools?: Array | null = null,                  // OpenAI 風格的工具定義
    toolChoice?: 'auto' | 'none' | object = 'auto',
    jsonSchema?: object | null = null,            // 結構化輸出模式(與 tools 互斥)
    functionCallMode?: 'auto' | 'native' | 'prompt_xml' | 'prompt_json' = 'auto',
    functionCallOptions?: object | null = null,   // 例如 { protocolStyle, requiredFunctionName }
    abortSignal?: AbortSignal | null = null,
}): Promise<{
    assistantText: string,
    toolCalls: Array<{ name, args, raw }>,
    jsonData: any,                  // jsonSchema 模式成功時填入
    reasoning: string | null,
    finishReason: string | null,
    usage: object | null,
    raw: any,                       // 發送方原始回應(供進階排錯使用)
}>
```

### `worldInfoSource` 模式

| 取值 | 含義 |
|------|------|
| `'none'`(預設) | 跳過世界書啟用。適合已經預先解析好 `runtimeWorldInfo` 或本任務根本不需要世界書的場景。 |
| `'task'` | 基於 `taskMessages` 啟用。任務本身驅動 WI 比對時使用。 |
| `'chat'` | 基於當前聊天歷史啟用(內部使用 `fallbackToCurrentChat: true`)。 |
| `'custom'` | 基於你顯式提供的 `customWorldInfoMessages` 啟用。 |

如果已經有解析好的 WI 快照(例如重試迴圈中快取了一份),直接傳 `runtimeWorldInfo` 並把 `worldInfoSource` 設成 `'none'`,可以跳過重複啟用。

### 工具呼叫

```js
const result = await context.generateTask({
    taskMessages: [
        { role: 'system', content: '只能透過工具呼叫回傳結果。' },
        { role: 'user', content: '搜尋一下:claude opus 4 release notes。' },
    ],
    worldInfoSource: 'none',
    tools: [{
        type: 'function',
        function: {
            name: 'search_web',
            description: '搜尋網頁取得資訊。',
            parameters: {
                type: 'object',
                properties: { query: { type: 'string' } },
                required: ['query'],
            },
        },
    }],
    toolChoice: 'auto',
    functionCallMode: 'auto',
});

for (const call of result.toolCalls) {
    console.log(call.name, call.args);  // args 已經解析成物件
}
```

`result.toolCalls` 一律是 `{ name, args, raw }` 陣列。`args` 已經被解析成物件,不用再 `JSON.parse`。`raw` 是發送方回傳的原始 tool-call 物件,需要原始 `id` 時可用。

#### 強制單一函式

如果想讓模型必須呼叫某個特定函式:

```js
toolChoice: { type: 'function', function: { name: 'my_fn' } },
functionCallOptions: { requiredFunctionName: 'my_fn' },
```

#### 函式呼叫模式

| 模式 | 何時選用 |
|------|----------|
| `'auto'`(預設) | 由執行時根據當前連線設定自動決定。 |
| `'native'` | 強制使用原生工具呼叫(例如 OpenAI tools / Anthropic tool_use)。 |
| `'prompt_xml'` | 把工具定義嵌入 system prompt 作為 XML —— 適合不支援原生工具呼叫的模型。 |
| `'prompt_json'` | 把工具定義作為 JSON 嵌入 prompt。 |

### 結構化輸出 (JSON Schema)

非工具的結構化輸出:

```js
const result = await context.generateTask({
    taskMessages: [
        { role: 'system', content: '把使用者資訊以 JSON 形式回傳。' },
        { role: 'user', content: 'Alice,32 歲,軟體工程師。' },
    ],
    worldInfoSource: 'none',
    jsonSchema: {
        type: 'object',
        properties: {
            name: { type: 'string' },
            age: { type: 'integer' },
            occupation: { type: 'string' },
        },
        required: ['name', 'age', 'occupation'],
        additionalProperties: false,
    },
});

console.log(result.jsonData);  // { name: 'Alice', age: 32, occupation: 'software engineer' }
```

`tools` 與 `jsonSchema` 互斥,只能傳其中一個。

### 錯誤處理

所有失敗都會擲出 `GenerateTaskError`,在 `context.GenerateTaskError` 暴露:

```js
try {
    await context.generateTask({ ... });
} catch (error) {
    if (error instanceof context.GenerateTaskError) {
        console.warn('generateTask failed:', error.code, error.message);
        if (error.code === 'rate_limit') {
            // 退避後重試
        }
    }
    throw error;
}
```

| `code` | 含義 |
|--------|------|
| `aborted` | 透過 `abortSignal` 主動中止。 |
| `network` | 網路層失敗(DNS、ECONNREFUSED 等)。 |
| `auth_missing` | 認證錯誤(401、缺 API key)。 |
| `rate_limit` | 觸發限流(429)。 |
| `invalid_input` | 選項不合法(例如同時傳了 `tools` 和 `jsonSchema`,或 `worldInfoSource:'custom'` 但未傳 `customWorldInfoMessages`)。 |
| `unsupported_api` | 解析出的請求 API 在執行時不支援。 |
| `tool_call_parse` | 模型回傳的 tool call `arguments` 無法 `JSON.parse`。 |
| `json_schema_violation` | `jsonSchema` 模式驗證失敗。 |
| `no_response` | 發送方沒回傳可用內容。 |
| `unknown` | 未分類失敗的兜底。 |

`error.cause` 在可用時攜帶原始底層錯誤;`error.details` 攜帶診斷上下文(例如 `tool_call_parse` 時被拒的 `rawArgs`)。

### 端到端範例

一個搜尋代理 —— 遵循使用者選擇的連線設定、迴圈工具呼叫直到模型給出最終結果、支援取消:

```js
const context = Luker.getContext();
const settings = extension_settings.my_search_agent;

const result = await context.generateTask({
    taskMessages: [
        { role: 'system', content: '你是搜尋代理,只能用 search_web。' },
        { role: 'user', content: userQuery },
    ],
    worldInfoSource: 'chat',          // 基於當前聊天啟用 WI
    apiPresetName: settings.connectionProfileName,  // 使用者選擇的,例如 'claude'
    llmPresetName: settings.presetName,             // 使用者選擇的,例如 'low-temp'
    tools: [searchWebTool],
    toolChoice: 'auto',
    functionCallMode: 'auto',
    abortSignal: controller.signal,
});

if (result.toolCalls.length === 0) {
    return { text: result.assistantText, calls: [] };
}
return {
    text: result.assistantText,
    calls: result.toolCalls.map(c => ({ name: c.name, args: c.args })),
};
```

## 遷移手冊

如果你的外掛以前直接呼叫 `sendOpenAIRequest`,這裡是平移指引。

### 對照表

| 舊 | 新 |
|----|----|
| `import { sendOpenAIRequest } from '../../openai.js'` | 用 `context.generateTask`(無需 import) |
| `import { resolveChatCompletionRequestProfile } from '../connection-manager/profile-resolver.js'` | 刪除 —— 給 `generateTask` 傳 `apiPresetName` |
| `import { extractAllFunctionCalls, getResponseMessageContent } from '../function-call-runtime.js'` | 刪除 —— 讀 `result.toolCalls` 與 `result.assistantText` |
| `context.buildPresetAwarePromptMessages({ messages, envelopeOptions, runtimeWorldInfo })` | 刪除 —— `generateTask` 內部組裝 |
| `responseData = await sendOpenAIRequest('quiet', msgs, signal, { llmPresetName, apiSettingsOverride, tools, toolChoice, requestScope: 'extension_internal', functionCallOptions })` | `result = await context.generateTask({ taskMessages, llmPresetName, apiPresetName, tools, toolChoice, functionCallOptions, abortSignal })` |
| `calls = extractAllFunctionCalls(responseData, allowedNames)` | `calls = result.toolCalls.filter(c => allowedNames.has(c.name))` |
| `assistantText = getResponseMessageContent(responseData)` | `assistantText = result.assistantText` |

### 改造前 / 改造後

**改造前**(手動拼裝):

```js
import { sendOpenAIRequest } from '../../openai.js';
import { resolveChatCompletionRequestProfile } from '../connection-manager/profile-resolver.js';
import { extractAllFunctionCalls } from '../function-call-runtime.js';

const { apiSettingsOverride, requestApi } = resolveChatCompletionRequestProfile({
    profileName: settings.connectionProfileName,
    defaultApi: context.mainApi || 'openai',
    defaultSource: context.chatCompletionSettings?.chat_completion_source || '',
});

const worldInfo = await context.resolveWorldInfoForMessages(messages, {
    type: 'quiet',
    fallbackToCurrentChat: true,
});

const promptMessages = context.buildPresetAwarePromptMessages({
    messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
    ],
    envelopeOptions: {
        includeCharacterCard: true,
        api: settings.presetName ? 'openai' : requestApi,
        promptPresetName: settings.presetName,
    },
    promptPresetName: settings.presetName,
    runtimeWorldInfo: worldInfo,
});

const responseData = await sendOpenAIRequest('quiet', promptMessages, abortSignal, {
    tools,
    toolChoice: 'auto',
    replaceTools: true,
    llmPresetName: settings.presetName,
    apiSettingsOverride,
    requestScope: 'extension_internal',
    functionCallOptions: { protocolStyle: TOOL_PROTOCOL_STYLE.JSON_SCHEMA },
});

const calls = extractAllFunctionCalls(responseData, allowedNames);
```

**改造後**(`generateTask`):

```js
const result = await context.generateTask({
    taskMessages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
    ],
    includeCharacterCard: true,
    worldInfoSource: 'chat',
    apiPresetName: settings.connectionProfileName,
    llmPresetName: settings.presetName,
    tools,
    toolChoice: 'auto',
    functionCallMode: 'auto',
    functionCallOptions: { protocolStyle: TOOL_PROTOCOL_STYLE.JSON_SCHEMA },
    abortSignal,
});

const calls = result.toolCalls.filter(c => allowedNames.has(c.name));
```

### 注意事項

- `generateTask` 內部固定使用 `requestScope: 'extension_internal'`,你不再需要傳這個欄位。
- 傳了 `tools` 就隱含 `replaceTools: true`,沒有單獨的開關。
- 推薦 API 不再暴露 `apiSettingsOverride` 路徑。如果確實需要原始 override(進階用法),可以走 `connectionProfiles.resolve` 加底層 dispatcher,見 [底層參考](#底層參考)。

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
        return `結果:${args.input}`;
    },
    formatMessage: (args) => {
        return `使用了工具,輸入:${args.input}`;
    },
    shouldRegister: async () => {
        return true;
    },
    stealth: false,
});
```

移除已註冊的工具:

```js
context.unregisterFunctionTool('my_plugin_tool');
```

工具相關方法:

| 方法 | 說明 |
|------|------|
| `context.registerFunctionTool(tool)` | 將工具註冊到全域註冊表 |
| `context.unregisterFunctionTool(name)` | 從全域註冊表移除工具 |
| `context.isToolCallingSupported()` | 檢查當前 API/模型是否支援工具呼叫 |
| `context.canPerformToolCalls(type)` | 檢查指定請求類型是否可以執行工具呼叫 |

::: warning 全域工具 vs 單次請求工具
`registerFunctionTool` 將工具新增到**全域註冊表**——它們在主聊天中可供模型呼叫。`generateTask` 的 `tools` 參數僅為**該次請求**提供工具,不影響全域註冊表。
:::

## 底層參考

下面這些是 `generateTask` 背後的底層原語。除非你的場景 `generateTask` 真的覆蓋不了 —— 例如需要串流回應、需要在重試之間改寫請求、要接非標準管線 —— 否則不建議直接呼叫。

### 連線設定 (Connection Profile) 解析

Connection profile 是 Luker 連線管理員管理的一組**連線設定**(API 類型、模型、金鑰、代理等),與 chat completion preset 是**兩個獨立的東西**——前者描述「連到哪」,後者描述「按什麼參數生成」,可自由組合。

當外掛需要讓使用者從 connection profile 中挑一個發請求時(例如自帶「使用哪個 API 設定」的下拉選單),用 `context.connectionProfiles.list()` 填充 UI:

```js
context.connectionProfiles.list(): ConnectionProfile[]
```

::: info `connectionProfiles.resolve` 已不推薦外掛直接呼叫
有了 `generateTask`,你只需要傳 profile 的*名稱*(`apiPresetName`),解析在內部完成。`resolve(...)` 仍保留以相容舊程式碼,但新程式碼不推薦使用。
:::

### sendOpenAIRequest

底層 LLM dispatcher。`generateTask` 內部對 OpenAI 家族的請求會呼叫它,前提是 envelope 組裝、世界書啟用、profile 解析都已經在外層完成。

```js
import { sendOpenAIRequest } from '../../../openai.js';

const result = await sendOpenAIRequest('quiet', messages, signal, {
    tools,
    toolChoice: 'auto',
    replaceTools: true,
    llmPresetName,
    apiSettingsOverride,
    requestScope: 'extension_internal',
    functionCallOptions: { protocolStyle: 'json_schema' },
});
```

第一個參數 `'quiet'` 表示這是一個背景請求,不會出現在聊天 UI 中。

| 參數 | 用途 |
|------|------|
| `llmPresetName` | 載入 chat completion preset 來覆寫**生成參數**(溫度、top_p、frequency_penalty、max_tokens 等)。不影響連線欄位。 |
| `apiPresetName` | 連線設定名稱。內部解析。如果同時傳了 `apiSettingsOverride`,以顯式 override 為準。 |
| `apiSettingsOverride` | 直接用物件覆寫連線設定(通常來自 `connectionProfiles.resolve`)。優先序高於 `apiPresetName`。 |
| `requestScope` | 設為 `'extension_internal'` 可跳過主聊天的 CHAT_COMPLETION 鉤子。 |

### buildPresetAwarePromptMessages

只做 envelope 組裝,不發請求。適合需要**預覽**組裝結果但不實際發送的場景(例如「展示將要發送的 prompt」工具)。

```js
const messages = context.buildPresetAwarePromptMessages({
    messages: [
        { role: 'system', content: taskSystemPrompt },
        { role: 'user', content: taskUserPrompt },
    ],
    envelopeOptions: {
        includeCharacterCard: true,
        api: 'openai',
        promptPresetName: llmPresetName,
    },
    promptPresetName: llmPresetName,
    runtimeWorldInfo: preResolvedWorldInfo,
});
```

它按照當前 prompt 預設的 `prompt_order` 排列訊息,可選地注入角色卡和世界書條目。組裝詳情見 [預設與提示詞](/zh-TW/development/extension-api/presets-and-prompts)。
