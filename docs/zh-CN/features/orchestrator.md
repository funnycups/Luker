# 多Agent编排

是不是有过这种情况:你精心设置了一个场景——剑拔弩张的对峙、微妙的政治谈判、慢热的浪漫——AI 的回复却跳过了你刚铺垫的节奏、忘了两段以前确立的世界规则、突然出戏跳出来给你做总结、或者把不该这一回合解决的伏笔仓促收尾了。这不是模型笨,是它一次只能想一件事,而你让它在一次回复里同时干太多了:守人设、调上下文、守世界观、规划下一步、*还要*把文笔写好。

编排器解决这件事的方法是——在主模型动笔之前,先派一支小队进去。一个 Agent 把最近聊天里的关键状态抽出来。一个查当前激活了哪些世界规则。一个起草这一回合该推进什么。一个审查它们的活儿。最后一个 Agent 把全队的成果打包成一份精简的「作业说明」。等到主模型开始写回复,它已经拿到了这份说明(并且只是这份),所以可以把它的预算都花在文笔上,而不是繁琐的核对工作。

你不需要自己设计这一切。编排器自带一套能跑的默认工作流,**AI 迭代工作台** 让你用一句话描述需求,然后亲眼看着 AI diff-by-diff 把工作流给你搭出来。从打开到能跑,五分钟。下面这一节带你走一遍。

::: info 它什么时候触发?
编排器在五种生成类型上触发:`normal`(普通生成)、`continue`(继续)、`regenerate`(重新生成)、`swipe`(滑动切换)和 `impersonate`(扮演)。它在世界书解析**之后**、主模型回复**之前**运行。运行轨迹只保存在内存中,切换聊天时会清空。
:::

## 5 分钟跑起来

这一节用迭代工作台走通,因为它的 diff-by-diff 操作能让你看见 AI 在干什么——快速生成更快,但是黑盒。快速生成后面会单独讲。

### Step 0 — 你需要先有什么

- 你的主对话已经能正常用 Chat Completion API 出回复
- 当前对话至少有 3 轮以上聊天记录(没有内容,工作流没什么可规划的)

### Step 1 — 启用编排器

打开顶栏的扩展抽屉,找到 **多智能体编排** 那一节。把 **启用** 开关打开。

![编排器开关与预设](/images/orchestrator/orch-toggle.png)

### Step 2 — 给各 Agent 选模型

在同一面板里继续往下看,找到 **LLM 节点 API 预设** 和 **AI 生成 API 预设**。这两个字段告诉编排器各 Agent 用哪个 API、哪个 Chat Completion 预设。

::: tip 这里能省钱
编排器一次跑会调 5–10 次 LLM(每个节点一次)。如果主对话用的是 Claude Opus 这种贵的,这里挑一个便宜模型——Haiku、Gemini Flash 之类——能省 70% 以上成本。如果需要更高质量,可以给不同节点配不同模型(每个节点都能单独覆写 API/预设)。
:::

### Step 3 — 打开 AI 迭代工作台

往下滚到操作按钮区,点 **打开 AI 迭代工作台**。

![快速生成与迭代工作台按钮](/images/orchestrator/orch-quickbuild-button.png)

会弹出一个面板。左边是你和工作台 AI 的对话,右边是当前编排的状态。

![迭代工作台主视图](/images/orchestrator/orch-iteration-studio.png)

### Step 4 — 描述你想要什么

在输入框里写一句话,描述你希望编排做什么。越具体越好。

> 例:*「我希望 AI 在每次回复前先回顾近期重要事件、保持人设一致性,并且不要轻易破规出戏。」*

![输入框带示例](/images/orchestrator/orch-iter-input.png)

点 **发送给 AI**。

### Step 5 — 看 AI 干活

AI 回一段简短计划 + 一份 diff,展示它打算改什么。每条改动是绿色加号(新增)/ 红色减号(删除)/ 黄色(修改)。你可以逐条 批准 / 拒绝,或者放手让它继续——工作台会自动一轮接一轮推进直到稳定,每轮都有 diff 可看。

![待审批 diff](/images/orchestrator/orch-iter-diff-inline.png)

哪条改动看不懂?点旁边的放大镜,左右对比看清楚。

![Diff side-by-side 详情](/images/orchestrator/orch-iter-diff-side.png)

### Step 6 — 应用

AI 说没什么再改的了之后,点 **应用到全局**(到处都用)或 **应用到角色卡**(只对这张卡)。

### Step 7 — 看效果(关键)

回主对话发一条消息。主模型回复出来之前,编排器会先在后台跑一遍工作流。回复完后,在编排器面板里点 **查看运行态轨迹**。

![运行态轨迹总览](/images/orchestrator/orch-runtime-trace.png)

每个节点卡显示它产出了什么。第一阶段的 distiller 把最近聊天提炼成一段紧凑的状态:

![Distiller 节点详情](/images/orchestrator/orch-runtime-trace-distiller.png)

**这段文字 *不是* 注入主模型的内容。** 它是给下一阶段当输入用的。真正变成「作业说明」注入主模型的,是**最后一阶段**节点的输出:

![最后阶段输出](/images/orchestrator/orch-runtime-trace-laststage.png)

最后一阶段的输出——只有最后一阶段——会被打包成一段文字,插到主模型的上下文里。前面所有阶段都是为它做准备。

这就是「AI 想清楚再回复」的物理含义。如果回复不对,你可以打开轨迹看清楚是哪一步出了问题,然后把这个观察反馈给迭代工作台。

## 迭代工作台详解

一旦你开始调整工作流,迭代工作台是你最常用的工具。它也是最适合教学的功能——每一步都看得见。

### 它能干什么

- **多轮对话。** 一句反馈一轮,AI 提一个聚焦的改动方案,你审。
- **逐条审批。** 每条 diff 单独 批准 / 拒绝,可以只接受一半。
- **模拟测试。** 用当前真实的聊天上下文跑一遍工作流——就像你刚发了条新消息一样,世界书也会照常被激活——但生成结果只展示给你看,*不影响*真实聊天。比如问「我加的 Constraint Agent 真的能挡住 OOC 吗?」,工作台跑一遍流程,把每个节点输出都摆给你看。
- **会话保存。** 每个作用域最多 24 个 session,不同卡 / 不同实验各自一份。
- **回滚。** 已经 Apply 的也能撤。
- **可折叠思考。** 推理模型的 `<thought>` 标签默认折叠;超过 1200 字符的消息也自动折叠。

### 一个真实的迭代节奏

> **第 1 轮。** 你:*「AI 不要轻易出戏。」*
> AI:「在 Stage 2 加一个 Constraint Agent,加反破规检查;启用 Anti-Data Guard。」 Diff:1 个新节点 + 1 个开关。你 批准。
>
> **第 2 轮。** 你:*「让它读知识书,这样它知道世界规则。」*
> AI:「在 Stage 1 加了一个 `lorebook_reader` 节点,这样 Constraint Agent 就能看到激活的世界规则。」 Diff:1 个新节点。批准。
>
> **第 3 轮。** 你:*「模拟一个明显出戏的输入,看 Constraint Agent 真能拦住吗?」*
> AI:切到 模拟模式,用一段假的破规用户消息跑一遍工作流,把 Constraint Agent 的判定结果展示给你。

![Simulation 输出](/images/orchestrator/orch-iter-simulation.png)

> **第 4 轮。** 稳定。点 **应用**。

每一步都是可见的、可中止的、可回退的。这是关键。

### 会话管理

不同卡、不同实验,各自一个 session。

![Session 列表](/images/orchestrator/orch-iter-sessions.png)

会话持久化,刷新后还在,可以是全局作用域也可以绑到某张卡。

### 边栏 — 快速生成是什么

快速生成是迭代工作台的一键模式。在编排编辑器顶部 **AI 生成目标** 文本框里输入需求,点 **AI 快速生成**:

![快速生成输入区](/images/orchestrator/orch-quickbuild-input.png)

一次 LLM 调用之后,你直接拿到完整工作流:

![快速生成结果](/images/orchestrator/orch-quickbuild-result.png)

适合两种场景:

1. 你已经用迭代工作台调过类似配置很多次,这次只想要个能跑的模板,不想再过流程
2. 你完全不在乎 AI 怎么决定的,只要默认能用就行

其他场景下,**用迭代工作台更划算**。多花的 1–2 分钟换来一个你能看懂、能调整的工作流。

## 常见场景配方

| 我想要 | 这样做 |
|---|---|
| AI 回复前先想清楚情节再写 | 迭代工作台描述里加「分两阶段:先规划下一步,再写文」 |
| AI 不要轻易出戏 | 启用 Anti-Data Guard;迭代工作台描述里要求「加一个硬挡 meta 评论的 Constraint Agent」,参考上面「一个真实的迭代节奏」 |
| 同一个工作流跨卡通用 | 应用到全局,不要绑卡 |
| 不同卡用不同工作流 | 在角色卡选中状态打开迭代工作台,**应用到角色卡** |
| 太慢 / 太贵 | 见 [Step 2 省钱提示](#step-2-给各-agent-选模型);或把执行模式从 Spec 切到 单 Agent(只跑一个节点) |
| 想反复调试同一个工作流 | 迭代工作台的 session 会话——它会持久化 |
| 换电脑用 | 见下面「导入导出」 |
| 全部重置 | 编排编辑器有 **重置全局** 按钮 |

## 自定义工作流(手搓路线)

到这一节,Stage / Node / DAG 这些术语开始派上用场。简短定义:

- **Stage 阶段** — 工作流的横向切片。阶段间严格串行,Stage 2 必须等 Stage 1 跑完才能开始。
- **Node 节点** — 阶段内的执行单位。**一个节点 = 一次 LLM 调用 + 一段 prompt 模板。**
- **DAG** — 有向无环图。说人话就是「有先后顺序、不会绕回去的流程图」。

### 三种执行模式

| 模式 | 是什么 | 何时用 |
|---|---|---|
| **Spec**(默认) | 固定的 Stage → Node DAG。最灵活的静态工作流。 | 默认。你要一个可预期的管道。 |
| **单 Agent** | 只有一个节点的 Spec——跑一次 LLM,没有编排开销。 | 便宜快。不需要多 Agent 协作。 |
| **Agenda** | 一个 Planner Agent 通过工具调用动态调度其他 Agent。 | 最灵活。Planner 根据情况决定运行什么,像个 Agent loop。 |

可以从编辑器的 **复制 Spec Agents 到 Agenda** / **复制 Agenda Agents 到 Spec** 按钮在两种模式间转换(尽力而为)。转换不完美——Agenda 的动态调度不能完全映射到 Spec 的静态 DAG。

### Spec 工作流编辑器

从编排器面板打开:**打开编排编辑器**。

![Spec 编辑器](/images/orchestrator/orch-spec-editor.png)

左边面板是工作流(阶段及其节点)。右边面板是 Agent 预设库。每个节点引用一个预设,预设携带系统提示、用户提示模板、可选的 API/Chat Completion 预设覆写、执行标志。

每个阶段有一个执行方式:

- **串行** — 阶段内的节点一个接一个跑
- **并行** — 节点用 `Promise.all` 同时跑

每个节点要么是 **worker**(干活),要么是 **review**(审查上一阶段的输出)。

#### 模板变量

用户提示模板支持以下占位符:

| 变量 | 含义 |
|---|---|
| <span v-pre>`{{recent_chat}}`</span> | 最近的聊天消息 |
| <span v-pre>`{{last_user}}`</span> | 最后一条用户消息 |
| <span v-pre>`{{previous_outputs}}`</span> | 前序阶段的输出 |
| <span v-pre>`{{distiller}}`</span> | 蒸馏器节点的输出 |
| <span v-pre>`{{previous_orchestration}}`</span> | 上一回合的编排结果。**运行时自动注入,模板里一般不用写。** |

### 审查节点

审查节点检查上一个工作阶段的输出,通过两个专用工具调用与运行时交互:

| 工具 | 作用 |
|---|---|
| `luker_orch_review_approve` | 工作合格,推进到下一阶段 |
| `luker_orch_request_rerun` | 一个或多个节点需要重做,附带修改建议 |

约束:

- 审查节点只能审 **直接相邻的前一个工作阶段** 的节点
- 重跑作用于具体节点 ID,不是整个阶段
- 重跑次数受 **审查重跑最大轮数** 控制(默认 2,最大 20)。设为 0 时,审查节点只能「通过或失败」,不能重跑
- 重跑后审查节点重新跑,形成「执行 → 审查 → 重跑 → 再审查」的循环,直到通过或达到上限
- 审查节点必须输出审查反馈

### Agenda 模式

Agenda 用一个 Planner Agent 替换静态 DAG,Planner 通过工具调用其他 Agent。

![Agenda 编辑器](/images/orchestrator/orch-agenda-editor.png)

Planner 维护 todo 列表,读每个 Agent 的输出,决定下一步派谁去。三个运行时上限:

- **Planner 最大轮数** — Planner 调度的轮数上限
- **最大并发 Agent 数** — 同时跑的 Agent 数量上限
- **总执行次数上限** — 整次跑里所有 Agent 调用次数总和

Agenda 模式依赖 Luker 的 [Function Call Runtime](/improvements/function-call-runtime) 框架。

## 角色卡绑定

编排配置可以绑到角色卡。绑定后:

- 配置随卡导出。别人导入卡片自动获得推荐工作流
- 卡作者可以为自己的角色定制最优工作流
- 切换到这张卡自动应用其工作流
- 卡可以指定自己的执行模式(Spec/Single/Agenda)
- 卡覆写可以独立启用 / 禁用,不影响全局
- 「清除卡覆写」恢复到全局配置
- 你可以在卡绑定配置上层叠个人调整

## 导入导出

配置以 JSON 导出。

| 格式 | 标识 | 适用 |
|---|---|---|
| V1 | `luker_orchestrator_profile_v1` | Spec 模式 |
| V2 | `luker_orchestrator_profile_v2` | Agenda 模式 |

文件名形如 `luker-orchestrator-[agenda-][global|character-{name}].json`。导出器同时支持全局和角色卡作用域。

导入时,文件的模式(Spec/Agenda)必须和你当前执行模式一致。你选择应用到全局或某张特定的卡。

## 结果注入

编排器的最终输出(「capsule」)会被注入到主模型 prompt 里。配置:

| 设置 | 默认 | 说明 |
|---|---|---|
| 注入位置 | `atDepth` | capsule 在 prompt 里的位置 |
| 注入深度 | `0` | 在该位置的深度 |
| 注入角色 | `SYSTEM` | `SYSTEM` / `USER` / `ASSISTANT` 之一 |
| 自定义指令前缀 | (默认一句话) | 加在 capsule 文本前面 |

capsule 绑定到触发编排的用户消息楼层。同一楼层 swipe 时,系统会复用现有 capsule 而不是重跑。配置变更时,系统会重新应用最新结果。

## 配置参考

最常用的几项(Quick Start 已覆盖):

| 设置 | 默认 |
|---|---|
| 执行模式 | `spec` |
| 注入位置 | `atDepth` |
| 注入深度 | `0` |
| 注入角色 | `SYSTEM` |
| 节点迭代最大轮数 | — |
| 审查重跑最大轮数 | `2`(最大 20) |

<details>
<summary>完整配置参考</summary>

| 设置 | 说明 |
|---|---|
| 执行模式 | Spec / 单 Agent / Agenda |
| 注入位置 | capsule 在主 prompt 中的位置 |
| 注入深度 | 注入深度 |
| 注入角色 | `SYSTEM` / `USER` / `ASSISTANT` |
| 自定义指令前缀 | 加在 capsule 前的前缀文字 |
| Planner 最大轮数 | 仅 Agenda 模式 |
| 最大并发 Agent 数 | 仅 Agenda 模式 |
| 总执行次数上限 | 仅 Agenda 模式 |
| RPM 限制 | 并行节点的速率限制 |
| Agent 超时 | 单 Agent 超时秒数 |
| 工具调用重试次数 | 工具调用失败的重试次数 |
| 节点迭代最大轮数 | 单节点的迭代上限 |
| 审查重跑最大轮数 | 0 禁用审查驱动的重跑;最大 20 |
| 全局 API 预设 | 默认 API 连接预设 |
| 全局 Chat Completion 预设 | 默认 Chat Completion 预设 |
| 包含世界书 | 节点是否能看到世界书 |
| Anti-Data Guard | 默认 Spec 工作流里的一个内置节点,屏蔽数据化 / 报告腔的散文(诸如 观察 / 分析 / 评估 / 监测 / observation / analyze / metric / probability 这种把 RP 写成观察日志或参数表的词)。硬编码约 18 个词的词典。不想要的话直接把这个节点从工作流里删掉。 |
| `<thought>` 标签剥离 | 从 Agent 输出剥离思考标签 |
| 消息折叠阈值 | 1200 字符 / 18 行 |
| 节点 API 预设 | 节点级覆写;留空 = 全局 |
| 节点 Chat Completion 预设 | 节点级覆写;留空 = 全局 |

每个节点可以用不同的 API 和 Chat Completion 预设,所以你可以让蒸馏器走便宜模型、合成器走高质量模型。

</details>

## 事件 / 二开 API

<details>
<summary>给其他扩展和脚本</summary>

编排器在每次运行结果后会派发一个前端事件,其他代码可以消费编排结果而不必读 UI 内部状态。

- **事件名:** `luker.orchestrator.result`
- **通道:** `getContext().eventSource`
- **触发时机:** `completed` / `reused` / `cancelled` / `failed` 时

事件载荷字段:

| 字段 | 类型 | 说明 |
|---|---|---|
| `module` | string | 始终为 `orchestrator` |
| `event` | string | 始终为 `luker.orchestrator.result` |
| `status` | string | `completed` / `reused` / `cancelled` / `failed` |
| `generationType` | string | 触发的生成类型 |
| `chatKey` | string | 当前聊天 key |
| `at` | string | ISO 时间戳 |
| `anchorPlayableFloor` | number | 绑定的用户回合楼层(不可用时为 0) |
| `anchorHash` | string | 用于校验的 anchor hash |
| `capsuleText` | string | 最终注入的引导文本 |
| `stageOutputs` | array | 紧凑的阶段输出(`completed` / `reused` 时存在) |
| `reviewRerunCount` | number | 审查重跑次数 |
| `reason` | string | 取消 / 失败的机器可读原因 |
| `note` | string | 人类可读说明 |
| `error` | string | `failed` 时的错误信息 |

订阅示例:

```js
const context = getContext();
context.eventSource.on('luker.orchestrator.result', (evt) => {
    if (evt.status === 'completed' || evt.status === 'reused') {
        console.log('Orchestrator capsule:', evt.capsuleText);
    }
});
```

</details>

## 相关页面

- [Function Call Runtime](/improvements/function-call-runtime) — Agenda 模式的 Planner 依赖此框架
- [角色卡编辑器](/features/card-editor) — 与迭代工作台共用 diff 引擎
- [卡内绑定预设与人格](/improvements/card-bound-presets) — 编排配置如何随角色卡走
