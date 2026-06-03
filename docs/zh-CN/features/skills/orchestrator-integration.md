# 编排器集成

本页讲技能如何挂到编排器 profile 上、以及每个 agent 派遣时如何看到对的那一组。

整体图景：编排器 profile 在两个层级带着 `skills` 策略 —— **模式级**（默认值）与**每 agent 覆写** —— 运行时在每次派遣前把两层与物理库存对账。agent 只看到它解析后的可见集；其余被过滤掉。

## 策略形状

编排器 profile JSON 里，两个 `skills` 块跟 `systemPrompt` 等现有字段并列：

```jsonc
{
  "mode": "director",

  // 模式级默认 —— 应用于该模式下每个 agent。
  "skills": {
    "visible": ["director-anti-cliche-zh", "director-character-voice-zh"],
    "deny": []
  },

  "mainAgent": {
    "systemPrompt": "你是 director 的主代理……",
    // 每 agent 覆写。开头的 "+" 表示继承模式默认值。
    "skills": {
      "visible": ["+", "director-turn-workflow-zh", "director-dispatch-protocol-zh"]
    }
  },

  "subAgents": [
    {
      "id": "voice_critic",
      "systemPrompt": "你是口吻评审……",
      "skills": {
        "visible": ["+", "voice-critic-method-zh"]
      }
    }
    // …更多子代理
  ]
}
```

`visible` 与 `deny` 都是**只有名字**的列表 —— 没有作用域前缀。解析器遍历三个物理作用域，按名字匹配（后者优先：character > preset > global）。

## 三条解析规则

派遣 agent 时，运行时从模式 + agent 两个块算出有效的 `visible` 与 `deny`：

### 规则 1 —— agent 没有 `visible`（或为空）

有效 visible = 模式 visible。agent 原样继承模式默认值。

```jsonc
"mainAgent": {
  "skills": { "visible": [] }  // 或省略
}
// 有效: ["director-anti-cliche-zh", "director-character-voice-zh"]
```

### 规则 2 —— agent 的 `visible` 以 `"+"` 开头

有效 visible = 模式 visible ∪ agent visible 的其余项。`"+"` 是显式的「继承再追加」。

```jsonc
"mainAgent": {
  "skills": { "visible": ["+", "director-turn-workflow-zh"] }
}
// 有效: ["director-anti-cliche-zh", "director-character-voice-zh",
//        "director-turn-workflow-zh"]
```

### 规则 3 —— agent 的 `visible` 不以 `"+"` 开头

有效 visible = agent visible。模式默认值被完全替换。

```jsonc
"specializedSubAgent": {
  "skills": { "visible": ["only-this-one"] }
}
// 有效: ["only-this-one"]
```

这对需要从模式级写作规则里隔离出去的 agent 有用 —— 例如，只产出结构化数据的 agent 不应该看到文字评审类技能。

### deny 永远是并集

`deny` 跨模式 + agent 两层取并集（永不被替换），并且**永远胜过** `visible`。某个技能名字只要出现在任一 deny 列表里，即使也在某个 visible 列表里，仍然被过滤掉。

```jsonc
"mode": "director",
"skills": { "deny": ["director-anti-cliche-zh"] },
"mainAgent": {
  "skills": { "visible": ["+", "director-anti-cliche-zh"] }
}
// 有效 visible: [] (deny 胜出)
```

### 通配符

`visible` 接受 `"*"`，意为「所有已安装技能」。早期想让 agent 看到所有可用项又不想列名时很有用：

```jsonc
"mainAgent": {
  "skills": { "visible": ["*"], "deny": ["scripts-experimental"] }
}
```

通配符按你预期的方式与 `"+"` 和 `deny` 组合。

## agent 实际看到什么

策略解析完之后，运行时在派遣时交给 agent 两件东西：

### 1. 自动注入的目录

一份精简的 `<available_skills>` 块追加到 agent 的系统消息里：

```
<available_skills>
- director-anti-cliche-zh: 叙事写作的反八股模式。
- director-character-voice-zh: 共享的角色口吻规则，所有默认子代理可见。
- director-turn-workflow-zh: director 主代理的 7 步回合工作流。
- ...
</available_skills>

（用 skill_read 查看具体内容；用 skill_search 在一个技能内 grep。）
```

只是目录 —— 名字 + 描述。agent 不用花一轮 `skill_list` 工具调用就知道有什么可用。

默认 director profile 的 18 来项加起来约 150–300 token —— 很便宜。

### 2. 三个函数工具

被限制在可见集内，这是 agent 唯一能拿到技能内容的方式：

| 工具 | 签名 | 返回 |
|---|---|---|
| `skill_list({ query? })` | 可选子串过滤 | `[{ name, description, tags }]` |
| `skill_read({ name, path?, offset?, limit? })` | `path` 缺省 SKILL.md；`offset`/`limit` 是行号 | `{ content, totalLines, truncated }` |
| `skill_search({ name, query, path?, limit?, contextLines? })` | 在单个技能的文件内做子串搜索 | `{ hits: [{ path, lineStart, lineEnd, snippet }] }` |

agent 真的需要正文时就调 `skill_read`。`skill_search` 用于技能很大、只有某一段相关的场景。

运行时硬上限：`skill_read` 响应不超过 50 KB。截断时 agent 用 `offset` 继续读。这保证即使技能携带大块参考文件，上下文成本也是有界的。

## 一个 director 真实例子

出厂的默认 director profile 示范了这些范式：

```jsonc
{
  "mode": "director",

  "skills": {
    "visible": [
      "director-anti-cliche-zh",
      "director-character-voice-zh",
      "director-no-meta-zh",
      "director-output-discipline-zh",
      "director-zh-style-baseline"
    ]
  },

  "mainAgent": {
    "systemPrompt": "<极薄的主代理身份>",
    "skills": {
      "visible": ["+", "director-turn-workflow-zh", "director-dispatch-protocol-zh"]
    }
  },

  "subAgents": [
    {
      "id": "voice_critic",
      "skills": { "visible": ["+", "voice-critic-method-zh"] }
    },
    {
      "id": "memory_curator",
      "skills": { "visible": ["+", "event-summary-rules-zh"] }
    },
    {
      "id": "plot_brainstormer",
      "skills": { "visible": ["+", "plot-brainstormer-method-zh"] }
    }
    // …还有 14 个子代理，形状一致
  ]
}
```

读这份策略：

- **每个 agent 都拿到 5 条共享写作规则** —— 通过模式级 visible。
- **主代理额外拿到** 回合工作流 + 派遣协议 —— 它特有的职责。
- **每个子代理额外拿到自己的方法技能** —— `voice_critic` 读 `voice-critic-method-zh`，`memory_curator` 读 `event-summary-rules-zh`，依此类推。

没有任何一个 agent 的 `skills.visible` 重复模式级条目。`"+"` 前缀让每条 per-agent 覆写都很短 —— 只列出这个 agent 特有的部分，而不是整摞栈。

## 各模式行为

每种编排器模式在略微不同的位置注入目录，但策略解析是一致的：

| 模式 | 目录注入位置 | 每 agent 覆写位置 |
|---|---|---|
| **director** | 主代理系统消息 + 派遣时每个子代理的系统消息 | `mainAgent.skills` + 每个 `subAgents[].skills` |
| **loop** | 唯一的 loop agent 的系统消息 | `loopAgent.skills` |
| **spec** | 执行时每个节点的系统消息 | 每个 `nodes[].skills`（按节点） |
| **agenda** | Planner + 每个被派遣 worker 的系统消息 | `planner.skills` + `workers[].skills` |
| **single** | 该单一节点的系统消息 | `node.skills` |

所有模式下，没有显式 `skills.skills` 字段的 agent 都通过上文规则 1 继承模式级默认值。

::: info 审查节点跳过目录注入
spec 模式的审查节点（review nodes）的目录注入是有意跳过的 —— 审查是结构化的判断任务而不是内容生成任务，给它的 prompt 加 `<available_skills>` 只是噪音。审查节点仍然可以显式调 `skill_list` 或 `skill_read` 看到技能，但自动注入的目录被省略。
:::

## 失效引用

`skills.visible` 是名字列表 —— 每个技能在派遣时才校验物理存在。

- **缺失的技能**（改名 / 删除 / 未安装）：静默过滤掉。agent 看不到；没有错误。
- **在编辑器 UI 里**：该条目变灰，带 tooltip 「该技能未安装」。

这种「软失败」行为是有意的。意味着：

- 导入一张你跳过其内嵌技能的角色卡不会坏任何东西 —— 引用只是悬空。
- 删除一个技能不需要清理每一个引用它的 profile。
- 改名一个技能是一步操作 —— 引用变失效，但派遣继续工作，直到你选择修。

## 编辑策略

在编排器面板里，每个 agent 的设置卡显示一行 **技能**：

![每 agent 的技能 chip，带 + 继承标记](/_screenshots/skills/agent-skill-chips.png)

- **`+`** chip —— 显式的「继承模式默认值」标记（`visible` 以 `"+"` 开头时出现）。
- 每个具名技能一个 chip。点击移除；点 **添加……** 从你已安装的库存里挑。
- **禁用** 行 —— 同样的 chip，独立列表。

面板顶部的模式级 **技能** 行也一样。编辑它更新 `mode.skills`；编辑某个 agent 的行更新该 agent 的覆写。

要让 AI 帮你编辑，[迭代工作台](/zh-CN/features/orchestrator/iteration-studio) 自带技能绑定工具（`skill_bind_to_agent`、`skill_unbind_from_agent`、`skill_set_mode_defaults`）—— 用自然语言描述需求，AI 通过工具调用 patch 你的策略。

## 模式切换会失效

编排器从一种模式切到另一种（例如 director → loop）时，运行时把缓存的解析结果作废。下一次派遣按新模式的策略重新构建目录。UI 也按新模式的 profile 重新渲染 **技能** 行，所以编辑永远反映当前激活的模式。

意味着 `director.mainAgent.skills` 块切到 loop 模式后不会跟过去。每种模式自己一份策略。许多用户在多种模式之间保持类似形状（同样的共享技能、同样的 per-agent 专属），但编辑是按模式独立的。

## 相关

- [技能概览](/zh-CN/features/skills/) —— 什么是技能、三种作用域
- [创作技能](/zh-CN/features/skills/authoring) —— 写自己的
- [技能管理](/zh-CN/features/skills/management) —— 安装 / 迁移 / 删除
- [Director 模式](/zh-CN/features/orchestrator/director) —— 出厂自带完整技能集成的典型多 agent profile
- [AI 迭代工作台](/zh-CN/features/orchestrator/iteration-studio) —— 用自然语言 AI 编辑 patch 策略
- [技能扩展 API](/zh-CN/development/extension-api/skills) —— 从扩展编程式编辑策略
