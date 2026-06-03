# 用 skills 调教 RP 输出

Skills 是给 agent 用的知识包。导演派发某个 sub-agent（`intent_scout`、`voice_critic`、`plot_brainstormer` 等）时，会顺便把"它能读哪些 skills"的清单和几个查询工具塞给它，它判断哪条相关再去拉正文。整个机制就这点东西。

难的是写出一条真能改变输出的 skill。Luker 自带二十多条作为起点——比如 `director-character-voice-zh`，规定每个角色（包括三无、android 这种冷感人设）首先都是有感官与本能的活的人，禁止情绪戏里出现 "她注意到对方瞳孔散大" 这种观察分析体；它默认就挂在导演 profile 里，每次导演跑，所有 sub-agent 都看得到。

自带集合覆盖不到的纪律，就要自己补一条。两条路：让 AI 迭代工作台替你写（推荐），或者自己手写。

---

## 让工作台替你写

打开编排器面板里的 AI 迭代工作台。

![AI 迭代工作台刚打开](/_screenshots/skills/iter-studio-02-iter-studio-opened.png)

在输入框里说一句你想要的，自然语言：

> 帮我写一条 skill 让导演避开翻译腔。别让角色对话出现"当 X 的时候"这种句式，不要用"——"破折号分隔短句，"是吗？"改成"是吧？"。让导演模式下所有 agent 都看到。

点**发送**。工作台起草 SKILL.md、安装好，顺便（因为你交代了）挂到所有 agent 都能看到的位置。每个动作都显示成一个绿色 ✅ 标记，参数和结果都能展开看：

![工作台跑完安装](/_screenshots/skills/iter-studio-05-after-llm-round.png)

下次你在聊天里发任何一条 RP 消息触发导演时，相关的 sub-agent（这里是 `voice_critic`）就能在它的可见清单里看到这条新规则，审稿时按需拉来用。

想再改这条 skill（加规则、放宽约束、改名）就在同一个会话里接着聊；每次改动都要你审批才落地。

---

## 自己手写（进阶）

适合你已经清楚知道想要哪几段、想自己定措辞、不愿被 LLM 套话的时候。

在编排器面板点**管理技能**，再点**新建**。填好名字、描述、作用域，流程会自动落一份模板 SKILL.md 并打开内嵌编辑器：

![内嵌技能编辑器 — 文件树 + 正文区](/_screenshots/skills/rp-demo-8.5-editor-body-pasted.png)

把模板正文换成你想要的。要找格式参考，随便打开一条自带 skill 看就行——它们用双语段落、`✗` / `✓` 例子对照，结尾用一个 Self-check 段。保存之后回到导演编辑器，把新 skill 加进它的技能列表。

详见 [技能管理](/zh-CN/features/skills/management)。

---

## 相关

- [Skills 概览](/zh-CN/features/skills/) — skill 是什么、scope 怎么用、agent 怎么读
- [Skills 集成](/zh-CN/features/orchestrator/skills) — 让 skill 对某个 agent 可见
- [AI 迭代工作台](/zh-CN/features/orchestrator/iteration-studio) — 工作台完整能力
- [创作技能](/zh-CN/features/skills/authoring) — SKILL.md 格式、frontmatter、多文件
