# 聊天与状态

读取聊天数据、发送和编辑消息、持久化聊天元数据、按聊天 / 按角色存储状态的相关 API。

## 聊天数据（只读）

以下属性提供当前聊天的只读访问：

| 属性 | 类型 | 说明 |
|------|------|------|
| `context.chat` | `ChatMessage[]` | 当前聊天消息数组 |
| `context.characters` | `Character[]` | 角色列表 |
| `context.groups` | `Group[]` | 群组列表 |
| `context.name1` | `string` | 用户名 |
| `context.name2` | `string` | 角色名 |
| `context.characterId` | `number` | 当前角色 ID |
| `context.groupId` | `string` | 当前群组 ID |
| `context.chat_metadata` | `object` | 当前聊天的元数据 |
| `context.online_status` | `string` | API 连接状态 |

## 在插件请求中读取聊天楼层

自己驱动 LLM 请求的插件（多智能体编排、记忆图整理、迭代重建等）需要把聊天历史变成 prompt 消息。不要自己遍历 `context.chat`：

- **深度很容易算错。** 带 `minDepth` / `maxDepth` 的正则脚本期望的深度是从可用聊天的末尾起算（跳过系统楼层）。手写遍历通常用数组位置当深度——那是另一个数字。
- **裸 `.mes` 会漏涂正则。** 主生成管线在文本进入模型前会把每个楼层都过一遍用户的正则脚本。手写遍历喂给 agent 的是原始文本，而主聊天里看到的是改写后的文本。

### readPluginFloors

```ts
context.readPluginFloors(options?: {
  fromSeq?: number,     // 聊天位置下界（1-based，含）
  toSeq?: number,       // 聊天位置上界（1-based，含）
  fromDepth?: number,   // 计算深度的下界（含）
  toDepth?: number,     // 计算深度的上界（含）
  roles?: string[],     // 默认 ['user', 'assistant']
}): FloorRecord[]
```

把当前聊天读成可直接进 prompt 的楼层记录。只遍历 `context.chat` 一次，每个楼层都带着真实的「距末尾深度」走一遍插件正则通道——脚本上的 `maxDepth` 在这里和在主管线里含义一致。

过滤器决定返回哪些记录；返回的每条记录始终带有下面表格里的全部字段。默认角色白名单会排除系统楼层，与主管线对它们的处理一致。传 `roles: ['user', 'assistant', 'system']` 可以把它们加回来——这类记录的 `depth` 为 `undefined`，因为系统楼层不在深度编号之内。

| 字段 | 类型 | 说明 |
|------|------|------|
| `seq` | `number` | 聊天中的位置（1-based） |
| `sourceIndex` | `number` | `chat` 中的索引（0-based） |
| `depth` | `number \| undefined` | 从聊天末尾起算的深度（0-based），系统楼层被跳过；系统楼层的值为 `undefined` |
| `is_user` | `boolean` | 是否由用户写入 |
| `is_system` | `boolean` | 是否为系统消息 |
| `mesRaw` | `string` | 原始 `.mes` 文本，未做任何处理 |
| `mesCooked` | `string` | 经过插件正则通道后的文本 |

绝大多数场景应该用 `mesCooked`：注入定位跟随作者身份（`is_user` → 用户输入规则，否则 AI 输出规则），插件作用域的正则脚本会在读取时按该楼层的真实聊天深度套用。

### floorRecordToTaskMessage

```ts
context.floorRecordToTaskMessage(record: FloorRecord): {
  role: string,
  content: string,
  sourceFloorIndex: number,
}
```

把记录转换成可传入 [`generateTask`](/zh-CN/development/extension-api/generation) 的 task message。role 由作者标记推导（先看 `is_user` → `'user'`，再看 `is_system` → `'system'`，否则 `'assistant'`），content 取 `mesCooked`。

```js
const ctx = Luker.getContext();

const taskMessages = [
    { role: 'system', content: 'Summarize the conversation so far.' },
    ...ctx.readPluginFloors({ roles: ['user', 'assistant', 'system'] })
        .map(ctx.floorRecordToTaskMessage),
];

const result = await ctx.generateTask({ taskMessages });
```

### 楼层来源标记

转换后消息上的 `sourceFloorIndex` 是一个来源标记：它告诉派发层这段文本已经由 `readPluginFloors` 涂过正则，自己的正则 pass 会跳过这条消息，避免脚本被套用第二次。

这份契约分三部分：

- 读 API 给它产出的每条消息都盖戳——你永远不需要自己计算或维护这个字段
- 派发层识别标记，原样放行带戳消息，并在任何内容发往网络之前剥掉标记
- 插件只负责搬运带戳的消息（重排、过滤、嵌进更大的 payload）；标记在常规的对象操作中自然保留

因此无论数组被派发多少次，每个楼层只会被涂一次正则。

### tool 载荷豁免

派发层的正则 pass 只处理 `role: 'user'` 或 `'assistant'` 且 content 为字符串的消息。工具流量（`tool_result` 等）一律不动。所以嵌进 tool JSON 里的楼层文本保持 `readPluginFloors` 读取时涂好的样子——不会被二次套用，历史经工具重放时也不会有重复涂抹的风险。

响应方向同样无需做任何事：子代理输出经工具信封重新进入 LLM 上下文（例如父 agent 消费子代理的报告）时，核心会在送达前自动完成涂抹。插件侧代码永远不需要自己套正则。

### 哪些正则规则在哪条通道生效

规则的生效范围在两条通道之间划分得很干净：

- `promptOnly` 规则绝不会出现在插件请求中——它们只在主生成管线内生效
- `pluginOnly` 规则**只**出现在插件请求中——主管线看不到它们

两个标记都没勾的规则对哪条通道都不生效——它改写的是存储的聊天历史本身，在消息编辑或保存时套用。

## 消息 API

Luker 提供了统一的高层消息操作 API。每个操作都是完整的一条龙流程：内存更新 + DOM 渲染 + 事件触发 + 持久化。

### addMessages

```ts
addMessages(
 messages: ChatMessage | ChatMessage[],
 options?: { scroll?: boolean, silent?: boolean }
): Promise<number | number[]>
```

添加一条或多条消息到聊天中。

- 自动 push 到 `chat[]`、渲染 DOM、触发 `MESSAGE_SENT`/`MESSAGE_RECEIVED` 和 `MESSAGE_RENDERED` 事件、持久化到后端
- 传入数组时批量操作，只触发一次持久化
- 返回新消息的索引（单条返回 `number`，批量返回 `number[]`）

```js
// 添加单条消息
const index = await context.addMessages({
 name: 'System',
 mes: '这是一条系统消息',
 is_system: true,
});

// 批量添加
const indices = await context.addMessages([
 { name: 'User', mes: '你好', is_user: true },
 { name: 'Assistant', mes: '你好！有什么可以帮你的？', is_user: false },
]);
```

### updateMessages

```ts
updateMessages(
 updates: { index: number, patch: object } | { index: number, patch: object }[],
 options?: { rerender?: boolean, silent?: boolean }
): Promise<void>
```

更新一条或多条消息的内容并持久化。

- `patch` 对象的字段会合并到 `chat[index]` 中
- 自动重渲染 DOM、触发 `MESSAGE_EDITED` 和 `MESSAGE_UPDATED` 事件、通过 RFC 6902 增量持久化
- 批量操作时合并为一次持久化调用

```js
// 更新单条消息
await context.updateMessages({
 index: 4,
 patch: { mes: '修改后的内容' },
});

// 批量更新
await context.updateMessages([
 { index: 3, patch: { mes: '新内容 A' } },
 { index: 5, patch: { mes: '新内容 B', extra: { model: 'gpt-4o' } } },
]);
```

### deleteMessages

```ts
deleteMessages(
 index: number | number[],
 options?: { swipe?: number, silent?: boolean }
): Promise<ChatMessage | ChatMessage[]>
```

删除一条或多条消息。

- 自动从 `chat[]` 移除、清理 DOM、触发 `MESSAGE_DELETED` 事件、通过 RFC 6902 增量持久化
- 批量删除时自动处理索引偏移
- 指定 `swipe` 选项时，只删除该消息的特定 swipe 而非整条消息
- 返回被删除的消息对象

```js
// 删除单条消息
const deleted = await context.deleteMessages(5);

// 批量删除
const deletedList = await context.deleteMessages([3, 5, 7]);

// 只删除特定 swipe
await context.deleteMessages(5, { swipe: 2 });
```

### getMessage

```ts
getMessage(index: number): Readonly<ChatMessage> | null
```

获取指定索引的消息（只读）。返回一个 Proxy 对象，尝试修改属性会抛出错误并引导使用 `updateMessages()`。

### getMessageCount

```ts
getMessageCount(): number
```

返回当前聊天的消息总数。

### sendTextareaMessage

```ts
sendTextareaMessage(): Promise<void>
```

像「用户在消息文本框里打了字然后按了发送」一样，程序化触发用户侧发送管道。会发送文本框里现有内容（先 `$('#send_textarea').val(...)` 喂入），然后跑标准生成流程。发送完成时解析。

---

::: warning 已弃用的底层 API
以下函数仍然可用但已标记为 deprecated，插件开发者应使用上述统一 API：

- `addOneMessage()` → 使用 `addMessages()`
- `deleteLastMessage()` → 使用 `deleteMessages(chat.length - 1)`
- `deleteMessage()` → 使用 `deleteMessages()`
- `updateMessageBlock()` → 使用 `updateMessages()`
- `patchChatMessages()` → 底层 RFC 6902 传输层，使用 `updateMessages()` / `deleteMessages()`
- `appendChatMessages()` → 底层追加传输层，使用 `addMessages()`
:::

## 聊天持久化

### saveChatMetadata

```ts
saveChatMetadata(withMetadata?: object): Promise<boolean>
```

保存聊天元数据。如果传入 `withMetadata`，会先合并到 `chat_metadata` 再保存。

## 聊天状态

聊天状态是 Luker 新增的聊天绑定状态机制，让插件可以将结构化数据绑定到特定聊天，而不是塞进 `chat_metadata`。

### getChatState

```ts
getChatState(
  namespace: string,
  options?: { target?: ChatTarget }
): Promise<
  | { ok: true, state: object | null }
  | { ok: false, state: null, reason: string, hint: string }
>
```

读取指定命名空间的聊天状态。成功时返回 `{ok: true, state}`，其中 `state` 是存储的值，命名空间无数据时为 `null`。失败时返回 `{ok: false, state: null, reason, hint}` —— 见下方[错误原因](#错误原因)。

- `namespace`：插件的唯一标识符，建议使用插件名
- `target`：可选，指定目标聊天（用于跨聊天读取，如分支场景）

### getChatStateBatch

```ts
getChatStateBatch(
  namespaces: string[],
  options?: { target?: ChatTarget }
): Promise<
  | { ok: true, results: Map<string, { ok: true, state: object | null }> }
  | { ok: false, results: Map<string, never>, reason: string, hint: string }
>
```

批量读取多个命名空间的聊天状态。成功时返回 `{ok: true, results}`，其中 `results` 是以命名空间为键的 `Map`，每条目本身是 `{ok: true, state}`，缺失的命名空间对应 `{ok: true, state: null}`。失败（无活动聊天、传输错误、HTTP 错误）时返回 `{ok: false, results: <空 Map>, reason, hint}`。

### updateChatState

```ts
updateChatState(
  namespace: string,
  updater: (current: any) => any,
  options?: { target?: ChatTarget }
): Promise<
  | { ok: true, state: object | null, updated: boolean }
  | { ok: false, reason: string, hint: string }
>
```

**推荐的读-改-写方式。** `updater` 函数接收当前状态，返回新状态。系统会自动处理并发冲突（默认对 `CONFLICT` 重试一次）。成功时返回 `{ok: true, state, updated}`，当 reducer 返回 `null`/`undefined` 或未产生 diff 时 `updated` 为 `false`。失败时返回 `{ok: false, reason, hint}` —— 见下方[错误原因](#错误原因)。该函数永不抛出；reducer 内部抛出的异常会被捕获并以 `reason: 'VALIDATION_ARGS'` 形式上报。

```js
await context.updateChatState('my-plugin', (current = {}) => ({
  ...current,
  counter: (current.counter || 0) + 1,
  lastUpdated: Date.now(),
}));
```

### deleteChatState

```ts
deleteChatState(
  namespace: string,
  options?: { target?: ChatTarget }
): Promise<{ ok: true } | { ok: false, reason: string, hint: string }>
```

删除指定命名空间的聊天状态。成功时返回 `{ok: true}`；失败时返回 `{ok: false, reason, hint}` —— 见下方[错误原因](#错误原因)。

### 最佳实践

- 使用 `updateChatState()` 进行读-改-写，而非手动链式调用 `getChatState()` + `patchChatState()`
- 保持 payload 为可 JSON 序列化的纯对象
- 处理 `ok: false` 返回值，保持插件 UI 的弹性 —— 按 `reason` 分支处理，不要翻译 `hint`（见[错误原因](#错误原因)）
- 对于大型插件数据，优先使用聊天状态而非 `chat_metadata`
- 如果状态需要随 swipe、删消息、切换聊天自动跟进，请使用 [楼层状态](#楼层状态)，而不是在 `updateChatState` 之上自己写对账逻辑

### 错误原因

每次写入失败都会返回 `{ok: false, reason, hint}`。`reason` 字段是以下九个值之一：

| Reason | 触发时机 | 建议处理 |
|---|---|---|
| `VALIDATION_ARGS` | 参数错误（命名空间为空、updater 非函数、reducer 抛错） | 修正调用方 —— 这是程序员 bug |
| `VALIDATION_TARGET` | 无活动聊天 | 静默跳过写入，等用户打开聊天后再试 |
| `VALIDATION_COMMIT` | 仅楼层状态：override 违反单调性、提交结构非法、floor 越界 | 调用方的 `floor` 参数有误，重新计算后再发 |
| `INSTANCE_DESTROYED` | 楼层状态实例已被销毁 | 重新加载聊天或重建实例 |
| `CONFLICT` | 重试后仍是 HTTP 409 | 重新读取当前状态后再试 |
| `HTTP_ERROR` | 其他非 2xx 响应 | 检查 `hint` 中的状态码，可以面向用户弹 toast |
| `TRANSPORT_ERROR` | fetch 抛错（网络、CORS、abort） | 重试或向用户展示网络错误 |
| `REPLAY_BROKEN` | 仅楼层状态：日志重放失败且恢复也失败 | 数据无法恢复，建议用户重置后重建 |
| `LOG_WRITE_FAILED` | 仅楼层状态：私有日志写入被拒 | 与 `hint` 中嵌入的底层聊天状态失败原因相同 |

`hint` 字段是英文、不超过 120 字符的可操作诊断信息。它不会被本地化 —— 面向用户的本地化文案请根据 `reason` 切换，而不是翻译 `hint`。

示例：

```js
const result = await context.updateChatState('my-ext', (cur) => ({ ...cur, x: 1 }));
if (!result.ok) {
    switch (result.reason) {
        case 'CONFLICT':
            toastr.warning(t('保存时与其他写入冲突，请重试。'));
            break;
        case 'HTTP_ERROR':
        case 'TRANSPORT_ERROR':
            toastr.error(t('无法连接服务器，更改未保存。'));
            break;
        case 'VALIDATION_TARGET':
            // 无活动聊天；静默跳过。
            break;
        default:
            console.warn('[my-ext] 保存失败：', result.reason, result.hint);
    }
    return;
}
```

## 楼层状态

楼层状态在聊天状态之上加了一层薄封装：每次写入都会附带聊天尾部的位置（楼层索引 + swipe 编号）记到日志里，聊天结构变化时自动重放幸存提交。需要让状态跟着 swipe、删消息、切换聊天而不用手动对账的插件或 CardApp，应该用这套 API 而不是直接调用 `updateChatState`。

### 工作方式

一个楼层状态实例独占一个聊天状态命名空间（`<ns>`）以及一份私有提交日志（`<ns>__floor_log`）。所有写入都通过实例的 `update` 方法进入：它读取当前状态、运行你的 reducer、计算差异、把差异写入业务命名空间并追加一条提交。每个实例创建时会注册到 `floor-state.js` 内部的实例表；聊天结构发生变化时，core 代码会先把所有已注册实例同步推平到对应的处理器，**然后**才触发对应的 `eventSource` 事件通知插件订阅者——任何插件在监听器里读取楼层状态都能看到已经 settle 完的数据。四种结构性转换是：

- `CHAT_CHANGED`——切换到新聊天，按这份聊天的日志重建数据
- `MESSAGE_SWIPED`——用户切换 swipe，按新的活动 swipe 重建数据
- `MESSAGE_DELETED`——聊天截短，丢弃楼层超出新长度的提交后重建
- `MESSAGE_SWIPE_DELETED`——聊天尾部某个 swipe 被删除，相关楼层的提交重新编号后重建

每条提交存的是「提交时刻 materialized 状态 → 下一份状态」的增量 diff。重建按写入顺序遍历所有提交，丢弃 `(floor, swipeId)` 已不在当前活动 swipe 上的提交，然后把幸存的 patch 依次应用在 `{}` 上。删除事件都只发生在尾部——`MESSAGE_DELETED` 只截尾部、`MESSAGE_SWIPE_DELETED` 也只在聊天尾部触发——所以活动路径上的幸存提交始终是连续的链，增量 patch 正确组合。

### createFloorState

```ts
createFloorState(options: { namespace: string }): Promise<FloorStateInstance>
```

在插件或 CardApp 里使用 `getContext().createFloorState({ namespace })`。每个实例绑定一个命名空间；如果业务状态分多块，请创建多个实例。

所有执行写入的实例方法（`update`、`patch`、`reset`、`destroy({ purge: true })`）和读取方法（`get`）都返回一个 envelope —— 它们永不抛出。检查 `result.ok` 并根据 `result.reason` 切换处理失败模式，见[错误原因](#错误原因-1)。

```js
const ctx = SillyTavern.getContext();
const fs = await ctx.createFloorState({ namespace: 'my-plugin' });

// 推荐：reducer 风格写入。reducer 收到当前状态、返回下一份状态，差异自动算完并提交。
// 成功时返回 {ok: true, updated}，失败时返回 {ok: false, reason, hint}。
const writeResult = await fs.update((current) => ({ ...current, score: 10 }));
if (!writeResult.ok) {
    console.warn('[my-plugin] 楼层写入失败：', writeResult.reason, writeResult.hint);
}
await fs.update((current) => ({ ...current, level: (current?.level ?? 0) + 1 }));
await fs.update((current) => {
    const { temp, ...rest } = current ?? {};
    return rest;
});

// 读取当前状态。成功时返回 {ok: true, state}，失败时返回 {ok: false, state: null, reason, hint}。
const readResult = await fs.get();
const state = readResult.ok ? readResult.state : null;

// 在读取之前等待重建或写入完成：
await fs.ready();

// 从注册表里移除（极少需要，实例通常和页面同寿）：
fs.destroy();

// 抹除该命名空间的状态并从注册表移除。返回 {ok, reason?, hint?}。
await fs.destroy({ purge: true });
```

::: warning
reducer 必须返回普通对象。返回数组、基础类型、`null`、`undefined` 一律视作「无变化」，调用直接返回 `{ok: true, updated: false}`（不写入）。
:::

::: warning 行为变更（2026-06-28）
`fs.update` reducer 内部抛出的异常现在会被捕获并以 `{ok: false, reason: 'VALIDATION_ARGS', hint: 'reducer threw: ...'}` 形式返回，而不再向上冒泡。原本依赖异常抛出的插件代码需要改为检查 `result.ok` 与 `result.hint`。
:::

### 整盘替换日志（导入 / 重建）

`update` 和 `patch` 都是 append-only——每次调用都在现有历史末尾追加一条提交。当你要整盘替换历史（导入备份、从聊天重建、重置到已知基线）时，请用 `reset(commits)`：

```js
// 用这组提交原子性替换整段日志。
const result = await fs.reset([
    { floor: 0, swipeId: 0, patches: [{ op: 'add', path: '/intro', value: '...' }] },
    { floor: 3, swipeId: 0, patches: [{ op: 'add', path: '/scene', value: '...' }] },
]);
if (!result.ok) {
    // result.reason 是 VALIDATION_ARGS / VALIDATION_COMMIT / LOG_WRITE_FAILED / ... 之一
    // 校验失败（提交结构非法、floor 越出当前聊天范围）或底层写被拒绝，日志保持原状。
    console.warn('[my-plugin] reset 被拒绝：', result.reason, result.hint);
}

// 传空数组等于清空日志。
await fs.reset([]);
```

每条提交都按 `patch` 同样的结构校验（`floor` 与 `swipeId` 是非负整数、`patches` 是非空数组），外加 `floor < chat.length` 的范围检查。任意一条不合规就整批拒绝——日志绝不会落到「半合规」状态。没有独立的 data 命名空间要同步：下一次 `get()` 会按新日志重新重放，进程内 cache 自动失效。

### 把状态挂到非尾部的楼层

`update` 接受一个可选的第二参数 `{ floor, swipeId? }`，用来把这次提交显式挂到指定楼层而不是聊天尾部。常见场景是「滞后写入」——比如记忆扩展在用户设置了「最后 N 层不参与生成」时，需要把摘要挂到 `chat.length - N` 而不是当前最新楼层。

```js
// 只指定 floor：swipeId 自动取 chat[floor].swipe_id
await fs.update(
    (current) => ({ ...current, summaries: { ...(current?.summaries ?? {}), 0: '...' } }),
    { floor: targetFloor },
);

// 同时指定 floor + swipeId（用于回填某条具体 swipe 上的状态）
await fs.update((current) => nextState, { floor: targetFloor, swipeId: 0 });
```

不传 `options` 时按聊天尾部推断。`floor` 必须是当前 `chat` 的有效索引（`0 <= floor < chat.length`），越界、负数、非整数、负 `swipeId` 都会被拒绝并返回 `{ok: false, reason: 'VALIDATION_COMMIT', hint}`，避免悄无声息地把状态错挂到不存在的楼层。

::: tip
覆写只影响这条提交在日志里的标签——`MESSAGE_DELETED` 仍按 floor 截断，`MESSAGE_SWIPE_DELETED` 仍按 （floor， swipeId） 重编号。重建顺序由日志的写入顺序决定，不会因为你指定了较小的 `floor` 就被「插队」到前面执行。
:::

### 进阶：预先算好的 patch

如果你已经手上有一份针对当前 materialized 状态的增量 RFC 6902 diff——比如出于性能考虑自己算了 diff、或者在跑一次性迁移——可以调 `instance.patch(operations, options?)` 直接追加。operations 必须是 `buildObjectPatchOperationsAsync(prev, next)` 形式的增量 diff，prev 取自 `await fs.get()`；不能传「整盘覆写」式的 snapshot patch，因为重建假设每条提交的 patch 跟前面幸存提交的 patch 顺序组合。

其他场景一律走 `update`——它会帮你算好 diff。

### buildObjectPatchOperationsAsync

```ts
context.buildObjectPatchOperationsAsync(
    previousState: object,
    nextState: object,
    options?: object,
): Promise<RFC6902Operation[]>
```

驱动 Luker patch-first 持久化的 diff 引擎。回传把 `previousState` 变成 `nextState` 的最小 RFC 6902 操作。需要给 `instance.patch()` 喂一份预先算好的 diff 时用。同一个引擎内部驱动聊天持久化、聊天状态、楼层状态、预设状态——直接调它能让插件代码加入同一份增量保存管道。

### 何时要 `await ready()`

四种结构性转换由 core 在对应 `eventSource` 事件触发**之前**同步推平。所以插件在 `MESSAGE_DELETED` / `MESSAGE_SWIPED` / `MESSAGE_SWIPE_DELETED` / `CHAT_CHANGED` / `CHAT_BRANCH_CREATED` 监听器里读楼层状态时，看到的一定是已 settle 完的数据，**不需要** `ready()`。

`ready()` 现在主要用于跟可能并发的 `update` / `patch` in-flight 写入串行化。没有重建或写入在进行时，这个 Promise 立即解决，开销可以忽略。

### 约定

- 一个命名空间一个主人。不要在同一个命名空间上同时用 `updateChatState(ns, ...)` 和 `floorState.update(...)`——重建时会把直接写入的部分覆盖掉。
- 名字以 `__floor_log` 结尾的命名空间留给楼层状态的私有日志，不要占用。
- reducer 必须返回普通对象。数组、基础类型、`null`、`undefined` 一律忽略。

### 参考

- `createFloorState({ namespace })`——异步工厂，返回冻结的实例。
- `instance.update(reducer, options?): Promise<{ok: true, updated: boolean} | {ok: false, reason, hint}>`——读—改—写；reducer 收到当前状态、返回下一份状态，差异自动算完并提交。可选的 `options = { floor, swipeId? }` 把提交挂到指定楼层而非聊天尾部。**这是推荐的写入 API。**
- `instance.patch(operations, options?): Promise<{ok: true, updated: boolean} | {ok: false, reason, hint}>`——进阶：追加一条「自己已经算好 patch」的提交。operations 必须是相对 `await instance.get()` 的增量 RFC 6902 diff（`buildObjectPatchOperationsAsync(prev, next)`），不能是整盘覆写式 snapshot。`options` 与 `update` 相同。
- `instance.reset(commits): Promise<{ok: true} | {ok: false, reason, hint}>`——原子性整盘替换日志为给定提交列表。用于导入 / 重建 / 重置类工作流。每条提交都会被校验，任意一条结构非法或 `floor` 越界，整批拒绝。
- `instance.get(): Promise<{ok: true, state} | {ok: false, state: null, reason, hint}>`——读取当前 materialized 状态。按需对日志做重放（以当前 swipe map 为准），不读独立的 data 命名空间。
- `instance.ready(): Promise<void>`——所有在飞写入完成时解决。
- `instance.destroy(options?): Promise<{ok: true} | {ok: false, reason, hint}>`——从注册表移除实例。传 `{ purge: true }` 时同时把该命名空间的状态从磁盘抹除（用于永久重置 / 抹除场景）。不带 `purge` 调用时，同步的注销路径也返回 envelope 以保持一致。

### 错误原因

每次写入失败都会返回 `{ok: false, reason, hint}`。`reason` 字段是以下九个值之一：

| Reason | 触发时机 | 建议处理 |
|---|---|---|
| `VALIDATION_ARGS` | 参数错误（命名空间为空、updater 非函数、reducer 抛错） | 修正调用方 —— 这是程序员 bug |
| `VALIDATION_TARGET` | 无活动聊天 | 静默跳过写入，等用户打开聊天后再试 |
| `VALIDATION_COMMIT` | 仅楼层状态：override 违反单调性、提交结构非法、floor 越界 | 调用方的 `floor` 参数有误，重新计算后再发 |
| `INSTANCE_DESTROYED` | 楼层状态实例已被销毁 | 重新加载聊天或重建实例 |
| `CONFLICT` | 重试后仍是 HTTP 409 | 重新读取当前状态后再试 |
| `HTTP_ERROR` | 其他非 2xx 响应 | 检查 `hint` 中的状态码，可以面向用户弹 toast |
| `TRANSPORT_ERROR` | fetch 抛错（网络、CORS、abort） | 重试或向用户展示网络错误 |
| `REPLAY_BROKEN` | 仅楼层状态：日志重放失败且恢复也失败 | 数据无法恢复，建议用户重置后重建 |
| `LOG_WRITE_FAILED` | 仅楼层状态：私有日志写入被拒 | 与 `hint` 中嵌入的底层聊天状态失败原因相同 |

`hint` 字段是英文、不超过 120 字符的可操作诊断信息。它不会被本地化 —— 面向用户的本地化文案请根据 `reason` 切换，而不是翻译 `hint`。

示例：

```js
const result = await fs.update((cur) => ({ ...cur, score: (cur?.score ?? 0) + 1 }));
if (!result.ok) {
    switch (result.reason) {
        case 'CONFLICT':
            toastr.warning(t('保存时与其他写入冲突，请重试。'));
            break;
        case 'HTTP_ERROR':
        case 'TRANSPORT_ERROR':
            toastr.error(t('无法连接服务器，更改未保存。'));
            break;
        case 'REPLAY_BROKEN':
            toastr.error(t('楼层状态日志无法恢复，请重置后重建。'));
            break;
        case 'INSTANCE_DESTROYED':
            // 实例已被销毁，如仍需使用请用 createFloorState() 重建。
            break;
        default:
            console.warn('[my-ext] 楼层写入失败：', result.reason, result.hint);
    }
    return;
}
```

### resolveChatStateTarget

```ts
context.resolveChatStateTarget(target?: { chatId?: string, characterId?: number | string } | null): { chatId: string, characterId: number | string } | null
```

把 chat-state target 描述符按当前活跃聊天做归一化。传 `null`（或省略）拿到当前聊天的 `{ chatId, characterId }`；传部分对象则用提供的字段覆盖，另一字段从活跃状态填补。没有活跃聊天且 `target` 缺 `chatId` 时返回 `null`。

实现「默认跟随活跃聊天但允许程序化指定目标」的存储层时使用（例如 floor-state、chat-state API）。

## 角色状态

角色状态是绑定到角色卡本身的持久化存储，在该角色的所有聊天之间共享。与聊天状态（仅在单个聊天内有效）不同，角色状态适合存储跨聊天的角色级别配置。

::: warning 行为变更（2026-06-28）
角色状态 API 在 HTTP 失败时不再抛出异常，改为返回 `{ok, state, reason, hint}` envelope（与聊天状态一致）。如果你的插件原本写了 `try { await ctx.getCharacterState(...) } catch (e) { ... }`，请改用 `if (!result.ok) { ... }`。
:::

### getCharacterState

```ts
getCharacterState(
  avatar: string,
  namespace: string,
): Promise<
  | { ok: true, state: any }
  | { ok: false, state: null, reason: string, hint: string }
>
```

读取指定头像和命名空间下的角色状态。成功时返回 `{ok: true, state}`，其中 `state` 是存储的值，命名空间无数据时为 `null`。失败时返回 `{ok: false, state: null, reason, hint}` —— 见下方[错误原因](#错误原因-2)。

| 参数 | 说明 |
|------|------|
| `avatar` | 角色头像文件名（例如 `'tavernkeeper.png'`） |
| `namespace` | 存储命名空间，通常使用插件名称（如 `'my-extension'`） |

### getCharacterStateBatch

```ts
getCharacterStateBatch(
  avatar: string,
  namespaces: string[],
): Promise<
  | { ok: true, results: Map<string, { ok: true, state: any }> }
  | { ok: false, results: Map<string, never>, reason: string, hint: string }
>
```

单次请求批量读取多个角色状态命名空间。成功时返回 `{ok: true, results}`，其中 `results` 是以命名空间为键的 `Map`，每条目本身是 `{ok: true, state}`，缺失的命名空间对应 `{ok: true, state: null}`。失败时返回 `{ok: false, results: <空 Map>, reason, hint}`。

### setCharacterState

```ts
setCharacterState(
  avatar: string,
  namespace: string,
  data: any,
): Promise<
  | { ok: true, state: any }
  | { ok: false, reason: string, hint: string }
>
```

以整份覆盖的方式写入指定命名空间下的角色状态。传入 `null` 作为 `data` 可以删除该命名空间的状态。非平凡负载请优先用 `updateCharacterState` —— `setCharacterState` 每次都会把整份文档上网。成功时返回 `{ok: true, state}` 回显存储的值；失败时返回 `{ok: false, reason, hint}`。

| 参数 | 说明 |
|------|------|
| `avatar` | 角色头像文件名 |
| `namespace` | 存储命名空间 |
| `data` | 要存储的数据（任意可序列化对象），传 `null` 删除 |

### updateCharacterState

```ts
updateCharacterState(
  avatar: string,
  namespace: string,
  updater: (currentState: object, meta: { attempt: number, avatar: string, namespace: string })
    => object | null | undefined | Promise<object | null | undefined>,
  options?: { maxOperations?: number, maxRetries?: number, asyncDiff?: boolean },
): Promise<
  | { ok: true, state: object | null, updated: boolean, created?: boolean }
  | { ok: false, reason: string, hint: string }
>
```

**推荐的读—改—写接口。** `updater` 取得当前状态（不存在时为 `{}`），返回下一份状态。系统底层自动计算最小增量 patch，只有变化的那部分上网。返回 `null` / `undefined` 视为「无变更」。409 冲突（并发改动）会自动重试；重试预算由 `options.maxRetries` 控制（默认 1）。该函数永不抛出；reducer 内部抛出的异常会被捕获并以 `reason: 'VALIDATION_ARGS'` 形式上报。

```js
await context.updateCharacterState(character.avatar, 'my-plugin', (current = {}) => ({
  ...current,
  counter: (current.counter || 0) + 1,
  lastUpdated: Date.now(),
}));
```

### deleteCharacterState

```ts
deleteCharacterState(
  avatar: string,
  namespace: string,
): Promise<{ ok: true } | { ok: false, reason: string, hint: string }>
```

删除指定命名空间的角色状态 sidecar。幂等 —— sidecar 不存在时也会成功返回。语义等价于 `setCharacterState(avatar, namespace, null)`，提供给希望使用显式删除动词的调用方。成功时返回 `{ok: true}`，失败时返回 `{ok: false, reason, hint}`。

### 最佳实践

- 优先用 `updateCharacterState()`，不要手动串 `getCharacterState()` + `setCharacterState()` —— helper 只发 diff，并替你处理 409 重试。
- `setCharacterState()` 只用于首次初始化或确实想整份替换 sidecar 的场景。
- 负载保持为可 JSON 序列化的普通对象；顶层数组或基本类型不支持。
- 检查 `result.ok` 并根据 `result.reason` 切换处理 —— 这些 API 不再在 HTTP 失败时抛出异常（见上方行为变更与[错误原因](#错误原因-2)）。

### 错误原因

每次写入失败都会返回 `{ok: false, reason, hint}`。`reason` 字段是以下九个值之一：

| Reason | 触发时机 | 建议处理 |
|---|---|---|
| `VALIDATION_ARGS` | 参数错误（avatar / 命名空间为空、updater 非函数、reducer 抛错） | 修正调用方 —— 这是程序员 bug |
| `VALIDATION_TARGET` | 无活动聊天（仅聊天状态；角色状态写入不要求活动聊天） | 静默跳过写入，等用户打开聊天后再试 |
| `VALIDATION_COMMIT` | 仅楼层状态：override 违反单调性、提交结构非法、floor 越界 | 调用方的 `floor` 参数有误，重新计算后再发 |
| `INSTANCE_DESTROYED` | 楼层状态实例已被销毁 | 重新加载聊天或重建实例 |
| `CONFLICT` | 重试后仍是 HTTP 409 | 重新读取当前状态后再试 |
| `HTTP_ERROR` | 其他非 2xx 响应 | 检查 `hint` 中的状态码，可以面向用户弹 toast |
| `TRANSPORT_ERROR` | fetch 抛错（网络、CORS、abort） | 重试或向用户展示网络错误 |
| `REPLAY_BROKEN` | 仅楼层状态：日志重放失败且恢复也失败 | 数据无法恢复，建议用户重置后重建 |
| `LOG_WRITE_FAILED` | 仅楼层状态：私有日志写入被拒 | 与 `hint` 中嵌入的底层聊天状态失败原因相同 |

`hint` 字段是英文、不超过 120 字符的可操作诊断信息。它不会被本地化 —— 面向用户的本地化文案请根据 `reason` 切换，而不是翻译 `hint`。

示例：

```js
const result = await context.updateCharacterState(character.avatar, 'my-ext', (cur) => ({ ...cur, x: 1 }));
if (!result.ok) {
    switch (result.reason) {
        case 'CONFLICT':
            toastr.warning(t('保存时与其他写入冲突，请重试。'));
            break;
        case 'HTTP_ERROR':
        case 'TRANSPORT_ERROR':
            toastr.error(t('无法连接服务器，更改未保存。'));
            break;
        case 'VALIDATION_ARGS':
            // 程序员 bug —— avatar/命名空间为空或 reducer 抛错。
            console.error('[my-ext] 参数错误：', result.hint);
            break;
        default:
            console.warn('[my-ext] 保存失败：', result.reason, result.hint);
    }
    return;
}
```

### 角色状态 vs 聊天状态

| | 角色状态 | 聊天状态 |
|------|------|------|
| 作用范围 | 绑定到角色卡，所有聊天共享 | 绑定到单个聊天 |
| 典型用途 | 角色级别的插件配置、CardApp 应用状态 | 聊天内的临时数据、对话上下文 |
| API | `getCharacterState` / `getCharacterStateBatch` / `setCharacterState` / `updateCharacterState` / `deleteCharacterState` | `getChatState` / `getChatStateBatch` / `updateChatState` / `deleteChatState` |
| 存储位置 | 卡片旁边的状态文件 | 聊天元数据 |

## 聊天生命周期

### getCurrentChatId

```ts
getCurrentChatId(): string | undefined
```

返回当前聊天的文件名（不带 `.jsonl`）。群组聊天返回群组的 `chat_id`，独立角色返回 `characters[characterId].chat`。无角色或群组被选中时返回 `undefined`。

### reloadCurrentChat

```ts
reloadCurrentChat(): Promise<void>
```

从磁盘重新加载当前聊天。带互斥锁——并发调用会被串行化，可以从多个事件处理器安全调用。

### renameChat

```ts
renameChat(oldFileName: string, newName: string): Promise<void>
```

重命名聊天文件。`newName` 应不带 `.jsonl` 扩展名传入。

### openCharacterChat

```ts
openCharacterChat(fileName: string): Promise<void>
```

切换到当前角色的另一个聊天。会先清空当前聊天数据。

### closeCurrentChat

```ts
closeCurrentChat(): Promise<boolean>
```

关闭当前聊天，返回角色列表。返回 `true` 表示成功，`false` 表示生成正在进行且用户拒绝中断。

### doNewChat

```ts
doNewChat(options?: { deleteCurrentChat?: boolean }): Promise<void>
```

为当前角色创建一个全新的聊天。当 `deleteCurrentChat: true` 时会删除之前活跃的聊天文件 — 谨慎使用，这是破坏性操作。

### getPastCharacterChats

```ts
getPastCharacterChats(characterId?: number): Promise<Array<{
    file_name: string,    // 含 ".jsonl" — 想拿 chat id 用 path.parse(name).name 取
    file_id: string,      // 不带 ".jsonl" 的 basename;openCharacterChat 期望这种形式
    file_size: string,    // 格式化后的大小(如 "12.3 KB")
    mes: string,          // 第一条消息预览
    last_mes: number,     // 最后修改时间戳(ms)
}>>
```

列出某个角色已有的全部聊天。`characterId` 省略时默认为当前角色（`this_chid`）。`file_id` 字段是应用层 chat 标识符 — 把它传回 `openCharacterChat` / `deleteCharacterChat` / `renameChat`（这些函数期望不带 `.jsonl` 后缀的名字）。

### deleteCharacterChat

```ts
deleteCharacterChat(characterId: string, fileName: string): Promise<void>
```

永久删除指定角色的某个历史聊天。`fileName` 是 chat id（不带后缀）；末尾若带 `.jsonl` 会被自动剥除。

### openGroupChat

```ts
openGroupChat(groupId: string, chatId: string): Promise<void>
```

切换到群组中的特定聊天。

### saveChat

```ts
saveChat(): Promise<void>
```

如果当前没有正在保存，则把当前聊天写入磁盘。会等待短暂时间窗口让正在进行的保存完成，再触发自己的保存。大多数插件不需要调用——[消息 API](#消息-api) 会自动持久化。

### saveChatDebounced

```ts
saveChatDebounced(): void
```

安排一次聊天保存，触发后等 1 秒空档再真正落盘；窗口内重复调用会合并成一次保存。适合连续编辑的场景批量持久化，例如一条消息陆续插入多张生成图片时，每张图都调一次也只会落盘一次。同步返回，实际保存在后台经由 [`saveChat`](#savechat) 执行。

### printMessages

```ts
printMessages(options?: { clear?: boolean }): Promise<void>
```

从内存中的 `chat` 数组重新渲染聊天 DOM。在消息 API 之外执行了大规模聊天变更后使用。

### clearChat

```ts
clearChat(options?: { clearData?: boolean }): Promise<void>
```

清空已渲染的消息。`clearData: true` 时还会清空内存中的 `chat` 数组并重置 `extensionPrompts`。

### sendSystemMessage

```ts
sendSystemMessage(type: string, text?: string, extra?: object): void
```

向聊天插入一条系统消息。`type` 必须是系统消息类型之一（`HELP`、`WELCOME`、`EMPTY`、`GENERIC`、`NARRATOR`、`COMMENT`、`SLASH_COMMANDS`、`FORMATTING`、`HOTKEYS`、`MACROS`、`WELCOME_PROMPT`、`ASSISTANT_NOTE`、`ASSISTANT_MESSAGE`）。

```js
ctx.sendSystemMessage('GENERIC', 'Plugin loaded successfully.');
```

## 扩展 Prompt（深度注入）

扩展 prompt 让插件能在 prompt 的特定位置和深度注入文本。它们在 prompt 组装阶段被求值，对每次生成请求都生效。

### setExtensionPrompt

```ts
setExtensionPrompt(
    key: string,
    value: string,
    position: number,
    depth: number,
    scan?: boolean,
    role?: number,
    filter?: () => boolean | Promise<boolean>,
): void
```

| 参数 | 说明 |
|------|------|
| `key` | 该 prompt 槽位的唯一标识。重复使用 key 会覆盖 |
| `value` | 要注入的文本。传 `''` 移除 |
| `position` | `0` = 故事字符串之后（BEFORE_PROMPT），`1` = 在聊天的 `depth` 处（IN_CHAT），`2` = 聊天之后（IN_PROMPT） |
| `depth` | `position === 1` 时距离聊天尾部的距离。`0` = 最后一条消息之后 |
| `scan` | 为 `true` 时该 prompt 文本会参与世界书扫描 |
| `role` | 说话人角色（`0` = system，`1` = user，`2` = assistant） |
| `filter` | 可选的门控；存在且返回 falsy 时跳过该 prompt |

```js
const ctx = Luker.getContext();

ctx.setExtensionPrompt(
    'my-plugin-context',
    'You have access to a calculator tool.',
    1,                  // IN_CHAT
    0,                  // depth：在最后一条消息之后插入
    false,              // 不参与 WI 扫描
    0,                  // SYSTEM 角色
);

// 移除该 prompt
ctx.setExtensionPrompt('my-plugin-context', '');
```

### extensionPrompts

```ts
context.extensionPrompts: Record<string, ExtensionPrompt>
```

当前已注册扩展 prompt 的只读视图。每次 `clearChat` 调用时该 map 会被重置为 `{}`。

## Swipe API

插件可以以编程方式驱动 swipe 导航并检视 swipe 状态。

```ts
context.swipe.left(event?, options?): Promise<void>
context.swipe.right(event?, options?): Promise<void>
context.swipe.to(event, direction, options?): Promise<void>
context.swipe.show(): void
context.swipe.hide(options?: { hideCounters?: boolean }): void
context.swipe.refresh(updateCounters?: boolean, fade?: boolean): void
context.swipe.isAllowed(): boolean
context.swipe.state(): SwipeState
```

| 方法 | 说明 |
|------|------|
| `left` / `right` | 朝指定方向滑动（event 参数可选，仅在 UI 集成时有意义） |
| `to` | 通用滑动；`direction` 为 `SWIPE_DIRECTION.LEFT` / `RIGHT`。支持 `forceMesId`、`forceSwipeId`、`forceDuration` 覆盖 |
| `show` / `hide` | 切换滑动按钮可见性 |
| `refresh` | 重新计算每条消息的滑动控件 |
| `isAllowed` | 当前是否允许滑动（聊天存在、未在生成、未在动画中） |
| `state` | 当前 `SWIPE_STATE`（`NONE`，加上动画状态） |

```js
const ctx = Luker.getContext();

if (ctx.swipe.isAllowed()) {
    await ctx.swipe.right();
}
```

## 消息媒体辅助函数

用于管理消息上图像 / 文件附件的辅助函数。它们操作消息对象的 `extra.media` 和 `extra.files` 数组。

### appendMediaToMessage

```ts
appendMediaToMessage(messageObj: ChatMessage, messageElement: JQuery, scrollBehavior?: string): void
```

把 `messageObj.extra.media[]` 和 `messageObj.extra.files[]` 中引用的所有媒体渲染到给定的消息元素中。会遵守 `media_display` 和 `inline_image` 标志。在重新渲染已添加媒体的消息时有用。

### ensureMessageMediaIsArray

```ts
ensureMessageMediaIsArray(messageObj: ChatMessage): void
```

就地把旧版的单项 `extra.media` / `extra.image` 属性迁移为数组。如果你需要处理可能由更老代码写出的消息，在读取 `extra.media` 之前调用此函数。

### getMediaDisplay

```ts
getMediaDisplay(messageObj: ChatMessage): string
```

返回消息当前的 `MEDIA_DISPLAY` 模式（默认走全局设置）。

### getMediaIndex

```ts
getMediaIndex(messageObj: ChatMessage): number
```

返回当前选中的媒体索引，强制限定在 `0..media.length-1` 的合法范围。索引越界时返回 `0`。

### scrollChatToBottom

```ts
scrollChatToBottom(options?: { waitForFrame?: boolean }): void
```

把聊天滚动到底部。当用户向上滚动且 `auto_scroll_chat_to_bottom` 关闭时为 no-op。`waitForFrame: true` 时先等待 `requestAnimationFrame`，让布局先 settle。

### scrollOnMediaLoad

```ts
scrollOnMediaLoad(): Promise<void>
```

等待聊天中所有 `<img>` / `<video>` / `<audio>` 元素的 load 事件（带超时），等它们最终确定布局后重新锚定滚动位置。在追加媒体后调用，避免聊天画面跳动。
