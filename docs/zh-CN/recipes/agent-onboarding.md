# 多Agent上手：预设、记忆图、网络搜索

::: tip 这篇文档解决什么问题
Luker 的[多 Agent 编排](/zh-CN/features/orchestrator/)、[记忆图](/zh-CN/features/memory-graph)、[搜索插件](/zh-CN/features/search-tools)三项功能各自独立可用，但要让它们协同形成一套完整流程——由 Agent 团队抽取记忆、检索同人设定、构思剧情走向、起草正文——需要按顺序完成几项配置。

这篇从一份空白配置出发，逐步引导你完成预设、Director、记忆与搜索的配置，不假设你已经看过上述三篇深入文档。完成后你将获得一份可用的默认配置，之后随时可以在迭代工作台里继续调整。
:::

## 你会得到什么

完成本文配置后，在主对话发送一条消息，**主 LLM 不会立刻开始写作**——Agent 团队会先执行一轮编排：

- **`memory_scout`** 扫描记忆图，检索与当前剧情相关的角色 / 事件 / 地点
- **`canon_scout`**（必要时）联网检索当前题材的同人设定
- **`plot_brainstormer`** 从多个不同角度并行起草剧情结构草图，由主 Agent 从中选择
- **主 Agent** 根据前序 Agent 的产出直接完成正文写作
- **`memory_curator`** 在起草完成后将本回合新出现的事实写回记忆图

记忆图的**自动抽取 / 自动压缩**完全交由 Agent 处理，搜索引擎默认使用 DuckDuckGo——无需申请 API Key，无需配置 embedding，也不需要额外的 LLM 路由。

## 整体分工结构

```d2
direction: down

start: "你发一条消息" { shape: oval }

orch: "Director 主 Agent 接管" {
  style.fill: "#e1f5ff"
  scouts: "起草前侦察\nmemory_scout · chat_scout ·\nlorebook_scout · canon_scout(必要时联网)"
  brain: "中段头脑风暴\nplot_brainstormer\n按多角度并行出剧情草图"
  draft: "主 Agent 起草正文"
  curate: "起草后清理\nmemory_curator 把新事实写回记忆图"
}

end: "正文直接显示在聊天里\n(主 LLM 本回合不参与)" { shape: oval }

start -> orch.scouts -> orch.brain -> orch.draft -> orch.curate -> end
```

记忆图自身的「自动抽取 / 自动压缩」不再触发——Agent 已经在执行同样的工作。搜索功能启用后，`canon_scout` 才能执行联网检索，否则它返回零结果。

## 你需要先有什么

- 可正常运行的 Luker 实例，主对话能够正常生成回复
- 一份可用的 [RP 预设](/zh-CN/basics/presets)，最好已经配置好文风、越狱、NSFW 指导

## Step 1 — 选择起始预设

任何日常使用的 RP 预设均可。本步骤仅确认你有一份可用的写作预设作为起点——下一步将在此基础上派生 Director 所需的两份预设。

## Step 2 — 配置预设助手，派生 Director 要用的两份预设

Luker 的插件调用 LLM 大致分**两类**，需要的预设形态完全不同：一类是**插件产出 RP 内容**的（比如 Director 的 Agent 团队起草正文、评审子 Agent 复审等），需要带越狱 / 文风 / 反八股的完整 RP 预设；另一类是**插件的迭代 AI**（预设助手、记忆图 Schema 工作台、CardApp Studio、Director 的迭代工作台等），它们通过工具调用修改配置或抽取结构化数据，不写故事——任何混入的 RP 指令都会干扰模型执行插件指令，所以这些位置需要一份**只保留越狱**的精简预设。

Director 这条流程同时涉及这两类：

| 路径 | 给谁用 | 预设形态 |
|---|---|---|
| **Agent 路径** —— 主 Agent + 子 Agent 起草正文 | 实际负责撰写内容的 Agent，产出直接进入聊天界面 | 一份调好可用于 tool calling 的 RP 预设：保留越狱 / 文风 / 反八股，移除与编排器冲突的占位符和硬格式约束 |
| **迭代工作台路径** —— 你与它对话调整编排时，工作台 AI 自身使用 | 一个通过工具修改 JSON 配置的编辑器，完全不写正文 | 一份**只保留越狱**的精简预设——没有文风指导、没有 NSFW 写作规则、没有任何叙事元指令 |

::: tip 为什么不能两条路径共用一份预设
RP 预设默认假设「主 LLM 独立完成整个回复」，将其放入 Agent 工具循环后会出现以下问题：

- 与 Agent 的 system prompt 争夺注意力
- 把「必须输出 schema」「强制思维链」这类格式约束强加进起草环节，破坏 tool calling
- 让占位符（角色卡描述、人设、世界书条目）被编排器主路径**重复注入**

迭代工作台对此更为敏感——它完全不写故事，只通过工具调用修改 JSON 配置。任何混入的 RP 指令都会干扰模型执行插件指令。
:::

### 2a —— 配置预设助手本身

下一小节将使用预设助手派生 Agent 预设，但**它本身也是 LLM 驱动的工具**——需要先为它配置专用的迭代 AI 预设与 API 配置才能打开。

打开扩展抽屉（与编排器、记忆、搜索工具位于同一抽屉），找到**聊天补全预设助手**面板，配置以下两项：

- **迭代 AI 的提示词预设** —— 点击该项旁边的 **?** 按钮
- **迭代 AI 的 API 预设** —— 选择任意一个可正常工作的连接配置

![预设助手设置面板：迭代 AI 提示词预设（带 ? 按钮）+ 迭代 AI API 预设](/images/recipes/agent-onboarding/step-02a-preset-help-button.png)

**?** 按钮会打开一个说明弹窗，底部有一个**导入 plugin-only 预设**按钮——点击即可导入 Luker 内置的干净预设并自动选中。

![? 按钮弹窗：解释该位置需要挂什么预设，底部可导入 plugin-only](/images/recipes/agent-onboarding/step-02a-help-popup.png)

Luker 内置的其他迭代 AI 入口（Director 的迭代工作台、记忆图 Schema 工作台、CardApp Studio 等）旁边都有同一个 **?** 按钮——导入操作完全一致。

### 2b —— 用预设助手派生 **Agent 路径** 的预设

预设助手配置完成后，在同一个面板里点击**打开助手**。在弹出的会话里，将工具栏顶部的**编辑模式**切换为「**编排器适配**」，然后输入以下指令：

> 帮我把这个预设改成 Agent 专用预设

![编排器适配模式下的预设助手](/images/recipes/agent-onboarding/step-02-preset-assistant.png)

它默认会**派生一份新预设**（原名加 `-orchestrator` 后缀）——原预设保持不动。它会自动执行以下操作：

- 关闭会与编排器主路径**重复注入**的占位符：角色卡描述 / 人设 / 示例对话 / 显式世界书拼接
- 把会干扰 tool calling 的强格式约束（强制 schema、固定思维链头）从硬要求改写成弱引导
- 将仅在最终成稿中生效的指令（summary、风格收束等）条件化到「最终提交消息」阶段
- **保留**聊天历史、文风指令、越狱 / 反八股指令——主 Agent 起草与评审子 Agent 均会读取

逐条审阅其 diff 并确认通过即可。

::: tip 可在同一会话中继续改造预设
「编排器适配」只是助手三种**编辑模式**之一。将工具栏的**编辑模式**切回默认的「**通用编辑**」并新建会话，同一个助手即成为通用预设编辑器，例如可以让它「添加一个反八股指导并补充反面示例」「把文风指导从浓墨重彩改为克制细腻」「合并几条意思重复的规则」。详见[预设助手](/zh-CN/features/preset-assistant)。

「编排器适配」过程还会**主动扫描预设中可复用的文风 / 格式 / 写作纪律规则**，作为候选提案抽取为 Skills（原文照搬、绑定当前预设作用域、在原位置补充一行指针）。每条提案均可独立审阅——批准、拒绝或全部忽略，其余适配内容仍会正常生效。详见[把预设里的文风 / 输出格式抽成 Skills](/zh-CN/features/preset-assistant#把预设里的文风-输出格式抽成-skills-agent-编排预设模式)（单次小幅修改不会触发扫描）。
:::

## Step 3 — 切换到 Director 模式并配置两份预设

打开扩展抽屉的**多智能体编排**面板：

1. **执行模式** 切换为 **导演模式（Director）**
2. **API 预设（Connection profile）** + **提示词预设** 选择 Step 2b 派生的 `-orchestrator` 预设
3. 找到 **AI 迭代工作台配置** 区域，将**迭代 AI 的 API 预设** + **迭代 AI 的提示词预设**设置为 Step 2a 导入的 **plugin-only** 预设

## Step 4 — 将记忆图的抽取与召回交给 Agent

打开扩展抽屉的**记忆**面板：

- **启用** ✓ 保持开启
- **自动抽取** ✗ 关闭（交给 Agent 团队里负责整理记忆的子 Agent）
- **自动压缩** ✗ 关闭（Agent 收尾时一并处理）
- **启用记忆召回注入** ✗ 关闭（Agent 团队会在起草前自行执行一轮召回，保留内置注入只会**重复召回**并污染主 Agent 上下文）

![记忆面板：抽取、压缩、召回都交给 Agent](/images/recipes/agent-onboarding/step-04-memory-toggles.png)

::: info 想完全使用「记忆图内置的抽取、召回和压缩」
默认 Director 配置将抽取 / 召回 / 压缩纳入自身职责。如果你更信任记忆图内置的链路（已经配置好多模型路由、Hybrid + Rerank 等），则：

1. 将**自动抽取**、**自动压缩**、**启用记忆召回注入**三项重新启用
2. 在 [Step 6 的 AI 迭代工作台](#step-6) 里告诉工作台 AI：「我不想让 Agent 管理记忆，自己用内置的记忆图就够了」
3. 工作台 AI 会通过工具调用修改你的编排配置，逐条审阅后保存
:::

## Step 5 — 选一个搜索引擎

打开扩展抽屉的**搜索工具**面板，**搜索提供方**默认是 `DuckDuckGo（无需登录）`——保持默认即可。如需更精细的检索，可切换为 `SearXNG（自定义实例）`（填写自托管的 URL）或 `Brave Search（API Key）`。

![搜索引擎选择](/images/recipes/agent-onboarding/step-05-search-provider.png)

::: info 顶部两个开关与本流程的关系
**暴露工具给主模型** 和 **请求前运行搜索 Agent** 是搜索插件**相互独立**的两种工作模式，与 Director 无关——本流程通过 Director 的搜索子 Agent 执行搜索，这两个开关都**无需启用**。

如果不使用 Director 也需要搜索能力，请参阅[搜索插件](/zh-CN/features/search-tools)的「两种工作模式」。
:::

## Step 6 — 想修改配置？打开迭代工作台 {#step-6}

切换到 Director 后，在多智能体编排面板下方点击 **打开 AI 迭代工作台**——这是后续所有自定义的入口。

![AI 迭代工作台 — Director](/images/recipes/agent-onboarding/step-06-iter-studio-director.png)

工作台编辑的配置范围取决于打开它的时机：

- **当前没在任何角色卡聊天里** → 工作台编辑的是**全局**默认配置，所有未做覆写的卡都会继承该配置
- **当前在一张角色卡聊天里** → 工作台编辑的是**这张卡的覆写**，仅对该卡生效，并随卡导出 / 导入

::: tip 在角色卡上调出的优秀编排可以手动晋升为全局
如果为某张卡迭代出一套特别合用的 Director 配置，可以**手动晋升为全局**：在编排器面板导出该卡的配置，清空当前聊天回到无卡状态，再将这份配置导入全局。Schema 同理。
:::

### 全局作用域：可使用的指令

- 「我不想让 Agent 管理记忆，请去掉负责抽取和召回的 Agent」
- 「我不想让 Agent 联网搜索同人设定，请去掉负责搜索的 Agent」
- 「读取世界书里的图像生成指导，加一个子 Agent，在正文起草完成后构思插画的插入位置和提示词」
- 「读取世界书里的变量更新指导，加一个子 Agent，在正文起草完成后构思变量如何更新」

### 角色卡作用域：可使用的指令

- 「结合这张卡的世界观和当前剧情，给主 Agent 加一段专门的写作纪律」
- 「这张卡有自定义的体力 / 心情变量，负责整理记忆的子 Agent 抽取时优先填这几个字段」
- 任何与当前角色卡题材强相关、不适合放入全局配置的指令

工作台会逐条展示 diff，审阅并保存即可。如果结果与预期不符，可随时重置回默认 Director 配置。

## Step 7（可选）— 让 AI 迭代 Schema

记忆图的 Schema 也能被 AI 迭代。打开**记忆**面板里的 **AI 迭代 Schema**，跳转到 **记忆图 Schema 工作台**。

![记忆图 Schema 工作台](/images/recipes/agent-onboarding/step-07-schema-studio.png)

与编排配置一样，Schema 也区分全局与角色卡作用域——卡上保存的 Schema 会随卡导出。可以在工作台里针对题材进行定制，例如：

- 修仙题材：给角色加「修为境界」「灵脉」字段
- 政治题材：新增「派系」节点类型，记录派系关系和敌对图
- 生存题材：新增「物品」节点，追踪每一件道具的耐久、状态

::: tip 不要忘记为记忆图配置迭代 AI 预设
记忆图面板里的 **Schema 迭代提示词（Schema 编辑 AI）** 一栏属于 Step 2a 提到的「迭代 AI 路径」——其预设选择器旁边也有 **?** 按钮，点击后选择**导入 plugin-only 预设**即可（如果已在 Step 2a 导入过，直接在下拉中选择即可）。
:::

## 实际运行

返回主对话发送一条消息，展开思考块即可看到 Agent 团队的实时运行过程：

![Director 一回合内 Agent 团队的产出](/images/orchestrator/director-takeover/director-real-final-body.png)

- **起草前侦察**：各自 5 条 `Item / Source / Why`，列出与当前剧情相关的角色、事件、世界书条目
- **中段头脑风暴**：从多个角度并行起草剧情结构草图，供主 Agent 选择
- **起草后评审**：子 Agent 对主 Agent 的草稿提出评审意见，由主 Agent 决定采纳哪些修改
- **收尾整理**：把这一回合新出现的事实写回记忆图

如需查看更详细的内容——每个 Agent 的具体模型思考、每次工具调用的请求与响应——可在聊天区旁点击 **显示运行面板**（窄屏下为底部抽屉），展开任意一轮即可。

如果结果不满意，该思考块即 Agent 全程的执行记录——可据此定位问题所在，然后回到 [AI 迭代工作台](/zh-CN/features/orchestrator/iteration-studio) 用自然语言描述期望的修改。

## 下一步

- [多 Agent 编排概览](/zh-CN/features/orchestrator/) — 触发时机、capsule 注入、五种执行模式的全貌
- [Director 模式](/zh-CN/features/orchestrator/director) — 默认 12 个子 Agent 的职责分工
- [AI 迭代工作台](/zh-CN/features/orchestrator/iteration-studio) — 用自然语言让工作台 AI 修改配置
- [记忆图](/zh-CN/features/memory-graph) — 节点类型、召回算法、Schema 定制
- [搜索插件](/zh-CN/features/search-tools) — 三种搜索引擎的差异 + 不使用 Director 时的工具模式
- [预设助手](/zh-CN/features/preset-assistant) — 「编排器适配」之外的两种会话模式
