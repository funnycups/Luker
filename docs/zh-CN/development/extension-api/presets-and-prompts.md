# 预设与提示词

预设管理 API，以及把消息组装成带角色卡和世界书的提示词的相关 API。

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
  target?: PresetRef | string,
  options?: { collection?: string, defaultCollection?: string, allowMissingName?: boolean }
): { collection: string, name: string } | null
```

把一个预设引用规范化成 `{ collection, name }`。这是纯粹的名字解析助手，**不会**返回连接信息。可传入 `PresetRef`、表示集合名的字符串（解析成该集合当前选中的预设）、或 `null`（按 `options.collection` 解析当前选中的预设）。无法确定 collection 或 name 时返回 `null`。

::: tip 想找连接配置解析？
这个函数**不会**返回 API 端点、模型或密钥信息。要把 connection manager 的 profile 解析成 `sendOpenAIRequest` 能吃的连接配置，请用 [`context.connectionProfiles.resolve`](/zh-CN/development/extension-api/generation#连接配置-connection-profile-解析)。
:::

### presets.state

绑定到预设的插件运行时/会话数据。State sidecar 与预设文件并排存放，**不会随预设一起导出**，仅供插件侧运行时使用（例如编排器的「按预设记忆 agent 覆盖」、预设助手的「上次使用的模板」）。不要把插件数据塞进预设 body，用 `presets.state.*`。

所有方法都接受 `options.target`（`PresetRef`）和 `options.collection` 做跨预设读写；两者默认指向当前选中的预设。

::: warning 行为变更（2026-06-28）
预设状态的读写 API（`get`、`getBatch`、`update`、`patch`、`delete`、`deleteAll`）在 HTTP 失败时不再抛出异常，改为返回 `{ok, ...}` envelope（与聊天状态一致）。如果你的插件原本写了 `try { await ctx.presets.state.get(...) } catch (e) { ... }`，请改用 `if (!result.ok) { ... }`。
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

读取指定命名空间下的预设状态。成功时返回 `{ok: true, state}`，其中 `state` 是存储的值，命名空间无数据时为 `null`。失败时返回 `{ok: false, state: null, reason, hint}` —— 见下方[错误原因](#错误原因)。

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

单次请求批量读取多个命名空间。成功时返回 `{ok: true, results}`，其中 `results` 是以命名空间为键的 `Map`；每个条目本身为 `{ok: true, state}`，不存在的命名空间对应 `{ok: true, state: null}`。失败时（无活动预设、传输错误、HTTP 错误）返回 `{ok: false, results: <空 Map>, reason, hint}`。

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

**推荐的读—改—写接口。** `updater` 取得当前状态（不存在时为 `{}`），返回下一份状态。系统底层自动计算最小增量 patch，只有变化的那部分上网。返回 `null` / `undefined` 视为「无变更」，结果为 `{ok: true, updated: false}`。409 冲突（并发改动）会自动重试；重试预算由 `options.maxRetries` 控制（默认 1）。失败时返回 `{ok: false, reason, hint}` —— 见下方[错误原因](#错误原因)。该函数永不抛出；reducer 内部抛出的异常会被捕获并以 `reason: 'VALIDATION_ARGS'` 形式返回。

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

直接施加 RFC 6902 patch 操作。典型的读—改—写流程优先用 `update()`；只有当你已有操作列表（例如重放此前计算好的 diff）时才用 `patch()`。成功时返回 `{ok: true}`；失败时返回 `{ok: false, reason, hint}` —— 见下方[错误原因](#错误原因)。

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

删除指定命名空间的预设状态。幂等 —— sidecar 不存在时也会成功返回。成功时返回 `{ok: true}`；失败时返回 `{ok: false, reason, hint}` —— 见下方[错误原因](#错误原因)。

#### presets.state.deleteAll

```ts
presets.state.deleteAll(target?: PresetRef | string | null): Promise<
  | { ok: true }
  | { ok: false, reason: string, hint: string }
>
```

清空指定预设下的所有命名空间。慎用 —— 一般只在预设本身被删除或重置时调用。成功时返回 `{ok: true}`；失败时返回 `{ok: false, reason, hint}` —— 见下方[错误原因](#错误原因)。

#### 最佳实践

- 优先用 `presets.state.update()`，不要手动串 `get()` + 整份覆盖 —— helper 只发 diff，并替你处理 409 重试。
- 负载保持为可 JSON 序列化的普通对象；顶层数组或基本类型不支持。
- 一个命名空间装一片逻辑状态，不要把无关数据塞同一个命名空间。
- 处理 `ok: false` 返回值，保持插件 UI 的弹性 —— 按 `reason` 分支处理，不要翻译 `hint`（见[错误原因](#错误原因)）。

#### 错误原因

预设状态的读写方法（`get`、`getBatch`、`update`、`patch`、`delete`、`deleteAll`）失败时会返回 `{ok: false, reason, hint}`。`reason` 字段沿用与[聊天状态](/zh-CN/development/extension-api/chat-and-state#错误原因)相同的词汇表：

| Reason | 触发时机 | 建议处理 |
|---|---|---|
| `VALIDATION_ARGS` | 参数错误（命名空间为空、updater 非函数、operations 非数组、reducer 抛错） | 修正调用方 —— 这是程序员 bug |
| `VALIDATION_TARGET` | 无活动预设（apiId/name 解析失败） | 跳过写入，等用户选定预设后再试 |
| `VALIDATION_COMMIT` | 仅楼层状态（不适用于预设状态） | —— |
| `INSTANCE_DESTROYED` | 仅楼层状态（不适用于预设状态） | —— |
| `CONFLICT` | 重试后仍是 HTTP 409 | 重新读取当前状态后再试 |
| `HTTP_ERROR` | 其他非 2xx 响应 | 检查 `hint` 中的状态码，可以面向用户弹 toast |
| `TRANSPORT_ERROR` | fetch 抛错（网络、CORS、abort） | 重试或向用户展示网络错误 |
| `REPLAY_BROKEN` | 仅楼层状态（不适用于预设状态） | —— |
| `LOG_WRITE_FAILED` | 仅楼层状态（不适用于预设状态） | —— |

`hint` 字段是英文、不超过 120 字符的可操作诊断信息。它不会被本地化 —— 面向用户的本地化文案请根据 `reason` 切换，而不是翻译 `hint`。

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

基于当前预设配置，将插件的消息按照 prompt 预设的排列顺序组装为可发送给 API 的提示词消息列表。这是一个**可选的**组装工具——简单的 LLM 调用不需要它，只有当你需要复用角色卡、世界书或 prompt 模板时才需要使用。

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
import { sendOpenAIRequest } from '../../../openai.js';
const response = await sendOpenAIRequest('quiet', promptMessages, signal, {
 requestScope: 'extension_internal',
});
```

::: tip 关于后处理钩子（postActivationHook）
`resolveWorldInfoForMessages` 的 `postActivationHook` 参数允许你在世界书激活后、注入前对条目进行任意修改——包括修改内容、调整注入位置和深度、甚至增删条目。hook 接收归一化后的完整世界书 payload 并返回修改后的版本。例如记忆图插件利用此钩子将 depth 类型的世界书条目重写到 after 位置，避免插入到聊天深度中干扰插件自己的指令。
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
| `options.postActivationHook` | 激活后的钩子函数，接收完整的世界书 payload，可以修改条目的内容、位置、深度，或增删条目 |

返回的对象包含 `worldInfoBeforeEntries`、`worldInfoAfterEntries`、`worldInfoDepth` 等字段，可以直接传给 `buildPresetAwarePromptMessages` 的 `runtimeWorldInfo` 参数。

::: tip 世界书重扫
`resolveWorldInfoForMessages` 本质上就是对自定义消息进行世界书重扫。插件可以用它来：
- 为独立的 LLM 调用获取相关的世界书条目
- 测试特定消息会触发哪些世界书条目
- 在不影响主对话的情况下进行世界书激活模拟
:::

### 推荐的独立 LLM 调用模式

当插件需要进行独立的 LLM 调用（如弹窗中的 AI 辅助功能）时，推荐以下模式：

```js
import { sendOpenAIRequest } from '../../../openai.js';
const context = Luker.getContext();

// 1. 解析世界书激活结果
const wi = await context.resolveWorldInfoForMessages(myCustomMessages, {
 type: 'quiet',
 fallbackToCurrentChat: false,
});

// 2. 组装提示词（注入角色卡、世界书、按 prompt_order 排列）
const requestMessages = context.buildPresetAwarePromptMessages({
 messages: myCustomMessages,
 runtimeWorldInfo: wi,
});

// 3. 发送请求
const result = await sendOpenAIRequest('quiet', requestMessages, signal, {
 requestScope: 'extension_internal',
});
```

如果不需要角色卡和世界书，可以跳过步骤 1-2，直接传 messages 给 `sendOpenAIRequest`。`sendOpenAIRequest` 详见 [生成请求](/zh-CN/development/extension-api/generation)。

## Prompt 信封检视

对于诊断 UI 和「预览将要发送的内容」类工具，插件可以读取已组装好的 prompt 信封和 layout，而不必真的发起请求。

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

返回当前已解析的 prompt 配置快照，包含：

- `mainApi` / `completionApi`——活动 API 标识
- `presetRefs`——已解析的 completion / context / instruct / sysprompt / reasoning 预设名
- `promptCore`——每个预设里影响 prompt 的字段
- `promptLayout`——合并后的 Luker layout（来自 `extensions.luker.prompt_layout`）
- `promptCatalog`——`prompt.identifier` → `{ name, role, content, marker, systemPrompt }` 的映射
- `characterCard`——当前角色字段（`includeCharacterCard !== false` 时）

这与 `buildPresetAwarePromptMessages` 内部使用的数据是同一份。适合在发送前向用户展示插件请求的样子。

### getActivePromptLayout

```ts
getActivePromptLayout(options?: object): PromptLayoutEntry[]
```

仅返回合并后 prompt layout 的便捷访问器。每个条目有 `id`、`enabled`、`order`、`role`、`phase`、`source`、`content`、`path`、`promptIdentifier`、`tags`。

### formatPromptPresetEnvelope

```ts
formatPromptPresetEnvelope(envelope?: object, options?: { label?: string }): string
```

把信封格式化为 `[[LABEL]]\n<json>` 形式，便于嵌入另一段 prompt（例如委托给一个需要推理用户 prompt 配置的 meta-LLM）。未提供时默认使用当前信封。

```js
const ctx = Luker.getContext();
const envelope = ctx.getActivePromptPresetEnvelope({ includeCharacterCard: true });
const serialized = ctx.formatPromptPresetEnvelope(envelope);
console.log(serialized);
```

## 推理（Reasoning）

推理辅助函数用于解析和渲染 reasoning 模型（Claude reasoning、DeepSeek-R1、o1 等）输出的 `<thinking>...</thinking>` 风格代码块。

### parseReasoningFromString

```ts
parseReasoningFromString(
    text: string,
    options?: { strict?: boolean },
    template?: ReasoningTemplate | null,
): { reasoning: string, content: string } | null
```

根据推理模板（或当前 `power_user.reasoning` 模板）的 `prefix` 和 `suffix`，把模型输出字符串拆成 `reasoning` 和 `content`。模板缺少 prefix / suffix 或解析失败时返回 `null`。

| 选项 | 说明 |
|------|------|
| `strict` | 为 `true`（默认）时 prefix 必须出现在开头（去除前导空白后）。为 `false` 时在任意位置查找 |

### getReasoningTemplateByName

```ts
getReasoningTemplateByName(name: string): ReasoningTemplate
```

按名称查找推理模板。未找到时抛出 `Error('Unknown reasoning template name: "<name>"')`。返回的模板应当作只读处理。

### updateReasoningUI

```ts
updateReasoningUI(
    messageIdOrElement: number | HTMLElement | JQuery,
    options?: { reset?: boolean },
): void
```

触发某条消息推理块的 UI 刷新。可传聊天索引、原生 DOM 元素或 JQuery 包装。`reset: true` 时跳过读取消息当前的 reasoning 状态——在 swipe 时新的 reasoning 还没写入时使用。

### removeReasoningFromString

```ts
removeReasoningFromString(str: string): string
```

按当前 reasoning 模板从字符串里剥掉 reasoning 前后缀块。没有配置模板或没匹配到 reasoning 段时原样返回。当你只想要模型输出里给用户看的最终答复（去掉 `<thinking>……</thinking>` 之类）时用。

```js
const ctx = Luker.getContext();
const parsed = ctx.parseReasoningFromString(modelOutput);
if (parsed) {
    console.log('Reasoning:', parsed.reasoning);
    console.log('Final answer:', parsed.content);
}
```

## 设置视图（只读）

下面这些属性暴露的是活的设置对象。它们是可变引用——只能通过对应的规范 API（`presets.save`、`saveSettingsDebounced` 等）写入。直接修改可能不会被正确持久化。

### chatCompletionSettings

```ts
context.chatCompletionSettings: object
```

`oai_settings` 的引用。只读视图，便于检视当前 chat completion 源、模型和参数。

### textCompletionSettings

```ts
context.textCompletionSettings: object
```

`textgenerationwebui_settings` 的引用。只读视图，对应当前 text completion 后端。

### powerUserSettings

```ts
context.powerUserSettings: object
```

`power_user` 的引用。承载 tokenizer 选择、推理模板选择、消息显示偏好以及其他用户级配置。

::: warning 通过 API 修改，不要直接写
这些视图仅供检视。直接写入可能绕过 debounce 保存逻辑。要更改连接或模型，请使用面向用户的 UI 或 [`presets.save`](#presets-save)。要更改生成参数，请使用 chat completion 预设。
:::

## 连接相关辅助

### context.openai

```ts
context.openai: {
    proxies: Array<{ name: string, url: string, ... }>,
    ZAI_ENDPOINT: Record<string, string>,
    stripPresetConnectionFields(preset: object): object,
}
```

处理 chat completion 连接状态的辅助集合。`proxies` 是用户配置的反向代理实时列表；`ZAI_ENDPOINT` 列出已知的智谱 / Z.AI 端点 URL;`stripPresetConnectionFields` 返回去掉连接相关字段（API 源、模型、proxy 等）的预设克隆——导出「不同用户环境也能用」的预设时使用。

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

`textCompletion.types` 列举支持的 text-completion 后端标识（`OOBA`、`MANCER`、`APHRODITE`、`KOBOLDCPP`……）。在按当前 text-completion provider 分支行为时使用。
