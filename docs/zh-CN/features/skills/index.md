# 技能

**技能（skill）** 是一个紧凑、自包含的知识包，agent 可以按需读取。把每条写作规则、每条口吻约定、每份反八股清单全塞进一份巨型系统提示词里是常见痛点；技能让你把它们拆成命名的包，由 agent 在真正需要的时候去拉。

Luker 的技能格式与 [Anthropic Claude Skills](https://www.anthropic.com/news/skills) 兼容 —— 同样的 `SKILL.md` + frontmatter + 可选子文件结构 —— 所以 Claude Code 里写的技能放进 Luker 能直接用，Luker 里写的技能放进 Claude Code 也不用转换。

编排器自带的默认 director profile 就是建立在技能之上的：一段极薄的主代理身份提示词 + 24 份出厂技能，agent 按名字读取。你也可以把自己的 profile 调成同样的样子。

## 为什么有这玩意

多 agent 编排里最常见的痛点之一是「这个 prompt 两千多行，我不敢动它」。所有可复用的规则 —— 反八股清单、角色口吻约定、七步回合工作流、事件摘要格式 —— 过去都内联在 `systemPrompt` 字段里，经常在多个子代理里重复拷贝。

技能把这整块拆开。agent 的身份留在 `systemPrompt`（「你是口吻评审，这是你的职责」）；可复用规则放进技能文件里。agent 在真正需要时通过 `skill_read` 读取，规则的编辑、版本管理、分发都跟消费它的 prompt 解耦。

## 技能的结构

一个技能是一个目录：

```
director-anti-cliche-zh/
├── SKILL.md          # 必需 —— frontmatter + 正文
├── references/       # 可选 —— 辅助清单、更长的参考资料
├── examples/         # 可选 —— 真实示例
└── assets/           # 可选 —— 二进制附件
```

`SKILL.md` 是唯一必需的文件。它带着 Anthropic 标准的 YAML frontmatter：

```markdown
---
name: director-anti-cliche-zh
description: 叙事写作的反八股模式。
license: MIT
metadata:
  author: Luker Team
  version: 1.0.0
  tags: [writing-rules, zh, director]
---

# director-anti-cliche-zh

本技能记录了默认 director profile 主动防范的八股模式……
```

- `name` 和 `description` 是必需的。
- `license` 和 `metadata.*` 是可选的，遵循 Anthropic 标准。Luker 不引入私有命名空间。
- 正文就是「契约」—— agent 读取这个技能时，正文就是它消费的内容。要写得直接、命令式；把「什么时候用」「怎么用」「优先使用哪些工具」等指导都放进正文。

完整的写作手册见 [创作技能](/zh-CN/features/skills/authoring)。

## 三种作用域

技能物理上存放在 `data/<user>/skills/<scope>/`。Luker 有三种作用域：

| 作用域 | 存放位置 | 何时生效 | 用途 |
|---|---|---|---|
| `global` | `data/<user>/skills/global/<name>/` | 始终可见 | 通用写作规则、反八股清单、共享方法文档 |
| `preset` | `data/<user>/skills/preset/<api>/<preset>/<name>/` | 仅在选中该预设时 | 跟某个 Chat Completion 预设强绑的规则（如为 Claude 4 derive 的编排器预设） |
| `character` | `data/<user>/skills/character/<file>/<name>/` | 仅在加载该角色卡时 | 角色卡专属设定、口吻约定、世界内俚语 |

当 agent 按名字查找技能时，运行时遍历三种作用域，应用**后者优先**的优先级：`character` 覆盖 `preset`，`preset` 覆盖 `global`。所以一个名为 `voice-rules` 的 `character` 作用域技能会在该卡加载期间悄悄接管同名的 `global` 版本，切换卡片后再退回。

重要：编排器 profile 里写 `skills.visible: ["voice-rules"]` 时，它**只按名字**引用 —— 没有作用域前缀。把技能在作用域之间挪动永远不会破坏引用。

### 预设 / 角色卡作用域的技能会随它们一起导出

`preset` 和 `character` 作用域不只是你自己存放技能的目录——它们打包导出时，技能也跟着走：

- **预设**作用域的技能会写进预设的 JSON。导出预设、发给别人、对方导入——他们也得到你的技能。
- **角色**作用域的技能会写进角色卡 PNG 的 metadata。导出 PNG、分享卡片，你的技能跟着卡走。

所以如果你写的写作纪律技能依赖某个预设的提示词结构，或者某条嗓音规则只对一张卡有意义，按这个作用域写就够——分享是顺带的事，不用单独处理。详见 [把技能打包进预设 / 卡片](/zh-CN/features/skills/management#embed-export-into-presets-and-cards)。

## agent 如何看到技能

编排器 profile 在两个层级带着 `skills` 策略：

- **模式级** —— 适用于该模式下每个 agent（主代理 + 子代理）的默认值。
- **每 agent 覆写** —— 每个 agent 可以钉自己的 `visible` / `deny` 列表。开头的 `"+"` 表示继承模式默认值再追加。

运行时在派遣时把策略与物理库存对账，给 agent 交付一份过滤后的清单。由此带来两件事：

1. **一份精简目录被自动注入到 agent 的系统提示词**—— `<available_skills>` 块逐行列出每个可见技能的名称和描述。agent 不需要花一轮 `skill_list` 工具调用就知道有什么可用。
2. **三个函数工具 —— `skill_list`、`skill_read`、`skill_search` —— 提供给 agent**。它们被限制在可见集内；agent 拿不到策略之外的技能。`skill_read` 是主力 —— agent 需要正文时就调用它。它还接一个 `path` 参数，所以带子文件（`references/`、`examples/` 等）的技能可以选择性地按路径读：`skill_read({ name: "my-skill", path: "references/checklist.md" })`。skill 作者在 SKILL.md 里写明哪些子文件值得拉、什么时候拉 —— 见 [创作技能](/zh-CN/features/skills/authoring#何时使用子文件)。

策略解析的完整规则见 [编排器集成](/zh-CN/features/skills/orchestrator-integration)。

## 分层概览

```d2
direction: down

user: "用户安装 / 自创" {
  style.fill: "#e1f5ff"
  fs: "data/<user>/skills/\n  global / preset / character" { style.fill: "#fffde7" }
}

bundled: "Luker 出厂自带" {
  style.fill: "#fff3e0"
  pop: "default/skills/global/*\n（首次安装时落到 global 作用域）" { style.fill: "#fffde7" }
}

orch: "编排器 profile" {
  style.fill: "#e8f5e9"
  mode: "mode.skills.visible / deny" { style.fill: "#fffde7" }
  agent: "agent.skills.visible（+ 继承）" { style.fill: "#fffde7" }
}

runtime: "派遣时解析器" {
  style.fill: "#fce4ec"
  walk: "遍历三个作用域\n（后者优先）" { style.fill: "#fffde7" }
  policy: "应用 visible / deny" { style.fill: "#fffde7" }
  catalog: "<available_skills> 目录\n注入到系统提示词" { style.fill: "#fffde7" }
}

agent: "运行中的 agent" {
  style.fill: "#f3e5f5"
  tools: "skill_list / skill_read / skill_search" { style.fill: "#fffde7" }
}

bundled.pop -> user.fs: "首次安装出厂导入\n（之后只能通过按钮）"
user.fs -> runtime.walk
orch.mode -> runtime.policy
orch.agent -> runtime.policy
runtime.walk -> runtime.policy
runtime.policy -> runtime.catalog
runtime.catalog -> agent.tools
```

## 读 vs 写

agent 只能通过三个函数工具**读取**技能，无法修改。这是有意为之 —— 技能是用户管理的底层素材，只有用户（或者代表用户工作的 AI 助手，比如 [迭代工作台](/zh-CN/features/orchestrator/iteration-studio) 的技能工具）才能改技能内容。

面向用户的写入入口：

- **编排器配置里的技能管理子面板** —— 安装、编辑、改名、迁移作用域、删除。
- **内嵌技能编辑器** —— 文件树 + Markdown 编辑器，编辑 SKILL.md 和子文件。
- **导入 / 导出** —— 把一个或多个技能打包进角色卡或预设；导入时从内嵌载荷里抽出技能。详见 [技能管理](/zh-CN/features/skills/management)。
- **迭代工作台工具** —— 让迭代工作台的 AI「把这条写作规则抽成一个技能」时，它通过一组专门的工具完成抽取，并把 agent 的 `systemPrompt` 同步改写。

## 24 个出厂技能

全新的 Luker 安装会把 `data/<user>/skills/global/` 填入 24 个出厂默认技能，全部由 director profile 原先的内联 prompt 拆解而来。它们分三类：

- **共享类（5 个）**—— `director-anti-cliche-zh`、`director-character-voice-zh`、`director-no-meta-zh`、`director-output-discipline-zh`、`director-zh-style-baseline`。所有默认 director 子代理都可见。
- **主代理类（2 个）**—— `director-turn-workflow-zh`、`director-dispatch-protocol-zh`。仅主代理可见。
- **每子代理一份（17 个）**—— 每个默认子代理一份方法/契约技能（如 `voice-critic-method-zh`、`event-summary-rules-zh`、`chat-scout-method-zh`）。

这些出厂技能从原 director 默认值**逐字搬出** —— 没有改写、没有压缩 —— 所以基于技能的新版 director profile 跟未拆分前同强度。详见 [Director 模式 → 默认技能](/zh-CN/features/orchestrator/director#默认技能)。

## 下一步去哪

- **想写自己的技能？** → [创作技能](/zh-CN/features/skills/authoring)
- **想安装、分享或迁移技能？** → [技能管理](/zh-CN/features/skills/management)
- **想把某个技能挂到具体 agent？** → [编排器集成](/zh-CN/features/skills/orchestrator-integration)
- **在写扩展？** → [技能扩展 API](/zh-CN/development/extension-api/skills)
- **想看它实际跑起来？** → [Director 模式](/zh-CN/features/orchestrator/director)
