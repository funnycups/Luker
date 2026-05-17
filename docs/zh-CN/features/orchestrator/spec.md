# Spec 模式

Spec 是编排器的默认模式,也是其他模式的"基准"。它把工作流拆成一串 **阶段(Stage)**,每个阶段里若干 **节点(Node)** 串行或并行跑;阶段间严格串行,前一阶段所有节点都收工后才进入下一阶段。每个节点 = 一次 LLM 调用 + 一段 prompt 模板。最后一个阶段产出"作业说明"注入主模型,前面所有阶段都是为它做准备。

::: tip 你已经在用了
启用编排器时默认就是 Spec,而且自带一套能跑的工作流(distiller、规划、约束、审查、合成器...)。这份文档的目标是:**改默认工作流、写新工作流、理解为什么默认这样设计**。
:::

::: warning 99% 的人不该手搓
手搓 stage / node 之前先看一眼 [AI 迭代工作台](/zh-CN/features/orchestrator/iteration-studio)——一句话描述需求,AI 给方案,逐条审。手搓只在工作台搞不定的极致定制场景才用。
:::

## 概念速览

到这一节,几个术语开始派上用场。简短定义:

- **Stage 阶段** — 工作流的横向切片。阶段间严格串行,Stage 2 必须等 Stage 1 跑完才能开始。
- **Node 节点** — 阶段内的执行单位。**一个节点 = 一次 LLM 调用 + 一段 prompt 模板**。
- **DAG** — 有向无环图。说人话就是「有先后顺序、不会绕回去的流程图」。

每个阶段有一个执行方式:

- **串行** — 阶段内的节点一个接一个跑
- **并行** — 节点用 `Promise.all` 同时跑

每个节点要么是 **worker**(干活),要么是 **review**(审查上一阶段的输出)。

## 默认编排流程

Spec 是一条固定流水线。默认 profile 自带 5 个 stage、7 个 worker —— `distiller` 读懂场景,接着 `lorebook_reader` + `anti_data_guard` 并行锁定硬约束,然后 `planner` + `recall_relevance` 并行规划下一拍,`critic` 评审(并可把上一阶段打回重做),最后 `synthesizer` 落笔写 capsule。

```d2
direction: right

start: "新一回合开始" {
  shape: oval
  style.fill: "#e8f5e9"
}

s1: "Stage 1 · distill(serial)" {
  style.fill: "#e1f5ff"
  distiller: "distiller\n读懂本回合\n场景状态" {
    style.fill: "#fffde7"
  }
}

s2: "Stage 2 · grounding(parallel)" {
  style.fill: "#e1f5ff"
  lorebook_reader: "lorebook_reader\n锁定当前世界书\n硬约束" {
    style.fill: "#fffde7"
  }
  anti_data_guard: "anti_data_guard\n拦截播报体 /\n观察体文笔" {
    style.fill: "#fffde7"
  }
}

s3: "Stage 3 · reason(parallel)" {
  style.fill: "#e1f5ff"
  planner: "planner\n规划下一拍" {
    style.fill: "#fffde7"
  }
  recall_relevance: "recall_relevance\n召回相关\n记忆线索" {
    style.fill: "#fffde7"
  }
}

s4: "Stage 4 · review(serial)" {
  style.fill: "#e1f5ff"
  critic: "critic\n审查\n上一阶段" {
    shape: diamond
    style.fill: "#fff3e0"
  }
}

s5: "Stage 5 · finalize(serial)" {
  style.fill: "#e1f5ff"
  synthesizer: "synthesizer\n落笔写编排\n指引 capsule" {
    style.fill: "#c8e6c9"
  }
}

out: "capsule 注入\n下一句主回复" {
  shape: oval
  style.fill: "#f3e5f5"
}

start -> s1
s1 -> s2
s2 -> s3
s3 -> s4
s4 -> s5: "通过"
s4 -> s3: "打回重跑(带反馈)" {
  style.stroke-dash: 3
}
s5 -> out
```

## 手搓:Spec 工作流编辑器

工作台搞不定的极致定制场景,直接动 stage / node。从编排器面板打开:**打开编排编辑器**。

![Spec 编辑器](/images/orchestrator/orch-spec-editor.png)

左边面板是工作流(阶段及其节点)。右边面板是 Agent 预设库。每个节点引用一个预设,预设携带系统提示、用户提示模板、可选的 API/Chat Completion 预设覆写、执行标志。

### 模板变量

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

## 常见场景配方

| 我想要 | 这样做 |
|---|---|
| AI 回复前先想清楚情节再写 | [AI 迭代工作台](/zh-CN/features/orchestrator/iteration-studio)描述里加「分两阶段:先规划下一步,再写文」 |
| AI 不要轻易出戏 | 启用 Anti-Data Guard;[AI 迭代工作台](/zh-CN/features/orchestrator/iteration-studio)描述里要求「加一个硬挡 meta 评论的 Constraint Agent」 |
| 同一个工作流跨卡通用 | 应用到全局,不要绑卡 |
| 不同卡用不同工作流 | 在角色卡选中状态打开工作台,**应用到角色卡** |
| 太慢 / 太贵 | 见[概览 → Step 2](/zh-CN/features/orchestrator/#step-2-给各-agent-选模型);或切到 [单 Agent 模式](/zh-CN/features/orchestrator/single) 只跑一个节点 |
| 想反复调试同一个工作流 | 工作台的 session 会话——它会持久化 |
| 换电脑用 | 见[概览 → 导入导出](/zh-CN/features/orchestrator/#导入导出) |
| 全部重置 | 编排编辑器有 **重置全局** 按钮 |

## Trace 面板

主回复出来后在编排器面板点 **查看运行态轨迹**,Spec 的 trace 弹窗会按几块铺出整次 run——顶部元信息 + 流程图、执行时间线、流程事件、对话与原始数据。

### 面板概览 + 流程图

顶部状态摘要里 Spec 模式相关的几项:**节点执行次数**(所有 worker 跑了多少次)、**REVIEW 重跑次数**(审查节点驱动的重跑次数,默认上限 2 次,可在配置参考里调到 0 关闭或 20 上限)。

紧跟在下面的「流程图」可视化整条 DAG:每个 stage 是一个色块,内部按节点 id 排出 worker 卡片。点击某张卡片可以在右侧「执行时间线」里跳到对应 worker 的详情。

![Spec trace 面板:元信息 + 流程图 + 执行时间线右侧展示 worker 详情](/images/orchestrator/real-spec-meta.png)

### 执行时间线

「执行时间线」是右侧详情面板,展示选中 worker 的完整输出。Spec 节点的输出形态由节点的 prompt 模板决定——此例里 distiller 节点输出了一段 `summary` + 一段 `xml_guidance`(带 `<story_state>` / `<location>` / `<key_items>` 这类 XML 标签),后续 stage 可以解析它取出结构化字段。

![Spec 执行时间线:展开 worker 详情查看 summary 与 xml_guidance](/images/orchestrator/real-spec-timeline.png)

### 流程事件

「流程事件」按时间序号铺出整条 DAG 的执行节奏:`Run started` → 每个 stage 的 `stage_started` → 各 worker 的 `worker_started` / `worker_completed`(同 stage 内并行的 worker 时间戳会很接近)→ `stage_completed` → 下一个 stage,最后 `Run completed`。

![Spec 流程事件:stage_started → worker_started/completed → stage_completed,串行展开整条 DAG](/images/orchestrator/real-spec-events.png)

如果某个 stage 触发了审查重跑,事件流里会看到该 worker 多次 `worker_started` / `worker_completed`——拿这个数和顶部 **REVIEW 重跑次数** 对一下就知道审查节点驳回了几次。

### 原始轨迹

面板最底下「最新注入文本」是最后一个 stage 的输出——也就是注入主模型的 capsule。再往下「原始运行态轨迹」是整次 run 的 JSON 形态,顶层字段包含 `runId`、`chatKey`、`generationType`、`capsuleText` 等。

![Spec 原始轨迹 JSON 与最新注入文本](/images/orchestrator/real-spec-rawtrace.png)

报 bug 时点「导出本次 run」会下载这份 JSON 的 jsonl 形式,直接附给开发者。

## Spec 配置参考

<details>
<summary>Spec 专属配置</summary>

| 设置 | 说明 |
|---|---|
| 节点迭代最大轮数 | 单节点的迭代上限 |
| 审查重跑最大轮数 | 0 禁用审查驱动的重跑;最大 20 |
| Anti-Data Guard | 默认 Spec 工作流里的一个内置节点,屏蔽数据化 / 报告腔的散文(诸如 观察 / 分析 / 评估 / 监测 / observation / analyze / metric / probability 这种把 RP 写成观察日志或参数表的词)。硬编码约 18 个词的词典。不想要的话直接把这个节点从工作流里删掉。 |
| 节点 API 预设 | 节点级覆写;留空 = 全局 |
| 节点 Chat Completion 预设 | 节点级覆写;留空 = 全局 |

每个节点可以用不同的 API 和 Chat Completion 预设,所以你可以让蒸馏器走便宜模型、合成器走高质量模型。

</details>

## 相关页面

- [编排器概览](/zh-CN/features/orchestrator/) — 通用配置 / 触发时机 / 角色卡绑定
- [AI 迭代工作台](/zh-CN/features/orchestrator/iteration-studio) — AI 帮你改默认 Spec 流程(99% 场景下推荐)
- [单 Agent 模式](/zh-CN/features/orchestrator/single) — 退化的 Spec,只跑一个节点
- [Agenda 模式](/zh-CN/features/orchestrator/agenda) — Planner 动态调度版本
- [Loop 模式](/zh-CN/features/orchestrator/loop) — 单 Agent 工具循环
- [角色卡编辑器](/zh-CN/features/card-editor/) — 与迭代工作台共用 diff 引擎
