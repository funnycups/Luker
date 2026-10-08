# 运行面板

## 它是什么

一个可复用的内存内运行轨迹，供任何执行多步 LLM 任务的插件使用。它会在聊天区旁渲染一块滑入式面板（窄屏下改为底部抽屉），每一轮是一张可折叠的卡片，分节内容流式填充，附带停止按钮与导出动作，运行进行中还会显示一枚悬浮胶囊。

共享层位于 `public/scripts/run-panel/`，在 Luker context 上暴露为 `runPanel`。仓库内消费方：

- 编排器 —— `public/scripts/extensions/orchestrator/run-panel/panel.js`

## 快速上手

```js
import { createRunStore, createRunPanel } from '/scripts/run-panel/index.js';

const store = createRunStore();
const panel = createRunPanel({
    store,
    t: (text, ...args) => text,   // supply your plugin's translator
    idPrefix: 'luker-my-run-panel',
    modeLabels: { myTask: 'My task' },
    exportFilename: ({ runId }) => `my-run-${runId}.json`,
});
panel.init();   // call once at boot
panel.open();   // call from a menu action
```

这就是完整的集成方式。通过写入 store 驱动面板：

```js
const runId = store.startRun({ mode: 'myTask', stopFn: () => abortController.abort() });
const roundId = store.appendRound({ runId, round: { id: 'round-1', label: 'Round 1' } });
const sectionId = store.ensureSection({
    runId, roundId,
    section: { id: 'reasoning', kind: 'reasoning', title: 'Reasoning' },
});
store.appendToSection({ runId, roundId, sectionId, delta: 'thinking…' });
store.setSectionStatus({ runId, roundId, sectionId, status: 'done' });
store.finishRun({ runId, status: 'committed', finalText: 'Result' });
```

## 存储 API

`createRunStore()` 返回一个隔离的 store。每次调用都会产生一个独立实例，因此两个插件绝不会共享运行状态或产生冲突。

| 方法 | 用途 |
| --- | --- |
| `subscribe(listener)` | 订阅事件；返回一个取消订阅函数。 |
| `getCurrentRun()` | 当前运行对象，无则为 `null`。 |
| `startRun({ mode, chatKey, abortFn, stopFn, quiet })` | 开始一次运行；返回 `runId`。若该 store 已有运行中的运行则抛出错误。 |
| `clearCurrentRun()` | 丢弃当前运行并发出 `run_cleared`。 |
| `appendRound({ runId, round: { id, label } })` | 添加一轮；返回 `roundId`。 |
| `setRoundStatus({ runId, roundId, status })` | 更新轮次状态。 |
| `ensureSection({ runId, roundId, section: { id, kind, title, meta } })` | 分节不存在时创建；返回 `sectionId`。 |
| `appendToSection({ runId, roundId, sectionId, delta })` | 向分节正文追加流式文本。 |
| `setSectionStatus({ runId, roundId, sectionId, status, meta })` | 更新分节状态。 |
| `finishRun({ runId, status, finalText, error })` | 结束运行。 |
| `setRunMeta({ runId, tokensSpent, cost })` | 设置运行级元数据。 |
| `addTokenUsage({ runId, usage })` | 把 LLM 用量对象累加进运行中的 token 总数。 |

`quiet: true` 只填充 store 而不自动打开面板；之后调用 `panel.open()` 即可显示。

## 事件

监听器接收 `{ type, ... }` 负载。常量从 `run-panel/events.js` 导出（也可通过 `context.runPanel.events` 访问）。

| 事件 | 负载 |
| --- | --- |
| `run_started` | `runId`、`mode`、`quiet` |
| `round_appended` | `runId`、`roundId` |
| `section_ensured` | `runId`、`roundId`、`sectionId` |
| `section_appended` | `runId`、`roundId`、`sectionId`、`delta` |
| `section_status` | `runId`、`roundId`、`sectionId`、`status`、`meta` |
| `round_status` | `runId`、`roundId`、`status` |
| `run_meta` | `runId` |
| `run_finished` | `runId`、`status` |
| `run_cleared` | `runId` |

## 面板选项

`createRunPanel(options)` 返回 `{ init, open, destroy }`。

| 选项 | 默认值 | 用途 |
| --- | --- | --- |
| `store` | 必需 | 来自 `createRunStore()` 的 store。 |
| `t` | 恒等函数 | 翻译函数 `(template, ...args) => string`。 |
| `idPrefix` | `luker-run-panel` | DOM id 前缀；面板根为 `#<idPrefix>`，悬浮胶囊为 `#<idPrefix>-pill`。 |
| `stylesheetUrl` | 共享的 `panel.css` | 要注入的样式表。 |
| `kindIcons` | `DEFAULT_KIND_ICONS` | 分节类型到图标的映射。 |
| `defaultCollapsedKinds` | `[]` | 默认折叠渲染的分节类型。 |
| `modeLabels` | `{}` | mode 到徽标文字的映射；缺失时回退为原始 mode。 |
| `exportFilename` | `run-<runId>-<mode>.json` | 导出动作的文件名。 |
| `autoOpen` | `true` | 非 quiet 的 `run_started` 时自动打开。 |
| `emptyStateText` | 一段默认提示 | 无运行时 `open()` 显示的文案。 |
| `onStop` | `null` | 覆盖停止处理器。 |

## 辅助函数

以下便捷封装层用于终结轮次与分节状态。首个参数为 store 实例，因此可用于任意 store。

| 辅助函数 | 用途 |
| --- | --- |
| `withRound(store, runId, { id, label }, fn)` | 追加轮次、执行 `fn(roundId)`，随后将轮次标记为 `done`；抛出错误时标记为 `failed`。返回 `fn` 的结果；返回 Promise 时，在其落定后终结该轮次。 |
| `withStreamingSection(store, runId, roundId, { id, kind, title }, asyncFn)` | 确保分节存在，将 `append(delta)` 函数与分节 id 传给 `asyncFn`，随后将分节标记为 `done`；抛出错误时标记为 `failed`。 |

## 三层 API 暴露

```js
// Layer 1 —— 直接 ESM import（仓库内扩展）
import { createRunStore, createRunPanel } from '/scripts/run-panel/index.js';

// Layer 2 —— lukerContext 属性
const { createRunPanel } = lukerContext.runPanel;

// Layer 3 —— getContext（第三方扩展）
const { createRunStore } = SillyTavern.getContext().runPanel;
```

## 参考消费方

- 编排器运行时写入轮次与分节，面板在每次运行时自动打开：`public/scripts/extensions/orchestrator/loop-runtime.js`、`director-runtime.js`、`agenda-runtime.js`、`spec-runtime.js`。
- 编排器封装层配置 i18n 与导出文件名：`public/scripts/extensions/orchestrator/run-panel/panel.js`。
