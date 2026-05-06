# Orchestrator Loop 模式

Luker 的多 Agent 编排器（orchestrator）现已支持第四种执行模式：**loop**。一个 agent 在同一会话里通过工具调用循环推进，主动决定何时收尾——而不必预先画 DAG 或写 Planner 提示词。

适用场景：你想让一个 agent 像研究员那样工作——读最近聊天、查世界书、翻记忆图、记笔记，最后产出一段精炼的 capsule 注入主对话；过程中需要它自己根据中间发现决定下一步，而不是按固定流程走完所有 stage。

::: tip 与现有模式的关系
loop 模式和 spec / agenda 共存。已有的 spec / agenda profile 不受影响；新建 profile 默认走 loop。
:::

## 是什么 / 为什么

orchestrator 此前的三种模式（spec、single、agenda）都是"多 agent 协作生成单条主回复"，stage 间通过 `previousNodeOutputs` 传结构化输出。这套设计在以下场景出现摩擦：

- **配置门槛高**：spec 需要拉 DAG，agenda 需要 Planner 提示词。
- **stage 切换开销**：每个 stage 重建 system prompt / 切预设，prompt cache 难命中，端到端延迟累加。
- **上下文断层**：stage 间只透传 `previous_outputs`，agent 中间的思考过程会丢失。
- **流程僵化**：DAG 拓扑写死，agent 无法根据中间发现动态调整路径。

loop 模式针对这些点做单 agent + 工具循环：同一会话、一套 preset、消息数组持续累加，agent 根据上一轮工具结果决定下一步调什么工具，主动调 `finalize(capsule_text)` 时停下。core benefit 是上下文连续性——工具调用与结果天然在 messages 里，不需要手工传变量。

## 快速开始

1. 打开 orchestrator 编辑器（设置 → 多 Agent 编排）。
2. 新建 profile，模式选择"单 Agent 循环 (loop)"。
3. 在"系统提示词"框填写 agent 的角色和任务说明，例如：

   > 你是这本架空王朝小说的细节顾问。读取最近聊天，查阅角色卡设定与历史事件，记下你在循环中获得的关键线索。当你认为自己已经能写出一段对下一回合主模型有帮助的指引时，调用 finalize。

4. 在"启用的工具"勾选你需要的工具（详见下表）。`finalize` 强制启用，无法关闭。
5. 设置 `max_rounds`（默认 20，上限 50）和 `wall_clock_budget_ms`（默认 5 分钟）作为失控保护。
6. 配置 capsule 注入位置（与 spec 模式一致：atDepth / worldInfoBefore / 等）。
7. 保存。下一次主模型生成前，loop agent 会自动跑起来，把 `finalize` 产出的 capsule 注入到主提示词里。

## 工具集说明

所有工具走 OpenAI function-calling 协议，结果以 tool message 形式回到 agent 的下一轮上下文。共 8 个可选工具 + 1 个强制 `finalize`：

| 工具 | 作用 | 简单示例（RP 场景） |
|---|---|---|
| `note.add(text)` | 写一条**持久化笔记**，绑定当前 chat。下一次 loop 启动时，这些笔记会自动注入 system prompt。单条上限 1KB，最多保留 50 条 LRU。 | agent 在"林晚提到她的外祖母在洛阳"那一轮调 `note.add('林晚的家族线索：外祖母→洛阳')`，几次对话后再启 loop 时仍能看到这条笔记。 |
| `chat.read_range(start, end)` | 读 chat 楼层范围。负数从末尾倒数，单次最多 50 楼。 | `chat.read_range(-10, -1)` 读最近 10 楼复习上下文。 |
| `chat.search(query, limit)` | 全聊天 substring 搜索（大小写不敏感），返回楼层 + 内容预览。 | `chat.search('青冥剑')` 找出之前所有提到"青冥剑"的楼层。 |
| `lorebook.search(query, limit)` | 在所有启用的世界书里 substring 搜索条目。**默认排除本回合已激活的条目**（那些已经被注入主上下文，再返回会浪费 token）。返回 `entries` + `excluded_active_count`。 | `lorebook.search('落雁城')` 翻出未激活的"落雁城"相关设定。 |
| `lorebook.get(entry_key)` | 按 key 拉取条目全文。**不去重**——允许 agent 精确引用某条已激活条目以保持术语一致。 | `lorebook.get('落雁城-主城')` 把这一条全文调出来引用。 |
| `memory.search(query, limit)` | 在记忆图（memory-graph）做 lexical 搜索，**不依赖 vector 配置**。同样默认排除已注入节点。 | `memory.search('家族秘密')` 找历史事件节点。 |
| `memory.list_recent(limit)` | 时间倒序浏览记忆节点，看看最近发生了什么。 | `memory.list_recent(10)` 取最近 10 个事件节点。 |
| `memory.get(node_id)` | 按 id 拉节点本身 + 直连邻居 id 列表（不含完整邻居节点）。 | 看完 `memory.search` 拿到一个节点 id，用 `memory.get` 看它和谁相关。 |
| `finalize(capsule_text)` | **终止信号**。`capsule_text` 直接送到 capsule-injection 注入主模型。 | `finalize('林晚此刻心情焦虑：刚得知外祖母身世，可能在下一句对白中引出洛阳话题。')` |

## 与 spec / agenda 模式对比

| 维度 | spec / single | agenda | loop |
|---|---|---|---|
| 配置成本 | 需画 DAG + 每节点 prompt | 写 Planner prompt + worker prompts | 写一段 system prompt + 勾工具 |
| Agent 数量 | 多（每 stage / 节点一个） | Planner + 多 worker | 单 agent |
| Preset 切换 | 多次 | 多次 | 一次 |
| 流程可变 | 拓扑固定 | Planner 决定调度 | agent 自己决定下一步 |
| 上下文连续性 | 通过 `previous_outputs` 传变量 | 同 spec | 工具结果天然在 messages 里 |
| 失败处理 | 节点失败直接传播 | worker 失败由 Planner 重试 | 工具失败结构化注回，agent 自纠 |
| 适合场景 | 流程明确、stage 固定 | 复杂任务需要调度 | 探索性研究、动态决策、prompt cache 重要 |

## 配置项说明

- `max_rounds`（默认 20，上限 50）：loop 最多跑多少轮。一轮 = 一次 LLM 请求 + 处理它返回的 tool call。
- `wall_clock_budget_ms`（默认 300000，即 5 分钟）：整个 loop 的墙钟预算。无论 round 数多少，到点 break。
- `system_prompt`：loop agent 的 system 指令，由你撰写。
- `tools.<namespace>.<verb>`：每个工具的启用开关（`finalize` 强制 true）。
- `capsule_inject`：与 spec 模式一致的位置 / 深度 / 角色 / 自定义指令配置。
- `apiPresetName` / `promptPresetName`：单 agent 用的 API 预设和提示词预设。

## 失控保护（5 层，按触发优先级）

1. **abort signal**：用户点"停止" / 上层取消 → 立即中止，trace 记 `cancelled`，capsule **不**注入。
2. **wall_clock_budget_ms**：到点立即 break。
3. **max_rounds**：硬轮次上限（默认 20，最多 50）。
4. **单工具调用 timeout**：复用 orchestrator 的 `agentTimeoutSeconds`；超时即 ToolError 注回。
5. **agent 不调工具**：连续 3 轮没调任何工具 → 提前 break（防止 agent "光说话不动手"耗光预算）。任意一轮调到工具，streak 归零。

触发任一兜底时，loop 会把最后一次 agent 的自然文本作为 capsule（如果有），保证至少有产出送给主模型。

## AI Iteration Studio 用法

不会写 system prompt？打开 loop popup → 点"AI Iteration Studio" → 用自然语言描述你想要的 agent，AI 会读你当前的 profile，用工具调用产出 patch（修改 `system_prompt` / 工具开关 / `max_rounds` 等）。

例如：

> 我希望这个 agent 先读最近 5 楼，再去世界书查相关设定，最后去记忆图找有没有冲突，然后写 capsule。不要它写笔记。

Studio 会在多轮对话里逐步细化你的 profile；每次工具调用要么是 `luker_orch_continue_iteration`（继续追问 / 局部更新），要么是 `luker_orch_finalize_iteration`（这次需求已满足）。AI 自行决定何时收尾，无需手动开关 Auto-Continue。

## 常见问题

**Q：`memory.search` 返回空怎么办？**
A：先确认 memory-graph 扩展是否启用、当前 chat 是否真的有记忆节点。返回空也可能是查询词太具体；试试 `memory.list_recent` 看时间线，再决定下一步。

**Q：`lorebook.search` 为什么排除已激活条目？**
A：那些条目已经通过 worldInfo 主流程注入了主模型上下文，loop agent 再把它们返回到自己的循环里只是浪费 token。**用 `lorebook.get` 才能精确引用已激活条目原文**，比如保持术语一致。

**Q：loop 跑到一半我想停下来怎么办？**
A：点工具栏的 stop 按钮（与 spec / agenda 一致）。loop runtime 在每轮顶部检查 abort signal，立即中止；trace 写 `cancelled`，不会注入半成品 capsule。

**Q：笔记会跨 chat 共享吗？**
A：不会。`note.add` 写入的是**当前 chat** 的 floor-state 命名空间，跨 chat 之间互不可见。删除楼层 / swipe 走 floor-state 的 settle 机制——绑定到该楼的笔记会自动消失。

**Q：连续 3 轮不调工具被打断了怎么办？**
A：检查 system prompt 是否给了 agent 明确的"产出格式"。多数情况是 agent 在"思考"但不知道何时该 finalize；在 prompt 里加一条"当你掌握的信息足以写出 capsule 时，立即调用 finalize"通常能解决。

## Trace 排错

orchestrator 的 trace 面板会记录 loop 每一轮的事件：

- `run_started` / `run_finished`：run 开始 / 结束（含状态：completed / budget_exhausted / cancelled）
- `llm_request` / `llm_response`：每轮的请求 / 响应（含 message_count、tool_call_count）
- `tool_call` / `tool_result` / `tool_error`：每次工具调用的输入和结果
- `agent_no_tool_call`：agent 这一轮没调工具（含连续计数）
- `budget_exhausted`：触发兜底时的具体 reason（max_rounds / wall_clock / no_tool_call_streak）

报 bug 给开发者时，可以在 trace 面板点"导出本次 run"下载 jsonl 文件附上。

## 性能 trade-off

loop 模式与 spec / agenda 在性能上有结构性差异：

- **延迟**：loop 一套 preset 跑全程，每轮 LLM 请求复用同一个 prompt cache 前缀，理论上端到端比 spec 快（spec 每个 stage 切 preset，cache 几乎重建）。
- **token 用量**：loop **不一定省**。工具调用结果累加在同一个 messages 数组里，到第六、七轮时上下文已经显著膨胀；spec 模式 stage 间断流，每个 stage 的 prompt 较短。
- **失败率**：loop 是新模式，可能比成熟的 spec 不稳定，agent 偶尔会跑岔。建议从短任务（max_rounds=5）开始试。

::: info 待手测验证
具体延迟差距、capsule 主观质量、token 总用量在不同 character / 不同模型下的实际表现，需要真实 LLM 调用做对比测试，目前文档里的相对预期还没有大规模量化数据。欢迎在用过几天 loop 模式之后反馈你的感受。
:::
