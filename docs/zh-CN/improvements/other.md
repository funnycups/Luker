# 其他改进

除了前面介绍的主要架构改进外，Luker 还在连接管理、网络代理、UI 交互、扩展系统、性能优化等多个方面进行了增强。

## 连接管理器改进

Luker 对 SillyTavern 已有的 Connection Profiles 功能进行了增强，使其与[预设解耦](/zh-CN/improvements/preset-decoupling)体系配合工作。改进后的连接管理器将连接配置与聊天补全预设完全分离——连接配置仅管理「连到哪里」（API 地址、密钥、代理等），不再包含生成参数。

启动时自动执行迁移，清理旧配置中残留的预设字段和正则字段。新增了 plain-text Function Calling 的开关和重试配置，可按连接配置独立设置。支持通过斜杠命令 `/profile` 快速切换配置。


## 提示词分组

Luker 在 PromptManager 中新增了提示词条目的分组能力。用户可以将多个提示词条目归入命名分组，在 UI 中以可折叠的分组形式展示。分组支持创建、重命名、删除操作；删除分组时，组内成员变为未分组状态。分组信息随预设保存和加载。

## 预设分组

预设选择器同样支持分组功能。用户可以将预设归入命名分组，在下拉选择器中以分组 header + 成员的层级结构展示。分组 header 渲染为不可选中的视觉分隔行，通过自定义的 `select2-actionable-single.js` 适配器实现。

## 预设关联世界书

Luker 支持将世界书（Lorebook）与预设关联。切换预设时，系统自动激活对应的世界书，无需手动切换。撤销预设切换时，全局世界书的激活状态也会同步恢复。

## 撤销 Toast 系统

Luker 为多种破坏性操作添加了撤销 Toast 提示，允许用户在误操作后快速恢复：

- 聊天删除撤销
- 角色卡删除撤销
- 预设删除撤销
- 世界书条目删除撤销
- 提示词删除/切换撤销
- 提示管理器顺序切换撤销

## 动态模型列表

Luker 支持动态加载多种 API 的模型列表，替代硬编码的静态列表。目前支持动态加载的 API 包括 OpenAI、Claude、Vertex AI 等，也适用于各类 OpenAI 兼容的第三方服务。同时支持为每个 API 源自定义模型列表，方便使用第三方兼容 API 时配置可用模型。

## 扩展钩子排序

Luker 新增了 Hook Order 扩展，允许用户自定义扩展的钩子执行顺序。当多个扩展监听同一事件时，可以通过优先级设置控制执行顺序，支持第三方扩展 ID 和消息事件。

## 角色状态 API

Luker 为扩展提供了角色级别的持久化状态存储能力：

- `getCharacterState(avatar, namespace)` — 获取指定角色在指定命名空间下的状态数据
- `setCharacterState(avatar, namespace, data)` — 设置角色状态数据
- `registerExtensionApi(name, api)` — 注册命名 API，供其他扩展查找和调用

这些 API 通过全局上下文对象暴露，支持扩展间的松耦合通信。预设同样支持状态存储，带生命周期钩子。

## 启动性能优化

Luker 对启动流程进行了多项性能优化，包括并行化资源加载、预加载最近聊天快照、懒加载聊天索引等。

详见 [启动性能优化](/zh-CN/improvements/performance)。

## 移动端适配

Luker 针对移动端和 Android WebView 进行了大量适配修复，涵盖虚拟键盘、IME 输入、触摸事件、小屏布局等方面。

详见 [Android App](/zh-CN/guide/android)。

## 前端日志管理器

Luker 新增了前端日志管理器，用于前端调试和问题排查：

- 拦截 `console.trace/debug/log/info/warn/error` 六个级别，写入内存缓冲区（最多 3000 条）
- 拦截 `fetch` 请求，记录 API 调用的请求/响应摘要（method、path、status、duration 等）
- 捕获 `window.error` 和 `unhandledrejection` 全局错误
- 对请求 body 进行智能摘要，提取关键信息而非记录完整内容
- 安全处理 Header，仅记录非敏感字段

通过 `getFrontendLogsSnapshot()` 获取日志快照，支持按时间范围和 ID 过滤。

> [!TIP]
> 后端日志系统的详细说明请参阅[认证与配额](/zh-CN/improvements/auth-and-quota)页面的日志系统章节。
