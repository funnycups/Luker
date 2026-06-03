# 创作 Skill

一个 Skill 是一个目录：一份必需文件（`SKILL.md`）+ 可选子文件夹。创作一个 Skill 就是给它取名字、写 frontmatter、写一段 agent 能读的正文。仅此而已。

本页讲 Luker（与 Anthropic）期望的约定，沿途要做的选择，以及拿两个出厂 Skill 逐一拆解的真实例子。

## 写一个 skill 的两种方式

你不一定要手敲 SKILL.md。大多数用户从下面两条路之一开始：

| 路径 | 在哪 | 适合 |
|---|---|---|
| **让 LLM 替你写** | [AI 迭代工作台](/zh-CN/features/orchestrator/iteration-studio#用工作台编写-skill) | 在工作台里用一句话告诉它你想要什么；它起草 SKILL.md、安装好，顺便（如果你交代了）挂到对应位置。推荐先用这条。 |
| **自己手写** | [Skill 管理面板 → 新建](/zh-CN/features/skills/management#tab-1-installed-已安装) | 你已经清楚知道想要哪些段落、想自己定措辞、想完全控制文字。 |

![内嵌 Skill 编辑器 — 文件树 + 正文区](/_screenshots/skills/rp-demo-8.5-editor-body-pasted.png)

详见 [《用 skills 调教 RP 输出》](/zh-CN/recipes/rp-skills-walkthrough)。

## 目录布局

```
my-skill-name/
├── SKILL.md          # 必需 —— frontmatter + Markdown 正文
├── references/       # 可选 —— 辅助清单、更长的规范
├── examples/         # 可选 —— agent 可拉取的真实示例
├── assets/           # 可选 —— 二进制附件（图片、PDF）
└── scripts/          # 可选 —— 前向兼容预留，v1 不会执行
```

只有 `SKILL.md` 是必需的。其它文件夹是约定 —— Luker 不强制，但和 Anthropic 布局一致，Skill 保持可移植。

::: info 子文件夹共用同一个 `skill_read` 工具
agent 不会按子文件夹得到不同的工具。它们用 `skill_read({ name, path })` 加相对路径：`skill_read({ name: "my-skill", path: "references/checklist.md" })`。子文件夹纯粹是组织手段。
:::

## Frontmatter —— Anthropic 标准

`SKILL.md` 以 YAML frontmatter 开头：

```markdown
---
name: my-skill-name
description: 一句话摘要，agent 会在目录里看到。
license: MIT
metadata:
  author: 你的名字
  version: 1.0.0
  tags: [writing-rules, en]
---

# my-skill-name

正文从这里开始。
```

| 字段 | 必需 | 约束 | 备注 |
|---|---|---|---|
| `name` | 是 | 小写 ASCII 字母、数字、`-`、`_`；不超过 128 字符 | 必须与目录名一致。编排器 `skills.visible` 引用这个字段。 |
| `description` | 是 | 一句话 | 显示在自动注入的 `<available_skills>` 目录里。写给 **agent** 看，不是给用户看 —— 解释这个 Skill 什么时候相关。 |
| `license` | 否 | 任意字符串（自由格式） | Anthropic 标准。准备分享出去时再用。 |
| `metadata.author` | 否 | 字符串 | Anthropic 标准。 |
| `metadata.version` | 否 | semver 风格的字符串 | Anthropic 标准。语义变更时记得 bump。 |
| `metadata.tags` | 否 | 字符串数组 | 可搜索提示。 |

## 写正文

正文就是契约。agent 调用 `skill_read({ name })` 时，正文是它看到的内容（再加 frontmatter 的一小段 JSON 风格头部）。把正文当作命令式文档来写，不要当百科参考。

借鉴出厂 Skill 的写法，一个有效的范式有四个段落：

1. **这个 Skill 干什么** —— 一段话，让 agent 读完就能确认选对了。
2. **核心规则 / 方法** —— 真正的契约。用编号列表、表格、清单。具体、可执行；agent 会照着字面意思跟随。
3. **示例或失败案例** —— 让成功与失败长什么样具体可见。出厂的 `director-anti-cliche-zh` 用 `✗ 错` / `✓ 对` 的成对行展示。
4. **何时该读哪份子文件** —— 如果你打包了 `references/`，告诉 agent 哪个子文件值得读。

### 语气 —— 写给 agent 看

Skill 是给 LLM 看的，不是给人类运维手册的读者看的。两条推论：

- **要命令式，不要描述式。** 「避免 X」比「X 通常被认为不太合适」更有效。出厂 Skill 就是这种语气。
- **不要元解释。** 一段以「这是一个很棒的 Skill，将帮助你……」开头的正文是浪费 token。agent 都已经决定读它了，直接告诉它该干什么。

### 长度与限额

服务端强制的硬上限：

| 限额 | 数值 |
|---|---|
| `SKILL.md` 大小 | 512 KB |
| 单文件大小 | 4 MB |
| 单个 Skill 总大小 | 16 MB |
| 每个 Skill 文件数 | 100 |

大多数出厂 Skill 在 2–8 KB Markdown 之间。如果你的 Skill 逼近 100 KB，考虑拆分：在 `SKILL.md` 放 5–15 KB 的命令式正文，把长清单挪到 `references/<topic>.md`。agent 仅在相关时才选择性地 `skill_read({ name, path: "references/..." })` —— 更便宜的上下文、更快的读取。

### 读取预算

`skill_read` 强制每次响应不超过 50 KB。超过的文件返回时 `truncated: true`；agent 再用 `offset` 继续调。把正文写成「最重要的内容放最前面」 —— 即使 agent 只读了前 50 KB，也能拿到契约。

## 何时使用子文件

子文件（`references/`、`examples/`、`assets/`）能配得上自己的名号的场景：

- **它们只是偶尔被查阅。** 每次派遣都需要的通用清单属于 `SKILL.md`；5% 场景下才查的专门后备资料属于 `references/`。
- **它们很长。** 一份 30 KB 的真实示例会污染 SKILL.md 的读取；放进 `examples/`。
- **它们是二进制。** 图片、字体、PDF 放 `assets/`。（Skill 里的二进制文件能存得下，但 agent 没法通过 `skill_read` 读出来。如果部署面暴露了 URL，可以作为附件 URL 使用。）

在 `SKILL.md` 里，把 agent 显式指向子文件：

```markdown
## 何时读取额外文件

- `references/cliche-deep-list.md` —— 比本文件 top-20 更长的禁用措辞延伸清单。
  草稿反复踩到这里没列出的模式时再读。
- `examples/before-after.md` —— 六对「数据人式文字」与「重写为活人文字」的
  对照例。会话开始时读一遍校准。
```

## 真实例子 1：`director-anti-cliche-zh`

这个出厂 Skill 是单文件、约 3 KB 的 SKILL.md，没有子文件。它在整个默认 director profile 内强制反八股写作规则。

frontmatter：

```yaml
---
name: director-anti-cliche-zh
description: 叙事写作的反八股模式 —— 禁用措辞、AI 自造标签、契约词汇、升华八股。
metadata:
  author: Luker Team
  version: 1.0.0
---
```

正文遵循「规则家族」结构：每一族主要的八股（数据人式文字、契约词汇、升华八股、AI 自造标签）各得一个标题，并给出具体的双语示例。没有子文件 —— 整套契约小到能塞进 `SKILL.md`。

这个 Skill 是模式级可见：每个默认 director 子代理（主代理、口吻评审、连贯性评审、剧情头脑风暴员……）都看得到。它锚定了整支团队的写作标准。

## 真实例子 2：`event-summary-rules-zh`

这个出厂 Skill 是更密的 ~12 KB 的 SKILL.md，同样没有子文件。它是 `memory_curator` 子代理的写作契约 —— V10 事件摘要纪律。

frontmatter：

```yaml
---
name: event-summary-rules-zh
description: 给 memory_curator 用的事件摘要写作规则（V10）—— 7 步流程、闸门循环、反复述纪律。
metadata:
  author: Luker Team
  version: 1.0.0
---
```

正文先确立心智模型（「索引，不是回放」），然后定义带闸门循环的 7 步写作流程，再详细列出反复述规则。关键是每条规则都附了真实示例 —— `✗ 错` 与 `✓ 对` 并列 —— 因为这种纪律细微，只给抽象规则的 LLM 会一致地违反。

这个 Skill 是按子代理一对一：只有 `memory_curator` 在它的 `skills.visible` 里有这一条（通过 `"+"` 继承模式级默认值）。口吻评审不需要、连贯性评审不需要；只有 curator 需要，并且只在它真的在写摘要时才需要。

## 选合适的作用域

新建 Skill 时要选一个作用域。经验法则：

- **`global`** —— 个人使用的默认值。每次聊天都想用的通用规则。
- **`preset`** —— 该 Skill 仅在搭配特定 Chat Completion 预设时才有意义（一种模型特调的提示约定、依赖采样器的文风规则）。导出时跟着预设走。
- **`character`** —— 该 Skill 编码了角色卡专属设定或口吻规则。导出时跟着角色卡走（PNG 元数据）。

作用域可以随时改 —— Skill 管理子面板的**迁移到……**会做原子级 move。编排器 profile 里的引用（仅按名字）在迁移后仍然有效。

## 校验与安全

服务端在安装 / 写入时校验 Skill：

- frontmatter 必须能解析为 YAML。
- `name` 必须与目录名一致。
- Skill 内部的文件路径不得逃出 Skill 目录（不能 `..`，不能绝对路径）。
- 大小限额（见上）快速失败强制。
- `scripts/` 会被解析但**永不执行** —— 前向兼容预留。UI 在 Skill 携带 scripts 时显示风险标记。

如果校验失败，安装或写入原子回滚（写入走 `.staging/` 目录，校验通过后才提交）。

## 相关

- [Skills 概览](/zh-CN/features/skills/) —— 什么是 Skill、三种作用域
- [Skill 管理](/zh-CN/features/skills/management) —— 安装、导入、导出、迁移作用域
- [编排器集成](/zh-CN/features/skills/orchestrator-integration) —— 把 Skill 挂到 profile 上
- [Skill 扩展 API](/zh-CN/development/extension-api/skills) —— 编程式 `context.skills.*`
