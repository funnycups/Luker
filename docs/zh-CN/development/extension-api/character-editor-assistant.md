# Character Editor Assistant Extension API

`character-editor-assistant`（CEA）扩展通过 Luker 的 extension 注册表发布三个 helper，让其它插件拥有的迭代工作台能复用 CEA 的 helper-tool 面，而不必跨插件边界 import。这正是编排器 iter-studio 弹窗和记忆图 schema iter-studio 弹窗共同消费的接口。

## 为什么需要这套接口

CEA 拥有一组 helper 工具，给迭代弹窗用来读写角色卡和它的 lorebook：

- `lorebook_query` / `lorebook_list` / `lorebook_get` —— 读 lorebook
- `world_book_list` —— 列出某角色可见的世界书
- `simulate_prompt` —— dry-run 一次 prompt 并捕获 prompt 与世界信息命中
- 一组卡字段 + 词条写入工具，把 AI 提议翻译成可提交的 edits

之前兄弟 iter-studio（例如编排器的 iter-studio 弹窗）需要把这些工具也暴露给自己的 LLM 时，是直接 ES 模块 import 进来的。这会把消费者和 CEA 的内部文件路径耦合死，并打破插件↔插件边界。下面这套 extension api 就是来取代那种耦合的。

## 接口

```js
const cea = SillyTavern.getContext().getExtensionApi('character-editor-assistant');
if (!cea) {
    // CEA 未安装；依赖这些 helper 的 iter-studio 弹窗应当拒绝打开，
    // 并给出清晰的"请安装 CEA"错误。
    return;
}

const helperApis = cea.buildCharacterEditorHelperApis(context, { avatar });
const toolResult = await cea.runCharacterEditorHelperToolCall(call, helperApis);
await cea.applyCharacterEditorLorebookProposal(context, { kind, args });
```

## 方法

### `buildCharacterEditorHelperApis(context, opts?)`

返回 CEA 统一编辑器读工具分发用的 helper-tool API 数组。每个 entry 暴露 `isToolName(name)` 加 `invoke(call)`，`runCharacterEditorHelperToolCall` 会迭代这个数组，把调用路由到匹配的 helper。

```ts
buildCharacterEditorHelperApis(
    context: SillyTavernContext,
    opts?: { avatar?: string },
): Array<{ isToolName: (n: string) => boolean; invoke: (call) => Promise<any> }>
```

- `context` —— SillyTavern context（必须暴露 `characters`、`loadWorldInfo`、……）。
- `opts.avatar` —— 角色 avatar，用于把 lorebook / world-book-list 接口限定到正确的角色卡。全局弹窗可省略。

返回的数组恒定包含四个 helper（lorebook 读、lorebook 写、simulate、world-book-list），当 `globalThis.Luker.searchTools` 接好时会额外多一个 web 搜索 helper。

### `runCharacterEditorHelperToolCall(call, helperApis)`

分发一次 helper 工具调用。调用方传入 `buildCharacterEditorHelperApis` 返回的 helper API 数组；分发器通过 `isToolName` 找到匹配的 helper 并转发。匹配不到时抛 `Unsupported helper tool: <name>`。

这正是 iter-studio 弹窗注入到共享的 `iteration-library/tools/lorebook-reads.js` 和 `lorebook-writes.js` 里的分发器 —— 那两个模块本身与插件无关，按调用注入分发器。

### `applyCharacterEditorLorebookProposal(context, { kind, args })`

针对词条当前的磁盘状态重新推导 lorebook 提议的 after-image 并提交。`kind` 是 `'update'` 或 `'str_replace'`；`args` 是提议原始的 `args` payload。

iter-studio 弹窗就是用这个方法提交 AI 提议的 lorebook 编辑 —— 不信任提议时间点抓的快照，而是重新对齐当前状态。这样同一个 `book#uid` 的多次连环提议能正确依次提交，并行会话漂移也会冒成一次新鲜的校验错误，而不是被静默覆盖。

## 懒解析 api

弹窗应该在打开时解析 api，而不是在模块加载时。CEA 的注册时机可能晚于消费者模块求值；推迟解析也让弹窗在依赖缺失时有机会给用户一个清晰的"请安装 CEA"错误。

```js
function getCea() {
    const api = SillyTavern.getContext().getExtensionApi('character-editor-assistant');
    if (!api) {
        throw new Error('该迭代弹窗需要 character-editor-assistant 扩展。');
    }
    return api;
}
```

## 相关

- [插件集成](./plugin-integration.md) —— `registerExtensionApi(name, api)` / `getExtensionApi(name)` 注册表，发布 `'character-editor-assistant'`
- [迭代工作台框架](./iteration-studio.md) —— 消费者弹窗使用的共享 `iteration-library/*` 接口，CEA 分发器注入到其中
- [编排器工具 API](./orchestrator-tools.md) —— 兄弟参考消费者
- [记忆图扩展 API](./memory-graph.md) —— 兄弟参考消费者
