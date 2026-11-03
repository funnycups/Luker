# 编排器集成

编排器里的每个 Agent 都有一份 Skill 列表，决定它运行时能读到哪些知识包。

## 编辑 Agent 的 Skill

在编排编辑器里，每个 Agent 的设置卡都有 **Skill** 一行：

- **继承标记**：沿用该模式的默认列表。
- **具名条目**：这个 Agent 额外可见的 Skill。点条目可以移除，点 **添加** 从已安装的 Skill 里选择。
- **禁用列表**：明确不让这个 Agent 看到的 Skill，优先级高于可见列表。

面板顶部的 **Skill** 行是模式级默认值，作用于该模式下的所有 Agent。编辑单个 Agent 只改它自己的覆写。

切换执行模式时，Skill 行按该模式的配置重新显示。每种模式各自保存一份策略。

## 列表如何合并

- Agent 没有设置列表：继承模式默认值。
- Agent 的列表以继承标记开头：保留模式默认值，再追加自己的条目。
- Agent 的列表不以继承标记开头：完全替换模式默认值。
- 禁用列表在两层之间取并集，禁用的名称优先。

## Agent 看到什么

运行时把可见 Skill 的名称与描述作为一份简短目录注入 Agent 的上下文。Agent 需要正文时按名称读取，也可以在一份 Skill 内搜索。它只能访问可见范围内的 Skill。

## Skill 缺失

Skill 按名称引用。改名、删除或尚未安装时，运行时在派遣阶段跳过它，Agent 看不到这个 Skill，但派遣不会失败。编辑器里对应条目会变灰并提示未安装。

角色卡或预设带来的 Skill 没有装齐时，编排仍可运行；补装后引用自动恢复。

## 用 AI 编辑

[AI 迭代工作台](/zh-CN/features/orchestrator/iteration-studio) 可以按自然语言修改绑定关系。描述要让哪个 Agent 看到哪些 Skill，工作台会提交待审改动。

## 相关页面

- [Skills 概览](/zh-CN/features/skills/) —— 什么是 Skill、作用域与可见性
- [创作 Skill](/zh-CN/features/skills/authoring) —— 写自己的 Skill
- [Skill 管理](/zh-CN/features/skills/management) —— 安装、迁移、删除
- [Director 模式](/zh-CN/features/orchestrator/director) —— 出厂自带完整 Skill 集成的多 Agent 配置
- [AI 迭代工作台](/zh-CN/features/orchestrator/iteration-studio) —— 用自然语言修改策略
