# Loop 模式

Loop 模式让一个 Agent 在同一会话里反复调用工具，自己决定何时结束。它适合需要边查边想的回合：先读最近聊天，再查世界书和记忆图，最后写出一段编排结果交给主模型。

```d2
direction: down

start: "新回合开始" {
  shape: oval
  style.fill: "#e8f5e9"
}

loop: "单个 Agent 持续工作" {
  style.fill: "#e1f5ff"

  think: "读取已收集的信息\n决定下一步" {
    style.fill: "#fffde7"
  }

  decide: "可以写出编排结果了吗？" {
    shape: diamond
  }

  tool: "调用工具\n读取近期聊天 · 查询世界书 ·\n检索记忆 · 记录笔记 · 联网搜索\n结果回到同一会话" {
    style.fill: "#fff3e0"
  }

  finish: "写出编排结果并结束" {
    style.fill: "#c8e6c9"
  }

  think -> decide
  decide -> tool: "信息不足"
  decide -> finish: "信息足够"
  tool -> think: "继续"
}

out: "注入主模型的提示词" {
  shape: oval
  style.fill: "#f3e5f5"
}

start -> loop.think
loop.finish -> out
```

## 与 Spec、Agenda 的区别

Spec 和 Agenda 按预先写好的流程逐个阶段执行。每个阶段切换预设，提示词缓存难以复用，阶段之间只传递结构化输出，Agent 的中间思考会丢失。

Loop 只有一个 Agent 和一个持续增长的会话。工具调用与结果都留在上下文中，提示词缓存持续命中，因此速度更快；下一步查什么由 Agent 根据上一轮结果决定，不依赖固定流程。

需要可复现的固定流程时用 Spec；需要动态决定运行哪些 Agent 时用 Agenda；需要单个 Agent 自主研究并给出结论时用 Loop。

## 开始使用

1. 在**工作台 → 编排**顶栏的模式选择器中选为**循环**（Loop）。
2. 在**流程**或**准备阶段**编辑研究员的角色设定，说明任务和结束条件。
3. 在**流程**中选择循环模式使用的连接配置与生成预设，留空时沿用**编排 → 设置**中的全局默认。
4. 在**准备阶段**的工具开关中勾选本轮需要的工具组。
5. 正常聊天，在**运行面板**悬浮窗或**编排 → 运行**查看查询过程和最终结果。

## 编辑器

- **角色设定**：Agent 的角色、任务和结束条件。多数 Loop 卡住不结束，都是因为提示词没有说明什么时候可以提交结果。
- **循环最大轮数**（**编排 → 设置**）：默认 40。一轮包含一次模型请求和一次工具处理。
- **循环时间预算（秒）**（**编排 → 设置**）：默认 300 秒。到时终止，不等待剩余轮次。
- **工具开关**（**准备阶段**）：按组启用。未勾选的组不会出现在 Agent 的工具列表中。
- **模型**（**流程**）：可以让 Loop 单独使用成本更低的模型。

## 可用工具

工具按用途分组，勾选后 Agent 才能使用：

- **聊天**：读取指定范围的楼层，按正则搜索全部楼层。
- **世界书**：搜索已启用的条目，读取条目全文，或把本轮未激活的条目强制加入主模型上下文。
- **记忆图**：查看候选节点，按关键词或语义搜索，按名称查找实体，创建、编辑、删除节点与关系，查看类型配置，压缩事件层级。
- **笔记**：开启和关闭剧情线索，让后续回合能够追踪伏笔与承诺。
- **联网搜索**：调用搜索插件查找资料并访问页面正文。
- **提交结果**：写出最终编排结果并结束本轮。该工具始终启用。

工具的具体数量与名称会随安装的插件变化。Agent 只能调用已勾选且当前可用的工具。

## 保护机制

运行会在以下情况停止：

- 你点击停止，或上层取消生成。
- 达到时间预算。
- 达到最大轮次。
- Agent 连续多轮没有调用任何工具，说明它已经不再查询，只是重复输出文本。

如果你的 agent 需要内置之外的能力，参见[自定义工具](./custom-tools.md)。

## 失控保护（按触发优先级）

1. **abort signal**：用户点「终止」 / 上层取消 → 立即中止；trace 记 `cancelled`，**不**注入半成品 capsule。
2. **wall_clock_budget_ms**：到点立即 break。
3. **max_rounds**：轮次上限（默认 40）。
4. **Agent 不调工具**：连续 3 轮没调任何工具 → 提前 break（防止 agent「光说话不动手」耗光预算）。任意一轮调到工具，streak 归零。

触发任一兜底时，loop 会把最后一次 agent 的自然文本作为 capsule 兜底，保证至少有产出送给主模型。

## 看一次 loop 跑

[运行面板](/zh-CN/features/orchestrator/#step-4) 会实时显示 loop 运行过程。Agent 的推理是一张卡片，展开就能看 agent 当时怎么想、调了哪些工具。Loop 模式可以重点关注：

- **思考 + 工具调用** —— 该轮 agent 的思考，跟着是它派发的工具。工具参数就地展开，不用看 raw JSON。
- **工具结果反哺下一轮** —— 每个工具的返回也在这张卡片里。对照 system prompt 找 agent 跑岔的位置。
- **`finalize`** —— agent 调用 `finalize` 工具时 loop 结束。它的 `capsule_text` 参数就是注入主模型的那段文本。
- **兜底** —— 任一兜底触发（`max_rounds` / 墙钟超时 / 连续不调工具）时，面板会直接显示具体原因，loop 会用 agent 上一次的自然文本作为 capsule 兜底。

面板顶部的**导出**按钮把整次 run 下载为 JSON（便于回报问题）。

::: warning persistTrace 是实验性开关
设置里的 `persistTrace` 可以让所有 run 自动落盘到扩展数据目录。**目前是实验性的**——没有跨平台稳定的写盘 helper，开关默认关。日常用运行面板的按需导出就够；只有需要持续追踪某个 chat 的 loop 行为时才打开。
:::

## AI 迭代工作台用法

不会写 system prompt？打开 loop popup → 点 **打开 AI 迭代工作台**，用自然语言描述你想要的 agent，AI 会读你当前的 profile，用工具调用产出 patch（修改 `system_prompt` / 工具开关 / `max_rounds` / 预设路由）。详见 [AI 迭代工作台](/zh-CN/features/orchestrator/iteration-studio#loop-模式的迭代提示)。

## 角色卡绑定

Loop 现已支持卡覆写。在角色卡选中状态打开编排编辑器，会出现 **保存到角色卡覆写** / **清除角色卡覆写** 按钮——和 Spec / Agenda 的体验一致。绑定后这套 loop 配置会随卡导出，卡作者可以为自己的角色推荐"读什么、记什么、何时 finalize"。

::: info 与 spec / agenda 的差异
Loop popup 当前没有 **导出 Profile** / **导入 Profile** 按钮，跨电脑同步先用 AI Iteration Studio 复用工作流。文件级导入导出会等后续。
:::

## 与 spec / agenda 模式对比

| 维度 | spec / single | agenda | loop |
|---|---|---|---|
| 配置成本 | 需画 DAG + 每节点 prompt | 写 Planner prompt + worker prompts | 写一段 system prompt + 勾工具 |
| Agent 数量 | 多（每 stage / 节点一个） | Planner + 多 worker | 单 agent |
| Preset 切换 | 多次 | 多次 | 一次 |
| 流程可变 | 拓扑固定 | Planner 决定调度 | agent 自己决定下一步 |
| 上下文连续性 | 通过 `previous_outputs` 传变量 | 同 spec | 工具结果天然在 messages 里 |
| 失败处理 | 节点失败直接传播 | worker 失败由 Planner 重试 | 工具失败结构化注回，agent 自纠 |
| 角色卡覆写 | ✅ | ✅ | ✅ |
| 文件级导入导出 | ✅ | ✅ | ❌（用 Iteration Studio 复用） |
| 适合场景 | 流程明确、stage 固定 | 复杂任务需要调度 | 速度与效果平衡；探索性研究、动态决策、prompt cache 重要 |

## Loop 配置参考

<details>
<summary>Loop 专属配置</summary>

| 设置 | 说明 |
|---|---|
| `max_rounds` | loop 最多跑多少轮（默认 40） |
| `wall_clock_budget_ms` | 整个 loop 的墙钟预算（默认 300000 ms / 5 分钟） |
| `system_prompt` | loop agent 的 system 指令 |
| `tools.<namespace>.<verb>` | 每个工具的启用开关（`finalize` 强制 true） |
| `apiPresetName` / `promptPresetName` | 单 agent 用的 API 与提示词预设 |
| `capsule_inject` | 与 spec 模式一致的位置 / 深度 / 角色 / 自定义指令配置 |

</details>

## 常见问题

### Agent 一直不结束

在系统提示词里明确写出结束条件，例如「收集到当前场景所需的信息后，提交编排结果，不要继续查询」。减少勾选的工具组也能降低它反复探索的倾向。

### 工具没有出现

检查工具开关是否勾选，以及对应插件是否启用。联网搜索还需要在搜索插件中配置可用的 provider。

### 运行太慢或太贵

换用更小的模型，只勾选本轮真正需要的工具组，并降低最大轮次。记忆图的向量检索依赖嵌入档案，未配置时会提示不可用。

### 结果没有注入主模型

确认 Loop 已启用、执行模式选择正确，并查看运行面板是否显示了最终结果。取消或失败的运行不会注入未完成的内容。

## 相关页面

- [多 Agent 编排概览](/zh-CN/features/orchestrator/) —— 模式选择与通用配置
- [编排 AI 迭代](/zh-CN/features/orchestrator/iteration-studio) —— 用自然语言修改 Loop 配置
- [自定义工具](/zh-CN/features/orchestrator/custom-tools) —— 给 Agent 增加内置之外的能力
- [笔记](/zh-CN/features/orchestrator/notes) —— 剧情线索的保存与追踪
- [记忆图](/zh-CN/features/memory-graph) —— Loop 可查询的长期记忆
