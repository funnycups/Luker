# 统一生成层

统一生成层（Unified Generation Layer）是 Luker 引入的后端架构改进，将分散在各个 API 端点中的生成逻辑收敛到一个共享模块中，实现多后端的统一封装。

## 问题背景

在 SillyTavern 中，不同的 AI 后端（OpenAI、Anthropic、Google、Kobold 等）各自拥有独立的代码路径。每个后端端点文件独立处理请求构建、流式响应解析、错误处理等逻辑。这导致了以下问题：

- **重复代码** — 相似的流式处理、错误重试逻辑在多个文件中重复实现
- **不一致的行为** — 不同后端的 Token 统计、错误响应格式各不相同
- **难以扩展** — 添加新的后端需要从头实现完整的请求/响应处理链
- **无法统一计量** — 缺少跨后端的 Token 用量追踪能力

## 解决方案

Luker 新增了统一生成层端点（`/api/backends/luker-generation`），作为前端发起 AI 生成请求的主要路径。该端点接收前端的生成请求，根据当前的 Chat Completion Source 转发到对应的上游 API，并在统一的处理管线中完成流式响应、Token 计量、生成确认和持久化。

### 多后端统一封装

统一生成层支持以下后端的统一处理：

- **OpenAI** 及其兼容 API
- **Anthropic**（Claude）
- **Google**（Gemini / Vertex AI）
- **Kobold** / **TabbyAPI**
- 其他 Chat Completion 兼容后端

前端通过统一生成层发起生成请求，由该端点负责路由到正确的上游服务，而非前端直接调用各个后端的独立端点。各个后端的独立端点（`chat-completions.js`、`kobold.js` 等）仍然存在并独立集成了请求检查器，但统一生成层提供了更完整的处理管线。

### 共享 Token 计量

统一生成层在生成请求的前后自动调用[请求检查器](/zh-CN/improvements/request-inspector)：

1. 流式传输完成后调用 `completeInspectionFromStream` 从流事件中记录 Token 用量
2. 生成失败时调用 `failInspection` 记录错误信息
3. 生成中止时调用 `abortInspection` 记录中断

注意：`startInspection` 由后端端点（如 `chat-completions.js`）调用，而非由生成层本身调用。

这确保了无论使用哪个后端，Token 消耗都能被准确追踪。

### 统一流式处理

对于 SSE 流式响应，统一生成层提供共享的流解析逻辑：

- 解析不同后端的 SSE 事件格式
- 从流式事件中提取 Token 用量信息
- 统一的流中断和恢复处理
- 与 [WebSocket 代理](/zh-CN/improvements/ws-proxy)配合支持流偏移恢复

### 统一错误处理

不同后端返回的错误格式各异，统一生成层将它们规范化为一致的错误响应结构，简化前端的错误处理逻辑。

## 架构关系

```
前端请求
  ↓
各后端端点文件（chat-completions.js、kobold.js 等）
  ↓
统一生成层
  ├── Token 计量 → 请求检查器
  ├── 流式处理 → SSE 解析
  └── 错误处理 → 规范化响应
  ↓
上游 AI 服务
```

> [!NOTE]
> 统一生成层是一个内部模块，对前端透明。用户无需关心它的存在，只需享受它带来的一致体验。

## 与其他模块的关系

- **[请求检查器](/zh-CN/improvements/request-inspector)** — 统一生成层是请求检查器的主要调用方
- **[认证与配额](/zh-CN/improvements/auth-and-quota)** — 存储配额中间件在统一生成层之前执行，拦截超额请求
- **`chats.js`** — 生成完成后触发 `acknowledge-generation` 流程，将生成结果与聊天记录关联
