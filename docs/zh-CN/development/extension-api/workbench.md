# 工作台 API

`context.workbench` 暴露 Luker 统一工作台的注册表与导航运行时。扩展可以通过它注册嵌入式工作区、AI 迭代目标、问答只读数据源与本地建议规则，无需直接导入工作台内部文件或跨插件耦合。

仓库内参考实现：

- `public/scripts/extensions/memory-graph/lens/index.js` —— 工作区（`'memory'`）、AskProvider、SuggestRuleProvider，以及 `'memory'` / `'memory_graph'` 迭代目标
- `public/scripts/extensions/orchestrator/lens/index.js` —— 工作区（`'orch'`）、AskProvider、SuggestRuleProvider，以及 `'orch'` 迭代目标
- `public/scripts/workbench/targets/{preset,card,world}.js` —— 内置 `'preset'`、`'card'` 与 `'world'` 迭代目标

## 三层 API 暴露

```js
// Layer 1 —— 直接 ESM import（仓库内扩展）
import {
    registerWorkspace,
    registerIterateTarget,
    registerAskProvider,
    registerSuggestRuleProvider,
    open,
} from '/scripts/workbench/registry.js';

// Layer 2 —— lukerContext 属性
const { registerWorkspace, open } = lukerContext.workbench;

// Layer 3 —— Luker.getContext()（第三方扩展）
const { registerWorkspace, registerIterateTarget, open } = Luker.getContext().workbench;
```

所有 `register*` 方法均与加载顺序无关，并按 `id` 幂等（重复注册相同 `id` 会替换旧定义并保留排序槽位），返回值均为带唯一令牌校验的 `unregister()` 清理函数。

## 打开与导航

```ts
workbench.open(opts?: {
    page?: 'home' | 'ask' | 'ai' | 'hist' | 'settings' | `ws:${string}`;
    ws?: string;       // 工作区 id（导航到 ws:<id>），或在 page === 'ai' 时指定迭代目标 id
    subview?: string;  // 工作区子视图，例如 'run'、'graph'、'schema'
    runKey?: string;   // 例如 'orchestrator:<runId>'，跳转到特定运行记录
    scope?: string;    // 例如 'global' | 'character' | 'preset' | 'chat'
    draft?: string;    // 打开 page: 'ai' 时预填的输入框文本
}): Promise<WorkbenchHandle | null>
```

在工作台 UI 挂载完成前发起的 `open()` 会自动排队，待启动时 `setOpenHandler` 就绪后依次执行。

## 注册嵌入式工作区

`registerWorkspace(def)` 在工作台左侧栏核心页面下方新增一个工作区标签页。

```js
const unregister = Luker.getContext().workbench.registerWorkspace({
    id: 'my-ext',
    title: 'My Workspace',
    icon: 'mark',        // 工作台内置图标名或 DOM 节点
    order: 30,           // 侧栏升序排列权重
    tone: 'other',       // 强调色令牌
    flush: true,         // 占满主内容区高度（取消外层内边距）
    isEnabled: () => true,
    mount(container, { app, opts }) {
        const root = document.createElement('div');
        root.textContent = 'Workspace content';
        container.appendChild(root);
        return {
            show(showOpts) {},
            hide() {},
            update(nextOpts) {},
            onEscape() { return false; },
            onSnapshot() {},
            destroy() { root.remove(); },
        };
    },
});
```

`mount()` 在用户首次切换到该工作区时按需执行，`destroy()` 在取消注册或工作台卸载时调用。

## 注册 AI 迭代目标

`registerIterateTarget(def)` 向 **AI 迭代**页面（`page: 'ai'`）注册一个可对话编辑的目标。

`targetDef` 核心字段：

| 字段 | 用途 |
| --- | --- |
| `id` | 唯一目标 id（`'memory'`、`'orch'`、`'preset'`、`'card'`、`'world'` 等） |
| `label` | 顶部目标切换器显示的名称（字符串或 `() => string`） |
| `order` / `tone` | 排序权重与徽标色调 |
| `chips` | 可选，空会话时显示的快捷示例数组或 `() => string[]` |
| `scopes?(ctx)` | 异步返回 `{ global?, character?, preset?, chat? }` 可用性 |
| `scopeNotes` | 函数 `(scope, ctx) => string` 或映射 `{ [scope]: string \| (() => string) }`，显示在作用域选择器下方 |
| `isEnabled?(ctx)` | 可选的启用条件检查 |
| `getNativeAi?(ctx)` | 当工作台 AI 设置设为**跟随插件**时返回 `{ connection, preset }` |
| `promptInfo?(ctx)` | 异步返回 `{ from, custom, text }`，供**设置 → 提示词**展示 |
| `load(scope, ctx)` | 读取实时目标数据，返回 `{ live, target, title }` |
| `tools(live, scope, ctx, { target })` | 返回 OpenAI 风格的函数工具定义数组（或 Promise） |
| `systemPrompt?(scope, live, { wrapper, ctx, target })` / `prompt?(live, scope, ctx, { wrapper, target })` | 目标专属提示词（`systemPrompt` 返回完整系统提示词；未提供时工作台会为 `prompt` 自动前置 `wrapper`） |
| `isRead(name)` | 返回 `true` 表示只读工具，`false` 表示修改工具 |
| `runRead(call, live, helpers)` | 执行只读工具（`call` 为 `{ id, name, args }`） |
| `runEdit(call, live, helpers)` | 执行修改工具；返回更新后的 `live` 或 `{ live, proposals }`，或通过 `helpers.propose(...)` 暂存提案 |
| `proposalKinds` | 可选 `ProposalBus` 适配器或内置类型名（`'profile-edit'`、`'lorebook-write'`、`'skill-author'`、`'preset-clone'`、`'custom-tool-author'`） |
| `units(data, targetRef)` | 单元投影，用于生成**改动清单**的差异项 |
| `rebuild(base, ai, fieldKeys, targetRef)` | 基于 `base` 与用户勾选的 `ai` 中 `fieldKeys` 重建待提交的 `next` |
| `commit(targetRef, base, next, fieldKeys)` | 将批准的修改写回 Luker，返回 `{ applied?, skipped?, failure?, undo() }` |
| `renderControls?({ live, scope, settings, onReload })` | 可选，对话区上方工具栏控件 DOM 节点 |
| `renderPreview?({ base, ai, target })` | 可选，右侧实时预览栏 DOM 节点 |

`runEdit` 作用于克隆后的工作副本（`live`）或通过 `helpers.propose(...)` 将非字段类提案暂存到 `ProposalBus`。当模型某一轮返回零次工具调用时，迭代循环自动结束并将控制权交还用户。

## 注册问答数据源

`registerAskProvider(def)` 向**总览**与**问问**提供插件的状态快照、概览卡片与只读工具：

```js
const unregister = Luker.getContext().workbench.registerAskProvider({
    id: 'my-ext',
    label: 'My Extension',
    tone: 'other',
    icon: 'mark',
    overviewKey: 'myExtension',
    order: 30,
    async getSnapshot(ctx) {
        return { installed: true, items: 12 };
    },
    async getOverview(ctx) {
        return { enabled: true, items: 12 };
    },
    getSideInfo(pSnap, snap) {
        return {
            label: 'My Extension',
            countText: pSnap ? `${pSnap.items} items` : 'Not present',
            status: pSnap ? 'ok' : 'warn',
        };
    },
    renderHomeCard(pSnap, { snap, warn, status, askBtn, wsBtn, workspace }) {
        return {
            tone: 'other',
            iconName: 'mark',
            name: 'My Extension',
            by: pSnap ? 'Enabled' : 'Not installed',
            pill: status('my-ext', Boolean(pSnap)),
            stats: pSnap ? [['Items', String(pSnap.items)]] : [],
            acts: [
                pSnap ? askBtn('my-ext') : null,
                workspace ? wsBtn(workspace) : null,
            ],
        };
    },
    tools: [{
        type: 'function',
        function: {
            name: 'wb_read_my_ext',
            description: 'Read read-only status from My Extension.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
    }],
    readers: {
        wb_read_my_ext: async (args, ctx) => ({ items: 12 }),
    },
});
```

`tools` 与 `readers` 中注册到**问问**的工具必须严格只读，不产生任何状态变更。

## 注册本地建议规则

`registerSuggestRuleProvider(def)` 注册在**总览**展示、且可在**设置 → 小建议**中开关的零 AI 本地规则检查：

```js
const unregister = Luker.getContext().workbench.registerSuggestRuleProvider({
    id: 'my-ext',
    tone: 'other',
    rules: [
        {
            id: 'my-ext.high-count',
            name: 'High item count',
            when: 'Item count exceeds 100',
            defaultOn: true,
            check(snap) {
                const count = snap?.providers?.['my-ext']?.items || 0;
                if (count <= 100) return null;
                return {
                    text: `${count} items in My Extension`,
                    why: 'Large lists slow down processing.',
                    source: 'Based on My Extension state',
                    sig: String(count),
                    actions: [
                        { kind: 'ai', ws: 'my-ext', label: 'Have the AI look', prompt: 'Review My Extension items.' },
                    ],
                };
            },
        },
    ],
});
```

`actions` 支持的动作形态：

- `{ kind: 'ai', label, ws, prompt, primary? }` —— 打开对应目标 `ws` 的 **AI 迭代**并预填 `prompt`
- `{ kind: 'ask', label, question, primary? }` —— 打开**问问**并预填 `question`
- `{ kind: 'session', label, sessionId, primary? }` —— 打开已有的 **AI 迭代**会话
- `{ kind: 'setHorizon', label, value, primary? }` —— 调整记忆图常驻注入最大回溯楼层数
- `{ label, run: async (app) => { ... }, primary? }` —— 执行接收工作台 `app` 句柄的自定义异步回调

## 查询与订阅

- `workbench.getWorkspaces({ enabledOnly? })`
- `workbench.getIterateTargets()`
- `workbench.getAskProviders()`
- `workbench.getSuggestRuleProviders()`
- `workbench.subscribe(listener)` —— 注册表变更时触发，返回 `unsubscribe()`
- `workbench.saveSettingsChecked(ctx)` —— 刷新保存设置，失败时抛出带类型的错误
