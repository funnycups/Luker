# 多Agent编排

是不是有过这种情况:你精心设置了一个场景——剑拔弩张的对峙、微妙的政治谈判、慢热的浪漫——AI 的回复却跳过了你刚铺垫的节奏、忘了两段以前确立的世界规则、突然出戏跳出来给你做总结、或者把不该这一回合解决的伏笔仓促收尾了。这不是模型笨,是它一次只能想一件事,而你让它在一次回复里同时干太多了:守人设、调上下文、守世界观、规划下一步、*还要*把文笔写好。

编排器解决这件事的方法是——在主模型动笔之前,先派一支小队进去。一个 Agent 把最近聊天里的关键状态抽出来。一个查当前激活了哪些世界规则。一个起草这一回合该推进什么。一个审查它们的活儿。最后一个 Agent 把全队的成果打包成一份精简的「作业说明」。等到主模型开始写回复,它已经拿到了这份说明(并且只是这份),所以可以把它的预算都花在文笔上,而不是繁琐的核对工作。

**编排器自带一套能跑的默认 Spec 工作流——你不用先设计什么,启用就能用。** 后面想换玩法、想自己改,各执行模式都有独立编辑器。

::: info 它什么时候触发?
编排器在五种生成类型上触发:`normal`(普通生成)、`continue`(继续)、`regenerate`(重新生成)、`swipe`(滑动切换)和 `impersonate`(扮演)。它在世界书解析**之后**、主模型回复**之前**运行。运行轨迹只保存在内存中,切换聊天时会清空。
:::

## 5 分钟跑起来(用默认编排)

不用先选模式、不用先写工作流——默认 Spec 已经能跑。下面这一节带你把它启动起来,看清楚它到底替你干了什么。

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

### Step 3 — 直接发一条消息

回主对话发条消息——不用动其他设置。主模型回复之前,默认 Spec 工作流会自动在后台跑一遍。第一次跑会比平时慢一点(顺序调 5–10 个 Agent),后续就习惯了。

### Step 4 — 看它替你干了什么

回复出来后,在编排器面板里点 **查看运行态轨迹**。

![运行态轨迹总览](/images/orchestrator/orch-runtime-trace.png)

每个节点卡显示它产出了什么。第一阶段的 distiller 把最近聊天提炼成一段紧凑的状态:

![Distiller 节点详情](/images/orchestrator/orch-runtime-trace-distiller.png)

**这段文字 *不是* 注入主模型的内容。** 它是给下一阶段当输入用的。真正变成「作业说明」注入主模型的,是**最后一阶段**节点的输出:

![最后阶段输出](/images/orchestrator/orch-runtime-trace-laststage.png)

最后一阶段的输出——只有最后一阶段——会被打包成一段文字,插到主模型的上下文里。前面所有阶段都是为它做准备。

这就是「AI 想清楚再回复」的物理含义。如果回复不对,你可以打开轨迹看清楚是哪一步出了问题。

到这里你已经在用编排器了。下面三件事按需选:

- 默认 Spec 流程不够用,想自己 / 让 AI 帮你改 → [Spec 模式](/zh-CN/features/orchestrator/spec)
- 流程要根据情况动态变,不能写死 DAG → [Agenda 模式](/zh-CN/features/orchestrator/agenda)
- 想让一个 Agent 反复调工具(查记忆、查世界书...)直到它自己说"够了" → [Loop 模式](/zh-CN/features/orchestrator/loop)

::: tip 不管你选哪种模式,定制都从这里开始
**[AI 迭代工作台](/zh-CN/features/orchestrator/iteration-studio)** 是编排器的核心定制工具——一句话描述需求,AI 给方案,逐条审。Spec / Agenda / Loop 三种模式都共用这个工作台,**99% 的定制场景下都比手搓划算**。
:::

## 选你的执行模式

| 模式 | 是什么 | 何时用 | 详细文档 |
|---|---|---|---|
| **Spec**(默认) | 固定的 Stage → Node DAG | 默认。你要一个可预期的管道 | [Spec 模式](/zh-CN/features/orchestrator/spec) |
| **单 Agent** | 只有一个节点的 Spec | 便宜快。不需要多 Agent 协作 | [单 Agent 模式](/zh-CN/features/orchestrator/single) |
| **Agenda** | 一个 Planner Agent 通过工具调用动态调度其他 Agent | 流程要动态决定运行什么,像 Agent loop | [Agenda 模式](/zh-CN/features/orchestrator/agenda) |
| **Loop** | 单 Agent 在同一会话里循环调工具,自己决定何时 `finalize` | 速度与效果之间想要平衡;探索性研究、动态决策 | [Loop 模式](/zh-CN/features/orchestrator/loop) |

切换模式:扩展抽屉里 **执行模式** 下拉。Spec 与 Agenda 之间可以从编辑器里互转(尽力而为);Loop 模式结构差异较大,没有这种互转入口。

::: tip 想定制?优先用 AI 迭代工作台
切到任何模式后,**[AI 迭代工作台](/zh-CN/features/orchestrator/iteration-studio)** 都是优先选择。Spec / Agenda 给你 diff,Loop 直接 patch profile,流程一致。
:::

## 通用配置

无论选哪种模式,以下设定都共享。

### 结果注入

编排器的最终输出(「capsule」)会被注入到主模型 prompt 里。配置:

| 设置 | 默认 | 说明 |
|---|---|---|
| 注入位置 | `atDepth` | capsule 在 prompt 里的位置 |
| 注入深度 | `0` | 在该位置的深度 |
| 注入角色 | `SYSTEM` | `SYSTEM` / `USER` / `ASSISTANT` 之一 |
| 自定义指令前缀 | (默认一句话) | 加在 capsule 文本前面 |

capsule 绑定到触发编排的用户消息楼层。同一楼层 swipe 时,系统会复用现有 capsule 而不是重跑。配置变更时,系统会重新应用最新结果。

### 角色卡绑定

编排配置可以绑到角色卡。绑定后:

- 配置随卡导出。别人导入卡片自动获得推荐工作流
- 卡作者可以为自己的角色定制最优工作流
- 切换到这张卡自动应用其工作流
- 卡可以指定自己的执行模式(Spec / 单 Agent / Agenda / Loop 都支持)
- 卡覆写可以独立启用 / 禁用,不影响全局
- 「清除卡覆写」恢复到全局配置
- 你可以在卡绑定配置上层叠个人调整

四种模式现在都支持卡覆写。

### 导入导出

Spec 与 Agenda 配置以 JSON 导出。

| 格式 | 标识 | 适用 |
|---|---|---|
| V1 | `luker_orchestrator_profile_v1` | Spec 模式 |
| V2 | `luker_orchestrator_profile_v2` | Agenda 模式 |

文件名形如 `luker-orchestrator-[agenda-][global|character-{name}].json`。导出器同时支持全局和角色卡作用域。

导入时,文件的模式(Spec / Agenda)必须和你当前执行模式一致。你选择应用到全局或某张特定的卡。

::: info Loop 模式的导入导出
Loop 模式当前还没接入文件级的 Profile 导入导出按钮,改用 [AI 迭代工作台](/zh-CN/features/orchestrator/iteration-studio) 复用工作流。
:::

### 通用配置参考

最常用的几项:

| 设置 | 默认 |
|---|---|
| 执行模式 | `spec` |
| 注入位置 | `atDepth` |
| 注入深度 | `0` |
| 注入角色 | `SYSTEM` |

<details>
<summary>完整配置参考</summary>

| 设置 | 说明 |
|---|---|
| 执行模式 | Spec / 单 Agent / Agenda / Loop |
| 注入位置 | capsule 在主 prompt 中的位置 |
| 注入深度 | 注入深度 |
| 注入角色 | `SYSTEM` / `USER` / `ASSISTANT` |
| 自定义指令前缀 | 加在 capsule 前的前缀文字 |
| RPM 限制 | 并行节点的速率限制 |
| 工具调用重试次数 | 工具调用失败的重试次数 |
| 全局 API 预设 | 默认 API 连接预设 |
| 全局 Chat Completion 预设 | 默认 Chat Completion 预设 |
| 包含世界书 | 节点是否能看到世界书 |
| `<thought>` 标签剥离 | 从 Agent 输出剥离思考标签 |
| 消息折叠阈值 | 1200 字符 / 18 行 |

模式专属的参数(节点 / 审查 / Planner / Loop 工具开关...)在各自的子页面里详述。

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

- [AI 迭代工作台](/zh-CN/features/orchestrator/iteration-studio) — 编排器核心定制工具,所有模式共用
- [Spec 模式](/zh-CN/features/orchestrator/spec) — 默认 DAG 工作流
- [单 Agent 模式](/zh-CN/features/orchestrator/single) — 退化的 Spec,只跑一个节点
- [Agenda 模式](/zh-CN/features/orchestrator/agenda) — Planner 动态调度
- [Loop 模式](/zh-CN/features/orchestrator/loop) — 单 Agent 工具循环
- [笔记 — 作者侧剧情线索](/zh-CN/features/orchestrator/notes) — agent-as-author 线索追踪器,作用域为当前 chat
- [Function Call Runtime](/zh-CN/improvements/function-call-runtime) — Agenda / Loop 模式都依赖此框架
- [角色卡编辑器](/zh-CN/features/card-editor/) — 与迭代工作台共用 diff 引擎
- [卡内绑定预设与人格](/zh-CN/improvements/card-bound-presets) — 编排配置如何随角色卡走
