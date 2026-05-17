# Director 模式

Director 是编排器里唯一一种**接管(takeover)模式** —— 这一回合的最终消息正文不再由主 LLM 写,而是由编排器内部的一支 Agent 团队直接产出并提交。其它三种模式(spec / agenda / loop)的产物是紧凑的「作业说明」(capsule),要喂给主 LLM 才出成稿;Director 跳过这一步,Agent 自己把正文写完。

## 它和其它编排模式的核心差别

| 维度 | spec / agenda / loop | director |
|---|---|---|
| 谁写正文 | 主 LLM(读 capsule 后落笔) | 编排器内的主代理(直接写) |
| Agent 的产出 | 紧凑的 capsule 文本 | 完整可发送的消息正文 |
| 主 LLM 在本回合 | 出最终回复 | **不被调用** |
| 适合的场景 | 让主 LLM 在已有 prompt cache 上稳定出活 | 让一支多视角的写作团队**直接交一稿** |

从用户视角看,Director 给你的是「AI 内部一整支团队在协作,你只看到他们交付的最终 RP 回复」的体验:草稿、评审、修订、定稿的所有过程在思考折叠里展开,主聊天窗口里只出现成型的那一段叙事。

## 适合的场景

- **高质量长篇 RP**:角色一致性、文风一致性、连续性同时重要,单一视角顾不过来。
- **想要「草稿 → 评审 → 修订」被强制写进流程**,不靠主 LLM 自觉。
- **需要不同视角各跑自己的模型 / preset**——例如规划用便宜模型,评审用强模型。

不适合:

- 只想让主 LLM 用得更聪明一些 —— 用 [loop](/zh-CN/features/orchestrator/loop) / [spec](/zh-CN/features/orchestrator/spec) / [agenda](/zh-CN/features/orchestrator/agenda),让主 LLM 接 capsule 写。
- 想要毫秒级延迟 —— Director 一回合内部要跑若干轮工具调用 + 若干次子代理派遣,墙钟开销显著。

## 跑起来是什么样

下面这一组截图来自一次真实的 Director 回合。主代理调度了默认 profile 自带的三个子代理(`chat_scout` / `voice_critic` / `continuity_critic`),完整跑完了「侦察 → 起草 → 评审 → 修订 → 定稿」流程。

### 第一步:派遣前置侦察

主代理打开回合后,先派遣 `chat_scout` 扫近期聊天,得到 5 条 `Item / Source / Why` 形式的关键状态摘要。这些摘要进入思考折叠里 `chat_scout` 自己的命名区段(锚点 `### [<handleId>: chat_scout]`),主代理后续起草时能直接读到。

![Director 派遣 chat_scout,5 段侦察输出](/images/orchestrator/director-takeover/director-real-scout-dispatch.png)

### 第二步:起草后双 critic 并行评审

主代理用侦察结果起草一段中文叙事写入正文(`write_message`),然后**并行**派遣两个后置评审子代理:

- `voice_critic`:口吻 / 角色一致性 —— 挑出感觉「不像这个角色」的句子。
- `continuity_critic`:对照聊天 / 记忆 / 世界书的连续性 —— 指出与已确立设定冲突的地方。

两个 critic 在思考折叠里各自有一段同时生长的命名区,字符级别互不错位(每个区段的字节由 JavaScript 单线程事件循环保证连续)。

![voice_critic + continuity_critic 并行评审](/images/orchestrator/director-takeover/director-real-critic-loop.png)

### 第三步:迭代修订与收尾

主代理读两位 critic 的反馈,把它认可的批评通过 `apply_message_patches` 打补丁到正文里,自己判断不靠谱的直接忽略——可以再起一轮迭代(再起一个 critic、再回读一遍稿子)。当主代理判断「可以收尾」时调 `finalize`,handle 进入终态、保存到聊天、UI 解锁。折叠下方就是最终发出的中文正文。

![finalize 之后:折叠下方是最终正文](/images/orchestrator/director-takeover/director-real-final-body.png)

整个回合用户只在主对话里看到最终那一段叙事,所有过程性产出停留在折叠里,展开可读。

## 怎么切到 Director

在扩展抽屉的「多智能体编排」面板里,把**执行模式**设为 **Director(多代理)**。切到 Director 后,spec / agenda / loop 的设置卡片会自动收起,Director 自己的设置卡片出现。

::: tip 99% 的人不该手搓主代理 system prompt
默认主代理系统提示词与默认的五个子代理 id **强耦合**——它已经按「先派侦察、起草、再派评审、迭代修订」的纪律调好了。要改的话推荐用 [AI 迭代工作台](/zh-CN/features/orchestrator/iteration-studio)用自然语言描述需求,让它通过工具调用 patch 你的 profile。
:::

## 工作流梗概

```d2
direction: down

start: "新一回合开始\n(本回合主 LLM 不参与 ——\n编排器自己写正文)" {
  shape: oval
  style.fill: "#e8f5e9"
}

loop: "主代理坐在写作台前" {
  style.fill: "#e1f5ff"

  think: "看一眼当前草稿,\n决定下一步动作" {
    style.fill: "#fffde7"
  }

  decide: "主代理\n下一步要做什么?" {
    shape: diamond
  }

  consult: "找位顾问(默认 profile 自带 8 个子代理)" {
    style.fill: "#fff3e0"
    pre: "起草前侦察\nchat_scout · memory_scout ·\nlorebook_scout · epistemic_scout ·\ncanon_scout(按需)" {
      style.fill: "#fffde7"
    }
    mid: "plot_brainstormer\n结构草图 —— 可按不同角度\n并行派出多份" {
      style.fill: "#fffde7"
    }
    post: "起草后评审\nvoice_critic · continuity_critic" {
      style.fill: "#fffde7"
    }
  }

  research: "查点东西\n翻聊天 · 翻记忆 · 查世界书 ·\n联网 · 记笔记" {
    style.fill: "#fffde7"
  }

  write: "动笔写或改正文\n续写 · 定点打补丁 ·\n回读自己的草稿" {
    style.fill: "#fffde7"
  }

  finalize: "收笔 · finalize 正文" {
    style.fill: "#c8e6c9"
  }

  think -> decide
  decide -> consult: "找顾问"
  decide -> research: "查资料"
  decide -> write: "下笔"
  decide -> finalize: "finalize"
  consult -> think: "顾问返稿"
  research -> think: "下一步"
  write -> think: "下一步"
}

out: "成稿正文发到聊天\n(没有 capsule —— 正文就是输出)" {
  shape: oval
  style.fill: "#f3e5f5"
}

start -> loop.think
loop.finalize -> out
```

1. **主代理在一个工具循环里跑**。每一轮它可以调若干工具,直到主动调 `finalize`、到达轮次上限、或被用户中止。

2. **主代理能用的工具组**:
   - **循环工具**(在 profile 里勾选启用)—— 跟 loop 模式同源:`chat_*` / `lorebook_*` / `memory_*` / `note_*` / `search_*`,用来收集上下文。
   - **协作工具** —— `dispatch_subagent(subagentId, task)` 按 id 启动 profile 预定义的子代理;`dispatch_inline_subagent(systemPrompt, task, ...)` 启动一次性 ad-hoc 子代理;`await_subagents(handles)` 阻塞等子代理完工;`cancel_subagent(handle)` 中止跑到一半的子代理。
   - **消息产出工具** —— `write_message(text, mode?)` 写正文(`mode='replace'` 覆写、`mode='append'` 追加);`apply_message_patches(patches)` 做定点的 context-replace 补丁;`get_draft()` 回读当前草稿;`finalize()` 提交并收尾。

3. **子代理是「一次性顾问」**:派遣时拿到当前聊天快照 + 主代理写的任务简报 + 自己的系统提示词 + 启用的循环工具 + `get_draft()`。子代理彼此看不到对方的存在,看不到主代理的推理,**不能再向下派遣**,也**不能直接写正文**——它们只产出文本,主代理决定怎么用。

4. **默认 profile 自带 8 个为 RP 优化过的子代理**:

   | 子代理 | 作用 | 简单示例(RP 场景) |
   |---|---|---|
   | `chat_scout` | 起草前单源侦察 —— 扫近期聊天,挑出主代理起草要靠的载体状态。 | 返回 5 段 `Item / Source / Why`,例如「林晚的焦虑 / 第 42 楼 / 会把对话引回家族话题」。 |
   | `memory_scout` | 起草前单源侦察 —— 在记忆图里找本回合相关的节点。 | 「第 18 楼外祖母线索是当前情感主线;第 3 楼茶道闲笔休眠中。」 |
   | `lorebook_scout` | 起草前单源侦察 —— 拉激活之外的世界书条目。 | 「『洛阳主城』条目尚未进上下文;相关性:林晚的外祖母在那。」 |
   | `epistemic_scout` | 起草前跨源侦察 —— 把聊天(每个角色经历过什么)与世界书 / 记忆(世界里能知道什么)交叉,给出每个角色的「知道 / 不知道 / 上帝视角陷阱」清单。 | 「林晚**不知道**用户是围城将军的儿子 —— 她只见过他两次,带话的人还没出场。」 |
   | `canon_scout` | 按需的外部侦察 —— 同人 / 公共 IP 设定考据。原创世界跳过。 | 触到火影设定:「中忍考试不是考的,是推荐 —— 相关:若林晚自称中忍候选则要修正。」 |
   | `plot_brainstormer` | 中段头脑风暴 —— 每个角度产出一份结构草图。可按不同角度并行派多份拿到真正不同的选项。 | 角度 A「正面冲突」 / 角度 B「沉默本身成为节拍」 / 角度 C「她借转向洛阳话题躲避」。 |
   | `voice_critic` | 起草后评审 —— 口吻 / 角色一致性。揪出不像她说话的句子。 | 「草稿里林晚说『嗨哥们』—— 出戏;她从不用随意称呼。改成『公子』或沉默。」 |
   | `continuity_critic` | 起草后评审 —— 与聊天 / 记忆 / 世界书的连续性。揪出与已确立事实的矛盾。 | 「草稿里林晚放下茶杯,但她从第 38 楼起就拿着剑。」 |

   默认主代理系统提示词与这 8 个 id **强耦合**,按 id 指名调度,并为每个写好了 task brief 的样式。改子代理时,主代理提示词也要同步改。

5. **主代理对每个子代理的可见信息只有 `id` + `description`**——用户写的 `systemPrompt` **不会**泄露进主代理的提示词。description 是它「点菜」时唯一的依据,所以默认 description 写成三段式:角色 / 不知道什么 / 任务简报每次该带哪些字段。Studio 的迭代系统提示词把这一约定教给 AI,让它编辑 profile 时新建出的子代理 description 真能被主代理用起来。

## 配置

打开「多智能体编排」面板里那个 profile 的编辑器(把模式设为 **Director(多代理)** 后会看到对应的编辑卡片)。

### 主代理

- **API 预设** —— 主代理 `generateTaskStream` 调用走的连接配置。
- **提示词预设** —— 主代理用的 Chat Completion 预设(采样器、温度等),决定主代理这一侧的 prompt 结构;**这就是下一节「推荐预设配置」里要讨论的那一个**。
- **系统提示词** —— 留空使用内置默认(草稿 → 评审 → 修订 + 派遣启发式)。除非有明确理由,默认值是按「强制 critique 纪律」调校过的,值得先用默认跑两轮再决定要不要改。

### 子代理

每个子代理一行,字段:

- **子代理 ID** —— 在 profile 内唯一。主代理调用形式是 `dispatch_subagent({ subagentId: "<这个 id>", task: "..." })`。
- **描述** —— 作为工具文档的一部分展示给主代理,让它知道这个子代理擅长什么、何时该派。
- **系统提示词** —— 这个子代理扮演的角色 / 视角。例如:「你是口吻评审,主代理会给你这一回合的草稿——列出任何感觉不像说话人的句子。」
- **API 预设** + **提示词预设** —— 子代理独立的路由,可以让规划类子代理走快/便宜的模型,评审类子代理走强模型。

### 上限

- **工具调用最大轮数** —— 主代理循环的硬上限。
- **同时派遣的子代理最大数** —— `dispatch_subagent` 的并发数。
- **本回合子代理调用总数上限** —— 累计的子代理启动次数。

### 中断时的行为

- **中断时丢弃半成品消息** 关闭(默认):用户中途停止时,半成品消息保留并提交,折叠里追加一段 `### [aborted]` 标记。
- **中断时丢弃半成品消息** 开启:半成品消息丢弃,消息槽回到 placeholder 状态。

## 推荐的 Chat Completion 预设配置

主代理用的那个 Chat Completion 预设,**跟主对话里日常用的预设不是一个东西**——它给主代理的工具循环用,不直接产出最终回复。预设里的占位符提示词只有在跟「主代理的思考方式」或「最终正文的语言风格」直接相关时才有价值,其它的会污染主代理的上下文。

### 建议关闭

| 提示词项 | 为什么关 |
|---|---|
| **角色卡设定**(character description / personality / scenario / first message / example messages) | 主代理已经从聊天历史看到了这个角色,前置侦察子代理也会主动把相关条目摘出来——再叠一层角色卡占位符等于让主代理的 prompt 多读一遍同样的内容。 |
| **用户人设**(persona) | 同上,用户的人设信息已经在聊天上下文里;占位符再注一份只会让主代理在「这一回合用户是谁」这件事上看到两份可能彼此矛盾的描述。 |
| **示例对话**(example messages) | 示例对话本意是给主对话的主 LLM 看「角色的说话风格长什么样」。但 Director 的最终正文不是主 LLM 写的,主代理也不模仿示例,模仿是 `voice_critic` 与「文风指令」共同负责的事。留着只会消耗 token 与污染主代理判断。 |
| **世界书占位符**(如果预设里有显式 worldInfo 拼接节点) | 世界书已经被 ST 主流程注入到主代理拿到的消息里,而且 `lorebook_scout` 也能按需主动查 —— 再多一层占位符只是冗余。 |

### 建议保留

| 提示词项 | 为什么留 |
|---|---|
| **聊天历史** | 主代理判断「这一回合要推进什么、谁在说话、上一拍发生了什么」的唯一来源。一定要留,而且最好是完整的近 N 轮,不要被某些预设里截太短的设置吃掉。 |
| **文风指令** | 直接作用于最终正文质感。主代理在 `write_message` / 给 `voice_critic` 起草任务简报时都需要这条作为依据。 |
| **越狱 / 解除拘束指令** | 跟主对话上同等重要——主代理一旦被审查策略堵住,后面整条「侦察→起草→评审」链路都跑不到 finalize。 |
| **反 cliché 指令**(中文圈惯称「反八股」) | 跟文风指令同源,主代理起草与 critic 评审都会读它。 |
| **JSON / 函数调用支持** | Director 完全建立在 Chat Completion 的工具调用上,这一块**必须开启**,关掉的话整个模式跑不起来。 |

简而言之:**只保留「关于怎么写」与「关于工具调用」的提示词,把「角色 / 用户 / 世界设定」这一类静态占位符全部交给主流程注入。**

## 进阶:把 Director 用作单 Agent 迭代写手

Director 默认是「主代理 + 多子代理」的工作流,但有一种 power-user 用法是把它**退化成单 Agent 多轮迭代创作**——没有 critic,只有一个主代理自己写、自己改、自己拍板。

**适合的场景**:你已经知道想要什么风格,不需要 critic 视角,只想让一个强模型用工具循环(读上下文、读世界书、自己起草、自己回读、自己改)直接产出一稿。本质上是把 director 的「主代理」单拎出来当 loop 模式的 agent 用,但保留 director 直接写正文(不出 capsule)的接管特性。

**怎么改**:

1. 在主代理系统提示词里,删掉所有「派遣子代理」相关的纪律,改写成「你自己起草、自己回读、自己改,认为可以了就 `finalize`」。
2. 在 profile 里把所有子代理删掉(或者把它们的 ID 全部从主代理 prompt 里摘干净)——这样 `dispatch_subagent` 工具不会出现在主代理的工具列表里,只剩 `dispatch_inline_subagent`(可以保留或不保留,看你想不想让主代理在特殊场景临时拉 ad-hoc 子代理)。
3. 主代理的工具组里至少保留:`write_message` / `apply_message_patches` / `get_draft` / `finalize`,以及你想让它用的几个循环工具(典型组合是 `chat_*` + `memory_*` + `lorebook_*`)。
4. 视情况把「工具调用最大轮数」往下调一些(默认 20 对单 agent 来说偏多)。

**注意**:这种模式下没有 critic 兜底,主代理的判断就是终审。建议跑两轮先看主代理在你的 prompt 下能不能稳定 finalize,再决定是不是把这套配置存为新 profile。

## 限制与约束

- 适用于 `normal` / `regenerate` / `swipe` / `continue` 四种生成类型。`quiet` 与 `impersonate` 不触发 Director。
- 要求当前激活的连接配置属于 OpenAI 家族(Anthropic / OpenAI / Gemini / OpenRouter 等)——底层流式 API 暂不支持 kobold / textgen。
- Director 激活的回合里,capsule 注入路径自动禁用(两者概念上互斥:正文本身就是产出)。
- **子代理深度为 1**:不能再向下派遣子代理。它们共享主代理启用的循环工具——profile 里 chat / lorebook / memory / note / search 哪几个开了,子代理就能调哪几个。子代理的自然终止条件是「某一轮没有调用任何工具」:那一轮的文本就是它返回给主代理的答案。
- Director 遵循编排器现有的 **使用流式传输** 开关:开启时主代理与子代理都走流式 API;关闭时使用普通非流式调用。
- **消息气泡在主代理工作过程中实时更新**。主代理每次调 `write_message` / `apply_message_patches` 时,气泡的正文都会被重绘——你能看到消息随工具调用一步步生长、被打补丁、被改写。粒度是「每次工具调用」,不是「每个 token」。
- **子代理的输出实时进入思考折叠**。每个派遣出去的子代理在折叠里有一段命名区(锚点 `### [<handleId>: <subagentId>]`)。开启流式传输时,每个子代理的 token 抵达即落入它自己的区段——同一回合并行派出的多个子代理会以「多个区段同时各自生长」的形式呈现,字符级互不错位(各区段定位依靠 JavaScript 单线程事件循环,保证每个 producer 的字节都连续)。关闭流式时,区段一次性收到子代理的终态全文。区段标题在子代理工作期间带 `(running)` 后缀,完成后清除(失败时替换为 `(error: ...)`)。
- 主代理在工具调用之间的解释也以 `### [main-N]` 段落形式进入思考折叠,让用户能顺着读完跨轮的推理。

## 角色卡绑定

Director profile 跟 spec / agenda / loop 一样支持角色卡覆写。在选中角色卡的状态下打开编排编辑器,会看到 **保存到角色卡覆写** / **清除角色卡覆写** 按钮——绑定后这套 director 配置会随卡导出,卡作者可以为自己的角色推荐一整套「主代理 + 子代理 + 上限」配置。

::: info 跟 spec / agenda / loop 的差异
Director 没有独立的「导出 profile / 导入 profile」按钮——跨电脑同步先用 [AI 迭代工作台](/zh-CN/features/orchestrator/iteration-studio)复用工作流。文件级导入导出会等后续。
:::

## 相关页面

- [编排器概览](/zh-CN/features/orchestrator/) — 通用配置 / 触发时机 / 角色卡绑定
- [AI 迭代工作台](/zh-CN/features/orchestrator/iteration-studio) — AI 帮你写主代理 / 子代理 system prompt(强烈推荐)
- [Loop 模式](/zh-CN/features/orchestrator/loop) — 单 Agent 跑工具循环、产出 capsule
- [Spec 模式](/zh-CN/features/orchestrator/spec) — 默认 DAG,多 Agent 各 stage 产出 capsule
- [Agenda 模式](/zh-CN/features/orchestrator/agenda) — Planner 动态调度 Worker,产出 capsule

