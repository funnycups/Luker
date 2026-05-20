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
覆写只影响这条提交在日志里的标签——`MESSAGE_DELETED` 仍按 floor 截断，`MESSAGE_SWIPE_DELETED` 仍按 （floor， swipeId） 重编号。重建顺序由日志的写入顺序决定，不会因为你指定了较小的 `floor` 就被「插队」到前面执行。
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
getCharacterState(avatar: string, namespace: string): Promise<any | null>
```

读取指定头像和命名空间下的角色旁挂状态。如果该命名空间没有存储过数据，返回 `null`。

| 参数 | 说明 |
|------|------|
| `avatar` | 角色头像文件名（例如 `'tavernkeeper.png'`） |
| `namespace` | 存储命名空间，通常使用插件名称（如 `'my-extension'`） |

### setCharacterState

```ts
setCharacterState(avatar: string, namespace: string, data: any): Promise<void>
```

写入指定命名空间下的角色旁挂状态。传入 `null` 作为 `data` 可以删除该命名空间的状态。

| 参数 | 说明 |
|------|------|
| `avatar` | 角色头像文件名 |
| `namespace` | 存储命名空间 |
| `data` | 要存储的数据（任意可序列化对象），传 `null` 删除 |

### 使用示例

```js
const context = Luker.getContext();
const character = context.characters[context.characterId];

// 读取角色状态
const state = await context.getCharacterState(character.avatar, 'my-extension');
console.log(state); // { someConfig: true } 或 null

// 写入角色状态
await context.setCharacterState(character.avatar, 'my-extension', {
  someConfig: true,
  lastUpdated: Date.now(),
});

// 删除角色状态
await context.setCharacterState(character.avatar, 'my-extension', null);
```

### 角色状态 vs 聊天状态

| | 角色状态 | 聊天状态 |
|------|------|------|
| 作用范围 | 绑定到角色卡，所有聊天共享 | 绑定到单个聊天 |
| 典型用途 | 角色级别的插件配置、CardApp 应用状态 | 聊天内的临时数据、对话上下文 |
| API | `getCharacterState` / `setCharacterState` | `getChatState` / `getChatStateBatch` / `updateChatState` / `deleteChatState` |
| 存储位置 | 角色卡旁挂文件 | 聊天元数据 |

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
