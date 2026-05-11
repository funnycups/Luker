# IterationStudio

一个共享的弹窗框架，用于 **AI 驱动地迭代式编辑一个典型工件**。Studio 负责对话、会话历史、工具分发、diff 预览、批准 / 拒绝生命周期；插件通过 adapter 提供"工件长什么样、哪些工具能编辑、怎么持久化"。

仓库内有两份参考实现：

- `public/scripts/extensions/orchestrator/iteration-adapter.js` — 编辑编排器 profile（spec / agenda / loop）
- `public/scripts/extensions/memory-graph/schema-adapter.js` — 编辑记忆图节点类型 schema

本页是契约和构建你自己 adapter 的 walkthrough。

## 心智模型

Shell 拥有**工作台外壳** —— 跨所有 studio 通用的部分：

- popup 生命周期（打开 / 关闭、abort 接线、焦点）
- 对话面板（user / assistant 消息、pending 审批块）
- 输入区（textarea + 发送 / 终止 / 清空 / Auto-apply 开关）
- 工具调用 round trip（通过 `context.generateTask` 调 LLM，带重试 / RPM / 超时）
- 工具调用拆分（editable vs control）、pending vs 自动执行
- Auto-continue（AI 标记 `continueRequested` 时）
- Auto-apply（按 adapter 持久保存的偏好，跳过审批步骤）
- 会话历史列表 + 新建 / 加载 / 删除
- profile delta 计算（jsondiffpatch）和渲染（自带文本 diff + 放大 + 拖拽分栏）

Adapter 拥有**工件** —— 每个 studio 独有的部分：

- `workingProfile` 的形状（clone + sanitize）
- 初始 profile（从当前设置 / 角色卡覆写读出）
- prompt 构建（system + user + 可选的 auto-continue）
- 工具集 + 每个工具的执行（mutate `session.workingProfile`）
- 右侧"工作 profile"预览面板（HTML）
- 持久化（会话历史的存储路径 + adapter 自定义的 apply 动作）

## 入口

**Layer 2（推荐第三方插件用）：**

```js
const ctx = SillyTavern.getContext();
const { open, defineAdapter, createSettingsBackedHistoryStore } = ctx.iterationStudio;
```

**Layer 1（仓库内代码直接 import）：**

```js
import {
    open,
    defineAdapter,
    createSettingsBackedHistoryStore,
    buildProfileDelta,
    renderProfileDeltaHtml,
} from '/scripts/iteration-studio/index.js';
```

打开 studio：

```js
const adapter = defineAdapter({ /* … 见下方契约 … */ });
await open(adapter, context, settings, root);
```

`open` 在用户关闭 popup 之前一直 await。

## 快速上手 —— 最小可用 adapter

最简单有用的 adapter，编辑插件设置中的一个字符串字段：

```js
import { defineAdapter, createSettingsBackedHistoryStore, open as openIterationStudio } from '/scripts/iteration-studio/index.js';
import { i18n, i18nFormat } from './i18n.js';   // 你自己插件的 i18n
import { escapeHtml } from '/scripts/utils.js';

const TOOL_SET = 'mything_set_value';

export function createMyThingAdapter() {
    return defineAdapter({
        id: 'mything',
        title: i18n('My Thing Studio'),
        mode: 'mything',
        i18n,
        i18nFormat,

        getInitialProfile(ctx, settings) {
            return { value: String(settings.myThingValue || '') };
        },
        cloneWorkingProfile(profile) {
            return { value: String(profile?.value ?? '') };
        },
        getDefaultScope(ctx) {
            return ctx.characterId != null ? 'character' : 'global';
        },

        // 内置 helper 处理常见的 "全局 → settings、角色 → character state" 模式
        ...createSettingsBackedHistoryStore({
            moduleName: 'my_extension',
            globalSettingsKey: 'iterationHistory',
            characterStateNamespace: 'my_ext_iteration_history',
        }),

        buildSystemPrompt() {
            return 'You edit a single string field. Call mything_set_value with the new value.';
        },
        buildUserPrompt(settings, session, text) {
            return `[Current]\n${session.workingProfile.value}\n\n[Request]\n${text}`;
        },

        buildEditableToolSet() {
            return [{
                type: 'function',
                function: {
                    name: TOOL_SET,
                    description: 'Set the value to a new string.',
                    parameters: {
                        type: 'object',
                        properties: { next: { type: 'string' } },
                        required: ['next'],
                        additionalProperties: false,
                    },
                },
            }];
        },
        async executeEditableToolCall(ctx, session, call) {
            const args = call?.args && typeof call.args === 'object' ? call.args : {};
            session.workingProfile.value = String(args.next ?? '');
            return {
                content: JSON.stringify({ ok: true }),
                action: i18n('Updated value'),
                changed: true,
            };
        },

        renderWorkingProfile(session) {
            return `
<div class="luker-studio-panel-title">${escapeHtml(i18n('Current value'))}</div>
<pre>${escapeHtml(session.workingProfile.value)}</pre>
<div class="luker-studio-composer-buttons">
    <div class="menu_button" data-iter-custom-action="apply">${escapeHtml(i18n('Apply'))}</div>
</div>`;
        },
        async handleAction(actionId, ctx) {
            if (actionId === 'apply') {
                ctx.settings.myThingValue = ctx.session.workingProfile.value;
                await SillyTavern.getContext().saveSettings();
            }
        },

        getRequestPresetOptions(settings) {
            return {
                apiPresetName: String(settings.myThingApiPresetName || '').trim(),
                llmPresetName: String(settings.myThingPresetName || '').trim(),
            };
        },
    });
}
```

整个 adapter 就这些。Shell 负责：popup 外壳、对话、历史、auto-continue、Auto-apply 开关、diff 渲染、批准 / 拒绝、abort 接线、LLM 重试 / 超时、会话持久化。

## ProfileAdapter 契约

必填字段（`defineAdapter` 缺任意一项会抛错）：

| 字段 | 签名 | 用途 |
|------|------|------|
| `id` | `string` | 稳定标识符（如 `'mything'`）。用作 popup id 前缀、会话历史 mode filter、Auto-apply 偏好的存储 key |
| `title` | `string` | 本地化后的 popup 标题 |
| `mode` | `string` | 历史过滤 key。一个 adapter 一个 mode。存到 `Session.mode` |
| `i18n` | `(key) => string` | adapter 自己的翻译函数。仅用于 adapter 自有字符串 —— shell 外壳走 shell 自己的 i18n |
| `i18nFormat` | `(key, ...args) => string` | `${0}` / `${1}` 风格的插值。`defineAdapter` 自带默认实现 |
| `getInitialProfile` | `(context, settings) => WorkingProfile` | 新会话开打时构造 workingProfile |
| `cloneWorkingProfile` | `(profile) => WorkingProfile` | 深拷贝 + sanitize。必须幂等 |
| `loadHistoryState` | `(context, scope, avatar) => Promise<HistoryState>` | 读取指定 scope 下的会话历史 |
| `persistHistoryState` | `(context, state, scope, avatar) => Promise<void>` | 写入会话历史 |
| `getDefaultScope` | `(context) => 'global'\|'character'` | 决定打开时默认使用的 scope |
| `buildSystemPrompt` | `(settings, session) => string` | adapter 自己的完整 system prompt |
| `buildUserPrompt` | `(settings, session, userText, opts) => string` | 拼接用户请求 + 当前 profile + 历史 |
| `buildEditableToolSet` | `(session) => ToolDefinition[]` | 只返回可编辑工具 —— shell 会自动注入 `continue` / `finalize` |
| `executeEditableToolCall` | `(ctx, session, call, signal) => Promise<{content, action, changed}>` | 处理单次 editable 调用。只能 mutate `session.workingProfile` / `session.lastSimulation` |
| `renderWorkingProfile` | `(session, opts) => string` | 右侧面板 HTML，包含 adapter 想要的任何 apply / save / publish 按钮 |

可选字段：

| 字段 | 签名 | 默认 |
|------|------|------|
| `popupClassName` | `string` | popup 根元素附加 class，供 adapter 私有 CSS 钩入 |
| `getGlobalBaselineProfile` | `(settings, session) => WorkingProfile\|null` | `null` —— 返回非 null 可以让 LLM 看到"持久化的 vs 会话内已改的" |
| `buildAutoContinuePrompt` | `(executionResult) => string` | shell 自带默认（引用 control 工具名） |
| `controlToolNames` | `{ continue?: string, finalize?: string }` | `{continue: 'iter_continue', finalize: 'iter_finalize'}`。仅为兼容性才覆盖 |
| `describeTool` | `(name) => string` | 默认原样返回。用于 pending 审批摘要里的友好工具名 |
| `getRequestPresetOptions` | `(settings) => { apiPresetName, llmPresetName }` | `{'', ''}` —— 两个空字符串表示"用当前激活的" |
| `resolveRuntimeWorldInfo` | `(ctx, settings, session, signal) => Promise<any\|null>` | `null` —— 返回对象可以给 LLM 注入额外的 world info |
| `renderMessageDiff` | `(session, message, popupId) => string` | 走 `renderProfileDeltaHtml(adapter, message.profileDelta, …)`。仅在需要彻底改布局时覆盖 |
| `renderTextDiff` | `(beforeText, afterText, path) => string` | shell 自带完整的表格式行 / 词级 diff（带放大 + 拖拽分栏）。仅在需要完全不同的内联 UI 时覆盖 |
| `formatDiffPathLabel` | `(path, item) => string` | 默认原样返回。覆盖后可以把 `presets.critic.systemPrompt` 渲染成 `Preset 'critic' / System Prompt` |
| `renderDiffItem` | `(item) => string\|null` | `null` —— 返回 HTML 可以接管单张 diff 卡片的默认渲染 |
| `handleAction` | `(actionId, ctx) => Promise<void>\|void` | 空操作。接 popup 内任何 `[data-iter-custom-action]` 元素的点击 |
| `ensureStyles` | `(popupClassName) => void` | 空操作。在 popup 打开时一次性注入 adapter 自己的样式 |

## 生命周期

```
open(adapter, context, settings, root)
  │
  ├─ adapter.ensureStyles(popupClassName)
  ├─ adapter.getDefaultScope(context)        → scope ('global' | 'character')
  ├─ adapter.loadHistoryState(...)           → HistoryState
  ├─ adapter.getInitialProfile / cloneWorkingProfile  → 新 Session
  ├─ （若历史里有匹配 mode 的最近会话，则用它替换）
  ├─ popup 打开;rerender() 绘制对话 / profile / 历史
  │
  ├─ 用户输入并点 Send
  │   ├─ adapter.buildSystemPrompt
  │   ├─ adapter.buildUserPrompt
  │   ├─ adapter.buildEditableToolSet + shell 的 control 工具
  │   ├─ adapter.getRequestPresetOptions → 通过 generateTask 请求 LLM
  │   ├─ 拆分工具调用:editable vs control(continue / finalize)
  │   ├─ 若有 editable 调用且 !autoApply:
  │   │     ├─ 在克隆 session 上沙箱执行 editable 调用 → 预测出 delta
  │   │     ├─ 把预测 delta 一起存到 pending 消息
  │   │     └─ 渲染 批准 / 拒绝 按钮
  │   └─ 否则:
  │         ├─ 对每个 editable 调用 adapter.executeEditableToolCall
  │         ├─ 计算实际 delta 与 before
  │         ├─ 存为 completed 消息
  │         └─ 若 continueRequested → 再循环一轮
  │
  ├─ 用户点 批准
  │   ├─ 对每个 editable 调用(真实而非沙箱)调 adapter.executeEditableToolCall
  │   ├─ 计算 delta,存为 completed
  │   └─ 若 continueRequested → 再循环一轮
  │
  └─ 用户点 拒绝 / 终止 / 关闭 → 清理
```

## Session 形状

Shell 维护的 `Session` 字段：

```ts
{
    id: string,                    // 'session_<ts>_<rand>'
    mode: string,                  // adapter.mode
    chatKey: string,               // 用于聊天绑定的重置
    sourceScope: 'global'|'character',
    sourceAvatar: string,          // 全局时为 ''
    sourceName: string,            // adapter 提供的标签（如角色名）
    revision: number,              // 每次 editable 调用自增
    createdAt: number,
    updatedAt: number,
    workingProfile: WorkingProfile,  // adapter 自己定义形状
    baseWorkingProfile: WorkingProfile,
    messages: SessionMessage[],
    lastSimulation: Simulation|null,
    pendingApproval: PendingApproval|null,
}
```

Adapter 一般只读 `workingProfile` / `sourceScope` / `sourceAvatar` / `sourceName` / `messages`。其他字段是内部的但对你可见。

## 存储

`createSettingsBackedHistoryStore({ moduleName, globalSettingsKey, characterStateNamespace, historyLimit?, modeFilter? })` 返回一对 `{ loadHistoryState, persistHistoryState }`，adapter 把它展开到自己定义里：

- 全局 scope → `extension_settings[moduleName][globalSettingsKey]`（通过 `saveSettingsDebounced` 保存）
- 角色 scope → `context.getCharacterState(avatar, characterStateNamespace)` / `setCharacterState(...)`
- `historyLimit`（默认 24）限制每个 scope 保留的最近会话数
- `modeFilter` 让多个 adapter 共享同一份底层存储但各自只看自己的 sessions（编排器的 spec / agenda / loop 三个 adapter 就用它，所以现有历史不需要迁移）

需要自定义存储的 adapter（IndexedDB、加密、云同步）直接实现 `loadHistoryState` / `persistHistoryState` —— shell 只检查返回形状（`{ version: 3, sessions: Session[] }`）。

## Adapter 驱动的动作

Shell 把 popup 内 `[data-iter-custom-action="<id>"]` 的点击委托给 `adapter.handleAction(id, ctx)`。用它来做 apply 按钮、save-as-new、发布、撤销，等等。

```js
renderWorkingProfile(session) {
    return `
${profileHtml}
<div class="luker-studio-composer-buttons">
    <div class="menu_button" data-iter-custom-action="apply-global">${escapeHtml(i18n('Apply to Global'))}</div>
    ${session.sourceAvatar ? `<div class="menu_button" data-iter-custom-action="apply-character">${escapeHtml(i18n('Apply to Character'))}</div>` : ''}
</div>`;
},
async handleAction(actionId, ctx) {
    const { context, settings, session, root } = ctx;
    if (actionId === 'apply-global') {
        // ... 把 session.workingProfile 写入 settings
    }
    if (actionId === 'apply-character') {
        // ... 写入角色 state
    }
},
```

Shell 不解释动作 id —— 任意命名，符合你的领域即可。不需要持久化的 studio 可以完全省略 `handleAction` 并不渲染动作按钮。

## diff 自定义

默认行为已经覆盖大部分场景 —— 不需要覆盖：

- 对象 vs 对象 整体替换会**自动递归**展开成逐字段卡片（最多深度 3），不会看到两块大 JSON
- 长字符串字段自动走 shell 内置的**行级 / 词级内联 diff**（带放大 + 拖拽分栏）
- pending 审批会**预投影** diff（用户点批准之前就能看到将要改什么）

默认不够用时，通过可选钩子定制：

- `renderTextDiff(beforeText, afterText, path)` —— 接管字符串内联渲染
- `formatDiffPathLabel(path, item)` —— 把 `presets.critic.systemPrompt` 美化成 `Preset 'critic' / System Prompt`
- `renderDiffItem(item)` —— 接管整张 path 卡片（返回 `null` 回退到默认）
- `renderMessageDiff(session, message, popupId)` —— 整个 diff 块都接管

传给 `renderDiffItem` 的 `item` 形状：

```ts
{
    path: string,                                    // e.g. 'presets.critic'
    beforeValue: any,
    afterValue: any,
    beforePayload: { text: string, missing: boolean },  // 已预格式化方便使用
    afterPayload: { text: string, missing: boolean },
}
```

## i18n 注意

- Shell 用自己的翻译表（`public/scripts/iteration-studio/i18n.js`）渲染外壳字符串。adapter 不用翻译 `对话` / `发送给 AI` / `批准并应用` 这些
- 本地化注册延迟到 DOM-ready，因为 SillyTavern 的 `addLocaleData` 在 locale 文件加载前调用会静默 no-op
- Adapter 提供自己的 `i18n` 函数指向自己的翻译表 —— 用于 popup 标题、system prompt、工具动作描述、自定义按钮文本

## 兼容性

- `getApplyTargets` / `applyToGlobal` / `applyToCharacter` / `canApplyToCharacter` —— 这些是设计过程中的中间方案，不是当前契约的一部分。用 `renderWorkingProfile` + `handleAction` 来做按钮
- Shell 不假定 "global / character" 的 scope 模型 —— 编辑 chat scope 或 preset scope 工件的 adapter 自由渲染自己合适的按钮

## 参考

- `public/scripts/iteration-studio/adapter.js` —— JSDoc 标注的契约（权威来源）
- `public/scripts/extensions/orchestrator/iteration-adapter.js` —— 包裹已有编排器助手；参考"老代码薄包装"模式
- `public/scripts/extensions/memory-graph/schema-adapter.js` —— 直接基于契约从零构建;参考新 adapter 模式
