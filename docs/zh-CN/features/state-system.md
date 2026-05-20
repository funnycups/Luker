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

每个聊天有自己的状态，按命名空间隔离。Luker 将聊天状态按命名空间存储在聊天文件旁的独立文件中，命名模式为 `<聊天文件基名>.luker-state.<namespace>.json`。

### 状态文件的特点

- 每个命名空间一个文件，放在聊天文件同目录（不是单一全局状态文件）
- 同一聊天可存在多个状态文件（每个 namespace 一个），按首次写入懒创建
- 与聊天文件生命周期绑定：聊天被重命名时，关联状态文件同步重命名；聊天被删除时，关联状态文件同步删除
- 支持增量更新，不需要每次都写入完整数据

### 存储内容

聊天状态可以存储各种与聊天相关的辅助信息，例如：

- 生成任务的确认状态
- 扩展为该聊天保存的自定义数据
- 其他不适合直接写入聊天记录的元数据

::: tip
聊天状态由 Luker 自动管理，通常不需要手动编辑。如果你从 SillyTavern 迁移数据，这些文件会在首次使用时自动创建。
:::

## 预设状态

Luker 同样支持为预设附加状态数据。预设状态允许扩展在特定预设上存储配置或运行时信息，当用户切换预设时，相关的状态数据也会随之切换。

## 状态的持久化和生命周期

状态系统遵循以下原则：

| 状态类型 | 存储位置 | 生命周期 |
| --- | --- | --- |
| 角色状态 | 角色卡同目录的命名空间文件（`<角色名>.state.<namespace>.json`） | 首次命名空间写入时创建；随角色重命名/删除联动 |
| 聊天状态 | 聊天同目录的命名空间文件（`<聊天名>.luker-state.<namespace>.json`） | 首次命名空间写入时创建；随聊天重命名/删除联动 |
| 预设状态 | 预设同目录的命名空间文件（`<预设名>.luker-state.<namespace>.json`） | 首次命名空间写入时创建；随预设重命名/删除联动 |

```d2
direction: right

CHAR: "角色目录" {
  CHAR_MAIN: "Seraphina.png\n角色卡主文件" {
    style.fill: "#e1f5ff"
  }
  CHAR_S1: "Seraphina.state.memory_graph.json\n记忆图状态"
  CHAR_S2: "Seraphina.state.cardapp_studio.json\nStudio 会话"
}

CHAT: "聊天目录" {
  CHAT_MAIN: "Seraphina-2026.jsonl\n聊天主文件" {
    style.fill: "#e1f5ff"
  }
  CHAT_S1: "Seraphina-2026.luker-state.chat_sync.json\nintegrity / updated_at"
  CHAT_S2: "Seraphina-2026.luker-state.luker_orchestrator__schema.json\n编排状态"
  CHAT_S3: "Seraphina-2026.luker-state.memory_graph__meta.json\n记忆图元数据"
}

PRESET: "预设目录" {
  P_MAIN: "for_my_athena.json\n预设主文件" {
    style.fill: "#e1f5ff"
  }
  P_S1: "for_my_athena.luker-state.preset_assistant.json\n预设助手会话"
}
```

所有状态数据都会持久化到磁盘，不会因为服务重启而丢失。状态文件的清理是自动的——当关联的角色、聊天或预设被删除时，对应的状态文件也会被自动清理。

## 使用场景

### CardApp 状态追踪

CardApp 是状态系统最典型的使用者。角色卡内嵌的应用可以通过状态系统保存游戏进度、用户偏好、交互历史等数据。例如，一个 RPG 类型的 CardApp 可以将角色的等级、装备、任务进度等信息保存在角色状态中。

详见 [CardApp](/zh-CN/features/cardapp)。

### 扩展数据存储

第三方扩展可以利用状态系统为每个角色或聊天存储自定义数据，而无需自行管理文件读写。这简化了扩展开发，也确保了数据的生命周期管理是正确的。

详见 [扩展 API — 聊天与状态](/zh-CN/development/extension-api/chat-and-state)。

### 记忆系统

[Memory Graph](/zh-CN/features/memory-graph) 等记忆类扩展可以利用角色状态存储记忆摘要和索引数据，实现按角色隔离的记忆管理。

## 楼层状态（带回退的聊天状态）

普通聊天状态只能整体覆写：用户回切 swipe、删消息或者切换聊天时，插件得自己重新读取命名空间、自己对账数据。楼层状态在聊天状态之上加了一层薄封装，自动处理这件事：每次写入都会附带聊天尾部的位置（楼层索引 + swipe 编号）记到日志里，聊天结构变化时自动重放幸存提交，插件状态始终跟当前活动 swipe 链路一致，不用手动对账。

API、代码示例与使用约定见 [扩展 API — 楼层状态](/zh-CN/development/extension-api/chat-and-state#楼层状态)。

## 相关页面

- [CardApp](/zh-CN/features/cardapp) — 角色卡内嵌应用系统
- [扩展 API](/zh-CN/development/extension-api/) — 扩展开发接口
- [楼层状态](/zh-CN/development/extension-api/chat-and-state#楼层状态) — 带自动回退的聊天状态开发参考
- [增量同步](/zh-CN/improvements/incremental-sync) — 聊天数据的增量保存机制
