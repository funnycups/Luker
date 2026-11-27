# 迭代工具库（Iteration Library）

`context.iterationLibrary` 为 AI 驱动的迭代式编辑界面提供共享基础设施：LLM 工具调用 runner、消息与 diff 渲染、全屏对比浮层、用于审阅修改提案的 ProposalBus，以及与具体插件解耦的世界书、技能、预设和上下文检索工具集。

如需将可迭代编辑的目标直接接入 Luker 统一的**工作台 → AI 迭代**标签页，请通过 [`context.workbench.registerIterateTarget`](/zh-CN/development/extension-api/workbench#注册-ai-迭代目标) 注册 `IterateTarget`。插件自行管理独立弹窗或全屏开发环境如 CardApp Studio 时，直接调用 `context.iterationLibrary`。

## 接入方式

```js
// Layer 1 — ESM 导入
import { runner, ui, proposalBus } from '/scripts/iteration-library/index.js';

// Layer 2 — lukerContext
const { runner, ui, proposalBus } = lukerContext.iterationLibrary;

// Layer 3 — getContext()
const { runner, ui, proposalBus } = Luker.getContext().iterationLibrary;
```

`iterationLibrary` 是冻结对象，Layer 2 与 Layer 3 返回同一对象。

| 成员 | 类型 | 用途 |
| --- | --- | --- |
| `applyEdits`、`inverseEdit`、`registerOp`、`BUILT_IN_OPS`、`showConflictResolution` | 函数 / 数组 | [Edits 库](./edits-lib.md) |
| `render` | 命名空间 | 渲染消息正文的 Markdown |
| `runner` | 命名空间 | 工具调用请求驱动、持久化工具调用消息、中止辅助函数 |
| `textDiff` | 命名空间 | 并排文本 diff |
| `zoomOverlay` | 命名空间 | 文本 diff 的全屏查看与分栏拖动 |
| `ui` | 命名空间 | 消息卡片、diff 卡片、共享样式表 |
| `tools` | 命名空间 | 共享工具目录与执行器 |
| `proposalBus` | 命名空间 | ProposalBus 工厂与 kind 描述符 |
| `bindIterWorkspaceResizer` | 函数 | 双栏工作区的拖动分隔条 |

ESM 入口另外导出 `createRenderScheduler`。导入 `/scripts/iteration-library/index.js` 会加载全部命名空间；只需个别辅助函数的模块直接导入该函数所在文件，例如 `/scripts/iteration-library/text-diff.js`。

以 `_` 开头的成员用于单元测试重置模块缓存，不属于运行时契约。

## Edits

`applyEdits(edits, live)`、`inverseEdit(edit)`、`registerOp(name, handler)`、`BUILT_IN_OPS` 与 `showConflictResolution(conflicts, opts)` 即 [Edits 库](./edits-lib.md) 的函数，在此重新导出，工作台通过同一对象即可取得全部能力。

## render

| 成员 | 签名 | 行为 |
| --- | --- | --- |
| `ensureMarkdownDeps` | `() => Promise<boolean>` | 加载 Markdown 转换器与 HTML 净化器，重复调用不重复加载。两者就绪时解析为 `true`，加载失败时解析为 `false`。 |
| `renderMessageMarkdown` | `(text) => string` | 返回净化后的 HTML。`ensureMarkdownDeps` 解析前返回转义后的文本，并开始加载。 |

## runner

### `requestToolCallsWithRetry(context, settings, options)`

通过 `context.generateTask` 发送请求；`context.isStreamingPresetEnabled(llmPresetName)` 为真时改用 `context.generateTaskStream`。随后按工具 schema 校验返回的工具调用，失败的尝试按设置重试。

- `context` —— `Luker.getContext()` 返回的对象。
- `settings` —— 读取 `toolCallRetryMax` 作为重试次数，读取 `rpmLimit` 作为 RPM 上限。缺少 `toolCallRetryMax` 时不重试，重试次数没有上限；`rpmLimit: 0` 表示不限制。

| 选项 | 默认值 | 用途 |
| --- | --- | --- |
| `tools` | — | 必填，非空的 OpenAI 风格函数定义数组 |
| `taskMessages` | `[]` | 作为任务发送的聊天补全消息 |
| `apiPresetName` | `''` | 连接配置；留空使用当前连接 |
| `llmPresetName` | `''` | 聊天补全预设；留空使用当前预设 |
| `runtimeWorldInfo` | `null` | 传给 `generateTask` 的预解析世界书 |
| `allowedNames` | `null` | 数组或 `Set`；非空时丢弃名称不在其中的调用 |
| `retriesOverride` | `null` | 替代 `settings.toolCallRetryMax` |
| `abortSignal` | `null` | 中止请求；已中止的尝试直接拒绝，不重试 |
| `includeAssistantText` | `false` | 解析为下文所述的对象形式 |
| `allowNoToolCalls` | `false` | 接受只有文本、没有匹配工具调用的回复 |
| `allowEmptyResponse` | `false` | 接受任何没有匹配工具调用的回复，无论是否带有文本 |
| `substituteMacros` | `false` | 替换任务消息中的宏；编辑含宏源文本的工作台保持关闭 |
| `toolChoice` | `'auto'` | 发送给服务商的工具选择 |
| `requiredFunctionName` | `''` | 要求服务商调用的函数 |
| `reservedToolCallIds` | `null` | 会话已占用的工具调用 id 集合。设置后，返回调用的 id 若已被占用、已出现在 `taskMessages` 中或在同一回复内重复，则替换为新 id。 |
| `rpmBucket` | `'default'` | RPM 计数窗口；传入相同键的调用方共用同一窗口 |
| `logLabel` | `'orchestrator'` | 重试警告的前缀 |
| `isControlCall` | `null` | `(call) => boolean`；匹配的调用交给 `onControlCall` |
| `onToolCall` | `null` | `(call)`，按顺序逐个接收非控制调用 |
| `onControlCall` | `null` | `(call)`，逐个接收控制调用 |
| `onAssistantText` | `null` | `(text)`，在成功且文本非空的尝试后调用 |
| `onUsage` | `null` | `(usage)`，传入服务商返回的 token 用量 |
| `onFirstChunk` | `null` | `()`，在尝试收到首个流式片段时调用 |

回调在校验之后、Promise 解析之前执行。回调抛出的异常只记录日志，不会导致请求失败。

Promise 解析为 `{ name, args, id, raw }` 数组；传入 `includeAssistantText: true` 时解析为 `{ toolCalls, assistantText, rawAssistantText, reasoning, reasoningBlocks, reasoningDetails }`。`tools` 为空、缺少 `context.generateTask`、回复没有匹配的工具调用且 `allowNoToolCalls` 与 `allowEmptyResponse` 均不接受，或末次重试仍未通过校验时，Promise 拒绝。

### 持久化工具调用消息

工作台会话以 OpenAI 格式的 `tool_calls` 与 `tool_results` 存储 assistant 轮次，后续轮次据此回放聊天补全历史。

| 成员 | 行为 |
| --- | --- |
| `buildPersistentToolCallsFromRawCalls(rawCalls = [])` | 将 runner 调用 `{ name, args, id }` 转为 `{ id, type: 'function', function: { name, arguments } }`。工具名中的点号替换为下划线，缺失的 id 自动生成，丢弃缺少名称的调用。 |
| `buildExecutionToolCalls(rawCalls = [])` | 执行同样的转换，返回带已解析参数的 `{ id, name, args }`。 |
| `buildPendingToolResults(toolCalls = [], summaryText = '')` | 为各调用返回 `{ tool_call_id, content }`；`content` 为 `{ ok: true, pending: true, summary }` 的 JSON，`summary` 默认为 `Pending review.` |
| `createPersistentToolTurnMessage({ messageId, assistantText, toolCalls, toolResults, toolSummary, toolState, auto, at, extra })` | 构建存储用的 assistant 消息 `{ id, role, content, auto, at, tool_calls, tool_results }`，`toolSummary` 与 `toolState` 非空时一并写入，并合并 `extra` 的字段。`toolCalls` 采用存储格式；丢弃 `tool_call_id` 无对应调用的结果。 |
| `buildPersistentToolHistoryMessages(messages = [])` | 将同时带调用与结果的存储消息展开为历史：先是带 `tool_calls` 的 assistant 消息，再是各结果对应的 `tool` 消息。 |
| `collectIterToolCallIds(messages = [])` | 返回消息中全部工具调用 id 的 `Set`，读取 `toolCalls`、`tool_calls`、`toolResults` 与 `tool_call_id`。返回值用作 `reservedToolCallIds`。 |
| `makeAiIterationMessageId(prefix = 'orch_msg')` | 返回 `<prefix>_<time>_<random>`。 |

Layer 1 模块 `/scripts/lib/iter-tool-calling.js` 另外导出：

| 成员 | 行为 |
| --- | --- |
| `normalizeToolCallRetryMax(value, fallback)` | `null`、`undefined` 与空白字符串返回 `fallback`，其余值取整并限制为不小于 `0`；非数值返回 `fallback` |
| `serializeToolResultContentPreferText(result)` | `result.toolResultText` 为非空字符串时原样返回，否则将 `result` 转为字符串或缩进格式的 JSON |

### `runner.abortUtils`

| 成员 | 行为 |
| --- | --- |
| `isAbortSignalLike(value)` | 对象带 `aborted` 属性时为 `true` |
| `isAbortError(error, abortSignal = null)` | 信号已中止、错误名为 `AbortError` 或错误消息提及 abort 时为 `true` |
| `isStrictAbortError(error, signal = null)` | 错误名为 `AbortError` 或信号已中止时为 `true`，不检查错误消息 |
| `createAbortError(message = 'Operation aborted.')` | 返回名为 `AbortError` 的 `DOMException`；环境缺少 `DOMException` 时返回同名 `Error` |
| `throwIfAborted(abortSignal, message = 'Operation aborted.')` | 信号已中止时抛出 `createAbortError(message)` |
| `linkAbortSignals(...signals)` | 返回 `{ signal, cleanup }`。任一输入中止时 `signal` 随之中止，`cleanup()` 移除监听。没有有效输入时 `signal` 为 `null`，仅有唯一输入时即为该信号。 |
| `raceAbortSignal(promise, signal)` | 随 `promise` 落定；`signal` 一旦中止即以中止错误拒绝。原 Promise 继续运行。 |

## textDiff

| 成员 | 行为 |
| --- | --- |
| `renderInlineTextDiffHtml(beforeValue, afterValue, options = {})` | 返回包含逐行逐词并排 diff 的 `<details>` 块，全部文本均经 HTML 转义。选项：`fileLabel` 为全屏查看的标题；`i18n` 为翻译函数；`expandAffordance: false` 隐藏展开按钮；`forceOpen: true` 默认展开。末位参数为字符串时视作 `fileLabel`。调用时注入样式表。 |
| `renderInlineTextDiffElement(beforeValue, afterValue, options = {})` | 将 `renderInlineTextDiffHtml` 生成的 `<details>` 块解析为 DOM 元素并返回，参数与选项完全一致。 |
| `ensureStylesheetInjected()` | 注入 diff 样式表 `<link>`，重复调用不重复注入 |
| `STYLESHEET_ID`、`STYLESHEET_HREF` | 该 `<link>` 的 id 与地址 |
| `sanitizeDiffPlaceholderValue(value)` | 空文本与英文、简体中文、繁体中文的 `Not set` 占位符返回 `''`，其余文本原样返回 |
| `formatDiffValue(value)` | 与 `sanitizeDiffPlaceholderValue` 相同 |

## zoomOverlay

| 成员 | 行为 |
| --- | --- |
| `attachZoomOverlay(popupRoot, options = {})` | 在 `popupRoot` 下绑定委托事件，`popupRoot` 可为元素、jQuery 对象或选择器；没有 id 的元素会被分配 id。点击 `[data-luker-lib-action="expand-line-diff"]` 全屏打开 diff；关闭按钮、背景遮罩与 Esc 关闭全屏；拖动 `.luker_lib_diff_splitter` 调整分栏。`options.namespace` 为 jQuery 事件命名空间，默认值 `.luker_lib_diff`；以相同命名空间再次绑定会替换先前的绑定，各弹窗应传入各自的命名空间。`options.i18n` 翻译全屏界面的文字。返回解绑函数。 |
| `openExpandedDiff(rootElement, triggerElement, options = {})` | 在 `rootElement` 内全屏打开包含 `triggerElement` 的 diff |

## ui

### `ui.message`

`renderMessageCard(message, opts = {})` 返回单条对话消息的 HTML。消息字段：`id`、`role`，取值 `'user'`、`'assistant'` 或 `'system'`，以及 `content`、`toolCalls`、形如 `{ tool_call_id, content, status }` 的 `toolResults`、`edits`、`appliedAt`、`appliedTarget`、`rolledBackAt`、`auto` 和推理字段 `reasoning`、`reasoningBlocks`、`reasoningDetails`。

| 选项 | 用途 |
| --- | --- |
| `toolDisplay` | `{ [toolName]: { icon, label, type, summarize } }`。`type` 取 `'read'`、`'edit'` 或 `'control'`；`label` 为英文源字符串，渲染时经 `i18n` 翻译；`summarize(args, result, i18n)` 返回单行摘要。 |
| `renderEditCard` | `(edit, message) => html`，逐项处理 `message.edits` |
| `renderApplyControls` | `(message) => html`，置于编辑卡片与重新生成按钮之间 |
| `renderMarkdown` | `(text) => html`；未提供时文本经转义输出 |
| `i18n` | `(template, ...args) => string`，占位符形如 `${0}` |
| `actionAttribute` | 按钮使用的属性名，默认 `data-luker-lib-action` |

按钮通过该属性携带 `regenerate` 或 `edit-user-message`，并附带 `data-luker-lib-msg-id`。带 `auto: true` 的用户消息与无可显示内容的 assistant 消息渲染为 `''`。

`bindChainBrokenBanner(root, bus, opts = {})` 监听 bus 的 `bus:chain-broken` 事件，禁用 `root` 内的 `[data-iter-input]` 并追加经 `opts.translate` 翻译的横幅。返回解绑函数。

### `ui.diff`

`renderDiffCard(input, opts = {})`：

- `input` 为编辑数组时，返回逐条编辑渲染的卡片 HTML 字符串。
- `input` 为 ProposalBus 条目 `{ target, inverse }` 时，返回 `Promise<string>`：通过目标注册表读取当前值，还原提案时的值并渲染改动；还原失败时渲染原始记录。

| 选项 | 用途 |
| --- | --- |
| `fieldLabels` | 字段路径到显示标签的映射 |
| `includeRawArgs` | 在卡片下附带原始参数 |
| `live` | 字符串类编辑据以解析路径的值；待审编辑应传入 |
| `i18n`、`translate` | 翻译函数 |

### `ui.ensureUiStylesheetInjected()`

注入共享的 `luker_lib_*` 样式表并安装推理块复制按钮的处理函数，重复调用不重复注入。

## tools

各工具命名空间提供工具名、可拼入工作台工具目录的 OpenAI 风格定义、判定函数与执行器。执行器接收 runner 调用 `{ id, name, args }`，解析为 `{ ok: true, result }` 或 `{ ok: false, error }`。`runCharacterPresetReadTool` 的全部失败结果、`runLorebookReadTool` 执行期间抛出的失败结果，以及世界书写入与技能执行器因参数或目标出错的失败结果，另带状态错误码 `reason` 与简短的 `hint`，错误码如 `VALIDATION_ARGS`、`CONFLICT`。

### `tools.lorebookReads`

| 成员 | 行为 |
| --- | --- |
| `LOREBOOK_READ_TOOL_NAMES` | `world_book_list`、`lorebook_list`、`lorebook_query`、`lorebook_get` |
| `LOREBOOK_READ_TOOL_DEFS` | 工具定义 |
| `isLorebookReadTool(name)` | 判定函数 |
| `runLorebookReadTool(call, { context, avatar = '' })` | 执行调用；`avatar` 指定 `world_book_list` 列出哪个角色的世界书 |

### `tools.lorebookWrites`

| 成员 | 行为 |
| --- | --- |
| `LOREBOOK_WRITE_TOOL_NAMES` | `lorebook_update_entry`、`lorebook_str_replace_in_entry` |
| `LOREBOOK_WRITE_TOOL_DEFS` | 工具定义 |
| `isLorebookWriteTool(name)` | 判定函数 |
| `runLorebookWriteTool(call, { context })` | 计算提案 `{ book_name, uid, kind, before, after, ... }`，不写入；`before` 与 `after` 为完整条目 |

工作台以 `lorebookWrite` kind 与目标 `{ type: LOREBOOK_ENTRY_TARGET_TYPE, name: book_name, uid }` 将结果提交到 ProposalBus，由世界书条目目标写入已批准的条目。

### `tools.characterPresetsReads`

| 成员 | 行为 |
| --- | --- |
| `CHARACTER_PRESET_READ_TOOL_NAMES` | `inspect_bound_preset` |
| `CHARACTER_PRESET_READ_TOOL_DEFS` | 工具定义 |
| `isCharacterPresetReadTool(name)` | 判定函数 |
| `runCharacterPresetReadTool(call, { context, avatar = '' })` | 列出或读取角色卡内嵌的预设；`avatar` 默认为当前角色 |

### `tools.skillIterStudio`

| 成员 | 行为 |
| --- | --- |
| `SKILL_ITER_STUDIO_TOOL_NAMES`、`SKILL_ITER_STUDIO_TOOL_DEFS` | 技能清点、编写、策略与迁移工具 |
| `isSkillIterStudioTool(name)` | 判定函数 |
| `runSkillIterStudioTool(call, mutationCtx = {})` | 解析为 `{ ok: true, result }`；修改工作 profile 时解析为 `{ ok: true, result, pendingEdit }`；编写提案时解析为 `{ ok: true, result, pendingSkillEdit }`；失败时解析为 `{ ok: false, error }`。`mutationCtx.getWorkingProfile()` 返回策略类与拼接类工具修改的 profile；`mutationCtx.defaultScope` 为调用省略 `scope` 时使用的技能作用域，未设置时使用全局作用域。 |
| `commitApprovedSkillProposal(op)` | 将已批准的编写操作 `{ name, args }` 重新应用到磁盘上的技能。失败时抛出错误。校验失败抛出 `SkillProposalError`；`SKILL.md` 缺失，或技能在提案后于磁盘上发生变化导致服务端拒绝写入时，抛出 `reason` 为 `CONFLICT` 的 `SkillProposalError`。技能 API 的其他错误原样抛出。 |
| `SkillProposalError` | 带 `reason` 与 `hint` 的错误 |
| `applyFrontmatterPatch(content, patch)` | 返回写入补丁键后的 SKILL.md 内容；值为 `null` 时删除该键 |
| `buildSkillVisibilityChange(beforeProfile, afterProfile, { kind, agentId, list })` | 描述策略修改如何改变某个模式或 agent 的可见与禁用技能 |
| `ensureSkillRegistryTarget()` | 注册 ProposalBus 目标 `skill-registry`，重复调用不重复注册。目标地址为 `{ type: 'skill-registry', name, path, _op }`；批准时通过 `commitApprovedSkillProposal` 重新执行 `_op` 完成写入。 |

### `tools.ctxAndDocsDiscovery`

只提供执行器，不附带工具定义，工具名与 schema 由调用方决定。失败时解析为 `{ ok: false, error }`。

| 成员 | 行为 |
| --- | --- |
| `listCtxKeys({ filter = '' } = {})` | 返回顶层 context 键 `{ ok, count, keys: [{ key, type }] }` |
| `describeCtxPath({ path })` | 按点分路径描述：函数给出类型、参数个数与预览，对象给出键，标量给出值 |
| `listLukerDocs({ filter = '', includeTranslations = false, fetchImpl = null } = {})` | 返回 `{ ok, count, totalCount, hiddenTranslations, files }`；默认隐藏译文 |
| `readLukerDoc({ path, fetchImpl = null })` | 返回 `docs/` 下单篇文档的 `{ ok, path, size, content }` |

## proposalBus

ProposalBus 保存工作台 AI 提出的修改，直至用户批准、拒绝或回滚。条目存储其改动的正向与逆向 JSON 补丁，读写经由目标处理器完成；写入前，bus 核对改动涉及的路径仍为预期值，不一致时条目进入 `conflict` 状态。

### 工厂与 kind 描述符

| 成员 | 行为 |
| --- | --- |
| `createProposalBus({ i18n, onChange, onCommitted } = {})` | 挂载弹窗时创建专属 bus。变更后调用 `onChange()`；正向写入成功后调用 `onCommitted(entry)`。 |
| `profileEdit`、`lorebookWrite`、`skillAuthor`、`presetClone`、`customToolAuthor` | kind 描述符 `{ kind, targetType }`，取值见下表 |
| `createProfileEditHandler()`、`createLorebookWriteHandler()`、`createSkillAuthorHandler()`、`createPresetCloneHandler()`、`createCustomToolAuthorHandler()` | 返回对应描述符 |

| 描述符 | `kind` | `targetType` | 回滚 |
| --- | --- | --- | --- |
| `profileEdit` | `profile-edit` | `profile` | 支持 |
| `lorebookWrite` | `lorebook-write` | `orch-lorebook` | 支持 |
| `skillAuthor` | `skill-author` | `skill-registry` | 不支持 |
| `presetClone` | `preset-clone` | `preset` | 不支持 |
| `customToolAuthor` | `custom-tool-author` | `orch-custom-tool` | 不支持 |

工作台通过 `bus.registerKind(kind, handler)` 注册各 kind，重复注册同一 kind 时抛出错误。处理器在描述符基础上补充卡片渲染函数 `icon(entry)`、`label(entry)`、`target(entry)` 与 `renderDiffCard(entry, { escapeHtml, formatTime, i18n })`，供 `renderCardsForMessage` 调用。处理器带 `inverseAvailable: false` 时，该 kind 已提交的条目不可逆：`rollback` 拒绝回滚，批量回滚方法跳过这些条目。

### 目标

目标通过 Layer 1 模块 `/scripts/iteration-library/storage/target-registry.js` 注册。

| 成员 | 行为 |
| --- | --- |
| `registerTarget(type, { read, write, describe })` | `read(target)` 返回当前值，`write(target, next)` 写入值，`describe(target)` 返回显示名称。再次注册同一类型时替换原处理器。 |
| `hasTarget(type)` | 判断 `type` 是否已注册处理器 |
| `resolveTarget(target)` | 返回 `target.type` 对应的处理器；未注册时抛出 `UnknownTargetError` |

Layer 1 模块 `/scripts/iteration-library/proposal-bus/targets/lorebook-entry.js` 提供 `lorebookWrite` kind 的目标：

| 成员 | 行为 |
| --- | --- |
| `LOREBOOK_ENTRY_TARGET_TYPE` | 世界书条目提案的目标类型 `'orch-lorebook'`；目标地址为 `{ type, name, uid }` |
| `ensureLorebookEntryTarget(context)` | 注册世界书条目目标，重复调用不重复注册，并绑定提供 `loadWorldInfo` 与 `saveWorldInfo` 的 `context`；再次调用时改为绑定新的 `context` |

### bus 方法

| 方法 | 行为 |
| --- | --- |
| `propose({ kind, target, before, after, sourceCallId, meta })` | 添加 `pending` 条目，解析为 `{ id, target }`。kind 或目标未知、`target.type` 与 kind 的 `targetType` 不一致时抛出错误。 |
| `approve(id)` | 写入 `pending` 或 `conflict` 条目，解析为 `{ ok, status }`。成功时 `status` 为 `committed`；检测到外部改动或写入失败时条目转为 `conflict`，结果另带 `reason`、`hint` 与 `error`。 |
| `reject(id)`、`reset(id)` | `pending` 或 `conflict` → `rejected`；`rejected` → `pending` |
| `rollback(id)` | 恢复 `committed` 条目写入前的值并转为 `rolledBack`。检测到外部改动或写入失败时条目转为 `conflict` 并派发 `bus:rollback-failed`；不可逆条目解析为 `{ ok: false, status, reason: 'not_reversible' }`。 |
| `forceDiscard(id)` | `conflict` → `rolledBack`，不写入 |
| `exportRecord(id)` | 派发携带条目目标与逆向补丁的 `bus:export-record` |
| `approveAllPendingInTurn(message)`、`rejectAllPendingInTurn(message)`、`rollbackAllInTurn(message)` | 处理 `sourceCallId` 属于 `message.toolCalls[].id` 的条目 |
| `rollbackAllInMessages(messages)` | 由新到旧回滚这些消息中可逆的已提交条目，首次失败即停止，解析为 `{ results, ok, failedAt }` |
| `countCommittedInMessages(messages)` | 这些消息中可逆的已提交条目数 |
| `hasOutstanding()` | 判断是否存在 `pending` 条目 |
| `listPending()` | 返回待审条目 `[{ id, sourceCallId }]` |
| `listEntries()` | 按提案顺序返回全部条目的浅拷贝，包含 `id`、`kind`、`status`、`target`、`sourceCallId`、`meta`、`conflictError` 与时间戳 `createdAt`、`decidedAt`、`committedAt`、`rolledBackAt` |
| `discardEntries(ids)` | 将匹配的 `pending` 或 `conflict` 条目标记为 `rejected` 而不调用 `onChange`，移除匹配的待读取结果，并返回 `{ rejected, prunedOutcomes }` |
| `getCurrentPendingState(kind, target)` | 返回叠加该 kind 待审提案后的 `target` 当前值；提案无法叠加时派发 `bus:chain-broken` |
| `drainOutcomes()` | 返回并清空自上次读取以来的处理结果 |
| `serialize()`、`hydrate(data)` | 会话持久化；序列化结果带 `version: 3`。经 `hydrate` 恢复的待审条目可直接批准。 |
| `setAutoApprove(enabled)`、`isAutoApprove()` | 新提案加入后立即批准 |
| `renderCardsForMessage(messageOrCallId)` | 返回消息或工具调用 id 对应的提案卡片 HTML |
| `renderTurnActions(messageOrCallId)` | 返回批量批准、拒绝与回滚按钮的 HTML |
| `handleClick(event)`、`setMessageResolver(fn)` | 分发 `[data-proposal-action]` 上的点击，其他点击令 `handleClick` 解析为 `false`；`fn(messageId)` 返回批量操作所针对的消息 |
| `events` | 派发 `bus:chain-broken`、`bus:rollback-failed` 与 `bus:export-record` 的 `EventTarget` |

## 工作区辅助函数

| 成员 | 行为 |
| --- | --- |
| `bindIterWorkspaceResizer(workspaceRoot)` | 允许拖动 `workspaceRoot` 内的 `.luker-iter-workspace-resizer` 调整 `.luker-iter-workspace-grid` 的分栏，分栏比例不保存。返回解绑函数。 |
| `createRenderScheduler({ handler, frameRequester, onError })` | 仅 Layer 1 提供。返回 `{ schedule, flush, dispose }`：连续的 `schedule()` 合并为下一动画帧内的 `handler()` 调用，`flush()` 立即执行已排定的调用，`dispose()` 取消待执行的任务。`onError(err)` 接收 `handler` 抛出的错误。 |

## 参考消费方

- **工作台迭代目标** —— `public/scripts/workbench/targets/`、`orchestrator/lens/iterate-target.js` 与 `memory-graph/lens/iterate-targets.js` 复用 `proposalBus`、`tools` 与 `runner` 辅助能力，同时由工作台统一托管窗口、目标切换和改动记录。
- **CardApp Studio** —— `public/scripts/extensions/character-editor-assistant/studio/` 自行管理独立全屏开发环境，并调用 `iterationLibrary` 处理工具重试、世界书与检索工具、差异渲染及 `edits-lib` 应用与回滚。

## 相关页面

- [工作台 API](/zh-CN/development/extension-api/workbench) —— 向工作台注册 AI 迭代目标
- [Edits 库](/zh-CN/development/extension-api/edits-lib) —— 基于 op 的补丁引擎与冲突解决
