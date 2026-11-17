# 迭代工具库（Iteration Library）

`context.iterationLibrary` 为 AI 驱动的迭代式编辑界面提供共享基础设施：LLM 工具调用 runner、按作用域隔离的会话存储、词级 / 行级文本 diff、全屏缩放对比浮层、统一提案总线（`proposalBus`），以及与插件解耦的世界书 / 技能 / 预设读写工具集。

如果希望将可迭代编辑的目标直接接入 Luker 统一的**工作台 → AI 迭代**标签页，请使用 [`context.workbench.registerIterateTarget`](/zh-CN/development/extension-api/workbench#注册-ai-迭代目标)。当插件需要保留独立弹窗或全屏 IDE 界面（例如角色卡编辑弹窗或 CardApp Studio）时，可以直接调用 `context.iterationLibrary`。

## 三层 API 暴露

```js
// Layer 1 —— 直接 ESM import（仓库内扩展）
import {
    applyEdits,
    inverseEdit,
    registerOp,
    runner,
    storage,
    proposalBus,
    tools,
} from '/scripts/iteration-library/index.js';

// Layer 2 —— lukerContext 属性
const { runner, storage, proposalBus } = lukerContext.iterationLibrary;

// Layer 3 —— Luker.getContext()（第三方扩展）
const { applyEdits, runner, storage, textDiff, zoomOverlay, ui, tools, proposalBus } =
    Luker.getContext().iterationLibrary;
```

## 核心模块

| 导出项 | 用途 |
| --- | --- |
| `applyEdits`、`inverseEdit`、`registerOp`、`BUILT_IN_OPS`、`showConflictResolution` | 从 [Edits 库](/zh-CN/development/extension-api/edits-lib) 重新导出，用于感知漂移的应用、回滚与冲突解决 |
| `runner` | `requestToolCallsWithRetry` 与通用 LLM 轮次执行辅助函数 |
| `storage` | 按作用域隔离的会话持久化、安全深拷贝及角色 / 全局状态读写辅助 |
| `proposalBus` | `createProposalBus` 与内置提案适配器：`profileEdit`、`lorebookWrite`、`skillAuthor`、`presetClone`、`customToolAuthor` |
| `tools` | 与具体插件解耦的工具定义与分发器（`lorebook-reads`、`lorebook-writes`、`character-presets-reads`、`skill-iter-studio`） |
| `render`、`textDiff`、`zoomOverlay`、`ui` | 差异卡片、逐行并排对比浮层、消息 Markdown 渲染与可折叠思考块 |
| `bindIterWorkspaceResizer` | 分栏拖拽调整器（Layer 1 `/scripts/iteration-library/index.js` 还额外导出 `createRenderScheduler`） |

## 参考消费方

- **工作台迭代目标**（`public/scripts/workbench/targets/` 以及 `orchestrator/lens/iterate-target.js`、`memory-graph/lens/iterate-targets.js`）—— 复用 `proposalBus`、`tools` 与 `storage` 辅助能力，同时由工作台统一托管窗口、目标切换和改动记录。
- **CardApp Studio 与角色卡编辑弹窗**（`public/scripts/extensions/character-editor-assistant/`）—— 自行管理独立界面，并调用 `iterationLibrary` 处理工具重试、世界书工具、差异渲染及 `edits-lib` 应用与回滚。

## 相关页面

- [工作台 API](/zh-CN/development/extension-api/workbench) —— 向工作台注册 AI 迭代目标
- [Edits 库](/zh-CN/development/extension-api/edits-lib) —— 基于 op 的补丁引擎与冲突解决
- [角色卡编辑助手 API](/zh-CN/development/extension-api/character-editor-assistant) —— 角色卡与世界书修改辅助工具
