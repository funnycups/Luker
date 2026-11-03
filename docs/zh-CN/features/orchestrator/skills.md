# Skills

编排器派遣某个 Agent 时，它只能看到你为它选定的 Skill，看不到整个库。本页说明如何把 Skill 挂到指定 Agent 上。

Skill 本身是什么、`SKILL.md` 怎么写，见 [Skills 概览](/zh-CN/features/skills/)。

## 挂载方式

**让工作台代劳（推荐）。** 在 AI 迭代工作台编写或修改 Skill 时，顺便说明要让谁能看到，例如「让 Director 下所有 Agent 都能看到」或「只给文风评审看」。它会在同一轮审批里挂到对应位置，你不需要决定放在哪一层。详见 [用 Skills 调整角色扮演输出](/zh-CN/recipes/rp-skills-walkthrough) 和 [用工作台编写 Skill](/zh-CN/features/orchestrator/iteration-studio#用工作台编写-skill)。

**自行挂载。** 打开编排器面板中的 Director 编辑器，滚动到 Skill 列表区域。每个 Agent 各有一份列表，顶部还有一份所有 Agent 共享的列表。从下拉中选择一个 Skill，点击**添加**，然后保存。

![Director 编辑器中的 Skill 列表，刚添加的一条 Skill](/images/skills/rp-demo-11-director-chip-added.png)

不确定挂在哪一份里，让工作台决定即可。

## Agent 看到什么

派遣时，运行时在 Agent 的系统提示词前面附上一份简短清单，只有名称和描述，不含正文。Agent 根据描述判断哪条相关，需要时再按名称读取正文。

清单里只有名称。读取正文时按角色卡、预设、全局的顺序解析，后者覆盖前者。因此同名的角色卡 Skill 会在该卡加载期间覆盖全局版本，切换到其他卡后自动恢复。

## 相关页面

- [Skills 概览](/zh-CN/features/skills/) —— Skill 的结构与作用域
- [Skill 管理](/zh-CN/features/skills/management) —— 安装、导入、删除与切换作用域
- [创作 Skill](/zh-CN/features/skills/authoring) —— Skill 正文的写作规则
- [编排器集成](/zh-CN/features/skills/orchestrator-integration) —— 继承规则、通配符与禁用列表
- [AI 迭代工作台](/zh-CN/features/orchestrator/iteration-studio) —— 让 AI 替你写 Skill
- [用 Skills 调整角色扮演输出](/zh-CN/recipes/rp-skills-walkthrough) —— 端到端示例
