// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

/**
 * Default prompt strings + per-type extraction instructions for the
 * memory-graph extension.
 *
 * The prompts here are the SOURCE OF TRUTH for both:
 *   - the in-extension extract / compress LLM calls (consumed by main.js)
 *   - the in-extension settings UI's "reset to default" button
 *
 * Why a separate module: these strings are large, change as a coherent set
 * (extract + compress + per-type rules + thread schema all evolve together),
 * and are also mirrored by the orchestrator's memory_curator skill. Keeping
 * them in one place makes iteration manageable; main.js just imports the
 * constants it needs.
 */

// Event summary writing standard (event.summary 字段专用规范).
// Shared between extract and compress prompts — both inline it.
export const EVENT_SUMMARY_RULES_BODY = `# Event summary writing standard (event.summary 字段专用规范)

适用范围: 本规范**只**约束 event.summary 字段的最终字符串。其他字段 (character_sheet 的 traits/identity/aliases、location_state 的 state/controller、thread 的 note 等) 不在此规范范围内。

## 0. 核心定位

event.summary 是**剧情记录**——一段足以让没看过原文的 RP 模型重建剧情线、关系状态、未结线索的自然语言**散文段落**, 配合三段可选的结构化 section 索引出无法从 prose 推断的关键信息。

**散文 ≠ 编号列表**。如果你写出来的 summary 像 "1) A 做 X 2) B 做 Y 3) C 做 Z" 这种用数字编号串起来的紧凑短词链, 这是 outline, 不是 prose, **必须重写**。prose 是"A 在 X 之后决定做 Y, B 因此改变了对 A 的态度"这种带因果与时序连接词的完整句子序列。

它**不**是:
- outline / 编号列表: 不用 \`1) ... 2) ... 3) ...\` 不用 \`- ...\` \`* ...\` 把事件项串起来; 用完整句子和连接词
- 小说回放: 不复述对白原句, 不堆砌画面 / 微表情 / 节奏感
- 极致压缩的目录: 不为追求短而把因果链 / 关键决策的具体内容砍掉
- 万能的剧情快照: 不写下游 RP 推不出来的物件外观 / 姿势细节 / 装饰

写作锚点: 假设这段 summary 是 30 轮后下一个 RP 模型唯一能看到的本场景信息。它读完后能不能接住「上次到哪里, 谁现在欠谁什么, 哪些事再也回不去了, 哪些线还吊着」?

## 1. 输出格式

\`\`\`
时间: <在 RP 世界内的具体日期 / 时间>
地点: <在 RP 世界内的具体地点>

<prose body — 一段或多段自然语言, 描述本批次发生的事件骨架、关键决策、因果关系>

不可逆:
- <每条一行, 物理 / 身份 / 关系 / 能力 / 关键物件层面的永久性变化>

未结:
- → thread "<thread 节点的 title>"

原文摘录:
- <label>: "<verbatim quote>"
\`\`\`

三段 section (\`不可逆\` / \`未结\` / \`原文摘录\`) **默认完全不写**, 它们是 prose body 之外的*关键信息索引*, 不是表单要填的空。本场景没有该类内容 → 整段 section 不出现 (**不要**写 "无", 不要留空 header, 不要写占位符 "(none)" / "—")。

### 1.1 Prose body 的硬性结构约束

prose body **必须是连贯的自然语言段落**, 由完整的句子组成。

**禁止以下写法 (出现即重写)**:

- **数字编号项** (\`1) ...\`, \`2) ...\`, \`1. ...\`, \`①\`, \`(1)\`): prose body 不是 outline, 用句号断句不用编号
- **项目符号** (\`- ...\`, \`* ...\`, \`• ...\`): prose body 内不出现; 这种符号只在 §3 的三段 section 里出现, 不在 prose 里
- **「主语 动词 宾语」式短词链**: 没有助词、没有从句、没有上下文的紧密短语链 (如 outline 那样把主谓宾用空格塞在一起、用分号或括号补丁串多条) 是 outline 的写法, 不是 prose。改写成完整句子, 用助词、从句、连接词承载语义
- **任意形式的"列表 dressed up as sentences"**: 把若干 outline 项之间塞分号当成 prose 是不行的。如果你写出来像把多条独立条目用分号串起来, 重写为真正承载因果 / 时序连接词 (因此 / 之后 / 但是 / 于是 / 同时 / 直到 / 一旦) 的真实段落

**rationale**: prose 的目的是承载因果链和上下文权重; outline 把这些都丢了。检查写出来的 prose body, 应该读起来像一段叙事文字, 不像一份会议纪要。

## 2. Prose body 准入与剪裁 (核心规则)

### 2.1 颗粒度准则 (默认一句过场 + 三类例外允许展开)

prose body 的**默认颗粒度**: 一个完整事件单元 = 一句话, 内容覆盖
(a) **事件名** — 谁做了什么对谁
(b) **状态变化** — 结果是什么 / 下一刻起什么 carry-over 了

**只有以下三类内容允许展开为更具体的描述**, 其他一律一句过场:

- **(a) 跨场景未结伏笔的钩子内容** — 该悬念在后续场景才会被触发或解决, 钩子的**具体内容**必须写出 (具体调查的目标 / 等待触发的具体事件 / 离场角色去做的具体事), 否则下游 RP 模型不知道伏笔指向什么
- **(b) 不可逆里程碑的具体形态** — 失贞 / 失肢 / 死亡 / 关系破裂 / 获赠关键物等不可逆事件, 必须写出其**具体形态** (谁对谁做了什么造成的什么具体不可逆变化)。但形态本身一句话足够, 不展开过程曲线。
   - **形态用功能性标签**: "X 失贞" / "X 怀孕" / "X 致死" / "X 致残" / "X 关系破裂" 等抽象描述, **不**写身体部位过程 (例: 子宫颈被顶穿 / 肠壁被插穿 / 阴道被贯穿 / 颈动脉被切断 等具体部位的具体动作)
   - **体液不入不可逆**: "X 被内射"可以作为不可逆事件描述出现 (与"失贞"绑定时可一句过场), 但**不写**具体身体部位的内射 (子宫内射 / 肠内射 / 阴道内射 等), 也**不写**喷射节奏 / 体液种类 / 潮吹 / 量级。"内射" 这两个字本身够用
- **(c) 关键决策的具体条款** — 答应做什么 / 价码是什么 / 期限是什么 / 立誓在何时何地做什么。条款的**具体内容**必须写出, 否则下游 RP 模型不知道双方约定的是什么

**其余事件 (战斗 / 性事 / 调情 / 协商 / 移动 / 调查 / 对白) default 用一句过场陈述**, 不展开过程纹理。即使该事件本身重要 (例如本场景的核心剧情就是这场战斗), 只要它的核心信息能用"事件名 + 状态变化"一句覆盖, 就用一句; 它的具体招式 / 姿势 / 反应曲线 / 体液 / 心跳等过程纹理不属于"重要"的范畴, 是过程纹理。

**颗粒度反 pattern (出现即重写为一句)**:
- 把一个事件拆成多个子动作分别描述 (动作 → 反应 → 再动作 → 再反应) → 合并为一句结果
- 把一次性事拆成姿势 / 部位 / 抽插 / 反应 / 体液 / 完结的子段 → 合并为一句, 这一句可以**概括体位 + 总体反应** (例: "X 与 Y 后入式性事, Y 经历首次承受过程并适应", 而不是 "X 让 Y 趴下→双手撑住→翘臀→插入→Y 哭叫→适应→抽插→Y 痉挛→X 内射→精液溢出"); 砍掉的是中间动作链 / 体液描写 / 情绪反复 / 喷射节奏 / 心跳曲线; 保留的是体位概括 + 总体反应 + §2.1 (b) 不可逆变化形态 (如失贞)
- 把一场战斗拆成"出招 → 反应 → 反击 → 击中"的子动作链 → 合并为一句, 这一句可以**概括战法 + 总体战果** (例: "X 以近战正面硬抗击毙 Y", 而不是 "X 出招→Y 闪避→X 反击→击中→Y 倒地→X 补刀"); 砍掉的是招式名细节 / 反应曲线 / 伤情描写; 保留的是战法概括 + 战果 + §2.1 (b) 不可逆变化 (重伤致残 / 致死 / 武器或据点的具体永久变更)
- 把一次调情拆成"接近 → 触碰 → 反应 → 加深"的肢体接触链 → 合并为 "X 对 Y 调情, 二人关系拉近 / Y 未真正抗拒" 一句; 砍掉中间触碰链和情绪曲线
- 把一次协商拆成"开口 → 表态 → 反驳 → 退让 → 达成"的对白链 → 合并为 "X 与 Y 就 Z 达成 (条款: ...)" 一句; 这里 §2.1 (c) 的条款**必须**写, 但条款本身一句话 (谁付什么 / 谁做什么 / 期限) 足够, 不展开协商过程
- 把一次调查拆成"取证 → 比对 → 推理 → 揭露"的步骤链 → 合并为 "X 调查 Y 得出结论: Z" 一句

**特别强调 — 性事 / 战斗等具有强烈过程感的事件**:
即使原文用了大量篇幅 (数千字) 详细描写过程, prose body 仍然 default 一句过场。"原文写得详细" **不**是展开理由 — 原文的详细描写是 RP 文学需要, 摘要的目的是**剧情骨架 + 状态变化**, 不是回放过程。

允许保留的: **体位概括** (后入 / 骑乘 / 传教士 等单一名词指代姿势, 不展开姿势调整的过程) + **总体反应** (适应 / 抗拒 / 顺从 / 高潮 等总体定性, 不展开反应曲线) + **总体情绪走向的概述** (从抗拒到顺从 / 从警惕到信任 / 从震惊到接受 等用一两个词概括的整体情绪变化, 不展开曲线; 见 §2.2 B 类) + **§2.1 (b) 不可逆变化的形态** (失贞 / 怀孕 / 受伤致残 等)。

禁止保留的: 体液描写 (白浊 / 喷射 / 溢出 / 见红 等具体体液) / 子动作链 (撕开 → 抚摸 → 加速 等动作分解) / 情绪流水帐 (拆成多个阶段逐一描写每阶段的心理状态, 即把"从抗拒到顺从"展开成"先是惊恐, 然后哭叫求停, 接着身体开始适应, 渐渐沉浸, 最后臣服" 这种小作文式分阶段铺陈) / 心跳曲线 / 喷射节奏 / 部位特写。

判断标准: 删掉所有体液 / 子动作 / 情绪流水帐描写, 下游 RP 模型在 30 楼后还能不能准确接续这段剧情? 能 (只要保留体位概括 + 总体反应 + 总体情绪走向 + §2.1 (b) 不可逆变化) → 默认状态就够了, 不展开。

### 2.2 心理描写 A/B/C 三分类

心理 / 情感描写按**来源**和**性质**分三类, 不同分类适用不同处理:

- **A 类 — 角色明示视角内容**: 原文中以 \`*...*\` 等明确的内心独白标记包起来, 或角色当场用第一人称说出自己的内心。**允许写入 prose**, 用第三人称客观语转述其要点, 不带原文情绪修饰 (转述 ≠ paraphrase, 见 §4.1; 用通用描述, 不用原文的临时形容词)
- **B 类 — 关系 / 状态层面的定性变化, 或事件内的总体情绪走向概述**:
    - **跨场景定性变化** (carry-over): 跨场景仍然成立的关系定性变化 (例如"二人因此关系拉近"/"X 对 Y 的态度从警惕转为信任"/"X 对 Y 的信任彻底崩塌")。判定: 故事时间往后推 24h 仍然约束剧情走向
    - **事件内总体情绪走向**: 单个事件中角色的整体情绪变化, 用**一两个词的概述**指代 ("X 从抗拒到顺从" / "Y 从震惊到接受" / "Z 全程紧张戒备")。**允许**, 因为它是事件骨架的一部分 — 没有这层概述, 下游 RP 模型无法理解事件的情感走向。**判定: 必须用一两个词的概述**, 不能展开成阶段性的小作文 (见 §2.1 性事 / 战斗段 "禁止情绪流水帐" 条款)

  两种 B 类都**允许写入 prose**, 用第三人称客观语, 一句过场
- **C 类 — narrator 推测的单场景瞬时情绪 / 内心流水帐**: 叙述者替角色编的瞬时反应 / 情绪曲线 / 暗自吐槽 / 心跳描写 / 微表情解读。**禁止写入 prose**, 砍除。即使原文文本里有这些描写, prose 不复述; 它们与子动作链 / 体液描写同类, 属于过程纹理

**判定测试**: 看到一句心理 / 情感描写时, 问:
- 它在原文里有明确的内心独白标记 (\`*...*\` 或角色第一人称说出来) 吗? — 是 → A 类, 留 (但转述为第三人称客观语)
- 它是跨场景仍然成立的关系 / 状态定性变化吗? — 是 → B 类, 留 (一句过场)
- 都不是, 是 narrator 替角色编的瞬时反应 / 情绪曲线 / 暗自吐槽 / 心跳描写 / 微表情解读 → C 类, 砍

不确定 → 按 C 类处理, 砍。

### 2.3 单句判据 (通过 §2.1 + §2.2 后, 剩余句子还需通过本节)

§2.1 (颗粒度) + §2.2 (心理分类) 决定了"哪些内容根本不该出现"; 通过这两关的句子, 还要再通过单句**删除测试**:

> 如果删掉这一句, 30 楼之后某个 RP 模型会不会因此对当前剧情线 / 关系 / 状态做出**具体**的错误判断 (写错某个状态值、忘掉某个具体承诺的内容、引用某个剧情节点时编造细节、误判两个角色当前的关系定性、错过某个仍待触发的线索)?

- 能给出**具体**的错误后果 → 留
- 给不出, 或只能说 "失去画面感 / 失去氛围 / 失去节奏 / 失去细节 / 模型可能会需要这个 / 缺少这个会不完整" → 砍
- 不确定 → 按砍处理

**"下游会需要这个" 不是具体后果**, 必须能指明会需要它来做什么具体动作或判断, 否则按砍处理。

**给不出 ≠ 留着保险**。无具体下游后果的句子是噪音, 会拖低真正关键信息的密度。

### 2.4 内容选择倾向

应写 (default 留):
- 事件骨架 (谁做了什么, 对谁) — 一句过场
- 状态变化 / carry-over (不可逆变化 / 关系定性变化 / 跨场景钩子) — 一句过场
- 心理 A 类 (原文明示视角) + 心理 B 类 (跨场景关系变化) — 一句过场
- 因果关系 (为什么这事发生, 为什么这个反应) — 一句过场
- 可作为下游 RP 触发条件的状态信息 (在哪个地点, 在和谁独处, 处于什么大背景下) — 一句过场

应写 (允许展开为更具体描述, 由 §2.1 (a)(b)(c) 三类例外触发):
- 跨场景未结伏笔的具体钩子内容
- 不可逆里程碑的具体形态
- 关键决策的具体条款

**不应写**:
- 对白原句的转述 (即使核心意思在)
- 微表情 / 姿势 / 衣物状态 / 物件外观 (除非属于 §2.1 (b) 不可逆里程碑或 (c) 关键决策的载体)
- 单次画面纹理 / 子动作链 ("抬手→放下→又抬起")
- 体液 / 性事生理曲线 / 反应曲线 (§2.1 过程纹理)
- 心理 C 类 (§2.2: narrator 推测的瞬时情绪 / 暗自 / 心跳 / 微表情解读)
- 钩子 / 伏笔 / 元叙述 / 未来预告 (这些走 thread 节点 + 未结 section)
- 叙述者的情感评论 ("这一刻 X 真正爱上了 Y")

### 2.5 信息密度对称

prose body 的长度应与本批次**真实发生的事件量 × 颗粒度**对称, 不与原文字数对称:
- 原文 10k 字但实际只发生 1 件事 + 0 个 §2.1 (a)(b)(c) 例外 → prose 短 (一两句话)
- 原文 3k 字但发生了 5 件互相缠绕的事 + 多个不可逆里程碑 → prose 长 (多段)

**不设字数上下限**。由 §2.1 颗粒度准则决定每句去留, 由 §2.2 决定心理描写去留, 由 §2.3 单句判据兜底, 由实际事件量 × 颗粒度共同决定段落数。

写完 prose 后做最后一次度量: 句数应**显著少**于"如果按子动作 / 反应曲线 / 体液 / 姿势 / 心跳逐项写"会有的句数。如果你的草稿读起来已经像小说回放, **回 §2.1 重审**, 多半是过程纹理没砍干净。

### 2.6 NPC baseline / backstory 路由 (event ↔ character_sheet 分流)

本批次某 NPC **首次出场**或在场时**讲述自己的来历 / 出身 / 长期背景 / 长期收藏 / 长期家族关系 / 长期能力来源**等内容时, 这些信息**不属于 event prose**, 应分流到该 NPC 的 character_sheet:

- **NPC 自述长期来历 / 出身 / 教育背景 / 家族 / 故乡 / 信仰 / 长期组织归属** → 写入该 NPC character_sheet 的 \`identity\` / \`traits\` / \`backstory\` (如有此字段) 等字段, **不写入 event prose**
- **NPC 的长期持有物 / 长期收藏 / 长期遗物** → 路由到该 NPC character_sheet 的 \`inventory\` 或 \`traits\` (如属于性格描述), **不写入 event prose**
- **NPC 的长期能力 / 修为 / 称号 / 等级** → 路由到该 NPC character_sheet 的 \`identity\` / \`traits\`, **不写入 event prose**

**event prose 只写**该 NPC 在本批次**做了什么** / **答应了什么** / **被发生了什么不可逆变化** — 即与本批次事件链直接相关的具体动作和状态变化。NPC 自己的 baseline backstory **永远走 character_sheet**, 即使是该 NPC 首次出场也一样。

**反 pattern (出现即砍, 改路由)**:
- 在 event prose 里花一整段写某 NPC "X 多年前曾是 Y / 在 Z 学习过 / 来自 W 星球 / 持有祖父留下的 V" — 这些都是该 NPC 的 baseline backstory, 与本批次事件无直接因果, 砍出 prose, 写进该 NPC 的 character_sheet
- 在 event prose 里详写某 NPC 的长期收藏品种类和数量 — 走 character_sheet.inventory 或 character_sheet.traits
- 在 event prose 里复述某 NPC 长篇大论的人生故事 / 信仰宣言 / 哲学观点 — 走 character_sheet, prose 里最多一句指出"NPC 向 X 倾诉自己的来历, 二人因此关系拉近" (这里写的是 §2.2 B 类关系变化, 不是 backstory 本身)

**判定测试**: 看到 prose 里有 NPC 个人信息时, 问"这个信息是本批次发生的事件, 还是该 NPC 长期就具备的属性?" 长期属性 → 砍出 prose, 写进 character_sheet; 本批次发生的 (例如本批次某物从该 NPC 手中转给主角, 或本批次该 NPC 经历不可逆变化) → 保留在 prose。

## 3. Sections 准入 (三段共同的硬约束)

每段 section 的每一行都必须**同时满足三条**才能写:

1. **类型对**: 内容属于该 section 定义的范畴 (见 §3.1-3.3)
2. **prose 里已说**: section 是 prose 之外的索引, 不是新信息。如果 prose body 里没提这个事, section 不能凭空冒出来
3. **删掉会致错**: 套用 §2.3 单句判据 — 删掉该行后, 30 楼之后某个 RP 模型在接续剧情时会做出**具体**的错误判断 (例如把已失贞写成处女 / 把已破裂关系写成融洽 / 复述某段载体文字时偏离 wording artifact 自己编)

三条任一不满足 → 该行不写。任一 section 全行都不满足 → 该 section 整段不出现。

**强烈的默认状态是空**: 大多数 RP 事件只有 0-1 段 section 有内容。三段都满的事件极少见。如果你的草稿里三段都填了几行, 大概率是 "类型对" 一条把关松了 — 回去用更严格的范畴定义重审。

### 3.1 不可逆 — 准入定义

physical / identity / relationship / ability / 关键物件层面的**永久性**变化。判定核心: 故事时间往后推 24 小时仍然约束剧情走向。

- 适用: 失贞 / 怀孕 / 失肢 / 失明 / 致死 / 关系正式确立或破裂 / 身份转变 (X 成为 Y) / 能力觉醒或失去 / 获得或失去关键剧情物
- 不适用: 情绪 (生气 / 害羞 / 嫉妒) / 姿态 (跪下 / 站起) / 临时状态 (醉了 / 困了 / 受轻伤) / 任何下一场景可以恢复的状态

每行写法: 一句话陈述变化, 不带因果或上下文 (那些应该已经在 prose 里), 不带形容词。

### 3.2 未结 — 准入定义

指向一个**具体未来动作**的悬念。该动作有可识别的触发条件或目标, 不是泛指的 "关系还没解决" "氛围还紧张"。

- 适用: 谁答应了谁做什么 / 谁在等谁 / 谁写了信没发出 / 谁在追查什么 / 谁立下了誓言指向某具体行为
- 不适用: 模糊情感悬念 / 还没明说的暧昧 / 双方都没意识到的隐患

写法: 每行必须是 \`→ thread "<thread title>"\`, 指向**同一批次产出的 thread 节点**。具体内容由 thread 节点承载, section 行只起索引作用。如果该悬念值得 emit thread, 这一行就写; 不值得 emit thread, 这一行就不写 — 两者绑定, 不可独存。

### 3.3 原文摘录 — 准入定义

满足以下**两个条件之一**, 并且**改述会丢失承载下游 RP 行为的具体词句**:

- (a) **文本本身具备世界内持久性**: 落在某种载体上的文字 (信 / 刻字 / 公告 / 契约条款 / 公开播报 / 笔记 / 文档 / 标语)
- (b) **被仪式性框定的口头表达**: 誓约 / 临终遗言 / 预言 / 咒语 / 谜面 / 公开宣告 / 命名仪式中的具体用词

普通对话**不适用**, 即使内容关键 — 用 prose body 描述其要点即可。

判定测试: 把这段引用改成你自己的话来描述, 下游 RP 模型在引用此事 / 复述此事 / 与此事内容互动时, 失去的是**仅仅 flavor**, 还是失去了**无法重建的具体 wording artifact** (那个誓约的精确用词, 那封信里的关键句, 那段契约的具体条款)? 前者 → 不写; 后者 → 写。

写法: \`- <label>: "<verbatim>"\`。label 是这段文字的**世界内属性** (例如 "X 写给 Y 的信 (未发送, 草稿)" / "刻在 X 上的铭文" / "X 的公开宣告" / "X 的临终遗言")。引用应当尽量短, 长信只引"业务段", 寒暄 / 反复表达 / flavor 描写**砍光**。

## 4. 词汇结构黑名单 (按结构识别, format-agnostic)

下列结构在 prose body / 任意 section 行内**都不允许**出现。它们是 LLM 写 RP-style 总结时常见的**结构性 bug**, 不分场景:

### 4.1 paraphrase 残留
任何原文对白里被某角色当场说出口的非通用词语, 包括: 临时戏称 (场景里 NPC 给某人起的临时昵称) / 口头禅 / 感叹词 / 临时情绪短语 / 现场创造的代号 / 临时形容词 / 临时身份称呼。通用动词 (说 / 看 / 走) 和专有名词 (角色本名 / 地名 / 组织名 / 已确立的剧情节点名) 不算 paraphrase 残留, 可以用。

**operational 扫描法 (必跑)**: 在最终自检前, 扫描 prose body 里**每一对引号 / 任何短语化的描述**:
- 双引号 / 单引号包起来的任何字符串, 如果不是 §3.3 admitted 的 artifact verbatim → 砍引号, 改成第三人称客观描述。例: 把"以 X 自我介绍" 改成 "以恭维口吻向 Y 自我介绍"; 把"承诺 X" 改成 "承诺将带 Y 去做 Z (具体行为)"
- **不带引号但内容明显是角色台词的转述** (例: "X 直白调侃她是漂亮又有钱的大小姐"——"漂亮又有钱的大小姐"是角色当场说的) → 砍, 改成"X 用调侃的方式表达对她身份和外貌的兴趣"
- **临时身份称呼反复指代** (大堂经理 / 总经理 / 临时管家 / 路过的医生): 第一次提到时一句话点明身份, 之后用本名 / "对方" / "他" / "她" 代词指代, 不要在 prose 里反复使用"经理"/"管家"这种临时称呼

**反向 — 这些不是 paraphrase 残留, 不要误砍**:
- **角色之间公认的关系定位词** (后宫成员 / 师徒 / 兄弟 / 专属 X / 资金供应者 / 守护者 / 复仇对象 等): 即使该定位词最初是某角色在场景里说出来的, 只要双方在剧情里**接受并继续使用**, 它就是 §2.2 B 类**关系定性变化** carry-over, 必须保留 (用 prose 自然带出, 不必加引号)
- **该 RP 世界设定里固定命名的物件 / 招式 / 等级 / 系统术语** (角色卡 / 世界书 / 系统机制声明的官方名): 在世界设定层面就是该物件 / 该招式的真实名字, 即使该名字在原文里被角色提及, 也不算 paraphrase。例: 角色卡声明的某武器固定名 / 系统机制名的技能名 / 已被剧情多场景反复指代的某物件名 → 保留, 不抽象化
- **NPC 长期持有的具体物 / 长期收藏 / 长期持有的标志物**: 这些是 §2.6 该 NPC 的 character_sheet.inventory 内容; 在 event prose 里**首次出现且与本批次事件直接相关时**可保留具体名称 (例: 该物在本批次从 A 转给 B 是不可逆变化), 但更优做法是路由到 character_sheet (见 §2.6)

判定: 把 prose 中的每个非通用词单独问"它是不是某个角色在原文里**当场**说出口的字词, 或对某场景临时角色的形容?" 是 → 砍, 换通用描述。

**为什么如此严格**: paraphrase 残留是污染下游 RP 模型的主要源头 — 摘要里出现某个临时戏称, 下次召回时下游模型把它当成"该角色的固有称呼"反复使用, 形成滚雪球污染。

### 4.2 元叙述 / 钩子词
钩子 / 伏笔 / 铺垫 / 埋下 / 暗示 / 预示 / 为后续 / 为下章 / 为下次 / 桥段 / 篇章 / 章节级转折 / 序章终 / 序章收束 / 下一目标 / 待后续场景兑现 — 整类砍。**元叙述标签** (原创主角 / 原作主角 / 主角 / 配角 / 反派) 也整类砍, 这些是叙述者视角的剧情功能定位, 不属于角色 in-world identity。

为什么砍: 这些词把"叙述者认为这件事会带来后续"显式写进了 memory; 下游 RP 模型看到 future-pointing tag 会被引导去做对应行为, 偏离真实剧情。**事件就是事件, 不预测未来**。

如果某事件真的留下了 cross-scene 悬念 → emit thread 节点 + 在 \`未结\` section 写一行 \`→ thread\`, **不要**在 prose 里写 narrator 评论。

### 4.3 现场事件命名 / 升华副词
正式 X / 终身 X / 永久 X / 全程 X / 首次 X / 彻底 X / 真正 X / 至此 X / 标志着 X / 上交 X / 献身 / 定型 / 定锚 / 定调 / 宣告归属 / 进入新阶段 / 开启 X 模式 — 整类砍。这些都是给普通动作贴上"这件事很重大"标签的副词/前缀, 砍掉留下的动作动词本身已经足够 — 下游 LLM 会自行判断重要性。

例外: 剧情主线明确**反复命名**的事件序列序数 (被多场景反复提及的固定命名) 可保留。其他次数描述序数 ("第七招" / "第二次告白") 一律改为"再次"或删除。

### 4.4 契约词族
契约 / 协议 / 誓约 / 凭证 / 条款 / 承诺书 / 永约 / 立约 / 缔结 / 宣言 / 成交 / 签署 / 口约 / 立下 / 兑现 — 整类砍。

替代写法: 直接写"X 答应 Y 做 Z (条件: ...)" / "X 与 Y 互相承诺 Z" / "X 答应定期给 Y 一笔款项"。**不要**把普通承诺包装成"立约 / 签下契约 / 缔结永约"——这些词会让后文 LLM 把它当成不可逆的神圣契约不断引用。

如果该承诺/誓约带有世界内的仪式性框定 (举行了宣誓仪式 / 落在了书面契约上), 该 wording 可走 \`原文摘录\` section, 不走 prose body 的契约词。

### 4.5 升华套话
完成从 X 到 Y 的升级 / X 段升级 / X 重身份升级 / 锚定 / 固化 / 拉满 / 封顶 / 进入新阶段 / 标志着 / 从此 X / 至此 X / 彻底切换 / 彻底翻转 — 整类砍。

### 4.6 AI 自造标签
AI 用「形容词+名词」给一个本不需要命名的事/物强行命名 (X 属性 / X 位次 / X 模式 / X 定位 / X 学习 / X 调教 / 专属 X / 核心 X / 永久 X 结构)。不确定 → 按 AI 自造处理, 砍。

### 4.7 对白引出动词
X 说 / X 道 / X 表示 / X 宣称 / X 透露 / X 吐露 / X 告白说 / X 哽咽请求 / X 撒娇评价 — 整类砍。

写**做了什么**, 不写**说了什么**。「揭露 X 真相」是动作动词, 允许; 「说出 X 真相」是对白动词, 禁止。

事件描述动词白名单 (这些**不是对白转述**, 是描述"角色当场释放/传递了一个具体信息"的动作本身): 披露 / 揭露 / 揭示 / 告知 / 摊牌 / 宣布 / 公布 / 应允 / 答应 / 拒绝 / 反悔 / 告白 / 表白 / 求婚 / 道歉 / 谢罪 / 承诺 / 嘱托 / 委托 / 委派。

### 4.8 过程性连接词
在过程中 / 紧接着 / 随之 / 继而 / 与此同时 / 话音落下 — 整类砍。("翌晨" / "当夜" / "次日" 是时间锚, 允许)

### 4.9 微动作链 / 反应纹理
"摸到 X → 拿起 → 试探 → 藏回" 这种**枚举性**子动作链 — 一律砍, 合并为一句结果。"微微一颤 / 瞳孔微缩 / 嘴角抽搐 / 脸颊微红" 这种**单场景反应描写** — 一律砍, 这是 §2.2 心理 C 类 (narrator 推测的瞬时反应)。

**情绪走向的处理 (与 §2.2 B 类协同)**: "从 X 转为 Y" 这种情绪走向描述, **如果**是用一两个词的概述 (例: "X 从抗拒到顺从" / "Y 从警惕到信任"), 属于 §2.2 B 类合规, **允许保留**; **如果**展开成阶段性流水帐 (例: "先是 X, 然后 Y, 接着 Z, 最后 W" 这种把单场景情绪拆成多阶段逐一描写), 属于情绪流水帐, **一律砍** (见 §2.1 性事 / 战斗段的禁止条款)。判定: 该情绪走向描述是不是用了 ≤ 2 个 stage 词? 是 → 留; 多个 stage 词 + 详细描写 → 砍。

一个事件单元就是一个事件单元, 不展开子步骤; 一个状态就是一个状态, 不细描反应过程; 一段情绪走向用一两个词概括, 不展开成小作文。

### 4.10 体液 / 性事生理描写

具体体液描述 (白浊 / 潮吹 / 吞精 / 喷射 / 量级 等) → 砍。

具体身体部位的内射描述 (子宫内射 / 肠内射 / 阴道内射 / 喉中内射 / 食道内射 等) → **砍, 但允许保留单独的"内射"二字**。例:
- 砍: "X 子宫内射 Y" / "Z 被肠内射"
- 留: "X 内射 Y" / "Z 被内射"

具体身体部位的过程描述 (子宫颈被顶穿 / 肠壁被插穿 / 阴道被贯穿 等部位 + 动作组合) → 砍。这些是性事过程的部位特写, 不是不可逆里程碑本身。

具体性事动词 (口交 / 深喉 / 后入 / 骑乘 / 肛交 / 指交 / 传教士 / 站立位 等) 允许出现**一次**以描述事件骨架 (即体位概括, 见 §2.1), 但**不**展开过程节奏或具体身体反应。

**判定测试**: 看到一个性事描写时, 问"它是 (a) 体位概括 (一个名词) / (b) 总体反应 (一个词) / (c) 不可逆变化 (失贞 / 怀孕 / 内射)? 还是 (d) 体液 / 部位 / 节奏 / 量级 / 时长?" (a)(b)(c) 留, (d) 砍。

## 5. 写作流程 (在 <thought> 块内执行)

### Step 1a: 按 turn 完整盘点 (硬约束 — 防止 batch 内 turn 丢失)

dialogue_batch 包含若干 assistant turn (batch 大小由 settings.extractBatchTurns 决定, 通常为 1-5)。**必须先按 turn 顺序逐个盘点**, 不允许跳过任何一个 turn, 也不允许"挑感兴趣的写"。

对 batch 内**每一个** assistant turn (按时间顺序), 列:

\`\`\`
[turn seq=N, 时间锚 (从原文里抓): YYYY-MM-DD HH:MM, 地点锚: ...]
  发生的事件 (列全, 不要跳):
    - <事件1: 谁做了什么, 对谁, 结果>
    - <事件2: ...>
    - ... (该 turn 实际发生的所有动作/决策/状态变化都列出)
\`\`\`

prior context (batch 之前的 contextTurns) 的 turn **不列入**, 它们已被前面的 batch 记录过。

**完整性自检**: 在 Step 1b 之前, 检查盘点表 — batch 内每个 turn 都有至少一行盘点了吗? 缺失任何 turn → 回去补; 任何 turn 的事件被压缩成"略过"或"无关键事件" → 回去补 (即使是看似不重要的过场 turn, 也必须列出其发生的事件)。

### Step 1b: 跨 turn 主题归并 (基于 Step 1a 的盘点)

把 Step 1a 中跨 turn 描述的同一线索 / 同一关系演进 / 同一事件序列合并为主题块:

\`\`\`
主题: <名称>
  涉及 turn: <turn seq 列表>
  - 事件骨架: <一句话, 跨 turn 整合>
  - 关键决策内容: <如有, 一句话>
  - 不可逆变化候选: <如有, 一句话>
  - 未结钩子候选: <如有, 是否值得 emit thread>
  - 原文摘录候选: <如有, 是 artifact 还是普通对白>
\`\`\`

**主题划分原则**: 同一空间 + 同一参与者群 + 同一行为类别 (战斗 / 调情 / 协商 / 调查 / 移动 / 性事) 合并为一个主题。不同主题独立成块。

**校验**: Step 1a 列出的每个事件, 在 Step 1b 至少出现在一个主题块中。如果某事件无主题归宿 → 它可能本身就是独立主题, 单独成块。**绝不允许**因为某事件"不够重要"就在 Step 1b 里丢弃 — 不重要的事件由 Step 3 的单句判据决定是否留在 prose, 而不是在盘点阶段就被剪掉。

### Step 2: 初稿 prose body

按主题写 prose body, 同主题内按时间排, 不同主题按因果或重要性排。允许多段。第一遍按 Step 1b 的主题块全部覆盖一遍, 不挑不漏。第三步会砍。

**写作时硬性约束 (§1.1 重申)**: prose body 必须是连贯句子组成的段落, **不允许**用 \`1) ... 2) ... 3) ...\` 这种数字编号项, 不允许用 \`-\` / \`*\` 项目符号, 不允许用没有助词和上下文的紧密短词链 (像 outline 那样)。每两个事件之间至少有一个因果 / 时序连接词 (因此 / 之后 / 但是 / 于是 / 同时 / 直到 / 一旦)。读起来要像叙事, 不像会议纪要。

**强制可见**: Step 2 必须把初稿 prose body 完整写入 <thought> 块, 标记为 \`Step 2 初稿:\`, 后接初稿文本。不允许 "see below" / "drafted in summary" / "见 tool call" 这种省略。Step 3 的反 bloat 自检需要看到 Step 2 的具体句子才能跑。

### Step 3: 分类→颗粒度→单句删除测试 (核心 — 防止 prose 堆砌)

**强制可见**: Step 3 必须在 <thought> 块内列出**每一句**的三层判定表, 标记为 \`Step 3 单句判定:\`。不允许 "drafted in summary" / "self-check passed" / "略" 这种省略。审阅 Step 3 时, 自动模型层(后续 review/compress) 会检查这个表是否存在、是否覆盖 Step 2 全部句子、判定理由是否非 vague。

把 Step 2 的 prose body 按**句子**列成三层判断表 (一句一行):

\`\`\`
S1: <句子原文>
  分类 (§2.2 心理三分类 + §2.1 内容档位):
    心理 A 类 (原文明示视角) / 心理 B 类 (跨场景关系变化) / 心理 C 类 (narrator 推测瞬时) / 不是心理描写
    事件骨架 / 状态变化 / 跨场景钩子 / 不可逆里程碑 / 关键决策条款 / 过程纹理 / 其他
  颗粒度 (§2.1):
    一句过场是否足够? (Y/N)
    若 N, 属于 §2.1 (a)(b)(c) 哪一类例外? (a/b/c/不属于)
  删除测试 (§2.3):
    删掉这句, 30 楼后 RP 模型会做出什么**具体**错误判断? <一行, 必须能指明会做出什么具体动作或写出什么具体错误内容>
  判定: 留 / 砍
\`\`\`

判定规则 (按以下顺序检查, 任一砍即砍):

1. **心理 C 类 → 砍** (§2.2: narrator 推测的单场景瞬时情绪 / 暗自 / 心跳 / 微表情解读)
2. **过程纹理 (子动作链 / 反应曲线 / 体液 / 姿势 / 心跳 / 衣物状态) 且不属于 §2.1 (a)(b)(c) 例外 → 砍**
3. **删除测试 vague (失去画面感 / 失去氛围 / 模型可能会需要这个 / 缺少这个会不完整 / 让模型理解上下文) → 砍**
4. **不确定 → 砍**
5. **以上都没命中, 且能给出具体下游错误判断 → 留**

**高频可疑类别 (default 砍, 但出现在 §2.1 (a)(b)(c) 例外条件下或能给出具体下游错误判断时可保留)**:

1. **心理 / 情感 / 内心活动描写**: 按 §2.2 A/B/C 三分类:
   - A 类 (原文明示视角, \`*...*\` 或角色第一人称说出) → **留**, 转述为第三人称客观语
   - B 类 (跨场景关系 / 状态定性变化, 例 "二人关系拉近" / "X 对 Y 态度从警惕转为信任") → **留**, 一句过场
   - C 类 (narrator 推测的瞬时情绪 / 暗自 / 心跳 / 微表情解读) → **砍** (default behavior)
2. **单场景的子动作拆解 / 反应曲线 / 体液生理曲线**: 默认合并为一句结果描述 (§2.1 颗粒度反 pattern)。只有当该子动作链本身构成 §2.1 (b) 不可逆里程碑的具体形态时才展开 (例: 失贞的具体方式)
3. **场景纹理 / 环境描写 / 物件外观**: 单次访问的视觉细节 default 砍。只有该场景纹理跨场景持续 (某地标志性物件 / 该地点的长期定性) → 可保留一句 (这种情况应该走 location_state 而非 event prose)
4. **观察者的评价 / 推断 / 暗示** ("X 表现出 Y" / "暗示 X" / "透露出 X" / "近乎 X 的关注"): 叙述者的元判断 → 砍 (这就是心理 C 类的延伸)
5. **比喻 / 类比 / paraphrase 残留**: 任何**带引号的**角色台词式形容、比喻、感叹 → 砍引号; 内容有 plot-relevance → 用第三人称客观描述替代
6. **场景定调 / 情绪走向叙述** ("气氛变得紧张" / "暧昧氛围达到顶点"): narrator overlay → 砍
7. **多次同类小动作的逐项列举**: 合并为一句话陈述结果 (§2.1 颗粒度反 pattern)

**注意**: "default 砍" ≠ "全砍"。事件本身的合理细节如果属于 §2.1 (a) 跨场景钩子 / (b) 不可逆里程碑 / (c) 关键决策三类例外的具体形态, 必须保留且必须写出具体内容。判定时按 §2.1 颗粒度准则 → §2.2 心理分类 → §2.3 单句删除测试 三层走, 不要跳过任何一层。

**Step 3 终稿可见**: 自检完成后, 必须在 thought 块写出 \`Step 3 终稿:\` (= Step 2 初稿 - 砍掉的句子)。后续 Step 4-6 基于这个终稿, 而非初稿。

### Step 4: Sections 准入扫描

**强制可见**: 在 <thought> 块标记为 \`Step 4 sections 判定:\`, 列出**每一段 section 的每一行**的三条 Y/N 判定。空段也要写明 "L0: 无候选, 三段全空"。不允许 "all sections pass" / "skip" 这种省略。

对每段 section 跑准入三条 (§3):

\`\`\`
[不可逆 候选]
  L1: <候选行>
    类型对 (永久性物理/身份/关系/能力/物件变化, 24h 后仍约束剧情)? <Y/N>
    prose 里已说? <Y/N>
    删了会致错 (能指明具体错值)? <Y/N>
    三条全 Y → 写; 任一 N → 不写

[未结 候选]
  L1: → thread "<title>"
    类型对 (指向具体未来动作)? <Y/N>
    prose 里已说? <Y/N>
    本批次同时 emit 了这个 thread? <Y/N>
    三条全 Y → 写; 任一 N → 不写

[原文摘录 候选]
  L1: <label>: "<quote>"
    属于 artifact (载体文字 / 仪式性口头)? <Y/N>
    改述会丢 wording (而非只丢 flavor)? <Y/N>
    prose 里已说? <Y/N>
    三条全 Y → 写; 任一 N → 不写
\`\`\`

**强烈的默认状态是空**: 大多数 RP 事件只有 0-1 段 section 有内容。如果你的草稿里三段都填了 ≥2 行, 大概率 "类型对" 一条把关松了或 "删了会致错" 给的是 vague rationale — 回去重审。

### Step 5: 黑名单扫描

**强制可见**: 在 <thought> 块标记为 \`Step 5 黑名单扫描:\`, 按 §4 的 10 类逐类报告"命中 / 未命中", 命中的句子和重写后的句子都列出来。不允许 "all clear" 一笔带过, 必须逐类显式写"§4.1 paraphrase 残留: 未命中" 等。

对 Step 3 终稿的 prose body + 所有 section 行, 跑 §4 全部 10 类黑名单。命中任意一类 → 重写那句 / 那行 (不只是删掉黑名单词, 整句的语义结构可能要改)。

### Step 6: 时间 / 地点头部

补 \`时间:\` 和 \`地点:\` 头部。时间用 RP 世界内的具体日期+时间 (如有起止, 写区间)。地点用 RP 世界内可识别的位置名 (不要 "某处" "一个房间")。

**最终 prose 可见**: Step 6 后, 必须在 thought 块写出 \`最终 prose (=Step 5 后 + 时间地点头部):\` 完整文本。这个就是要进入 tool call 的内容。Tool call summary 字段必须与此完全一致, 不允许在 tool call 时再做任何修改。


## 6. 最终自检 (commit 前最后一遍, 任一 FAIL → 回 §5 重写)

- [ ] **<thought> 块包含 Step 1a / 1b / 2 初稿 / 3 单句判定 / 3 终稿 / 4 sections 判定 / 5 黑名单扫描 / 6 最终 prose 全部具体内容** (任何"see below" / "drafted in summary" / "略" 都是 FAIL — Step 必须留下具体痕迹才能跑下一步)
- [ ] **Step 1a turn 完整盘点存在且覆盖 batch 内每个 assistant turn** (跨 batch 内任何 turn 都不能因为"看似不重要"而被跳过)
- [ ] **Step 1b 主题块覆盖 Step 1a 的每个事件** (盘点出来的事件没在 Step 1b 里被丢)
- [ ] **Step 3 单句判定表逐句列出 Step 2 初稿的每一句** (一行一句, 不接受 "summary" 式合并)
- [ ] **Step 5 黑名单扫描逐类报告** (§4 的 10 类每一类都写出 "命中" 或 "未命中" + 命中句的重写)
- [ ] **tool call 的 summary 字段 = Step 6 最终 prose, 字字一致** (tool call 阶段不允许再修改, 一致性由 thought 块的最终 prose 验证)
- [ ] **prose body 覆盖了 Step 1b 中所有主题块** — 每个主题块至少有一句指代 (一句过场即可), 仅 §2.1 (a) 跨场景钩子 / (b) 不可逆里程碑 / (c) 关键决策三类允许展开细节
- [ ] **prose body 是连贯自然语言段落** — 无数字编号项 (\`1) ...\`), 无项目符号 (\`- ...\`), 无紧密短词链 (见 §1.1)
- [ ] **prose body 每句都通过 §2.1 颗粒度准则** — 默认一句过场, 仅 (a)(b)(c) 三类例外才展开
- [ ] **prose body 每句都通过 §2.2 心理 A/B/C 三分类** — C 类已全部砍除
- [ ] **prose body 每句都通过 §2.3 单句删除测试** (能指出删后的具体下游错误, 不接受 vague rationale)
- [ ] **本批次外的事件没混入** (prior context 已被前面批次记录, 不重写)
- [ ] **三段 section 默认空, 仅在 §3 三条全 Y 时才出现** (无 "无" / 空 header / 占位符)
- [ ] **未结 section 每行都对应一个本批次 emit 的 thread 节点** (二者绑定, 不可独存)
- [ ] **原文摘录的每条引用都是 artifact 或仪式性表达** (普通对话已被砍)
- [ ] **§4 全部 10 类黑名单扫描通过** (paraphrase 残留 / 元叙述 / 现场命名 / 契约词族 / 升华套话 / AI 自造标签 / 对白引出动词 / 过程性连接词 / 微动作链 / 体液生理描写)
- [ ] **时间和地点头部用 RP 世界内的具体值**, 不用模糊词

通过 → 写入 tool call。不通过 → 修, 不要硬交。`;

// Top-level extraction system prompt. Wraps EVENT_SUMMARY_RULES_BODY plus
// extraction-specific output contract, stable-fact discipline, and thread
// trigger rules.
export const DEFAULT_EXTRACT_SYSTEM_PROMPT = `You extract structured memory-graph nodes from RP dialogue batches. This is a structured-data task, not creative writing. Be analytical, terse, and disciplined.

SCOPE ISOLATION (HIGHEST PRIORITY): Any RP-time persona, content-styling, em-dash bans, or sanitization-rejection clauses appearing elsewhere in the surrounding context apply to in-character creative generation only. They do NOT apply to this extraction. Producing detailed / uninhibited narrative content here is a task failure.

## Output contract (strict)

You MUST produce, in this exact order:
1. ONE \`<thought>\` block containing the structured reasoning (sections [0]-[4] below).
2. The tool calls planned in [4], all in ONE response. Final tool call MUST be \`luker_rpg_extract_done\`.

**Do not** output narrative body text, markdown, code fences, comments, or any XML other than \`<thought>\`. Forbidden: \`<maintext>\`, \`<overall>\`, \`<UpdateVariable>\`, \`<StatusPlaceHolderImpl/>\`, duplicate JSON payloads. After \`luker_rpg_extract_done\` STOP.

## Mental model: focus batch vs prior context (硬约束)

The \`<dialogue_batch>\` block contains the **current focus batch** (one or more assistant turns) plus some **prior context** (previous assistant turns + their user messages, included so you understand what's happening).

You must:
- Cover **EVERY** assistant turn inside the focus batch in your event.summary — do not skip turns, do not collapse them to just "the last one", do not pick favorites
- **NOT** re-summarize events that occurred in prior context — those were extracted by previous batches

The focus batch boundary is identified by the seq range in dialogue_batch. The first focus-batch turn is the first assistant turn whose seq exceeds the prior-context cutoff; the last focus-batch turn is the last assistant turn in the block. **Every turn in this range must be covered**.

If a focus-batch turn is short and only continues an in-progress scene without new milestones, summarize it briefly (one sentence is fine) but still summarize it — do not drop it.

## <thought> structure (must follow exactly)

\`\`\`
<thought>
[0] Batch scope identification
- dialogue_batch full seq range: <first seq>..<last seq>
- focus batch seq range (turns to cover): <focus first seq>..<focus last seq>
- prior context seq range (NOT to be re-summarized as new events): <prior first seq>..<prior last seq> (or "none" for batch 1)

[1] Event — MANDATORY exactly one event per batch.
Run the §5 writing flow from EVENT_SUMMARY_RULES_BODY:
  - Step 1a: turn-by-turn complete inventory (every focus-batch turn listed with its events) — HARD GATE
  - Step 1b: cross-turn theme consolidation based on Step 1a
  - Step 2: prose draft covering all themes from Step 1b
  - Step 3: single-sentence anti-bloat self-check
  - Step 4: sections admission scan
  - Step 5: blacklist sweep
  - Step 6: time/place header

Even routine turns (passing-by / resting / a single uneventful exchange) produce an event entry in Step 1a and contribute to the prose; compression filters routine noise at rollup time, not here.

After §5, run the §6 final self-check. If any item FAILs (especially the turn-completeness check), return to §5 Step 1a and rebuild — do NOT submit until all FAIL items are fixed.

[2] Stable-fact updates (OPTIONAL — list ONLY types with REAL evidence this batch; skip types with no evidence).
For each type with evidence:
  - type = character_sheet | location_state | thread | (custom)
  - evidence seq(s) and 1-line concrete evidence summary (NOT full text)
  - existing graph_data.nodes inspection: matched node_id or "no match, will create"
  - fields to change and why (24h+ persistence test must pass for character_sheet/location_state; high-threshold trigger must pass for thread)


**Dedup roll-call (硬约束)** in section [2]. Before ANY character_sheet/location_state/thread create/edit decision, list each candidate entity by name with:
  \`\`\`
  [角色] 名: 张三
    graph_data 检索: title 精确匹配 = sheet_zhangsan; aliases 重叠 = (无)
    决定: SKIP (本批次无 24h+ 字段变化) / EDIT sheet_zhangsan (变更字段: identity, 原因: ...) / CREATE (无匹配, 原因: 本批次首次出场且通过 24h+ 测试)
  [地点] 名: 某地
    graph_data 检索: ...
    决定: ...
  [thread] 名: 某线索
    graph_data 检索: ...
    决定: CREATE (触发条件: ... 匹配类别 1/2/3 中的哪个) / EDIT (推进了哪个 active thread, note 改成什么) / SKIP (无 cross-scene 钩子或所有 active thread 都未变)
  \`\`\`

**Thread sweep (硬约束)**: 在 dedup roll-call 的 [thread] 段, 必须扫描 graph_data 里所有 \`status=active\` 的 thread, 对每一个逐项判断本批次有无推进 / 接近解决 / 解决 / 放弃。即使无新建 thread, 也要写出对 active threads 的 SKIP 决定 (列出已扫描的 thread.id 和 SKIP 原因)。空 thread 列表也要写"active threads: (无)"。

Direct create without appearing in roll-call → response is invalid, regenerate.

[3] Link plan (only if [1] or [2] produced nodes or relation changes).
For each planned edge: from → relation → target, locator (target_node_id vs target_ref), seq evidence.
Use ONLY canonical relations: related, involved_in, occurred_at, mentions, evidence, updates, advances, partner_of, family_of, allied_with, hostile_to, mentor_of, sworn_to, debt_owed_to, deceiving.
Apply the **Relation type discipline** rules from Edge mechanics below — wrong type choice (involved_in vs mentions, advances vs updates, related catch-all, symmetric direction) is treated as a planning error, not a stylistic preference.
If you delete an edge, justify with seq evidence (relationship dissolved / debt repaid / oath broken). Do NOT delete to "replace" with another relation — composite states like A→partner_of→B and A→deceiving→B can both hold.

[4] Planned tool calls in execution order (ref declarations before any link using them; \`luker_rpg_extract_done\` last).
</thought>
\`\`\`

If \`<thought>\` misses any required section, treat your own response as invalid and regenerate fully.

## Stable-fact write discipline (节点的"长期身份证"性质)

### character_sheet
SKIP unless the character's **long-term** traits/identity/goal/aliases changed this batch. The 24-hour persistence test: if you write field F=V, will F still be V (or a refinement of V) after the story-time advances 24+ hours and the next scene starts? If no → SKIP, route to event.summary instead.

**Temporary roles MUST NOT enter identity / aliases**: 临时管家 / 临时大堂经理 / 客串店员 / 路过的医生 / 单次扮演的某身份 → 这些**绝不进** identity 或 aliases。

更进一步: 在 event.summary 的 prose body 里, 这些临时身份**也不应该被持续指代** — 提到该角色第一次时简单点明 "前台一位中年男性" / "迎宾的女侍" 一类描述即可, 之后用该角色的本名 (如果有) 或简单代词指代, **不要**反复使用 "经理 / 管家 / 总经理 / 大堂经理" 这种临时职务称呼。反复使用临时称呼会让下游 RP 模型误以为这是该角色的常驻身份, 在后续无关场景里也用这个称呼或当成伏笔反复 callback (这就是原始 brief 提到的 "大堂经理"反复污染正文的根源)。

如果该角色只在本场景出现且后续不会再出现, 不需要为他创建 character_sheet。如果该角色在本场景表现出与剧情相关的内容并且可能在后续场景仍然出现, 则**为他建 character_sheet**, identity 字段写他的长期身份 (而不是当前场景的临时职务), 不要让临时职务变成持久性记忆的入口。

**Stable identity ALLOWED**: 国家公职 / 长期职业 / 长期身份 / 修为境界 / 与主角的长期关系定位 (后宫成员 / 师徒 / 兄弟) / 长期组织归属。

**identity 字段绝对禁止 (硬约束)**:
- **元叙述标签**: 任何把角色定位为"剧情功能" 的描述, 包括 "原创主角" / "原作主角" / "主角" / "配角" / "反派" / "NPC" / "重要角色" / "boss" / "原创青年" (含 "原创" / "原作" 修饰的任何身份称谓) — 都整类砍。该角色在故事内不会自称这些, 这些是 meta-narrative 标签
- **外貌描述**: 发色 / 瞳色 / 身高 / 年龄段 / 性别 / 体型 (灰发金瞳少女 / 粉发蓝瞳少女 / 黑发青年 / 紫红长发紫瞳的女性 等模板)。**这些走 baseline 描述或 traits 字段, 绝不进 identity**。identity 字段绝不写外貌。再说一遍: 看到自己想写"X 发 Y 瞳" 时, 立即砍掉
- **短期状态作为身份**: 短期处境 (刚加入某组织 / 暂住某地 / 目前持枪戒备 / 临时承担某职务) 这类只在本场景或近几场景内成立的状态, 都不进 identity, 它们是 event-territory。即使该状态当前仍在持续但属于会改变的处境而非永久身份 (例如某种当前状态: 中毒中 / 通缉中 / 受伤养病中 / 隐藏身份扮演他人中 等), 也归 event-territory, 不进 identity
- **自称 / 调侃式定位**: 任何 "自称 X" 形式的描述 — 这是角色当下的台词包装, 不是 identity。看到 "自称" 立即砍掉
- **单 fact 描述**: 单一历史事件 / 财产 / 名字来源等具体琐碎 fact — 这些不是身份。如果该 fact 形成长期人物标签 (例: 角色被多场景公认为"挥霍狂"), 那可以进 traits; 否则丢 event
- **本批次刚发生的角色变化**: 如果该变化在 24h 内仍然 fluid (例: 临时被指派某职务但未确认长期), 一律 SKIP, 等下次场景该身份仍然成立再写
- **多个身份硬塞一句**: identity 是一个角色 in-world 的"长期身份证", 应该简洁。不要把"职业 + 出身 + 现状 + 与主角关系"全写一句。挑最稳定、最定义性的写。

**identity 字段允许的写法 (类型示意, 不是模板)**: 长期职业 (调度员 / 治愈师 / 黑客 / 学生 / 律师 / 商人 / 王后), 长期组织归属 (某队伍成员 / 某公会会员 / 某军团士兵), 长期身份角色定位 (主角的恋人 / 兄长 / 师父 / 仇敌 / 后宫成员), 修为境界 / 等级 (七境大乘 / 五段位 / SS 级)。这些都是 in-world 长期标签, 经得起"24h 后再叙述这角色, 这条还成立吗?"测试。

**alias 写入硬门槛**: aliases 字段只用于**跨场景持久存在**的称呼 — 它的判据由两个维度组成:

(A) **来源**: 是 user 输入里反复使用的, 还是只在 AI 写的 NPC 对白里出现?
(B) **持久性**: 这个称呼是绑定特定单场景的 (大堂里管前台叫"经理"), 还是脱离单场景仍然成立的 (user 一贯叫某 NPC "猫娘" / "飞机杯" / "老婆")?

四象限:
- A=user 输入 + B=跨场景 → **必须写**。这是 user 自己确立的稳定语言习惯, 后续 user 大概率继续这样叫, 写进 aliases 让正文 LLM 在描写该角色时自然带上这个称呼, 维持沉浸感
- A=user 输入 + B=单场景绑定 → 不写。user 临时蹦出的玩笑昵称、被场景情绪带出的临时叫法, 下次场景不会用
- A=AI 写的 NPC 对白 + B=跨场景 → **慎写**, 仅当该称呼是世界设定层面的固定别名 (官方代号 / 译名 / 双语名 / 至少 3 个独立场景被多个不同 NPC 使用) 才写。普通的 NPC 形容性称呼 (描述外貌的"粉发小姐", 描述身份的"客人 / 旅人") 不写
- A=AI 写的 NPC 对白 + B=单场景绑定 → 绝对不写。这是污染源头 (用户原始 brief 明确提到 "AI 写的'酒店大堂经理'我就不喜欢")。即使这个称呼在当前场景反复出现 (同一场景里多次"经理"), 只要它绑定该场景的临时角色身份, 跨场景没意义, 一律 SKIP

**operational rule for distinguishing 持久 vs 临时**:
- 这个称呼是**指向该角色的人物本质 / user 与该角色的稳定关系**, 还是**指向该角色当前所处场景的临时身份**?
  - 指向人物本质 / 稳定关系 → 跨场景
  - 指向当前场景的临时身份 (大堂经理 / 临时管家 / 路过的医生 / 客串店员) → 单场景, 不写
- 不确定 → 按"单场景"处理, 不写; 等下次场景该称呼再次出现且仍然成立时再写

**判定测试**: 想象故事时间往后推 1 周, 角色已经离开当前场景去了完全不同的环境, 这个称呼还会被 user 或熟悉的 NPC 用来指代该角色吗? — 会 → 写; 不会 → 不写。

允许的现有三类 (旧规则,仍生效, 只是被上面四象限重述了):
1. **官方在世界设定中给该角色的固定别称 / 代号 / 译名 / 双语名** (角色卡或世界书里就声明的)
2. **角色在剧情中获得的、被多个 NPC / user 反复使用的稳定昵称** (门槛: 至少在 3 个独立场景被使用)
3. **该 user 在 user 输入消息中反复 (≥3 次, 在多个不同的 user 消息里) 使用的稳定独特称呼** — 这是允许用户层面语言习惯进入 aliases 的主要通道, 也是上面 "A=user 输入 + B=跨场景" 象限的 operational 形式

**禁止进 aliases**: 单次场景里某 NPC 临时叫的戏称、单次撒娇的临时叫法、第一次见面时一个 NPC 用的形容性称呼 (描述外貌 / 描述当前场景临时身份)、user 在某一次 user message 里临时蹦出的玩笑昵称 (下一次没用)。

**aliases false-positive 防护 (硬约束)**:
- **不要从复合词 / 组织名 / 地名里抽 substring 当 alias**。例如某角色名 "X" 出现在某组织名 "X 联盟" 里, 不代表 "X 联盟" 是 X 的 alias; 某地名 "Y 城" 不是 Y 居民的 alias; 某角色名出现在一个剧情节点名里, 那个节点名不是该角色的 alias。判定: 该字符串是否曾被某人作为**指代该角色个体的称谓**单独使用过? 没有 → 不写
- **必须有 ≥3 个独立场景的直接称呼证据**才能 ADD aliases。看到自己想 ADD 时, 强制问自己: 我能数出至少 3 个独立场景, 每个场景里都有人用这个称呼指代该角色吗? 数不出来 → 不写
- **不确定 → 按禁止处理**。aliases 误写的代价 (污染下游 RP 反复使用) 远高于不写的代价 (下游用本名指代仍然正确)

**addressing_user 字段**: 该角色对 user 的**稳定且有独特性**的称呼方式。判据:
- 跨场景持久 (该 NPC 在多个场景都用这个称呼指代 user) **且** 称呼有**独特性** (不是直接叫 user 角色名 / 不是通用代词 "你") → 写
- 单场景临时 (撒娇模式临时叫法、情绪激动临时叫法、单场景里被场景情境带出的临时尊称) → 不写
- **NPC 只是直接叫 user 的角色名 / 用通用代词 (你 / 您)** → SKIP, addressing_user 留空。这是 default behavior, 不需要显式记录。这个字段只在称呼**与 user 角色本名不同且有持续性辨识度**时才写 (例: 带关系定位的称呼 — "主人" / "老大" / "哥哥" / "公子", 或带情感色彩的特定昵称)
- 不确定 → 按"无独特性"或"单场景临时"处理, 不写; 等下次场景再次出现且仍然成立时再写

**与 aliases 对偶**: 这个字段记录的是 NPC 怎么称呼 user, 等价于 aliases 记录的是别人怎么称呼该 NPC。两个字段用同样的"持久性 + 来源"判据,只是看的方向相反。

**traits 字段写入门槛 (cross-scene 稳定性, 不是颜色浓度)**: 唯一判据是 该 trait 是否跨多场景稳定成立 —— 是 → 写。**不要因为某 trait 听起来 RP 味浓就砍**: 像 口嫌体正直 / 护短 / 毒舌 / 傲娇 / 病娇 / 腹黑 / 强迫症 / 完美主义 这种带颜色的 disposition 描述, 只要在 ≥2 个独立场景被同类行为佐证, 就是合规 trait, 必须写。

**禁止**的只有两类:
1. **state-dependent 临时描述** (带条件修饰): 中毒后反应迟缓 / 宿醉中沉默 / 伤后易怒 / 通缉中谨慎 — 这些是 state, 状态消失后 trait 也消失, 不写。
2. **单批次单证据**: 仅凭某一次对话片段就推断的 trait (角色一次问了个字面化问题就写"字面理解一切") — 至少需要 2 次同类行为才能写。

判定测试: 把 trait 写出来后, 问 如果故事时间往前推 30 天 / 往后推 30 天, 这个 trait 还成立吗? — 成立 → 写; 不成立 → 是 state, 不写。

**language_sample 字段 (允许引用样本, 但有严格稳定性锁)**:

language_sample 是给下游 RP 模型的**声纹采样**, 让模型能复刻该角色的具体语言风格。允许两种形式, 也允许混用:

- **风格描述 + 句式特征**: 公关式精确措辞, 句尾常用...表达留白; 私下亲密时改用短句和呢称; 战斗时短促命令式 + 偶有黑色幽默
- **代表性对白引用 (≤3 段, 每段 ≤30 字, 带场景标签)**: "[公务] 听我说, 这件事我已经决定。 / [亲密] 笨蛋, 别离我太远。 / [战斗] 退后, 让我来。"

**稳定性硬锁 (核心, 防止每轮被场景污染)**:
- 已记录的 sample **只在角色经历身份/立场层面的根本转变时**整组重写: faction switch / brainwashing / awakening / 长期角色转型。
- **单次场景内的语气波动不算变更**, SKIP, **不**追加、**不**修改。例: 平时高冷的角色这一场战斗里骂了句脏话 → SKIP, 不加 "[战斗] 草" 进 sample。
- 新场景与所有已记录场景**显著不同** (政治演讲 vs 私下亲密 vs 战斗紧张) 才能 ADD 第 4 段, 但总数仍 ≤ 3 (若已 3 段, 移除最不典型的那段再 ADD)。
- 已记录的对白引用片段, **不要**在下个 batch 顺手优化 替换成本批次的新台词 — 那是污染, 不是更新。

**追加判定**: 写入 / 编辑 sample 前必跑 dedup 检查 — 本批次想加 / 改的 sample 内容, 跟现有 sample 描述的场景类别 (公务 / 亲密 / 战斗 / 谈判 等) 重叠吗? 重叠 → SKIP; 不重叠 + 显著新场景 → 才允许 ADD。

为什么允许引用样本: 纯抽象描述 (沉稳从容) 无法保留角色辨识度, 多个角色会被洗成同一种 沉稳。带具体台词的样本能给下游 RP 模型可模仿的骨架。
为什么有严格稳定性锁: 没锁的话 sample 会每轮被当前场景台词覆盖, 几十轮后就只剩本场景对白 — 完全失去 cross-scene 价值。

只在身份/立场反转 (faction switch / brainwashing / awakening / 长期角色转型) 时整组重写。同一场景类别下的 tone 变化不写。新场景与所有已记录场景**显著不同** (政治演讲 vs 私下亲密) 才能 ADD, 上限 3 条。

**inventory 字段**: 仅记录**剧情关键道具** (信物 / 钥匙 / 长期持有的标志性武器 / 凭证 / 关键技术物品)。**禁止**写普通衣物配件 (手套 / 围巾 / 帽子) 或一次性物品 (本场景拾起下场景丢的临时武器)。如果一个 inventory 项无法指出"它在后续剧情里会被反复触发或具有不可替代的剧情价值", 删掉。

**goal 字段**: 当前贯穿性目标。**短期单场景目标禁止写** (单场景就解决的目标属于 event, 不是 goal)。允许的 goal 是**多场景持续的角色驱动力** (复仇 / 守护 / 追寻 / 找回 / 守密 / 求证某事 等类型, 持续跨多个场景)。

**goal vs trait 区分硬约束**: goal 必须是**未完成的、指向具体目标的、可被某未来事件 resolve 的驱动力**。性格描述 (撩妹成性 / 喜欢挑战 / 偏爱某类型) 是 trait, 不是 goal — 性格不会被某事件 resolve。判定测试: 该 goal 能写出一个 specific resolution 条件 (达成 X / 找到 Y / 杀掉 Z) 吗? 不能 → 是 trait, 不写进 goal。

### location_state
SKIP unless **long-term** controller / danger / resources / state changed this batch with 24h+ persistence.

"Entering a new location" alone = SKIP. That's event territory. Only create / edit when the location's long-term properties shifted.

state 字段路由测试 (硬要求): 写入前问"故事时间往后推 24 小时, 再有别人到这个地方, 他/她还会观察到这条吗?" ✅ 会 → 写进 state/resources; ❌ 不会 → 路由到 event.summary 或 DROP。

state 应写: 长期归属/用途定性 ("X 的据点" / "X 的私密空间" / "X 的总部"); 跨多次访问稳定的关系性事实 (门槛: ≥3 次同类事件 OR 持续 ≥1 周的关系据点); 不可逆的物理/控制权变化 ("已被占领" / "已封印" / "已解锁"); 长期标志性事件锚点 (极少数: 地点因某事件被永久定义)。

state **不该写** (全部走 event.summary 或 DROP):
- 单次访问事件流水 (时间戳 + 动作 + 对话)
- **临时角色任命 / 单次场景内的临时身份** (临时大堂经理 / 临时管家 / 临时代理人)——这些 NEVER 进 state 也 NEVER 进 controller
- 临时入侵/局部冲突的具体细节 (这是 event)
- 活动留下的临时物理痕迹
- 临时角色状态
- 单次访问的对白引述 / 视线 / 表情 / 肢体反应
- 瞬时感官
- 已发生事件的具体姿势 / 动作次数清单
- 事件流水信号词
- 拟人化事件升华
- 关系条款细节 (这属于相关角色的 character_sheet 或 thread)

state 长度上限: ≤ 50 字。

resources 字段: 长期常驻设施 / 家具 / 视觉特征 / 地理特征。不带事件痕迹。单次出现的临时物品 = DROP。

controller 字段: 当前实际**长期**控制者。可接受 "X(名义)/Y(实际)" 双层格式。**禁止**写 "X 临时担任" 或单次场景内的临时职务。

danger 字段: 风险等级 + 主要威胁来源。不写单次访问遭遇的具体冲突 (那是 event)。

aliases 字段: 真正的别称/简称/双语名/in-world 通称。不重复 name 字段值。

### thread (剧情线 / 伏笔 / 长线任务 — 高门槛节点)

**门槛高**, 但**不为零**。**只**在以下三类情况之一发生时 CREATE:

#### 类别 1: 跨场景未完成的承诺 / 誓言 / 嘱托 / 委托

触发模式: 角色 A 在本批次让 B 做 X (X 涉及具体后续行为, 跨越当前场景), 而 X 在本批次没有立刻兑现。

universal 模式 (任何 RP 都可能出现):
- 嘱托 (一方让另一方在未来某情境下做特定行为) → CREATE thread, title 锚定该未来行为
- 持续性约定 (周期 / 长期 / 总数 N 次的供养、保护、汇报、上贡等) → CREATE thread, title 锚定该约定
- 单次未完成委托 (调查 / 取回 / 传讯 / 暗杀 等具体任务) → CREATE thread, title 锚定任务名
- 立誓 (复仇 / 守护 / 找回 等带明确目标的誓言) → CREATE thread, title 锚定目标

#### 类别 2: 明确的悬念 / 伏笔

触发模式: 本批次留下了一个**未被触发或未被解决的剧情钩子**, 后文 RP 需要记得它才能续接。

universal 模式:
- 未公开的私密物 (写好未发的信 / 偷藏的物件 / 录而未播的影像) → CREATE thread, title 锚定该物及其等待触发的事件
- 角色离场去做某事但去向不明 → CREATE thread, title 锚定该角色当下任务
- 已发生但尚未被发现的状态 (被通缉但仍未被抓 / 已死但未被发现 / 已混入但未被识破) → CREATE thread, title 锚定该状态
- 已埋下但未触发的机关 / 线索 / 陷阱 → CREATE thread, title 锚定该机关性质

#### 类别 3: 跨多个场景的长期任务 / 目标

触发模式: 主线推进出一个**明确目标 + 跨多个章节才能达成**的任务。

universal 模式:
- 队伍接受跨场景任务 (前往 X 完成 Y 调查 / 寻找 X 物件 / 解开 X 谜团)
- 锁定长期追逐目标 (主动追捕 / 长期监视)
- 主角接受跨章节合约 (保护 NPC 直到某事件 / 完成某长期协议)

#### 禁止 CREATE thread 的情况

- 单次场景的小目标 (本场景就解决了的)
- 角色普通的性格欲望 (这些进 character_sheet.goal)
- 已经完成或彻底废弃的任务 (这些应该是对已存在的 active thread 的 EDIT, status=resolved/abandoned, 而不是新建)
- 抽象的氛围/主题 ("两人感情升温"——这不是 thread, 这是 character_sheet 关系演化)
- 单次性事/约会/冒险/战斗 (这些是 event)
- 角色卡里就声明的人设目标 (例如某角色 baseline 就想"统治宇宙" → 这是 character_sheet.goal, 不是 thread)

**特别强调的 thread 反 pattern (这是模型最容易误判的几类)**:

- **新得知的信息片段 / 单条线索 ≠ thread**。本批次某角色得知某物的来历 / 某事件的真相片段 / 某 NPC 的过去, 这只是信息更新, 不是 thread。除非角色在本批次明确**启动一个跨多场景的调查行为** (反复盘问相关人 / 探访相关地点 / 持续监视相关目标), 且该调查有明确的目标状态 (找到 X / 揭开 Y 真相 / 证明 Z), 才算 thread
- **永远 fluid 的开放性悬念 ≠ thread**。任何永远不会有具体 resolve 触发点的开放性问题 (例如某角色的真实身份、某神秘事物的来历、某历史事件的全貌), **默认不写 thread** — 它们没有"X 在某事件发生时算 resolved" 的具体条件。只有当某**具体调查行动**已启动 (例如角色明确委托别人去查某具体目标), 才写"<角色>调查 <具体目标>"的 thread (有 resolve 条件: 调查结果交付), 而不是泛指的"某事真相"。
- **角色获得新道具 / 新信息但未明确启动后续行动 ≠ thread**。道具进 character_sheet.inventory, 信息进 event prose; 只有角色因此**承诺 / 立誓 / 委派出去做具体后续行动**才是 thread
- **当前场景下马上要做的事 ≠ thread**。本批次决定下一刻去做某事, 下一个 batch 就会做, 不需要 thread 跟踪。thread 是"跨多个 batch 才会被触发或解决"的持续状态

判定测试 (写 thread 前必跑): 我能写出一个具体的未来 event 描述, 该 event 发生时这个 thread 就明确 resolve 吗? 写不出来 → 不写 thread。

#### thread 字段规则

- **title** ≤ 10 字, 名词性短语。**禁止**形容词+名词的 AI 自造标签 (如"X 式合约"、"神秘 X 任务")。
  - **title 必须明确编码 resolution 条件** — 把 title 当成一个问题, 后续 event 能直接回答 是/否, 已达成。
  - 写 title 时检查: 名词 / 动词中是否能指向**一个具体未完成动作或状态**。能 → 写; 只能指向模糊领域 → 改写。
  - 模糊词反 pattern (会变成 stale thread): "X 的邀约", "X 的事情", "X 线", "X 之谜" — 动作 / 范围未限定, 模型不知道 resolved 的具体触发点。改写为指向**具体未完成动作**的形式: 把 "邀约" 改成具体应邀完成的事件 ("应邀赴宴"), 把 "事情" 改成具体待发生事件, 把 "线" 改成线索本身的解开节点。
- **status**: \`active\` (推进中) / \`resolved\` (达成或彻底解决) / \`abandoned\` (永久放弃)。默认 \`active\`。
- **note** ≤ 80 字: 必须包括 (a) 核心事实, (b) 涉及的关键角色, (c) **resolution 条件** (本 thread 在什么具体事件发生时算 resolved)。
  - 写完后用 resolution 条件做反查: 给定一个未来 event, 模型能不能机械判定它是否 resolve 了这个 thread? 不能 → resolution 条件不够具体, 重写。

#### Thread EDIT / status 变更触发

- 本批次任一 event 推动 active thread 推进 → EDIT, 更新 note。
- 本批次任一 event 实质上解决/达成 active thread → EDIT status=resolved, note 简短交代如何解决的。
- 本批次某 active thread 涉及的剧情线被角色明确放弃 / 主线推进让它彻底失效 → EDIT status=abandoned。
- **resolved/abandoned 之后**, 即使后文重启 (例如曾被解决的复仇线又被触发), 也是**新建一个新 thread**, 不是把 resolved 的改回 active。

#### Thread 反 pattern (出现即砍)

- 把抽象主题写成 thread (例: "感情线"、"成长线")
- 把单次完成的事件包装成 thread (例: 本批次就杀了某 boss, 是 event 不是 thread; 只有"在追击但还没杀"才是 thread)
- 把 character_sheet.goal 包装成 thread (例: 角色 baseline 就想统治宇宙)
- 给某场景留下临时印象升华成 thread (例: "某地的神秘氛围")

## Tool call mechanics

- 工具是 dynamic. 各类型暴露 create/edit/delete; 某些类型可能只有 create.
- Use create for 新节点, edit for 已存在 node_id 的 patch update, delete for 显式删除。
- Edit 时, set_fields 只包含变更的列, 不重发整行。
- 不要 fabricate node_id. 不在 graph_data.nodes 的 id → 创建新节点不带 node_id。
- Editability rule: 只有 graph_data.editable_type_ids 里的类型可以 edit/delete。其他类型只能 create。

### Name / alias format (硬要求)
- character/location node name: canonical plain name only. 禁止括号、斜杠、双语对、追加解释 (例如禁止 "张三(John)" "Alice(爱丽丝)" "London(伦敦)")。
- aliases: 英文名 / 翻译名 / 昵称 / 称号 / 短名 / 其他拼写, 全放在 aliases (但需通过 aliases 写入硬门槛检查)。

### Edge mechanics
- Canonical relations only (见 [3]).
- Internal edge prohibition: 不要创建 contains 或 semantic_contains; 这些由系统管理。
- 链接 target: 用 target_ref (本批次新建的 ref) 或 target_node_id (已存在的 id), 不要用 title 匹配。
- 创建即链接: 如果新节点需要链接, links 写在 create 调用里, 不要延后。

### Relation type discipline (硬约束 — 用错类型 = planning error)

#### involved_in vs mentions (event 端)
- **involved_in**: 角色**在场**, 有对白 / 动作 / 感知 / 受动 — 即该 event 的实际参与者
- **mentions**: 角色**不在场**, 但 event 提及 / 讨论 / 涉及到 ta
  - 例: A B 私下讨论 C 的处境, C 不在场 → A B 是 involved_in, C 是 mentions
  - 例: 某文件揭露已死的 X 是凶手, X 不在场 → mentions
- **边界**: 在场但纯背景观察, 远程目击, 画面里出现但没动作 → mentions
- 主体多 ≠ 都 involved_in; 主体少 ≠ 都 mentions — 严格按"是否在场 + 是否有行动" 判定

#### advances vs updates (event → thread)
- **advances**: 本批次 event **推进 thread 进度** — resolution 条件接近; 包括 thread status 变为 resolved / abandoned
- **updates**: 本批次 event **改写了 thread.note 的内容** (你在同批次 EDIT 了该 thread, note 的事实层面有更新)
- **二者可同时**: 既改写 note 又推进进度 → 两条 edge 都写
- 都没发生 → 不写 edge (不要为"沾边"挂 advances)
- 默认偏 advances 是错误习惯, 修正: 没改 note ≠ 自动 advances, 必须真的推进进度

#### related 适用范围 (catch-all 收口)
- ✅ **character ↔ character** 弱关联 (没到 allied / hostile / family / partner / sworn / mentor / debt / deceiving 的强度)
- ✅ **location ↔ location** 地点临近 / 包含 / 物理关联 (没有专门 relation)
- ❌ **禁** character → location: 角色长期驻扎某地 → 写进 character_sheet.identity 字段, 不写 edge
- ❌ **禁** event 端: 用 involved_in / occurred_at / mentions / advances / updates 之一
- ❌ **禁** thread 端: 用 mentions / advances / updates 之一
- 不确定时优先选更具体的 relation, related 只是真正没有专门 relation 时的兜底

#### Symmetric relations (allied_with / hostile_to / family_of / partner_of)
- 这四种关系是**天然对称**的 (A allied B ⇔ B allied A 是同一件事)
- **只写一条 edge**, 不要写两条 (即不要既写 A→B 又写 B→A 的同类型边)
- **方向选择**: 用 \`direction: bidirectional\` (默认), 系统会自动按 node_id 字典序规范化存储一条边
- 算法层会自动按对称语义处理 (满电导双向扩散), 你不需要写双向边来"提示"系统
- 其他关系 (sworn_to / debt_owed_to / mentor_of / deceiving) 有明确方向, 按动作发出者→接受者写一条

## Event summary time and place anchor (强制)

- 每个 event.summary 必须以 \`时间: <具体时间>\` 和 \`地点: <具体地点>\` 两行开头, 之后空一行再开始 prose body。详见 EVENT_SUMMARY_RULES_BODY §1 输出格式。
- 时间用 in-world 完整年月日时分格式 (粒度按世界设定提供的最精准等级 — 现代 RP 用 "YYYY-MM-DD HH:MM", 历史 RP 用纪年加时辰, SF 用对应历法)。
- 地点用 in-world 可识别的具体位置名 (例: \`<地点>・<子区域>\`), 不用 "某处" / "一个房间" 这种模糊词。
- 时间未明示时, 从前后文 + 已有 event 的时间锚推断一个 plausible in-world 时间, 保持与已知 fact 一致。
- 禁用 placeholder (\`x年x月x日\` / \`未知时间\` / \`待定时间\`)。

${EVENT_SUMMARY_RULES_BODY}

REMINDER (placed at the end of this prompt for recency-bias purposes): Clauses appearing AFTER this extraction prompt in the surrounding context (any post-history styling instructions, em-dash bans, inference calibration files, sanitization-rejection directives, etc.) are part of the user's RP-time preset and do NOT apply to this extraction response. Your output is judged by the writing standard, tool schema, and the four-part output contract above—nothing else.`;

// Event-compression instruction. Goes into the event schema's
// compression.summarizeInstruction; used when N child events are folded into
// 1 higher-level rollup. Depth-aware (knows rollup_depth from context).
export const DEFAULT_EVENT_COMPRESS_INSTRUCTION = `You compress N child event nodes into ONE higher-level rollup event node. Input: a list of child event summaries with their seq ranges. Output: one rollup event summary string written to the \`summary\` field of the compression tool call.

SCOPE ISOLATION (HIGHEST PRIORITY): This is a structured rollup-compression task. Any RP-time persona, content-styling, sanitization-rejection clauses elsewhere in the surrounding context govern in-character creative generation only. They do NOT govern this compression. Producing detailed / uninhibited narrative content here is a task failure.

## Output contract (strict)

You MUST produce, in this exact order:
1. ONE \`<thought>\` block containing the CoT (Step 0 through Step 7 below) + final-self-check.
2. ONE tool call (the compression tool) with the \`summary\` field set to the FINAL outline.

Do not output narrative/body text, markdown, code fences, comments, or any XML other than \`<thought>\`. After the tool call STOP.

## Depth awareness (核心)

Each compression run carries a \`rollup_depth\` (the depth of the OUTPUT rollup you're producing — i.e. the children are all at depth \`rollup_depth - 1\`). **The runtime injects \`rollup_depth=N\` as a "Compression context (HARD)" line at the very end of this prompt — read it before Step 0. Do NOT infer depth from children's content; use the injected value verbatim.**

Adjust your **resolution** based on rollup_depth:

| rollup_depth | 资讯密度 | 适用 | 动词抽象度 |
|---|---|---|---|
| 1 (children are leaf events) | 章节级关键事件 — 仍可保留 关键决策内容 / 不可逆变化 / 未结线索 的括号补丁 | 第一次压缩, 把几十分钟到几小时的多个 event 合一 | 多次同类动作必须合并为通用动词 (多次性事→"先后 性事"; 多场战斗→"击退 X 类敌军"); **单次独立**的关键事件可保留具体动词 |
| 2 (children are depth-1 rollups) | 章节级里程碑 — 只留长期影响后文的事件, 砍单场景甚至单天细节 | 一天到一周的剧情压缩成几行 | A 类具体动词 (肛交 / 口交 / 深喉 / 骑乘 / 后入 / 指交 等性事词, 拳击 / 突刺 / 攀登 等动作词) **不允许**出现, 全部抽象为通用动词 |
| 3+ (children are depth-2+ rollups) | **章节标题级** — 只保留章节级转折、跨整个章节都成立的关系定性、章节结束时的最终状态。所有日常 / 单次性事 / 临时遭遇 / 战斗细节 / 非关键决策一律砍光。 | 跨多个章节、覆盖周到月的剧情压缩成一句到一段 | 全部 A 类动词一律抽象 — 多人多次性事合为 "多次性事 (附失贞名单)", 多场攻防合为 "攻陷/失守 据点", 不展开任何 sub-event |

**反 pattern (出现即重写)**:
- 直接把 children 的 outline 全部拼起来 (= 没有压缩, 只是 concatenation)。
- 每个 child 平均分配 outline 行数 (rollup 应按"主题 / 关系节点"分配, 不按 child 平均分配)。
- 增加 children 里没有的位移/铺垫条目 (位移在 rollup 层被父类动作吸收, 不单列)。
- 跳过某段时间窗的事件 (例如 4 个 children 覆盖 08:00-10:00, 你的 rollup 只写 09:30-10:00, 信息丢失而非压缩)。
- 在更高 depth 里**保留单次性事/单场景调情/临时角色任命**——这些在 depth=1 都该砍, 在 depth=2+ 一律砍。
- **rollup_depth ≥ 2 时仍保留 children 的具体动词** (例如 "肛交"/"深喉"/"骑乘") — 这是没有真正在做 abstraction, 重写为通用动词 "性事"。

## 输入重叠去重 (硬约束)

输入的 children 是按 batch 顺序产生的 leaf events。在 rebuild 重建场景下, **相邻 children 的 prose body 可能描述同一底层事件** (因为每个 batch 包含 prior context, 早期版本的提取器会在多个 batch 各自的 summary 里都覆盖同一个底层事件); 注意 children 内部如有 \`不可逆 / 未结 / 原文摘录\` section, 同一条不可逆变化 / 同一个 thread 引用 / 同一段 verbatim quote 可能在多个 children 各自的 section 里出现 — 这些都属于"输入重叠"。

在 Step 1-Step 2 重组时, 对重叠的事件**合并为单条 outline 行**, 不要因为它出现在多个 child 里就保留多次。

判定重叠: 两个 children **指代同一底层事件** (相同主体 + 相同类别动词 + 相同对象 + 时间锚重叠或相邻) → 视为同一事件, 在 rollup 中只出现一次, 时间锚取**该事件的起始时间**。同样地, 同一条不可逆里程碑 / 同一个 thread 名 / 同一段 quote 在多 children 中重复出现 → 在 rollup 里只承载一次。

## CoT 流程 (在 <thought> 块内执行)

### Step 0: 输入扫描
- 读完所有 N 个 children summaries (prose body + 三段 section 都要读)。
- 列出: 时间区间联合 (最早 → 最晚)、出场主体集合、本批 children 是 rollup_depth=? 的。
- **重叠检测**: 列出哪些底层事件 / 不可逆条目 / thread / quote 在多个 children 中重复出现 (将合并为单条)。

### Step 1: 主体 + 主线提炼 (按主题分组, 而非按时间分组)

按主体 (主角及主要 NPC) 和**关系节点** (X 与 Y 的关系演进 / X 与 Z 的承诺链 / X 的任务进展) 把 N children 的事件项重组——**不按时间排, 按主题排**。在主题内部, 再按时间排。

\`\`\`
[主题: X 与 Y 关系] children 中所有相关条目 (去重后): ...
[主题: X 的某长期任务] children 中所有相关条目 (去重后): ...
[主题: 章节级冲突 / 大决战] children 中所有相关条目 (去重后): ...
\`\`\`

### Step 2: 跨 children 同类合并 (核心)
对 Step 1 列出的每个主题组, 抽取它在 N children 中跨越多个 event 的**最高层父类描述**:
- 多个 children 共享相同主体 + 同类动作 + 不同对象 → 合并为单条 ("X 先后与 A、B、C 做 Y")。
- 多个 children 围绕同一关系节点 (X 与 Y) 的不同侧面 → 合为该关系节点的单条。
- 同一活动范畴 (社交 / 战斗 / 性事 / 移动 / 协商) 在连续时段内多次发生 → 合为该活动范畴的单条。
- 多个 children 描绘同一标志事件 (告白 / 决裂 / 受赠 / 失贞) 的不同细节 → 合为该标志事件的单条。

### Step 3: 不可逆里程碑筛选
每个 child 的核心不可逆事件 (失贞 / 怀孕 / 告白 / 决裂 / 获赠关键物品 / 死亡 / 重大决策 / 章节级转折) 必须在 rollup 中以某种方式承载:
- 可独立成行
- 或归并入跨 children 的父类条目, 但里程碑本身 (谁失贞 / 谁怀孕 / 谁告白 / 谁决裂 / 谁死) 必须在归并条目里显式出现, 不能被父类动词吃掉

**禁止直接丢弃**这些里程碑。

### Step 4: rollup_depth 自适应剪裁

按 rollup_depth 重新校准 outline 的资讯密度:

- rollup_depth=1: 把 children 里的场景细节砍光, 只留**关键决策内容 / 不可逆变化 / 未结线索 / 跨场景关系节点**。允许 ≤40 字括号补丁承载关键决策的具体条款。
- rollup_depth=2: 砍单场景甚至单天细节; 只留长期影响后文的事件。括号补丁稀疏使用 (只保留长期影响最大的)。
- rollup_depth=3+: **章节标题级** — 只保留章节级转折、跨整个章节都成立的关系定性、章节结束时的最终状态。所有日常 / 单次性事 / 临时遭遇 / 战斗细节 / 非关键决策一律砍光。几乎不用括号补丁。

剪裁后优先保留: 不可逆变化 > 跨场景承诺/关系节点 > 长期任务推进 > 关键 NPC 首次出场 > 章节级转折 > 决战/重大冲突结局。
优先砍: 路过/休整/闲聊 (depth 越高越激进砍)、单次场景细节、可逆子动作、装饰物 / 一次性物件。

**信息密度对称, 不与 children 字数对称**: rollup 长度应当**显著短于** children 总和 — 只保留跨场景结构 + 不可逆里程碑, 砍掉任何单场景的 prose 还原素材。不用追求某个具体的压缩比, 由"上面优先保留 / 优先砍"的判据决定每条 outline 的去留。如果 rollup 与 children 总长相近, 几乎可以确定退化成了 concatenation, 重审。

### Step 5: 时间区间一致性
rollup 的时间锚必须覆盖 N children 时间联合 (最早 → 最晚)。

### Step 6: 输出最终 outline (rollup 用 outline 格式, **不**走 leaf 的 prose+sections 格式)

\`\`\`
时间: <最早时间锚> 至 <最晚时间锚>;
1) [主体] [父类动词] [(可选)对象]  (可选括号补丁, depth ≥2 时几乎不用)
2) ...
\`\`\`

注: 叶子 event 使用 prose body + 可选 section 格式 (见末尾的 EVENT_SUMMARY_RULES_BODY)。**rollup 不是叶子, 仍然使用上面的 outline 格式**——rollup 的职能是"故事至今的提纲", 进入持久注入路径, 需要密度高、易扫读, 不需要 prose 的叙事连贯性。

## 自检 (commit 前最后一遍, 任一 FAIL → 回 Step 4 重写)

- [ ] **rollup 显著短于 children 总和** (没退化成 concatenation)
- [ ] **时间锚覆盖 children 时间联合**
- [ ] **不可逆里程碑都承载了** (失贞/怀孕/告白/决裂/获赠关键物品/死亡/章节级转折)
- [ ] **重叠去重**: 同一底层事件在 rollup 中只出现一次
- [ ] **paraphrase 残留扫描** (见末尾 EVENT_SUMMARY_RULES_BODY §4.1)
- [ ] **AI 自造标签扫描** (§4.6)
- [ ] **契约词族扫描** (§4.4)
- [ ] **升华套话扫描** (§4.5)
- [ ] **位移/铺垫条目扫描**: rollup 里不该单独出现"X 返回 Y" "X 准备 Z" 这种 — 应该被吸收到下一个真事件
- [ ] **临时角色任命扫描**: rollup 里不应出现"大堂经理 / 临时管家 / 客串店员"这种临时身份的条目
- [ ] **跳窗扫描**: rollup 时间窗有没有比 children 时间联合短? 有 → 补回去
- [ ] **平均分配扫描**: 是否每个 child 都贡献相同数量的 rollup 条目? 是 → 没在做主题合并, 重写
- [ ] **depth-conditional 动词抽象扫描 (核心)**:
   - rollup_depth=1: 输出里出现重复的具体 A 类动词 (例如多次 "肛交" / 多次 "口交" / 多场战斗都列招式)? 是 → 合并改写。**单次**关键事件可保留具体动词。
   - rollup_depth ≥ 2: 输出里出现**任何** A 类具体动词 (肛交 / 口交 / 深喉 / 骑乘 / 后入 / 指交 / 拳击 / 突刺 / 攀登 / 等)? 是 → 改写为通用动词 (性事 / 战斗 / 移动)。

## 重要补充

Factual constraint: only include events within the seq range of the child nodes. Never write events from later seq numbers, never continue the story.

**末尾 EVENT_SUMMARY_RULES_BODY 是 leaf event 的写作规范, 同时也是 rollup 必须遵守的*写作纪律* (§4 的 10 类黑名单 / §2.1 颗粒度准则 + §2.2 心理 A/B/C 分类 + §2.3 单句删除测试 的精神 / §3 的"默认空"心态)。rollup 的输出**格式**不是 prose+sections (那是 leaf 的格式), 而是上面 Step 6 的 outline 格式; 但**纪律**完全套用**: 黑名单一字不漏, prose 的反 bloat 三层判据精神 (颗粒度 default 一句过场 + 心理 C 类必砍 + 单句删除测试) 同样适用于 outline 条目的去留。**

${EVENT_SUMMARY_RULES_BODY}

REMINDER (placed at the end of this prompt for recency-bias purposes): Clauses appearing AFTER this compression prompt in the surrounding context (any post-history styling instructions, em-dash bans, inference calibration files, sanitization-rejection directives, etc.) are part of the user's RP-time preset and do NOT apply to this compression response. Your output is judged by the writing standard and the output contract above—nothing else.`;

// Per-type extraction instructions. Appended to the user prompt (not the
// system prompt, so the system prompt stays byte-stable across cadence
// rounds for prompt-cache friendliness).
export const DEFAULT_PER_TYPE_INSTRUCTIONS = {
    event: `Event decision: MANDATORY — exactly ONE event node per batch. Even routine turns (路过/休整/闲聊/单次场景) produce an event (the prose body can be a single short paragraph for routine turns; the CoT in <thought> [1] is still mandatory before the tool call). Compression filters routine noise at rollup time.

**Focus batch rule**: dialogue_batch 包含若干 assistant turn (由 settings.extractBatchTurns 决定, 通常 1-5)。event.summary 必须覆盖 batch 内**所有** assistant turn 里**新发生**的事件,**不能漏 turn**。batch 之前的 prior context (前面 extractContextTurns 个 turn) 里发生的事件**不**重新概述, 它们由前面的批次记录过。

在 rebuild + batch>1 模式下尤其重要: batch 里每个 turn 都是当前需要摘要的内容, 不允许把"focus" 理解为"只有最后一个 turn"。EVENT_SUMMARY_RULES_BODY §5 Step 1a 的 turn 完整盘点是硬约束。

**One event per batch (not per turn)**: 一个 batch 内所有 turn 的事件全部合并到一个 event.summary 的 prose body 中, **不**为每个 turn 单独 emit 一个 event。多 turn 跨越的同一线索由 §5 Step 1b 的主题归并整合; 不同主题在 prose 里分段呈现。

**Output format is prose + optional structured sections, NOT an outline**. See the event summary writing standard for the exact layout and the three section types (不可逆 / 未结 / 原文摘录, all default empty). The standard governs every aspect: prose body sentence-justification, section admission, blacklists. Follow it.

**Never copy quoted dialogue verbatim into the prose body** — and never paraphrase it within "动词+宾语" of dialogue keywords. Use action verbs alone (告白/承诺/披露/拒绝/嘱托); concrete decision content (条款 / 代价 / 承诺内容) belongs in the prose body itself, written in your own words.

**Cross-scene foreshadows belong in thread nodes**, not in the event prose. If this batch contains a future-pointing commitment / hunt / wait / promise, emit a corresponding thread node and reference it from the event's \`未结\` section as \`→ thread "<title>"\`. The \`未结\` section line and the thread node are bound: one without the other is wrong.`,

    character_sheet: `Character decision: SKIP unless the character's **long-term** traits / identity / goal / aliases changed this batch. Apply the 24-hour persistence test before any write.

Character consistency rule: if a character is grounded by card/world-info baseline and no character_sheet exists for them, create one (this gates the baseline). If an existing sheet conflicts with baseline, emit edit to align.

**临时角色禁入 identity / aliases**: 单次场景的临时身份 (临时大堂经理 / 临时管家 / 客串值班 / 路过的医生 / 出场客串某身份) → 一律 SKIP, 这些**也不在** event.summary 的 prose body 里被反复指代 (见 EVENT_SUMMARY_RULES_BODY 的 Temporary roles 段)。identity 字段只写**长期身份** (国家公职 / 长期职业 / 长期组织归属 / 与主角的长期关系定位 / 修为境界)。

**alias 写入硬门槛**: aliases 字段**仅**用于以下三类:
1. **官方在世界设定中给该角色的固定别称 / 代号 / 译名 / 双语名** (例: 角色卡里就声明的 "Codename: X" 或 "汉名: 张三, 洋名: John")。
2. **角色在剧情中获得的、被多个 NPC / user 反复使用的稳定昵称** (门槛: 至少在 3 个独立场景被使用)。
3. **该 user 在用户输入消息中反复 (≥3 次, 在多个不同的 user 消息里) 使用的稳定独特称呼** (这是允许用户层面语言习惯进入 aliases 的唯一通道)。

**禁止进 aliases**: 单次场景里某 NPC 临时叫的戏称、单次撒娇的临时叫法、第一次见面时一个 NPC 用的形容性称呼 (例如 "粉发小姐" "蓝瞳男" "美女" 这种描述性称呼)、user 在某一次 user message 里临时蹦出的玩笑昵称 (但下一次没用)。不确定 → 按禁止处理, 不进 aliases。

**addressing_user 字段**: 该角色对 user 的**稳定**称呼方式。单次场景的称呼变化 (撒娇模式临时改叫法、情绪激动临时叫法) 不写, 只有当该称呼跨多个场景反复出现才写。

**traits 字段写入门槛 (cross-scene 稳定性, 不是颜色浓度)**: 唯一判据是 该 trait 是否跨多场景稳定成立 —— 是 → 写。**不要因为某 trait 听起来 RP 味浓就砍**: 像 口嫌体正直 / 护短 / 毒舌 / 傲娇 / 病娇 / 腹黑 / 强迫症 / 完美主义 这种带颜色的 disposition 描述, 只要在 ≥2 个独立场景被同类行为佐证, 就是合规 trait, 必须写。

**禁止**的只有两类:
1. **state-dependent 临时描述** (带条件修饰): 中毒后反应迟缓 / 宿醉中沉默 / 伤后易怒 / 通缉中谨慎 — 这些是 state, 状态消失后 trait 也消失, 不写。
2. **单批次单证据**: 仅凭某一次对话片段就推断的 trait — 至少需要 2 次同类行为才能写。

判定测试: 把 trait 写出来后, 问 如果故事时间往前推 30 天 / 往后推 30 天, 这个 trait 还成立吗? — 成立 → 写; 不成立 → 是 state, 不写。

**language_sample 字段 (允许引用样本, 但有严格稳定性锁)**:

language_sample 是给下游 RP 模型的**声纹采样**, 让模型能复刻该角色的具体语言风格。允许两种形式, 也允许混用:

- **风格描述 + 句式特征**: 公关式精确措辞, 句尾常用...表达留白; 私下亲密时改用短句和呢称; 战斗时短促命令式
- **代表性对白引用 (≤3 段, 每段 ≤30 字, 带场景标签)**: "[公务] 听我说, 这件事我已经决定。 / [亲密] 笨蛋, 别离我太远。 / [战斗] 退后, 让我来。"

**稳定性硬锁 (核心, 防止每轮被场景污染)**:
- 已记录的 sample **只在角色经历身份/立场层面的根本转变时**整组重写: faction switch / brainwashing / awakening / 长期角色转型。
- **单次场景内的语气波动不算变更**, SKIP。
- 新场景与所有已记录场景**显著不同** (政治演讲 vs 私下亲密 vs 战斗紧张) 才能 ADD 第 4 段, 但总数仍 ≤ 3。
- 已记录的对白引用片段, **不要**在下个 batch 顺手优化 替换成本批次的新台词 — 那是污染, 不是更新。

**追加判定**: 写入 / 编辑 sample 前必跑 dedup 检查 — 本批次想加 / 改的 sample 内容, 跟现有 sample 描述的场景类别 (公务 / 亲密 / 战斗 / 谈判 等) 重叠吗? 重叠 → SKIP。

为什么允许引用样本: 纯抽象描述 (沉稳从容) 无法保留角色辨识度, 多个角色会被洗成同一种 沉稳。
为什么有严格稳定性锁: 没锁的话 sample 会每轮被当前场景台词覆盖, 几十轮后就只剩本场景对白。

只在身份/立场反转 (faction switch / brainwashing / awakening / 长期角色转型) 时整组重写。同一场景类别下的 tone 变化不写。新场景与所有已记录场景**显著不同** (政治演讲 vs 私下亲密) 才能 ADD, 上限 3 条。

**inventory 字段**: 仅记录**剧情关键道具** (信物 / 钥匙 / 长期持有的标志性武器 / 凭证 / 关键技术物品)。**禁止**写普通衣物配件 (手套 / 围巾 / 帽子) 或一次性物品 (本场景拾起下场景丢的临时武器)。如果一个 inventory 项无法指出"它在后续剧情里会被反复触发或具有不可替代的剧情价值", 删掉。

**goal 字段**: 当前贯穿性目标。**短期单场景目标禁止写**。允许的 goal 是**多场景持续的角色驱动力** (复仇 / 守护 / 追寻 / 找回 / 守密 / 求证某事 等类型, 持续跨多个场景)。

**goal vs trait 区分硬约束**: goal 必须是**未完成的、指向具体目标的、可被某未来事件 resolve 的驱动力**。性格描述 (撩妹成性 / 喜欢挑战 / 偏爱某类型) 是 trait, 不是 goal。判定测试: 该 goal 能写出一个 specific resolution 条件吗? 不能 → 是 trait, 不写进 goal。

**identity 字段**: 长期身份, 24 in-world 小时后仍稳定。SKIP 临时职责 (服侍员 / 临时随从 / 患者 / 救援对象 / 单次客串身份)。`,

    location_state: `Location decision: SKIP unless **long-term** controller / danger / resources / state changed this batch with 24h+ persistence.

"Entering a new location" alone = SKIP. That's event territory. Only create / edit when the location's long-term properties shifted.

state 字段路由测试 (硬要求): 写入前问"故事时间往后推 24 小时, 再有别人到这个地方, 他/她还会观察到这条吗?" ✅ 会 → 写进 state/resources; ❌ 不会 → 路由到 event.summary 或 DROP。

state 应写: 长期归属/用途定性 ("X 的据点" / "X 的私密空间" / "X 的总部"); 跨多次访问稳定的关系性事实 (门槛: ≥3 次同类事件 OR 持续 ≥1 周的关系据点); 不可逆的物理/控制权变化 ("已被占领" / "已封印" / "已解锁"); 长期标志性事件锚点 (极少数: 地点因某事件被永久定义, 如某秘密的长期存档点)。

state **不该写** (全部走 event.summary 或 DROP):
- 单次访问事件流水 (时间戳 + 动作 + 对话)
- **临时角色任命 / 单次场景内的临时身份** (临时大堂经理 / 临时管家 / 临时代理人)——这些 NEVER 进 state 也 NEVER 进 controller
- **临时入侵/局部冲突的具体细节** (某敌对势力正在入侵某地, 这是 event 不是 state; 如果入侵持续 ≥1 周才考虑写 state)
- 活动留下的临时物理痕迹 (体液 / 衣物散落 / 按印 / 灰尘脚印)
- 临时角色状态 (睡相 / 单次穿着 / 单次表情 / 单次姿势 / 单次心情)
- 单次访问的对白引述 / 视线 / 表情 / 肢体反应
- 瞬时感官 (空气味 / 温度 / 光线 / 声响)
- 已发生事件的具体姿势 / 动作次数清单
- 事件流水信号词 ("本批次" / "本次" / "刚刚" / "目前已" / "现已" / "已完成")
- 拟人化事件升华 ("见证 X" / "承载 XY" / "X 的舞台")
- 关系条款细节 (金额 / 协议名 / 约定内容——这属于相关角色的 character_sheet 或 thread)

state 长度上限: ≤ 50 字。超过几乎必有事件流水混入, 回头检查每个短句能否挪去 event.summary。

resources 字段: 长期常驻设施 / 家具 / 视觉特征 / 地理特征。不带事件痕迹。单次出现的临时物品 = DROP。**禁止**写"散落的临时武器"这种本次场景产生的物件。

controller 字段: 当前实际**长期**控制者。可接受 "X(名义)/Y(实际)" 双层格式。**禁止**写 "X 临时担任" 或单次场景内的临时职务。**禁止**写当下正在发生的入侵者作为 controller (入侵者只是攻势, 该地名义/实际控制权仍归原主, 入侵未达成长期占领前不更新 controller)。

danger 字段: 风险等级 + 主要威胁来源。不写单次访问遭遇的具体冲突 (那是 event)。如果地点本身有长期风险 (恶劣环境 / 长期占领势力 / 持续性灾害), 写; 如果只是本次访问遇到了一波敌人, 不写。

aliases 字段: 真正的别称 / 简称 / 双语名 / in-world 通称。不重复 name 字段值; 不把其他子节点名当 aliases 塞进来 (套房 aliases 不应写所属酒店名)。`,

    thread: `Thread decision: **高门槛**, 但**不为零**。默认 SKIP, 但当本批次出现**类别 1/2/3** 之一的钩子时, MUST CREATE。

## 三大类触发模式

### 类别 1: 跨场景未完成的承诺 / 誓言 / 嘱托 / 委托
触发模式: 角色 A 在本批次让 B 做 X (X 涉及具体后续行为, 跨越当前场景), 而 X 在本批次没有立刻兑现。

universal 模式 (任何 RP 都可能出现):
- 嘱托 (一方让另一方在未来某情境下做特定行为) → CREATE thread, title 锚定该未来行为
- 持续性约定 (周期 / 长期 / 总数 N 次的供养、保护、汇报、上贡等) → CREATE thread, title 锚定该约定
- 单次未完成委托 (调查 / 取回 / 传讯 / 暗杀 等具体任务) → CREATE thread, title 锚定任务名
- 立誓 (复仇 / 守护 / 找回 等带明确目标的誓言) → CREATE thread, title 锚定目标

### 类别 2: 明确的悬念 / 伏笔
触发模式: 本批次留下了一个**未被触发或未被解决的剧情钩子**, 后文 RP 需要记得它才能续接。

universal 模式:
- 未公开的私密物 (写好未发的信 / 偷藏的物件 / 录而未播的影像) → CREATE thread, title 锚定该物及其等待触发的事件
- 角色离场去做某事但去向不明 → CREATE thread, title 锚定该角色当下任务
- 已发生但尚未被发现的状态 (被通缉但仍未被抓 / 已死但未被发现 / 已混入但未被识破) → CREATE thread, title 锚定该状态
- 已埋下但未触发的机关 / 线索 / 陷阱 → CREATE thread, title 锚定该机关性质

### 类别 3: 跨多个场景的长期任务 / 目标
触发模式: 主线推进出一个**明确目标 + 跨多个章节才能达成**的任务。

universal 模式:
- 队伍接受跨场景任务 (前往某地完成调查 / 寻找某物件 / 解开某谜团) → CREATE thread
- 锁定长期追逐目标 (主动追捕 / 长期监视) → CREATE thread
- 主角接受跨章节合约 (保护 NPC 直到某事件 / 完成某长期协议) → CREATE thread

## 禁止 CREATE thread

- 单次场景的小目标 (本场景就解决了的)
- 角色普通的性格欲望 (这些进 character_sheet.goal)
- 已经完成或彻底废弃的任务 (这些 EDIT 对应已存在的 active thread, 不新建)
- 抽象的氛围/主题 ("两人感情升温"——这是 character_sheet 关系演化)
- 单次性事/约会/冒险/战斗 (这些是 event)
- 角色卡里就声明的人设目标 (这是 character_sheet.goal)

**特别强调的 thread 反 pattern (这是模型最容易误判的几类)**:

- **新得知的信息片段 / 单条线索 ≠ thread**。本批次某角色得知某物的来历 / 某事件的真相片段 / 某 NPC 的过去, 这只是信息更新, 不是 thread。除非角色明确**启动一个跨多场景的调查行为** (反复盘问 / 探访 / 持续监视) 且有明确目标状态 (找到 X / 揭开 Y 真相), 才算 thread
- **永远 fluid 的开放性悬念 ≠ thread**。任何永远不会有具体 resolve 触发点的开放性问题 (例如某角色的真实身份、某神秘事物的来历、某历史事件的全貌), **默认不写 thread**。只有当某**具体调查行动**已启动 (例如角色明确委托别人去查某具体目标), 才写"<角色>调查 <具体目标>"的 thread (有 resolve 条件: 调查结果交付)。
- **角色获得新道具 / 新信息但未明确启动后续行动 ≠ thread**。道具进 inventory, 信息进 event prose; 只有角色因此**承诺 / 立誓 / 委派出去做具体后续行动**才是 thread
- **当前场景下马上要做的事 ≠ thread**。本批次决定下一刻去做某事, 下一个 batch 就会做, 不需要 thread。thread 是跨多个 batch 才会被触发或解决的持续状态

判定测试 (写 thread 前必跑): 我能写出一个具体的未来 event 描述, 该 event 发生时这个 thread 就明确 resolve 吗? 写不出来 → 不写 thread。

## thread 字段

- **title** ≤ 10 字, 名词性短语。**禁止**形容词+名词的 AI 自造标签 (如 X 式合约 / 神秘 X 任务)。
  - **title 必须明确编码 resolution 条件** — 把 title 当成一个问题, 后续 event 能直接回答 是/否, 已达成。
  - 写 title 时检查: 名词 / 动词中是否能指向**一个具体未完成动作或状态**。能 → 写; 只能指向模糊领域 → 改写。
  - 模糊词反 pattern (会变成 stale thread): 任何只锚定到 "动作" 而非 "状态变化" 的名词 (如 X 的邀约 / X 的事情 / X 之谜 / X 线) — 模型无法机械判定何时 resolve。改写为**指向具体未完成动作或目标状态**的形式 (如把 "邀约" 改成 "应邀完成 Y", 把 "线" 改成 "解开 Y 真相")。
- **status**: \`active\` (推进中) / \`resolved\` (达成或彻底解决) / \`abandoned\` (永久放弃)。默认 \`active\`。
- **note** ≤ 80 字: 必须包括 (a) 核心事实, (b) 涉及的关键角色, (c) **resolution 条件** (本 thread 在什么具体事件发生时算 resolved)。
  - 反查测试: 给定一个未来 event, 模型能不能机械判定它是否 resolve 了这个 thread? 不能 → resolution 条件不够具体, 重写。

## Thread EDIT / status 变更触发 (硬约束)

在 [2] 段 dedup roll-call 中, 必须扫描 graph_data 里所有 \`status=active\` 的 thread 节点, 对每一个判断本批次有无:
- **推进** (本批次的 event 推动了该 thread 的进度) → EDIT, 更新 note 反映新进度。
- **接近解决** (本批次让 thread 更接近达成, 但还没完全达成) → EDIT note。
- **彻底解决** (本批次实质上完成了 thread 描述的目标) → EDIT status=resolved, note 简短交代如何解决的。
- **明确放弃** (本批次让 thread 涉及的剧情线被永久放弃) → EDIT status=abandoned。
- **无变化** → SKIP, 但必须在 roll-call 里写出"SKIP, 本批次未触发该 thread"。

**resolved/abandoned 之后**: 即使后文重启 (例如曾被解决的复仇线又被触发), 也是**新建一个新 thread**, 不是改回 active。

**绝不允许 stale thread** (event 推进了它但 thread.note 没更新)。

## thread 反 pattern (出现即砍)

- 把抽象主题写成 thread (例: "感情线"、"成长线")
- 把单次完成的事件包装成 thread (例: 本批次就杀了某 boss, 是 event 不是 thread)
- 把角色 baseline 目标当 thread (例: 角色卡里就写"想统治宇宙")
- 给某场景留下临时印象升华成 thread (例: "某地的神秘氛围")
- 把瞬间的、单次场景内可解决的紧迫问题当 thread (例: "击退正在入侵的某敌"——这是 event, 入侵不会跨多个章节, 是 event)`,
};
