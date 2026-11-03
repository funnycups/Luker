# 创作 Skill

一个 Skill 是一个目录：一份必需的 `SKILL.md`，加上可选的子文件夹。创作 Skill 就是给它命名、写 frontmatter、写一段 Agent 能读的正文。

本页说明目录约定、frontmatter 字段、正文写法，以及什么时候该拆子文件。

## 从哪里开始

不必手敲全部内容。常见做法：

- **让 AI 起草**：在 [AI 迭代工作台](/zh-CN/features/orchestrator/iteration-studio#用工作台编写-skill) 里描述想要的效果，它会起草 `SKILL.md`、安装好，并在你要求时挂到对应 Agent。
- **自己写**：在 [Skill 管理面板](/zh-CN/features/skills/management) 新建，完全控制措辞与结构。

## 目录布局

```text
my-skill-name/
├── SKILL.md          # 必需：frontmatter 与正文
├── references/       # 可选：辅助清单、较长规范
├── examples/         # 可选：Agent 可以读取的真实示例
├── assets/           # 可选：图片、PDF 等附件
└── scripts/          # 可选：预留，当前不会执行
```

只有 `SKILL.md` 是必需的。其他文件夹是组织约定，与 Anthropic 的布局一致，方便分享与迁移。

## Frontmatter

`SKILL.md` 以 YAML frontmatter 开头：

```markdown
---
name: my-skill-name
description: 一句话摘要，Agent 会在目录里看到。
license: MIT
metadata:
  author: 你的名字
  version: 1.0.0
  tags: [writing-rules, zh]
---

# my-skill-name

正文从这里开始。
```

| 字段 | 必需 | 约束 | 说明 |
| --- | --- | --- | --- |
| `name` | 是 | 小写字母、数字、`-`、`_` | 必须与目录名一致。 |
| `description` | 是 | 一句话 | 显示在 Agent 看到的目录里。写给 Agent 看，说明这个 Skill 什么时候相关。 |
| `license` | 否 | 任意字符串 | 准备分享时填写。 |
| `metadata.author` | 否 | 字符串 | 作者信息。 |
| `metadata.version` | 否 | 版本字符串 | 语义变更时更新。 |
| `metadata.tags` | 否 | 字符串数组 | 便于搜索。 |

## 正文

正文是 Agent 实际读到的内容。写成直接、可执行的规则，不要写成百科条目。一个有效的结构：

1. **这个 Skill 做什么**：一段话，让 Agent 确认自己选对了。
2. **核心规则**：编号列表、表格或清单。具体、可执行，Agent 会照字面执行。
3. **示例**：用「错误 / 正确」的对照让标准可见。
4. **何时读取子文件**：如果打包了参考资料，明确说明什么情况下读哪一份。

### 语气

Skill 写给 LLM 看，不写给人类运维手册的读者看。

- 用命令式，不用描述式。「避免 X」比「X 通常被认为不太合适」更有效。
- 不写元解释。「这是一个很棒的 Skill，将帮助你……」是浪费上下文；Agent 已经决定读了，直接告诉它该做什么。

### 长度

把最重要的内容放在最前面。Agent 读取时可能只拿到正文的开头部分，后面的内容未必进入上下文。

正文保持在能说清规则的规模。规则变长时，把扩展清单、长示例和参考资料移到子文件，而不是让 `SKILL.md` 无限增长。

## 何时使用子文件

- **只是偶尔查阅**：每次都需要的基础规则放在 `SKILL.md`，特定场景才查的资料放在 `references/`。
- **内容很长**：完整示例、长清单放在 `examples/` 或 `references/`。
- **二进制附件**：图片、字体、PDF 放在 `assets/`。

在 `SKILL.md` 里明确指向子文件，并说明读取时机：

```markdown
## 何时读取额外文件

- `references/cliche-deep-list.md`：比本文件更长的禁用措辞清单。
  草稿反复踩到未列出的模式时再读。
- `examples/before-after.md`：数据化文字与活人文字的对照例。
  会话开始时读一遍校准。
```

## 示例：反八股规则

一个单文件的写作规则 Skill 可以按「规则家族」组织：数据化描写、契约词汇、升华式总结、AI 自造标签各占一节，每节给出具体例子。规则总量不大时，全部放进 `SKILL.md` 即可。

这类 Skill 通常设为全局或模式级可见，让团队里的每个 Agent 都遵循同一套写作标准。

## 示例：事件摘要规则

事件摘要 Skill 面向负责整理记忆的 Agent。正文先说明摘要的定位，例如「它是索引，不是回放」，再给出写作步骤和反复述规则，并用「错误 / 正确」的对照说明细微差别。

这类 Skill 只挂给真正需要它的 Agent，不必让所有 Agent 都读取。

## 选择作用域

- **全局**：每次聊天都想用的通用规则。
- **预设**：只在搭配某份聊天补全预设时有意义，随预设导出。
- **角色卡**：角色专属设定或口吻规则，随角色卡导出。

作用域可以随时迁移，引用按名称解析，迁移后无需改动。

## 校验与安全

安装或保存时，Luker 会检查 frontmatter 能否解析、名称是否与目录一致、文件路径是否留在 Skill 目录内，以及大小是否超过限制。校验失败会回滚，不会留下半个 Skill。

`scripts/` 会被识别但不会执行。界面会在 Skill 携带脚本时显示风险标记。

## 相关页面

- [Skills 概览](/zh-CN/features/skills/) —— 什么是 Skill、作用域与可见性
- [Skill 管理](/zh-CN/features/skills/management) —— 安装、导入、导出、迁移
- [编排器集成](/zh-CN/features/skills/orchestrator-integration) —— 把 Skill 挂到指定 Agent
- [Skill 扩展 API](/zh-CN/development/extension-api/skills) —— 开发者接口
