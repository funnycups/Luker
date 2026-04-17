# 改进总览

Luker 对 SillyTavern 的改进不是简单的功能堆叠，而是从数据传输架构、预设系统、扩展能力等多个维度进行的系统性重构。这些改进相互配合，共同构成了一个更高效、更灵活的角色扮演平台。

## 改进一览

| 分类 | 改进项 | 简要描述 |
| --- | --- | --- |
| 架构 | [预设解耦](/zh-CN/improvements/preset-decoupling) | 将连接参数与预设分离为独立实体 |
| 架构 | [增量同步](/zh-CN/improvements/incremental-sync) | 基于增量 patch 的数据传输，替代全量覆盖 |
| 架构 | [后端实时存储](/zh-CN/improvements/backend-storage) | 数据变更实时持久化，完整性校验防止并发冲突 |
| 功能 | [函数调用运行时](/zh-CN/improvements/function-call-runtime) | 原生与纯文本两种模式的统一函数调用支持 |
| 功能 | [角色卡绑定预设与人设](/zh-CN/improvements/card-bound-presets) | 角色卡可携带推荐预设和默认人设 |
| 功能 | [请求检查器](/zh-CN/improvements/request-inspector) | 追踪生成请求的完整生命周期与 Token 用量 |
| 功能 | [预设关联世界书](/zh-CN/improvements/preset-world-info) | 切换预设时自动激活对应的世界书 |
| 基础设施 | [统一生成层](/zh-CN/improvements/generation-layer) | 多后端生成请求统一封装与 Token 计量 |
| 基础设施 | [性能优化](/zh-CN/improvements/performance) | 并行加载、懒加载、延迟初始化等启动和运行时优化 |
| 基础设施 | [WebSocket 代理](/zh-CN/improvements/ws-proxy) | 持久 WS 隧道传输，心跳保活与流偏移恢复 |
| 基础设施 | [认证与配额](/zh-CN/improvements/auth-and-quota) | OAuth 登录、多用户认证与存储配额管理 |
| 基础设施 | [其他改进](/zh-CN/improvements/other) | 连接管理器增强、提示词/预设分组、动态模型列表等 |

独有功能模块（记忆图、编排器、角色编辑助手、搜索工具、CardApp 等）请参阅 [独有功能](/zh-CN/features/memory-graph) 分类。

## 架构改进

### 预设解耦

SillyTavern 中，API 连接参数（如模型名称、API 地址、代理设置）与预设（如温度、Top-P、提示词配置）耦合在同一个配置对象中。这意味着切换 API 提供商时，用户不得不重新配置生成参数；反过来，调整采样策略也可能意外影响连接设置。

Luker 将两者拆分为独立实体：**连接配置**负责「连到哪里」，**预设**负责「怎么生成」。在代码层面，每个设置字段都通过 `isConnection` 标记进行分类，加载预设时自动跳过连接字段。两者可以自由组合——同一套预设可以搭配不同的 API 连接使用，反之亦然。

这一解耦也为角色卡绑定预设、连接管理器等下游功能奠定了基础。详见 [预设解耦](/zh-CN/improvements/preset-decoupling)。

### 增量同步

传统的前后端数据同步采用全量覆盖：每次修改都将完整对象发送到服务端。当对象体积增长（如包含大量消息的聊天记录），这种方式会产生显著的带宽浪费和写入冲突风险。

Luker 新增了三个增量端点：

- **`append`**：将新消息追加到 `.jsonl` 文件末尾，而非重写整个文件
- **`patch`**：按消息索引修补指定行，只更新变更的消息
- **`patch-metadata`**：使用深度合并更新聊天元数据，而非替换

每次写入后，后端计算文件的 integrity hash 并返回给前端；后续请求携带该值进行校验，不匹配时返回 409 Conflict，从根本上防止并发写入冲突。设置数据同样支持增量 patch 保存，带冲突检测和序列化写入。详见 [增量同步](/zh-CN/improvements/incremental-sync)。

### 后端实时存储

SillyTavern 的部分数据依赖前端触发保存，存在「用户已操作但数据未落盘」的时间窗口。一旦进程异常退出，这些变更就会丢失。

Luker 将存储逻辑下沉到后端：数据变更在到达服务端的同时即刻持久化到磁盘。前端不再承担「何时保存」的职责，从根本上消除了数据丢失的窗口期。

此外，Luker 引入了以下机制保障数据安全：

- **聊天状态文件**：`.luker-state.<chat_id>.json` 文件为每个聊天维护额外状态，生命周期与聊天文件绑定
- **Generation Acknowledge**：AI 生成完成后通过专用端点确认，确保生成结果被正确记录
- **序列化聊天写入**：防止并发写入导致数据损坏，特别针对群聊场景
- **可配置备份策略**：支持聊天文件的自动备份

详见 [后端实时存储](/zh-CN/improvements/backend-storage)。

## 功能增强

### 函数调用运行时

Luker 内置了统一的函数调用（Function Calling）运行时，支持两种工作模式：

- **原生模式**：利用 API 提供商的原生工具调用能力（兼容 OpenAI、Claude、Gemini 等格式），由模型直接输出结构化调用指令，支持流式工具调用规范化
- **纯文本模式**：通过提示词引导模型在普通文本中输出调用意图，再由运行时解析执行，支持多工具调用和可配置的错误重试

两种模式覆盖了从高端商业 API 到本地小模型的全部场景。连接管理器中可按配置独立设置纯文本函数调用的开关和重试策略。详见 [函数调用运行时](/zh-CN/improvements/function-call-runtime)。

### 角色卡绑定预设与人设

角色卡的创作者往往最清楚角色在什么参数下表现最佳。Luker 允许角色卡携带**推荐预设**（已自动剥离连接字段）和**默认人设**。用户加载角色卡时，系统自动应用创作者推荐的配置并记录之前的预设；离开角色时自动恢复。预设选择器中，绑定预设以特殊徽章标识，与普通预设视觉区分。

聊天人设锁定（Chat Persona Lock）功能则将用户人设与特定聊天绑定，切换聊天时自动恢复对应的角色设定。这些功能建立在预设解耦的基础之上——正因为预设是独立实体，才能被角色卡引用和分发。详见 [角色卡绑定预设与人设](/zh-CN/improvements/card-bound-presets)。

### 请求检查器

调试 AI 对话时，用户经常需要知道「到底发了什么给 API」。Luker 的请求检查器追踪每个 AI 生成请求从发起到完成的完整生命周期，记录 prompt token、completion token 和总用量。它支持流式响应的 Token 统计（从 SSE 事件中提取 usage 信息），也覆盖图像生成请求的追踪。请求检查器追踪的 Token 用量是独立的统计功能，与存储配额管理是两个独立的系统。详见 [请求检查器](/zh-CN/improvements/request-inspector)。

## 基础设施

### 统一生成层

SillyTavern 中，不同 AI 后端（OpenAI、Anthropic、Google、Kobold 等）的生成请求走各自独立的代码路径，导致功能支持不一致。Luker 新增了统一生成层，将多后端的生成请求统一封装，共享 Token 计量、流式处理和错误处理逻辑。

该模块为所有 AI 后端提供统一的处理管线，确保无论使用哪种 AI 服务，用户都能获得一致的功能体验（如请求检查、Token 统计、生成确认等）。详见 [统一生成层](/zh-CN/improvements/generation-layer)。

### 认证与配额

Luker 增加了 OAuth 登录支持（GitHub、Discord）和存储配额管理：

- **OAuth 登录**：通过前端管理员面板配置（存储在 `admin-settings.json` 的 `oauth` 配置段中），支持授权码换取 access token、自动创建或关联本地用户账户
- **存储配额**：管理员可为不同用户设置存储空间配额上限，系统在请求前自动检查额度
- **日志系统**：详见 [日志系统](/zh-CN/features/logging)

这使得 Luker 能够在多人共享部署的场景下安全运行。详见 [认证与配额](/zh-CN/improvements/auth-and-quota)。

### 其他改进

除上述核心改进外，Luker 还包含大量基础设施优化：

- **连接管理器改进**：对 SillyTavern 已有的 Connection Profiles 进行增强，与预设解耦深度集成，支持独立的纯文本函数调用开关
- **WebSocket 代理**：通过持久 WS 隧道传输生成请求，包含心跳保活和流偏移恢复
- **HTTP 请求代理**：支持 SOCKS5/HTTP 代理转发出站请求
- **预设分组 & 提示词分组**：预设选择器和提示词管理器支持可折叠的分组区段
- **预设关联世界书**：切换预设时自动激活对应的世界书
- **撤销 Toast 系统**：为破坏性操作提供撤销提示
- **动态模型列表**：Claude 和 Vertex 模型列表动态加载
- **扩展钩子排序**：允许用户自定义扩展的执行优先级
- **角色状态 API**：扩展可在角色和预设上存储持久化状态数据
- **启动性能优化**：并行化资源加载、预加载最近聊天快照、懒加载聊天索引
- **移动端适配**：大量 Android WebView 和触摸交互修复

详见 [其他改进](/zh-CN/improvements/other)。

## 与 SillyTavern 的关系

Luker 是 SillyTavern 的下游分支，而非独立项目。所有改进都以**不破坏上游兼容性**为前提进行设计：

- **定期同步**：Luker 持续跟踪 SillyTavern 上游的更新，定期合并上游变更
- **数据兼容**：Luker 的数据格式在 SillyTavern 的基础上进行扩展而非替换。新增的状态文件和配置项都有合理的默认值
- **功能叠加**：Luker 的改进是在上游功能之上的增量叠加，而非破坏性重写。从 SillyTavern 迁移到 Luker 时，用户的现有数据可以无缝使用
