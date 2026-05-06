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
): Promise<any | null>
```

读取指定命名空间的聊天状态。返回 `null` 表示该命名空间无数据。

- `namespace`：插件的唯一标识符，建议使用插件名
- `target`：可选，指定目标聊天（用于跨聊天读取，如分支场景）

### getChatStateBatch

```ts
getChatStateBatch(
  namespaces: string[],
  options?: { target?: ChatTarget }
): Promise<Record<string, any>>
```

批量读取多个命名空间的聊天状态。返回一个以命名空间为键的对象。

### updateChatState

```ts
updateChatState(
  namespace: string,
  updater: (current: any) => any,
  options?: { target?: ChatTarget }
): Promise<{ ok: boolean }>
```

**推荐的读-改-写方式。** `updater` 函数接收当前状态，返回新状态。系统会自动处理并发冲突。

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
): Promise<{ ok: boolean }>
```

删除指定命名空间的聊天状态。

### 最佳实践

- 使用 `updateChatState()` 进行读-改-写，而非手动链式调用 `getChatState()` + `patchChatState()`
- 保持 payload 为可 JSON 序列化的纯对象
- 处理 `ok: false` 返回值，保持插件 UI 的弹性
- 对于大型插件数据，优先使用聊天状态而非 `chat_metadata`
- 如果状态需要随 swipe、删消息、切换聊天自动跟进，请使用 [楼层状态](#楼层状态)，而不是在 `updateChatState` 之上自己写对账逻辑

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

```js
const ctx = SillyTavern.getContext();
const fs = await ctx.createFloorState({ namespace: 'my-plugin' });

// 推荐：reducer 风格写入。reducer 收到当前状态、返回下一份状态，差异自动算完并提交。
await fs.update((current) => ({ ...current, score: 10 }));
await fs.update((current) => ({ ...current, level: (current?.level ?? 0) + 1 }));
await fs.update((current) => {
    const { temp, ...rest } = current ?? {};
    return rest;
});

// 读取当前状态：
const state = await fs.get();

// 在读取之前等待重建或写入完成：
await fs.ready();

// 从注册表里移除（极少需要，实例通常和页面同寿）：
fs.destroy();
```

::: warning
reducer 必须返回普通对象。返回数组、基础类型、`null`、`undefined` 一律视作「无变化」，调用直接成功返回但不写入。
:::

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

不传 `options` 时按聊天尾部推断。`floor` 必须是当前 `chat` 的有效索引（`0 <= floor < chat.length`），越界、负数、非整数、负 `swipeId` 都会被拒绝并返回 `false`，避免悄无声息地把状态错挂到不存在的楼层。

::: tip
覆写只影响这条提交在日志里的标签——`MESSAGE_DELETED` 仍按 floor 截断，`MESSAGE_SWIPE_DELETED` 仍按 (floor, swipeId) 重编号。重建顺序由日志的写入顺序决定，不会因为你指定了较小的 `floor` 就被「插队」到前面执行。
:::

### 进阶：预先算好的 patch

如果你已经手上有一份针对当前 materialized 状态的增量 RFC 6902 diff——比如出于性能考虑自己算了 diff、或者在跑一次性迁移——可以调 `instance.patch(operations, options?)` 直接追加。operations 必须是 `buildObjectPatchOperationsAsync(prev, next)` 形式的增量 diff，prev 取自 `await fs.get()`；不能传「整盘覆写」式的 snapshot patch，因为重建假设每条提交的 patch 跟前面幸存提交的 patch 顺序组合。

其他场景一律走 `update`——它会帮你算好 diff。

### 何时要 `await ready()`

四种结构性转换由 core 在对应 `eventSource` 事件触发**之前**同步推平。所以插件在 `MESSAGE_DELETED` / `MESSAGE_SWIPED` / `MESSAGE_SWIPE_DELETED` / `CHAT_CHANGED` / `CHAT_BRANCH_CREATED` 监听器里读楼层状态时，看到的一定是已 settle 完的数据，**不需要** `ready()`。

`ready()` 现在主要用于跟可能并发的 `update` / `patch` in-flight 写入串行化。没有重建或写入在进行时，这个 Promise 立即解决，开销可以忽略。

### 约定

- 一个命名空间一个主人。不要在同一个命名空间上同时用 `updateChatState(ns, ...)` 和 `floorState.update(...)`——重建时会把直接写入的部分覆盖掉。
- 名字以 `__floor_log` 结尾的命名空间留给楼层状态的私有日志，不要占用。
- reducer 必须返回普通对象。数组、基础类型、`null`、`undefined` 一律忽略。

### 参考

- `createFloorState({ namespace })`——异步工厂，返回冻结的实例。
- `instance.update(reducer, options?)`——读—改—写；reducer 收到当前状态、返回下一份状态，差异自动算完并提交。可选的 `options = { floor, swipeId? }` 把提交挂到指定楼层而非聊天尾部。**这是推荐的写入 API。**
- `instance.patch(operations, options?)`——进阶：追加一条「自己已经算好 patch」的提交。operations 必须是相对 `await instance.get()` 的增量 RFC 6902 diff（`buildObjectPatchOperationsAsync(prev, next)`），不能是整盘覆写式 snapshot。`options` 与 `update` 相同。
- `instance.get()`——读取业务命名空间。
- `instance.ready()`——重建结束时解决。
- `instance.destroy()`——从注册表移除实例并冻结它。

## 角色状态

角色状态是绑定到角色卡本身的持久化存储，在该角色的所有聊天之间共享。与聊天状态（仅在单个聊天内有效）不同，角色状态适合存储跨聊天的角色级别配置。

### getCharacterState

```ts
getCharacterState(namespace: string): Promise<any | null>
```

读取指定命名空间下的角色状态数据。如果该命名空间没有存储过数据，返回 `null`。

| 参数 | 说明 |
|------|------|
| `namespace` | 存储命名空间，通常使用插件名称（如 `'my-extension'`） |

### setCharacterState

```ts
setCharacterState(namespace: string, data: any): Promise<void>
```

写入指定命名空间下的角色状态数据。传入 `null` 作为 `data` 可以删除该命名空间的状态。

| 参数 | 说明 |
|------|------|
| `namespace` | 存储命名空间 |
| `data` | 要存储的数据（任意可序列化对象），传 `null` 删除 |

### 使用示例

```js
const context = Luker.getContext();

// 读取角色状态
const state = await context.getCharacterState('my-extension');
console.log(state); // { someConfig: true } 或 null

// 写入角色状态
await context.setCharacterState('my-extension', {
  someConfig: true,
  lastUpdated: Date.now(),
});

// 删除角色状态
await context.setCharacterState('my-extension', null);
```

### 角色状态 vs 聊天状态

| | 角色状态 | 聊天状态 |
|------|------|------|
| 作用范围 | 绑定到角色卡，所有聊天共享 | 绑定到单个聊天 |
| 典型用途 | 角色级别的插件配置、CardApp 应用状态 | 聊天内的临时数据、对话上下文 |
| API | `getCharacterState` / `setCharacterState` | `getChatState` / `getChatStateBatch` / `updateChatState` / `deleteChatState` |
| 存储位置 | 角色卡 JSON 文件 | 聊天元数据 |
