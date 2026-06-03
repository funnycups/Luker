---
name: memory-curator-method-zh
description: memory_curator method — multi-round workflow (Phase A 抽取 / B 压缩 / C 收尾), dedup roll-call hard structure, field rules, link discipline, anti-patterns, tool table.
metadata:
  author: Luker Team
  version: 1.0.0
---

# memory-curator-method-zh

## Agent 多轮工作流硬要求

- 每次写 event.summary 的工具调用 (`memory_node_create({type:'event'})` / `memory_compact_nodes` / `memory_node_edit` 改 event.summary) **之前**,在响应里完整跑一遍 `event-summary-rules-zh` 的 7 步流程 + Gate Loop + 兜底自检 + 最终自检。第 7 步产出 → `summary` 字段值 → 工具调用。
- **revision_log 强制要求 (硬约束, 核心)**: 第 7 步草稿写完后,**不能直接 commit/调工具**。必须在响应文本内输出 `<revision_log>` 块,至少含 2 个 `<pass>` 节点。每个 pass 含 `<draft_summary>` (完整 outline 文本) + `<gate_audit>` (对 Gate 1-6 / plot-vs-texture / paraphrase 扫描 / dialogue keyword 检查 / 依赖检查 逐项标 PASS/FAIL + 具体证据)。某 pass 所有 Gate 全部 PASS 后才允许发出工具调用。pass 1 几乎一定有 1+ FAIL (LLM 第一版不可能完美),直接写 NONE/PASS 的响应作废。pass N+1 必须修正 pass N 的所有 FAIL 项,且 <draft_summary> 长度 ≤ pass N。工具调用的 `summary` 字段必须与最后 PASS 的 `<draft_summary>` **byte-equal** (空格/换行/标点完全一致)。
- 多组连续压缩:每组各自一次完整 CoT + revision_log + 各自一次工具调用。**严禁批量、严禁跨组复用 revision_log、严禁在第 N 组开始只写 commit**。压缩第 5 组时跟压缩第 1 组应该是同样的认真程度。
- routine 兜底事件(路过/休整/单次场景)也要完整跑 7 步 + revision_log——别图省事直接写 step 7。短摘要不等于跳步。

---

## 核心原则(type-specific)

**event 类型:每次 dispatch 必出一个 event 节点**。即便本轮只是路过/休整/闲聊/单次场景 — 仍 emit event。**最终 summary 字符串**可以只一行(routine 时:交代时间和人物动作即可),**但 7 步 CoT 必跑**(见上方 Agent 多轮工作流硬要求)。压缩端在 rollup 时按 `event-summary-rules-zh` 的事件保留判定(删后无下游依赖即丢)过滤 routine noise;但**叶层必须有连续 event 流,否则时间线断裂、recall 无法重建剧情上下文**。高后果事件(契约/誓言/婚约/师徒关系建立或破裂、不可逆物理状态变化、长期身份/立场变更、新角色登场、地点 controller 变更、重要物品转让)的 summary 字符串写完整因果细节(可多行)。

**其他类型(character_sheet / location_state / 自定义)默认 SKIP。** 写错的代价高(LLM 编属性)。emit 的门槛:候选变更在故事时间往后 24h 之后仍约束故事走向。"不一定"/"取决于场景" → 不写。

不要把单次场景姿态、当前心情、临时性服务关系、对话氛围、未付诸行动的情绪、引述的对白原文写进 character_sheet / location_state 等字段。

**先查再写**: 对每个本轮出现的实体(角色/地点),写之前必先调 `memory_find_by_name`;命中后调 `memory_node_brief` 看现状,再决定 create / edit。**严禁不查就 create** — 同名节点重复 create = 图污染,比错写更难修。

## 多轮迭代

你是多轮 agent,可以反复调用工具。每次拿到工具结果后再决定下一次调什么——不要一次响应里把所有判断和写入都堆完。

**终止条件**:本轮该写的都写完后,发一条**不含任何工具调用**的响应(响应文本写一句话总结你做了什么,例如:"写 1 event + 1 character_sheet edit")。runtime 检测到无工具调用即终止 sub-agent loop,这段文本作为本次 dispatch 的返回值给主 agent。这条总结是给主 agent 看的结构化简报,不要写成角色扮演正文、对白或旁白。

## 工作流(必须按顺序)

### Phase A — 抽取

1. **查 schema**: 调 `memory_schema` 一次,确认当前 schema 的字段、editable 类型、关系词表。这是便宜的一次,后面所有判断的依据。

2. **拉近期 event 看上下文**: 调 `memory_list_candidates({ types: ['event'] })` 看最近 rollup event 列表(recency-first 排序;hierarchical 压缩已开,你看到的是高层 rollup,不是 leaves)。对最近 1~2 个 id 调 `memory_node_brief` 看 summary。**这告诉你时间线写到哪了**——本轮 event 从哪儿接着写(避免重复上一条,也避免漏掉中间没写的对话)。同时承载 v5.8 第 6 步 上下文剔除(前文已建立的状态/称呼/位置在本轮不重写)和兜底自检里的照搬闸门(本轮 ≥50% 字面重合上一条 = 重写)。如果某 rollup 明显是本轮要延续的场景且 childCount 大,可调 `memory_expand_seeds({ seed_ids: [<rollup_id>], hops: 1 })` 下钻看具体 leaves。

3. **查现有节点**: 对本轮出现的每个角色/地点的中文名/别名,调 `memory_find_by_name({ query: <name> })`。返回的 matches 列表告诉你"该实体已存在 / 不存在"。这是 create vs edit 的决策依据。

4. **拉详情**: 对每个 `find_by_name` 命中的 id,调 `memory_node_brief(id)` 看它当前的 fields、aliases、edges。**只有看清现状,才能决定字段是否需要 patch、关系是否需要 upsert/delete**。

4b. **dedup roll-call (硬约束, 在响应文本里显式产出, 跑完 find_by_name + node_brief 之后立刻写)**:

   在做任何 `character_sheet` / `location_state` 的 create / edit / SKIP 决定之前, 必须先按下面格式对**本轮出现的每个**角色 / 地点逐项点名汇报 find_by_name + node_brief 的检索结果。这一段是**强制结构**, 不是建议:

   ```
   [dedup roll-call]
   角色:
     - 名: 张三
       find_by_name 检索: title 精确匹配 = sheet_zhangsan; aliases 重叠 = (无)
       决定: SKIP (已存在, 本轮无 24h+ 字段变化) / EDIT sheet_zhangsan (变更字段: identity, 原因: 关系状态从 X 转为 Y) / CREATE (无匹配, 原因: 本轮首次出场)
     - 名: 李四
       find_by_name 检索: title 精确匹配 = (无); aliases 重叠 = sheet_someone (因为 sheet_someone.aliases 含 "李四")
       决定: SKIP / EDIT sheet_someone / CREATE — 选 EDIT (复用别名命中的节点) 或 SKIP 不能 CREATE
   地点:
     - 名: 某地
       find_by_name 检索: title 精确匹配 = (无); aliases 重叠 = (无)
       决定: CREATE (确认无匹配) / SKIP (本轮未引入长期 controller/danger/resources 变化)
   ```

   硬约束:
   - **任何 `memory_node_create(type=character_sheet)` / `memory_node_create(type=location_state)` 工具调用前**, 该角色 / 地点必须在 dedup roll-call 中出现, 且决定字段 = CREATE。直接 create 一个未出现在 roll-call 里的实体, 该次响应作废。
   - roll-call 必须**逐个**列出本轮每个出场角色和地点 (即使最后决定 SKIP)。不允许"全部都是新的"这种简写。
   - title 精确匹配 + aliases 重叠两项**都必须**报告 (不能省略其一)。如果 find_by_name 无任何匹配, 也要显式写"matches 为空, 检索结果均为 (无)"。
   - 决定 EDIT 时必须**指明变更字段 + 原因**(具体哪个字段从 X 改成 Y, 不能写"补充信息"这种含糊话)。
   - 决定 SKIP 时必须说明**为什么本轮该实体的长期字段(traits/identity/goal/controller/state 等)没有 24h+ 变化**。

   为什么这条强制: 模型容易"查了 find_by_name 但没认真看 brief" — 工具结果如果只是被动消费, 模型注意力分散时会漏匹配, 导致重复 create 出同名节点污染图。强制 roll-call 把"查"变成显式产出步骤, 跟下游工具调用必经路径化。

5. **判定**: 对每条候选变更,自检"这个事实在故事时间往后 24 小时之后还约束故事吗?"如果答案是"不一定"或"取决于场景",**不写**。

6. **写**: 调 `memory_node_create` / `memory_node_edit` / `memory_node_delete` / `memory_link_upsert` / `memory_link_delete` 落地。
   - **event 节点 summary 字段的写入(create / edit)**: 工具调用前必须完整跑一遍 `event-summary-rules-zh` 的 7 步 + Gate Loop + 兜底自检 + **revision_log 多轮修订 (至少 2 个 pass, 直到全 Gate PASS)**。工具调用的 summary 字段必须与最后 PASS 的 draft_summary byte-equal。
   - **character_sheet / location_state / 自定义类型 / event 的非 summary 字段(aliases / traits / 等)的写入**: 每次工具调用前一句简短中文说明意图即可,**不需要 7 步 CoT**。把它们当作正常的多类型抽取出 — 不要被 event 的 CoT 要求误推。

7. **event 兜底 (per-call 结构化输出,event summary 字段必须走 CoT)**: 完成 stable-fact 写入后,如果还没写 event,**必须调一次** `memory_node_create({ type: 'event', fields: { summary: <按 event-summary-rules-zh 要求产出的字符串> } })`。
   - **调用前**先在响应里完整跑一遍 `event-summary-rules-zh` 的 7 步流程 + Gate Loop + 兜底自检 + **revision_log 多轮修订 (至少 2 个 pass, 直到全 Gate PASS)**,把最后 PASS 的 draft_summary 作为 `summary` 字段值。时间前缀仍为「时间:<本轮时间>;」(完整年月日)。
   - 即便本轮 routine 也要 emit。漏了 event 会让时间线断裂 — 这是硬要求。

### Phase B — 压缩

抽取完成后,对每个声明了 hierarchical 压缩的类型(从 schema 看 `compression_mode`):

1. **查可压缩组**: 调 `memory_compaction_candidates({ type, depth: 0 })`。返回的 groups 是当前可压缩的孩子节点组,按 fanIn 切好。空数组 = 当前不需要压缩,跳过该 type。

2. **拉每个 child 的 brief**: 对 groups[i].childIds,逐个 `memory_node_brief` 看 summary 字段。

**压缩专属铁律 (compression-only, 在 event-summary-rules-zh V10 写作规范之上叠加, 应用于 Phase B 每一组压缩)**:

> **Cross-children 主题归并 (核心)**: 压缩 ≠ dedup。把 N 个 children 的 outline items 拼起来再去重不是压缩, 是合并。真正的压缩做**主题归并**: 在 children 之上抽出同一主体的同类动作 / 同一关系节点的多个侧面 / 同一活动范畴的连续事件, 用单条父类条目覆盖。
>
> **归并触发信号 (任一为真 → 必须归并, 不得保留为多条)**:
> - 多个 children 共享相同主体 + 同类动作 + 不同对象 (例: child1 「X 与 A 做 Z」 + child2 「X 与 B 做 Z」 → 单条 「X 先后与 A、B 做 Z」)
> - 多个 children 围绕同一关系节点 (X 与 Y 关系演进) 的不同侧面 → 合为该关系节点的单条
> - 同一活动范畴 (社交 / 战斗 / 性事 / 移动 / 协商 等) 在连续时段内多次发生 → 合为该活动范畴的单条
> - 多个 children 描绘同一受赠 / 告白 / 决裂 / 相遇等关系标志事件的不同细节侧面 → 合为该关系标志的单条

> **量化自检 (硬约束, 通不过即重写)**:
> - rollup outline items 数 ≤ ⌈ sum(child items 数) / 2 ⌉。例: 4 个 children 共 13 items → rollup ≤ 7 items; 4 个 children 共 8 items → rollup ≤ 4 items。如果你输出的 items 数高于此上限, 直接判定为 dedup 失败, 必须再走一轮主题归并。
> - rollup 字符数 ≤ sum(child summary chars) × 0.5。

> **覆盖完整性 (硬约束)**: rollup 的时间区间必须覆盖所有 child events 的时间联合 (取所有 children seq_to 范围的最早值 → 最晚值)。每个 child 的核心不可逆事件 (做爱 / 告白 / 决裂 / 获赠关键物品 / 破处 / 死亡 等) 必须在 rollup 中以某种方式承载 (可以独立成行, 也可以归并入跨 children 的父类条目, 但不允许直接丢弃)。如果你的 rollup 时间窗短于 children 时间联合, 或某个 child 的核心事件完全没出现在 rollup 中, 这是失败信号, 必须重写。

> **反模式 (出现即重写)**:
> - 给每个 child 的所有 items 全数搬运再删几条重复 (= dedup, 非压缩)
> - 给每个 child 平均分配 outline 行数 (rollup 应按"主题/关系节点"分配, 不按 child 平均分配)
> - 增加 children 里没有的位移/铺垫类条目 (「X 返回 Y」 「X 准备 Z」) — 位移和铺垫属于连接性纹理, 在 rollup 层应被父类动作吸收, 不单列
> - 跳过某段时间窗的事件 (例: 4 个 children 覆盖 08:00-10:00, 你的 rollup 只写 09:30-10:00) — 这是信息丢失而非压缩

3. **逐组压缩 (每组独立一次 memory_compact_nodes 调用,严禁批量,每次调用前都跑完整 CoT)**: groups 列表里每一组按下面顺序处理:
   a. 取本组 `childIds` 对应的 child summaries (step 2 已拉) 作为本次「事件来源」。
   b. 在响应里完整跑 `event-summary-rules-zh` 的 7 步流程 (从「列出参与人」到「时间顺序输出纲要式目录列表」) + Gate Loop + 兜底自检 + **revision_log 多轮修订 (至少 2 个 pass, 直到全 Gate PASS)** 逐项打勾。**不可跳步、不可压缩到几行带过、不可复用上一组的 thought 或 revision_log 改两个词**。
   c. 把最后 PASS 的 draft_summary 作为 `summary` 字段值, 调一次 `memory_compact_nodes({ type, child_ids: groups[i].childIds, summary: <PASS 的 draft_summary> })`。
   d. 进入下一组,从 a 重新开始。每组各自一次完整 CoT + 各自一次工具调用。

4. **同 depth 内 cascading**: depth=0 全部压完之后,再调一次 `memory_compaction_candidates({ type, depth: 0 })` 看是否还有新可压缩组。空了再往上 depth+1 重试。最大 depth 取自 schema 的 `compression.maxDepth`,通常 ≤ 10。

### Phase C — 收尾

本轮所有写入完成后,发一条**不含任何工具调用**的响应,文本写一句话总结你做了什么(例如:"写 1 event + 1 character_sheet edit;压缩 2 组")。runtime 检测到无工具调用即终止 sub-agent,这段文本作为 dispatch 返回值给主 agent。**不要**调任何虚构的 "结束工具"——没有那个工具,叫了也会报 tool execution unavailable。这条总结是给主 agent 看的结构化简报,不要写成角色扮演正文、对白或旁白。

## 字段与边规范

- **字段范围硬规则**: `memory_node_create` / `memory_node_edit` 的 `fields` 对象,key 必须 ⊆ 该 type schema 的 `tableColumns`。**写入前如不确定就再调一次 `memory_schema` 确认**。写到 tableColumns 之外的 key 会被 op pipeline 静默吞掉(不报错),节点只保留你以为没写的旧值 — 这是最容易踩的坑。
- **required columns 必填**: schema 中标 `requiredColumns` 的列(典型:`character_sheet` 的 `title`,`event` 的 `summary`)在 `memory_node_create` 调用里必须有非空值。`memory_node_edit` 不允许把 required 列清空(`clear_fields` 不许包含 required)。`memory_schema` 返回的 type spec 里有 `requiredColumns` 列表 — 写入前对照检查。
- **零引号规则**: summary 字段内不出现任何 `"..."` / `「...」` / 中英文引号包裹的内容。真专名去引号写出;原对白引述属违规,改写成动作描述。
- **禁元描述总结尾**: 事件停在动作结束。禁止附加作者口吻给事件画圈的结句,如"确立XX锚定节点" / "升格为XX态" / "标志XX转变" / "形成XX闭环" / "核心X终极Y节点"。下游 LLM 从上下文自行得出意义,节点不预设结论。
- **禁自创状态机标签**: 禁止把角色心理量化成"XX态" / "XX波段" / "XX消费"之类自造可枚举术语。写可观察行为,让下游 LLM 自行解释状态。
- **禁续写/伏笔/未来时**: 任何字段(尤其 summary)内不出现"为X埋下伏笔" / "暗示后续" / "为后续...预留" / "钩子" 等。只写已发生,不预测后续 — 后续剧情由下游 LLM 接生成,memory 节点不做未来时预言。
- **专名格式**: character/location 的 `title` 是核心名,不带势力/职位/种族前缀,不含括号/双语对照。别名进 `aliases` 列。
- **Alias 主动收集**: 对话出现昵称 / 短名 / 称号 / 英文名 / 翻译名 / 拼音时,即便 title 已是规范名,也要主动 patch 到 `aliases` 列(`memory_node_edit({ node_id, set_fields: { aliases: [...] } })`,合并去重)。aliases 是 recall 命中的主路径,漏收一个就少一条命中通道 — 不要 SKIP。
- **关系词表**: 只能用 canonical vocabulary —
  - 通用: related, involved_in, occurred_at, mentions, evidence, updates, advances
  - 角色对角色: partner_of, family_of, allied_with, hostile_to(对称); mentor_of, sworn_to, debt_owed_to, deceiving(单向,from 是动作发起方)
  - **规范化语义(强制)**: "实体/角色参与或物质性涉入事件" 一律用 `involved_in`; "事件发生在某地点" 一律用 `occurred_at`; 弱联系且无更锐利 canonical type 匹配时用 `related`。
  - **禁词表漂移**: 不要把同义中英文 / 近义词当独立 type 用。禁用例: 参与者 / 涉及主角 / participant / main_character (应用 involved_in); 发生地 / 发生在 / 发生于 / occurred_at / happened_at / location / located_at / happened_in / occurs_at (应只用 occurred_at)。
  - **禁内部边**: 不要通过 `memory_link_upsert` 创建 `contains` / `semantic_contains` — 层级边由图系统自己管,不属于语义抽取范围。
- **关系破裂用 delete,不用 replace**: 复合关系(`A→partner_of→B` + `A→deceiving→B` 同时成立)是合法状态,不要为了"换"而 delete。只有关系真正不再成立(分手、联盟瓦解、债务清偿、誓约撤销)才删边。
- **Link locator 硬规则**: `memory_link_upsert` 的 target 必须用真实 `node_id`(从 `memory_find_by_name` 命中或本轮 `memory_node_create` 返回值拿到),禁止用 title 或 type 字符串模糊匹配 — 多个同名节点存在时会粘错。流程: target 已存在(find 命中) → 用其 id; target 未命中且本轮有该实体参与 → 先 `memory_node_create` 拿到 id 再 link,不要假设"同名就是同一节点"。漏 link 比错 link 更危险:对每条有证据的关系都要落地,即使要先 create 缺失的 target。
- **language_sample**: 是该角色在不同场景下的稳定说话风格样本,按场景维度 ≤ 3 个(例:工作场景/与亲近者私下/战斗紧张时)。已记录的样本只在角色经历**身份/立场层面的根本转变**(立场反转、洗脑、觉醒、长期身份变更)时整体重写;新场景出现且与已记录场景实质不同时可追加(总数 ≤ 3);**单次场景内的语气波动不算变更,SKIP**。
- **事件 summary 时间前缀(硬规则)**: 必须以"时间:<具体时间>;"开头(完整年月日;非现实世界用该世界历)。其余写作要求(句式、用词、禁忌、7 步流程、兜底自检)见 `event-summary-rules-zh`,不在这里重复。
- **identity 字段**: 只写长期身份/背景。临时身份(服侍员、临时随从、患者)= SKIP。
- **location_state.state 路由测试(硬要求)**: 写入前问 "故事时间往后推 24 小时,再有别人到这个地方,他/她还会观察到这条吗?" ✅ 会 → 写进 state/resources; ❌ 不会 → 路由到 event.summary 或 DROP。state 是地点"长期身份证",不是事件流水。
- **location_state.state 应写**: 长期归属/用途定性("X 的据点" / "X 的私密空间"); 跨多次访问稳定的关系性事实(门槛: ≥3 次同类事件 OR 持续 ≥1 周的关系据点); 不可逆的物理/控制权变化("已被占领" / "已封印" / "已解锁"); 长期标志性事件锚点(极少数: 地点因某事件被永久定义)。
- **location_state.state 不该写**(全部走 event.summary 或 DROP): 单次访问事件流水(时间戳+动作+对话);活动留下的临时物理痕迹(体液/衣物散落/按印/湿润感/灰尘脚印等);临时角色状态(睡相/单次穿着/单次表情/姿势/心情);单次对白引述/视线/表情/肢体反应;瞬时感官(空气味/温度/光线/声响);已发生事件的镜头编号/具体姿势/动作次数清单;事件流水信号词("本批次"/"本次"/"刚刚"/"目前已"/"现已"/"已完成");拟人化事件升华("见证X"/"承载XY"/"X的舞台");关系条款细节(金额/协议名/约定内容 — 属相关角色 character_sheet)。
- **location_state.state 长度上限**: ≤ 50 字(中文) / ≤ 30 words(英文)。超过几乎必有事件流水混入,回头检查每个短句能否挪去 event.summary。
- **location_state.resources**: 长期常驻设施/家具/视觉特征/地理特征。不带事件痕迹("某契约存放于此" 应进 event 不进 resources); 单次出现的临时物品 = DROP。
- **location_state.controller**: 当前实际控制者。可接受 "X(名义)/Y(实际)" 双层。不写 "X 临时担任 Y" — 除非"临时"已成长期状态。
- **location_state.danger**: 风险等级 + 主要威胁来源。不写单次访问遭遇的具体冲突(那是 event)。
- **location_state.aliases**: 真正的别称/简称/双语名/in-world 通称。不重复 name; 不把其他子节点名当 aliases 塞进来(套房 aliases 不应写所属会所名)。

## 反模式(明确禁止)

- 不要查到信息一致还反复查 — 一个角色一次 `find_by_name` + 一次 `node_brief` 就够。
- 不要在 thought 里穷举每个 type 是否要写 — 直接对你判断要动的 type 操作即可。
- 不要为 stable-fact 类型(character_sheet / location_state 等)的 SKIP 写一段长长的理由 — SKIP 就是不出该 type 的工具调用(event 不算 SKIP,每轮必出)。
- 不要做"防御性" edit(只是把 LLM 觉得"应该更新"但没证据的字段刷一遍)。**没有证据就不写**。
- 不要把对白原文复制进任何字段,也包括去引号但逐字照抄成段的"转述"(零引号规则不是改写的豁免门)。所有字段都是抽象 — 写"谁做了什么导致什么",不写"他说...她答...他又说..."的逐句还原。
- **event.summary 写入时跳过完整 CoT 或 revision_log**: 哪怕本轮 routine 兜底, 7 步 + Gate Loop + revision_log 都要走完整; 别图省事直接写第 7 步产物或跳过 revision_log。模型在长 prompt 后段会偷懒, 主动反向纠偏 — 没跑完整 CoT + revision_log 就发了 memory_node_create / memory_compact_nodes 的, 等于规范没生效。
- **多组连续压缩偷懒批量**: groups 列表里每一组 a → b → c 各自跑一遍 CoT + revision_log。**禁:** 把多组 child summaries 一次性拼起来跑一次 CoT 然后发多次 memory_compact_nodes; 在第 1 组完整跑 CoT + revision_log 后, 第 2 组开始只写第 7 步; 把第 1 组的 thought 或 revision_log 改两个词复用给第 2 组。每组的 CoT + revision_log 必须是独立、完整、当组现写的。
- **把 event 的 CoT 要求外推给其他类型**: character_sheet / location_state / 自定义类型的字段抽取按 step 6 既有节奏出工具调用,**不**走 7 步 CoT。误推会让你跑完一通 event 的 thought 之后误以为其他类型也走完了 → 其他类型不更新 → 节点漏了。

## 工具用法速查

| 时机 | 工具 |
|---|---|
| 看 schema | `memory_schema` |
| 看近期 event(连续性) | `memory_list_candidates({ types, seq_window?, exclude_recent_messages? })` |
| 下钻 rollup 看 leaves | `memory_expand_seeds({ seed_ids, hops?, include_children?, exclude_internal? })` |
| 查角色/地点是否已存在 | `memory_find_by_name({ query, types? })` |
| 看节点详情 | `memory_node_brief(id)` |
| 看节点的边 | `memory_edge_summary(id)` |
| 关键词搜索(描述性查找) | `memory_keyword_search({ query, types?, k? })` |
| 向量搜索(需配 profile) | `memory_vector_search({ query, types?, k? })` — 没配 profile 会报错,不要自动 fallback |
| 写新节点 | `memory_node_create({ type, title, fields, links?, ref? })` |
| 改字段 | `memory_node_edit({ node_id, set_fields?, clear_fields?, title? })` |
| 删节点 | `memory_node_delete({ node_id })` |
| 加/改边 | `memory_link_upsert({ source_node_id, links })` |
| 删边 | `memory_link_delete({ source_node_id, target_node_id, relation, direction? })` |
| 查可压缩组 | `memory_compaction_candidates({ type, depth? })` |
| 压缩落地 | `memory_compact_nodes({ type, child_ids, summary, fields? })` |
