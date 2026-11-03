# 单 Agent 模式

单 Agent 是编排器最轻的模式：只运行一个节点，调用一次模型，产出一段引导文本注入主模型。它像一个只剩单个节点的 Spec，适合只需要一句提醒、一段摘要或一条风格约束的回合。

## 什么时候用

- 主对话只需要一段 OOC 提醒、一段世界书摘要或一句写作约束。
- 想使用编排结果的注入，但不想承担多 Agent 的延迟和成本。
- 调试新的引导提示词：先用单 Agent 验证注入位置与效果，再升级到更复杂的模式。
- 预算有限，只需要一次额外调用。

需要 Agent 主动查世界书、检索记忆或做多步研究时，用 [Loop 模式](/zh-CN/features/orchestrator/loop)。需要固定多阶段流程时，用 [Spec 模式](/zh-CN/features/orchestrator/spec)。需要动态决定下一步时，用 [Agenda 模式](/zh-CN/features/orchestrator/agenda)。

## 开始使用

在扩展抽屉把执行模式选为 **单 Agent**。其他模式的编辑器入口会收起，出现两个字段：

- **System Prompt**：Agent 的角色与任务。
- **User Prompt 模板**：本轮提供给 Agent 的输入。

直接填写这两个字段即可，不需要打开编排编辑器。运行时 Agent 的产出会作为编排结果注入主模型。

## 与 Spec 的关系

单 Agent 在底层是只有一个节点的 Spec。切回 Spec 时，看到的就是这个节点，可以继续添加阶段和节点。两个模式之间切换不会丢失提示词。

## 与其他模式对比

| | 单 Agent | Spec | Agenda | Loop |
| --- | --- | --- | --- | --- |
| 模型调用 | 一次 | 多次，按阶段 | 由规划 Agent 决定 | 由 Agent 决定 |
| 配置方式 | 两个提示词字段 | 阶段与节点编辑器 | 规划 Agent 与工作 Agent 池 | 系统提示词与工具开关 |
| 工具调用 | 无 | 无 | 规划 Agent 使用 | Agent 自由使用 |
| 流程 | 固定单步 | 固定阶段 | 动态调度 | Agent 自主决定 |
| 适合 | 简单引导 | 可预期的多阶段准备 | 需要动态调度 | 需要边查边想 |

## 用 AI 编写提示词

[AI 迭代工作台](/zh-CN/features/orchestrator/iteration-studio) 在单 Agent 模式下同样可用。描述希望 Agent 完成的任务，工作台会生成系统提示词与用户提示词，并逐项确认。

## 相关页面

- [多 Agent 编排概览](/zh-CN/features/orchestrator/) —— 通用配置、触发时机与角色卡绑定
- [Spec 模式](/zh-CN/features/orchestrator/spec) —— 多阶段流程
- [AI 迭代工作台](/zh-CN/features/orchestrator/iteration-studio) —— 用自然语言编写提示词
- [Loop 模式](/zh-CN/features/orchestrator/loop) —— 让 Agent 调用工具
