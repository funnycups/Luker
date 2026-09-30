# AI 迭代工作台

AI 迭代工作台是编排器的**主要定制方式**。99% 的情况下都不需要手动编辑 stage / node 或手写 Planner prompt——用一句话描述目标，AI 返回一份方案，逐条审批即可。Spec / Agenda / Loop / Director 四种执行模式共用同一个工作台，只是产出物不同。

::: tip 优先使用工作台，仅在工作台无法达成时手动编辑
如果你正准备打开编排器编辑器手动添加节点，请先考虑工作台——多数情况下它几秒钟内就能给出一份可用方案。手动编辑只留给工作台无法覆盖的极端场景。
:::

## 打开工作台

切到想要的执行模式（Spec / Agenda / Loop），在编排器面板的操作区点击 **打开 AI 迭代工作台**。

![快速生成与迭代工作台按钮](/images/orchestrator/orch-quickbuild-button.png)

会弹出一个面板。左边是你和工作台 AI 的对话，右边是当前编排的状态。

![迭代工作台主视图](/images/orchestrator/orch-iteration-studio.png)

## 描述你想要什么

在输入框中写一句话，描述希望编排做什么。描述越具体越好。

> 例：*「我希望 AI 在每次回复前先回顾近期重要事件、保持人设一致性，并且不要轻易破规出戏。」*

![输入框带示例](/images/orchestrator/orch-iter-input.png)

点击 **发送给 AI**。

## 看 AI 干活

AI 返回一段简短计划与一份方案，展示它打算改什么。具体形态取决于当前模式：

- **Spec / Agenda 模式** — AI 产出一份 diff：绿色加号（新增）/ 红色减号（删除）/ 黄色（修改）。可以逐条批准 / 拒绝，或者直接等待——工作台会自动迭代直到方案稳定，每轮都会展示其 diff。
- **Loop 模式** — AI 通过工具调用直接 patch profile（`system_prompt` / 工具开关 / `max_rounds` / 预设路由）。无需逐条审批，AI 自行决定何时结束。
- **Director 模式** — 通过工具调用直接 patch 主 agent 与子 agent 名册：prompt、工具集、预设路由、技能。名册视图标出被改动的行，没有逐条 diff 审批。

![待审批 diff](/images/orchestrator/orch-iter-diff-inline.png)

若某条改动不易理解，点击旁边的放大镜图标即可左右对比查看。

![Diff side-by-side 详情](/images/orchestrator/orch-iter-diff-side.png)

## 应用

在 AI 表示没有更多建议之后，点击 **应用到全局**（到处都用）或 **应用到角色卡**（只对这张卡）。

## 工作台能干什么

- **多轮对话。** 每一轮提交一句反馈，AI 提出一个聚焦的改动方案，由你审阅。
- **逐条审批（Spec / Agenda）。** 每条 diff 单独批准 / 拒绝，可以只接受方案的一部分。
- **程序驱动自动续轮。** 只要 AI 在当前回合发出任意工具调用，工作台就会开始下一轮；AI 只返回纯文本、不调用工具时立即停止。**没有手动 Auto-Continue 开关，也没有 AI 侧的 continue / finalize 工具——循环只根据 AI 的实际输出做出反应。**
- **模拟测试。** 用当前真实的聊天上下文执行一次工作流——就像刚发送了一条新消息一样，世界书也会照常被激活——但生成结果只显示在工作台中，*不影响*真实聊天。例如询问「我加的 Constraint Agent 真的能挡住 OOC 吗？」，工作台会执行流程并展示每个节点的输出。
- **会话保存。** 每个作用域最多保存 24 个会话，不同卡 / 不同实验各自独立。
- **回滚。** 即使已经应用，也可以撤销。
- **可折叠思考。** 推理模型的 `<thought>` 标签默认折叠；超过 1200 字符的消息也自动折叠。

## 一个真实的迭代节奏（以 Spec 为例）

> **第 1 轮。** 你：*「AI 不要轻易出戏。」*
> AI：「在 Stage 2 加一个 Constraint Agent，加反破规检查；启用 Anti-Data Guard。」 Diff：1 个新节点、1 个设置变更。你批准。 <!-- banned-words-allow -->
>
> **第 2 轮。** 你：*「让它读世界书，这样它知道世界规则。」*
> AI：「在 Stage 1 加了一个 `lorebook_reader` 节点，这样 Constraint Agent 就能看到激活的世界规则。」 Diff:1 个新节点。批准。
>
> **第 3 轮。** 你：*「模拟一个明显出戏的输入，看 Constraint Agent 真能拦住吗？」*
> AI：切到 模拟模式，用一段假的破规用户消息执行一次工作流，把 Constraint Agent 的判定结果展示给你。

![Simulation 输出](/images/orchestrator/orch-iter-simulation.png)

> **第 4 轮。** 稳定。点 **应用**。

每一步都是可见、可中止、可回退的，这正是设计目标——控制权不会交给黑盒，而是由 AI 提出建议、由你做决定。

## 各模式的产出差异

| 模式 | 工作台产出 | 你看到什么 |
|---|---|---|
| **Spec** | Stage / Node 的 diff：加节点、删节点、改 prompt 模板、调执行标志、调 API/预设覆写 | 绿/红/黄 diff 列表，逐条审批 |
| **Agenda** | Planner Prompt 的 diff + Agent 池的 diff：加 Agent、改 Planner 调度逻辑 | 绿/红/黄 diff 列表，逐条审批 |
| **Loop** | 直接通过工具调用 patch loop profile:`system_prompt` / 工具开关 / `max_rounds` / 预设路由 | 看不到 diff，AI 改完后告诉你结果 |
| **Director** | 直接通过工具调用 patch 主 agent + 子 agent 名册：prompt、工具集、预设路由、技能 | 名册视图标出改动行，没有逐条 diff 面 |

## Loop 模式的迭代提示

不想手动编写 system prompt？在 Loop 模式下打开工作台，用自然语言描述期望的 agent 行为：

> 我希望这个 agent 先读最近 5 楼，再去世界书查相关设定，最后去记忆图找有没有冲突，然后写 capsule。不要它写笔记。

工作台 AI 读取当前的 profile，通过工具调用产出 patch。只要 AI 在本轮发出任何工具调用，工作台就会自动续到下一轮；一旦 AI 返回纯文本、不再调用工具即停止——只要 AI 持续做出修改，迭代就持续进行。

## 角色卡世界书冲突调和

在以角色卡为作用域打开工作台时，AI 还会同时对照这张卡绑定的世界书。格式相关的世界书条目分为两类，处理方式不同：

- **过程强制类**——条目在指挥*模型运行过程中怎么思考*（强制思考模板、每轮必须打 CoT 前缀、"回答前先做 5W1H 检查"、"按 1 至 N 步依次执行后再回答"等）。这类条目会干扰编排：它们会在每一轮工具调用中触发，挤占 agent 进行规划和工具调用的通道。工作台会去除格式约束，提取作者真正想要的意图（关心的话题、角度、人设习惯、场景锚点），并将其改写为叙事 / 人设 / 场景素材，让 agent 作为叙事输入读取，而不是作为新的输出规则。
- **最终输出形态类**——条目在描述*最终给用户看到的那一条回复长什么样*（"输出必须用 markdown"、"用标签包裹回复"、"末尾附上一段总结"、"说话用诗的格式"等）。这类是合理的风格偏好，工作台会保留——只是改写措辞，使最终提交的语义明确，避免编排过程中的规划节点、工具调用节点、复审节点也被这条形式约束限制。

工作台首选只改写冲突那一句、保留条目的其它信息载荷；只有当整条几乎就是纯格式约束、没有可保留的内容时才直接禁用整条。任何情况都不会删除条目。

**审批流程。** 世界书调整都是*提案*，不会立即写入磁盘。每条提案以一张 diff 卡片的形式出现在产生它的助手消息下方，带**批准** / **拒绝**按钮——和编排变更的逐条审查体验一致。只有获得批准的提案会在点击 **Apply** 时写入本地世界书；被拒绝的提案直接丢弃；未做决定的留在面板中，可稍后处理。输入框上方有一行汇总，显示待审批 / 已批准 / 已拒绝的计数；当存在已批准的提案、且没有编排变更同时待处理时，这一行还会出现一个"提交已批准的世界书改动"按钮用于单独提交。

全局编排会话不会修改任何世界书——这套调和流程仅在角色卡范围内生效。

## 用工作台编写 skill

不想手动编写 SKILL.md？打开工作台并描述需求。它会起草、安装 SKILL.md，并（如有要求）挂载到对应位置——与其他改动相同的逐条审批流程。

一句话就够，自然语言：

> 帮我写一条 skill，让导演避开翻译腔。别让角色对话出现「当 X 的时候」这种句式，不要用「——」破折号分隔短句，「是吗？」改成「是吧？」这种更本地化的语气词。让导演模式下所有 agent 都看到。

审批之后，skill 会立即写入磁盘并可用。如果同时要求了挂载（"让所有 agent 看到"、"给 voice_critic 看"），它会一并挂好；否则之后也可以自己在 [Skill 列表](/zh-CN/features/orchestrator/skills) 里添加。

![工作台跑完安装](/_screenshots/skills/iter-studio-05-after-llm-round.png)

详见 [《用 skills 调教 RP 输出》](/zh-CN/recipes/rp-skills-walkthrough)。

## 会话管理

不同卡、不同实验各自拥有独立的会话。

![Session 列表](/images/orchestrator/orch-iter-sessions.png)

会话会持久化，刷新后仍然存在，可以是全局作用域也可以绑定到某张卡。每个作用域最多保留 24 个会话。

## 边栏 — 快速生成（Spec / Agenda）

快速生成是迭代工作台的一键模式，适用于 Spec 与 Agenda。在编排编辑器顶部 **AI 生成目标** 文本框里输入需求，点 **AI 快速生成**:

![快速生成输入区](/images/orchestrator/orch-quickbuild-input.png)

一次 LLM 调用之后即可获得完整工作流：

![快速生成结果](/images/orchestrator/orch-quickbuild-result.png)

适合以下两种场景：

1. 已经用迭代工作台调整过多次类似配置，这次只需要一个可用的模板，不想再走完整流程
2. 只需要默认配置可用，不关心 AI 的决策过程

多数情况下，**迭代工作台是更好的选择**：多花的 1–2 分钟能换来一个可理解、可调整的工作流。

::: info Loop 模式没有 Quick Build
Loop 模式只能通过迭代工作台逐步迭代——没有「一次生成完整 profile」的快捷入口，因为 loop 的 system prompt 通常需要根据具体场景调整，一次成型反而容易偏离目标。
:::

## 相关页面

- [编排器概览](/zh-CN/features/orchestrator/) — 通用配置 / 触发时机 / 角色卡绑定
- [Spec 模式](/zh-CN/features/orchestrator/spec) — 默认的 DAG 模式
- [单 Agent 模式](/zh-CN/features/orchestrator/single) — 退化的 Spec
- [Agenda 模式](/zh-CN/features/orchestrator/agenda) — Planner 动态调度
- [Loop 模式](/zh-CN/features/orchestrator/loop) — 单 Agent 工具循环
- [Skills 集成](/zh-CN/features/orchestrator/skills) — 让某个 Skill 对特定 agent 可见
- [角色卡编辑器](/zh-CN/features/card-editor/) — 与迭代工作台共用 diff 引擎
