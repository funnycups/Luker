# Director 模式

Director 是编排器里唯一一种**接管（takeover）模式** —— 这一回合的最终消息正文不再由主 LLM 写，而是由编排器内部的一支 Agent 团队直接产出并提交。其它三种模式（spec / agenda / loop）的产物是紧凑的「作业说明」（capsule），要喂给主 LLM 才出成稿；Director 跳过这一步，Agent 自己把正文写完。

## 它和其它编排模式的核心差别

| 维度 | spec / agenda / loop | director |
|---|---|---|
| 谁写正文 | 主 LLM（读 capsule 后落笔） | 编排器内的主代理（直接写） |
| Agent 的产出 | 紧凑的 capsule 文本 | 完整可发送的消息正文 |
| 主 LLM 在本回合 | 出最终回复 | **不被调用** |
| 适合的场景 | 让主 LLM 在已有 prompt cache 上稳定出活 | 让一支多视角的写作团队**直接交一稿** |

从用户视角看，Director 给你的是「AI 内部一整支团队在协作，你只看到他们交付的最终 RP 回复」的体验：草稿、评审、修订、定稿的所有过程在思考折叠里展开，主聊天窗口里只出现成型的那一段叙事。

## 适合的场景

- **高质量长篇 RP**：角色一致性、文风一致性、连续性同时重要，单一视角顾不过来。
- **想要「草稿 → 评审 → 修订」被强制写进流程**，不靠主 LLM 自觉。
- **需要不同视角各跑自己的模型 / preset**——例如规划用便宜模型，评审用强模型。

不适合：

- 只想让主 LLM 用得更聪明一些 —— 用 [loop](/zh-CN/features/orchestrator/loop) / [spec](/zh-CN/features/orchestrator/spec) / [agenda](/zh-CN/features/orchestrator/agenda)，让主 LLM 接 capsule 写。
- 想要毫秒级延迟 —— Director 一回合内部要跑若干轮工具调用 + 若干次子代理派遣，墙钟开销显著。

## 跑起来是什么样

下面这一组截图来自一次真实的 Director 回合。主代理调度了默认 profile 自带的三个子代理（`chat_scout` / `voice_critic` / `continuity_critic`），完整跑完了「侦察 → 起草 → 评审 → 修订 → 定稿」流程。

### 第一步：派遣前置侦察

主代理打开回合后，先派遣 `chat_scout` 扫近期聊天，得到 5 条 `Item / Source / Why` 形式的关键状态摘要。这些摘要进入思考折叠里 `chat_scout` 自己的命名区段（锚点 `### [<handleId>: chat_scout]`），主代理后续起草时能直接读到。

![Director 派遣 chat_scout，5 段侦察输出](/images/orchestrator/director-takeover/director-real-scout-dispatch.png)

### 第二步：起草后双 critic 并行评审

主代理用侦察结果起草一段中文叙事写入正文（`write_message`），然后**并行**派遣两个后置评审子代理：

- `voice_critic`：人性 & 口吻 —— 揪出「数据人」式描写（冷观察动词 / 数据词汇 / 汇报式对白）与冷设定误读（让科学家"分析"恋人、人造人在亲密中"扫描评估"、三无角色内心被写成真的空白）。
- `continuity_critic`：硬冲突 —— 草稿说 X 而聊天 / 记忆 / 世界书明确说过 NOT-X 时才 flag，以及角色认知边界违规（让角色知道他没被告知过的事）。

两个 critic 在思考折叠里各自有一段同时生长的命名区，字符级别互不错位（每个区段的字节由 JavaScript 单线程事件循环保证连续）。

![voice_critic + continuity_critic 并行评审](/images/orchestrator/director-takeover/director-real-critic-loop.png)

### 第三步：迭代修订与收尾

主代理读两位 critic 的反馈，把它认可的批评通过 `apply_message_patches` 打补丁到正文里，自己判断不靠谱的直接忽略——可以再起一轮迭代（再起一个 critic、再回读一遍稿子）。当主代理判断「可以收尾」时调 `finalize`，handle 进入终态、保存到聊天、UI 解锁。折叠下方就是最终发出的中文正文。

![finalize 之后：折叠下方是最终正文](/images/orchestrator/director-takeover/director-real-final-body.png)

整个回合用户只在主对话里看到最终那一段叙事，所有过程性产出停留在折叠里，展开可读。

## 默认技能

默认 director profile 出厂时配套 **24 个出厂技能**，agent 按需读取。技能是兼容 Anthropic 的紧凑知识包 —— 每一份装载一条写作规则、一份评审方法、或一份工作流契约，过去这些都内联在系统提示词里。把它们移出 prompt、放进 `skill_read` 可访问的文件里，带来三个效果：prompt 短而可编辑；同一条规则可被多个 agent 共用而不必拷贝；卡作者或预设作者可以自己分发变体。

24 个出厂技能分三类：

| 家族 | 数量 | 谁能看到 | 例子 |
|---|---|---|---|
| 共享（模式级） | 5 | 每个默认子代理 | `director-anti-cliche-zh`、`director-character-voice-zh`、`director-no-meta-zh`、`director-output-discipline-zh`、`director-zh-style-baseline` |
| 主代理 | 2 | 仅主代理 | `director-turn-workflow-zh`、`director-dispatch-protocol-zh` |
| 每子代理一份方法 | 17 | 对应那个子代理 | `voice-critic-method-zh`（→ `voice_critic`）、`event-summary-rules-zh`（→ `memory_curator`）、`chat-scout-method-zh`（→ `chat_scout`）…… |

模式级的几条是每个默认 agent 共享的通用写作规则。两条主代理技能装着 7 步回合工作流和派遣协议。每条 per-sub-agent 方法技能装着该子代理的专属契约 —— 例如 `event-summary-rules-zh` 是 `memory_curator` 完整的 V10 事件摘要写作纪律。

默认 profile 相应预填了 `skills.visible`：模式级 visible 覆盖那 5 条共享技能，主代理用 `["+", "director-turn-workflow-zh", "director-dispatch-protocol-zh"]`（继承模式 + 追加两条），每个子代理用 `["+", "<对应方法技能>"]`。所以开箱即用每个 agent 都拿到对的那摞栈，不需要手动绑定。

服务端首次启动时把 `data/<user>/skills/global/` 从 `default/skills/global/` 填充。之后，编排器面板的 **管理技能** 按钮（以及 `import-bundled` API）是唯一覆盖入口 —— 后续启动不会有隐式自动更新。

技能如何挂到 agent 的完整图景，见 [技能概览](/zh-CN/features/skills/) 与 [编排器集成](/zh-CN/features/skills/orchestrator-integration)。创作约定见 [创作技能](/zh-CN/features/skills/authoring)。

## 怎么切到 Director

在扩展抽屉的「多智能体编排」面板里，把**执行模式**设为 **Director（多代理）**。切到 Director 后，spec / agenda / loop 的设置卡片会自动收起，Director 自己的设置卡片出现。

::: tip 99% 的人不该手搓主代理 system prompt
默认主代理系统提示词与默认的十二个子代理 id **强耦合**——它已经按「先派侦察、起草、再派评审、迭代修订、最后落盘」的纪律调好了。要改的话推荐用 [AI 迭代工作台](/zh-CN/features/orchestrator/iteration-studio)用自然语言描述需求，让它通过工具调用 patch 你的 profile。
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

  consult: "找位顾问(默认 profile 自带 12 个子代理)" {
    style.fill: "#fff3e0"
    pre: "起草前侦察\nintent_scout · chat_scout · memory_scout ·\nlorebook_scout · notes_pickup_scout ·\nepistemic_scout · canon_scout(按需)" {
      style.fill: "#fffde7"
    }
    mid: "plot_brainstormer\n结构草图 —— 可按不同角度\n并行派出多份" {
      style.fill: "#fffde7"
    }
    post: "起草后评审\nvoice_critic · continuity_critic" {
      style.fill: "#fffde7"
    }
    housekeeping: "起草后清理\nmemory_curator —— 把会延续的事实写进记忆图\nnotes_curator —— notes 子系统唯一的写入点\n(默认:什么也不做)" {
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

1. **主代理在一个工具循环里跑**。每一轮它可以调若干工具，直到主动调 `finalize`、到达轮次上限、或被用户中止。

2. **主代理能用的工具组**:
   - **循环工具**（在 profile 里勾选启用）—— 跟 loop 模式同源：`chat_*` / `lorebook_*` / `memory_*` / `note_*`（开启/关闭） / `search_*`，用来收集上下文。
   - **协作工具** —— `dispatch_subagent(subagentId, task)` 按 id 启动 profile 预定义的子代理；`dispatch_inline_subagent(systemPrompt, task, ...)` 启动一次性 ad-hoc 子代理；`await_subagents(handles)` 阻塞等子代理完工；`cancel_subagent(handle)` 中止跑到一半的子代理。
   - **消息产出工具** —— `write_message(text, mode?)` 写正文（`mode='replace'` 覆写、`mode='append'` 追加）;`apply_message_patches(patches)` 做定点的 context-replace 补丁；`get_draft()` 回读当前草稿；`finalize()` 提交并收尾。
   - **[自定义工具](./custom-tools.md)** —— 其他 Luker 扩展注册的工具、从 SillyTavern function tool 桥接进来的工具、本编排里手写的工具。子代理看到的是同一组自定义工具面（在子代理粒度有覆写时按覆写过滤）。

3. **子代理是「一次性顾问」**：派遣时拿到当前聊天快照 + 主代理写的任务简报 + 自己的系统提示词 + 启用的循环工具 + `get_draft()`。子代理彼此看不到对方的存在，看不到主代理的推理，**不能再向下派遣**，也**不能直接写正文**——它们只产出文本，主代理决定怎么用。

4. **默认 profile 自带 12 个为 RP 优化过的子代理**:

   | 子代理 | 作用 | 简单示例（RP 场景） |
   |---|---|---|
   | `intent_scout` | 起草前跨源侦察 —— 把用户最近的输入（显式诉求、括号 / OOC 旁白、有载体的隐式信号）与世界书里的「作者向指令」类条目（风格规则、节奏、角色写法、创作约束、输出规范）交叉，surface 用户本回合想要什么 + 世界书对写作有什么要求。 | 「用户旁白：第 72 楼 `(写慢些)`。世界书 `pov-rules`：『始终第二人称叙述，不破第四面墙』。林晚专用条目：『动怒时以碎句开头，然后陷入沉默。』」 |
   | `chat_scout` | 起草前单源侦察 —— 扫近期聊天，挑出主代理起草要靠的载体状态。 | 返回 5 段 `Item / Source / Why`，例如「林晚的焦虑 / 第 42 楼 / 会把对话引回家族话题」。 |
   | `memory_scout` | 起草前的单源 scout，通过记忆图只读 API 跑一次 LLM 级召回。枚举可见候选池，用 `memory_find_by_name` / `memory_keyword_search`（或配了 embedding profile 时 `memory_vector_search`）定位命名实体或主题命中，必要时通过 `memory_expand_seeds` 钻 rollup，然后返回带 signal level 的 ≤6 条引用列表（signal 来自 API 结构信号：edge density、exposure、alwaysInject）。不读 chat 或 lorebook（那是别的 scout 的活）。不改图。 | 「`evt_42`（第 3 章外祖母线索）是 hub —— 其子节点里有 draft 要回收的告白节拍。降权：`msg_18`（一次性提及，无后续）。」 |
   | `lorebook_scout` | 起草前单源侦察 —— 拉激活之外的世界书条目。 | 「『洛阳主城』条目尚未进上下文；相关性：林晚的外祖母在那。」 |
   | `notes_pickup_scout` | 起草前 scout —— 扫描 OPEN notes 块（agent 自己在更早回合开启的伏笔、承诺、章节大纲），挑出本回合触发条件成熟的 id。不分析、不写稿——只挑出来。 | 「`o_a3f2`（外祖母在洛阳）成熟——林晚刚提到这座城。`o_b8c1`（神殿誓言）还没到时机。」 |
   | `epistemic_scout` | 起草前跨源侦察 —— 把聊天（每个角色经历过什么）与世界书 / 记忆（世界里能知道什么）交叉，给出每个角色的「知道 / 不知道 / 上帝视角陷阱」清单。 | 「林晚**不知道**用户是围城将军的儿子 —— 她只见过他两次，带话的人还没出场。」 |
   | `canon_scout` | 按需的外部侦察 —— 同人 / 公共 IP 设定考据，底层走循环工具 `search_search` / `search_visit`。需要 profile 里启用 `search.search` / `search.visit`，否则返回零条结果。原创世界跳过。 | 触到火影设定：「中忍考试不是考的，是推荐 —— 相关：若林晚自称中忍候选则要修正。」 |
   | `plot_brainstormer` | 中段头脑风暴 —— 每个角度产出一份结构草图。可按不同角度并行派多份拿到真正不同的选项。 | 角度 A「正面冲突」 / 角度 B「沉默本身成为节拍」 / 角度 C「她借转向洛阳话题躲避」。 |
   | `voice_critic` | 起草后评审 —— 人性 & 口吻。揪出「数据人」式描写（冷观察动词 / 数据词汇 / 汇报式对白等动情时刻应该烫的地方却写得冷）和冷设定误读（冷设定角色被写成真的冷，而不是「冷皮包热瓤」）。口吻语域错配是次要维度。 | 「草稿里林晚『以临床抽离的姿态观察对象的微表情漂移』—— 这是传感器笔法，不是活人笔法。换成她真的有的某个感觉，即使表面仍然克制。」 |
   | `continuity_critic` | 起草后评审 —— 仅查硬冲突。默认信任 draft；只有当聊天 / 记忆 / 世界书明确说过相反事实时才 flag。例外：角色认知边界违规（角色知道了没人告诉过他的事）永远要 flag。 | 「草稿里林晚认出对方挂坠上的家纹，但聊天里这个挂坠对她而言只被描述成『一枚银盘』。认知边界：她没被告知这是家纹，更没被告知是谁的。」 |
   | `memory_curator` | 后置 mutation sub-agent，更新记忆图，把本轮中会延续过场景的事实写下来。多轮 observe-act 流程：查 schema，创建前用 `memory_find_by_name` 查重已有实体，用 `memory_node_edit` 打补丁字段，用 `memory_link_upsert` / `memory_link_delete` 管理关系边，Phase B 检查 `memory_compaction_candidates` 并调 `memory_compact_nodes` 把事件层级压缩。**event 节点每次 dispatch 必出一个**（时间线连续性）;character_sheet / location_state 默认 SKIP，只在变化通过 24 小时持续性测试时才写。 | 「创建 `evt_42`（Day 5 立誓节点）。编辑 `n_eileen` 加 `goal: '还债'`。新增 `n_eileen → debt_owed_to → n_protag` 边。把 `evt_18,19,20` 压缩成 `rollup_l1_06`。」 |
   | `notes_curator` | 起草后清理 —— 本回合 notes 子系统**唯一**的写入点。关闭草稿中已兑现的笔记；只有在草稿确实埋下了真正的剧情承诺时才开新条。**默认动作：什么也不做**。污染笔记比少关一条更糟。 | 「关闭 `o_a3f2`——本稿外祖母见面已发生。不新增；brainstormer 提到未来去洛阳的伏笔，但本稿没真正埋下，不开。」 |

   默认主代理系统提示词与这 12 个 id **强耦合**，按 id 指名调度，并为每个写好了 task brief 的样式。改子代理时，主代理提示词也要同步改。

   > **笔记反污染原则**:`notes_curator` 默认**什么也不做**。笔记是剧情作者的线索仓库，不是回合日记——被污染的笔记列表会消耗 agent 的注意力。关闭是安全的，开启是昂贵的。这条原则烙在默认 sub-agent 的 prompt 和主代理的 system prompt 里；如果你自己写 director profile，请保留它。

5. **主代理对每个子代理的可见信息只有 `id` + `description`**——用户写的 `systemPrompt` **不会**泄露进主代理的提示词。description 是它「点菜」时唯一的依据，所以默认 description 写成三段式：角色 / 不知道什么 / 任务简报每次该带哪些字段。Studio 的迭代系统提示词把这一约定教给 AI，让它编辑 profile 时新建出的子代理 description 真能被主代理用起来。

## 配置

打开「多智能体编排」面板里那个 profile 的编辑器（把模式设为 **Director（多代理）** 后会看到对应的编辑卡片）。

### 主代理

- **API 预设** —— 主代理 `generateTaskStream` 调用走的连接配置。
- **提示词预设** —— 主代理用的 Chat Completion 预设（采样器、温度等），决定主代理这一侧的 prompt 结构；**这就是下一节「推荐预设配置」里要讨论的那一个**。
- **主代理系统提示词** —— 创建编排时默认文本会被直接写入这个字段。运行时**只看字段里的当前内容**——留空就发空指令，没有隐藏回退。可以自由编辑；**重置为默认值**按钮会把字段内容写回内置默认。除非有明确理由，默认值是按「强制 critique 纪律」调校过的，值得先用默认跑两轮再决定要不要改。

### 子代理

每个子代理一行，字段：

- **子代理 ID** —— 在 profile 内唯一。主代理调用形式是 `dispatch_subagent({ subagentId: "<这个 id>", task: "..." })`。
- **描述** —— 作为工具文档的一部分展示给主代理，让它知道这个子代理擅长什么、何时该派。
- **系统提示词** —— 这个子代理扮演的角色 / 视角。例如：「你是口吻评审，主代理会给你这一回合的草稿——列出任何感觉不像说话人的句子。」
- **API 预设** + **提示词预设** —— 子代理独立的路由，可以让规划类子代理走快/便宜的模型，评审类子代理走强模型。

### 上限

- **工具调用最大轮数** —— 主代理循环的硬上限。
- **同时派遣的子代理最大数** —— `dispatch_subagent` 的并发数。
- **本回合子代理调用总数上限** —— 累计的子代理启动次数。

### 中断时的行为

- **中断时丢弃半成品消息** 关闭（默认）：用户中途停止时，半成品消息保留并提交，折叠里追加一段 `### [aborted]` 标记。
- **中断时丢弃半成品消息** 开启：半成品消息丢弃，消息槽回到 placeholder 状态。

## 推荐的 Chat Completion 预设配置

主代理用的那个 Chat Completion 预设，**跟主对话里日常用的预设不是一个东西**——它给主代理的工具循环用，不直接产出最终回复。预设里的占位符提示词只有在跟「主代理的思考方式」或「最终正文的语言风格」直接相关时才有价值，其它的会污染主代理的上下文。

### 建议关闭

下面这些都关掉，原因都是同一个——**重复注入**:ST 主流程已经把这些内容写进主代理看到的聊天上下文，预设占位符再注一份就是重复。

- **角色卡字段**(description / personality / scenario / first message / example messages)
- **用户人设**(persona)
- **示例对话**(example messages)
- **世界书占位符**（预设里的显式 worldInfo 拼接节点）

### 建议保留

| 提示词项 | 为什么留 |
|---|---|
| **聊天历史** | 主代理 prompt 实际通过这个槽位传递给 LLM。关掉=主代理什么都看不到。 |
| **文风指令** | 主代理 `write_message` 起草、给 `voice_critic` 写任务简报时都会读。 |
| **越狱 / 解除拘束指令** | 一旦主代理中途被审查策略卡住，「侦察 → 起草 → 评审」整条链就到不了 finalize。 |
| **反八股指令** | 与文风指令同源，主代理起草与 critic 评审都会读。 |

## 进阶：把 Director 用作单 Agent 迭代写手

Director 默认是「主代理 + 多子代理」的工作流，但有一种 power-user 用法是把它**退化成单 Agent 多轮迭代创作**——没有 critic，只有一个主代理自己写、自己改、自己拍板。

**适合的场景**：你已经知道想要什么风格，不需要 critic 视角，只想让一个强模型用工具循环（读上下文、读世界书、自己起草、自己回读、自己改）直接产出一稿。本质上是把 director 的「主代理」单拎出来当 loop 模式的 agent 用，但保留 director 直接写正文（不出 capsule）的接管特性。

**用 [AI 迭代工作台](/zh-CN/features/orchestrator/iteration-studio) 改。** 跟它说类似「把当前 profile 改成单 Agent 迭代写手：移除所有子代理，主代理 prompt 简化为 draft → 回读 → 修订 → finalize，保留 `chat_*` / `memory_*` / `lorebook_*` 工具」。Studio 认识这种变体，会通过工具调用 patch 你的 profile——审一下 diff，批准，保存。这是推荐路径，下面的手动步骤只给想自己接线的用户。

::: details 手动改法（Studio 已搞定的话可跳过）

1. 在主代理系统提示词里，删掉所有「派遣子代理」相关的纪律，改写成「你自己起草、自己回读、自己改，认为可以了就 `finalize`」。
2. 在 profile 里把所有子代理删掉（或者把它们的 ID 全部从主代理 prompt 里摘干净）——这样 `dispatch_subagent` 工具不会出现在主代理的工具列表里，只剩 `dispatch_inline_subagent`（可以保留或不保留，看你想不想让主代理在特殊场景临时拉 ad-hoc 子代理）。
3. 主代理的工具组里至少保留：`write_message` / `apply_message_patches` / `get_draft` / `finalize`，以及你想让它用的几个循环工具（典型组合是 `chat_*` + `memory_*` + `lorebook_*`）。
4. 视情况把「工具调用最大轮数」往下调一些（默认 20 对单 agent 来说偏多）。

:::

**注意**：这种模式下没有 critic 兜底，主代理的判断就是终审。建议跑两轮先看主代理在你的 prompt 下能不能稳定 finalize，再决定是不是把这套配置存为新 profile。

## 限制与约束

- 适用于 `normal` / `regenerate` / `swipe` / `continue` 四种生成类型。`quiet` 与 `impersonate` 不触发 Director。
- 要求当前激活的连接配置属于 OpenAI 家族（Anthropic / OpenAI / Gemini / OpenRouter 等）——底层流式 API 暂不支持 kobold / textgen。
- Director 激活的回合里，capsule 注入路径自动禁用（两者概念上互斥：正文本身就是产出）。
- **子代理深度为 1**：不能再向下派遣子代理。它们共享主代理启用的循环工具——profile 里 chat / lorebook / memory / note（开启/关闭） / search 哪几个开了，子代理就能调哪几个。子代理的自然终止条件是「某一轮没有调用任何工具」：那一轮的文本就是它返回给主代理的答案。
- Director 遵循编排器现有的 **使用流式传输** 开关：开启时主代理与子代理都走流式 API；关闭时使用普通非流式调用。
- **消息气泡在主代理工作过程中实时更新**。主代理每次调 `write_message` / `apply_message_patches` 时，气泡的正文都会被重绘——你能看到消息随工具调用一步步生长、被打补丁、被改写。粒度是「每次工具调用」，不是「每个 token」。
- **子代理的输出实时进入思考折叠**。每个派遣出去的子代理在折叠里有一段命名区（锚点 `### [<handleId>: <subagentId>]`）。开启流式传输时，每个子代理的 token 抵达即落入它自己的区段——同一回合并行派出的多个子代理会以「多个区段同时各自生长」的形式呈现，字符级互不错位（各区段定位依靠 JavaScript 单线程事件循环，保证每个 producer 的字节都连续）。关闭流式时，区段一次性收到子代理的终态全文。区段标题在子代理工作期间带 `(running)` 后缀，完成后清除（失败时替换为 `(error: ...)`）。
- 主代理在工具调用之间的解释也以 `### [main-N]` 段落形式进入思考折叠，让用户能顺着读完跨轮的推理。

## 角色卡绑定

Director profile 跟 spec / agenda / loop 一样支持角色卡覆写。在选中角色卡的状态下打开编排编辑器，会看到 **保存到角色卡覆写** / **清除角色卡覆写** 按钮——绑定后这套 director 配置会随卡导出，卡作者可以为自己的角色推荐一整套「主代理 + 子代理 + 上限」配置。

::: info 跟 spec / agenda / loop 一致
Director 跟其他模式一样支持 **导出 profile** / **导入 profile** 按钮。导出文件是一份自包含的 JSON 载荷（`format: luker_orchestrator_profile_v3`），覆盖当前选中的作用域（全局或角色卡覆写）。导入时如果文件里的执行模式与当前模式不匹配，会拒绝加载——切换到对应模式后再导入。
:::

## 相关页面

- [编排器概览](/zh-CN/features/orchestrator/) — 通用配置 / 触发时机 / 角色卡绑定
- [技能概览](/zh-CN/features/skills/) — director 默认值依赖的知识包底层素材
- [编排器集成](/zh-CN/features/skills/orchestrator-integration) — `skills.visible` 如何按 agent 解析
- [AI 迭代工作台](/zh-CN/features/orchestrator/iteration-studio) — AI 帮你写主代理 / 子代理 system prompt（强烈推荐）
- [笔记子系统](/zh-CN/features/orchestrator/notes) — `notes_pickup_scout` 读取、`notes_curator` 写入的开/关状态线索仓库
- [Loop 模式](/zh-CN/features/orchestrator/loop) — 单 Agent 跑工具循环、产出 capsule
- [Spec 模式](/zh-CN/features/orchestrator/spec) — 默认 DAG，多 Agent 各 stage 产出 capsule
- [Agenda 模式](/zh-CN/features/orchestrator/agenda) — Planner 动态调度 Worker，产出 capsule
- [自定义工具](/zh-CN/features/orchestrator/custom-tools) — 用扩展、SillyTavern 桥接或手写代码给主代理和子代理加新工具

