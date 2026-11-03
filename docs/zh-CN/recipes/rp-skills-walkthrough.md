# 用 Skills 调整角色扮演输出

Skills 是提供给 Agent 的知识包。Director 派遣子代理时，会把「它可以读取哪些 Skills」的清单和查询工具一并提供给它，由它判断哪条相关，再读取正文。

核心是一条能实际改变输出的 Skill。Luker 自带一批出厂 Skill 作为起点。其中一条口吻规则规定每个角色（包括三无、android 这类冷感人设）首先是有感官与本能的角色，禁止在情绪戏中出现「她注意到对方瞳孔散大」这种观察分析体。该 Skill 默认包含在 Director 配置中，运行时所有子代理均可见。

出厂集合覆盖不到的规则，需要自行补充：可以让 AI 迭代工作台代为编写（推荐），也可以手动编写。

---

## 由工作台编写

打开编排器面板中的 AI 迭代工作台。

![AI 迭代工作台刚打开](/images/skills/iter-studio-02-iter-studio-opened.png)

在输入框中用自然语言描述需求：

> 请编写一条 Skill，让 Director 避开翻译腔。角色对话中不要出现「当 X 的时候」这种句式，不要用「——」破折号分隔短句，把「是吗？」改为「是吧？」。让 Director 模式下所有 agent 都能看到。

点击**发送**。工作台起草 SKILL.md 并完成安装，并根据要求挂载到所有 agent 均能看到的位置。操作以绿色 ✅ 标记显示，参数和结果均可展开查看：

![工作台执行完成并安装](/images/skills/iter-studio-05-after-llm-round.png)

下次在聊天中发送角色扮演消息触发 Director 时，相关的子代理（这里是文风评审）就能在可见清单中看到这条新规则，评审时按需读取。

如需修改这条 Skill（添加规则、放宽约束、改名），可以在同一会话中继续对话；改动均需审批后才会写入。

---

## 手动编写（进阶）

适合你已经明确知道需要哪些段落、希望自行确定措辞、不希望受 LLM 套话影响的情况。

在编排器面板点击**管理 Skills**，再点击**新建**。填写名称、描述和作用域后，系统会自动生成一份模板 SKILL.md 并打开内嵌编辑器：

![内嵌 Skill 编辑器 —— 文件树与正文区](/images/skills/rp-demo-8.5-editor-body-pasted.png)

将模板正文替换为所需内容。需要格式参考时，可以打开任意一条自带 Skill 查看：它们使用双语段落、`✗` / `✓` 例子对照，结尾包含一个 Self-check 段。保存后回到 Director 编辑器，将新 Skill 加入它的 Skill 列表。

详见 [Skill 管理](/zh-CN/features/skills/management)。

---

## 相关

- [Skills 概览](/zh-CN/features/skills/) —— Skill 是什么、作用域如何使用、agent 如何读取
- [Skills 集成](/zh-CN/features/orchestrator/skills) —— 让 Skill 对某个 agent 可见
- [AI 迭代工作台](/zh-CN/features/orchestrator/iteration-studio) —— 工作台完整能力
- [创作 Skill](/zh-CN/features/skills/authoring) —— SKILL.md 格式、frontmatter、多文件
