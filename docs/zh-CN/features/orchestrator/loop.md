# Loop 模式

Loop 模式让单个 Agent 在同一会话里通过工具调用循环推进，自己决定何时收尾——不画 DAG、不写 Planner，只写一段 system prompt + 勾几个工具就能跑。

**Loop 模式在速度与效果之间取得平衡**：比单 Agent 智能（可以调工具迭代查记忆 / 查世界书 / 翻聊天），比 Spec / Agenda 快（同一会话同一 preset，prompt cache 持续命中，不像 spec 每个 stage 切 preset 都要重建 cache）。

适合的场景：你想让一个 agent 像研究员那样工作——读最近聊天、查世界书、翻记忆图、记笔记，最后产出一段精炼的 capsule 注入主对话；过程中需要它自己根据中间发现决定下一步，而不是按固定流程走完所有 stage。

::: tip 与 Spec / Agenda 的关系
loop 模式和 spec / agenda 共存。已有的 spec / agenda profile 不受影响。
:::

::: warning 99% 的人不该手搓 system prompt
不会写 system prompt？直接打开 [AI 迭代工作台](/zh-CN/features/orchestrator/iteration-studio)——用自然语言描述你想要的 agent，AI 通过工具调用直接 patch profile。
:::

## 是什么 / 为什么

Spec / Single / Agenda 三种模式都是"多 agent 协作生成单条主回复"，stage 间通过 `previousNodeOutputs` 传结构化输出。这套设计在以下场景出现摩擦：

- **配置门槛高**:spec 需要画 DAG，agenda 需要写 Planner 提示词。
- **stage 切换开销**：每个 stage 重建 system prompt / 切预设，prompt cache 难命中，端到端延迟累加。
- **上下文断层**:stage 间只透传 `previous_outputs`，agent 中间的思考过程会丢失。
- **流程僵化**:DAG 拓扑写死，agent 无法根据中间发现动态调整路径。

Loop 模式针对这些点做单 agent + 工具循环：同一会话、一套 preset、消息数组持续累加，agent 根据上一轮工具结果决定下一步调什么工具，主动调 `finalize(capsule_text)` 时停下。core benefit 是上下文连续性——工具调用与结果天然在 messages 里，不需要手工传变量。

## 默认编排流程

Loop 模式只跑一个 Agent。它读一眼手头已有的信息，决定是再去取点上下文，还是直接落笔写 capsule，如此往复直到主动 `finalize`。

```d2
direction: down

start: "新一回合开始\n(为下一句回复准备编排指引)" {
  shape: oval
  style.fill: "#e8f5e9"
}

loop: "一个 Agent 单干" {
  style.fill: "#e1f5ff"

  think: "看一眼到目前为止已收集到的信息,\n决定下一步动作" {
    style.fill: "#fffde7"
  }

  decide: "可以下笔写 capsule 了吗?" {
    shape: diamond
  }

  tool: "调一个工具\n翻聊天 · 查世界书 · 翻记忆图 ·\n记笔记 · 联网搜索\n—— 结果直接落进会话里" {
    style.fill: "#fff3e0"
  }

  finalize: "写下编排指引 capsule\n并 finalize 收尾" {
    style.fill: "#c8e6c9"
  }

  think -> decide
  decide -> tool: "还不行 —— 再取点上下文"
  decide -> finalize: "可以"
  tool -> think: "下一步"
}

out: "capsule 注入下一句主回复" {
  shape: oval
  style.fill: "#f3e5f5"
}

start -> loop.think
loop.finalize -> out
```

## 切到 Loop

扩展抽屉里把执行模式选成 **单 Agent 循环 （loop）**。spec / agenda 的 board 自动收起，出现一个独立的 Loop board。

![执行模式选成 Loop](/images/orchestrator-loop/orch-loop-mode-select.png)

![Loop 设置面板](/images/orchestrator-loop/orch-loop-board.png)

## 编辑器

点 **打开编排编辑器** 弹出一个左右两列的工作区——左边是单个 Agent 的预设 + 系统提示词 + 两个保护参数，右边是按命名空间分组的工具开关。

![Loop 编辑器](/images/orchestrator-loop/orch-loop-editor.png)

关键字段：

- **Loop 系统提示词**:Agent 的角色与任务说明。要明确告诉它「何时该调 `finalize`」——多数翻车都来自 agent 不知道何时收尾。
- **Loop 最大轮次**（默认 20，上限 50）：一轮 = 一次 LLM 请求 + 处理它返回的 tool call。
- **Loop 墙钟预算**（默认 300 秒）：整个 loop 的墙钟上限，无论已跑多少轮，到点 break。
- **工具开关**：勾掉的命名空间不会出现在 agent 的工具 schema 里。`finalize` 强制启用、不可关闭。
- **Loop API 预设 / Loop 提示词预设**：留空 = 用全局编排预设。和 spec / agenda 的预设路由一致，能让 loop 单独走更便宜的模型。

## 内置工具

工具走 OpenAI function-calling 协议，结果以 `role: tool` 消息形式回到 Agent 的下一轮上下文。共 23 个可选工具 + 1 个强制 `finalize`:

| 工具 | 作用 | 简单示例（RP 场景） |
|---|---|---|
| `note_open(text)` | 开启一条**剧情作者线索**（伏笔、承诺、章节大纲）。笔记会在之后每次 loop 启动时出现在 agent 的 "## Open Notes" 块，直到被关闭。单条上限 16KB。 | agent 发现自己刚埋了一个设定，调 `note_open('林晚:外祖母在洛阳——下次见面兑现')`；之后几轮 loop 都能看到这条线索。 |
| `note_close(id, reason?)` | 按 id 关闭一条已开启的笔记（已兑现、不再需要等）。笔记从 "## Open Notes" 块中消失，但仍归档保留。 | 章节节拍落地后，`note_close('o_a3f2', '林晚见到外祖母,floor 73')`。 |
| `chat_read_range(start, end)` | 读 chat 楼层范围。负数从末尾倒数，单次最多 50 楼。 | `chat_read_range(-10, -1)` 读最近 10 楼复习上下文。 |
| `chat_search(query, limit)` | 全聊天 substring 搜索（大小写不敏感），返回楼层 + 内容预览。 | `chat_search('青冥剑')` 找出之前所有提到「青冥剑」的楼层。 |
| `lorebook_search(query, limit)` | 在所有启用的世界书里 substring 搜索条目。**默认排除本回合已激活的条目**（那些已经被注入主上下文，再返回会浪费 token）。返回 `entries` + `excluded_active_count`。 | `lorebook_search('落雁城')` 翻出未激活的「落雁城」相关设定。 |
| `lorebook_get(entry_key)` | 按 key 拉取条目全文。**不去重**——允许 agent 精确引用某条已激活条目以保持术语一致。 | `lorebook_get('落雁城-主城')` 把这一条全文调出来引用。 |
| `memory_list_candidates(seq_window?, types?, exclude_recent_messages?)` | 枚举可见的记忆图候选池——与记忆图自身召回 LLM 看到的同一组。返回 `{ candidates: [{ id, type, level, title, seqTo, semanticDepth }] }`，按时间倒序。**召回流水线的第一步**。 | `memory_list_candidates({ types: ['event'] })` 返回召回 LLM 会考虑的最近事件节点。 |
| `memory_keyword_search(query, types?, k?)` | 按 token 匹配 title + 字段值，无需 profile。返回 `{ results: [{ id, type, title, seqTo, score, scoreMode: 'keyword' }] }`，按 score 降序。按关键词或短语查时用。 | `memory_keyword_search({ query: 'family secret', k: 8 })` |
| `memory_vector_search(query, types?, k?)` | 按配置的 embedding profile 做语义相似度搜索。未配置 embedding profile 时直接抛 `NO_EMBEDDING_PROFILE`，不静默 fallback；需要时手动回落到 `memory_keyword_search`。 | `memory_vector_search({ query: 'the moment she chose forgiveness', k: 5 })` |
| `memory_find_by_name(query, types?)` | 在 title + primary key 列（通常含 aliases）上做大小写不敏感子串匹配。返回 `{ matches: [...] }`。**创建角色 / 地点前先调它确认实体不存在** —— 名称去重时比 search 更便宜也更可靠。 | `memory_find_by_name({ query: 'Eileen', types: ['character_sheet'] })` |
| `memory_compaction_candidates(type, depth?)` | 纯读：查哪些节点组当前可做层级压缩。返回 `{ groups: [{ depth, childIds, fanIn }] }`，搭配 `memory_compact_nodes` 用。`compression.mode === 'none'` 的类型会返回空 groups。 | `memory_compaction_candidates({ type: 'event' })` |
| `memory_node_create({ type, title, fields, links?, ref? })` | 创建新语义节点。节制使用 — 先调 `memory_find_by_name` 确认实体不存在。返回 `{ ok, id }`。 | `memory_node_create({ type: 'character_sheet', title: 'Marcus', fields: { traits: 'warrior, terse' } })` |
| `memory_node_edit({ node_id, set_fields?, clear_fields?, title? })` | 给已有节点打字段补丁。`fields` 的 key 必须在该 type 的 `tableColumns` schema 里（用 `memory_schema` 确认）。返回 `{ ok }`。 | `memory_node_edit({ node_id: 'n_eileen', set_fields: { goal: 'reach the summit' } })` |
| `memory_node_delete({ node_id })` | 按 id 删节点。仅当节点显然过期 / 重复 / 错误时用。返回 `{ ok }`。 | `memory_node_delete({ node_id: 'n_stale_dup' })` |
| `memory_link_upsert({ source_node_id\|source_ref, links })` | 在节点间加 relation 边。必须使用规范的 relation 词表。允许同一对节点上多种 relation 并存（复合状态）。返回 `{ ok, applied }`。 | `memory_link_upsert({ source_node_id: 'n_eileen', links: [{ target_node_id: 'n_protag', relation: 'partner_of' }] })` |
| `memory_link_delete({ source_node_id, target_node_id, relation, direction? })` | 删 relation 边。该方向上的 relation 不再成立时用（关系破裂、债务偿清）。**不要为「替换」而删** —— 复合多边状态本身就是合法的。返回 `{ ok, removed }`。 | `memory_link_delete({ source_node_id: 'n_eileen', target_node_id: 'n_protag', relation: 'sworn_to' })` |
| `memory_compact_nodes({ type, child_ids, summary, fields? })` | 创建一个高层 rollup 节点，把指定 children reparent 进来；同时加 `semantic_contains` 边。在 `memory_compaction_candidates` 返回 groups 后调。返回 `{ ok, rollup_node_id }`。 | `memory_compact_nodes({ type: 'event', child_ids: ['e1', 'e2', 'e3'], summary: '时间：Day 1-3；...' })` |
| `memory_node_brief(node_id, include_edge_summary?, edge_summary_limit?)` | 节点的规范化 brief（title、summary、key/row 字段、子节点数、exposure、edge summary、alwaysInject）——与召回 LLM 看到的单行格式一致。 | 搜索拿到短名单后，`memory_node_brief({ node_id: 'evt_42' })` 拉一个节点的完整 brief。 |
| `memory_edge_summary(node_id, edge_types?, limit?)` | 仅返回边摘要 `{ degree, relations, sample_neighbors }`。只想判断"这是不是个 hub"而不要整个 brief 时用。 | `memory_edge_summary({ node_id: 'evt_42' })` 只取拓扑信号。 |
| `memory_expand_seeds(seed_ids, hops?, edge_types?, include_children?)` | 从种子 id 沿子节点 + 投影边做 BFS 扩展。当某节点主题相关但具体细节大概率在子节点或相关 rollup 时用。 | `memory_expand_seeds({ seed_ids: ['evt_42'], hops: 1, include_children: true })` 浮现 `evt_42` 的子节点。 |
| `memory_schema()` | 一轮一次：有哪些节点类型，哪些字段是 key vs detail，哪些类型走 hierarchical compression。让你能正确解读其他 memory_* 工具的返回。 | 召回开始前 `memory_schema()` 一次，了解可用的类型集。 |
| `search_search(query)` | **联网搜索**，转发给 [Search Tools](/zh-CN/features/search-tools) 插件（DuckDuckGo / SearXNG / Brave）。默认开启，但需要 search-tools 扩展已加载并配好 provider——否则 Agent 会收到 `SEARCH_UNAVAILABLE` / `SEARCH_DISABLED` 并自行改用其他工具。 | `search_search('某某新闻最新进展')` 返回 provider 形态的结果（通常是 `{title, url, snippet}` 列表）。 |
| `search_visit(url)` | 抓取 `search_search` 命中的某个页面，返回可读正文。 | 拿到搜索结果后，`search_visit('https://example.com/article')` 把整篇正文拉回来。 |
| `finalize(capsule_text)` | **终止信号**（强制启用）。`capsule_text` 直接注入主模型 prompt。 | `finalize('林晚此刻心情焦虑:刚得知外祖母身世,可能在下一句对白中引出洛阳话题。')` |

工具调用结束后，结果以浅黄色 `工具结果` 块挂在对话流里，agent 下一段 `助手` 块的思考就能直接基于它继续推进。这种「调工具 → 看结果 → 继续 → 适时 finalize」的节奏正是 loop 与 spec / agenda 拉开差距的地方：整段上下文留在 messages 里，没有 stage 之间的断流。

![Loop 对话流：工具结果回到 agent 下一轮思考](/images/orchestrator/real-loop-conversation-tool.png)

如果你的 agent 需要内置之外的能力，参见[自定义工具](./custom-tools.md)。

## 失控保护（5 层，按触发优先级）

1. **abort signal**：用户点「停止」 / 上层取消 → 立即中止；trace 记 `cancelled`，**不**注入半成品 capsule。
2. **wall_clock_budget_ms**：到点立即 break。
3. **max_rounds**：硬轮次上限（默认 20，最多 50）。
4. **Agent 不调工具**：连续 3 轮没调任何工具 → 提前 break（防止 agent「光说话不动手」耗光预算）。任意一轮调到工具，streak 归零。

触发任一兜底时，loop 会把最后一次 agent 的自然文本作为 capsule 兜底，保证至少有产出送给主模型。

## Trace 面板

主回复出来后在编排器面板点 **查看运行态轨迹** 就能打开 loop run 的 trace 弹窗。它把整次 loop 拆成几块呈现——顶部元信息、Agent 对话、流程事件时间线、原始数据——下面按面板顺序逐块看。

### 面板概览

最上面一行是状态摘要：状态（已完成 / 取消 / 预算耗尽）、模式（`loop`）、生成类型（`normal` / `continue` / `regenerate` / `swipe` / `impersonate`）、目标楼、节点执行次数、REVIEW 重跑次数、更新时间。

![Loop trace 面板顶部元信息](/images/orchestrator/real-loop-meta.png)

### Agent 对话

「Agent 对话」一栏按消息顺序铺出整轮 loop 的 messages 数组——`系统` 块是 system prompt，`助手` 块是 agent 那一轮的思考与工具调用（参数直接展开，不用看 raw json），后接 `工具结果` 块。整次 loop 的所有上下文都在这里看，对照 prompt 找 agent 跑岔的根因。

![Agent 对话：system 提示词 + 第一轮思考 + chat_read_range 工具调用](/images/orchestrator/real-loop-conversation-system.png)

下一轮里 agent 拿到上一次工具的返回，补一段思考，调 `finalize`。`finalize` 也走 tool_call 通道，`capsule_text` 直接展开成结构化文本——就是会注入主模型的那段。

![Agent 对话：finalize 调用与 capsule_text 全文](/images/orchestrator/real-loop-conversation-assistant.png)

### 流程事件

「流程事件」一栏按时间序号排出每个 trace event，带 ISO 时间戳。run 起止、每轮 llm_request / llm_response、每次 tool_call / tool_result / tool_error 都各占一行；触发兜底时会有 `budget_exhausted` 行，带具体 reason。

![Loop 流程事件：run_started → llm_request/response → tool_call/result → Run completed](/images/orchestrator/real-loop-events.png)

事件类型速查：

- `run_started` / `run_finished`:run 开始 / 结束（含状态：`completed` / `budget_exhausted` / `cancelled`）
- `llm_request` / `llm_response`：每轮的请求 / 响应（含 `message_count`、`tool_call_count`）
- `tool_call` / `tool_result` / `tool_error`：每次工具调用的输入和结果（`finalize` 也走这条；空 `capsule_text` 报 `code: FINALIZE_EMPTY`）
- `agent_no_tool_call`:agent 这一轮没调工具（含连续计数）
- `budget_exhausted`：触发兜底时的具体 reason(`max_rounds` / `wall_clock` / `no_tool_call_streak`)

### 原始轨迹 / 导出

面板最底下「最新注入文本」是 capsule 终态；接着的「原始运行态轨迹」是整次 run 的 JSON 形态——`runId`、`chatKey`、`generationType`、`capsuleText` 等顶层字段都在这里。报 bug 时点「导出本次 run」会下载这份 JSON 的 jsonl 形式，直接附给开发者。

![Loop 原始轨迹 JSON 与最新注入文本](/images/orchestrator/real-loop-rawtrace.png)

::: warning persistTrace 是实验性开关
设置里的 `persistTrace` 可以让所有 run 自动落盘到扩展数据目录。**目前是实验性的**——没有跨平台稳定的写盘 helper，开关默认关。日常用按需导出就够；只有需要持续追踪某个 chat 的 loop 行为时才打开。
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
| `max_rounds` | loop 最多跑多少轮（默认 20，上限 50） |
| `wall_clock_budget_ms` | 整个 loop 的墙钟预算（默认 300000 ms / 5 分钟） |
| `system_prompt` | loop agent 的 system 指令 |
| `tools.<namespace>.<verb>` | 每个工具的启用开关（`finalize` 强制 true） |
| `apiPresetName` / `promptPresetName` | 单 agent 用的 API 与提示词预设 |
| `capsule_inject` | 与 spec 模式一致的位置 / 深度 / 角色 / 自定义指令配置 |

</details>

## 常见问题

**Q:`memory_list_candidates` 返回空怎么办？**
A：先确认记忆图扩展是否启用、当前 chat 是否真的有记忆节点。返回空也可能是这个 chat 还很早、还没产生候选节点；可以用 `memory_schema` 确认类型表已经填充。

**Q:`lorebook_search` 为什么排除已激活条目？**
A：那些条目已经通过 worldInfo 主流程注入了主模型上下文，loop agent 再把它们返回到自己的循环里只是浪费 token。**用 `lorebook_get` 才能精确引用已激活条目原文**，比如保持术语一致。

**Q:loop 跑到一半我想停下来怎么办？**
A：点工具栏的 stop 按钮（与 spec / agenda 一致）。loop runtime 在每轮顶部检查 abort signal，立即中止；trace 写 `cancelled`，不会注入半成品 capsule。

**Q：笔记是否跨 chat 共享？**
A：不会——笔记保存在当前 chat 的持久化状态里。floor-state 的 settle 机制会自动处理分支和删除。

**Q：连续 3 轮不调工具被打断了怎么办？**
A：检查 system prompt 是否给了 agent 明确的「产出格式」。多数情况是 agent 在「思考」但不知道何时该 finalize；在 prompt 里加一条「当你掌握的信息足以写出 capsule 时，立即调用 finalize」通常能解决。

**Q：勾选了 `search_search`，Agent 却收到 `SEARCH_UNAVAILABLE` / `SEARCH_DISABLED`?**
A:web 工具是把请求转发给 [Search Tools](/zh-CN/features/search-tools) 插件的。`SEARCH_UNAVAILABLE` 表示插件没加载；`SEARCH_DISABLED` 表示插件加载了但被关掉了。打开 search-tools 设置面板，选好 provider（DuckDuckGo / SearXNG / Brave）、把总开关打开，再重试即可。

## 性能 trade-off

Loop 模式与 spec / agenda 在性能上有结构性差异：

- **延迟**:loop 一套 preset 跑全程，每轮 LLM 请求复用同一个 prompt cache 前缀，理论上端到端比 spec 快（spec 每个 stage 切 preset，cache 几乎重建）。
- **token 用量**:loop **不一定省**。工具调用结果累加在同一个 messages 数组里，到第六、七轮时上下文已经显著膨胀；spec 模式 stage 间断流，每个 stage 的 prompt 较短。
- **失败率**:loop 是新模式，可能比成熟的 spec 不稳定，agent 偶尔会跑岔。建议从短任务（`max_rounds=5`）开始试。

::: info 待手测验证
具体延迟差距、capsule 主观质量、token 总用量在不同 character / 不同模型下的实际表现，需要真实 LLM 调用做对比测试，目前文档里的相对预期还没有大规模量化数据。欢迎在用过几天 loop 模式之后反馈你的感受。
:::

## 相关页面

- [编排器概览](/zh-CN/features/orchestrator/) — 通用配置 / 触发时机 / 角色卡绑定
- [AI 迭代工作台](/zh-CN/features/orchestrator/iteration-studio) — AI 帮你写 system prompt（推荐）
- [Spec 模式](/zh-CN/features/orchestrator/spec) — 默认的 DAG 模式
- [单 Agent 模式](/zh-CN/features/orchestrator/single) — 退化的 Spec
- [Agenda 模式](/zh-CN/features/orchestrator/agenda) — Planner 动态调度
- [Function Call Runtime](/zh-CN/improvements/function-call-runtime) — loop 工具调用走的运行时
- [记忆图](/zh-CN/features/memory-graph) — `memory.*` 工具背后的数据源
- [Notes](/zh-CN/features/orchestrator/notes) — open/close 笔记模型的面板使用与概念详解
- [自定义工具](./custom-tools.md) — 自己注册工具或把 SillyTavern function tool 桥接进 loop
