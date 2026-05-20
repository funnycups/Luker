# 角色卡开发者指南

本指南面向角色卡创作者，介绍如何利用 Luker 的扩展能力创建更丰富、更智能的角色卡。Luker 在保持与 SillyTavern 角色卡格式完全兼容的基础上，提供了多项增强功能。

## 角色卡扩展字段

Luker 使用角色卡 `data.extensions` 中的多个命名空间存储扩展数据。这些字段不会影响角色卡在 SillyTavern 中的正常使用——不识别的字段会被忽略。

### data.extensions 扩展字段结构

```json
{
  "data": {
    "extensions": {
      "luker": {
        "memoryGraphSchema": {
          "nodeTypes": [
            { "name": "string", "label": "string", "color": "#hex" }
          ]
        }
      },
      "card_app": {
        "enabled": true,
        "entry": "index.js"
      }
    }
  }
}
```

| 字段路径 | 类型 | 说明 |
|---------|------|------|
| `luker.memoryGraphSchema` | object | 记忆图的自定义节点类型 schema |
| `luker.memoryGraphSchema.nodeTypes` | array | 节点类型定义列表 |
| `luker.memoryGraphSchema.nodeTypes[].name` | string | 节点类型标识符（英文，用于内部引用） |
| `luker.memoryGraphSchema.nodeTypes[].label` | string | 节点类型显示名称 |
| `luker.memoryGraphSchema.nodeTypes[].color` | string | 节点颜色（十六进制色值） |
| `card_app.enabled` | boolean | 是否启用 CardApp |
| `card_app.entry` | string | CardApp 文件夹下的入口模块文件名，默认 `index.js`。入口文件必须导出 `init(ctx)` 函数。同目录下的 `style.css` 会按约定自动加载。 |

> [!NOTE]
> 绑定预设和人设的数据存储在角色卡的状态文件中，不在 `data.extensions` 内。这样设计是为了避免修改角色卡本身的 JSON 数据。

## 绑定预设和人设

Luker 支持在角色卡中绑定推荐的生成预设和用户人设。当用户加载角色卡时，可以一键应用创作者推荐的配置，确保最佳的角色扮演体验。

绑定信息存储在角色卡的状态文件中：

- **推荐预设**：指定最适合该角色的生成预设（温度、采样参数等）
- **推荐人设**：指定与角色互动时建议使用的用户人设

这些绑定通过[角色卡编辑助手](/zh-CN/features/card-editor/)的「绑定预设」面板进行配置。

## 配置编排工作流

[编排器](/zh-CN/features/orchestrator/)允许角色卡创作者定义复杂的提示词编排工作流。通过编排器，你可以：

- 定义多步骤的提示词处理管线
- 在生成前后插入自定义逻辑
- 根据对话状态动态调整提示词结构

编排工作流可以绑定到角色卡，当用户加载角色卡时自动激活。

## 自定义记忆图 Schema

[记忆图](/zh-CN/features/memory-graph)支持角色卡级别的节点类型 schema 自定义。通过在角色卡的扩展数据中定义 `luker.memoryGraphSchema`，你可以为角色定制专属的记忆结构。

例如，一个奇幻世界的角色卡可以定义如下 schema：

```json
{
  "data": {
    "extensions": {
      "luker": {
        "memoryGraphSchema": {
          "nodeTypes": [
            { "name": "character", "label": "角色", "color": "#4A90D9" },
            { "name": "location", "label": "地点", "color": "#7ED321" },
            { "name": "quest", "label": "任务", "color": "#F5A623" },
            { "name": "magic", "label": "魔法", "color": "#BD10E0" },
            { "name": "faction", "label": "阵营", "color": "#D0021B" }
          ]
        }
      }
    }
  }
}
```

自定义 schema 会覆盖默认的节点类型集合，让记忆图的提取和组织更贴合角色的世界观。

## CardApp 开发

[CardApp](/zh-CN/features/cardapp) 是 Luker 的角色卡内嵌应用系统，允许你在角色卡中嵌入交互式 JavaScript 应用。

### 适用场景

- **状态追踪**：好感度、体力值、库存等游戏化元素
- **互动元素**：骰子、卡牌、小游戏
- **可视化**：关系图、时间线、地图
- **自定义 UI**：角色专属的界面组件

### 应用定义结构

CardApp 定义在角色卡的 `data.extensions.card_app` 字段中。角色卡里只存开关和入口文件名，实际代码以文件形式存放在 CardApp 的角色级目录（由 Studio 管理）:

```json
{
  "data": {
    "extensions": {
      "card_app": {
        "enabled": true,
        "entry": "index.js"
      }
    }
  }
}
```

运行时把 `index.js`（或 `entry` 指向的文件）以 ES 模块方式从 `/api/card-app/<charId>/<entry>` 加载，同目录下若有 `style.css` 也会自动注入。推荐用 Studio 编辑/保存/版本管理这些文件。

### 入口函数

CardApp 的入口模块必须导出 `init(ctx)` 函数，接收上下文对象：

```javascript
export async function init(ctx) {
  const container = ctx.container;

  // 读取持久化状态 — getChatState 是异步的(server-backed sidecar)
  const state = await ctx.getChatState('my_app');
  render(state);

  // 渲染 UI
  function render(state) {
    const fav = state?.favorability ?? 0;
    container.innerHTML = `
      <div class="fav-panel">
        <h3>好感度</h3>
        <div class="fav-bar">
          <div class="fav-fill" style="width: ${Math.min(fav, 100)}%"></div>
        </div>
        <span>${fav} / 100</span>
      </div>
    `;
  }
}
```

### 上下文 API（ctx）

CardApp 的上下文对象提供以下 API：

#### 消息与生成

| API | 说明 |
|-----|------|
| `ctx.container` | 应用的DOM容器元素 |
| `ctx.charId` | 当前角色ID |
| `ctx.sendMessage(text, options?)` | 发送消息（内部调用`sendTextareaMessage`） |
| `ctx.stopGeneration()` | 停止当前生成 |
| `ctx.continueGeneration()` | 继续生成 |
| `ctx.getHistory(limit?, offset?)` | 获取聊天历史记录，支持限制条数和偏移 |
| `ctx.editMessage(messageId, newText)` | 编辑指定消息 |
| `ctx.deleteMessage(messageId)` | 删除指定消息 |
| `ctx.deleteLastMessage()` | 删除最后一条消息 |
| `ctx.swipe()` | 切换到下一个回复变体 |
| `ctx.regenerate()` | 重新生成最后一条AI消息（调用`Generate('regenerate')`） |

#### 数据与状态

| API | 说明 |
|-----|------|
| `ctx.getCharacterData()` | 获取当前角色数据（只读） |
| `ctx.updateCharacterFields(fields)` | 更新角色字段并保存。支持name、description、personality、scenario、first_mes、mes_example、system_prompt、post_history_instructions、creator_notes、creator、character_version、tags（逗号分隔字符串）、talkativeness（数字）、depth_prompt相关字段 |
| `ctx.getChatState(namespace, options?)` | **异步** 读取聊天绑定的 sidecar 状态（server-backed，`/api/chats/state/`）。HP / 金币 / 好感度 / 物品 / 任务标志这类用聊天变量。 |
| `ctx.updateChatState(namespace, updater, options?)` | **异步** reducer 风格写入聊天 sidecar，返回 `{ ok, state, updated }`。 |
| `ctx.patchChatState(namespace, operations, options?)` | **异步** 对聊天 sidecar 应用 JSON-patch 操作。 |
| `ctx.deleteChatState(namespace, options?)` | **异步** 删除一个聊天 sidecar 命名空间。 |
| `ctx.getCharacterState(namespace)` | **异步** 读取角色绑定的 sidecar（avatar 自动绑定），跨该角色的所有聊天保留。 |
| `ctx.setCharacterState(namespace, data)` | **异步** 写入角色绑定的 sidecar（avatar 自动绑定），传 `null` 表示删除。 |
| `ctx.getVariable(key)` | 读取聊天变量（来自 `chat_metadata.variables`，即 <code v-pre>{{getvar::key}}</code> 读的同一个桶）。 |
| `ctx.setVariable(key, value, options?)` | **异步** 设置聊天变量。默认写入 `chat_metadata.variables`（会话级，贯穿整个 chat）。传 `{ floor: <消息序号> }` 则改走变量 op-log，把这次写入绑定到该楼的**当前 swipe**——切 swipe / 切回 / 删楼 / 创建分支都会经过 rebuilder 重放，效果跟 AI 在消息里直接写 <code v-pre>{{setvar}}</code> 一致。绑定楼层的路径会把 value 强转成字符串（op-log 的存储格式只承载字符串）。如果需要"结构化的逐楼状态 + 独立命名空间 + 自己的 commit log"，改用 `ctx.lukerContext.createFloorState({ namespace })`。 |

#### 聊天管理

| API | 说明 |
|-----|------|
| `ctx.getChatList()` | 获取当前角色的聊天列表 |
| `ctx.switchChat(chatName)` | 切换到指定聊天 |
| `ctx.newChat()` | 创建新聊天 |
| `ctx.closeChat()` | 关闭当前聊天 |

#### 世界书操作

| API | 说明 |
|-----|------|
| `ctx.getWorldBooks()` | 获取当前角色可见的世界书名称列表（角色主世界书 + 角色附加世界书 + 聊天绑定 + 全局激活，已去重）。传 `{ withSource: true }` 可拿到带 `source: 'character' \| 'character_aux' \| 'chat' \| 'global'` 的标注列表 |
| `ctx.getCharacterAuxWorldBooks()` | 获取当前角色绑定的附加世界书（非主世界书）。这些与主世界书一同参与提示词组装，但通过 Luker 的世界书编辑器单独管理 |
| `ctx.getWorldBookEntries(bookName)` | 获取指定世界书的所有条目 |
| `ctx.createWorldBookEntry(bookName, fields?)` | 创建世界书条目，返回新条目对象（含 uid） |
| `ctx.updateWorldBookEntry(bookName, uid, patch)` | 更新世界书条目（浅合并） |
| `ctx.deleteWorldBookEntry(bookName, uid)` | 删除世界书条目 |

#### 事件与生命周期

| API | 说明 |
|-----|------|
| `ctx.eventSource` | Luker 的内部事件总线。订阅用 `ctx.eventSource.on(eventName, handler)`，取消订阅用 `ctx.eventSource.off(eventName, handler)`。事件名在 `ctx.lukerContext.eventTypes` 上（`CHAT_CHANGED`、`MESSAGE_DELETED`、`MESSAGE_SWIPED` 等）。每次 `.on()` 都搭配 `ctx.onDispose(() => ctx.eventSource.off(eventName, handler))`，CardApp 卸载时监听器才会被移除干净。 |
| `ctx.addEventListener(target, event, handler, options?)` | 订阅 DOM 元素上的事件。`target` 通常是 `ctx.container` 或 `querySelector` 的返回值；用于容器内的 UI 事件如 click、keydown、scroll。CardApp 卸载时监听器会自动移除。 |
| `ctx.setInterval(fn, ms)` | `setInterval` 的封装，卸载时句柄自动清理。 |
| `ctx.setTimeout(fn, ms)` | `setTimeout` 的封装，卸载时句柄自动清理。 |
| `ctx.onDispose(fn)` | 注册清理回调，CardApp 卸载（切换聊天、热重载、切换角色）时执行。 |

示例 —— 聊天切换或当前 swipe 改变时刷新面板：

```javascript
export async function init(ctx) {
    const { eventTypes } = ctx.lukerContext;
    const refresh = () => render(ctx);

    ctx.eventSource.on(eventTypes.CHAT_CHANGED, refresh);
    ctx.eventSource.on(eventTypes.MESSAGE_SWIPED, refresh);
    ctx.onDispose(() => {
        ctx.eventSource.off(eventTypes.CHAT_CHANGED, refresh);
        ctx.eventSource.off(eventTypes.MESSAGE_SWIPED, refresh);
    });

    refresh();
}
```

### 安全限制

CardApp 运行在受限环境中：

- ✅ 可以操作 `ctx.container` 内的 DOM
- ✅ 可以通过 `ctx` API 读写聊天状态
- ✅ 可以发送消息和控制生成
- ❌ 不应直接操作沙箱外的 DOM
- ❌ 不应直接发起网络请求
- ❌ 不应直接访问其他扩展的数据

### CardApp Studio

[CardApp Studio](/zh-CN/features/card-editor/studio) 是开发 CardApp 的完整环境，提供基于 CodeMirror 6 的代码编辑器、实时预览、AI 辅助和 Git 版本历史。建议通过 Studio 开发 CardApp，而非手动编辑 JSON。

## 世界书最佳实践

世界书（World Info / Lorebook）是角色卡的重要组成部分。以下是在 Luker 中使用世界书的最佳实践：

### 1. 合理组织条目

- 按主题分组：角色背景、世界设定、重要事件等
- 使用清晰的关键词触发条件
- 避免条目之间的内容重叠

### 2. 利用预设绑定世界书

Luker 支持将世界书绑定到预设。当用户切换预设时，关联的世界书会自动激活。这适用于需要不同世界观设定的场景。

### 3. 搜索工具与世界书集成

[搜索工具](/zh-CN/features/search-tools)的搜索代理可以将搜索结果自动写入世界书条目，实现实时信息注入。创作者可以利用这一机制为角色提供实时知识更新能力。

### 4. 控制注入深度和顺序

合理设置世界书条目的注入深度（depth）和排序（order），确保关键设定在提示词中的位置合理。Luker 的搜索工具提供了 `lorebookDepth`、`lorebookRole`、`lorebookEntryOrder` 等配置项来精细控制。

### 5. 与记忆图配合

世界书提供静态的世界设定，记忆图提供动态的对话记忆。两者互补：

- 世界书：不变的背景设定、角色关系、世界规则
- 记忆图：对话中产生的事件、情感变化、新发现

## 角色卡分发注意事项

### 兼容性

- `data.extensions.luker` 和 `data.extensions.card_app` 中的字段在 SillyTavern 中会被忽略，不影响角色卡的正常使用
- 绑定预设和人设存储在状态文件中，不包含在角色卡文件内，分发时不会携带
- 编排工作流需要用户手动导入或通过其他方式分发

### 建议

- 在角色卡描述中注明推荐使用 Luker 以获得完整体验
- 如果角色卡依赖 CardApp，说明所需的 Luker 版本
- 提供不依赖 Luker 扩展功能的基础体验，将 Luker 特性作为增强

## 相关页面

- [CardApp Studio](/zh-CN/features/card-editor/studio) — CardApp 的完整开发环境
- [角色卡编辑助手](/zh-CN/features/card-editor/) — 编辑助手概览（含弹窗 / Studio 两种模式）
- [记忆图](/zh-CN/features/memory-graph) — 长期记忆系统
- [编排器](/zh-CN/features/orchestrator/) — 提示词编排工作流
- [CardApp](/zh-CN/features/cardapp) — 角色卡内嵌应用详细说明
- [扩展 API 参考](/zh-CN/development/extension-api/) — API 详细文档
