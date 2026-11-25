# Skills

Skill 是 Agent 按需读取的知识包。把每条写作规则、口吻约定和反八股清单都塞进一份超长系统提示词，会让提示词难以维护，也会在多个 Agent 之间重复拷贝。Skill 把这些规则拆成命名的小包，Agent 只在真正需要时读取。

Luker 的 Skill 格式与 Anthropic Claude Skills 兼容：一份 `SKILL.md` 加可选的子文件。编排器默认的 Director 配置就建立在 Skill 之上：主代理只保留很薄的身份提示词，具体写作规则放在 Skill 里，按名称读取。

## 结构

一个 Skill 是一个目录：

```text
my-skill/
├── SKILL.md          # 必需：frontmatter 与正文
├── references/       # 可选：较长的参考资料
├── examples/         # 可选：真实示例
└── assets/           # 可选：附件
```

`SKILL.md` 以 YAML frontmatter 开头，`name` 和 `description` 必需。正文是 Agent 实际读到的内容，应当写成直接、可执行的规则，而不是百科条目。

## 作用域

Skill 可以放在三个作用域：

| 作用域 | 何时生效 | 用途 |
| --- | --- | --- |
| 全局 | 始终可见 | 通用写作规则、反八股清单、共享方法 |
| 预设 | 选中该聊天补全预设时 | 与某份预设强绑的规则 |
| 角色卡 | 加载该角色卡时 | 角色专属设定、口吻约定、世界内用语 |

同名 Skill 按角色卡、预设、全局的顺序覆盖。引用只写名称，不写作用域，所以把 Skill 在作用域之间移动不会破坏引用。

预设与角色卡作用域的 Skill 会随预设或角色卡一起导出，接收方无需单独安装。

```d2
direction: down

bundled: "Luker 自带的 Skill" {
  style.fill: "#fff3e0"
  pop: "首次安装时进入全局作用域" {
    style.fill: "#fffde7"
  }
}

user: "本地安装的 Skill" {
  style.fill: "#e1f5ff"
  fs: "全局 / 预设 / 角色卡" {
    style.fill: "#fffde7"
  }
}

profile: "编排配置" {
  style.fill: "#e8f5e9"
  mode: "模式级可见范围" {
    style.fill: "#fffde7"
  }
  agent: "Agent 级可见范围" {
    style.fill: "#fffde7"
  }
}

runtime: "派发时解析" {
  style.fill: "#fce4ec"
  walk: "按作用域优先级合并" {
    style.fill: "#fffde7"
  }
  policy: "应用可见与禁用规则" {
    style.fill: "#fffde7"
  }
  catalog: "生成 Skill 目录\n注入 Agent 上下文" {
    style.fill: "#fffde7"
  }
}

agent: "运行中的 Agent" {
  style.fill: "#f3e5f5"
  tools: "按名称读取 Skill 正文" {
    style.fill: "#fffde7"
  }
}

bundled.pop -> user.fs: "导入"
user.fs -> runtime.walk
profile.mode -> runtime.policy
profile.agent -> runtime.policy
runtime.walk -> runtime.policy
runtime.policy -> runtime.catalog
runtime.catalog -> agent.tools
```

## Agent 如何看到 Skill

编排器可以限制每个 Agent 能看到哪些 Skill。运行时把可见 Skill 的名称和描述作为一份简短目录注入 Agent 的上下文，Agent 需要正文时再按名称读取。它只能读取可见范围内的 Skill，无法越过限制。

Director 的默认配置已经为不同 Agent 绑定好各自的 Skill。其他模式默认让 Agent 看到全部已安装 Skill，可以在**工作台 → 编排**里收紧。

## 写入入口

面向用户的写入入口：

- **编排器配置里的 Skill 管理子面板** —— 安装、编辑、改名、迁移作用域、删除。
- **内嵌 Skill 编辑器** —— 文件树 + Markdown 编辑器，编辑 SKILL.md 和子文件。
- **导入 / 导出** —— 导出预设或角色卡时附带其 Skill，导入时安装附带的 Skill。详见 [Skill 管理](/zh-CN/features/skills/management)。
- **迭代工作台工具** —— 让迭代工作台的 AI「把这条写作规则抽成一个 Skill」时，它通过一组专门的工具完成抽取，并把 agent 的 `systemPrompt` 同步改写。

## 出厂 Skill

Luker 自带一组用于角色扮演的 Skill，覆盖反八股、角色口吻、输出纪律、事件摘要等规则。首次启动时它们会安装到全局作用域；之后可以在 Skill 管理面板浏览、导入或覆盖。

## 下一步

- [创作 Skill](/zh-CN/features/skills/authoring) —— 目录结构、frontmatter 与正文写法
- [管理 Skill](/zh-CN/features/skills/management) —— 安装、导入、编辑与打包
- [编排器集成](/zh-CN/features/skills/orchestrator-integration) —— 让指定 Agent 看到指定 Skill
