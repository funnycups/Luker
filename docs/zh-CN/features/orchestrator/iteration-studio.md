# AI 迭代工作台

AI 迭代工作台是编排器的**主要定制方式**。99% 的人不需要手搓 stage / node 或者写 Planner prompt——工作台让你用一句话描述需求,AI 给你一份方案,你逐条审,稳定了点 Apply。Spec / Agenda / Loop 三种执行模式都共用这个工作台,只是产出物不同。

::: tip 先用它,搞不定再手搓
如果你正在打开编排器编辑器准备手动加节点,先停一下——你需要的事情大概率工作台几秒钟就能给你一份方案。手搓留给极致定制场景。
:::

## 打开工作台

切到你想要的执行模式(Spec / Agenda / Loop),从编排器面板下面的操作区点 **打开 AI 迭代工作台**。

![快速生成与迭代工作台按钮](/images/orchestrator/orch-quickbuild-button.png)

会弹出一个面板。左边是你和工作台 AI 的对话,右边是当前编排的状态。

![迭代工作台主视图](/images/orchestrator/orch-iteration-studio.png)

## 描述你想要什么

在输入框里写一句话,描述你希望编排做什么。越具体越好。

> 例:*「我希望 AI 在每次回复前先回顾近期重要事件、保持人设一致性,并且不要轻易破规出戏。」*

![输入框带示例](/images/orchestrator/orch-iter-input.png)

点 **发送给 AI**。

## 看 AI 干活

AI 回一段简短计划 + 一份方案,展示它打算改什么。具体形态取决于当前模式:

- **Spec / Agenda 模式** — AI 产出一份 diff:绿色加号(新增)/ 红色减号(删除)/ 黄色(修改)。你可以逐条 批准 / 拒绝,或者放手让它继续——工作台会自动一轮接一轮推进直到稳定,每轮都有 diff 可看。
- **Loop 模式** — AI 通过工具调用直接 patch profile(`system_prompt` / 工具开关 / `max_rounds` / 预设路由)。无需逐条审批,AI 自行决定何时收尾。

![待审批 diff](/images/orchestrator/orch-iter-diff-inline.png)

哪条改动看不懂?点旁边的放大镜,左右对比看清楚。

![Diff side-by-side 详情](/images/orchestrator/orch-iter-diff-side.png)

## 应用

AI 说没什么再改的了之后,点 **应用到全局**(到处都用)或 **应用到角色卡**(只对这张卡)。

## 工作台能干什么

- **多轮对话。** 一句反馈一轮,AI 提一个聚焦的改动方案,你审。
- **逐条审批(Spec / Agenda)。** 每条 diff 单独 批准 / 拒绝,可以只接受一半。
- **AI 驱动收尾(Loop)。** AI 自行决定何时停止迭代——`continueRequested` 标志位由 AI 通过工具调用控制,**没有手动 Auto-Continue 开关**。
- **模拟测试。** 用当前真实的聊天上下文跑一遍工作流——就像你刚发了条新消息一样,世界书也会照常被激活——但生成结果只展示给你看,*不影响*真实聊天。比如问「我加的 Constraint Agent 真的能挡住 OOC 吗?」,工作台跑一遍流程,把每个节点输出都摆给你看。
- **会话保存。** 每个作用域最多 24 个 session,不同卡 / 不同实验各自一份。
- **回滚。** 已经 Apply 的也能撤。
- **可折叠思考。** 推理模型的 `<thought>` 标签默认折叠;超过 1200 字符的消息也自动折叠。

## 一个真实的迭代节奏(以 Spec 为例)

> **第 1 轮。** 你:*「AI 不要轻易出戏。」*
> AI:「在 Stage 2 加一个 Constraint Agent,加反破规检查;启用 Anti-Data Guard。」 Diff:1 个新节点 + 1 个开关。你 批准。
>
> **第 2 轮。** 你:*「让它读知识书,这样它知道世界规则。」*
> AI:「在 Stage 1 加了一个 `lorebook_reader` 节点,这样 Constraint Agent 就能看到激活的世界规则。」 Diff:1 个新节点。批准。
>
> **第 3 轮。** 你:*「模拟一个明显出戏的输入,看 Constraint Agent 真能拦住吗?」*
> AI:切到 模拟模式,用一段假的破规用户消息跑一遍工作流,把 Constraint Agent 的判定结果展示给你。

![Simulation 输出](/images/orchestrator/orch-iter-simulation.png)

> **第 4 轮。** 稳定。点 **应用**。

每一步都是可见的、可中止的、可回退的。这是关键——你不是把控制权交给一个黑盒,而是让 AI 提建议、你做主。

## 三种模式的产出差异

| 模式 | 工作台产出 | 你看到什么 |
|---|---|---|
| **Spec** | Stage / Node 的 diff:加节点、删节点、改 prompt 模板、调执行标志、调 API/预设覆写 | 绿/红/黄 diff 列表,逐条审批 |
| **Agenda** | Planner Prompt 的 diff + Agent 池的 diff:加 Agent、改 Planner 调度逻辑 | 绿/红/黄 diff 列表,逐条审批 |
| **Loop** | 直接通过工具调用 patch loop profile:`system_prompt` / 工具开关 / `max_rounds` / 预设路由 | 看不到 diff,AI 改完后告诉你结果 |

## Loop 模式的迭代提示

不会写 system prompt?在 Loop 模式下打开工作台,用自然语言描述你想要的 agent 行为:

> 我希望这个 agent 先读最近 5 楼,再去世界书查相关设定,最后去记忆图找有没有冲突,然后写 capsule。不要它写笔记。

工作台 AI 读你当前的 profile,通过工具调用产出 patch。每次工具调用要么是 `luker_orch_continue_iteration`(继续追问 / 局部更新),要么是 `luker_orch_finalize_iteration`(这次需求已满足)——AI 自行决定何时收尾。

## 会话管理

不同卡、不同实验,各自一个 session。

![Session 列表](/images/orchestrator/orch-iter-sessions.png)

会话持久化,刷新后还在,可以是全局作用域也可以绑到某张卡。每个作用域最多保留 24 个 session。

## 边栏 — 快速生成(Spec / Agenda)

快速生成是迭代工作台的一键模式,适用于 Spec 与 Agenda。在编排编辑器顶部 **AI 生成目标** 文本框里输入需求,点 **AI 快速生成**:

![快速生成输入区](/images/orchestrator/orch-quickbuild-input.png)

一次 LLM 调用之后,你直接拿到完整工作流:

![快速生成结果](/images/orchestrator/orch-quickbuild-result.png)

适合两种场景:

1. 你已经用迭代工作台调过类似配置很多次,这次只想要个能跑的模板,不想再过流程
2. 你完全不在乎 AI 怎么决定的,只要默认能用就行

其他场景下,**用迭代工作台更划算**。多花的 1–2 分钟换来一个你能看懂、能调整的工作流。

::: info Loop 模式没有 Quick Build
Loop 模式只能通过迭代工作台逐步迭代——没有「一次生成完整 profile」的快捷入口,因为 loop 的 system prompt 通常需要根据具体场景调,一次成型反而容易跑偏。
:::

## 相关页面

- [编排器概览](/zh-CN/features/orchestrator/) — 通用配置 / 触发时机 / 角色卡绑定
- [Spec 模式](/zh-CN/features/orchestrator/spec) — 默认的 DAG 模式
- [单 Agent 模式](/zh-CN/features/orchestrator/single) — 退化的 Spec
- [Agenda 模式](/zh-CN/features/orchestrator/agenda) — Planner 动态调度
- [Loop 模式](/zh-CN/features/orchestrator/loop) — 单 Agent 工具循环
- [角色卡编辑器](/zh-CN/features/card-editor/) — 与迭代工作台共用 diff 引擎
