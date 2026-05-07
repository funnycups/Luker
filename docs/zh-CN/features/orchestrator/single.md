# 单 Agent 模式

单 Agent 是编排器最轻的执行模式——只有一个节点跑一次 LLM,产出一段 capsule 注入主模型。本质是个只剩一个节点的退化 Spec,但因为没有多节点协作,扩展抽屉里直接给你两个简化字段,完全不用走编排编辑器。

::: tip 这个模式给谁用
不需要多 agent 协作、不需要工具循环、只想要「一段简单的引导文本」注入主模型的场景。比如:一段 OOC 提醒、一段世界书摘要、一句风格约束。如果你在想「我要是能让主模型回复前先读一下 XXX 就好了」,这个模式可能正合适。
:::

## 切到单 Agent

扩展抽屉里把执行模式选成 **单 Agent**。Spec / Agenda / Loop 的编辑器入口收起,扩展抽屉里多两个简化字段——**System Prompt** 和 **User Prompt 模板**。

直接在这两个字段里写 prompt 即可,不需要打开编排编辑器。

## 模板变量

User Prompt 模板支持以下占位符,和 Spec 模式一致:

| 变量 | 含义 |
|---|---|
| <span v-pre>`{{recent_chat}}`</span> | 最近的聊天消息 |
| <span v-pre>`{{last_user}}`</span> | 最后一条用户消息 |
| <span v-pre>`{{previous_orchestration}}`</span> | 上一回合的编排结果。**运行时自动注入,模板里一般不用写。** |

## 适用场景

- **简单 capsule** — 主对话只需要一段 OOC 提醒、一段 lorebook 摘要、一句约束指令
- **想用 capsule 注入,但不想付多 agent 延迟** — 只跑一次 LLM,延迟最低
- **新提示词调试** — 先单 agent 跑通基础 prompt,验证 capsule 注入位置 / 角色 / 深度都符合预期,再升级到多 agent
- **预算敏感** — 一次 LLM 调用比 Spec 默认工作流的 5–10 次便宜得多

## 不适用场景

- 需要 agent 读世界书、查记忆、做调研 → 用 [Loop 模式](/zh-CN/features/orchestrator/loop)
- 需要多步规划、审查、合成 → 用 [Spec 模式](/zh-CN/features/orchestrator/spec)
- 需要根据中间结果决定下一步 → 用 [Agenda 模式](/zh-CN/features/orchestrator/agenda)

## AI 帮你写 prompt

不会写 prompt?[AI 迭代工作台](/zh-CN/features/orchestrator/iteration-studio)在单 Agent 模式下也能用——切到单 Agent 后打开工作台,描述你想要 agent 干什么,它会帮你生成 system / user prompt。

## 与 Spec 的关系

单 Agent 模式底层是只有一个节点的 Spec profile。这意味着:

- 切到单 Agent → 只有一个节点 + 简化 UI,不打开编排编辑器
- 切回 Spec → 看到的就是这一个节点,可以继续手搓加节点

两者之间切换不会丢配置(System Prompt + User Prompt 在 Spec 模式下是节点 0 的配置)。

## 与其他模式对比

| 维度 | 单 Agent | Spec | Agenda | Loop |
|---|---|---|---|---|
| LLM 调用次数 | 1 | 5–10 | 视 Planner 调度 | 视 agent 决定(默认 ≤ 20 轮) |
| 配置成本 | 两个字段 | 画 DAG + 多 prompt | Planner prompt + worker pool | 一段 system prompt + 工具开关 |
| 工具调用 | ❌ | ❌ | ✅ Planner | ✅ agent 自由调 |
| 流程可变 | ❌ | 拓扑固定 | Planner 决定 | agent 自己决定 |
| 角色卡覆写 | ✅ | ✅ | ✅ | ✅ |
| 适合场景 | 简单 capsule | 流程明确 / stage 固定 | 复杂任务需要调度 | 速度与效果平衡 / 探索性研究 |

## 相关页面

- [编排器概览](/zh-CN/features/orchestrator/) — 通用配置 / 触发时机 / 角色卡绑定
- [Spec 模式](/zh-CN/features/orchestrator/spec) — 多节点 DAG 版本
- [AI 迭代工作台](/zh-CN/features/orchestrator/iteration-studio) — AI 帮你写 prompt
- [Loop 模式](/zh-CN/features/orchestrator/loop) — 想让 agent 调工具就用这个
