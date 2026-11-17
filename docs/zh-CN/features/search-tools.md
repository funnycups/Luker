# 搜索插件

搜索插件（Search Tools）为 AI 角色提供联网搜索能力，让角色在对话中检索实时信息并将结果注入上下文。搜索插件支持多种搜索引擎后端，并提供多种工作模式以适应不同使用场景。

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

### 工具模式

搜索功能作为创作 LLM 的可调用工具注册到[函数调用运行时](/zh-CN/improvements/function-call-runtime)中。当 AI 判断需要搜索信息时，主动发起联网搜索或网页读取调用，并将结果作为工具返回值送入上下文。

### 预请求 Agent 模式

在创作 LLM 生成回复之前，自动运行一个独立的搜索 Agent。Agent 分析当前对话内容，判断是否需要搜索，并将结果写入世界书条目：

- 通过**请求前运行搜索 Agent** 开关启用
- 可使用独立的提示词预设与 API 连接，与创作模型分开
- 运行工具调用循环，直到不再调用工具并返回纯文本为止
- 可回读、更新和删除自己创建的条目，修订已有笔记以保持整洁
- 搜索结果自动保存为世界书条目，供创作 LLM 在生成时读取
- 运行过程实时流式显示在共享**运行面板**悬浮窗中（默认开启**运行时自动打开**，也可在运行面板菜单里切换）

![预请求搜索 Agent 在运行面板中的运行](/images/search-tools/run-panel.png)

::: tip 模式的选择
**工具模式**适合模型在对话中自主决定何时搜索的场景——例如用户询问近期新闻时。

**预请求 Agent 模式**则在 AI 生成前自动执行搜索，使检索过程与主对话分离。
:::

## 设置面板

搜索插件的配置位于**扩展 → 搜索工具**：

![搜索工具设置面板](/images/search-tools/search-tools-settings.png)

顶部开关对应两种工作模式：**暴露工具给主模型**为工具模式，**请求前运行搜索 Agent** 为预请求 Agent 模式，两者可单独或同时启用。下方可配置搜索引擎、Agent 专用预设与世界书注入参数；点击**显示搜索运行面板**可随时打开共享运行面板。

## 支持的搜索引擎

| 搜索引擎 | 说明 | 配置要求 |
|----------|------|----------|
| **DuckDuckGo** | 默认搜索引擎，无需 API 密钥 | 开箱即用 |
| **SearXNG** | 自托管元搜索引擎 | 需要提供自托管实例 URL |
| **Brave Search** | Brave 提供的搜索 API | 需要 API 密钥 |
| **Tavily** | 面向 LLM 的搜索 API | 需要 API 密钥 |
| **Exa** | 神经 / 语义搜索 API | 需要 API 密钥 |
| **Serper** | 通过 serper.dev 获取 Google 结果 | 需要 API 密钥 |
| **SerpApi** | 通过 SerpApi 获取 Google 结果 | 需要 API 密钥 |
| **Z.AI** | Z.AI 网页搜索 | 需要 API 密钥 |
| **DeepSeek** | DeepSeek 原生网页搜索 | 需要 DeepSeek API 密钥 |

DuckDuckGo、SearXNG、Brave Search、Tavily、Exa 和 SerpApi 支持安全搜索过滤。

## 世界书条目管理

在预请求 Agent 模式下，搜索结果自动写入世界书条目。可以在设置面板中调整**注入位置**、**注入深度**、**注入角色**与**注入顺序**，并通过**管理已保存的搜索条目**查看或清理记录。

## 供其他功能使用

工作台 AI 迭代（角色卡与世界书编辑）、CardApp Studio 与角色卡编辑助手弹窗同样支持调用搜索能力，在编辑设定时联网查阅资料。开发者接口见[扩展 API](/zh-CN/development/extension-api/)。

## 结果复用

满足以下全部条件时，系统复用上一次搜索 Agent 的结果：

1. 当前聊天与上次快照为同一聊天
2. 最后一条用户消息与上次快照一致
3. 当前生成类型支持复用（如重新生成、继续生成）

结果复用时，运行面板会显示已复用标记。

## 消息操作的影响

聊天内容变化时，插件会同步维护已保存的搜索条目：

- **删除消息** —— 被删除消息所在轮次及其后的搜索结果一并清除
- **切换分支** —— 被切换轮次的搜索结果清除
- **编辑消息** —— 已保存的结果保留；编辑某次搜索对应的轮次后，下次生成将重新执行搜索

## 配置参考

| 设置项 | 说明 |
|--------|------|
| **暴露工具给主模型** | 开启工具模式，让模型在对话中自主调用搜索 |
| **请求前运行搜索 Agent** | 开启预请求 Agent 模式，生成前自动搜索 |
| **搜索引擎** | 选择使用的搜索引擎 |
| **默认最大搜索结果数** | 单次搜索返回的结果条数 |
| **默认页面摘要最大字符数** | 访问网页时提取的最大文本长度（`0` 为不截断） |
| **安全搜索** | 搜索结果的安全过滤级别 |
| **Agent API 预设** | 预请求 Agent 使用的 API 连接预设（留空使用主连接） |
| **Agent 预设** | 预请求 Agent 使用的预设（留空使用主预设），下拉框旁的帮助按钮说明所需预设类型 |

::: info 相关页面
- [工作台](/zh-CN/features/workbench) —— 在工作台 AI 迭代中结合联网搜索
- [角色卡编辑助手](/zh-CN/features/card-editor/) —— 编辑助手概览
- [CardApp Studio](/zh-CN/features/card-editor/studio) —— Studio 中的联网搜索能力
- [运行面板 API](/zh-CN/development/extension-api/run-panel) —— 共享运行面板开发参考
:::
