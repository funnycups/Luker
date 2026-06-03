# Skills

编排器派发某个 agent 时，那个 agent 只能看到你专门给它"亮出来"的 skills，看不到整个技能库。这一页讲的是怎么**让一个 skill 对某个 agent 可见**。

skill 本身是什么、SKILL.md 长什么样、怎么写——见 [Skills 概览](/zh-CN/features/skills/)。

## 两种挂载方式

**让工作台替你挂（推荐）。** 在 AI 迭代工作台里让它写 skill 或改 skill 的时候，顺便告诉它你想让谁能看到——"让导演模式下所有 agent 都看到"、"只给 voice_critic 看"——它会在同一轮审批里把这条挂到对应的位置。你不用想该放哪一层。详见 [《用 skills 调教 RP 输出》](/zh-CN/recipes/rp-skills-walkthrough) 和 [工作台的 skill 编写](/zh-CN/features/orchestrator/iteration-studio#用工作台编写-skill)。

**自己挂。** 打开编排器面板里的导演编辑器，往下滚到技能列表那一节。每个 agent 自己有一份列表，顶上还有一份所有 agent 共享的列表。从下拉里选一个 skill，点**添加**，保存。

![导演编辑器 — 技能列表，刚添加的一条 skill](/_screenshots/skills/rp-demo-11-director-chip-added.png)

不确定挂在哪一份里？让工作台来更省心——你描述一下需求，剩下的让它决定。

## Agent 派发时看到什么

派发时，运行时会在 agent 的系统提示词顶部拼上一段简短的清单，只有名字和描述，不含正文：

```
<available_skills>
- director-character-voice-zh: Character voice consistency rules — living-being principle, archetype handling, voice-register matching.
- director-no-meta-zh: 禁止破坏沉浸——叙述与对话都在故事世界内，作者侧装置不在场。
- director-anti-cliche-zh: Anti-cliché checklist — banned phrases, narrative-template avoidance, freshness rules.
- voice-critic-method-zh: How voice_critic audits a draft — pass criteria, common failure modes, hand-off back to the main agent.

(Use skill_read to consult specific content; skill_search to grep within a skill.)
</available_skills>
```

agent 自己判断哪条相关。如果某条描述跟当前任务直接相关，agent 就调一次 `skill_read({name: "..."})`，SKILL.md 的正文以工具调用的返回结果回来。

清单里**只有名字**。`skill_read` 真去拉正文的时候，运行时按 `character → preset → global` 走，后者覆盖前者。所以同名的 `character` 作用域 skill 会在该角色卡加载期间静悄悄盖掉 `global` 的同名版本，切到别的卡又自动让位。

## 相关

- [Skills 概览](/zh-CN/features/skills/) — SKILL.md 长什么样、scope 怎么用
- [技能管理](/zh-CN/features/skills/management) — 安装 / 导入 / 删除 / 切换作用域
- [创作技能](/zh-CN/features/skills/authoring) — 技能正文的写作规则
- [编排器集成（深度）](/zh-CN/features/skills/orchestrator-integration) — 完整层级策略、继承规则、通配符、deny 列表
- [AI 迭代工作台](/zh-CN/features/orchestrator/iteration-studio) — 让 LLM 替你写技能
- [Recipe：用 skills 调教 RP 输出](/zh-CN/recipes/rp-skills-walkthrough) — 端到端示例
