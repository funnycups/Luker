# API 连接

Luker 本身不包含 AI 模型，它通过 API 连接到外部的大语言模型（LLM）服务来生成回复。本页介绍如何配置和管理 API 连接。

## 支持的 API 类型

Luker 支持多种主流的 LLM API：

### Chat Completion（聊天补全）

| API 提供商 | 说明 |
|-----------|------|
| **OpenAI** | GPT 系列模型（如 GPT-5 等） |
| **Anthropic** | Claude 系列模型 |
| **Google AI Studio / Vertex AI** | Gemini 系列模型 |
| **OpenRouter** | 聚合多家模型的中转服务 |
| **自定义 OpenAI 兼容 API** | 任何兼容 OpenAI API 格式的服务（如各类中转站） |

### Text Completion（文本补全）

| API 提供商 | 说明 |
|-----------|------|
| **KoboldAI** | 本地运行的开源模型 |
| **Ollama** | 本地模型管理和推理工具 |
| **llama.cpp / TabbyAPI** | 本地推理后端 |
| **Text Generation WebUI** | Oobabooga 的 Web 界面 |

::: info
Chat Completion 和 Text Completion 是两种不同的 API 模式。大多数商业 API（OpenAI、Claude、Gemini）使用 Chat Completion 模式；本地模型通常两种都支持。如果你不确定，Chat Completion 是更常用的选择。
:::

## 连接管理器

Luker 提供了**连接管理器**（Connection Manager）来管理多个 API 连接配置。

### 创建连接配置

1. 打开设置面板，找到连接管理器
2. 点击「新建配置」
3. 填写配置名称（例如「Claude Sonnet 4.5」「GPT-5」）
4. 选择 API 类型并填写连接参数
5. 保存配置

### 切换连接

在连接管理器的下拉列表中选择不同的配置即可一键切换。切换连接不会影响你当前使用的聊天补全预设。

### 管理多个连接

你可以创建任意数量的连接配置，例如：

- 一个用于日常对话的低成本模型
- 一个用于高质量创作的旗舰模型
- 一个用于本地模型的配置

通过连接管理器可以在它们之间快速切换，无需每次都重新填写 API 地址和密钥。

## API 密钥配置

### 获取 API 密钥

每个 API 提供商都有自己的密钥获取方式：

- **OpenAI**：在 [platform.openai.com](https://platform.openai.com) 创建 API Key
- **Anthropic**：在 [console.anthropic.com](https://console.anthropic.com) 创建 API Key
- **Google**：在 [aistudio.google.com](https://aistudio.google.com) 获取 API Key
- **OpenRouter**：在 [openrouter.ai](https://openrouter.ai) 注册并获取 Key

### 填写密钥

在连接配置中填入对应的 API 密钥。密钥会安全地存储在 Luker 的服务端，不会在前端暴露。

::: tip
如果你使用的是自部署的 Luker 实例，API 密钥存储在你自己的服务器上。如果使用他人提供的 Luker 实例，请注意密钥安全。
:::

## 模型选择

配置好 API 连接后，你需要选择要使用的具体模型。Luker 会根据 API 类型动态加载可用的模型列表。

对于 Claude 和 Gemini 等 API，Luker 支持**动态模型列表**——自动从 API 获取最新的可用模型，无需手动更新。你也可以为每个 API 源自定义模型列表。详见[其他改进](/zh-CN/improvements/other)。

## OpenRouter 上的 Gemini 历史缓存

在 **OpenRouter Gemini 提示缓存**区域，启用**缓存稳定的聊天历史**后，Luker 会显式缓存一段包含系统提示、总结和较早对话消息的前缀。此功能默认关闭，仅对声明支持显式缓存的 OpenRouter Gemini 模型生效；直连 Google AI Studio/Vertex 以及其他模型保持原有行为。

**不缓存最近几轮**默认为 **2** 个完整回合，当前输入也始终不缓存。如果正则或扩展会随深度变化改写较早的消息，请调大此值。边界从最终发出的消息中选取，因此连续的 user 消息算作一个回合，工具结果不算新的 user 回合。消息文本、角色、总结位置、工具调用和多媒体内容均保持不变。

Gemini 对普通消息内容只使用最后一个显式缓存标记。因此 Luker 将一个标记固定在相同的历史位置，而不是每轮都向后推进，并在每次复用前检查前缀。五分钟后，或者编辑、swipe、总结替换、上下文裁剪、系统提示或工具定义改变了该前缀时，会选取新的边界。新消息在下次刷新前始终位于固定前缀之外。调大不缓存尾部设置也会在下次请求时生效。

已有的**缓存 system prompt**开关适用于历史不足的短请求。历史缓存启用时，Luker 只放置一个历史标记，不再添加与之竞争的系统标记。其他扩展提供的显式标记会被保留并优先生效。

这些设置随连接配置保存，也可以用 `/gemini-enable-history-cache` 和 `/gemini-cache-keep-recent-turns` 读取或修改。不经过 UI 的后端调用可以在 `config.yaml` 中使用 `gemini.enableHistoryCache` 和 `gemini.cacheKeepRecentTurns`。

### 检查效果

在请求检查器中查看最终发出的请求：被选中的历史消息的最后一个文本块应包含 `cache_control: { "type": "ephemeral" }`。服务器日志会报告本地边界计划的状态：`created`、`reused`、`refreshed`、`no-history` 或 `external-breakpoint`。**边界被复用并不代表提供商缓存命中。** 请跨多个回合检查 OpenRouter 返回的 `usage.prompt_tokens_details.cached_tokens`、缓存写入次数和总费用。

OpenRouter 文档说明 Gemini 显式缓存有五分钟的生命周期，且缓存写入和存储都会计费。缓存前缀较大时，如果频繁重建或只用一次，费用可能反而更高。长时间停顿、上游路由、最小缓存长度和服务器重启都会降低复用率。Luker 只在内存中保存有界的、按用户/凭据/会话隔离的哈希和位置，不保存提供商缓存对象；它无法保证命中，也无法控制上游缓存的生命周期。参见 [OpenRouter 的 Gemini 缓存文档](https://openrouter.ai/docs/guides/best-practices/prompt-caching#google-gemini)。

## 代理设置

如果你需要通过代理（Reverse Proxy）访问 API，可以在连接配置中设置：

- **代理地址**：中转服务的 URL
- **代理密码**：中转服务的认证密码（如果需要）

代理设置是连接配置的一部分，不同的连接配置可以使用不同的代理。

## 与预设解耦的关系

在 Luker 中，API 连接和聊天补全预设是**完全独立**的两个概念：

- **连接配置**管理的是「用哪个 API、哪个模型、通过什么地址访问」
- **聊天补全预设**管理的是「用什么提示词、什么采样参数」

你可以自由组合它们。例如：

- 用同一个 Claude API 连接，搭配不同的预设来切换写作风格
- 用同一套精心调教的预设，在 OpenAI 和 Claude 之间切换对比效果

这种解耦设计让你可以独立地优化连接和预设，互不干扰。

详见 [预设系统](/zh-CN/basics/presets) 和 [预设解耦](/zh-CN/improvements/preset-decoupling)。

## 斜杠命令

Luker 的连接管理器提供了斜杠命令，方便高级用户快速操作：

| 命令 | 说明 |
|------|------|
| `/profile [名称]` | 切换到指定连接配置，或查看当前配置名 |
| `/profile-list` | 列出所有连接配置 |
| `/profile-create <名称>` | 用当前设置创建新配置 |
| `/profile-update` | 更新当前选中的配置 |

## 请求检查器

Luker 内置了请求检查器（Request Inspector），可以查看每次生成请求的详细信息，包括发送给 API 的完整请求内容和返回的响应。这在调试连接问题或优化提示词时非常有用。

## 下一步

- 了解 [预设系统](/zh-CN/basics/presets) 如何控制 AI 的回复行为
- 了解 [角色卡](/zh-CN/basics/character-cards) 的基本概念
- 了解 [聊天管理](/zh-CN/basics/chat-management) 的基本操作
