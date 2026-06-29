# 自定义工具

自定义工具让你给编排器的 agent 加新能力——超出 Luker 内置的 chat / lorebook / note / memory 工具范围。一共支持三条来源通道，四种编排模式（loop / spec / agenda / director）看到它们的方式完全一致。

## 自定义工具的来源

**来自其他 Luker 扩展。** 像 memory-graph、search-tools 这类扩展在启动时注册自己的工具。你什么都不用做——这些工具会出现在编排编辑器的「自定义工具 → 扩展（来自其他插件）」里，新建编排时默认启用。

**来自 SillyTavern。** SillyTavern 自身也有 function tool 系统，其他插件会用它注册工具。要把这些工具暴露给编排器 agent，打开编排编辑器，点「桥接 SillyTavern 工具……」——挑你想要的工具，给每个工具选「读」或「写」模式，保存。它们会出现在「自定义工具 → 来自 SillyTavern」分组里。

**在本编排里手写。** 上面两条通道都覆盖不到的一次性需求，你可以现写一个工具。在编排编辑器的「自定义工具」区点「添加自定义工具」。这种方式定义的工具会跟着编排走——全局编排里写的就全局生效，角色卡覆写里写的就会随角色卡一起导出。

## 「添加自定义工具」对话框

- **工具名** —— `a-z`、`A-Z`、`0-9`、`_`，最长 64 个字符。必须以字母开头，不能跟内置工具或同一编排里别的工具重名。
- **显示名** —— 在编排编辑器的工具列表里展示。LLM 看到的仍然是上面那个技术名。
- **描述** —— 写给 LLM 看的工具说明，不是写给你自己看的。
- **模式**
  - **读（无副作用）** —— 模拟评审期总是真实跑。
  - **写（修改状态）** —— 模拟评审期会跳过，除非你提供了模拟体。
- **参数（OpenAI JSON Schema）** —— LLM 传入参数的 JSON Schema 描述。保存时会按 JSON 解析校验。
- **函数体** —— 异步 JavaScript，两个参数：
  - `args` —— LLM 传过来已解析的参数。
  - `ctx` —— SillyTavern `getContext()` 那个对象，外加编排运行时挂的几个字段。完整字段列表见下面 [ctx 上有什么](#ctx-上有什么)。

  你 `return` 什么，LLM 就看到什么作为工具结果。`throw` 会把错误抛回给 agent。
- **模拟体** —— 可选，签名同函数体。模拟评审期间对写工具用，让模拟跑出来的结果形状跟真实跑一致，但不会改任何真实状态。

### ctx 上有什么

`ctx` 原型链上继承 SillyTavern `getContext()` 返回的所有字段，外加编排运行时挂的几个内部字段。

来自 SillyTavern（用法跟 `getContext()` 完全一样）:

- `ctx.chat` —— 实时聊天数组，最新一条在最后
- `ctx.characters`、`ctx.characterId` —— 当前角色卡列表与索引
- `ctx.groups`、`ctx.groupId` —— 群聊时的当前群组与索引
- `ctx.name1`、`ctx.name2` —— `{{user}}` 与 `{{char}}` 解析后的当前名字
- `ctx.eventSource`、`ctx.eventTypes` —— 派发 / 订阅运行时事件
- `ctx.getExtensionApi(name)` —— 调用其他扩展发布的 API（例如 `ctx.getExtensionApi('memory-graph')`）
- `ctx.registerOrchestrationTool`、`ctx.bridgeSillyTavernTool` 等 —— 同 [编排器工具 API](/zh-CN/development/extension-api/orchestrator-tools) 文档里描述的那一套

编排运行时挂的（只在编排过程中存在）:

- `ctx.__lukerRun` —— 本次 run 的运行时状态。子字段：
    - `ctx.__lukerRun.activatedEntryKeys` 是一个 `Set`，键的形式是 `${world}.${uid}`，标记本轮已经被注入主上下文的 World Info 条目（你的工具若要再呈现 lorebook 内容可据此去重）。
    - `ctx.__lukerRun.wiFinalizedPayload` 是**可变引用**，指向 `script.js` 即将拼成 `<world_info>` 通道字符串的那一份 `wiFinalizedPayload`。**在你的工具调用执行期间** push 到 `wiFinalizedPayload.worldInfoBeforeEntries` / `.worldInfoAfterEntries` / `.worldInfoDepth[i].entries` 里的内容，会被当作本轮 `<world_info>` 通道的一部分一同送进主模型，跟自然激活的条目完全没法区分。绕过世界书 token 预算，也不会触发递归 key 扫描。Loop / Spec / Agenda 可用（它们都在 `GENERATION_WORLD_INFO_FINALIZED` 同一帧内跑）；**Director 下为 undefined**（主代理跑的时候 WI 已经焊死在 prompt 里）。Layer-1 的 `lorebook_force_activate` builtin 是这个机制的官方包装——优先用它，不要自己手写 push。
    - `ctx.__lukerRun.abortSignal` 是本次 run 的协作式取消信号——长耗时工具里要定期检查 `.aborted`。
- `ctx.__floorStateForNotes` —— `note_open` / `note_close` 工具底层用的 floor-state 实例。想跟笔记系统协作的工具可以读它。
- `ctx.__customToolRegistry` —— 你的工具被编译进的那个 per-run Layer-3 注册表。大多数工具用不到，留给少数高级场景（例如反向枚举本编排里的其他手写工具）。
- `ctx.__memoryGraphSession` —— 由第一次 `memory_*` 工具调用 lazy 打开；本轮跑过至少一次 memory 工具之后才会出现。

字段命名冲突：SillyTavern 占顶层名字空间；编排运行时只挂 `__` 前缀的字段，所以两边互不踩。

最小例子：

```js
// 读当前角色名
return { char: ctx.characters[ctx.characterId]?.name };

// 调另一个扩展的 API
const mg = ctx.getExtensionApi('memory-graph');
const session = await mg.openSession(ctx);

// 发出事件,别处可以订阅
ctx.eventSource.emit('my_tool_fired', { args });

// 协作式取消:检查本 run 的 abort signal
if (ctx.__lukerRun?.abortSignal?.aborted) {
    throw new Error('aborted');
}
```

### 安全提示

函数体跑在页面 context 里，权限和任何 Luker 模块一样大。它可以发起任意 URL 请求、改全局状态、读你的私聊内容。**只粘贴你信任的代码。**

当你正在导入的角色卡带了自定义工具，Luker 会先弹一个审查对话框，把每个工具的名字、描述、模式、完整代码都列出来再问你要不要导入。你可以点「导入并应用工具」全盘接收，「导入但不应用工具」只导入角色卡本身丢掉这些工具，或者展开每一项先把代码看一遍。

## 启用与禁用

编排编辑器的「自定义工具」复选框面板控制每个工具在本编排下要不要喂给 LLM。取消勾选不会删除定义，之后随时可以再勾回来。

子代理的工具覆写（spec 节点 / agenda agent / director 子代理）对自定义工具的处理跟内置工具一样——单节点的覆写会覆盖编排默认值。

## 模拟评审

自定义工具会进入 [AI 迭代工作台](./iteration-studio.md) 用来在不写真实状态的前提下、把工作流跑在你当前聊天上的那条模拟管线。读工具总是真实派发到你的代码。写工具如果你写了模拟体就走模拟体；否则返回标准占位 `{ ok: true, simulated: true, unvalidated: true }`，trace 里会标成「未验证」。

## 迭代工作台

AI 迭代工作台直接在工作 profile 上读写自定义工具的 Layer-3 定义。它有完整的读 / 写 / 检查表面，外加沙箱 dry-run 和发现工具，这样它能在请你确认前先用真实的 `ctx` 把代码校验过。

读工具（结果直接回传，无需审阅）：

- `luker_orch_list_custom_tools` —— 列出 profile 上的工具，带模式 / 描述 / 是否有模拟体 / 一行参数 schema 摘要。
- `luker_orch_get_custom_tool` —— 按名字返回某个工具的完整内容（含函数体）。
- `luker_orch_dry_run_custom_tool` —— 在沙箱里编译 + 执行函数体（可传入实参），返回 `{ok, result, error, logs, durationMs}`；硬墙时长 3 秒；`console.log/warn/error` 会被捕获。`name`（跑 profile 上现存工具）或 `body`（编译内联函数体）二选一。
- `luker_ctx_list_keys` / `luker_ctx_describe` —— 枚举 / 钻入运行时 `ctx`（就是 SillyTavern/Luker 扩展通过 `getContext()` 拿到的那个对象）。返回类型 / 函数 arity / 源码预览 / 子键。
- `luker_docs_list` / `luker_docs_read` —— 列出和读取 `docs/` 下的 markdown 文档（默认隐藏 zh-CN / zh-TW 翻译）。推荐起步：`features/orchestrator/custom-tools.md`、`development/extension-api/chat-and-state.md`、`development/extension-api/generation.md`、`development/extension-api/world-info.md`、`development/extension-api/orchestrator-tools.md`。

写工具（在迭代工作台的 ProposalBus 上挂一张待审 card；你不点同意就什么都不会落到 profile）：

- `luker_orch_set_custom_tool` —— 新建或整体覆盖一条工具。挂卡前函数体会做一次编译校验；语法错的话立刻被拒绝、不挂卡。
- `luker_orch_patch_custom_tool_body` —— 对现有函数体做 find/replace 局部补丁（默认要求 `oldString` 命中唯一一处；`replaceAll: true` 才允许多处替换）。补丁后的函数体也会被再次编译校验。微调时优先用它，可避免重新提交大段函数体。
- `luker_orch_patch_custom_tool_schema` —— 只替换参数 JSON-Schema，函数体保持不变。
- `luker_orch_remove_custom_tool` —— 按名字删除一条工具。审阅 card 会把即将被删的函数体显示出来，方便你确认。

每次 `set` 提案被你接受后，迭代工作台会同时把模式对应的启用开关（loop / director 是 `tools.custom.<name>`，agenda 是 `defaultTools.custom.<name>`，spec 是 `spec.defaultTools.custom.<name>`）切到 `true`，这样新工具立刻就会喂给运行时 agent。

来自其他扩展（Layer-2）的工具定义不能在工作台里改——那些定义在注册它们的扩展里，工作台只能切它们的启用开关。

## 相关页面

- [编排器概览](./) —— 通用配置 / 触发时机 / 角色卡绑定
- [AI 迭代工作台](./iteration-studio.md) —— 让 AI 帮你决定工具开关
- [Loop 模式](./loop.md) —— 单 agent 工具循环，是自定义工具最能发挥的地方
- [Director 模式](./director.md) —— 主代理 + 子代理，全部都能调自定义工具
- [编排器工具 API](/zh-CN/development/extension-api/orchestrator-tools) —— 想从自己的扩展注册工具的插件开发者看这里
