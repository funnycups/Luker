# Agenda 模式

Agenda 用一个 **Planner Agent** 替换 Spec 的静态 DAG。Planner 维护 todo 列表,通过工具调用动态调度其他 Agent,读它们的输出,决定下一步派谁去——本质是一个 Agent loop。

什么时候用 Agenda 而不是 Spec:

- 流程要根据中间结果决定下一步派谁。比如"先看看用户输入有没有破规倾向,有的话才启动 Constraint Agent"——这种"有条件触发"在 Spec 的固定 DAG 里很别扭。
- 你想要更灵活的多 Agent 协作,而不是固定的 stage → node 拓扑。
- 用[Function Call Runtime](/zh-CN/improvements/function-call-runtime)的能力让 Planner 自己组织调度。

::: tip Agenda 不是 Spec 的替代
Spec 的可预期性、prompt 缓存友好度、debug 友好度都比 Agenda 强。绝大多数 RP 场景固定 DAG 已经够用,Agenda 是给确实需要动态调度的场景准备的。
:::

::: warning 99% 的人不该手搓
手搓 Planner prompt 之前先看一眼 [AI 迭代工作台](/zh-CN/features/orchestrator/iteration-studio)——一句话描述需求,AI 给你一份 Planner + Agent 池的方案,逐条审。
:::

## Agenda 编辑器

切到 Agenda 模式后,从编排器面板点 **打开编排编辑器**。

![Agenda 编辑器](/images/orchestrator/orch-agenda-editor.png)

左边是 **Planner Prompt** 配置区(API 预设、提示词预设、System Prompt、Planner Prompt 模板);右边是可用的 Agenda Agents 列表——Planner 通过工具调用从这个池子里挑 Agent 派任务。

### Planner

Planner 是 Agenda 的核心,它做几件事:

1. 读最近聊天 + 用户消息
2. 维护一个 todo 列表(下一步该做什么)
3. 调度 Agenda Agent 池里的 Agent 去做任务
4. 收集 Agent 输出
5. 根据收集到的内容决定下一步,或者认为足够了就停下,把最后一个 Agent 输出当 capsule 注入主模型

### Agenda Agents

每个 Agenda Agent 类似 Spec 的 Node:有自己的 System Prompt、User Prompt Template、可选的 API / Chat Completion 预设覆写。区别在于 Agent 不绑死在某个 stage,**何时被调用、被调用几次、是否被调用,都由 Planner 决定**。

### 三个运行时上限

Agenda 是动态调度,失控容易,所以有三道闸:

- **Planner 最大轮数** — Planner 调度的轮数上限
- **最大并发 Agent 数** — 同时跑的 Agent 数量上限(`Promise.all` 的并发度)
- **总执行次数上限** — 整次跑里所有 Agent 调用次数总和

到任一上限就强制收尾。

## AI 迭代工作台

和 Spec 一样,Agenda 也有 AI 迭代工作台支持——自然语言描述 Planner 行为 / Agent 池构成,AI 帮你搭。详见 [AI 迭代工作台](/zh-CN/features/orchestrator/iteration-studio)。Quick Build 也适用 Agenda。

## 与 Spec 的互转

编排编辑器里有 **复制 Spec Agents 到 Agenda** / **复制 Agenda Agents 到 Spec** 按钮可以快速搬运 Agent 池(尽力而为)。**注意**:

- Spec → Agenda 时,stage 拓扑信息丢失,需要你重新写 Planner Prompt 描述调度逻辑
- Agenda → Spec 时,Planner 的动态调度无法完整映射到固定 DAG,需要你手动决定 stage 划分

## Function Call Runtime 依赖

Agenda 模式的 Planner 调度通过 OpenAI 工具调用实现,依赖 Luker 的 [Function Call Runtime](/zh-CN/improvements/function-call-runtime)框架。这意味着:

- Planner 用的连接配置必须支持 function calling(OpenAI / Claude / Gemini 都支持)
- 工具调用失败时的重试由 Function Call Runtime 处理(详见对应文档)

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
| Agenda Agent 池 | 各 Agent 的预设 / prompt(可独立覆写 API 与 Chat Completion 预设) |

</details>

## 相关页面

- [编排器概览](/zh-CN/features/orchestrator/) — 通用配置 / 触发时机 / 角色卡绑定
- [AI 迭代工作台](/zh-CN/features/orchestrator/iteration-studio) — AI 帮你写 Planner + Agent 池(推荐)
- [Spec 模式](/zh-CN/features/orchestrator/spec) — 默认的 DAG 模式
- [Loop 模式](/zh-CN/features/orchestrator/loop) — 单 Agent 工具循环
- [Function Call Runtime](/zh-CN/improvements/function-call-runtime) — Planner 调度依赖此框架
