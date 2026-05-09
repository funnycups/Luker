# 从零写一个 CardApp

::: tip 这篇文档解决什么问题
[CardApp Studio](/zh-CN/features/card-editor/studio) 的页面讲它有什么能力，这篇用一个真实题材演示**怎么让 Studio 从零联动起来**：自己设计 memory-graph schema、自己设计 orchestrator loop 编排、写卡 + 写卡专用世界书、最后再做一个会随对话演进的 CardApp 可视化面板。

读完你能看到 Studio 怎么把这几层堆叠在一张卡上 — 全程不用自己写代码，也不用手工去任何编辑器开关任何选项。
:::

## 你会得到什么

最终成品是一张名叫「维多利亚案宗」的侦探题材角色卡。<code v-pre>{{char}}</code> 是 1888 年伦敦的福尔摩斯式独立顾问，你扮演一位委托人（或苏格兰场来访的探长）递上案宗，跟他一起把案件查下去。

这张卡身上同时挂着：

- **memory-graph schema 派生** — `suspect` / `clue` / `forensic_site` / `witness` 四类领域节点（不是默认 schema）。**这层是给 LLM 长期记忆用的**：AI 每聊一段就把对应实体抽出来归档，跨回合 recall 时图谱有现成切片可喂回 prompt。
- **orchestrator loop 编排** — 每次 AI 回复都跑 `draft → critique → revise` 三阶段，critique 阶段强制审视"是否遗漏线索 / 嫌疑人陈述是否抵触 / 时代约束是否被违反"
- **卡专用世界书** — 「维多利亚案宗·伦敦档案」，含维多利亚伦敦背景 + 侦探办案规矩 + **状态注入条目**（含 <code v-pre>{{getvar::case_*}}</code> 占位 + 教 AI 用 <code v-pre>{{setvar}}</code> 改写变量的指令），**不动你的全局世界书**
- **「当前案宗」CardApp 面板** — 读 chat 变量呈现案件状态：案件名 / 当前阶段 / 嫌疑人 / 线索 / 取证地点。**变量由 AI 在 reply 中通过 setvar 推进**；CardApp 读 `ctx.getVariable` + `JSON.parse` 渲染。聊一句 → AI emit setvar → 面板下一帧就更新。

整个搭建过程只有 2 轮自然语言对话 — Studio 自己提案、自己写文件、自己绑字段、自己造世界书。

::: info CardApp 不读 memory-graph
图谱（memory-graph）和面板（CardApp）是**两条平行线，不直接连**。memory-graph 是 LLM 内部记忆系统，UI 不读它（`ctx` 故意没暴露 graph 读接口）。CardApp 想呈现案件状态走 chat 变量；同样的实体可以同时在图谱里被 AI 抽取归档，那是给跨回合 prompt recall 用，不是给面板渲染用的。详见[变量驱动 UI 场景](/zh-CN/features/variable-op-log#何时使用变量驱动-ui)。
:::

## 前置条件

- 一个能跑的 Luker 实例
- 已配通的 LLM API，推荐工具调用强的模型（Claude / GPT-5 等）。Studio 的工具流非常依赖模型敢于用工具
- 角色卡编辑助手在扩展面板里有"模型请求 LLM 预设" / "模型请求 API 预设"两个选项，Studio 自己跑 AI 时用的就是这两个

## 1. 建一张空白卡 → 进 Studio

打开右侧角色管理面板，点「新建角色」，起名「**维多利亚案宗**」 — 描述 / 第一条消息 / 世界书绑定全部留白，这些都让 Studio 来填。

接下来打开「扩展」面板 → 拉到「角色卡编辑助手」一节展开 → 点 **「&lt;/&gt; CardApp Studio」**：

![Studio 入口](/images/walkthrough/victorian/step-01-studio-entry.png)

::: tip Studio 也能给没启用 CardApp 的卡用
"角色卡编辑助手"针对没有 CardApp 的卡走[普通弹窗](/zh-CN/features/card-editor/popup)，含 CardApp 的卡走 Studio。但**这个 Studio 按钮可以主动把任何卡拉进 Studio**，工具集是完整版（memory-graph schema / orchestrator override / 正则脚本 / 世界书 / 卡字段全在），不像普通弹窗只够改字段和世界书条目。
:::

## 2. 一句题材需求 → Studio 自己提方案

点 Studio 左栏输入框，描述题材就行，具体怎么落地让模型来想：

```
我要从零做一张维多利亚时代伦敦侦探题材的角色卡。这卡先天就需要：

1. 自定义 memory-graph schema（按这题材该有的派生节点类型，比如嫌疑人/线索/取证地点/证人等），不要用默认 schema
2. orchestrator loop 编排（draft → critique → revise），按你最佳实践的预设来配
3. 一个绑定到这张卡的世界书（lore + 维多利亚伦敦背景 + 几条侦探办案规矩）
4. 一个简洁的 CardApp，把"当前案宗"（嫌疑人 / 线索 / 取证地点）随对话演进可视化显示出来

请按你认为合适的顺序逐步落地。每一步先把你的方案告诉我让我看一下，我点头你再写。
```

![输入题材需求](/images/walkthrough/victorian/step-02-first-prompt.png)

发出去后，Studio 不会埋头猛写 — 它先把整个方案铺开来给你看一遍。

## 3. Studio 提议 memory-graph schema

第一段它先讲数据层，把这题材该有什么节点类型推出来：Studio 主动给出四个派生类型（`suspect` / `clue` / `forensic_site` / `witness`），每个类型列出了相关的列（嫌疑人有 alibi / motive / suspicion_level、线索有 found_at / linked_suspects 等），并解释了为什么不加 `victim` / `theory`（避免 schema 膨胀，把推理留给 event 链承担）。

::: tip "派生类型"是什么
Memory Graph 默认有 `event` 这个核心类型（时间线脊柱），除此之外可以**按卡的题材自定义节点类型**。侦探卡需要的"嫌疑人 / 线索"等概念，就是这种派生类型 — 让 AI 抽取记忆时按结构归档，不用全部塞进自由文本。详见 [记忆图](/zh-CN/features/memory-graph)。

注意：**这层是给 LLM 长期记忆用的**，CardApp 面板**不读** graph。下面 Section 6 写 CardApp 时，数据来源是 chat 变量，不是 graph 节点。
:::

## 4. Studio 提议 orchestrator loop 编排

接着是生成层：它推荐 `loop` 模式 — Luker 的 loop 是一个"研究 + 总结"型的单 agent：每次回复前先跑一轮工具调用 (搜 chat / lorebook / memory 切片)，把这次回应应该参考什么压缩成一个 capsule，再喂进主生成。Studio 给这个研究 agent 写的 system_prompt 是"内审脑"：强制它在 finalize 之前对照三件事 — 是否遗漏线索、嫌疑人陈述是否抵触 graph 已存的 alibi/motive、维多利亚时代礼仪 / 阶级 / 技术约束有没有被违反。

这是 Studio 的 AI 默认推荐 loop 的原因 — 多数卡用 loop 比单跑生成多一层把关，推理类 / 长跑类卡尤其受益。

## 5. 同意后，Studio 一次性落地全部产物

回个"全部确认，按你这方案走，直接落地"，Studio 就开始批量发起工具调用：

![Studio 落地全部产物的工具调用](/images/walkthrough/victorian/step-05-tool-calls.png)

一轮里它做完了：

- **`character_update_memory_graph_schema`** — 把四类派生节点 schema 写进卡（只动这张卡，不污染全局）
- **`character_update_orchestrator`** — 把 draft / critique / revise 的三阶段 loop 配置写进卡（同样 character-scoped）
- **`worldinfo_create_chat_book`** + **`worldinfo_replace_entries`** — 创建卡专用世界书 + 一次性写入维多利亚伦敦背景 / 侦探办案规矩 / **状态注入条目**（含 <code v-pre>{{getvar::case_*}}</code> 占位 + 教 AI 用 <code v-pre>{{setvar}}</code> 改写变量的指令）/ 苏格兰场文化 / 白教堂区背景等条目
- **`character_update_fields`** — 写 description / personality / first_mes / scenario / 把 `world` 字段绑定到刚建的世界书

每个工具调用都会**弹出审批 + 完整 diff**让你看清楚改了什么 — 一般可以放心点"批准"全过。

::: tip 状态注入条目是变量驱动 UI 的核心枢纽
"状态注入"那条世界书条目里同时含 <code v-pre>{{getvar::case_*}}</code>（让 AI 在每次 prompt 装配时看见当前案件状态）和**教学用的 <code v-pre>{{setvar}}</code> 宏**（指引 AI 在它的 reply 里发 setvar 来推进案件）。AI 读 prompt → 看见当前 case_phase / 嫌疑人列表 → 在新 reply 里 emit <code v-pre>{{setvar::case_phase::勘察现场}}</code> 等宏 → op-log 把字面量从 mes 里剥掉同时写进 `chat_metadata.variables` → CardApp 读 `ctx.getVariable` 渲染。**这是闭环**。详见[逐楼层变量](/zh-CN/features/variable-op-log)。
:::

::: tip 正则脚本也能管
Studio 也能写 / 改正则脚本（裁掉 thinking 标签、转换显示格式等），需要时让它做即可 — 这张测试卡里我们没用上，不需要也别强加。
:::

## 6.（继续）给案宗做一个会动的可视化面板

最后一步发一句：

```
继续。现在做最后一步——CardApp「当前案宗」可视化面板。
读 chat 变量呈现案件状态：案件名 / 阶段 / 嫌疑人 / 线索 / 取证地点。
布局照之前的草案，每条 AI 消息生成完毕后刷新一次。
风格：维多利亚雾都氛围（暗色羊皮纸纸感、衬线字体、暗红/暗黄边）。
样式 / 配色 / 取值细节你定。所有 cardapp 文件写入审批我都批准。
```

Studio 就把 CardApp 写出来了。它读的是 chat 变量（`case_name` / `case_phase` / `case_suspects` / `case_clues` / `case_sites`），列表型变量是 JSON-serialized 数组，CardApp 用 `ctx.getVariable + JSON.parse` 拿到再渲染。**不读 memory-graph**——graph 是 LLM 的长期记忆层，跟 UI 不在一条数据链上。

## 7. 端到端跑一次

退出 Studio，正常发 RP 消息。我们丢一份伦敦白教堂的案宗给 <code v-pre>{{char}}</code>：

> "侦探，白教堂有人深夜被害，死在自家阁楼上。死者是 35 岁的私塾教师莫妮卡·惠勒，丈夫亨利·惠勒报的案。我刚从苏格兰场调档过来，需要您一起把脉。"

### a. 聊天回复 — 卡设定全部生效

![端到端聊天回复](/images/walkthrough/victorian/step-07a-chat-reply.png)

回复体现了所有层的协同：推理有据（具体物证 → 推理 → 下一步取证方向）、维多利亚阶级氛围、技术约束（没有指纹比对、没有电话）、<code v-pre>{{char}}</code> 自带的"现场不破坏 + 证据链"办案规矩。这些是世界书条目 + character 字段 + orchestrator capsule 共同把控出来的。

::: tip 同时 AI 在这条 reply 里 emit 了 setvar
打开消息底部的小烧瓶图标（fa-flask），能看到这条 reply 实际记录了几条 var_ops，比如 `setvar case_name = 白教堂阁楼命案 · 莫妮卡·惠勒` / `setvar case_phase = 勘察现场` / `setvar case_suspects = [{...亨利·惠勒...}]`。这些字面量在显示前就被 op-log 从 mes 里剥掉了，所以读者看到的是干净叙事，但变量已经更新。
:::

### b. 看 orchestrator 在背后做了什么

每次回复之前，卡上配置的 loop 编排会先跑一轮"研究 + 总结" — 调用 chat / lorebook / memory 的搜索工具，把这次回应需要参考的上下文压缩成一个 capsule，再喂给主生成。点开扩展面板里 Orchestrator 一节的「View Runtime Trace」，能看到这次 loop 跑了哪些步、调用了哪些工具、最终如何 finalize：

![Orchestrator 运行轨迹](/images/walkthrough/victorian/step-07b-stage-output.png)

如果 loop 出错（API 配置不对、超时等），这里会标红失败点，并自动 fallback 到无 loop 的直生成 — 端到端体验依然连续，你只是少了那一层内审 capsule。

### c. 看 memory-graph 在长期积累什么

点扩展面板里 Memory 一节 →「查看图」，能看到当前对话攒到的图：

![Memory Graph 视图](/images/walkthrough/victorian/step-07c-memory-graph.png)

节点是按之前设计的 schema 派生的（`suspect`、`clue`、`forensic_site`、`witness`、`event`），边记录关系。**但这是给 LLM 用的**——下次跨回合需要 recall 亨利·惠勒的相关上下文时，图谱会把存的切片自动喂进 prompt。CardApp 面板**不读这里的图**——面板的数据来源是 chat 变量。两条平行线，分工互不重叠：图谱负责跨回合长期记忆，变量负责当下 UI 同步。

## 8. 看 CardApp 面板随聊天演进

继续聊。每发一句，AI 在 reply 里 emit <code v-pre>{{setvar::case_*::...}}</code> 等宏推进案件状态，CardApp 的「当前案宗」面板就会刷新：

![CardApp 面板第二轮后：嫌疑人 / 线索 / 取证地点 逐条浮现](/images/walkthrough/victorian/step-06b-cardapp-turn2.png)

聊了两轮之后——AI 在 reply 里 emit 了 <code v-pre>{{setvar::case_suspects::[...]}}</code> 等宏，op-log 把 setvar 字面量从 mes 里剥掉同时写进 `chat_metadata.variables`，CardApp 通过 `ctx.getVariable('case_suspects')` 读到 JSON 数组，渲染成嫌疑人栏的卡片。**这是变量驱动 UI 的标准玩法**。

状态注入世界书条目把同样的 <code v-pre>{{getvar::case_*}}</code> 也往 prompt 里贴一份——所以 AI 自己也始终看得见"目前嫌疑人有谁、线索有哪些"，下一回合 emit 新 setvar 时不会跟之前矛盾。

::: info 跟 memory-graph 怎么分工？
- **chat 变量**：当下案件状态、面板数据、prompt 同步——AI emit setvar，op-log 字面量替换 + 落库 + replay。
- **memory-graph**：跨回合长期记忆，AI 跨回合 recall 用——AI 在叙事里描写"看见什么 / 跟谁说什么"，提取器异步抽节点。
- 两者**分工不重叠**，CardApp **只读变量**。
:::

## 提示词小抄

跑过一轮你会发现，有效的 Studio prompt 的关键不是字数，而是**说清楚方向 + 把决定权放给 Studio**：

1. **题材 + 风格说清楚就行，实现交给 Studio**
   - ✓ "维多利亚伦敦侦探卡，需要 memory-graph schema 派生 + loop 编排 + 卡专用世界书 + 可视化面板"
   - ✗ "在 character.data.extensions.memory_graph.schema 里加一个 type=suspect 的对象，字段是 alibi、motive..."

2. **对 schema / loop 这种结构性决策，让它先提案再落地**
   - 它默认就这么做（系统提示词内置了这个习惯），你只要在它提案时盯一眼，有意见就直接说
   - 觉得 schema 多了一类："witness 砍掉合并进 suspect" — Studio 会改
   - 觉得 loop 想换 agenda 模式："换 agenda，让规划阶段决定优先查哪条线" — 它也会改

3. **同意后明确告诉它"不要再来确认"**
   - 不然每个工具调用都来一遍可能很慢
   - "按你这方案走，工具调用我都批准，直接落地"

4. **不会的就让它解释**
   - "为什么 victim 不放进 schema?" — 它会告诉你"这种少量的固定信息写在 first_mes 或世界书 entry 里更稳，放 schema 反而冗余"

5. **CardApp 数据来源是 chat 变量，不是 memory-graph**
   - memory-graph 是 LLM 长期记忆，CardApp 不读
   - 你不需要在 prompt 里特意说，Studio 默认就这样
   - 如果你不小心写了"让 CardApp 读 memory-graph 节点"这种话，Studio 会推回去并解释为什么不该这样

## 下一步

- [CardApp Studio](/zh-CN/features/card-editor/studio) — Studio 的能力清单、界面布局、工具集
- [记忆图](/zh-CN/features/memory-graph) — Memory Graph 概念、默认 schema、派生类型机制
- [Loop 模式](/zh-CN/features/orchestrator/loop) — Orchestrator loop 编排详解
- [逐楼层变量](/zh-CN/features/variable-op-log) — 变量 op-log、变量驱动 UI 场景
- [角色卡开发者指南](/zh-CN/development/card-developers) — `ctx` API 全集 + CardApp 创作约定
