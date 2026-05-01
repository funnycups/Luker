# 状态系统

Luker 引入了一套状态系统，允许角色卡、聊天和预设携带持久化的状态数据。扩展和 CardApp 可以利用这套系统存储和读取自定义数据，而无需修改角色卡或聊天记录本身。

## 角色状态

每个角色可以拥有独立的状态数据，按命名空间隔离。不同的扩展或 CardApp 使用各自的命名空间，互不干扰。

例如，一个记忆扩展可以在角色状态中存储该角色的记忆摘要，而一个 CardApp 可以在同一角色上存储游戏进度——两者通过不同的命名空间各自独立运作。

### 工作方式

- **读取状态**：通过角色标识和命名空间获取该角色在该命名空间下的状态数据
- **写入状态**：将数据保存到指定角色的指定命名空间中
- **自动持久化**：状态数据会自动保存到磁盘，服务重启后不会丢失

角色状态的生命周期与角色本身绑定——当角色被删除时，其关联的状态数据也会被清理。

## 聊天状态

Luker 将聊天状态按命名空间存储为聊天文件旁的 sidecar 文件，命名模式为 `<聊天文件基名>.luker-state.<namespace>.json`。

### 状态文件的特点

- 以 sidecar 文件形式存储在聊天文件所在目录（不是单一全局状态文件）
- 同一聊天可存在多个状态 sidecar（每个 namespace 一个），按首次写入懒创建
- 与聊天文件生命周期绑定：聊天被重命名时，关联 sidecar 同步重命名；聊天被删除时，关联 sidecar 同步删除
- 支持增量更新，不需要每次都写入完整数据

### 存储内容

聊天状态文件可以存储各种与聊天相关的辅助信息，例如：

- 生成任务的确认状态
- 扩展为该聊天保存的自定义数据
- 其他不适合直接写入聊天记录的元数据

::: tip
聊天状态文件是 Luker 自动管理的，你通常不需要手动编辑它们。如果你从 SillyTavern 迁移数据，这些文件会在首次使用时自动创建。
:::

## 预设状态

Luker 同样支持为预设附加状态数据。预设状态允许扩展在特定预设上存储配置或运行时信息，当用户切换预设时，相关的状态数据也会随之切换。

## 状态的持久化和生命周期

状态系统遵循以下原则：

| 状态类型 | 存储位置 | 生命周期 |
| --- | --- | --- |
| 角色状态 | 角色卡同目录 sidecar（`<角色名>.state.<namespace>.json`） | 首次命名空间写入时创建；随角色重命名/删除联动 |
| 聊天状态 | 聊天同目录 sidecar（`<聊天名>.luker-state.<namespace>.json`） | 首次命名空间写入时创建；随聊天重命名/删除联动 |
| 预设状态 | 预设同目录 sidecar（`<预设名>.luker-state.<namespace>.json`） | 首次命名空间写入时创建；随预设重命名/删除联动 |

所有状态数据都会持久化到磁盘，不会因为服务重启而丢失。状态文件的清理是自动的——当关联的角色、聊天或预设被删除时，对应的状态文件也会被自动清理。

## 使用场景

### CardApp 状态追踪

CardApp 是状态系统最典型的使用者。角色卡内嵌的应用可以通过状态系统保存游戏进度、用户偏好、交互历史等数据。例如，一个 RPG 类型的 CardApp 可以将角色的等级、装备、任务进度等信息保存在角色状态中。

详见 [CardApp](/zh-CN/features/cardapp)。

### 扩展数据存储

第三方扩展可以利用状态系统为每个角色或聊天存储自定义数据，而无需自行管理文件读写。这简化了扩展开发，也确保了数据的生命周期管理是正确的。

详见 [扩展 API](/zh-CN/development/extension-api)。

### 记忆系统

[Memory Graph](/zh-CN/features/memory-graph) 等记忆类扩展可以利用角色状态存储记忆摘要和索引数据，实现按角色隔离的记忆管理。

## 楼层状态（带回退的聊天状态）

普通聊天状态只能整体覆写：用户回切 swipe、删消息或者切换聊天时，插件得自己重新读取命名空间、自己对账数据。楼层状态在聊天状态之上加了一层薄封装，自动处理这件事。每次写入都会附带聊天尾部的位置（楼层索引 + swipe 编号）记到日志里，聊天结构变化时自动重放。

### 工作方式

一个楼层状态实例独占一个聊天状态命名空间（`<ns>`）以及一份私有提交日志（`<ns>__floor_log`）。所有写入都通过实例的 `patch` 或 `update` 进入，同时更新业务命名空间和追加一条提交。实例订阅四个聊天事件：

- `CHAT_CHANGED`——切换到新聊天，按这份聊天的日志重建数据
- `MESSAGE_SWIPED`——用户切换 swipe，按新的活动 swipe 重建数据
- `MESSAGE_DELETED`——聊天截短，丢弃楼层超出新长度的提交后重建
- `MESSAGE_SWIPE_DELETED`——某个 swipe 被删除，相关提交重新编号后重建

重建始终从 `{}` 起步，按顺序重放幸存提交，确保业务命名空间永远对应当前的 swipe 路径。

### 创建实例

在插件或 CardApp 里使用 `getContext().createFloorState({ namespace })`。每个实例绑定一个命名空间；如果业务状态分多块，请创建多个实例。

```js
const ctx = SillyTavern.getContext();
const fs = await ctx.createFloorState({ namespace: 'my-plugin' });

// 直接应用 RFC 6902 操作：
await fs.patch([{ op: 'add', path: '/score', value: 10 }]);

// 或者写 reducer，差异会自动计算并提交：
await fs.update((current) => ({ ...current, level: (current?.level ?? 0) + 1 }));

// 读取当前状态：
const state = await fs.get();

// 在读取之前等待重建完成：
await fs.ready();

// 解除事件监听（极少需要，实例通常和页面同寿）：
fs.destroy();
```

### 何时要 `await ready()`

如果你的插件在 `GENERATION_STARTED` 之类紧跟在四个结构事件之后的钩子里读楼层状态，那就先 `await fs.ready()`。没有重建在进行时，这个 Promise 立即解决，开销可以忽略。

### 约定

- 一个命名空间一个主人。不要在同一个命名空间上同时用 `patchChatState(ns, ...)` 和 `floorState.patch(...)`——重建时会把直接写入的部分覆盖掉。
- 名字以 `__floor_log` 结尾的命名空间留给楼层状态的私有日志，不要占用。
- reducer 必须返回普通对象。数组、基础类型、`null`、`undefined` 一律忽略。

### 参考

- `createFloorState({ namespace })`——异步工厂，返回冻结的实例。
- `instance.patch(operations)`——应用 RFC 6902 操作并追加提交。
- `instance.update(reducer)`——读—改—写；reducer 收到当前状态，返回下一份状态。
- `instance.get()`——读取业务命名空间。
- `instance.ready()`——重建结束时解决。
- `instance.destroy()`——解除事件监听并冻结实例。

## 相关页面

- [CardApp](/zh-CN/features/cardapp) — 角色卡内嵌应用系统
- [扩展 API](/zh-CN/development/extension-api) — 扩展开发接口
- [增量同步](/zh-CN/improvements/incremental-sync) — 聊天数据的增量保存机制
