# 搜索插件

搜索插件（Search Tools）为 AI 角色提供联网搜索能力，让角色在对话中可以检索实时信息并将搜索结果注入上下文。搜索插件支持多种搜索引擎后端，并提供两种工作模式以适应不同的使用场景。

## 两种工作模式

```d2
direction: right

TOOL: "工具模式" {
  T_USER: "用户提问"
  T_LLM: "创作 LLM"
  T_DECIDE: "LLM 判断\n需要搜索吗" {
    shape: diamond
  }
  T_TOOL: "调用 luker_web_search\n/ luker_web_visit" {
    style.fill: "#e1f5ff"
  }
  T_RESULT: "结果作为工具调用返回值\n注入对话上下文"
  T_FINAL: "LLM 生成最终回复"

  T_USER -> T_LLM -> T_DECIDE
  T_DECIDE -> T_TOOL: "是"
  T_TOOL -> T_RESULT
  T_RESULT -> T_LLM
  T_DECIDE -> T_FINAL: "否"
}

AGENT: "预请求 Agent 模式" {
  A_USER: "用户提问"
  A_AGENT: "搜索 Agent\n独立 LLM 预设"
  A_DECIDE: "分析对话\n需要搜索吗" {
    shape: diamond
  }
  A_SEARCH: "执行搜索\n多轮可循环"
  A_WRITE: "结果写入世界书条目" {
    style.fill: "#fff3e0"
  }
  A_LLM: "创作 LLM"
  A_FINAL: "LLM 生成最终回复\n世界书条目作为参考资料注入"

  A_USER -> A_AGENT -> A_DECIDE
  A_DECIDE -> A_SEARCH: "是"
  A_SEARCH -> A_WRITE -> A_LLM -> A_FINAL
  A_DECIDE -> A_LLM: "否"
}
```

### 工具模式（Tool Mode）

搜索功能作为创作 LLM 的可调用工具注册到[函数调用运行时](/zh-CN/improvements/function-call-runtime)中。当 AI 判断需要搜索信息时，会主动发起工具调用。

- 通过 `enabled` 配置项开启
- 注册 `luker_web_search` 和 `luker_web_visit` 两个函数工具
- AI 自主决定何时搜索、搜索什么内容
- 搜索结果作为工具调用返回值注入对话上下文

### 预请求 Agent 模式（Pre-request Agent Mode）

在创作 LLM 生成回复之前，自动运行一个独立的搜索 Agent。Agent 会分析当前对话内容，判断是否需要搜索，并将搜索结果写入世界书条目。

- 通过 `preRequestEnabled` 配置项开启
- Agent 使用独立的 LLM 预设（`agentPresetName`）和 API 预设（`agentApiPresetName`），可以与创作 LLM 使用不同的模型
- Agent 最大执行轮次由 `agentMaxRounds` 控制
- 搜索结果自动创建为世界书条目，创作 LLM 在生成时可以直接读取
- 支持通过 toast 通知上的 Stop 按钮中止 Agent 执行

::: tip 两种模式的选择
**工具模式**适合需要模型在对话中自主决定何时搜索的场景——例如用户问「最近有什么新闻」时，模型会自动调用搜索工具获取信息。搜索行为由模型根据对话内容自主触发。

**预请求 Agent 模式**则是在每次 AI 生成前自动执行搜索，搜索过程与主对话完全分离。适合希望每次回复都有最新信息支撑的场景。
:::

## 设置面板

搜索插件的所有配置在扩展面板的「搜索工具」子项里：

![搜索工具设置面板](/images/search-tools/search-tools-settings.png)

顶部两个开关分别对应上文的两种模式（「暴露工具给主模型」= 工具模式，「请求前运行搜索 Agent」= 预请求 Agent 模式），可以单独或同时启用。下方是引擎选择、Agent 专用预设、世界书条目注入参数等。

## 支持的搜索引擎

| 搜索引擎 | 说明 | 配置要求 |
|----------|------|----------|
| **DuckDuckGo** | 默认搜索引擎，无需 API 密钥 | 开箱即用 |
| **SearXNG** | 自托管的元搜索引擎，隐私友好 | 需要提供自托管实例的 URL |
| **Brave Search** | Brave 提供的搜索 API | 需要 API 密钥 |

搜索引擎通过 `provider` 配置项选择，各引擎的独立配置存储在 `providerSettings` 中。你还可以通过 `safeSearch` 配置安全搜索级别。

## 世界书条目管理

在预请求 Agent 模式下，搜索结果会被自动创建为世界书条目。这些条目的行为可以通过以下配置项控制：

| 配置项 | 说明 |
|--------|------|
| `lorebookDepth` | 条目在提示词中的注入深度 |
| `lorebookRole` | 条目的角色标记（如 system、assistant） |
| `lorebookEntryOrder` | 条目的排序权重 |
| `lorebookPosition` | 条目的注入位置 |

搜索结果条目可以设置为 `constant`（常驻激活）或通过关键词匹配激活，具体取决于 Agent 的判断和配置。

## 全局 API

搜索插件通过全局 API 供其他插件集成使用。例如[角色卡编辑助手](/zh-CN/features/card-editor/)的[普通弹窗](/zh-CN/features/card-editor/popup)和 [CardApp Studio](/zh-CN/features/card-editor/studio) 都已集成搜索能力，可以在编辑过程中联网搜索资料辅助角色卡 / CardApp 编辑。

### 属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `toolNames` | `Object` | 工具名常量对象，包含 `SEARCH` 和 `VISIT` |

### 方法

| 方法 | 返回值 | 说明 |
|------|--------|------|
| `getToolDefs()` | `Array` | 返回搜索工具的定义数组，包含工具名、参数 schema 等信息 |
| `isToolName(name)` | `boolean` | 判断给定名称是否为搜索插件注册的工具名 |
| `invoke(call, options)` | `Promise` | 调用搜索工具，`call` 包含工具名和参数 |
| `search(args)` | `Promise` | 直接执行搜索，返回搜索结果 |
| `visit(args)` | `Promise` | 直接访问指定网页，返回页面内容 |
| `getSettings()` | `Object` | 返回当前搜索插件的设置快照 |

### 使用示例

```javascript
const api = Luker.searchTools;
if (api) {
  // 检查是否为搜索工具
  api.isToolName('luker_web_search'); // true

  // 获取工具定义
  const defs = api.getToolDefs();

  // 直接调用搜索
  const results = await api.search({ query: '...', maxResults: 5 });

  // 访问网页
  const page = await api.visit({ url: 'https://...', maxChars: 10000 });
}
```

## 结果复用

搜索插件实现了精细的结果复用机制，避免在不必要的场景下重复执行搜索。

系统会自动判断是否可以复用上次搜索 Agent 的结果。复用需要同时满足以下条件：

1. 当前聊天 key 与上次快照的聊天 key 匹配
2. 用户锚点（最后一条用户消息的特征）与上次快照匹配
3. 当前生成类型属于可复用类型（如重新生成、继续生成等场景）

当结果被复用时，UI 会显示 `(reused)` 标记，提示用户本次生成使用了缓存的搜索结果。

## 消息操作的影响

搜索插件会监听消息的删除和编辑事件，自动维护内部状态的一致性：

- **消息删除** — 根据删除的消息范围更新搜索状态，确保不会引用已删除消息的搜索结果
- **消息编辑** — 根据编辑的消息位置更新搜索状态，可能使缓存的搜索结果失效

## 配置参考

| 设置项 | 说明 |
|--------|------|
| 启用搜索工具 | 开启工具模式，让模型在对话中自主调用搜索 |
| 启用预请求 Agent | 开启预请求 Agent 模式，每次生成前自动搜索 |
| 搜索引擎 | 选择搜索引擎（DuckDuckGo / SearXNG / Brave Search） |
| 搜索结果数量 | 每次搜索返回的结果条数 |
| 页面提取字符数 | 访问网页时提取的最大文本长度 |
| 安全搜索 | 搜索结果的安全过滤级别 |
| Agent API 预设 | 预请求 Agent 使用的 API 连接预设（空值使用主连接） |
| Agent 预设 | 预请求 Agent 使用的预设（空值使用主预设） |
| Agent 最大轮次 | 预请求 Agent 的最大搜索轮次 |

::: info 相关页面
- [角色卡编辑助手](/zh-CN/features/card-editor/) — 编辑助手概览（公共能力与入口）
- [普通弹窗模式](/zh-CN/features/card-editor/popup) — 弹窗中的联网搜索
- [CardApp Studio](/zh-CN/features/card-editor/studio) — Studio 中的联网搜索能力
- [CardApp](/zh-CN/features/cardapp) — 角色卡应用化概念
:::
