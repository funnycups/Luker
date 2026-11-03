# 多 Agent 编排

精心铺垫的场景仍可能被一条回复破坏：跳过刚建立的节奏、忘记此前确立的世界规则、出戏总结，或者仓促收尾本应留到后面的伏笔。一次生成要同时满足人物一致性、上下文、世界规则、情节推进与文笔，很难每项都到位。

编排器在主模型动笔之前，先运行一组 Agent 完成准备工作：提取近期聊天中的关键状态、确定当前生效的世界规则、规划这一回合的推进方向并审校。产物取决于执行模式：多数模式输出一份精简的编排结果，注入主模型的提示词；Director 模式由编排器内的主代理直接写出回复正文。

**编排器自带可用的默认 Spec 工作流，启用即可运行。** 需要其他形态时，各执行模式均有独立编辑器。

::: info 它什么时候触发？
编排器在普通回复、继续、重新生成、滑动切换和扮演时运行，在世界书解析之后、主模型回复之前。运行面板只保存在内存中，切换聊天时清空。
:::

## 快速开始（使用默认编排）

默认 Spec 已配置完成，启用后即可运行。

### Step 0 —— 你需要先有什么 {#step-0}

- 主对话已能通过聊天补全接口正常生成回复
- 当前对话至少有数轮聊天记录

### Step 1 —— 启用编排器 {#step-1}

打开顶栏的扩展抽屉，找到 **多 Agent 编排** 那一节。把 **启用** 开关打开。

![编排器启用开关](/images/orchestrator/orch-toggle.png)

### Step 2 —— 给各 Agent 选模型 {#step-2}

在同一面板中找到 **LLM 节点 API 预设** 与 **AI 生成 API 预设**，分别指定各 Agent 使用的 API 连接与聊天补全预设。预设下拉框旁的问号按钮说明该槽位需要什么类型的预设，并可以一键导入内置预设：非 Director 模式使用 `agent-non-director`，Director 使用 `agent-director`。

::: tip 成本
编排器的每个节点都会产生模型调用。主对话使用高价模型时，可以为编排器选择更小的模型；需要更高质量时，也可以为每个节点单独指定连接与预设。
:::

### Step 3 —— 直接发一条消息 {#step-3}

在主对话中发送一条消息，其他设置保持默认。主模型回复之前，默认 Spec 工作流会在后台执行。

### Step 4 —— 查看执行过程 {#step-4}

运行开始时，**运行面板**会从聊天区右侧滑入，窄屏上则从底部升起。面板实时更新：轮次以可折叠卡片展示，展开后可查看模型的思考过程、调用的工具和工具返回内容。

![编排器开始运行时的面板](/images/run-panel/01-panel-initial.png)

模型流式输出时，面板在原地实时更新：

![流式过程：思考、文本与工具分节实时填充](/images/run-panel/02-panel-streaming.png)

展开任意工具调用，能看到它的入参和返回：

![工具调用展开——参数与结果](/images/run-panel/03-panel-tool-expanded.png)

窄屏下面板变成底部抽屉，可以上拉展开或下滑关闭：

![窄屏下的运行面板（抽屉布局）](/images/run-panel/05-panel-drawer.png)

面板仅保存在内存中。切换聊天或刷新页面会清空；聊天记录里只保留最终回复。还可以执行以下操作：

- 运行中**停止**
- **复制**任意分节的原始内容
- 把整次运行**导出**为 JSON，便于分享或反馈问题
- 一键**全部收起**所有卡片

回复不理想时，可在面板中查看每一步的输出。

至此编排器已启用，接下来选择执行模式：

- 需要固定、可重复的流程 → [Spec 模式](/zh-CN/features/orchestrator/spec)
- 只需要一次调用注入一段引导 → [单 Agent 模式](/zh-CN/features/orchestrator/single)
- 运行哪些 Agent 需要根据中间结果决定 → [Agenda 模式](/zh-CN/features/orchestrator/agenda)
- 希望单个 Agent 反复调用工具，自行判断何时结束 → [Loop 模式](/zh-CN/features/orchestrator/loop)
- 希望由编排器内的团队直接写出正文 → [Director 模式](/zh-CN/features/orchestrator/director)

::: tip 定制入口
各模式的定制均从 **[AI 迭代工作台](/zh-CN/features/orchestrator/iteration-studio)** 开始：用一句话描述目标，AI 返回方案，逐条审批。五种模式共用同一个工作台。
:::

## 选你的执行模式

| 模式 | 是什么 | 何时用 | 技能范围 | 详细文档 |
|---|---|---|---|---|
| **Spec**（默认） | 固定的阶段与节点流程 | 默认模式。需要可预期的流程 | 每个节点可单独选择可见技能 | [Spec 模式](/zh-CN/features/orchestrator/spec) |
| **单 Agent** | 只有一个节点的 Spec | 成本低、速度快。不需要多 Agent 协作 | 在该节点上选择技能 | [单 Agent 模式](/zh-CN/features/orchestrator/single) |
| **Agenda** | 规划 Agent 根据情况动态派遣其他 Agent | 流程无法预先固定 | 规划 Agent 与每个被派遣的 Agent 分别选择 | [Agenda 模式](/zh-CN/features/orchestrator/agenda) |
| **Loop** | 单 Agent 在会话中反复调用工具，自行判断何时结束 | 探索性研究、动态决策 | 在 Loop Agent 上选择 | [Loop 模式](/zh-CN/features/orchestrator/loop) |
| **Director** | 主代理带子代理团队探索上下文并创作正文 | 高质量长篇角色扮演 | 主代理与子代理分别选择；出厂自带默认技能 | [Director 模式](/zh-CN/features/orchestrator/director) |

切换模式：扩展抽屉里的 **执行模式** 下拉。Spec 与 Agenda 可以在编辑器中互相转换；Loop 结构差异较大，没有对应的互转入口。

::: info 技能范围
所有模式都可以限制每个 Agent 能看到哪些技能。Director 在出厂配置中已经绑定默认技能，其他模式的 Agent 默认可以看到全部已安装技能。技能的作用方式见 [编排器集成](/zh-CN/features/skills/orchestrator-integration)。
:::

## 通用配置

无论选哪种模式，以下设定均共享。

### 结果注入

编排器的最终输出会注入主模型的提示词。配置：

| 设置 | 默认 | 说明 |
|---|---|---|
| 注入位置 | `atDepth` | 编排结果在提示词中的位置 |
| 注入深度 | `0` | 在该位置的深度 |
| 注入角色 | `SYSTEM` | `SYSTEM` / `USER` / `ASSISTANT` 之一 |
| 自定义指令前缀 | 默认值为一句话 | 添加在编排结果之前 |

编排结果绑定到触发编排的用户消息楼层。同一楼层切换 swipe 时复用现有结果；配置变更后重新应用最新结果。

### 角色卡绑定

编排配置可以绑到角色卡。绑定后：

- 配置随卡导出，导入者自动获得推荐工作流
- 卡作者可以为自己的角色定制工作流
- 切换到这张卡自动应用其工作流
- 卡可以指定自己的执行模式（Spec / Agenda / Loop / Director 均支持）
- 在卡的下拉中选择预设后，当前聊天立即切换；卡上的预设库保持不变
- 「清除这张卡上的预设」恢复到全局配置
- 可以在卡绑定配置之上叠加个人调整

### 导入导出

Spec 与 Agenda 配置可以导出为 JSON，再导入到全局或某张角色卡。导入文件的模式必须与当前执行模式一致。Loop 配置通过 [AI 迭代工作台](/zh-CN/features/orchestrator/iteration-studio) 复用，不提供独立的文件导入导出。

### 通用配置参考

最常用的几项：执行模式、编排结果的注入位置与深度、注入角色、自定义指令前缀、速率限制、工具调用重试、默认 API 连接与聊天补全预设、节点是否能看到世界书，以及运行面板的消息折叠阈值。

模式专属的参数在各自的子页面里说明。

## 相关页面

- [AI 迭代工作台](/zh-CN/features/orchestrator/iteration-studio) —— 编排器核心定制工具，所有模式共用
- [Spec 模式](/zh-CN/features/orchestrator/spec) —— 固定流程工作流
- [单 Agent 模式](/zh-CN/features/orchestrator/single) —— 只执行一个节点的精简流程
- [Agenda 模式](/zh-CN/features/orchestrator/agenda) —— 规划 Agent 动态派遣
- [Loop 模式](/zh-CN/features/orchestrator/loop) —— 单 Agent 工具循环
- [Director 模式](/zh-CN/features/orchestrator/director) —— 多 Agent 接管，出厂自带技能
- [技能概览](/zh-CN/features/skills/) —— 所有模式共用的知识包
- [笔记](/zh-CN/features/orchestrator/notes) —— 当前聊天的剧情线索追踪
- [角色卡编辑助手](/zh-CN/features/card-editor/) —— 与迭代工作台共用差异审批
- [卡内绑定预设与人设](/zh-CN/improvements/card-bound-presets) —— 编排配置如何随角色卡分发
