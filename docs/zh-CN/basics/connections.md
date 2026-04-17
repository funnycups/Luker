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
