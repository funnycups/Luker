# 迭代工作台框架

一个共享的弹窗外壳，用于 **AI 驱动地迭代式编辑由适配器提供的工件**。外壳负责对话、工具分发、感知漂移的应用、历史列表和批准 / 拒绝 UI；插件通过适配器提供"编辑什么、哪些工具能提出变更、会话存储在哪"。

仓库内有两份参考适配器：

- `public/scripts/extensions/orchestrator/iteration-adapter.js` —— 编辑编排器 profile（spec / agenda / loop）
- `public/scripts/extensions/memory-graph/schema-adapter.js` —— 编辑记忆图节点类型 schema

本页是契约和构建自己适配器的 walkthrough。

## 它是什么

一个迭代工作台会话，是用户与 LLM 之间的弹窗对话，LLM 输出**描述编辑动作的工具调用**。每一轮：

1. 用户输入请求并点击发送。
2. 外壳带着适配器的工具集（外加适配器自己声明的任何控制工具）请求 LLM。
3. 对每个返回的工具调用，适配器将其归一化为一组 op 类型化的 `Edit`（见 [edits-lib](./edits-lib.md)）。
4. 外壳通过 edits 库把编辑应用到 `adapter.live()`，在应用时逐条做漂移检测。
5. 批准的变更通过 `adapter.commit(newLive)` 提交回去。
6. 只要这一轮发出过任何工具调用，外壳就会自动续到下一轮（程序按工具调用是否存在判定）。一旦 AI 改回纯文本、不再发工具，迭代就结束，控制权回到用户。

外壳不持有工件的工作副本。`adapter.live()` 是唯一权威源，外壳每次需要当前值时都重新调用它。

**迭代工作台不合适的时候：** 如果你的界面需要 viewport 所有权（全屏 IDE、移动端接管），或者已经有一套成熟的独立 UI 想保留，直接用 [edits-lib](./edits-lib.md) —— 从 `/scripts/lib/edits/index.js` import `applyEdits` / `inverseEdit` / `showConflictResolution`，自己控制 UI。CardApp Studio（`extensions/character-editor-assistant/studio/`）是仓库内的参考实现。

## 快速上手：最小适配器

```js
import { defineAdapter, openIterationStudio } from '/scripts/iteration-studio/index.js';

const TOOL_SET = 'mything_set_value';

export function createMyThingAdapter({ readValue, writeValue, listMetas, loadMeta, saveMeta, deleteMeta }) {
    return defineAdapter({
        id: 'mything',
        title: 'My Thing Studio',
        mode: 'mything',
        layout: 'popup',
        i18n: (s) => s,
        i18nFormat: (s, ...args) => args.reduce((out, v, i) => out.split('${' + i + '}').join(String(v)), s),

        live: () => readValue(),
        commit: async (newLive) => { await writeValue(newLive); },
        sessionScope: () => 'global',

        listSessions: async () => listMetas(),
        loadSession: async (_scope, id) => loadMeta(id),
        saveSession: async (_scope, session) => saveMeta(session),
        deleteSession: async (_scope, id) => deleteMeta(id),

        buildSystemPrompt: () => 'You edit a single string. Call mything_set_value with the new value.',
        buildUserPrompt: (session, userText) => `[Current]\n${readValue()}\n\n[Request]\n${userText}`,

        buildToolCatalog: () => [{
            type: 'function',
            function: {
                name: TOOL_SET,
                description: 'Set the value.',
                parameters: {
                    type: 'object',
                    properties: { next: { type: 'string' } },
                    required: ['next'],
                    additionalProperties: false,
                },
            },
        }],
        normalizeToolCallToEdit: (call) => {
            if (call?.name !== TOOL_SET) return null;
            const next = String(call?.args?.next ?? '');
            return [{ op: 'set', path: '', oldValue: readValue(), newValue: next }];
        },

        renderMessageCard: (message) => `<div>${message.role}: ${message.content}</div>`,
        renderHistoryItem: (meta) => `<div>${meta.title}</div>`,
    });
}

await openIterationStudio(adapter, SillyTavern.getContext(), settings, document.body);
```

这就是完整适配器。外壳负责弹窗外观、对话渲染、历史列表、自动续写、abort 接线、LLM 重试 / 超时、感知漂移的应用、冲突 UI 和回滚。

## 权威模型

`adapter.live()` 是唯一可信来源。

- 外壳不缓存工作 profile。每次渲染和每次应用都重新调用 `live()`。
- `adapter.commit(newLive)` 是唯一写入路径。适配器决定写到哪里（扩展设置、角色状态、IndexedDB、远程 API 都行）。
- 漂移检测**在应用时逐条**通过 edits 库进行。若用户在 LLM 提案与点击批准之间从外部修改了工件，冲突会通过 `edits-lib` 标准冲突 UI 暴露出来。
- 回滚把消息上 `appliedEdits` 数组逆序送入 `inverseEdit(edit)`，再重新提交。

这意味着工件随时可以在工作台之外被编辑。工作台只是众多编辑器中的一个。

## 工具分发

`buildToolCatalog(session)` 返回适配器自己的可编辑工具加上自定义控制工具。外壳不再注入 continue / finalize 控制工具——多轮自动续轮由程序判定：这一轮发出过任意工具调用就续到下一轮，只回纯文本不调工具就停下来。如果你的适配器需要 popup 侧控制工具（比如重置状态、切模式），自行在 catalog 里声明，通过 `classifyToolCall` / `executeControlToolCall` 走和普通适配器特定控制工具一样的路径。

每个 LLM 工具调用先经过 `classifyToolCall(call)`（默认：不匹配适配器声明的控制名的都是可编辑）。可编辑调用进入：

```ts
normalizeToolCallToEdit(call, { session, live }): Edit[] | null | Promise<Edit[] | null>
```

返回 op 类型化编辑（op 形态见 [edits-lib](./edits-lib.md)）。返回 `null` 跳过此调用。

**sandbox-diff 模式** —— 当你已经有一个原地变更器时，这是快速 bootstrap 的方式：

1. 把 `live` 克隆成一个 sandbox profile。
2. 在 sandbox 上跑现有变更器。
3. 发射一条粗粒度的 `{ op: 'set', path: '', oldValue: live, newValue: sandbox }` 编辑。

两个参考适配器都用此模式。它足够上线，但产出 profile 级冲突（任何并发变更都会与整批冲突）。要做生产级冲突解决，应当把每个工具调用归一化成逐字段 op（`set` / `str_replace` / `list_insert` 等）。

适配器声明的控制工具（重置、切模式等）通过 runner 的 `isControlCall` 谓词路由到你的 `onControlCall` 处理函数，不走 normalize-to-edit 路径。外壳把它们也算成"这一轮有工具调用"——任意控制工具发射都会触发下一轮。

## Runner 设置

Runner 有三项影响每次 LLM 往返的旋钮——重试次数、每分钟请求数上限、流式传输。适配器通过 `getRunnerSettings` 接入：

```ts
getRunnerSettings(settings): RunnerSettings | null
```

`settings` 是你传给 `openIterationStudio` 的那个对象。返回形状：

```ts
type RunnerSettings = {
    toolCallRetryMax?: number;       // 默认 0——工具调用畸形/缺失时的重试次数
    rpmLimit?: number;               // 默认 0——iteration-studio 共享的 RPM 上限（0 表示不限）
};
```

返回 `null` / `undefined` / `{}` 即采用全部默认值。外壳不会直接读取你的 settings 字段——只走这一个 hook。这样每个适配器可以自由暴露自己的设置 UI（CPA 两项都暴露；CardApp Studio 都不暴露），外壳不需要知道你的存储路径。底层传输（SSE / 一次性 POST）由 `generateTask` 依解析后预设的 `stream_openai` 决定，适配器不需要再暴露相应开关。

## 会话存储

适配器拥有会话持久化。四个钩子：

```ts
listSessions(scope): Promise<SessionMeta[]>           // 最新在前
loadSession(scope, id): Promise<Session | null>
saveSession(scope, session): Promise<void>
deleteSession(scope, id): Promise<void>
```

`scope` 即 `sessionScope()` 的返回值。常见样式：`'global'`、`'character_<avatar>'`、`'chat_<chatId>'`。

会话存到哪完全由你决定。典型模式：

- 全局 → 扩展设置桶：`extension_settings.my_extension.iterStudioSessions`
- 按角色 → `context.getCharacterState(avatar, 'my_ext_iter_sessions')`
- 按聊天 → chat metadata

会话形状由外壳定义（见 `public/scripts/iteration-studio/adapter.js` 的 JSDoc typedef）。适配器可以把任意 blob 数据塞到 `session.surfaceState`。

## 布局选择

`layout: 'popup' | 'split'`。

- `'popup'` —— 单列对话。输入区与历史是堆叠的。适合工件预览很短、或 diff 已经放在消息卡里的适配器。
- `'split'` —— 双列对话 + 预览面板。右侧面板由 `renderPreviewPane(state)` 渲染。适合工件具有有意义的规范视图（图 schema、profile 树、角色卡）、用户希望与对话同时可见的场景。

外壳调用的插槽钩子：

| 钩子 | 何时 | 必需 |
|---|---|---|
| `renderMessageCard(message, state)` | 每条对话消息 | 是 |
| `renderHistoryItem(meta)` | 历史列表的每个会话 | 是 |
| `renderPreviewPane(state)` | `split` 布局的右侧面板 | `split` 必需 |
| `renderToolbarSlots(state)` | 工具栏额外 `{start, end}` HTML | 可选 |
| `handleAction(actionId, ctx)` | 弹窗内 `[data-iter-custom-action="<id>"]` 的任何点击或 change | 可选 |

## 预览面板

`renderPreviewPane(state) => string` 为 `split` 布局返回右侧面板的 HTML。外壳每次 rerender（每次聊天 tick、busy 状态切换、AI 工具调用等）都会整体替换预览面板。适合：字段摘要、tab 占位、只读 diff 列表。如果适配器持有需要在 rerender 之间存活的控件状态（CodeMirror、图表等），那块界面应该放在迭代工作台外壳之外 —— 直接用 [edits-lib](./edits-lib.md)。

## 对比基准

适配器可以提供"与...对比"选择器，从别处拉取一份快照与实时数据并排渲染。两个钩子：

```ts
listReferences(session): { id: string, label: string }[]
loadReference(id): Promise<any>
```

外壳在工具栏显示下拉菜单，用户选择时调 `loadReference(id)`，结果通过 `state.reference` 传给渲染钩子。两个都省略则整个选择器隐藏。

## 自定义 op

外壳每次调用 `openIterationStudio()` 时会触发一次 `adapter.registerCustomOps?.(registry)`。`registry` 是对 edits-lib 引擎 `registerOp` 的封装，带 `getRegisteredOp` 守卫，所以重新打开弹窗不会重复注册（也不会因重复注册而失败）。需要 schema 专属 op 的适配器在这里注册。

示例 —— CEA 的世界书条目自定义 op：

```js
import {
    createLorebookEntryAddOp,
    createLorebookEntryUpdateOp,
    createLorebookEntryRemoveOp,
} from './lorebook-ops.js';

registerCustomOps: (registry) => {
    registry.registerOp('lorebook_entry_add', createLorebookEntryAddOp());
    registry.registerOp('lorebook_entry_update', createLorebookEntryUpdateOp());
    registry.registerOp('lorebook_entry_remove', createLorebookEntryRemoveOp());
},
```

每个 handler 实现 `{ apply, inverse, detectConflict }` —— 完整 op 契约见 [edits-lib](./edits-lib.md)。当条目以非数组下标的方式（如世界书 `uid`）作为键时使用自定义 op；这种场景下内置 `list_*` op 会在重排序时悄然漂移。

## 迁移：clearObsoleteSessions

```ts
clearObsoleteSessions?(scope): Promise<void>
```

一个一次性钩子，外壳在升级后首次打开时按适配器调用一次。用它清掉旧的 v1 存储 key（外壳在 localStorage 中记录按适配器的清理标记，因此只跑一次）。两个参考适配器都实现了它，用来丢掉 v1 历史桶：

```js
clearObsoleteSessions: async () => {
    const root = getMySettings();
    if (root && Object.prototype.hasOwnProperty.call(root, LEGACY_GLOBAL_HISTORY_KEY)) {
        delete root[LEGACY_GLOBAL_HISTORY_KEY];
        persistSettings();
    }
}
```

无需迁移则省略该钩子。

## 三层 API 暴露

按 Luker API 约定，外壳每个能力都在三层暴露 —— 与 `edits-lib` 一致：

```js
// Layer 1 —— 直接 ESM import（仓库内扩展）
import { openIterationStudio, defineAdapter } from '/scripts/iteration-studio/index.js';

// Layer 2 —— lukerContext 属性（持有 context 的 CardApp / 扩展代码）
const { openIterationStudio, defineAdapter } = lukerContext.iterationStudio;

// Layer 3 —— getContext（第三方扩展）
const { open, defineAdapter } = SillyTavern.getContext().iterationStudio;
```

Layer 3 表面重新导出与 Layer 1 相同的函数；`open` 是 `openIterationStudio` 的短别名。

## 参考适配器

阅读这些文件可以看到契约的端到端样例：

- `public/scripts/extensions/orchestrator/iteration-adapter.js` —— 用 sandbox-diff 模式包裹编排器既有的变更器。布局 `split`、按 mode 分桶的会话、运行时 world-info 解析、自定义控制工具名。
- `public/scripts/extensions/memory-graph/schema-adapter.js` —— 直接基于 v2 契约构建的节点类型 schema 编辑器。布局 `split`、仅全局会话、预览面板里有"应用到全局" /"应用到角色"动作按钮。
- **CEA 角色编辑器** —— `public/scripts/extensions/character-editor-assistant/character-editor-adapter.js`，布局 `split`、按角色范围 `char_<avatar>`。实时数据结构为 `{ card, lorebook: { bookName, entries: { [uid]: entry } } }`。通过 `mergeCharacterAttributes` 编辑角色卡字段，通过 `context.saveWorldInfo` 编辑世界书。注册 3 个以条目 uid 为键的自定义 op（`lorebook_entry_add / update / remove`）。
- **CPA（补全预设助手）** —— `public/scripts/extensions/completion-preset-assistant/cpa-iteration/`（studio 通过 `openCpaIterationStudio` 自挂为 popup，独立于分层 `iterationStudio` open / defineAdapter 契约）。按预设范围 `preset_<name>`。实时目标是用户当前选中的 OpenAI 预设（通过 `context.presets.get`）；`commit()` 通过 `context.presets.save(..., { select: true })` 写回。工具集为 15 个可编辑预设操作 + 5 个只读检查工具 + 12 个 Skills 编写工具（清单 + 写入 + 逐字抽取，仅在会话模式为 `orchestrator-optimize` 时暴露，直接复用编排器侧 `skill-iter-studio-tools.js` 的注册表）。无预览面板——聊天中的每条消息编辑摘要即为差异展示。

适配器契约 JSDoc 位于 `public/scripts/iteration-studio/adapter.js` —— 该文件是必需 vs 可选字段与精确签名的规范来源。
