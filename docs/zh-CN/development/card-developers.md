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
        "html": "string",
        "script": "string",
        "style": "string"
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
| `card_app.html` | string | 应用的 HTML 模板 |
| `card_app.script` | string | 应用的 JavaScript 代码 |
| `card_app.style` | string | 应用的 CSS 样式 |

> [!NOTE]
> 绑定预设和人设的数据存储在角色卡的状态文件中，不在 `data.extensions` 内。这样设计是为了避免修改角色卡本身的 JSON 数据。

## 绑定预设和人设

Luker 支持在角色卡中绑定推荐的生成预设和用户人设。当用户加载角色卡时，可以一键应用创作者推荐的配置，确保最佳的角色扮演体验。

绑定信息存储在角色卡的状态文件中：

- **推荐预设**：指定最适合该角色的生成预设（温度、采样参数等）
- **推荐人设**：指定与角色互动时建议使用的用户人设

这些绑定通过[角色卡编辑助手](/zh-CN/features/card-editor)的「绑定预设」面板进行配置。

## 配置编排工作流

[编排器](/zh-CN/features/orchestrator)允许角色卡创作者定义复杂的提示词编排工作流。通过编排器，你可以：

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

CardApp 定义在角色卡的 `data.extensions.card_app` 字段中：

```json
{
  "data": {
    "extensions": {
      "card_app": {
        "enabled": true,
        "html": "<div id='fav-tracker'><span id='fav-value'>0</span></div>",
        "script": "export default function(ctx) { ... }",
        "style": "#fav-tracker { padding: 10px; }"
      }
    }
  }
}
```

### 入口函数

CardApp 的 `script` 字段应导出一个默认函数，该函数接收上下文对象 `ctx`：

```javascript
export default function (ctx) {
  const container = ctx.container;

  // 初始化：读取持久化状态
  async function init() {
    const state = ctx.getChatState('my_app');
    render(state);
  }

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

  init();
}
```

### 上下文 API（ctx）

CardApp 的上下文对象提供以下 API：

#### 消息与生成

| API | 说明 |
|-----|------|
| `ctx.container` | 应用的 DOM 容器元素 |
| `ctx.charId` | 当前角色 ID |
| `ctx.sendMessage(text, options?)` | 发送消息 |
| `ctx.stopGeneration()` | 停止当前生成 |
| `ctx.continueGeneration()` | 继续生成 |

#### 数据与状态

| API | 说明 |
|-----|------|
| `ctx.getCharacterData()` | 获取当前角色数据（只读） |
| `ctx.updateCharacterFields(fields)` | 更新角色字段并保存。支持 name、description、personality、scenario、first_mes、mes_example、system_prompt、post_history_instructions、creator_notes、creator、character_version、tags（逗号分隔字符串）、talkativeness（数字）、depth_prompt 相关字段 |
| `ctx.getChatState(namespace)` | 读取聊天绑定的持久化状态 |
| `ctx.setChatState(namespace, key, value)` | 设置聊天状态 |
| `ctx.getVariable(key)` | 获取聊天变量 |
| `ctx.setVariable(key, value)` | 设置聊天变量 |
| `ctx.getChatList()` | 获取当前角色的聊天列表 |

#### 世界书操作

| API | 说明 |
|-----|------|
| `ctx.getWorldBooks()` | 获取当前角色关联的世界书名称列表（角色绑定 + 全局激活） |
| `ctx.getWorldBookEntries(bookName)` | 获取指定世界书的所有条目 |
| `ctx.createWorldBookEntry(bookName, fields?)` | 创建世界书条目，返回新条目对象（含 uid） |
| `ctx.updateWorldBookEntry(bookName, uid, patch)` | 更新世界书条目（浅合并） |
| `ctx.deleteWorldBookEntry(bookName, uid)` | 删除世界书条目 |

### 安全限制

CardApp 运行在受限环境中：

- ✅ 可以操作 `ctx.container` 内的 DOM
- ✅ 可以通过 `ctx` API 读写聊天状态
- ✅ 可以发送消息和控制生成
- ❌ 不应直接操作沙箱外的 DOM
- ❌ 不应直接发起网络请求
- ❌ 不应直接访问其他扩展的数据

### CardApp Studio

[角色卡编辑助手](/zh-CN/features/card-editor)内置了 CardApp Studio，提供基于 CodeMirror 6 的代码编辑器，支持实时预览和调试。建议使用 Studio 进行 CardApp 开发，而非手动编辑 JSON。

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

- [角色卡编辑助手](/zh-CN/features/card-editor) — 角色卡编辑和 CardApp Studio
- [记忆图](/zh-CN/features/memory-graph) — 长期记忆系统
- [编排器](/zh-CN/features/orchestrator) — 提示词编排工作流
- [CardApp](/zh-CN/features/cardapp) — 角色卡内嵌应用详细说明
- [扩展 API 参考](/zh-CN/development/extension-api) — API 详细文档
