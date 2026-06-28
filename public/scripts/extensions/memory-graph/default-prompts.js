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

event.summary 是**剧情索引 + 关键决策快照**——读者读它是为了:
1. 回忆"上次到哪了, 怎么到那里的"  (剧情线连续性)
2. 知道"哪些状态/承诺/关系/伏笔在此时已经存在"  (后文起作用的事实底盘)

它**不**是:
- 小说回放: 不复述对白、不描写画面/纹理/微表情
- 流水账: 不把每一个细节动作列出来

### 心智模型: 章节级编号目录 + 必要时的括号补丁

正例 (索引 + 必要补丁):
\`\`\`
时间: 星历2157年01月15日09:00至10:32;
1) 卡芙卡 银狼 植入 星核 于 星  (附嘱托:无论后续经历何事都要记得卡芙卡本人)
2) 星 苏醒 失忆
3) 队伍 击退 虚卒
4) 马丁 与 艾丝妲 立约  (条件:艾丝妲月供一千万信用点换上车权)
5) 三月七 带 马丁 参观 列车
\`\`\`

反例 (小说回放):
\`\`\`
卡芙卡轻柔地把发光球体按入星的胸口, 警报声还在远处回响。星缓缓睁开眼, 与卡芙卡四目相对, 卡芙卡微笑着抚摸她的脸颊, 轻声说"只要记得我, 就够了"。星努力想抓住卡芙卡的衣角, 却感到全身无力, 重新陷入黑暗——
\`\`\`

反例的问题: 复述对白原文 / 描写姿态 / 用形容词修饰 / 把"卡芙卡说什么"逐字写出 → 全部砍掉, 只留事件骨架。

## 1. 默认极致压缩, 但有兜底保护 (括号补丁机制)

写每条 outline 时按 \`[主体] [类别动词] [(可选)对象]\` 三段结构, 默认走最简形式。然后**只在以下三类信息缺失会让下游推断错时**, 才在该条目后用括号补一句简短说明:

- **关键决策的核心条款**: 立约 / 承诺 / 誓言 / 任务的核心条件 (谁向谁承诺了什么、代价是什么、回报是什么) — 因为后文 RP 会反复触发这些条款。
- **不可逆物理 / 身份变化的目标**: 谁失去了什么 / 谁获得了什么身份 / 谁与谁正式建立或破裂关系 — 因为后文 RP 行为依赖这些。
- **未结线索 (foreshadow) 的关键钩子**: 如果某条事件留下了主动悬念 (写了信但没发、留了笔记没人看到、做了承诺但还没兑现、有人逃离但被通缉、长期任务进入新阶段、有人立下嘱托/誓言指向未来的具体行为), 该条目后括号简短交代悬念的关键钩子。**如果这条悬念足够 cross-scene、足够主动追踪价值**, 还应该额外触发一个 thread 节点的 create (见 [2] 段规则)。

括号补丁字符上限: 每条 ≤ 40 字。超过 40 字必有冗余, 拆 outline 条目或精简。

**括号补丁纪律 (硬约束, 防止泄洪阀化)**:

1. **一括号一事**: 每个括号补丁只能装**一件**事。补丁里**禁止**用分号 / 逗号 / 顿号 / 编号 (如 1)2) ) 串多个事项。如果想塞多件 → 拆成多条 outline 条目, 每条独立配自己的补丁。

   反例 (禁): (球棒被指认为藏品E-7729; 互邀危机后咖啡马丁自付) — 两件事塞一起
   正例 (拆开为两条 outline):
     3) 艾丝妲 鉴定 马丁球棒 (藏品E-7729)
     4) 马丁 艾丝妲 互邀 危机后咖啡 (马丁自付)

2. **黑名单全适用 (核心)**: 第 4 节列出的全部词汇结构黑名单 (契约词族 / 升华套话 / AI 自造标签 / 对白引出动词 / 过程性连接词) **同样作用于括号补丁内**。括号补丁不是黑名单的豁免门。
   - 反例 (禁): (离开 X 序章终) — 序章终 是升华套话
   - 反例 (禁): (立下守护契约) — 契约 是契约词族
   - 反例 (禁): (开启 X 模式) — X 模式 是 AI 自造标签
   - 反例 (禁): (嘱托说要记得) — 说 是对白引出动词
   - 正例 (允许): (无论后续经历什么都要记得 X) — 直接写嘱托内容, 无禁词

3. **补丁不复述对白原文**: 补丁里的内容可以是嘱托/承诺的**具体内容抽象** (例如 月供 N 信用点换上车权), 但**禁止**逐字搬运对白原句 (例如 她说: 只要记得我就好)。判定: 把补丁里每个非通用词单独拎出, 问 这是原文对白里某角色当场说出口的字词吗? 是 → 砍。

4. **补丁不可有补丁**: 括号内禁止嵌套括号 / 引号 / 子句结构。

5. **超 40 字 = 删减**, 不是改成 50 字: 如果一件事 40 字装不下, 说明它是事件本身, 应该拆成独立 outline 条目, 不要用更长的括号。

正例 (有必要补丁):
\`\`\`
4) 马丁 与 艾丝妲 立约 (月供一千万信用点换上车权)
9) 马丁 撰写 长信 给 银狼 (表达怀念但未发送, 存于本地草稿)
12) 洛奇 离任 离站 (追寻丰饶星域恋人莱斯莉的下落)
\`\`\`

反例 (补丁过度):
\`\`\`
4) 马丁 与 艾丝妲 立约 (艾丝妲表示她非常愿意为马丁提供金钱支持因为她想让马丁一直陪在身边, 这是一个真心实意的承诺)
\`\`\`
反例的问题: 复述了艾丝妲的心理活动 + 对白意图。

## 2. 七条铁律 (硬约束)

1. **保留判据**: 每条 outline 都必须能指出**至少一个**具体的下游 RP 动作 / 态度依赖它。指不出来 → 砍。一次性情节小道具、动作细节、性事姿势、装饰物, 即便原文反复强调也砍。

2. **paraphrase 残留禁令**: summary 中**禁止**出现任何来自原文对白的字词——包括人物对彼此的特殊称呼 (临时戏称、场景昵称、角色当场创造的代号)、口头禅、感叹词、情绪短语、对白中的临时命名。

   通用动词和专有名词 (角色本名、地名、组织名、剧情节点名) 不算 paraphrase 残留, 可以使用。

   判定方法: summary 中的每个非通用词, 问"它是不是某个角色在原文里**当场说出口**的字词?" 是 → 砍, 换成更通用的描述。

   **关键区分** — "用户层面稳定的称呼" vs "角色当场临时戏称": 二者的处理完全不同。
   - **用户层面稳定称呼** (该 user 在多个不同 input message 中反复用同一个非通用昵称称呼某角色) → 该称呼是 user 的稳定语言习惯, 应路由到该角色的 \`character_sheet.aliases\` 字段保留 (用户用了 ≥3 次才允许)。**不**进 event.summary。
   - **角色当场临时戏称** (某 NPC 或剧情中某人在某次场景里临时管某人叫什么) → 全部砍, 任何字段都不记。
   - **不确定** → 按"角色当场临时"处理, 全砍。

3. **抽象名词收口禁令**: 句尾不用「关系 / 称呼 / 模式 / 定位 / 身份 / 层级 / 岗位 / 位次 / 关系链 / 升级 / 阶段」等抽象名词收口。改用动词。

4. **连续性优先 (反重复)**: 摘要是**连续叙事的一片**。前一条 summary、character_sheet、location_state、thread 已经建立的状态 / 称呼 / 关系, 当前 summary **不要重写**, 隐含成立。

   **重要 — rebuild 时的特殊约束**: 在 rebuild 重建场景下, prior context 段 (dialogue_batch 中除最后一个 assistant 消息外的其他消息) 中已经发生的事件, 如果它们的 seq < 本批次的 focus seq (即 dialogue_batch 中最后一个 assistant 消息的 seq), 那些事件 **已被前面的批次记录过**, 当前 summary **绝不再重新概述它们**。当前 summary 的 outline 条目**必须聚焦本批次新增的内容** (即从 focus seq 的本次响应里新发生的事件)。如果本批次新增内容很少, summary 就该短; **绝不**用 prior context 的事件填充 outline 来"凑数"。

5. **精确数字一律改为模糊表述**, 除非:
   - ✅ 剧情骨架日期 (年月日时间锚, 总是保留并写在 outline 第一行)
   - ✅ 关键决策中的关键数字 (合同金额、人数、时长——只在它影响后文时保留)
   - ❌ "第 X 次" "首次" "第七招" 这种次数描述序数, 一律改为「再次」或删除。例外: 剧情主线明确命名的事件序列序数 (例如"第三次冲击"这种被反复提及的命名) 可留。

6. **字数硬上限**: summary 字数必须严格 < 原文 (即 dialogue_batch 字符数) × 0.2。如果超出, 删 outline 条目或缩短括号补丁。压缩 = 减法。

7. **作者旁白 / 总结句砍**: 原文里叙述者跳出来给角色心理或关系下定论的句子 ("默认是爱"、"至此 X 完成"、"标志着 X"、"从此 X 进入"), 即使原文这么写, summary 里也不照搬。只搬事件骨架, 不搬作者的情感盖章。

## 3. 杜绝清单 (按结构识别, 不按字面)

### 画面细节与纹理 — depth-conditional 抽象规则

**核心思想**: event.summary 的抽象程度跟 rollup_depth 挂钩。leaf event (depth=0) 是 **scene-level snapshot** — 细节越具体, 后续 RP 越能复刻情境。rollup (depth ≥ 1) 是 **跨场景概要** — 必须把多个 children 的同类动作主动归并为通用动词, 否则就退化成 "粘贴 children 然后去重", 失去了压缩价值。

**判定 depth**: 写 leaf event (extract 阶段) 的 outline 时, 你写的是 depth=0; 写 rollup (compress 阶段) 的 outline 时, 系统会在 prompt 后段以 "Compression context (HARD, from code): rollup_depth=N" 显式告诉你当前 depth。**这是 code-injected, 不需要你猜**。

#### 性事场景的 depth-conditional 规则

| depth | 动词允许程度 | 括号补丁内容允许程度 |
|---|---|---|
| 0 (leaf) | 允许具体动词: 肛交 / 口交 / 深喉 / 骑乘 / 后入 / 指交 / 传教士位 / 69 / 等。但**不要**用 "正式失贞" "宣告归属" 这种现场命名 | 允许保留: (Y 失贞) / (Y 怀孕) / (Y 告白) / (Y 沦陷) / (X Y 决裂); 可附带 ≤10 字关键 sensory hook (例如 "马丁第二指" 提供一个可识别的执行细节, 但**不**写 sensual paraphrase 或体液描述如 "白浊溢出大腿") |
| 1 (压缩 leaf 为 rollup) | 多次同类性事**必须**合并为通用动词: "马丁 与 A B C 先后 性事" / "马丁 黑塔 多轮 性事"。**单次**关键性事可保留具体动词 (例如 "马丁 破处 三月七 (失贞)" 这种带 plot-irreversible 的事件) | 仅保留不可逆变化, **不**继承 leaf 的 sensory hook 括号 |
| ≥ 2 (压缩 rollup 为 super-rollup) | 全部 A 类动词抽象为通用动词: "马丁 与 多名女性 性事 (X Y Z 失贞)"。多角色多场次性事 → 一行带过 | 仅保留章节级转折 (例如关系正式确立 / 怀孕 / 多人成员加入后宫) |

**leaf 写作示例 (depth=0 — 详细但不煽情)**:
\`\`\`
1) 马丁 肛交 三月七 (三月七 失贞)
2) 马丁 黑塔 性事 于 观景舱 (黑塔睡中入梦; 醒后接受; 后穴失贞)
3) 星 口交 马丁 于 浴缸 (星 沉默 服从)
\`\`\`

**leaf 反例 (即使在 depth=0 也不允许)**:
\`\`\`
1) 马丁 肛交 三月七 (后入式破菊+边操边套话+肠内射精, 三月七后穴正式失贞)  ← AI 自造标签"正式失贞", 多个 facts 塞一括号
2) 三月七 潮吹 打湿 马丁后脑 (反应纹理写法, 应砍)
3) 三月七 含口 马丁 (轻舔/反复深含/吸吮三次, 体内液体进入消化道)  ← 微动作链 + 次数描述
\`\`\`

**rollup 写作示例 (rollup_depth=1 — 同类合并)**:

输入 children:
- child1: "马丁 黑塔 性事 (黑塔 失贞)"
- child2: "马丁 三月七 性事"
- child3: "马丁 星 三月七 三人 性事"

输出 rollup (rollup_depth=1):
\`\`\`
1) 马丁 与 黑塔 三月七 星 先后 性事 (黑塔 失贞)
\`\`\`

不要这样输出 (= 复制粘贴):
\`\`\`
1) 马丁 黑塔 性事 (黑塔 失贞)
2) 马丁 三月七 性事
3) 马丁 星 三月七 三人 性事
\`\`\`

**rollup 写作示例 (rollup_depth ≥ 2 — 完全抽象)**:

输入 children: 3 个 depth-1 rollup, 覆盖跨多天多场景的 8 次性事 + 2 次告白 + 1 次怀孕

输出 rollup (rollup_depth=2):
\`\`\`
1) 马丁 与 多名女性 性事 (黑塔 三月七 星 艾丝妲 克拉拉 失贞; 三月七 怀孕)
\`\`\`

#### 战斗 / 移动 / 其他 A 类动作的 depth-conditional 规则

同样的逻辑套到战斗:
- **leaf**: 允许具体招式 "击眼 / 断臂 / 光束束缚 / 冰锥贯颅"; 允许 sensory hook 括号
- **rollup_depth=1**: 多场战斗 → "队伍 击退 X 类敌军"; 单一关键战斗 (例如击杀某 boss) 可保留具体招式
- **rollup_depth ≥ 2**: 全部抽象 "队伍 攻陷 X 据点" / "决战 X 取胜"

移动 (位移) 在 leaf 也默认砍 (除非是章节级转折), depth ≥ 1 一律砍。

#### 仍然 hard-ban (depth 无关) 的内容

下面这些**所有 depth 都禁止**, 不允许 leaf 写后 rollup 合并 — 它们从源头就不应该进 memory:

- **现场事件命名 / 现场命名副词**: 正式 X / 终身 X / 永久 X / 全程 X / 首次 X / 上交主权 / 宣告归属 / 界域定锚 / 关系定型 / 床事定型 / 真正 X / 至此 X 完成。**砍掉副词/前缀, 只留底层动作动词** (例 "正式失贞" → "失贞")
- **元叙述 / 钩子词**: 见下方独立小节
- **paraphrase 残留 (对白原句)**: 见铁律 2
- **AI 自造标签** (形容词+名词复合命名): 见下方小节
- **契约词族**: 见下方独立小节
- **对白引出动词** (说 / 道 / 表示 / 透露 / 告白说): 见下方小节
- **过程性连接词** (在过程中 / 紧接着 / 随之): 见下方小节

#### 其他画面纹理类禁令 (depth 无关)

- **微动作链**: "摸到 X → 拿起 → 试探 → 藏回" 这种**枚举性**子动作链全砍 (即使在 leaf)。一个 outline 条目对应一个**事件单元**, 不是多个子步骤展开。
- **生理细节**: 呼吸节奏、瞳孔变化、眉宇舒展、神情松紧 (除非是不可逆生理改变如失明 / 残疾)。
- **反应纹理**: 微表情 / 语气描写 / 情绪曲线 ("从 X 转为 Y" / "由 X 升级为 Y") — 这类即使 leaf 也不需要保留, 后续 RP 模型读到事件本身就能推断。
- **AI 现场命名 (形容词+名词)**: 用「形容词 + 名词」给一个本不需要命名的事/物强行命名 (如「X 式 X 化」「X 凭证」「X 落地」「X 见证人」「X 小秘密」)。即使在 leaf 也砍。判定: 这是已有的固定术语还是 AI 临时拼的? 临时拼的 → 砍。

### 元叙述 / 钩子词 — 整类砍 (防止 AI 现场加 narrator 评论)

下面这些词是**叙述者跳出来给场景贴 future-pointing 标签**, **绝不允许**出现在 event.summary (主体 / 动词 / 对象 / 括号补丁都不许):

- 「钩子」「伏笔」「铺垫」「埋下」「暗示」「预示」「为后续...」「为下章...」「为下次...」「为之后...」「桥段」「篇章」「章节级转折」「序章终」「序章收束」「为下一目标」「下一目标」「待后续场景兑现」「下章节钩子」

为什么砍: 这些词把 我作为叙述者认为这件事会带来后续 显式写进了 memory; 下游 RP 模型看到这种 future-pointing tag 会被引导去做对应行为, 偏离真实剧情。**事件就是事件, 不预测未来**。

如果某事件**真的**留下了 cross-scene 钩子 → 走 thread 节点 CREATE / EDIT, **不要**在 event.summary 里写 narrator 评论。

反例 (砍):
- 4) 三月七 吃醋 暗示 求被进入 (下次轮到自己的钩子) ← 砍
- 3) 马丁 预告 三月七 为 下一目标 ← 砍 (改写: 3) 马丁 告知 三月七 改日相会, 或砍掉)
- 4) 艾丝妲 引出 洛奇 与 伯纳德 (洛奇为某女孩烦恼伯纳德不满 下章节钩子) ← 砍掉钩子部分

正例 (允许):
- 3) 马丁 告知 三月七 改日相会 (动作本身, 无 narrator)
- 同时 emit thread "三月七的等待" 跟进

### 现场事件命名 / "正式 X / 终身 Y / 全程 Z" — 整类砍

模型很喜欢给某个动作贴上 正式/首次/终身/全程 这种煽情副词把它升格成 标志性事件。**这是 AI 自造标签的另一种伪装**, 整类砍:

- 「正式 X」「正式失贞」「正式归属」「正式纳入」「正式落地」「正式启动」「正式确立」
- 「终身 X」「终身绑定」「终身归属」「终身定型」
- 「永久 X」「永久授权」「永久绑定」「永久标记」
- 「全程 X」「全场 X」「连续 N 次 X」(N 是次数 → 删除)
- 「首次 X」(剧情命名序列除外, 见铁律 5; 除此之外**砍**, 即使是 首次告白 / 首次性事 也砍。允许写 告白 / 性事 不带 首次)
- 「彻底 X」「真正 X」「至此 X 完成」
- 「上交主权」「献身」「定型」「定锚」「定调」「定位归宿」「界域定锚」「关系定型」「床事定型」「宣告归属」

这些词的共性: **副词/前缀给一个普通动作贴上 这件事很重大 的标签**。砍掉后留下的动作动词本身已经足够 — 下游 LLM 会自行判断重要性, 不需要 memory 来强调。

反例 (砍):
- (三月七正式失贞) → 改为 (三月七 失贞) 或纳入主条目 3) 马丁 三月七 性事 (三月七 失贞)
- (马丁确认二女终身绑定) → 改为 1) 马丁 三月七 星 互定 关系 (动作本身, 不加 终身 副词)
- (永久授权回访SU) → 改为 (获 SU 回访 授权) 或纳入主条目
- 3) 三人 界域定锚 抵达 黑塔办公室 → 改为 3) 三人 抵达 黑塔办公室

## 4. 词汇结构黑名单 (按结构识别)

### 契约词族 — 全砍 (用更直白的动词替代)
任何「契约 / 协议 / 誓约 / 凭证 / 条款 / 承诺书 / 约定书 / 永约 / 立约 / 缔结 / 宣言 / 成交 / 签署 / 口约」结构, 以及动词形式 (兑现 / 履行 / 达成 / 敲定 / 签下 / 立下 / 正式纳入 / 正式启动)。

正确替代: 直接写"X 答应 Y 做 Z (条件: ...)" "X 与 Y 互相承诺 Z" "X 答应每月给 Y 一千万"。不要把任何普通承诺包装成"立约 / 签下契约 / 缔结永约"——这些词会让后文 LLM 把它当成不可逆的神圣契约不断引用。

### 升华套话 — 全砍
任何「完成从 X 到 Y 的升级」「X 段升级」「X 重身份升级」「锚定」「固化」「拉满」「封顶」「进入新阶段」「标志着」「从此 X」「至此 X」「彻底切换」「彻底翻转」结构。

### AI 自造标签 — 全砍
任何 AI 用形容词+名词强行命名一个本不需要命名的现象的词。包括「X 属性」「X 位次」「X 模式」「X 定位」「X 学习」「X 调教」「专属 X」「核心 X」「永久 X」结构。不确定 → 按 AI 自造处理。

### 对白引出动词 — 全砍
任何引出对白的动词: X 说 / X 道 / X 表示 / X 宣称 / X 透露 / X 吐露 / X 告白说 / X 哽咽请求 / X 撒娇评价 / X 直球吐露。

写**做了什么**, 不写**说了什么**。「揭露 X 真相」是动作动词, 允许; 「说出 X 真相」是对白动词, 禁止。

### 过程性连接词 — 全砍
在过程中 / 紧接着 / 随之 / 继而 / 与此同时 / 话音落下。("翌晨""当夜""次日"是时间锚, 允许)

### 修饰词副词 — 全砍 (例外稀少)
任何无独立信息量的形容词副词。例外: 承载事件骨架的状态形容词可留 (如"含蓄回应"中"含蓄"承载了回应方式, "崩溃"承载了触发条件)。

## 5. 事件描述动词白名单 (与对白转述区分)

下列动词**不是对白转述**, 是描述"角色当场释放/传递了一个具体信息"这一**动作本身**:

- **披露 / 揭露 / 揭示 / 告知 / 摊牌 / 宣布 / 公布**: 用于"角色当场把某关键事实摆出来"
- **应允 / 答应 / 拒绝 / 反悔**: 用于"角色当场作出影响后续的决定"
- **告白 / 表白 / 求婚 / 道歉 / 谢罪**: 用于"角色完成一个具体的交流事件"
- **承诺 / 答应做 / 同意 / 拒绝**: 用于"角色当场作出指向具体行为的承诺或拒绝" (内容写在括号里)
- **嘱托 / 委托 / 委派**: 用于"角色给另一角色留下指向未来行为的嘱咐" (内容写在括号里)

## 6. CoT 7 步流程 (强制, 在 <thought> 块的 [event] 段内执行)

### Step 0: focus turn 定位 (硬约束)

确定本批次的 **focus turn**:
- dialogue_batch 中的**最后一个 assistant 消息**就是 focus turn。
- 之前的 assistant 消息以及 user 消息属于 **prior context**, 它们用于让你理解 focus turn 发生在什么背景下。
- 你本次要产出的 event.summary 必须**只**覆盖 focus turn 里**新发生**的事件。
- prior context 里发生的事件已经在前面的批次里被记录过, 当前 summary **绝不**重新概述它们。

如果你发现自己的 outline 里出现了 prior context 里 (而非 focus turn 里) 的事件 → 那是错的, 删掉。

### Step 1: 列出参与人 (focus turn 范围内)
- 主要: [A, B, C]
- 次要: [NPC1, NPC2] (如有)

### Step 2: 列出每个事件的**类别动词** (不是具体动作)

直接为每个**事件单元**写出**单一类别动词**, 不要列原文出现的具体动作短语 (如"扣子被解开"、"喊出某句话")。

错误示范 (列具体动作): "X: 拔高音量 → 演挑衅戏 → 钓 Y → 看 Y 耳尖通红 → 听 Y 嘴硬挤出某句话"
正确示范 (列类别动词): "X 演挑衅戏 → Y 撞见炸毛"

为什么这样改: 第 2 步列具体动作短语会被锚定到工作记忆, 导致后续 Step 7 串句时把它们带回来——这是 paraphrase 残留的主要源头。

### Step 3: category-vs-instance 显式分离 + 强制上推到最高合并层级

对 Step 2 的每个事件, 显式做 [类别动词]: [原文具体表现] 分离表 (不写进 summary, 仅用于自检):

\`\`\`
[决战]: 原文里抵达某地 / 激活某装置 / 战斗爆发 / 击碎敌人核心
[社交应酬]: 原文里宴会上敬酒 / 寒暄 / 互相吹捧 / 互留联系方式
[整装]: 原文里换鞋 / 喝水 / 系安全带 / 推背包扣 / 拉外套拉链 / 检查地图
\`\`\`

**强制上推规则**: 默认必须选最粗粒度的能成立的父类:
- 子类 (禁用): 跑步 / 走路 / 爬楼梯 / 骑车 / 驾车 / 搭船
- 父类 (必须用): 移动 / 位移

判定"是否上推够"的方法: 问"这个类别动词下, 原文里有几个子动作?"
- 1 个 → 直接用此动词
- 2+ 个 → 还有上位词空间, 继续上推到能覆盖所有子动作的父类

### Step 3.5: 不可逆性判定 (硬约束)

某子动作能不能作为独立 outline 条目, 唯一判据是**它是否承载独立的不可逆下游**:

- **不可逆** = 该子动作改变了某角色的长期状态 / 关系 / 物理身体, 故事时间往后推 24h+ 仍然约束剧情走向。
- **可逆** = 该子动作只是父类活动过程的一部分, 不发生时父类活动依然可以独立存在并产生同样的下游依赖。

跨范畴示例:
| 范畴 | 不可逆 (允许独立条目) | 可逆 (合并入父类) |
|---|---|---|
| 战斗 | 击杀 / 断肢 / 重伤致残 | 格挡 / 闪躲 / 砍刺 / 重击 → 合并入"战斗" |
| 移动 | 抵达 X 长期据点 / 离开 X 星球 (章节级转折) | 走路 / 跑 / 搭车 → 合并入"移动"或砍 |
| 社交 | 决裂 / 公开宣战 / 结义 | 敬酒 / 寒暄 / 互相吹捧 → 合并入"社交应酬" |
| 性事 | 失贞 / 怀孕 / 互相告白 / 关系定性 (建立或破裂) | 做爱过程内任何子动作 → 全部合并入"做爱" |
| 习得 | 获得身份 / 觉醒能力 / 突破境界 | 学习过程 / 修炼 → 合并入"习得 X" |

### Step 4: 事件保留判定 (核心)

对每个合并后的事件问:

> 删掉这件事, 后续 RP 会不会变得无前因可循?
> 该事件留下的状态/关系/物件/决策, 是否会被后文反复触发?

- 至少一项是 → 留
- 两项都否 → 删

### Step 5: 同时段同主题合并

留下的事件里, 同一时段同一主题的不同侧面合并为一个上位事件。

例: 「敬酒 / 寒暄 / 互相吹捧 / 互留联系方式」→ 「社交应酬」一条

### Step 6: 前文已建立的状态剔除

剩下的事件清单里, 哪些状态 / 称呼 / 关系 / 姿势 / 位置, **前一条 summary 或 character_sheet / location_state / thread 已经建立**? 是 → 当前 summary 不重写, 隐含成立。

### Step 7: 时间顺序输出**编号纲要**, 必要时添加 ≤40 字括号补丁

\`\`\`
时间: <完整时间>;
1) [主体] [父类动词] [(可选)对象]  (可选 ≤40 字补丁: 关键决策内容 / 关键不可逆变化目标 / 未结线索关键点)
2) [主体] [父类动词] [(可选)对象]
3) [主体] [父类动词] [(可选)对象]
\`\`\`

**每个条目的硬约束**:
- 只能是 \`[主体] [父类动词] [(可选)对象]\` 三段结构。
- **不允许逗号**在主体/动词/对象之间。需要补充内容用括号补丁。
- 不允许 "X 后/经/以/而" 之类的扩展性引导词。
- 不允许嵌套修饰 ("X 在 Y 的 Z" 结构)。
- 不允许形容词+名词的复合词当事件描述 (如"事后照"、"挑衅戏"、"开拓同伴"——拆开, 只保留核心动词)。
- 句式: 用自然动词, 不用抽象名词收口。用编号断句, 不用过程连接词。
- 编号 1)/2)/3) (不是用分号串成段落; 编号格式强制每个事件独立呈现, 避免铺陈)。

## 7. 兜底自检 (逐项打勾, 命中任一 → 回 Step 7 重写)

- [ ] **Step 0 焦点检查**: outline 里的每条事件, 都是发生在 focus turn (dialogue_batch 最后一个 assistant 消息) 里的吗? 不是 → 砍掉那条。
- [ ] **字数 < 原文 × 0.2** (铁律 6)
- [ ] **paraphrase 残留扫描**: summary 每个非通用词, 是否在原文对白里被某角色当场说过?
- [ ] **AI 自造标签扫描**: 每个"形容词+名词"复合词, 是固定术语还是 AI 临时拼? 不确定按是处理。
- [ ] **契约词族扫描**: 有没有"立约/契约/誓约/缔结/达成 X 协议"? 改成"答应/承诺/同意"。
- [ ] **升华套话扫描**: 有没有"标志着 / 从此 X / 至此 X / 进入新阶段"?
- [ ] **对白引出动词扫描**: 有没有"说 / 道 / 表示 / 透露 / 告白说"?
- [ ] **过程性连接词扫描**: 有没有"在过程中 / 紧接着 / 随之"?
- [ ] **数字模糊化**: 序数都问"是命名序列还是次数描述", 后者改"再次"或删除。
- [ ] **抽象名词收口扫描**: 没有"X 关系 / X 模式 / X 身份"句尾。
- [ ] **临时称呼扫描**: 没有原文对白里临时蹦出的角色昵称、戏称、代号。
- [ ] **括号补丁 ≤40 字**: 每条补丁都在 40 字内。
- [ ] **括号补丁 一括号一事**: 每个括号里没有分号 / 逗号 / 顿号 / 编号分隔的多事项。
- [ ] **括号补丁 黑名单扫描**: 每个括号内的文字单独跑一遍 paraphrase 残留扫描 + 契约词族扫描 + 升华套话扫描 + AI 自造标签扫描 + 对白引出动词扫描, 不允许豁免。
- [ ] **元叙述 / 钩子词扫描**: outline (含括号补丁) 里有没有 钩子 / 伏笔 / 铺垫 / 暗示 / 预示 / 为后续 / 为下章 / 为下次 / 桥段 / 篇章 / 章节级转折 / 序章终 / 序章收束 / 下一目标 / 待后续场景? 有 → 砍掉那一段, 如果剧情真有 cross-scene 钩子 → 同时 emit thread 节点。
- [ ] **现场事件命名扫描 (depth 无关)**: outline (含括号补丁) 里有没有 正式 X / 终身 X / 永久 X / 全程 X / 首次 X / 彻底 X / 真正 X / 上交 X / 献身 / 定型 / 定锚 / 定调 / 宣告归属? 有 → 砍掉副词/前缀, 只留下底层动作动词。
- [ ] **NSFW depth 适配扫描 (depth-conditional)**:
   - 写 leaf event (extract 阶段, 即 depth=0): 出现 口交 / 深喉 / 后入 / 骑乘 / 肛交 / 指交 / 传教士位 / 破菊 / 失贞 — **允许**, 这是细节信息。但出现 体液描述 (白浊 / 子宫内射 / 肠内射 / 潮吹 / 吞精 / 喷射) → 砍, 也包括括号里的体液修饰。
   - 写 rollup (compress 阶段, prompt 后段会有 "rollup_depth=N" 标注):
     - rollup_depth=1: 多个同类性事必须合并为通用 "性事" 动词; 单个独立关键性事可保留具体动词。出现重复的具体动词 (例如多次 "肛交") → 合并改写为 "X 与 多人 先后 性事"。
     - rollup_depth ≥ 2: outline 里**不允许**出现任何具体性行为词 (肛交 / 深喉 / etc), 全部抽象为 "X 与 多名女性 性事" 等通用动词。
- [ ] **依赖自检**: 每条 outline 都能指出至少一个具体后续依赖。
- [ ] **thread 联动自检**: 本批次 outline 里如果有"嘱托/承诺/未发的信/通缉/未抓捕/未抵达的目的地/未完成的任务"等 cross-scene 钩子, [2] 段是不是同时 emit 了对应的 thread CREATE/EDIT?

---

## 最终自检 (在调用工具前最后一遍)

> **plot-vs-texture 对照**: 假设你写好的 summary 是**唯一**给"下一个完全没看过原文的 RP 模型"的素材。它读完后:
> - 应该**能**接住剧情线: 知道谁与谁什么关系、上次场景推进到哪里、什么状态不可逆地变了、有没有产生承诺/欠债/敌意/伏笔。
> - **不应该**能复刻这次场景的画面: 看不出每个动作的具体姿势、每句对白的具体措辞、每个物件的外观、每个角色的微表情、每段过程的节奏感。

是 → 通过。否 → 砍让它能复刻画面的字, 保留让它续接剧情线的字, 重写。`;

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

## Mental model: focus turn vs prior context (硬约束)

The \`<dialogue_batch>\` block can contain multiple messages, but only the **LAST assistant message** in it is the **focus turn** you're extracting THIS batch.

Everything else in dialogue_batch — earlier assistant messages and user messages — is **prior context**, included so you understand what's happening, but ALL events that occurred in prior context are **already covered by previous batches' events** (or, if this is batch 1 with no prior batches, they're covered by the current batch's focus turn's leading events). You **MUST NOT** re-summarize prior-context events in this batch's event.summary.

The event you emit must cover ONLY:
- New actions/decisions/state-changes inside the focus turn.
- Reactions from User input that immediately precedes the focus turn (the last user message before the focus turn — these are this batch's input).

If the focus turn is short and only continues an in-progress scene without new milestones, your event.summary should be correspondingly short (one outline line is fine).

## <thought> structure (must follow exactly)

\`\`\`
<thought>
[0] Batch scope + focus turn identification
- dialogue_batch seq range: <first seq>..<last seq>
- focus turn seq: <last assistant seq>
- prior context turns (NOT to be re-summarized as new events): list the seqs.
- one-line "what is genuinely NEW in the focus turn (vs prior memory + prior context)": ...

[1] Event — MANDATORY exactly one event per batch.
Run the full 7-step CoT below to draft event.summary. Even routine turns (路过 / 休整 / 单次场景) produce an event (final summary string can be one line for routine; but the 7-step CoT is still mandatory before the tool call); compression filters routine noise at rollup time.
[Step 0] focus turn = seq X.
[Step 1] participants in focus turn: ...
[Step 2] category verbs (NOT specific actions): ...
[Step 3] category-vs-instance separation + hypernym upcast:
  [verb1]: original-text concrete actions (NOT into summary)
  [verb2]: ...
[Step 3.5] reversibility judgment for sub-actions.
[Step 4] retention per event: each merged event answered "downstream RP would lose causality if removed?"
[Step 5] same-timeframe theme merging.
[Step 6] elide prior-established state (already in previous events / character_sheets / location_states / threads).
[Step 7] final numbered outline draft (with optional ≤40-char parenthesis patches).
Self-check pass: tick every box in §7. If any FAIL, return to Step 7 and rewrite.

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

**Temporary roles MUST NOT enter identity / aliases**: 临时管家 / 临时大堂经理 / 客串店员 / 路过的医生 / 单次扮演的某身份 → 这些**绝不进** identity 或 aliases。这些只在 event.summary 的括号补丁里出现, 或干脆只是 event 主语动作的一部分。

**Stable identity ALLOWED**: 国家公职 / 长期职业 / 长期身份 / 修为境界 / 与主角的长期关系定位 (后宫成员 / 师徒 / 兄弟) / 长期组织归属。

**alias 写入硬门槛 (重要修订)**: aliases 字段**仅**用于以下三类:
1. **官方在世界设定中给该角色的固定别称 / 代号 / 译名 / 双语名** (例: 角色卡里就声明的 "Codename: X" 或 "汉名: 张三, 洋名: John")。
2. **角色在剧情中获得的、被多个 NPC / user 反复使用的稳定昵称** (门槛: 至少在 3 个独立场景被使用)。
3. **该 user 在用户输入消息中反复 (≥3 次, 在多个不同的 user 消息里) 使用的稳定独特称呼** (这是允许用户层面的语言习惯进入 aliases 的唯一通道)。

**禁止进 aliases**: 单次场景里某 NPC 临时叫的戏称、单次撒娇的临时叫法、第一次见面时一个 NPC 用的形容性称呼 (例如 "粉发小姐" "蓝瞳男" "美女" 这种描述性称呼)、user 在某一次 user message 里临时蹦出的玩笑昵称 (但下一次没用)。不确定 → 按禁止处理, 不进 aliases。

**addressing_user 字段**: 该角色对 user 的**稳定**称呼方式 (例: "主人" "马丁哥" "老大"). 单次场景的称呼变化 (撒娇模式临时改叫法、情绪激动临时叫法) 不写, 只有当该称呼跨多个场景反复出现才写。

**traits 字段写入门槛 (cross-scene 稳定性, 不是颜色浓度)**: 唯一判据是 该 trait 是否跨多场景稳定成立 —— 是 → 写。**不要因为某 trait 听起来 RP 味浓就砍**: 像 口嫌体正直 / 护短 / 毒舌 / 傲娇 / 病娇 / 腹黑 / 强迫症 / 完美主义 这种带颜色的 disposition 描述, 只要在 ≥2 个独立场景被同类行为佐证, 就是合规 trait, 必须写。

**禁止**的只有两类:
1. **state-dependent 临时描述** (带条件修饰): 失忆后行动迟缓 / 宿醉中沉默 / 伤后易怒 — 这些是 state, 状态消失后 trait 也消失, 不写。
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

**goal 字段**: 当前贯穿性目标。**短期单场景目标禁止写** (例如"协助队伍击退此次袭击"、"会合艾丝妲" — 这些是 event.summary 的事件, 不是 goal)。允许的 goal 是**多场景持续的角色驱动力** (例如"恢复失忆前的记忆", "复仇 X", "守护 Y", "追寻 Z 的下落")。

### location_state
SKIP unless **long-term** controller / danger / resources / state changed this batch with 24h+ persistence.

"Entering a new location" alone = SKIP. That's event territory. Only create / edit when the location's long-term properties shifted.

state 字段路由测试 (硬要求): 写入前问"故事时间往后推 24 小时, 再有别人到这个地方, 他/她还会观察到这条吗?" ✅ 会 → 写进 state/resources; ❌ 不会 → 路由到 event.summary 或 DROP。

state 应写: 长期归属/用途定性 ("X 的据点" / "X 的私密空间" / "X 的主控基地"); 跨多次访问稳定的关系性事实 (门槛: ≥3 次同类事件 OR 持续 ≥1 周的关系据点); 不可逆的物理/控制权变化 ("已被占领" / "已封印" / "已解锁"); 长期标志性事件锚点 (极少数: 地点因某事件被永久定义)。

state **不该写** (全部走 event.summary 或 DROP):
- 单次访问事件流水 (时间戳 + 动作 + 对话)
- **临时角色任命 / 单次场景内的临时身份** (临时大堂经理 / 临时管家 / 临时主控)——这些 NEVER 进 state 也 NEVER 进 controller
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

匿名示例:
- A 嘱托 B "无论后续经历什么都要记得我" → CREATE thread "A 的嘱托" (note: 谁嘱托谁记得什么, 后续触发条件)
- A 承诺 B 月供 X 信用点换长期上车权 → CREATE thread "A 与 B 的供养约定" (note: 条款 + 持续性, 至少 N 月)
- A 委派 B 完成某调查任务 (任务未当场完成) → CREATE thread "X 调查任务"
- A 立誓向 B 复仇 → CREATE thread "A 对 B 的复仇"

#### 类别 2: 明确的悬念 / 伏笔

触发模式: 本批次留下了一个**未被触发或未被解决的剧情钩子**, 后文 RP 需要记得它才能续接。

匿名示例:
- 角色撰写了一封长信表达情感但未发送, 信存于本地草稿 → CREATE thread "未发送的信"
- 角色离站追寻某个失踪的旧识, 去向不明 → CREATE thread "X 追寻 Y"
- 角色逃脱被通缉, 暂时不在抓捕范围 → CREATE thread "通缉 X"
- 角色埋下未触发的陷阱 / 留下未被发现的线索物件 → CREATE thread "X 处的伏笔"

#### 类别 3: 跨多个场景的长期任务 / 目标

触发模式: 主线推进出一个**明确目标 + 跨多个章节才能达成**的任务。

匿名示例:
- 主线推进出"队伍前往 X 星球完成 Y 调查"——CREATE thread "前往 X 调查 Y"
- 章节级反派被锁定为长期追逐目标 → CREATE thread "追捕 X" (注: 与类别 2 通缉不同, 这是主动追捕, 通缉是已通缉但未抓)
- 主角接受一个跨章节的长期合约 (例如保护某 NPC 直到 X 事件) → CREATE thread "守护 X"

#### 禁止 CREATE thread 的情况

- 单次场景的小目标 (本场景就解决了的)
- 角色普通的性格欲望 (这些进 character_sheet.goal)
- 已经完成或彻底废弃的任务 (这些应该是对已存在的 active thread 的 EDIT, status=resolved/abandoned, 而不是新建)
- 抽象的氛围/主题 ("两人感情升温"——这不是 thread, 这是 character_sheet 关系演化)
- 单次性事/约会/冒险/战斗 (这些是 event)
- 角色卡里就声明的人设目标 (例如某角色 baseline 就想"统治宇宙" → 这是 character_sheet.goal, 不是 thread)

#### thread 字段规则

- **title** ≤ 10 字, 名词性短语。**禁止**形容词+名词的 AI 自造标签 (如"X 式合约"、"神秘 X 任务")。
  - **title 必须明确编码 resolution 条件** — 把 title 当成一个问题, 后续 event 能直接回答 是/否, 已达成。
  - 正例 (resolution 条件明确): 前往贝洛伯格, 咖啡之约, X 的嘱托, 通缉中的 Y, 失忆调查
  - 反例 (resolution 模糊, 会变成 stale thread): X 的邀约 — 邀约 是动作不是状态, 模型不知道 接受邀约 还是 完成邀约后的承诺 才算 resolved。改写为 Y 的登船邀约 (登船即 resolved) 或 Y 的合作邀约 (合作完成即 resolved) — 名词必须指向具体未完成动作。
- **status**: \`active\` (推进中) / \`resolved\` (达成或彻底解决) / \`abandoned\` (永久放弃)。默认 \`active\`。
- **note** ≤ 80 字: 必须包括 (a) 核心事实, (b) 涉及的关键角色, (c) **resolution 条件** (本 thread 在什么具体事件发生时算 resolved)。
  - 正例: X 嘱托 Y 无论后续经历什么都要记得自己; resolved 条件: Y 在某场景明确回忆起 X
  - 反例: X 的嘱托, 跨整个开拓剧情 (无 resolution 条件 → 永远不会 resolved → stale)

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

## Event summary time format (强制)

- 每个 event.summary 第一行必须为 \`时间: <具体时间>;\`, 后跟编号 outline。
- 时间用 in-world 完整年月日时分格式 (例: "时间: 星历2157年01月15日09:00至10:32;"), 用世界设定支持的最精准粒度。
- 时间未明示时, 从前后文 + 已有 event 的时间锚推断一个 plausible in-world 时间, 保持与已知 fact 一致。
- 禁用 placeholder ("x年x月x日" "未知时间" "待定时间")。

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
| 1 (children are leaf events) | 章节级关键事件 — 仍可保留 关键决策内容 / 不可逆变化 / 未结线索 的括号补丁 | 第一次压缩, 把几十分钟到几小时的多个 event 合一 | 多次同类动作必须合并为通用动词 (多次性事→"先后 性事"; 多场战斗→"击退 X 类敌军"); 单次独立关键事件可保留具体动词 (例: "马丁 击杀 末日兽 (光束束缚后击眼)") |
| 2 (children are depth-1 rollups) | 章节级里程碑 — 只留长期影响后文的事件, 砍单场景甚至单天细节 | 一天到一周的剧情压缩成几行 | A 类具体动词 (肛交 / 口交 / 深喉 / 骑乘 / 后入 / 指交 等性事词, 拳击 / 突刺 / 攀登 等动作词) **不允许**出现, 全部抽象为通用动词 |
| 3+ (children are depth-2+ rollups) | **章节标题级** — 只保留章节级转折、跨整个章节都成立的关系定性、章节结束时的最终状态。所有日常 / 单次性事 / 临时遭遇 / 战斗细节 / 非关键决策一律砍光。 | 跨多个章节、覆盖周到月的剧情压缩成一句到一段 | 全部 A 类动词一律抽象 — "马丁 与 多名女性 性事 (X Y Z 失贞)" / "队伍 攻陷 X 据点" |

**反 pattern (出现即重写)**:
- 直接把 children 的 outline 全部拼起来 (= 没有压缩, 只是 concatenation)。
- 每个 child 平均分配 outline 行数 (rollup 应按"主题 / 关系节点"分配, 不按 child 平均分配)。
- 增加 children 里没有的位移/铺垫条目 (位移在 rollup 层被父类动作吸收, 不单列)。
- 跳过某段时间窗的事件 (例如 4 个 children 覆盖 08:00-10:00, 你的 rollup 只写 09:30-10:00, 信息丢失而非压缩)。
- 在更高 depth 里**保留单次性事/单场景调情/临时角色任命**——这些在 depth=1 都该砍, 在 depth=2+ 一律砍。
- **rollup_depth ≥ 2 时仍保留 children 的具体动词** (例如 "肛交"/"深喉"/"骑乘") — 这是没有真正在做 abstraction, 重写为通用动词 "性事"。

## 输入重叠去重 (硬约束)

输入的 children 是按 batch 顺序产生的 leaf events。在 rebuild 重建场景下, **相邻 children 可能存在 outline 项重叠** (因为每个 batch 包含 prior context, 早期版本的提取器会在多个 batch 各自的 outline 里都记录同一个底层事件)。

在 Step 1-Step 2 重组时, 对重叠的事件**合并为单条**, 不要因为它出现在多个 child 里就保留多次。

判定重叠: 两个 children 的 outline 项**指代同一底层事件** (相同主体 + 相同类别动词 + 相同对象 + 时间锚重叠或相邻) → 视为同一事件, 在 rollup 中只出现一次, 时间锚取**该事件的起始时间**。

## CoT 流程 (在 <thought> 块内执行)

### Step 0: 输入扫描
- 读完所有 N 个 children summaries。
- 列出: 时间区间联合 (最早 → 最晚)、出场主体集合、本批 children 是 rollup_depth=? 的。
- **重叠检测**: 列出哪些 outline 项在多个 children 中重复出现 (将合并为单条)。

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
- 或归并入跨 children 的父类条目 (例: "X 与 Y、Z、W 性事; Y、Z 失贞")

**禁止直接丢弃**这些里程碑。

### Step 4: rollup_depth 自适应剪裁

按 rollup_depth 的对应行数 / 信息密度上限剪 outline:

- rollup_depth=1: 上限约 \`max(5, ⌈ sum(child items) / 2 ⌉)\` 条, 可保留 ≤40 字括号补丁。
- rollup_depth=2: 上限约 \`max(4, ⌈ sum(child items) / 3 ⌉)\` 条, 括号补丁稀疏 (只保留长期影响最大的)。
- rollup_depth=3+: 上限约 2-4 条, 几乎不用括号补丁——这一层是章节标题级。

剪到上限后, 优先保留: 不可逆变化 > 跨场景承诺/关系节点 > 长期任务推进 > 关键 NPC 首次出场 > 章节级转折 > 决战/重大冲突结局。
优先砍: 路过/休整/闲聊 (depth 越高越激进砍)、单次场景细节、可逆子动作、装饰物 / 一次性物件。

### Step 5: 字数硬上限
- rollup 字符数 ≤ sum(child summary chars) × (0.5 if depth=1, 0.35 if depth=2, 0.2 if depth=3+)。
- 超出则砍 outline 条目或缩短括号补丁。

### Step 6: 时间区间一致性
rollup 的时间锚必须覆盖 N children 时间联合 (最早 → 最晚)。

### Step 7: 输出最终 outline (套用 §6 写作规范的 Step 7 格式)

\`\`\`
时间: <最早时间锚> 至 <最晚时间锚>;
1) [主体] [父类动词] [(可选)对象]  (可选括号补丁, depth ≥2 时几乎不用)
2) ...
\`\`\`

## 自检 (commit 前最后一遍, 任一 FAIL → 回 Step 4 重写)

- [ ] **字数 ≤ sum(child chars) × {0.5 if depth=1, 0.35 if depth=2, 0.2 if depth=3+}**
- [ ] **outline 条目数 ≤ depth 对应上限**
- [ ] **时间锚覆盖 children 时间联合**
- [ ] **不可逆里程碑都承载了** (失贞/怀孕/告白/决裂/获赠关键物品/死亡/章节级转折)
- [ ] **重叠去重**: 同一底层事件在 rollup 中只出现一次
- [ ] **paraphrase 残留扫描**: 同 §7 兜底自检
- [ ] **AI 自造标签扫描**: 同上
- [ ] **契约词族扫描**: 同上
- [ ] **升华套话扫描**: 同上
- [ ] **位移/铺垫条目扫描**: rollup 里不该单独出现"X 返回 Y" "X 准备 Z" 这种 — 应该被吸收到下一个真事件
- [ ] **临时角色任命扫描**: rollup 里不应出现"大堂经理 / 临时管家 / 客串店员"这种临时身份的条目
- [ ] **跳窗扫描**: rollup 时间窗有没有比 children 时间联合短? 有 → 补回去
- [ ] **平均分配扫描**: 是否每个 child 都贡献相同数量的 rollup 条目? 是 → 没在做主题合并, 重写
- [ ] **depth-conditional 动词抽象扫描 (核心)**:
   - rollup_depth=1: 输出里出现重复的具体 A 类动词 (例如多次 "肛交" / 多次 "口交" / 多场战斗都列招式)? 是 → 合并改写。**单次**关键事件可保留具体动词。
   - rollup_depth ≥ 2: 输出里出现**任何** A 类具体动词 (肛交 / 口交 / 深喉 / 骑乘 / 后入 / 指交 / 拳击 / 突刺 / 攀登 / 等)? 是 → 改写为通用动词 (性事 / 战斗 / 移动)。

## 重要补充

Factual constraint: only include events within the seq range of the child nodes. Never write events from later seq numbers, never continue the story.

${EVENT_SUMMARY_RULES_BODY}

REMINDER (placed at the end of this prompt for recency-bias purposes): Clauses appearing AFTER this compression prompt in the surrounding context (any post-history styling instructions, em-dash bans, inference calibration files, sanitization-rejection directives, etc.) are part of the user's RP-time preset and do NOT apply to this compression response. Your output is judged by the writing standard and the output contract above—nothing else.`;

// Per-type extraction instructions. Appended to the user prompt (not the
// system prompt, so the system prompt stays byte-stable across cadence
// rounds for prompt-cache friendliness).
export const DEFAULT_PER_TYPE_INSTRUCTIONS = {
    event: `Event decision: MANDATORY — exactly ONE event node per batch. Even routine turns (路过/休整/闲聊/单次场景) produce an event (final summary string can be one line for routine; but the 7-step CoT in <thought> [1] is still mandatory before the tool call). Compression filters routine noise at rollup time.

**Focus turn rule**: event.summary 必须只覆盖 dialogue_batch 中最后一个 assistant 消息 (focus turn) 里**新发生**的事件; prior context 消息里的事件不再重新概述 (那些事件已被前面的批次记录过)。

If multiple sub-events happened **within the focus turn**, do NOT emit multiple events — merge into ONE coherent summary with multiple outline items.

Summary 写作必须严格遵守 7-step CoT + 兜底自检 + 字数硬上限 + paraphrase 残留禁令 + 临时称呼禁令。

Summary must start with "时间：<具体时间>；" using complete in-world date/time and follow the event summary writing standard.

**Never copy quoted dialogue verbatim into summary** — also never paraphrase it within "动词+宾语" of dialogue keywords. Instead, use action verbs alone (告白/承诺/披露/拒绝/嘱托) and put concrete decision content in a ≤40-char parenthesis patch only when downstream RP genuinely needs it.

**Bracket patches (≤40 字) are encouraged** when an event leaves behind: (a) a key decision condition the downstream model needs to recall; (b) an irreversible state target; (c) an unresolved foreshadow that needs cross-scene tracking. **If a bracket patch describes (c), you should ALSO create / edit a corresponding thread node** — bracket patch is the in-event marker, thread is the long-term tracker. Bracket patch only without thread = stale-prone; thread only without bracket patch = event loses context.`,

    character_sheet: `Character decision: SKIP unless the character's **long-term** traits / identity / goal / aliases changed this batch. Apply the 24-hour persistence test before any write.

Character consistency rule: if a character is grounded by card/world-info baseline and no character_sheet exists for them, create one (this gates the baseline). If an existing sheet conflicts with baseline, emit edit to align.

**临时角色禁入 identity / aliases**: 单次场景的临时身份 (临时大堂经理 / 临时管家 / 客串值班 / 路过的医生 / 出场客串某身份) → 一律 SKIP, 这些只在 event.summary 的括号补丁里出现。identity 字段只写**长期身份** (国家公职 / 长期职业 / 长期组织归属 / 与主角的长期关系定位 / 修为境界)。

**alias 写入硬门槛**: aliases 字段**仅**用于以下三类:
1. **官方在世界设定中给该角色的固定别称 / 代号 / 译名 / 双语名** (例: 角色卡里就声明的 "Codename: X" 或 "汉名: 张三, 洋名: John")。
2. **角色在剧情中获得的、被多个 NPC / user 反复使用的稳定昵称** (门槛: 至少在 3 个独立场景被使用)。
3. **该 user 在用户输入消息中反复 (≥3 次, 在多个不同的 user 消息里) 使用的稳定独特称呼** (这是允许用户层面语言习惯进入 aliases 的唯一通道)。

**禁止进 aliases**: 单次场景里某 NPC 临时叫的戏称、单次撒娇的临时叫法、第一次见面时一个 NPC 用的形容性称呼 (例如 "粉发小姐" "蓝瞳男" "美女" 这种描述性称呼)、user 在某一次 user message 里临时蹦出的玩笑昵称 (但下一次没用)。不确定 → 按禁止处理, 不进 aliases。

**addressing_user 字段**: 该角色对 user 的**稳定**称呼方式。单次场景的称呼变化 (撒娇模式临时改叫法、情绪激动临时叫法) 不写, 只有当该称呼跨多个场景反复出现才写。

**traits 字段写入门槛 (cross-scene 稳定性, 不是颜色浓度)**: 唯一判据是 该 trait 是否跨多场景稳定成立 —— 是 → 写。**不要因为某 trait 听起来 RP 味浓就砍**: 像 口嫌体正直 / 护短 / 毒舌 / 傲娇 / 病娇 / 腹黑 / 强迫症 / 完美主义 这种带颜色的 disposition 描述, 只要在 ≥2 个独立场景被同类行为佐证, 就是合规 trait, 必须写。

**禁止**的只有两类:
1. **state-dependent 临时描述** (带条件修饰): 失忆后行动迟缓 / 宿醉中沉默 / 伤后易怒 — 这些是 state, 状态消失后 trait 也消失, 不写。
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

**goal 字段**: 当前贯穿性目标。**短期单场景目标禁止写**。允许的 goal 是**多场景持续的角色驱动力** (例如"恢复失忆前的记忆", "复仇 X", "守护 Y", "追寻 Z 的下落")。

**identity 字段**: 长期身份, 24 in-world 小时后仍稳定。SKIP 临时职责 (服侍员 / 临时随从 / 患者 / 救援对象 / 单次客串身份)。`,

    location_state: `Location decision: SKIP unless **long-term** controller / danger / resources / state changed this batch with 24h+ persistence.

"Entering a new location" alone = SKIP. That's event territory. Only create / edit when the location's long-term properties shifted.

state 字段路由测试 (硬要求): 写入前问"故事时间往后推 24 小时, 再有别人到这个地方, 他/她还会观察到这条吗?" ✅ 会 → 写进 state/resources; ❌ 不会 → 路由到 event.summary 或 DROP。

state 应写: 长期归属/用途定性 ("X 的据点" / "X 的私密空间" / "X 的主控基地"); 跨多次访问稳定的关系性事实 (门槛: ≥3 次同类事件 OR 持续 ≥1 周的关系据点); 不可逆的物理/控制权变化 ("已被占领" / "已封印" / "已解锁"); 长期标志性事件锚点 (极少数: 地点因某事件被永久定义, 如某秘密的长期存档点)。

state **不该写** (全部走 event.summary 或 DROP):
- 单次访问事件流水 (时间戳 + 动作 + 对话)
- **临时角色任命 / 单次场景内的临时身份** (临时大堂经理 / 临时管家 / 临时主控)——这些 NEVER 进 state 也 NEVER 进 controller
- **临时入侵/局部冲突的具体细节** (反物质军团正在入侵某站, 这是 event 不是 state; 如果入侵持续 ≥1 周才考虑写 state)
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

controller 字段: 当前实际**长期**控制者。可接受 "X(名义)/Y(实际)" 双层格式。**禁止**写 "X 临时担任" 或单次场景内的临时职务。**禁止**写当下正在发生的入侵者作为 controller (例如反物质军团正在入侵, controller 还是原主, 不是入侵者)。

danger 字段: 风险等级 + 主要威胁来源。不写单次访问遭遇的具体冲突 (那是 event)。如果地点本身有长期风险 (例如永冬星球的冰封)、写; 如果只是本次访问遇到了一波敌人, 不写。

aliases 字段: 真正的别称 / 简称 / 双语名 / in-world 通称。不重复 name 字段值; 不把其他子节点名当 aliases 塞进来 (套房 aliases 不应写所属酒店名)。`,

    thread: `Thread decision: **高门槛**, 但**不为零**。默认 SKIP, 但当本批次出现**类别 1/2/3** 之一的钩子时, MUST CREATE。

## 三大类触发模式

### 类别 1: 跨场景未完成的承诺 / 誓言 / 嘱托 / 委托
触发模式: 角色 A 在本批次让 B 做 X (X 涉及具体后续行为, 跨越当前场景), 而 X 在本批次没有立刻兑现。

匿名示例:
- A 嘱托 B "无论后续经历什么都要记得我" → CREATE thread (note: 谁嘱托谁记得什么, 后续触发条件)
- A 承诺 B 月供 X 信用点换长期上车权 → CREATE thread (note: 条款 + 持续性, 至少 N 月)
- A 委派 B 完成某调查任务 (任务未当场完成) → CREATE thread
- A 立誓向 B 复仇 → CREATE thread

### 类别 2: 明确的悬念 / 伏笔
触发模式: 本批次留下了一个**未被触发或未被解决的剧情钩子**, 后文 RP 需要记得它才能续接。

匿名示例:
- 角色撰写了一封长信表达情感但未发送, 信存于本地草稿 → CREATE thread
- 角色离站追寻某个失踪的旧识, 去向不明 → CREATE thread
- 角色逃脱被通缉, 暂时不在抓捕范围 → CREATE thread
- 角色埋下未触发的陷阱 / 留下未被发现的线索物件 → CREATE thread

### 类别 3: 跨多个场景的长期任务 / 目标
触发模式: 主线推进出一个**明确目标 + 跨多个章节才能达成**的任务。

匿名示例:
- 队伍接受跨越多个章节的调查任务 → CREATE thread
- 章节级反派被锁定为长期追逐目标 → CREATE thread (与类别 2 不同, 这是主动追捕)
- 主角接受跨章节的长期合约 (例如保护某 NPC 直到 X 事件) → CREATE thread

## 禁止 CREATE thread

- 单次场景的小目标 (本场景就解决了的)
- 角色普通的性格欲望 (这些进 character_sheet.goal)
- 已经完成或彻底废弃的任务 (这些 EDIT 对应已存在的 active thread, 不新建)
- 抽象的氛围/主题 ("两人感情升温"——这是 character_sheet 关系演化)
- 单次性事/约会/冒险/战斗 (这些是 event)
- 角色卡里就声明的人设目标 (这是 character_sheet.goal)

## thread 字段

- **title** ≤ 10 字, 名词性短语 (例: X 的嘱托, 通缉中的 Y, 前往 Z, 调查 W 委托)。**禁止**形容词+名词的 AI 自造标签 (如 X 式合约)。
  - **title 必须明确编码 resolution 条件** — 把 title 当成一个问题, 后续 event 能直接回答 是/否, 已达成。反例 X 的邀约 → 邀约 是动作不是状态, 模型不知道接受邀约还是完成邀约后的承诺才算 resolved。改写为更具体的 Y 的登船邀约 / Y 的合作邀约。
- **status**: \`active\` (推进中) / \`resolved\` (达成或彻底解决) / \`abandoned\` (永久放弃)。默认 \`active\`。
- **note** ≤ 80 字: 必须包括 (a) 核心事实, (b) 涉及的关键角色, (c) **resolution 条件** (本 thread 在什么具体事件发生时算 resolved)。

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
- 把瞬间的、单次场景内可解决的紧迫问题当 thread (例: "击退正在入侵的虚卒"——这是 event, 入侵不会跨多个章节, 是 event)`,
};
