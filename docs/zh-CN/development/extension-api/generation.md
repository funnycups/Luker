# 生成请求

发送 LLM 请求、向全局工具注册表注册工具、解析连接配置的相关 API。

## 发送 LLM 请求

推荐使用 `context.generateTask` —— 一次调用同时处理 profile 解析、世界书激活、prompt 组装、分发与响应归一化。Luker 内置的 search-tools、completion-preset-assistant、character-editor-assistant、memory-graph、orchestrator 都通过它发起 LLM 请求。第三方插件也应该用这个 API,而不是自己拼装 `sendOpenAIRequest` + `buildPresetAwarePromptMessages` + `connectionProfiles.resolve`。

::: info 为什么要统一成一个 API
手动拼装意味着每个插件都得自己重做 profile 解析、世界书激活、家族分发(openai vs kobold/novel/textgen)、响应解析。`generateTask` 把这些都收敛到一处,无论底层 API 家族是哪种,都返回归一化的结果结构。
:::

### 快速开始

最简单的纯文本请求 —— 自动遵循当前 prompt preset、角色卡和聊天世界书:

```js
const context = Luker.getContext();

const result = await context.generateTask({
    taskMessages: [
        { role: 'system', content: '你是一个翻译助手。' },
        { role: 'user', content: '把这句话翻译成法语:hello world。' },
    ],
    worldInfoSource: 'chat',  // 基于当前聊天历史激活世界书
    abortSignal: controller.signal,
});

console.log(result.assistantText);
```

### 选项参考

```ts
context.generateTask({
    taskMessages: Array<{role, content, ...}>,   // 必填:system / user / assistant / tool 消息
    includeCharacterCard?: boolean = true,        // 是否在 envelope 中带上角色卡
    worldInfoSource?: 'none' | 'task' | 'chat' | 'custom' = 'none',
    customWorldInfoMessages?: Array | null = null, // worldInfoSource 为 'custom' 时必填
    runtimeWorldInfo?: object | null = null,      // 已预解析的快照,会跳过激活流程
    forceWorldInfoResimulate?: boolean = false,
    worldInfoType?: string = 'quiet',
    apiPresetName?: string = '',                  // 连接配置名(例如 'claude')
    llmPresetName?: string = '',                  // chat completion preset 名(例如 'low-temp')
    tools?: Array | null = null,                  // OpenAI 风格的工具定义
    toolChoice?: 'auto' | 'none' | object = 'auto',
    jsonSchema?: object | null = null,            // 结构化输出模式(与 tools 互斥)
    functionCallMode?: 'auto' | 'native' | 'prompt_xml' | 'prompt_json' = 'auto',
    functionCallOptions?: object | null = null,   // 例如 { protocolStyle, requiredFunctionName }
    abortSignal?: AbortSignal | null = null,
}): Promise<{
    assistantText: string,
    toolCalls: Array<{ name, args, raw }>,
    jsonData: any,                  // jsonSchema 模式成功时填充
    reasoning: string | null,
    finishReason: string | null,
    usage: object | null,
    raw: any,                       // 发送方原始响应(供高级排错用)
}>
```

### `worldInfoSource` 模式

| 取值 | 含义 |
|------|------|
| `'none'`(默认) | 跳过世界书激活。适合已经预先解析好 `runtimeWorldInfo` 或本任务根本不需要世界书的场景。 |
| `'task'` | 基于 `taskMessages` 激活。任务自身驱动 WI 匹配时用。 |
| `'chat'` | 基于当前聊天历史激活(内部使用 `fallbackToCurrentChat: true`)。 |
| `'custom'` | 基于你显式提供的 `customWorldInfoMessages` 激活。 |

如果已经有解析好的 WI 快照(例如重试循环中缓存了一份),直接传 `runtimeWorldInfo` 并把 `worldInfoSource` 设成 `'none'`,可以跳过重复激活。

### 工具调用

```js
const result = await context.generateTask({
    taskMessages: [
        { role: 'system', content: '只能通过工具调用返回结果。' },
        { role: 'user', content: '搜一下:claude opus 4 release notes。' },
    ],
    worldInfoSource: 'none',
    tools: [{
        type: 'function',
        function: {
            name: 'search_web',
            description: '搜索网页获取信息。',
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
    console.log(call.name, call.args);  // args 已经解析成对象
}
```

`result.toolCalls` 始终是 `{ name, args, raw }` 数组。`args` 已经被解析成对象,不用再 `JSON.parse`。`raw` 是发送方返回的原始 tool-call 对象,需要原始 `id` 时可用。

#### 强制单一函数

如果想让模型必须调用某个特定函数:

```js
toolChoice: { type: 'function', function: { name: 'my_fn' } },
functionCallOptions: { requiredFunctionName: 'my_fn' },
```

#### 函数调用模式

| 模式 | 何时选用 |
|------|----------|
| `'auto'`(默认) | 由运行时根据当前连接配置自动决定。 |
| `'native'` | 强制使用原生工具调用(例如 OpenAI tools / Anthropic tool_use)。 |
| `'prompt_xml'` | 把工具定义嵌入 system prompt 作为 XML —— 适合不支持原生工具调用的模型。 |
| `'prompt_json'` | 把工具定义作为 JSON 嵌入 prompt。 |

### 结构化输出 (JSON Schema)

非工具的结构化输出:

```js
const result = await context.generateTask({
    taskMessages: [
        { role: 'system', content: '把用户信息以 JSON 形式返回。' },
        { role: 'user', content: 'Alice,32 岁,软件工程师。' },
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

`tools` 与 `jsonSchema` 互斥,只能传其中一个。

### 错误处理

所有失败都抛 `GenerateTaskError`,在 `context.GenerateTaskError` 暴露:

```js
try {
    await context.generateTask({ ... });
} catch (error) {
    if (error instanceof context.GenerateTaskError) {
        console.warn('generateTask failed:', error.code, error.message);
        if (error.code === 'rate_limit') {
            // 退避后重试
        }
    }
    throw error;
}
```

| `code` | 含义 |
|--------|------|
| `aborted` | 通过 `abortSignal` 主动中止。 |
| `network` | 网络层失败(DNS、ECONNREFUSED 等)。 |
| `auth_missing` | 鉴权错误(401、缺 API key)。 |
| `rate_limit` | 触发限流(429)。 |
| `invalid_input` | 选项不合法(例如同时传了 `tools` 和 `jsonSchema`,或 `worldInfoSource:'custom'` 但未传 `customWorldInfoMessages`)。 |
| `unsupported_api` | 解析出的请求 API 在运行时不支持。 |
| `tool_call_parse` | 模型返回的 tool call `arguments` 无法 `JSON.parse`。 |
| `json_schema_violation` | `jsonSchema` 模式校验失败。 |
| `no_response` | 发送方没返回可用内容。 |
| `unknown` | 未分类失败的兜底。 |

`error.cause` 在可用时携带原始底层错误;`error.details` 携带诊断上下文(例如 `tool_call_parse` 时被拒的 `rawArgs`)。

### 端到端示例

一个搜索代理 —— 遵循用户选择的连接配置、循环工具调用直到模型给出最终结果、支持取消:

```js
const context = Luker.getContext();
const settings = extension_settings.my_search_agent;

const result = await context.generateTask({
    taskMessages: [
        { role: 'system', content: '你是搜索代理,只能用 search_web。' },
        { role: 'user', content: userQuery },
    ],
    worldInfoSource: 'chat',          // 基于当前聊天激活 WI
    apiPresetName: settings.connectionProfileName,  // 用户选择的,例如 'claude'
    llmPresetName: settings.presetName,             // 用户选择的,例如 'low-temp'
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

## 迁移手册

如果你的插件以前直接调 `sendOpenAIRequest`,这里是平移指引。

### 映射表

| 旧 | 新 |
|----|----|
| `import { sendOpenAIRequest } from '../../openai.js'` | 用 `context.generateTask`(无需 import) |
| `import { resolveChatCompletionRequestProfile } from '../connection-manager/profile-resolver.js'` | 删除 —— 给 `generateTask` 传 `apiPresetName` |
| `import { extractAllFunctionCalls, getResponseMessageContent } from '../function-call-runtime.js'` | 删除 —— 读 `result.toolCalls` 和 `result.assistantText` |
| `context.buildPresetAwarePromptMessages({ messages, envelopeOptions, runtimeWorldInfo })` | 删除 —— `generateTask` 内部组装 |
| `responseData = await sendOpenAIRequest('quiet', msgs, signal, { llmPresetName, apiSettingsOverride, tools, toolChoice, requestScope: 'extension_internal', functionCallOptions })` | `result = await context.generateTask({ taskMessages, llmPresetName, apiPresetName, tools, toolChoice, functionCallOptions, abortSignal })` |
| `calls = extractAllFunctionCalls(responseData, allowedNames)` | `calls = result.toolCalls.filter(c => allowedNames.has(c.name))` |
| `assistantText = getResponseMessageContent(responseData)` | `assistantText = result.assistantText` |

### 改造前 / 改造后

**改造前**(手动拼装):

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

**改造后**(`generateTask`):

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

### 注意事项

- `generateTask` 内部固定使用 `requestScope: 'extension_internal'`,你不再需要传这个字段。
- 传了 `tools` 就隐含 `replaceTools: true`,没有单独的开关。
- 推荐 API 不再暴露 `apiSettingsOverride` 路径。如果确实需要原始 override(高级用法),可以走 `connectionProfiles.resolve` 加底层 dispatcher,见 [底层参考](#底层参考)。

## 工具注册

插件可以通过 `getContext()` 将工具注册到全局工具注册表。注册的工具会出现在主聊天的工具调用流程中——模型可以在正常对话中调用它们。

```js
const context = Luker.getContext();

context.registerFunctionTool({
    name: 'my_plugin_tool',
    displayName: 'My Tool',
    description: '执行某个有用的操作',
    parameters: {
        type: 'object',
        properties: {
            input: { type: 'string', description: '输入文本' },
        },
        required: ['input'],
    },
    action: async (args) => {
        return `结果:${args.input}`;
    },
    formatMessage: (args) => {
        return `使用了工具,输入:${args.input}`;
    },
    shouldRegister: async () => {
        return true;
    },
    stealth: false,
});
```

移除已注册的工具:

```js
context.unregisterFunctionTool('my_plugin_tool');
```

工具相关方法:

| 方法 | 说明 |
|------|------|
| `context.registerFunctionTool(tool)` | 将工具注册到全局注册表 |
| `context.unregisterFunctionTool(name)` | 从全局注册表移除工具 |
| `context.isToolCallingSupported()` | 检查当前 API/模型是否支持工具调用 |
| `context.canPerformToolCalls(type)` | 检查指定请求类型是否可以执行工具调用 |

::: warning 全局工具 vs 单次请求工具
`registerFunctionTool` 将工具添加到**全局注册表**——它们在主聊天中可供模型调用。`generateTask` 的 `tools` 参数仅为**该次请求**提供工具,不影响全局注册表。
:::

## 底层参考

下面这些是 `generateTask` 背后的底层原语。除非你的场景 `generateTask` 真的覆盖不了 —— 例如需要流式响应、需要在重试间改写请求、要接非标准管道 —— 否则不建议直接调用。

### 连接配置 (Connection Profile) 解析

Connection profile 是 Luker 连接管理器管理的一组**连接配置**(API 类型、模型、密钥、代理等),与 chat completion preset 是**两个独立的东西**——前者描述「连到哪」,后者描述「按什么参数生成」,可自由组合。

当插件需要让用户从 connection profile 中挑一个发请求时(例如自带「使用哪个 API 配置」的下拉框),用 `context.connectionProfiles.list()` 填充 UI:

```js
context.connectionProfiles.list(): ConnectionProfile[]
```

::: info `connectionProfiles.resolve` 已不推荐插件直接调用
有了 `generateTask`,你只需要传 profile 的*名称*(`apiPresetName`),解析在内部完成。`resolve(...)` 仍保留以兼容旧代码,但新代码不推荐用。
:::

### sendOpenAIRequest

底层 LLM dispatcher。`generateTask` 内部对 OpenAI 家族的请求会调用它,前提是 envelope 组装、世界书激活、profile 解析都已经在外层完成。

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

第一个参数 `'quiet'` 表示这是一个后台请求,不会出现在聊天 UI 中。

| 参数 | 用途 |
|------|------|
| `llmPresetName` | 加载 chat completion preset 来覆盖**生成参数**(温度、top_p、frequency_penalty、max_tokens 等)。不影响连接字段。 |
| `apiPresetName` | 连接配置名。内部解析。如果同时传了 `apiSettingsOverride`,以显式 override 为准。 |
| `apiSettingsOverride` | 直接用对象覆盖连接设置(通常来自 `connectionProfiles.resolve`)。优先级高于 `apiPresetName`。 |
| `requestScope` | 设为 `'extension_internal'` 可跳过主聊天的 CHAT_COMPLETION 钩子。 |

### buildPresetAwarePromptMessages

只做 envelope 组装,不发请求。适合需要**预览**组装结果但不实际发送的场景(例如「展示将要发送的 prompt」工具)。

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

它按照当前 prompt 预设的 `prompt_order` 排列消息,可选地注入角色卡和世界书条目。组装详情见 [预设与提示词](/zh-CN/development/extension-api/presets-and-prompts)。

### generateRaw

```ts
generateRaw(params: {
    prompt?: string,
    api?: string | null,
    instructOverride?: boolean,
    quietToLoud?: boolean,
    systemPrompt?: string,
    responseLength?: number | null,
    trimNames?: boolean,
    prefill?: string,
    jsonSchema?: object | null,
    llmPresetName?: string,
    apiPresetName?: string,
    apiSettingsOverride?: object | null,
}): Promise<string>
```

把字面量 `prompt` 直接发给当前后端，不涉及聊天历史、世界书、角色卡或扩展 prompt。返回经过后处理的响应文本。适合工具类调用——拟标题、分类、改写——这种你想完全控制输入的场景。

### generateRawData

参数与 `generateRaw` 相同，但返回原始 API 响应对象而非后处理后的字符串。当你需要 `generateRaw` 折叠掉的 `reasoning` 之类字段时用。

### generateQuietPrompt

```ts
generateQuietPrompt(params: {
    quietPrompt?: string,
    quietToLoud?: boolean,
    skipWIAN?: boolean,
    quietImage?: string | null,
    quietName?: string | null,
    responseLength?: number | null,
    forceChId?: number | null,
    jsonSchema?: object | null,
    removeReasoning?: boolean,
    trimToSentence?: boolean,
}): Promise<string>
```

执行一次「quiet」生成，复用当前聊天上下文（历史、persona、世界书等），同时把 `quietPrompt` 作为最后一条用户指令注入。结果默认静默返回，除非设置 `quietToLoud`。

| 参数 | 说明 |
|------|------|
| `quietPrompt` | 作为最后一条用户消息注入的用户侧指令 |
| `quietToLoud` | 为 `true` 时把结果显示在聊天里而非静默返回 |
| `skipWIAN` | 跳过世界书 / Author's Note 注入 |
| `quietImage` | 多模态调用使用的图片 data URL |
| `quietName` | 发送者名称（默认 `'System:'`） |
| `responseLength` | 仅本次调用覆盖最大 token 数 |
| `forceChId` | 群聊中绑定到特定成员的 persona |
| `jsonSchema` | 结构化输出 schema；结果变成序列化 JSON |
| `removeReasoning` | 按当前模板剥离 reasoning 块 |
| `trimToSentence` | 截到最后一个完整句子 |

### generateRaw vs generateQuietPrompt

| | `generateRaw` | `generateQuietPrompt` |
|------|------|------|
| 聊天上下文 | 跳过 | 复用 |
| 世界书 | 关 | 应用（除非 `skipWIAN`） |
| 角色卡 | 关 | 应用 |
| 适用场景 | 独立工具（标题、分类） | 边栏 / 静默的角色内生成 |

### sendStreamingRequest

```ts
sendStreamingRequest(type: string, data: object, options?: object): AsyncGenerator
```

`sendOpenAIRequest` 的流式对应版本。中止信号已被中止时会抛错。会触发 `event_types.GENERATION_BEFORE_API_REQUEST`，`stream: true`，让插件在发送前修改请求。返回一个异步 generator。

### sendGenerationRequest

```ts
sendGenerationRequest(type: string, data: object, options?: object): Promise<object>
```

非流式底层 dispatcher。按 `mainApi` 路由到对应 sender（`sendOpenAIRequest`、`generateHorde` 或 text-completion 后端）。大多数插件不需要——`generateTask` 已经覆盖了常见场景。

### stopGeneration

```ts
stopGeneration(): boolean
```

取消进行中的生成。中止活动 controller、关闭进度通知，返回是否真的停掉了什么。

### streamingProcessor

```ts
context.streamingProcessor: StreamingProcessor | null
```

进行中流式生成的活引用。无活动流时为 `null`。可用于探测或检视进行中的流；不要直接修改它。

## Service 类

三个「类即命名空间」的辅助类，暴露请求生命周期，绕开 `Generate`。当你需要直接控制 chat-completion 或 text-completion 后端时使用（例如自定义重试逻辑、自定义 token 计费）。

### ChatCompletionService

```ts
ChatCompletionService.createRequestData(custom: object): object
ChatCompletionService.sendRequest(data: object, extractData?: boolean, signal?: AbortSignal): Promise<{ content, reasoning } | object | AsyncGenerator>
ChatCompletionService.processRequest(requestData: object, options: object, extractData?: boolean, signal?: AbortSignal): Promise<...>
```

封装 `/api/backends/chat-completions/generate` 端点。`processRequest` 通过 `getPresetManager('openai')` 增加了具名预设的应用。

非流式返回 `{ content, reasoning }`（`extractData: false` 时返回原始 JSON）。流式返回一个产出 `{ text, swipes, state }` 的异步 generator 工厂。

### TextCompletionService

```ts
TextCompletionService.createRequestData({ stream, prompt, ... }): object
TextCompletionService.sendRequest(data, extractData?, signal?): Promise<...>
TextCompletionService.constructPrompt(prompt: ChatMessage[], instructPreset, instructSettings): string
TextCompletionService.processRequest(requestData, options, extractData?, signal?): Promise<...>
```

`ChatCompletionService` 的 text-completion 后端版本。`constructPrompt` 把消息数组格式化成单一的 instruct 格式字符串。

### ConnectionManagerRequestService

```ts
ConnectionManagerRequestService.sendRequest(
    profileId: string,
    prompt: string | ChatMessage[],
    maxTokens: number,
    custom?: { stream?, signal?, extractData?, includePreset?, includeInstruct?, instructSettings? },
    overridePayload?: object,
): Promise<{ content, reasoning } | AsyncGenerator>

ConnectionManagerRequestService.constructPrompt(prompt, profileId, instructSettings?): string
ConnectionManagerRequestService.getSupportedProfiles(): Profile[]
ConnectionManagerRequestService.getProfile(profileId): Profile | null
ConnectionManagerRequestService.getProfileIcon(profileId?): string
ConnectionManagerRequestService.getAllowedTypes(): { openai, textgenerationwebui }
```

通过指定 id 的 Connection Manager profile 发起一次生成，与 UI 当前活动的 profile 无关。Connection Manager 扩展未启用时抛出 `'Connection Manager is not available'`。

```js
const ctx = Luker.getContext();
const result = await ctx.ConnectionManagerRequestService.sendRequest(
    settings.profileId,
    [
        { role: 'system', content: 'You are a translator.' },
        { role: 'user', content: 'Hello, world!' },
    ],
    256,
    { signal: controller.signal },
);
console.log(result.content);
```

::: tip generateTask vs Service 类
`generateTask` 一次调用涵盖 profile 解析 + envelope 组装 + WI 激活 + 家族分发。只有当你需要显式控制消息构建（例如裸 text-completion 字符串）或想完全绕开 envelope / WI 时才用 Service 类。
:::

## 响应辅助函数

### extractMessageFromData

```ts
extractMessageFromData(data: object | string): string
```

从后端响应对象中提取助手文本。处理不同后端（OpenAI、Anthropic、Cohere、KoboldAI、NovelAI 等）返回的多种结构。传入字符串时原样返回。

在使用 `sendGenerationRequest` 或未预先提取的 service 类输出时使用。

### getChatCompletionModel

```ts
getChatCompletionModel(): string
```

返回当前为 chat completion 选中的模型标识（例如 `'claude-opus-4-7'`、`'gpt-4o'`）。从当前活动 connection profile 的设置读取。
