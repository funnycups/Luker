# 生成请求

发送 LLM 请求、向全局工具注册表注册工具、解析连接配置的相关 API。

## 发送 LLM 请求

插件可以使用 `sendOpenAIRequest` 发送独立的 LLM 请求，这是核心的生成函数。

### 基本用法

对于不需要角色卡或世界书的简单 LLM 调用：

```js
import { sendOpenAIRequest } from '../../../openai.js';

const result = await sendOpenAIRequest('quiet', [
    { role: 'system', content: '你是一个翻译助手。' },
    { role: 'user', content: '翻译这段文字...' },
], signal, {
    requestScope: 'extension_internal',
});
```

第一个参数 `'quiet'` 表示这是一个后台请求，不会出现在聊天 UI 中。

### 预设覆盖

`sendOpenAIRequest` 接受覆盖参数来控制使用哪个模型、API 端点和生成设置：

```js
const result = await sendOpenAIRequest('quiet', messages, signal, {
    llmPresetName: 'my-low-temp',       // 覆盖生成参数（温度、top_p 等）
    apiSettingsOverride: profileOverride, // 覆盖连接设置（模型、API URL 等）
    requestScope: 'extension_internal',
});
```

| 参数 | 用途 |
|------|------|
| `llmPresetName` | 加载 chat completion preset 来覆盖**生成参数**（温度、top_p、frequency_penalty、max_tokens 等）。不影响连接字段。 |
| `apiPresetName` | 连接配置名。内部解析成对应的连接字段 override 并应用到请求——等价于自己先调一次 `context.connectionProfiles.resolve(...)`，只是调用点更简洁。如果同时传了 `apiSettingsOverride`，以显式 override 为准。 |
| `apiSettingsOverride` | 直接用对象覆盖连接设置（通常来自 `context.connectionProfiles.resolve(...)`）。优先级高于 `apiPresetName`。 |
| `requestScope` | 设为 `'extension_internal'` 可跳过主聊天的 CHAT_COMPLETION 钩子。 |

### 工具调用

在请求中包含工具定义：

```js
const result = await sendOpenAIRequest('quiet', messages, signal, {
    tools: [
        {
            type: 'function',
            function: {
                name: 'search_web',
                description: '搜索网页获取信息',
                parameters: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', description: '搜索关键词' },
                    },
                    required: ['query'],
                },
            },
        },
    ],
    toolChoice: 'auto',
    functionCallMode: 'native',  // 或 'prompt_xml' 使用纯文本模式
    requestScope: 'extension_internal',
});
```

这些 `tools` 仅用于本次请求，与全局工具注册表（见下方[工具注册](#工具注册)）是分开的。

### 配合 Prompt 组装

对于需要融入角色卡、世界书或 prompt 模板的请求，先使用 `buildPresetAwarePromptMessages` 组装消息：

```js
const context = Luker.getContext();

// 第一步：解析世界书
const worldInfo = await context.resolveWorldInfoForMessages(rawMessages);

// 第二步：按 prompt 预设布局组装消息
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

// 第三步：发送组装好的消息
const result = await sendOpenAIRequest('quiet', messages, signal, {
    llmPresetName,
    apiSettingsOverride,
    requestScope: 'extension_internal',
});
```

`buildPresetAwarePromptMessages` 按照当前 prompt 预设的 `prompt_order` 排列消息，可选地注入角色卡和世界书条目。它控制**发送什么**；`sendOpenAIRequest` 的预设参数控制**怎么发送**（模型、温度、连接）。组装详情见 [预设与提示词](/zh-CN/development/extension-api/presets-and-prompts)。

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
        // 执行工具并返回结果字符串
        return `结果：${args.input}`;
    },
    formatMessage: (args) => {
        // 可选：格式化一条人类可读的消息显示在聊天中
        return `使用了工具，输入：${args.input}`;
    },
    shouldRegister: async () => {
        // 可选：返回 false 可条件性地跳过注册
        return true;
    },
    stealth: false, // 可选：为 true 时工具结果不会显示在聊天中
});
```

移除已注册的工具：

```js
context.unregisterFunctionTool('my_plugin_tool');
```

工具相关方法：

| 方法 | 说明 |
|------|------|
| `context.registerFunctionTool(tool)` | 将工具注册到全局注册表 |
| `context.unregisterFunctionTool(name)` | 从全局注册表移除工具 |
| `context.isToolCallingSupported()` | 检查当前 API/模型是否支持工具调用 |
| `context.canPerformToolCalls(type)` | 检查指定请求类型是否可以执行工具调用 |

::: warning 全局工具 vs 单次请求工具
`registerFunctionTool` 将工具添加到**全局注册表**——它们在主聊天中可供模型调用。`sendOpenAIRequest` 的 `tools` 参数仅为**该次请求**提供工具，不影响全局注册表。
:::

## 连接配置(Connection Profile)解析

Connection profile 是 Luker 连接管理器管理的一组**连接配置**（API 类型、模型、密钥、代理等），与 chat completion preset 是**两个独立的东西**——前者描述「连到哪」，后者描述「按什么参数生成」，可自由组合。

当插件需要让用户从 connection profile 中挑一个发请求时（例如自带「使用哪个 API 配置」的下拉框），用 `context.connectionProfiles`：

```ts
context.connectionProfiles.list(): ConnectionProfile[]

context.connectionProfiles.resolve({
  profileName?: string,    // 用户挑的 profile 名；空字符串表示不切换
  defaultApi?: string,     // 当 profile 没指定 api 时的回退，默认 'openai'
  defaultSource?: string,  // 当无法从 profile.api 推断时，chat_completion_source 的回退值
}): {
  profile: object | null,            // 原始 profile，未匹配时为 null
  requestApi: string,                 // 'openai' / 'kobold' / 'novel' / 'textgenerationwebui'
  apiSettingsOverride: object | null  // 可直接传给 sendOpenAIRequest
}
```

`list()` 用于填充 UI 下拉框。`resolve(...)` 把一个 profile 名解析成 `sendOpenAIRequest` 能吃的 `apiSettingsOverride`——这是把「UI 选的 profile 名」接到「实际请求」的**唯一正确路径**。

### 端到端示例

```js
import { sendOpenAIRequest } from '../../../openai.js';
const context = Luker.getContext();

const { apiSettingsOverride } = context.connectionProfiles.resolve({
    profileName: userSelectedProfileName,                                   // 例如 'claude'
    defaultApi: context.mainApi || 'openai',
    defaultSource: context.chatCompletionSettings?.chat_completion_source || '',
});

const result = await sendOpenAIRequest('quiet', messages, signal, {
    llmPresetName: userSelectedPresetName,  // 只覆盖生成参数，例如 'Default'
    apiSettingsOverride,                     // 上一步解析得到，覆盖连接字段
    requestScope: 'extension_internal',
});
```

`secret_id` 请求覆盖：在 chat-completions 请求体中，可以通过 `secret_id` 字段指定使用哪个密钥，覆盖全局选择。`connectionProfiles.resolve` 返回的 `apiSettingsOverride` 已经包含了 profile 关联的 `secret_id`，通常不需要单独处理。
