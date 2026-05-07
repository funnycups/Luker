# 请求检查器

请求检查器（Request Inspector）是 Luker 的核心后端模块之一，用于追踪每个 AI 生成请求从发起到完成的完整生命周期，并记录详细的 Token 用量数据。它是生成诊断能力的基础设施。

## 问题背景

在 SillyTavern 中，AI 生成请求发出后，后端不会系统性地记录请求的 Token 消耗。用户无法得知每次生成实际花费了多少 Token，管理员也无法追踪多用户场景下的资源使用情况。

Luker 实现了一套完整的请求生命周期追踪系统，覆盖文本生成和图像生成两类请求。

## 核心能力

### 请求生命周期追踪

每个 AI 生成请求都会经历以下状态流转：

1. **开始**（`startInspection`）— 记录请求元数据，标记请求进入追踪
2. **完成**（`completeInspection`）— 请求成功返回，记录 Token 用量
3. **失败**（`failInspection`）— 请求出错，记录错误信息
4. **中止**（`abortInspection`）— 用户主动取消生成

```d2
direction: down

start: "" {
  shape: circle
  width: 20
  style.fill: "#222"
}
in_progress: "进行中"
done: "完成"
failed: "失败"
aborted: "中止"
end_: "" {
  shape: circle
  width: 20
  style.fill: "#222"
}

note: "流式响应额外通过 completeInspectionFromStream\n从 SSE 事件提取 usage" {
  shape: text
  style.fill: "#fff8d4"
}

start -> in_progress: "startInspection 记录元数据"
in_progress -> done: "completeInspection 记录 Token 用量"
in_progress -> failed: "failInspection 记录错误信息"
in_progress -> aborted: "abortInspection 用户取消"
done -> end_
failed -> end_
aborted -> end_
in_progress -- note: {style.stroke-dash: 3}
```

### Token 用量统计

请求检查器记录每次生成的详细 Token 数据：

- **Prompt Tokens** — 输入提示词消耗的 Token 数
- **Completion Tokens** — 模型生成内容消耗的 Token 数
- **Total Tokens** — 总用量

这些数据从 API 响应中提取，并与用户账户关联，用于用量统计和诊断分析。

### 流式响应的 Token 统计

对于流式（SSE）响应，Token 用量信息通常包含在最后一个 SSE 事件中。请求检查器通过 `completeInspectionFromStream` 和 `extractUsageFromStreamEvents` 函数，从 SSE 事件流中提取 `usage` 字段，确保流式生成也能准确统计 Token 消耗。

### 图像生成请求追踪

除文本生成外，请求检查器还支持追踪图像生成请求。通过独立的 `startImageInspection` / `completeImageInspection` / `failImageInspection` 函数，覆盖所有图像生成后端的请求记录。

## 主要能力

| 函数 | 用途 |
|------|------|
| `startInspection(request)` | 开始追踪一个生成请求 |
| `completeInspection(request, payload, rawApiResponse?)` | 标记请求完成并记录结果 |
| `failInspection(request, errorMessage, httpStatus?)` | 标记请求失败 |
| `abortInspection(request)` | 标记请求被中止 |
| `completeInspectionFromStream(request, events)` | 从流式事件中提取用量并完成追踪 |
| `extractUsageFromStreamEvents(events, source)` | 从 SSE 事件数组中提取 Token 用量 |
| `startImageInspection(request, meta)` | 开始追踪图像生成请求 |
| `completeImageInspection(request, resultMeta?)` | 完成图像生成追踪 |
| `failImageInspection(request, errorMessage, httpStatus?)` | 标记图像生成失败 |

## 集成点

请求检查器被以下模块调用：

- **`chat-completions.js`** — 在 OpenAI 兼容 API 调用中记录 Token 用量
- **统一生成层** — 在[统一生成层](/zh-CN/improvements/generation-layer)中统一调用
- **`chats.js`** — 在 `acknowledge-generation` 端点中关联生成结果

## Token 用量统计

请求检查器追踪的 Token 用量是独立的统计功能，用于帮助用户和管理员了解 AI 生成的资源消耗情况。这与[认证与配额](/zh-CN/improvements/auth-and-quota)中的存储配额管理是两个独立的系统：

- **Token 用量统计**：请求检查器记录每次 AI 生成的 Token 消耗，提供用量可视化和诊断数据
- **存储配额管理**：管理文件存储空间的分配和限制

> [!TIP]
> 请求检查器在服务器启动时通过 `server-startup.js` 自动初始化，无需额外配置。
