# 扩展 API 参考

本文档是 Luker 扩展 API 的完整参考，面向插件开发者。所有 API 均通过 `Luker.getContext()` 暴露。完整参考分为以下子页面：

| 页面 | 涵盖内容 |
| --- | --- |
| [聊天与状态](/zh-CN/development/extension-api/chat-and-state) | 聊天数据、统一消息 API、聊天持久化、聊天状态、楼层状态、角色状态 |
| [预设与提示词](/zh-CN/development/extension-api/presets-and-prompts) | `context.presets.*`、`buildPresetAwarePromptMessages`、`resolveWorldInfoForMessages` |
| [生成请求](/zh-CN/development/extension-api/generation) | `sendOpenAIRequest`、工具注册、连接配置解析 |
| [插件集成](/zh-CN/development/extension-api/plugin-integration) | 正则运行时、搜索工具、扩展间通信、事件系统 |
| [底层端点](/zh-CN/development/extension-api/low-level-endpoints) | 原始 HTTP 路由（仅供高级 / 调试场景使用） |

## 全局入口

```js
const context = Luker.getContext();
```

| 别名 | 说明 |
|------|------|
| `Luker.getContext()` | 推荐使用 |
| `SillyTavern.getContext()` | 兼容别名 |
| `st.getContext()` | 兼容别名 |

新插件应统一使用 `Luker.getContext()`。兼容别名仅为迁移期保留。

## 与 SillyTavern 的 API 差异

Luker 基于 SillyTavern 构建，但在 API 层面有以下主要差异：

| 领域 | SillyTavern | Luker |
|------|-------------|-------|
| 聊天持久化 | 整文件覆写 | Patch-first（RFC 6902 增量更新） |
| 聊天绑定状态 | 仅 `chat_metadata` | 新增聊天状态机制 |
| 预设管理 | 直接导入内部模块 | `context.presets.*` 统一 API |
| 提示词组装 | 需要手动拼接 | `buildPresetAwarePromptMessages()` |
| 世界书模拟 | 无 | `simulateWorldInfoActivation()` |
| 生成钩子 | 基础事件 | 新增 `GENERATION_CONTEXT_READY`、`GENERATION_BEFORE_WORLD_INFO_SCAN` 等细粒度钩子 |
| 事件排序 | 注册顺序 | 支持 `priority`、`pluginOrder`、`makeFirst`/`makeLast` |
| 正则运行时 | 无插件 API | `registerManagedRegexProvider()` |
| 搜索工具 | 无插件 API | `Luker.searchTools` 全局 API |
| 函数调用 | 基础 `ToolManager` | 纯文本模式支持 + 连接级独立开关 + `sendOpenAIRequest` 预设覆盖 |
| 连接配置 | 全局单一 | `context.presets.resolve()` 支持按预设解析连接配置 |

> [!IMPORTANT]
> 优先使用 `Luker.getContext()` 提供的 API，而非直接调用底层 HTTP 端点。Context API 封装了 patch-first 语义、冲突处理和重试逻辑，直接调用端点需要自行处理这些细节。

## 相关页面

- [前端插件开发](/zh-CN/development/frontend-plugin) — 插件结构、事件系统、UI 集成
- [角色卡开发](/zh-CN/development/card-developers) — 角色卡扩展字段和 CardApp
- [增量同步](/zh-CN/improvements/incremental-sync) — 增量保存的技术细节
- [预设解耦](/zh-CN/improvements/preset-decoupling) — 预设与 API 选择的解耦机制
