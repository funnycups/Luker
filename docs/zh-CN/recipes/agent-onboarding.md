# 多Agent上手：预设、记忆图、网络搜索

::: tip 这篇文档解决什么问题
Luker 的[多 Agent 编排](/zh-CN/features/orchestrator/)、[记忆图](/zh-CN/features/memory-graph)、[搜索插件](/zh-CN/features/search-tools)三块功能各自独立可用，但要让它们协同形成一套完整流程——由 Agent 团队抽取记忆、检索同人设定、构思剧情走向、起草正文——需要按顺序完成几项配置。

这篇从一份空白配置出发，一步步引导你配完预设、Director、记忆与搜索，不假设你看过上面三篇深入文档。完成后你会得到一份开箱即用的默认配置，之后随时可以在迭代工作台里让 AI 帮你继续调整。
:::

## 你会得到什么

跑完这篇后，主对话发一条消息，**主 LLM 不会立刻动笔**——Agent 团队先进去做一轮：

- **`memory_scout`** 翻一遍记忆图，捞出和当前剧情有关的角色 / 事件 / 地点
- **`canon_scout`**（必要时）联网检索当前题材的同人设定
- **`plot_brainstormer`** 按几个不同角度并行出剧情结构草图，主 Agent 从中挑
- **主 Agent** 拿着前面几位的产出，直接把正文写完交给你
- **`memory_curator`** 起草完之后把这一回合新出现的事实写回记忆图

记忆图的**自动抽取 / 自动压缩**完全交给 Agent，搜索引擎默认走 DuckDuckGo——不用申请 API Key，不用配 embedding，不需要额外的 LLM 路由。

## 整体分工长这样

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

记忆图自己的「自动抽取 / 自动压缩」不再触发——同一件事 Agent 已经在做了。搜索一旦被启用，`canon_scout` 才有能力联网，否则它返回零结果。

## 你需要先有什么

- 已经能跑的 Luker 实例，主对话能正常发回复
- 一份能用的 [RP 预设](/zh-CN/basics/presets)，最好已经调教过文风、越狱、NSFW 指导

## Step 1 — 挑一份起点预设

任何你日常用的 RP 预设都行。这一步只是确认你有一份调教好的写作预设作为起点——下一步从它出发，准备 Director 要用的两份预设。

## Step 2 — 配置预设助手，派生 Director 要用的两份预设

Luker 的插件里调 LLM 大致分**两类**，要用的预设形态完全不同：一类是**插件产出 RP 内容**的（比如 Director 的 Agent 团队起草正文、评审子 Agent 复审等），需要带越狱 / 文风 / 反八股的 RP 预设；另一类是**插件的迭代 AI**（预设助手、记忆图 Schema 工作台、CardApp Studio、Director 的迭代工作台等），它们用工具调用改配置或抽结构，不写故事——任何 RP 指令漏进去都会干扰模型执行插件指令，所以要挂一份**只保留越狱**的精简预设。

Director 这条流程同时涉及这两类：

| 路径 | 给谁用 | 预设形态 |
|---|---|---|
| **Agent 路径** —— 主 Agent + 子 Agent 起草正文 | 真正在写内容的那批，产出物落进聊天框 | 一份调好可以走 tool calling 的 RP 预设：保留越狱 / 文风 / 反八股，关掉跟编排器抢话的占位符和硬格式 |
| **迭代工作台路径** —— 你跟它对话调编排时，工作台 AI 自己用 | 一个用工具改 JSON 配置的编辑器，完全不写正文 | 一份**只保留越狱**的精简预设——没有文风指导、没有 NSFW 写作规则、没有任何叙事元指令 |

::: tip 为什么不一份预设两边都用
RP 预设默认假设「主 LLM 一个人独自写完整个回复」，塞进 Agent 工具循环会：

- 跟 Agent 的 system prompt 抢话语权
- 把「必须输出 schema」「强制思维链」这类格式约束塞进起草环节，顶坏 tool calling
- 让占位符（角色卡描述、人设、世界书条目）被编排器主路径**重复注入**

迭代工作台更敏感——它根本不写故事，只通过工具调用改一份 JSON 配置。任何 RP 指令漏进去，都会影响模型执行插件指令。
:::

### 2a —— 配置预设助手本身

下一小节要用预设助手派生 Agent 预设，但**它本身也是一个 LLM 驱动的工具**——得先给它挂上自己用的迭代 AI 预设和 API 配置才能打开。

打开扩展抽屉（跟编排器、记忆、搜索工具同一栏），找到**聊天补全预设助手**面板，把这两栏配好：

- **迭代 AI 的提示词预设（参数+提示词）** —— 点这栏旁边的 **?** 按钮
- **迭代 AI 的 API 预设（连接配置）** —— 选任意一个能跑通的连接配置

![预设助手设置面板：迭代 AI 提示词预设（带 ? 按钮）+ 迭代 AI API 预设](/images/recipes/agent-onboarding/step-02a-preset-help-button.png)

? 按钮会弹出一个说明窗口，底部带一个**导入 plugin-only 预设**按钮——点一下就把 Luker 内置的纯净预设导入并自动选中。

![? 按钮弹窗：解释这一栏要挂什么预设，底部一键导入 plugin-only](/images/recipes/agent-onboarding/step-02a-help-popup.png)

Luker 内置的其他迭代 AI 入口（Director 的迭代工作台、记忆图 Schema 工作台、CardApp Studio 等）旁边都有同一个 **?** 按钮——一键导入操作完全一致。

### 2b —— 用预设助手派生 **Agent 路径** 的预设

预设助手挂好之后，在同一个面板里点**打开助手**。在弹出的会话里，把工具栏顶部的**编辑模式**切到「**编排器适配**」，然后跟它说：

> 帮我把这个预设改成 Agent 专用预设

![编排器适配模式下的预设助手](/images/recipes/agent-onboarding/step-02-preset-assistant.png)

它默认会**派生一份新预设**（原名加 `-orchestrator` 后缀）——原预设保持不动。它会自动：

- 关掉跟编排器主路径**重复注入**的占位符：角色卡描述 / 人设 / 示例对话 / 显式世界书拼接
- 把会干扰 tool calling 的强格式约束（强制 schema、固定思维链头）从硬要求改写成弱引导
- 把仅出现在最终成稿里的指令（summary、风格收束之类）条件化到「最终提交消息」阶段
- **保留**聊天历史、文风指令、越狱 / 反八股指令——主 Agent 起草和评审子 Agent 都会读

跟着它的草稿 diff 看一遍，逐条点同意即可。

::: tip 顺手让它再帮你改造预设
「编排器适配」只是助手三种**编辑模式**里的一种。把工具栏的**编辑模式**切回默认的「**通用编辑**」开一个新会话，同一个助手就是一个通用预设编辑器——可以让它「添加一个反八股指导并补充反面示例」「把文风指导从浓墨重彩改成克制细腻」「合并几条意思重复的规则」之类。详见[预设助手](/zh-CN/features/preset-assistant)。

「编排器适配」这趟还会**主动扫一遍预设里那些可复用的文风 / 格式 / 写作纪律规则**，按候选给你提案抽成 Skills（原文照搬、绑当前预设作用域、原位置补一行指针）。每条独立可审 —— 批、拒、或者全拒都可以，其余适配照常生效。详见[把预设里的文风 / 输出格式抽成 Skills](/zh-CN/features/preset-assistant#把预设里的文风-输出格式抽成-skills-agent-编排预设模式)（小改一句话不会触发扫一遍）。
:::

## Step 3 — 切到 Director 模式，挂上两份预设

打开扩展抽屉的**多智能体编排**面板：

1. **执行模式** 切到 **Director（多代理）**
2. **API 预设** + **提示词预设** 选 Step 2b 派生的那份 `-orchestrator` 预设
3. 找到 **AI 迭代工作台** 区域，把它的 **API 预设** + **提示词预设** 选 Step 2a 导入的 **plugin-only** 预设

## Step 4 — 把记忆图的抽取与召回交给 Agent

打开扩展抽屉的**记忆**面板：

- **启用** ✓ 保持开启
- **自动抽取** ✗ 关掉（交给 Agent 团队里负责整理记忆的子 Agent）
- **自动压缩** ✗ 关掉（同上，Agent 收尾时一并处理）
- **启用记忆召回注入** ✗ 关掉（Agent 团队会在起草前自己跑一轮召回，留着内置注入只会**重复一份**，污染主 Agent 上下文）

![记忆面板：抽取、压缩、召回都交给 Agent](/images/recipes/agent-onboarding/step-04-memory-toggles.png)

::: info 想完全走「记忆图内置的抽取、召回和压缩」
默认 Director 配置把抽取 / 召回 / 压缩都揽过来了。如果你更信任记忆图内置的链路（已经调好了多模型路由、Hybrid + Rerank 之类），那么：

1. 把**自动抽取**、**自动压缩**、**启用记忆召回注入**三项重新打开
2. 在 [Step 6 的 AI 迭代工作台](#step-6) 里告诉工作台 AI：「我不想让 Agent 管理记忆，自己用内置的记忆图就够了」
3. 工作台 AI 会通过工具调用修改你的编排配置，逐条审完点保存
:::

## Step 5 — 选一个搜索引擎

打开扩展抽屉的**搜索工具**面板，**搜索提供方**默认是 `DuckDuckGo（无需登录）`——不动就行。需要更精细的可以切到 `SearXNG（自定义实例）`（填你自托管的 URL）或 `Brave Search（API Key）`。

![搜索引擎选择](/images/recipes/agent-onboarding/step-05-search-provider.png)

::: info 顶部两个开关跟这个流程的关系
**暴露工具给主模型** 和 **请求前运行搜索 Agent** 是搜索插件**独立**的两种工作模式，跟 Director 没关系——本流程靠 Director 里的搜索子 Agent 调用搜索，这两个开关都**不需要打开**。

如果你不用 Director 也想让搜索可用，再去看[搜索插件](/zh-CN/features/search-tools)的「两种工作模式」。
:::

## Step 6 — 想改点什么？去迭代工作台 {#step-6}

切到 Director 之后，在多智能体编排面板下方点 **打开 AI 迭代工作台**——这就是后续所有定制的入口。

![AI 迭代工作台 — Director](/images/recipes/agent-onboarding/step-06-iter-studio-director.png)

打开时机决定改的是哪一份配置：

- **当前没在任何角色卡聊天里** → 工作台改的是**全局**默认配置，所有未做覆写的卡都跟着走
- **当前在一张角色卡聊天里** → 工作台改的是**这张卡的覆写**，只对它生效，还会随卡导出 / 导入

::: tip 卡上调出来的好编排，可以手动晋升为全局
如果你给某张卡迭代出一套特别合用的 Director 配置，**完全可以把它复制成新的全局默认**——在编排器面板上导出这张卡的配置，清空当前聊天回到无卡状态，再把那份配置导入到全局即可。Schema 同理。
:::

### 全局作用域，你可以这么说

- 「我不想让 Agent 管理记忆，请去掉负责抽取和召回的 Agent」
- 「我不想让 Agent 联网搜索同人设定，请去掉负责搜索的 Agent」
- 「读取世界书里的图像生成指导，加一个子 Agent，在正文起草完成后构思插画的插入位置和提示词」
- 「读取世界书里的变量更新指导，加一个子 Agent，在正文起草完成后构思变量如何更新」

### 角色卡作用域，你可以这么说

- 「结合这张卡的世界观和当前剧情，给主 Agent 加一段专门的写作纪律」
- 「这张卡有自定义的体力 / 心情变量，负责整理记忆的子 Agent 抽取时优先填这几个字段」
- 任何跟当前角色卡题材强相关、不适合写进全局配置的指令

工作台会一步步出 diff，逐条审完点保存。改不顺手随时可以重置回默认 Director 配置。

## Step 7（可选）— 让 AI 帮你迭代 Schema

记忆图的 Schema 也能被 AI 迭代。打开**记忆**面板里的 **AI 迭代 Schema**，跳转到 **记忆图 Schema 工作台**。

![记忆图 Schema 工作台](/images/recipes/agent-onboarding/step-07-schema-studio.png)

跟编排配置一样，Schema 也区分全局和角色卡作用域——卡上保存的 Schema 会随卡导出。你可以在工作台里针对题材做定制，例如：

- 修仙题材：给角色加「修为境界」「灵脉」字段
- 政治题材：新增「派系」节点类型，记录派系关系和敌对图
- 生存题材：新增「物品」节点，追踪每一件道具的耐久、状态

::: tip 别忘了给记忆图配迭代 AI 预设
记忆图面板里的 **Schema 迭代提示词（schema-editor AI）** 那一栏走的就是 Step 2a 提到的「迭代 AI 路径」——它的预设选择器旁边也有 **?** 按钮，点开后选**导入 plugin-only 预设**即可（如果你在 Step 2a 已经导过了，这里直接在下拉里选即可）。
:::

## 开玩

回主对话发一条消息，展开思考块就能看到 Agent 团队在实时干活：

![Director 一回合内 Agent 团队的产出](/images/orchestrator/director-takeover/director-real-final-body.png)

- **起草前侦察**：各自 5 条 `Item / Source / Why`，把跟当前剧情相关的角色、事件、世界书条目摆出来
- **中段头脑风暴**：按几个不同角度并行出剧情结构草图供主 Agent 挑
- **起草后评审**：子 Agent 各自拍主 Agent 草稿，主 Agent 决定接受哪几条改写
- **收尾整理**：把这一回合新出现的事实写回记忆图

想看更细——每个 Agent 的具体模型思考、每次工具调用的请求和响应？打开聊天区旁的**运行面板**（窄屏下从底部抽屉拉起），展开任意一轮即可。

不满意？这个思考块就是 Agent 全程的运行记录——定位是哪一步出了问题，然后回 [AI 迭代工作台](/zh-CN/features/orchestrator/iteration-studio) 用自然语言描述你想怎么改。

## 下一步

- [多 Agent 编排概览](/zh-CN/features/orchestrator/) — 触发时机、capsule 注入、四种执行模式的全貌
- [Director 模式](/zh-CN/features/orchestrator/director) — 默认 12 个子 Agent 的职责分工
- [AI 迭代工作台](/zh-CN/features/orchestrator/iteration-studio) — 自然语言指挥工作台 AI 改配置
- [记忆图](/zh-CN/features/memory-graph) — 节点类型、召回算法、Schema 定制
- [搜索插件](/zh-CN/features/search-tools) — 三种搜索引擎的差异 + 不走 Director 时的工具模式
- [预设助手](/zh-CN/features/preset-assistant) — 「编排器适配」之外的两种会话模式
