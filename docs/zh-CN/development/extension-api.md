# 扩展 API 参考

本文档是 Luker 扩展 API 的完整参考，面向插件开发者。所有 API 均通过 `Luker.getContext()` 暴露。

## 全局入口

```js
const context = Luker.getContext();
```

| 别名 | 说明 |
|------|------|
| `Luker.getContext()` | 推荐使用 |
| `SillyTavern.getContext()` | 兼容别名 |
| `st.getContext()` | 兼容别名 |

新插件应统一使用 `Luker.getContext()`。兼容别名仅为迁移期保留。

## 与 SillyTavern 的 API 差异

Luker 基于 SillyTavern 构建，但在 API 层面有以下主要差异：

| 领域 | SillyTavern | Luker |
|------|-------------|-------|
| 聊天持久化 | 整文件覆写 | Patch-first（RFC 6902 增量更新） |
| 聊天绑定状态 | 仅 `chat_metadata` | 新增聊天状态机制 |
| 预设管理 | 直接导入内部模块 | `context.presets.*` 统一 API |
| 提示词组装 | 需要手动拼接 | `buildPresetAwarePromptMessages()` |
| 世界书模拟 | 无 | `simulateWorldInfoActivation()` |
| 生成钩子 | 基础事件 | 新增 `GENERATION_CONTEXT_READY`、`GENERATION_BEFORE_WORLD_INFO_SCAN` 等细粒度钩子 |
| 事件排序 | 注册顺序 | 支持 `priority`、`pluginOrder`、`makeFirst`/`makeLast` |
| 正则运行时 | 无插件 API | `registerManagedRegexProvider()` |
| 搜索工具 | 无插件 API | `Luker.searchTools` 全局 API |
| 函数调用 | 无共享运行时 | `requestToolCallsWithRetry()` 共享运行时 |
| 连接配置 | 全局单一 | `context.presets.resolve()` 支持按预设解析连接配置 |

> [!IMPORTANT]
> 优先使用 `Luker.getContext()` 提供的 API，而非直接调用底层 HTTP 端点。Context API 封装了 patch-first 语义、冲突处理和重试逻辑，直接调用端点需要自行处理这些细节。

## 聊天数据（只读）

以下属性提供当前聊天的只读访问：

| 属性 | 类型 | 说明 |
|------|------|------|
| `context.chat` | `ChatMessage[]` | 当前聊天消息数组 |
| `context.characters` | `Character[]` | 角色列表 |
| `context.groups` | `Group[]` | 群组列表 |
| `context.name1` | `string` | 用户名 |
| `context.name2` | `string` | 角色名 |
| `context.characterId` | `number` | 当前角色 ID |
| `context.groupId` | `string` | 当前群组 ID |
| `context.chat_metadata` | `object` | 当前聊天的元数据 |
| `context.online_status` | `string` | API 连接状态 |

## 消息 API

> **模块来源**：`scripts/messages.js` → `getContext()`

Luker 提供了统一的高层消息操作 API。每个操作都是完整的一条龙流程：内存更新 + DOM 渲染 + 事件触发 + 持久化。

### addMessages

```ts
addMessages(
 messages: ChatMessage | ChatMessage[],
 options?: { scroll?: boolean, silent?: boolean }
): Promise<number | number[]>
```

添加一条或多条消息到聊天中。

- 自动 push 到 `chat[]`、渲染 DOM、触发 `MESSAGE_SENT`/`MESSAGE_RECEIVED` 和 `MESSAGE_RENDERED` 事件、持久化到后端
- 传入数组时批量操作，只触发一次持久化
- 返回新消息的索引（单条返回 `number`，批量返回 `number[]`）

```js
// 添加单条消息
const index = await context.addMessages({
 name: 'System',
 mes: '这是一条系统消息',
 is_system: true,
});

// 批量添加
const indices = await context.addMessages([
 { name: 'User', mes: '你好', is_user: true },
 { name: 'Assistant', mes: '你好！有什么可以帮你的？', is_user: false },
]);
```

### updateMessages

```ts
updateMessages(
 updates: { index: number, patch: object } | { index: number, patch: object }[],
 options?: { rerender?: boolean, silent?: boolean }
): Promise<void>
```

更新一条或多条消息的内容并持久化。

- `patch` 对象的字段会合并到 `chat[index]` 中
- 自动重渲染 DOM、触发 `MESSAGE_EDITED` 和 `MESSAGE_UPDATED` 事件、通过 RFC 6902 增量持久化
- 批量操作时合并为一次持久化调用

```js
// 更新单条消息
await context.updateMessages({
 index: 4,
 patch: { mes: '修改后的内容' },
});

// 批量更新
await context.updateMessages([
 { index: 3, patch: { mes: '新内容 A' } },
 { index: 5, patch: { mes: '新内容 B', extra: { model: 'gpt-4o' } } },
]);
```

### deleteMessages

```ts
deleteMessages(
 index: number | number[],
 options?: { swipe?: number, silent?: boolean }
): Promise<ChatMessage | ChatMessage[]>
```

删除一条或多条消息。

- 自动从 `chat[]` 移除、清理 DOM、触发 `MESSAGE_DELETED` 事件、通过 RFC 6902 增量持久化
- 批量删除时自动处理索引偏移
- 指定 `swipe` 选项时，只删除该消息的特定 swipe 而非整条消息
- 返回被删除的消息对象

```js
// 删除单条消息
const deleted = await context.deleteMessages(5);

// 批量删除
const deletedList = await context.deleteMessages([3, 5, 7]);

// 只删除特定 swipe
await context.deleteMessages(5, { swipe: 2 });
```

### getMessage

```ts
getMessage(index: number): Readonly<ChatMessage> | null
```

获取指定索引的消息（只读）。返回一个 Proxy 对象，尝试修改属性会抛出错误并引导使用 `updateMessages()`。

### getMessageCount

```ts
getMessageCount(): number
```

返回当前聊天的消息总数。

---

::: warning 已弃用的底层 API
以下函数仍然可用但已标记为 deprecated，插件开发者应使用上述统一 API：

- `addOneMessage()` → 使用 `addMessages()`
- `deleteLastMessage()` → 使用 `deleteMessages(chat.length - 1)`
- `deleteMessage()` → 使用 `deleteMessages()`
- `updateMessageBlock()` → 使用 `updateMessages()`
- `patchChatMessages()` → 底层 RFC 6902 传输层，使用 `updateMessages()` / `deleteMessages()`
- `appendChatMessages()` → 底层追加传输层，使用 `addMessages()`
:::

## 聊天持久化

### saveChatMetadata

```ts
saveChatMetadata(withMetadata?: object): Promise<boolean>
```

保存聊天元数据。如果传入 `withMetadata`，会先合并到 `chat_metadata` 再保存。

## 聊天状态

聊天状态是 Luker 新增的聊天绑定状态机制，让插件可以将结构化数据绑定到特定聊天，而不是塞进 `chat_metadata`。

### getChatState

```ts
getChatState(
  namespace: string,
  options?: { target?: ChatTarget }
): Promise<any | null>
```

读取指定命名空间的聊天状态。返回 `null` 表示该命名空间无数据。

- `namespace`：插件的唯一标识符，建议使用插件名
- `target`：可选，指定目标聊天（用于跨聊天读取，如分支场景）

### getChatStateBatch

```ts
getChatStateBatch(
  namespaces: string[],
  options?: { target?: ChatTarget }
): Promise<Record<string, any>>
```

批量读取多个命名空间的聊天状态。返回一个以命名空间为键的对象。

### updateChatState

```ts
updateChatState(
  namespace: string,
  updater: (current: any) => any,
  options?: { target?: ChatTarget }
): Promise<{ ok: boolean }>
```

**推荐的读-改-写方式。** `updater` 函数接收当前状态，返回新状态。系统会自动处理并发冲突。

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

删除指定命名空间的聊天状态。

### 最佳实践

- 使用 `updateChatState()` 进行读-改-写，而非手动链式调用 `getChatState()` + `patchChatState()`
- 保持 payload 为可 JSON 序列化的纯对象
- 处理 `ok: false` 返回值，保持插件 UI 的弹性
- 对于大型插件数据，优先使用聊天状态而非 `chat_metadata`

## 预设 API

`context.presets` 提供了统一的预设管理接口，替代直接导入 `PresetManager` 内部模块。

### presets.list

```ts
presets.list(collection?: string): Array<PresetRef>
```

列出指定集合的所有已保存预设。`collection` 为预设集合名（如 `'openai'`）。

### presets.getSelected

```ts
presets.getSelected(collection?: string): PresetRef | null
```

获取当前选中的预设引用。如果当前选中的是角色卡绑定的运行时预设，返回 `null`。

### presets.getLive

```ts
presets.getLive(collection?: string): PresetBody | null
```

获取当前 UI 中正在编辑的预设内容（包括未保存的修改）。适合需要读取当前实际生效配置的场景。

### presets.getStored

```ts
presets.getStored(ref: { collection: string, name: string }): PresetBody | null
```

获取指定预设的已保存内容。适合跨预设比较或复制内容。

### presets.save

```ts
presets.save(
  ref: { collection: string, name: string },
  body: PresetBody
): Promise<void>
```

保存预设内容。

### presets.resolve

```ts
presets.resolve(
  target?: PresetRef,
  options?: object
): ConnectionProfile
```

解析预设对应的连接配置（API 端点、模型、密钥等）。这是插件进行独立 API 调用时获取连接信息的推荐方式。

返回的 `ConnectionProfile` 包含：

| 字段 | 说明 |
|------|------|
| `requestApi` | 规范化的 API 类型（如 `'openai'`） |
| `requestModel` | 模型名称 |
| `requestUrl` | API 端点 URL |
| `secretId` | 密钥标识符 |

### presets.state

```ts
presets.state.update(
  namespace: string,
  updater: (current: any) => any,
  options?: { target: PresetRef }
): Promise<void>
```

管理绑定到预设的插件运行时/会话数据。这些数据不会随预设导出，仅用于插件的运行时状态。

### 使用规则

- `list()` 和 `getSelected()` 只返回已保存的预设
- 编辑中的预设用 `getLive()`
- 角色卡绑定的运行时预设不算「已保存」，`getSelected()` 返回 `null`，但 `getLive()` 仍可读取
- 不要将插件运行时数据塞进预设 body，使用 `presets.state.*`

## 提示词与世界书组装

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

基于当前预设配置，将聊天消息组装为可发送给 API 的提示词消息列表。这是插件进行独立 LLM 调用时最核心的 API。

**参数说明：**

| 参数 | 说明 |
|------|------|
| `messages` | 要发送的消息数组，每条消息包含 `role`（`'system'`/`'user'`/`'assistant'`）和 `content` |
| `envelopeOptions.includeCharacterCard` | 是否在提示词中包含当前角色卡的设定（默认 `true`） |
| `envelopeOptions.api` | 指定使用的 API 类型（如 `'openai'`），不指定则使用当前连接 |
| `envelopeOptions.promptPresetName` | 指定使用的预设名称，不指定则使用当前预设 |
| `promptPresetName` | 与 `envelopeOptions.promptPresetName` 相同，顶层快捷方式 |
| `runtimeWorldInfo` | 预先解析好的世界书激活结果（通过 `resolveWorldInfoForMessages` 获取） |

**关键行为：**

- 保留活跃预设中聊天历史以外的内容（系统提示、角色描述等）
- 仅替换聊天历史部分为你提供的 `messages`
- 如果提供了 `runtimeWorldInfo`，世界书条目会被注入到对应位置
- 如果指定了 `promptPresetName`，会使用该预设的提示词模板而非当前预设

**实际使用示例**（参考记忆图插件的召回流程）：

```js
// 1. 先解析世界书激活结果
const runtimeWorldInfo = await context.resolveWorldInfoForMessages(
  resolverMessages,
  {
    type: 'quiet',
    fallbackToCurrentChat: false,
    postActivationHook: rewriteDepthWorldInfoToAfter, // 重写指令：将 depth 类型的世界书条目移到 after 位置
  }
);

// 2. 组装提示词
const promptMessages = context.buildPresetAwarePromptMessages({
  messages: [
    { role: 'system', content: '你是一个记忆分析助手...' },
    { role: 'user', content: '请分析以下对话中的关键信息...' },
  ],
  envelopeOptions: {
    includeCharacterCard: true,
    api: envelopeApi,
    promptPresetName: selectedPromptPresetName,
  },
  promptPresetName: selectedPromptPresetName,
  runtimeWorldInfo: runtimeWorldInfo,
});

// 3. 发送给 LLM
const response = await context.generateQuietPrompt(promptMessages);
```

::: tip 关于重写指令（postActivationHook）
`resolveWorldInfoForMessages` 的 `postActivationHook` 参数允许你在世界书激活后、注入前修改条目的位置。这在插件场景中很有用——例如记忆图将 depth 类型的世界书条目重写到 after 位置，避免插入到聊天深度中干扰插件自己的指令。
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

对指定消息执行世界书激活扫描，返回激活结果。这相当于对自定义消息进行一次世界书「重扫」。

**参数说明：**

| 参数 | 说明 |
|------|------|
| `messages` | 用于触发世界书关键词匹配的消息列表 |
| `options.type` | 激活类型（如 `'quiet'` 表示静默扫描，不影响主对话） |
| `options.fallbackToCurrentChat` | 如果 messages 为空，是否回退到当前聊天消息 |
| `options.postActivationHook` | 激活后的钩子函数，可以修改条目的注入位置 |

返回的对象包含 `worldInfoBeforeEntries`、`worldInfoAfterEntries`、`worldInfoDepth` 等字段，可以直接传给 `buildPresetAwarePromptMessages` 的 `runtimeWorldInfo` 参数。

::: tip 世界书重扫
`resolveWorldInfoForMessages` 本质上就是对自定义消息进行世界书重扫。插件可以用它来：
- 为独立的 LLM 调用获取相关的世界书条目
- 测试特定消息会触发哪些世界书条目
- 在不影响主对话的情况下进行世界书激活模拟
:::

### 推荐的弹窗生成模式

当插件需要进行独立的 LLM 调用（如弹窗中的 AI 辅助功能）时，推荐以下模式：

```js
const context = Luker.getContext();

// 1. 解析世界书激活结果
const wi = await context.resolveWorldInfoForMessages(myCustomMessages, {
  type: 'quiet',
  fallbackToCurrentChat: false,
});

// 2. 组装提示词
const requestMessages = context.buildPresetAwarePromptMessages({
  messages: myCustomMessages,
  runtimeWorldInfo: wi,
});

// 3. 发送请求（使用当前预设的连接配置）
const response = await fetch('/api/backends/chat-completions/generate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ messages: requestMessages }),
});
```

## 正则运行时 API

插件可以通过 `registerManagedRegexProvider()` 注册托管的正则处理器，参与 Luker 的正则处理流程。该函数从正则引擎模块导出：

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
  // ...其他正则脚本字段
});

// 卸载时取消注册
handle.unregister();
```

`registerManagedRegexProvider` 返回的句柄提供 `upsertScript`、`removeScript`、`setScripts`、`clearScripts` 和 `unregister` 方法。

## 搜索工具 API

搜索插件通过 `Luker.searchTools` 全局对象暴露 API，供其他插件调用搜索能力：

```js
// 检查搜索插件是否可用
if (globalThis?.Luker?.searchTools) {
  // 获取可用的搜索工具名称列表
  const toolNames = Luker.searchTools.toolNames;
  // 获取工具定义（用于函数调用）
  const toolDefs = Luker.searchTools.getToolDefs();
  // 检查某个工具名是否属于搜索工具
  const isSearchTool = Luker.searchTools.isToolName('web_search');
}
```

`Luker.searchTools` 暴露的是工具定义元数据，实际的搜索执行通过 `requestToolCallsWithRetry()` 的工具调用循环完成。详见[搜索插件](/zh-CN/features/search-tools)。

## 函数调用共享运行时

Luker 提供了共享的函数调用运行时，插件可以复用它来实现工具调用循环：

```js
import { requestToolCallsWithRetry } from '../search-tools/main.js';

const result = await requestToolCallsWithRetry({
  messages: requestMessages,
  tools: myToolDefinitions,
  maxRounds: 3,
  // 连接配置（可选，默认使用当前预设）
  requestApi: profile.requestApi,
  requestModel: profile.requestModel,
  requestUrl: profile.requestUrl,
  secretId: profile.secretId,
});
```

> [!NOTE]
> `requestToolCallsWithRetry` 不在 `Luker.getContext()` 上，而是从 `search-tools/main.js` 模块导出的函数。其他内置插件（如 orchestrator、memory-graph）通过 ES Module import 使用它。

这个运行时处理了工具调用的完整循环：发送请求 → 解析工具调用 → 执行工具 → 将结果注入消息 → 再次请求，直到模型不再调用工具或达到最大轮次。

## 连接配置解析

当插件需要使用非当前预设的连接配置时，使用 `presets.resolve()`：

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

`secret_id` 请求覆盖：在 chat-completions 请求体中，可以通过 `secret_id` 字段指定使用哪个密钥，覆盖全局选择。这在多 Agent 场景中特别有用——不同的 Agent 可以使用不同的 API 密钥。

## 角色状态

```js
// 读取角色级别的持久化状态
const state = context.getCharacterState(namespace);

// 写入角色级别的持久化状态
await context.setCharacterState(namespace, newState);
```

角色状态绑定到角色卡，在所有聊天之间共享。适合存储角色级别的插件配置（如 CardApp 的应用状态）。

## 扩展间通信

### registerExtensionApi

```js
context.registerExtensionApi('my-plugin', {
  doSomething: () => { /* ... */ },
  getData: () => myData,
});
```

### 查找其他插件的 API

```js
const api = context.getExtensionApi('other-plugin');
if (api) {
  api.doSomething();
}
```

## 事件系统

### eventSource

```js
// 监听
context.eventSource.on(eventName, handler, options?);

// 取消监听
context.eventSource.off(eventName, handler);

// 确保最先执行
context.eventSource.makeFirst(eventName, handler);

// 确保最后执行
context.eventSource.makeLast(eventName, handler);

// 查看监听器信息（调试用）
context.eventSource.getListenersMeta(eventName);

// 配置插件排序
context.eventSource.setOrderConfig(config);
```

### 监听器选项

```js
context.eventSource.on(eventName, handler, {
  priority: 10,  // 数字越大越先执行
});
```

### 事件类型

所有事件类型通过 `context.eventTypes` 访问。完整的事件列表和回调参数请参阅[插件开发基础](/zh-CN/development/plugin-basics#事件系统)。

## 世界书读写

插件可以通过 context API 读写世界书条目。

## 底层端点参考（高级 / 调试用）

> [!WARNING]
> 以下端点仅供高级调试和无法使用 `Luker.getContext()` 的集成场景参考。它们是同源 Web 应用路由，不是主要的插件 API 契约。正常插件开发应使用上述 Context API。

### 角色聊天

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/chats/save` | 保存聊天（patch-first） |
| POST | `/api/chats/get` | 获取聊天列表 |
| POST | `/api/chats/delete` | 删除聊天 |
| POST | `/api/chats/rename` | 重命名聊天 |
| POST | `/api/chats/export` | 导出聊天 |

### 群组聊天

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/chats/group/save` | 保存群组聊天 |
| POST | `/api/chats/group/get` | 获取群组聊天列表 |
| POST | `/api/chats/group/delete` | 删除群组聊天 |

### 聊天状态

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/chats/state/get` | 批量读取状态 |
| POST | `/api/chats/state/patch` | 增量更新状态 |
| POST | `/api/chats/state/delete` | 删除状态 |

### 设置

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/settings/save` | 保存设置（patch-first） |
| POST | `/api/settings/get` | 获取设置 |

### 世界书

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/worldinfo/save` | 保存世界书（patch-first） |
| POST | `/api/worldinfo/get` | 获取世界书 |

### 搜索/访问

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/plugins/search/search` | 执行搜索 |
| POST | `/api/plugins/search/visit` | 访问 URL 并提取内容 |

### Patch 操作格式

消息 patch 使用 RFC 6902 JSON Patch 格式：

```json
[
  { "op": "replace", "path": "/4/mes", "value": "新内容" },
  { "op": "add", "path": "/4/extra/note", "value": "备注" },
  { "op": "remove", "path": "/4/extra/old_field" }
]
```

对象 patch（`meta/patch`、`state/patch`、`settings/patch`、`worldinfo/patch`）也使用相同的 RFC 6902 格式。

### Patch 冲突与完整性语义

- 服务端会验证 patch 操作的路径是否存在
- `replace` 操作要求目标路径已存在
- `add` 操作会创建不存在的路径
- 冲突时返回错误，客户端应重试或回退到全量保存

### Chat-Completions 请求体

```json
{
  "messages": [...],
  "model": "gpt-4o",
  "secret_id": "optional-override"
}
```

`secret_id` 字段允许在请求级别覆盖使用的 API 密钥，适用于多 Agent 编排等需要不同密钥的场景。

## 相关页面

- [插件开发基础](/zh-CN/development/plugin-basics) — 插件结构、事件系统、UI 集成
- [角色卡开发](/zh-CN/development/card-developers) — 角色卡扩展字段和 CardApp
- [增量同步](/zh-CN/improvements/incremental-sync) — 增量保存的技术细节
- [预设解耦](/zh-CN/improvements/preset-decoupling) — 预设与 API 选择的解耦机制
