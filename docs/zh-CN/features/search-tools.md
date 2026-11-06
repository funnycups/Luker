# 搜索插件

搜索插件（Search Tools）为 AI 角色提供联网搜索能力，让角色在对话中可以检索实时信息并将搜索结果注入上下文。搜索插件支持多种搜索引擎后端，并提供多种工作模式以适应不同的使用场景。

## 工作模式

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
- 预请求 Agent 可以使用独立的提示词预设与 API 连接，与创作模型分开
- Agent 运行工具调用循环：只要需要检索或写入就持续调用工具，回复纯文本且不调用工具时即停止。没有固定轮次上限
- Agent 可以回读、更新和删除自己创建的条目，因此会更新已有笔记，避免重复创建
- 搜索结果自动创建为世界书条目，创作 LLM 在生成时可以直接读取
- 运行过程流式显示在[运行面板](/zh-CN/development/extension-api/run-panel)中，该面板自动打开，显示每一轮、调用的工具及其结果

![预请求搜索 Agent 在运行面板中的运行](/images/search-tools/run-panel.png)

::: tip 模式的选择
**工具模式**适合需要模型在对话中自主决定何时搜索的场景——例如用户问「最近有什么新闻」时，模型会自动调用搜索工具获取信息。搜索行为由模型根据对话内容自主触发。

**预请求 Agent 模式**则是在 AI 生成前自动执行搜索，搜索过程与主对话完全分离。适合希望回复有最新信息支撑的场景。
:::

## 设置面板

搜索插件的所有配置在扩展面板的「搜索工具」子项里：

![搜索工具设置面板](/images/search-tools/search-tools-settings.png)

顶部开关分别对应上文的模式：**暴露工具给主模型** 是工具模式，**请求前运行搜索 Agent** 是预请求 Agent 模式，两者可以单独或同时启用。下方是引擎选择、Agent 专用预设、世界书条目注入参数等。「显示搜索运行面板」按钮可重新打开上次运行。

## 支持的搜索引擎

| 搜索引擎 | 说明 | 配置要求 |
|----------|------|----------|
| **DuckDuckGo** | 默认搜索引擎，无需 API 密钥 | 开箱即用 |
| **SearXNG** | 自托管的元搜索引擎，隐私友好 | 需要提供自托管实例的 URL |
| **Brave Search** | Brave 提供的搜索 API | 需要 API 密钥 |
| **Tavily** | 面向 LLM 的搜索 API | 需要 API 密钥 |
| **Exa** | 神经 / 语义搜索 API | 需要 API 密钥 |
| **Serper** | 通过 serper.dev 获取 Google 结果 | 需要 API 密钥 |
| **SerpApi** | 通过 SerpApi 获取 Google 结果 | 需要 API 密钥 |
| **Z.AI** | Z.AI 网页搜索 | 需要 API 密钥 |
| **DeepSeek** | DeepSeek 原生网页搜索 | 需要 DeepSeek API 密钥 |

搜索引擎通过 `provider` 配置项选择，各引擎的独立配置存储在 `providerSettings` 中。安全搜索适用于 DuckDuckGo、SearXNG、Brave Search、Tavily、Exa 和 SerpApi，可通过 `safeSearch` 配置；Serper、Z.AI 与 DeepSeek 不提供安全搜索。

## 世界书条目管理

在预请求 Agent 模式下，搜索结果会被自动创建为世界书条目。这些条目的行为可以通过以下配置项控制：

| 配置项 | 说明 |
|--------|------|
| `lorebookDepth` | 条目在提示词中的注入深度 |
| `lorebookRole` | 条目的角色标记（如 system、assistant） |
| `lorebookEntryOrder` | 条目的排序权重 |
| `lorebookPosition` | 条目的注入位置 |

搜索结果条目可以设为常驻激活，或通过关键词匹配激活，具体取决于 Agent 的判断与配置。

## 供其他插件使用

搜索能力也供角色卡编辑助手等插件调用，用于在编辑过程中联网查资料。开发者接口见[扩展 API](/zh-CN/development/extension-api/)。

## 结果复用

搜索插件实现了精细的结果复用机制，避免在不必要的场景下重复执行搜索。

系统会自动判断是否可以复用上次搜索 Agent 的结果。复用需要同时满足以下条件：

1. 当前聊天 key 与上次快照的聊天 key 匹配
2. 用户锚点（最后一条用户消息的特征）与上次快照匹配
3. 当前生成类型属于可复用类型（如重新生成、继续生成等场景）

当结果被复用时，UI 会显示 `(reused)` 标记，提示用户本次生成使用了缓存的搜索结果。

## 消息操作的影响

聊天结构变化时，插件会保持共享世界书与已保存的搜索结果一致：

- **删除消息** —— 被删除消息所在轮次及其之后的搜索结果随之丢弃
- **切换 swipe** —— 被切换轮次的搜索结果随之丢弃
- **编辑消息** —— 已保存的结果保持不变。编辑某次搜索所依据的那一轮，会让下一次生成重新搜索，而不是复用上一次的结果

## 配置参考

| 设置项 | 说明 |
|--------|------|
| 启用搜索工具 | 开启工具模式，让模型在对话中自主调用搜索 |
| 启用预请求 Agent | 开启预请求 Agent 模式，生成前自动搜索 |
| 搜索引擎 | 选择搜索引擎（DuckDuckGo / SearXNG / Brave Search / Tavily / Exa / Serper / SerpApi / Z.AI / DeepSeek） |
| 搜索结果数量 | 单次搜索返回的结果条数 |
| 页面提取字符数 | 访问网页时提取的最大文本长度 |
| 安全搜索 | 搜索结果的安全过滤级别 |
| Agent API 预设 | 预请求 Agent 使用的 API 连接预设（空值使用主连接） |
| Agent 预设 | 预请求 Agent 使用的预设（空值使用主预设）。下拉框旁的问号按钮说明该槽位需要的预设类型 |

::: info 相关页面
- [角色卡编辑助手](/zh-CN/features/card-editor/) —— 编辑助手概览（公共能力与入口）
- [普通弹窗模式](/zh-CN/features/card-editor/popup) —— 弹窗中的联网搜索
- [CardApp Studio](/zh-CN/features/card-editor/studio) —— Studio 中的联网搜索能力
- [CardApp](/zh-CN/features/cardapp) —— 角色卡应用化概念
:::
