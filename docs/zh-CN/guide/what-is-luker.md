# Luker 是什么

Luker 是基于 [SillyTavern](https://github.com/SillyTavern/SillyTavern) 深度重构的角色扮演聊天平台。它保留与 SillyTavern 角色卡、数据格式和扩展的兼容性，并在此基础上加入记忆图、多 Agent 编排、CardApp 等子系统。本页说明 Luker 适合谁，以及这些子系统各自解决什么问题。

Luker 完全兼容 SillyTavern 的数据——角色卡、世界书、预设均可直接使用，迁移成本为零。如果你不想继续使用 Luker，也可以随时降级回 SillyTavern，数据不会被破坏。

## 为什么选择 Luker

SillyTavern 是一款角色扮演前端，拥有活跃的社区与角色卡生态。Luker 在此基础上做了系统性改进：

### 更高效的数据传输

SillyTavern 的大部分保存操作采用全量传输——编辑消息、切换设置、修改世界书时，均会将完整数据发送到后端。云端部署下，流量消耗显著。

Luker 引入了增量同步机制，只发送发生变化的部分。保存操作还支持延迟触发和冲突检测，避免并发写入互相覆盖。

### 更强的扩展能力

Luker 为插件开发者提供了更完整的基础设施：角色与预设状态 API、托管正则提供者、统一的扩展注入设置、函数调用运行时。插件可以复用已有的 API 预设与聊天补全预设。

### 内置专业工具链

Luker 内置了多个面向角色扮演场景的专业工具——记忆图、多 Agent 编排、角色卡编辑助手、搜索插件等，开箱即用，无需额外安装第三方扩展。

## 核心特性概览

### 记忆图（Memory Graph）

基于知识图谱的角色记忆系统。角色扮演中的事件、人物、地点、主线等信息会被提取成带类型的节点并互相连边。回复写出之前，召回环节会选出与当前场景最相关的节点，并将其注入创作上下文——主角返回先前到访的地点时，长期没有登场的早期角色会被回忆起来。召回方式有两种：**LLM 召回** 为默认方式，由模型从记忆库中选出相关节点，支持多轮探索；**RAG 召回** 使用向量检索与重排。提取在回复后独立运行，可以使用内置流程，也可以交给编排器的子 agent。

→ [记忆图详细文档](/zh-CN/features/memory-graph)

### 多 Agent 编排

在创作 LLM 生成回复之前，agent 团队会先探索上下文信息、完成场景规划：压缩最近上下文、草拟这一回合应完成的内容、审校方案，最后将规划结果打包成简短说明交给写作模型。执行模式包括五种：**Spec** 使用固定的阶段流程，为默认模式；**单 Agent** 只运行一个节点；**Agenda** 由规划器通过工具调用派遣 agent；**Loop** 让单个 agent 循环迭代；**Director** 由主 agent 与子 agent 团队探索上下文并创作正文。无论采用哪种模式，Agent 的操作都会记录在运行面板中，可以展开查看。编排配置可绑定到角色卡并随角色卡导入导出。

→ [多 Agent 编排详细文档](/zh-CN/features/orchestrator/)

### 技能（Skills）

可复用的知识包，供 agent 按需读取，用来代替一份巨型系统提示词。技能支持 Anthropic Claude Skills 格式。默认的 Director 配置自带内置技能，技能也可以随角色卡或预设一起分发——分发角色卡的同时，也会一并分发让这张卡正常运行的写作规则。

→ [技能文档](/zh-CN/features/skills/)

### 角色卡编辑助手（CEA / CardApp Studio）

集成代码编辑器的 AI 辅助角色卡编辑工具。它通过自然语言对话编辑角色卡、世界书和 CardApp 代码，以结构化工具调用提交真实改动，改动经过差异对比审批——没被批准的改动不会生效。替换或更新角色卡时，它会发现世界书变更，并提供导入新书、保留旧书、或借 AI 之力合并的选项。普通角色卡用弹窗版编辑助手，含 CardApp 的角色卡进入功能更完整的 Studio。

→ [角色卡编辑助手概览](/zh-CN/features/card-editor/)　·　[普通弹窗](/zh-CN/features/card-editor/popup)　·　[CardApp Studio](/zh-CN/features/card-editor/studio)

### 补全预设助手（Preset Assistant）

面向聊天补全预设的 AI 助手。它读取当前预设的真实取值，解释每个参数的作用，可以修改采样参数与提示词条目，也可以和参考预设对比，改动以差异形式供你审批。下游消费者是编排器的预设，也使用同一套流程。

→ [补全预设助手详细文档](/zh-CN/features/preset-assistant)

### 搜索插件（Search Tools）

为 AI 提供联网搜索能力，使用搜索插件中配置的搜索服务。既可以作为创作 LLM 的可调用工具，也可以作为预请求 Agent 在生成前自动搜索并将结果写入世界书。

→ [搜索插件详细文档](/zh-CN/features/search-tools)

### TTS NPC 对白归属

开启 TTS 之后，回复里的引号台词均可以用说话者自己的声音念出来。后台会有一个 AI 环节判断台词归属——它发现的 NPC 会自动出现在语音映射里；你事先手动添加的名字，从首次播放起就能被识别。

→ [TTS NPC 对白归属详细文档](/zh-CN/features/tts-npc-attribution)

### 聊天合并与拆分

任意位置拆开一条聊天，或者把两条聊天合并成一条；两边的分支历史均保持一致。

→ [聊天合并与拆分详细文档](/zh-CN/features/chat-merge-split)

### 同步

通过配对的局域网设备或加密的 S3 存储同步所选聊天、角色卡、世界书与设置。在统一的同步面板中管理自动同步、待处理版本选择、聊天分支与恢复。

→ [同步概览](/zh-CN/improvements/sync) · [局域网配对](/zh-CN/improvements/lan-sync) · [S3 配置](/zh-CN/improvements/s3-sync)

### 独立 App

以桌面端或移动端 App 运行完整的服务端和界面，支持 macOS、Windows、Linux、Android、HarmonyOS。后端完全在 App 内运行——不需要 Termux、不需要手动安装 Node、不需要端口转发。

→ [桌面端 App 指南](/zh-CN/guide/desktop)　·　[Android App 指南](/zh-CN/guide/android)　·　[HarmonyOS App 指南](/zh-CN/guide/harmonyos)

### 换模型不必重配提示词

SillyTavern 中 API 预设和聊天补全预设是联动切换的，换一个模型可能悄悄覆盖掉你的 API 地址、密钥或提示词配置。Luker 把连接字段和生成参数分开，你可以自由搭配不同的 LLM 后端和提示词预设。

→ [预设解耦](/zh-CN/improvements/preset-decoupling)

### 关闭标签页，回复仍会继续生成

生成在后端运行，并流式推送到界面；数据变更到达服务器即在后端落盘。刷新标签页、合上笔记本盖、回复写到一半断网：生成会继续在服务端运行，你回来时自动重连。

→ [后端实时存储](/zh-CN/improvements/backend-storage)

### 函数调用运行时（Function Call Runtime）

统一的函数调用 / 工具调用运行时，支持以下模式：

- **原生工具调用**：兼容 OpenAI、Claude、Gemini 等 API 的原生 tool call 格式
- **纯文本函数调用**：通过文本协议实现工具调用，适用于不支持原生工具调用的模型

→ [函数调用运行时](/zh-CN/improvements/function-call-runtime)

### CardApp

角色卡内嵌应用运行时。允许角色卡携带自定义应用逻辑，提供上下文 API 和生命周期管理。

→ [CardApp](/zh-CN/features/cardapp)

### 角色卡绑定预设与人设

角色卡可以绑定专属的聊天补全预设和用户人设（Persona）。绑定的预设和人设独立于全局列表，不会污染用户的全局配置，关闭角色卡聊天后自动消失，并可随角色卡导入导出。角色卡开发者不必再要求用户手动导入专属预设。

→ [角色卡绑定预设与人设](/zh-CN/improvements/card-bound-presets)

### 请求检查器（Request Inspector）

每用户的生成请求诊断工具，可追踪所有后端（包括图像生成和向量嵌入 / 重排调用）的请求详情，方便调试和排查问题。

→ [请求检查器](/zh-CN/improvements/request-inspector)

### 认证与配额

支持 GitHub / Discord OAuth 登录，管理员可为每位用户配置空间大小配额。Discord 登录可额外要求用户必须在指定服务器中或拥有特定身份组。

→ [认证与配额](/zh-CN/improvements/auth-and-quota)

::: tip 更多特性

- **备份、存储与迁移**——按数据类别[备份与恢复](/zh-CN/features/user-settings-additions)，查看[服务端](/zh-CN/features/storage-inspector)和浏览器端的存储占用，还能通过局域网把整套环境迁移到新设备。
- **给角色卡作者的结构化数据**——[逐楼层变量](/zh-CN/features/variable-op-log)和[状态系统](/zh-CN/features/state-system)。
- **排查问题**——[日志系统](/zh-CN/features/logging)可切换前端与后端来源，另有一键导出调试包。
- **日常体验**——[沉浸模式、移动端后台保活、回复完成通知、消息媒体懒加载](/zh-CN/features/user-settings-additions)、撤销 Toast、角色卡携带的人设、预设与提示词的分组折叠、从提供商实时获取的模型列表、世界书激活链路追踪、预设关联世界书、插件注册正则。
:::

## 兼容性

Luker 与 SillyTavern 保持数据格式层面的完全兼容：

| 数据类型 | 兼容性 |
|---------|--------|
| 角色卡（PNG/JSON） | ✅ 完全兼容，可双向导入导出 |
| 世界书 / Lorebook | ✅ 完全兼容 |
| 聊天记录 | ✅ 完全兼容 |
| 聊天补全预设 | ✅ 完全兼容 |
| 第三方扩展 | ✅ 兼容，支持 isomorphic-git 回退 |
| 用户设置 | ✅ 完全兼容 |

::: info 双向迁移
你可以随时从 SillyTavern 迁移到 Luker，也可以从 Luker 降级回 SillyTavern。Luker 新增的功能数据（如记忆图、编排配置等）存储在独立的状态文件中，不会影响 SillyTavern 的核心数据结构。但仍建议在迁移前做好备份。
:::

## 下一步

准备好开始使用了吗？

→ [快速开始](/zh-CN/guide/getting-started) —— 安装和部署 Luker
