# 函数调用运行时

Luker 内置了统一的函数调用（Function Calling）运行时，让 AI 角色能够执行结构化的操作——搜索信息、管理记忆、操作状态——而不仅仅是生成文本。无论底层模型是否原生支持 tool call，Luker 都提供一致的调用体验。

## 统一的函数调用框架

函数调用运行时提供了一个统一的框架来管理工具的注册、调用和结果处理。核心设计目标是：

- **模型无关** — 同一套工具定义可以在不同的 LLM 提供商之间无缝切换
- **协议透明** — 上层工具不需要关心底层使用的是原生 tool call 还是文本协议
- **流式兼容** — 支持流式响应中的工具调用解析和规范化

## 原生模式

当连接的模型原生支持 Function Calling 时（如 OpenAI、Claude、Gemini），Luker 使用模型的原生 tool call 格式。运行时会：

1. 将注册的工具转换为模型要求的 schema 格式
2. 在请求中附加工具定义
3. 解析模型返回的工具调用结构
4. 执行对应的工具函数
5. 将执行结果注入上下文，继续对话

原生模式的优势在于利用了模型经过专门训练的工具调用能力，调用格式更规范，参数解析更准确。

## 纯文本模式

对于不支持原生 Function Calling 的模型，Luker 提供了纯文本协议作为降级方案。运行时会在 System Prompt 中自动注入工具使用说明，引导模型以特定的文本格式输出工具调用请求。

纯文本模式的工作流程：

1. 在 System Prompt 中描述可用工具及其参数格式
2. 模型在回复中以约定的文本标记输出工具调用
3. 运行时解析文本中的工具调用标记
4. 执行工具并将结果注入上下文
5. 继续生成后续回复

::: tip 适用场景
纯文本模式适用于本地部署的开源模型、不支持 tool call 的 API 提供商，或者需要更灵活的工具调用格式的场景。虽然准确性不如原生模式，但大幅扩展了函数调用的适用范围。
:::

## 多工具调用支持

运行时支持在单次生成中调用多个工具（multi-tool / parallel tool calls）。当模型在一次响应中请求调用多个工具时，运行时会：

- 按顺序或并行执行所有请求的工具
- 收集所有工具的执行结果
- 将结果批量注入上下文
- 触发后续生成

这对于需要同时查询多个信息源的场景尤为重要，例如同时搜索网页和查询记忆。

## 流式工具调用规范化

在流式响应（streaming）场景下，工具调用的数据可能分散在多个数据块中。运行时会自动将分散的工具调用片段重新组装为完整的调用结构，确保无论是流式还是非流式响应，上层逻辑都能获得一致的工具调用数据。

## 可配置的错误处理

当工具执行失败时，运行时会将错误信息格式化后注入上下文，让模型知道工具调用失败并可以选择：

- 使用不同的参数重试
- 尝试其他工具
- 直接基于已有信息回复用户

错误信息包含工具名称、失败原因等结构化数据，帮助模型做出合理的后续决策。

## Connection Manager 中的独立开关

函数调用功能可以在连接级别独立启用或禁用。不同的连接配置可以有不同的函数调用设置，例如：

- 主力连接启用完整的函数调用
- 备用连接禁用函数调用以节省 token
- 特定连接只启用部分工具

这与[预设解耦](/zh-CN/improvements/preset-decoupling)机制协同工作——函数调用开关属于连接配置的一部分，切换预设不会影响它。

## 内置工具

搜索插件注册了全局工具：网页搜索（支持 DuckDuckGo、SearXNG、Brave Search 等搜索引擎）和网页访问。其他模块（编辑助手、编排器、预设助手）在各自的独立上下文中使用工具调用机制，不通过全局工具注册表。

::: info 扩展工具
第三方扩展可以通过 `context.registerFunctionTool()` 注册自定义工具（由核心的 `ToolManager` 提供）。工具定义遵循统一的 schema 格式，注册后自动适配原生模式和纯文本模式。详见[扩展 API — 工具注册](/zh-CN/development/extension-api#工具注册)文档。
:::

## 底层实现

对于想了解内部实现的开发者，函数调用系统由三个核心模块组成：

| 模块 | 文件 | 职责 |
|------|------|------|
| **ToolManager** | `tool-calling.js` | 全局工具注册表、工具 schema 转换、流式工具调用片段重组、工具执行编排和结果注入 |
| **函数调用运行时** | `function-call-runtime.js` | 纯文本模式支持——构建工具协议消息注入 System Prompt（`buildPlainTextToolProtocolMessage`）、从文本响应中提取函数调用（`extractAllFunctionCallsFromText` / `extractToolCallsFromTextResponse`）、将附加文本合并到 prompt messages（`mergeUserAddendumIntoPromptMessages` / `mergeSystemAddendumIntoPromptMessages`） |
| **请求引擎** | `openai.js`（`sendOpenAIRequest`） | 核心 LLM 请求函数，处理预设解析、连接覆盖，并将请求分发到对应的 API 后端 |

**原生模式**的流程：`ToolManager` 将注册的工具转换为模型的 schema → `sendOpenAIRequest` 将其附加到 API 请求 → 模型返回结构化的工具调用 → `ToolManager` 解析、执行并注入结果。

**纯文本模式**的流程多了一层：`function-call-runtime.js` 将工具描述注入 System Prompt → 模型输出文本格式的工具调用 → `function-call-runtime.js` 解析文本 → `ToolManager` 执行并注入结果。

需要自行发送带工具调用的 LLM 请求的插件，直接使用 `sendOpenAIRequest` 并传入 `tools` 和 `toolChoice` 参数——这与全局工具注册表是分开的。详见[扩展 API — 发送 LLM 请求](/zh-CN/development/extension-api#发送-llm-请求)文档。

## 相关页面

- [改进总览](/zh-CN/improvements/overview) — 所有技术改进的概述
- [预设解耦](/zh-CN/improvements/preset-decoupling) — 函数调用开关与连接配置的关系
- [扩展 API](/zh-CN/development/extension-api) — 插件开发指南，包含工具注册和 LLM 请求 API
