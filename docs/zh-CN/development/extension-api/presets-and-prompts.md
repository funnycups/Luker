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
