# Agenda 模式

Agenda 用一个 **Planner Agent** 替换 Spec 的静态 DAG。Planner 维护 todo 列表，通过工具调用动态调度其他 Agent，读它们的输出，决定下一步派谁去——本质是一个 Agent loop。

什么时候用 Agenda 而不是 Spec:

- 流程要根据中间结果决定下一步派谁。比如"先看看用户输入有没有破规倾向，有的话才启动 Constraint Agent"——这种"有条件触发"在 Spec 的固定 DAG 里很别扭。
- 你想要更灵活的多 Agent 协作，而不是固定的 stage → node 拓扑。
- 用[Function Call Runtime](/zh-CN/improvements/function-call-runtime)的能力让 Planner 自己组织调度。

::: tip Agenda 不是 Spec 的替代
Spec 的可预期性、prompt 缓存友好度、debug 友好度都比 Agenda 强。绝大多数 RP 场景固定 DAG 已经够用，Agenda 是给确实需要动态调度的场景准备的。
:::

::: warning 99% 的人不该手搓
手搓 Planner prompt 之前先看一眼 [AI 迭代工作台](/zh-CN/features/orchestrator/iteration-studio)——一句话描述需求，AI 给你一份 Planner + Agent 池的方案，逐条审。
:::

## Agenda 编辑器

切到 Agenda 模式后，从编排器面板点 **打开编排编辑器**。

![Agenda 编辑器](/images/orchestrator/orch-agenda-editor.png)

左边是 **Planner Prompt** 配置区（API 预设、提示词预设、System Prompt、Planner Prompt 模板）；右边是可用的 Agenda Agents 列表——Planner 通过工具调用从这个池子里挑 Agent 派任务。

### Planner

Planner 是 Agenda 的核心，它做几件事：

1. 读最近聊天 + 用户消息
2. 维护一个 todo 列表（下一步该做什么）
3. 调度 Agenda Agent 池里的 Agent 去做任务
4. 收集 Agent 输出
5. 根据收集到的内容决定下一步，或者认为足够了就停下，把最后一个 Agent 输出当 capsule 注入主模型

### Agenda Agents

每个 Agenda Agent 类似 Spec 的 Node：有自己的 System Prompt、User Prompt Template、可选的 API / Chat Completion 预设覆写。区别在于 Agent 不绑死在某个 stage，**何时被调用、被调用几次、是否被调用，都由 Planner 决定**。

### 三个运行时上限

Agenda 是动态调度，失控容易，所以有三道闸：

- **Planner 最大轮数** — Planner 调度的轮数上限
- **最大并发 Agent 数** — 同时跑的 Agent 数量上限（`Promise.all` 的并发度）
- **总执行次数上限** — 整次跑里所有 Agent 调用次数总和

到任一上限就强制收尾。

## 默认编排流程

Agenda 把节奏交给 Planner Agent 来定，Planner 每轮从一个 worker 池里挑人派活。默认 profile 自带 Planner + 5 个 worker（`distiller`、`lorebook_reader`、`planner`、`critic`、`finalizer`）；每轮 Planner 派出一个或多个 worker、读回结果、必要时重新规划，看板搞定后由 `finalizer` 落笔写 capsule。

```d2
direction: down

start: "新一回合开始" {
  shape: oval
  style.fill: "#e8f5e9"
}

loop: "Planner 主导的动态调度" {
  style.fill: "#e1f5ff"

  driver: "Planner\n看一眼已完成的工作 · 更新 todo 看板 ·\n派 worker 处理任务 · 判断何时收尾" {
    style.fill: "#fffde7"
  }

  pool: "默认 worker 池 —— Planner 按 todo 挑人派" {
    style.fill: "#fff3e0"
    distiller: "distiller\n紧凑的状态读取" {
      style.fill: "#fffde7"
    }
    lorebook_reader: "lorebook_reader\n当前世界书硬约束" {
      style.fill: "#fffde7"
    }
    planner: "planner\n下一拍进程规划" {
      style.fill: "#fffde7"
    }
    critic: "critic\n审计指定材料" {
      style.fill: "#fffde7"
    }
  }

  driver -> pool: "并行派一个或多个"
  pool -> driver: "结果回收 · 必要时重新规划"
}

finalizer: "finalizer\n读完最终的看板 · 落笔写编排指引 capsule" {
  style.fill: "#c8e6c9"
}

out: "capsule 注入下一句主回复" {
  shape: oval
  style.fill: "#f3e5f5"
}

start -> loop.driver
loop.driver -> finalizer: "收尾"
finalizer -> out
```

默认 agent 在编排里各自负责什么：

| Agent | 作用 | 简单示例（RP 场景） |
|---|---|---|
| `Planner`（循环驾驶员，非 worker） | 读聊天和用户消息，维护 todo 看板（`add` / `set_status` / `drop`），每轮从下面的 worker 池里挑一个或多个派活，读回结果，决定是继续规划还是交给 `finalizer`。 | 第 1 轮：并行派 `distiller` + `lorebook_reader`。第 2 轮：读完输出，判断还需要 `planner` 与 `critic`。第 3 轮：交给 `finalizer`。 |
| `distiller` | 紧凑、有据可查的场景状态读取（用户意图、当前张力、即时方向）；写给 Planner 与下游 agent 看，不直接面向玩家。 | 「林晚在试探用户对洛阳话题的态度；如果用户绕开，她会彻底换话题。」 |
| `lorebook_reader` | 只挑出本回合**真的有影响**的世界书 / world-info 约束，写成可执行的写作 / 行为约束，不抄世界书原文。 | 「洛阳被围 —— 林晚不可能离开。文风：别用现代词，她会说『不知怎的』而非『somehow』。」 |
| `planner` | 场景进程分析师 —— 提下一拍该走哪些 beat / 决策点，保留因果、不让世界围着用户转。 | 节拍：「用户追问 → 她躲闪 → 换个角度再问 → 她漏出一个洛阳细节 → 回复停在那」。 |
| `critic` | 审 Planner 派过来的材料（连续性断裂、OOC 漂移、缺失硬约束、anti-data、不合理的因果），给审计结论；不亲自改写指引。 | 「这个计划里林晚说『没什么大不了』—— 现代腔调，这角色 OOC。其它通过。」 |
| `finalizer`（Final Agent —— 整个流程的最后一站，只跑一次） | 读完最终的 todo 状态和选定的历次 run，合成一段简洁、可直接拿来起稿下一回合的编排指引文本 —— 就是最后注入主回复的那段 capsule。 | capsule：「林晚：躲闪 → 被追问 → 漏出一个洛阳姑姑的细节。用词保持古朴；她还在被围的洛阳城内。」 |

## AI 迭代工作台

和 Spec 一样，Agenda 也有 AI 迭代工作台支持——自然语言描述 Planner 行为 / Agent 池构成，AI 帮你搭。详见 [AI 迭代工作台](/zh-CN/features/orchestrator/iteration-studio)。Quick Build 也适用 Agenda。

## 与 Spec 的互转

编排编辑器里有 **复制 Spec Agents 到 Agenda** / **复制 Agenda Agents 到 Spec** 按钮可以快速搬运 Agent 池（尽力而为）。**注意**:

- Spec → Agenda 时，stage 拓扑信息丢失，需要你重新写 Planner Prompt 描述调度逻辑
- Agenda → Spec 时，Planner 的动态调度无法完整映射到固定 DAG，需要你手动决定 stage 划分

## Function Call Runtime 依赖

Agenda 模式的 Planner 调度通过 OpenAI 工具调用实现，依赖 Luker 的 [Function Call Runtime](/zh-CN/improvements/function-call-runtime)框架。这意味着：

- Planner 用的连接配置必须支持 function calling（OpenAI / Claude / Gemini 都支持）
- 工具调用失败时的重试由 Function Call Runtime 处理（详见对应文档）

## 看一次 Agenda 跑

[运行面板](/zh-CN/features/orchestrator/#step-4) 会实时显示每次 Agenda 运行。每一轮 Planner 是一张卡片，该轮派发的每个 worker 是它下面的子卡片，展开就能看到完整推理和输出。Agenda 模式可以重点关注：

- **每轮 Planner 输出** —— `todo_ops` 列表（`set_status` / `add` / `set_goal` 等），就地展开。Planner 派错 agent、漏步、死循环时，对照这些 ops 与 worker 输出找根因。
- **worker 派发** —— 该轮 Planner 调起来的每个 worker 都在这一轮的卡片下。展开能看到入参与输出。
- **Final Agent 输出** —— run 末尾的最后一个 worker（默认是 `finalizer`）产出注入主模型的 capsule。配置参考里能换成其他 agent id。
- **事件密度** —— Agenda 一次 run 通常会有 20+ 事件（Planner 轮次 + 每次派发都会留下记录），所以面板比 Spec 看起来更密。

面板顶部的**导出**按钮把整次 run 下载为 JSON（便于回报问题）。

## Agenda 配置参考

<details>
<summary>Agenda 专属配置</summary>

| 设置 | 说明 |
|---|---|
| Planner 最大轮数 | Planner 调度的轮数上限 |
| 最大并发 Agent 数 | 同时跑的 Agent 数量上限 |
| 总执行次数上限 | 整次跑里所有 Agent 调用次数总和 |
| Planner API 预设 | Planner 节点用的 Connection profile |
| Planner Chat Completion 预设 | Planner 节点用的提示词预设 |
| Planner System Prompt | Planner 的 system 指令 |
| Planner Prompt 模板 | Planner 的 user prompt 模板 |
| Final Agent | 收尾时把哪个 Agent 的输出当 capsule |
| Agenda Agent 池 | 各 Agent 的预设 / prompt（可独立覆写 API 与 Chat Completion 预设） |

</details>

## 相关页面

- [编排器概览](/zh-CN/features/orchestrator/) — 通用配置 / 触发时机 / 角色卡绑定
- [AI 迭代工作台](/zh-CN/features/orchestrator/iteration-studio) — AI 帮你写 Planner + Agent 池（推荐）
- [Spec 模式](/zh-CN/features/orchestrator/spec) — 默认的 DAG 模式
- [Loop 模式](/zh-CN/features/orchestrator/loop) — 单 Agent 工具循环
- [Function Call Runtime](/zh-CN/improvements/function-call-runtime) — Planner 调度依赖此框架
- [自定义工具](/zh-CN/features/orchestrator/custom-tools) — Agenda Worker 可以调用的扩展 / SillyTavern 桥接 / 手写工具

## 预设

本模式的配置可以保存为命名预设，并在编辑面板中切换。完整工作流见
[编排预设](./presets.md)。
