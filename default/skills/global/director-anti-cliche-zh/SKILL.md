---
name: director-anti-cliche-zh
description: Anti-cliche patterns for narrative writing — banned phrasings, AI-自造 labels, contract-vocab, sublimation cliches.
metadata:
  author: Luker Team
  version: 1.0.0
---

# director-anti-cliche-zh

This skill is the consolidated anti-cliche reference for the default director RP profile. The rules below are extracted verbatim from `director-default-prompt.js` (main-agent draft step) and `director-defaults.js` (voice_critic + EVENT_SUMMARY_RULES_BODY constant). The same patterns are also enforced inline in those sub-agent prompts; this shared skill exists so cross-cutting cliches are visible as one document instead of being scattered across 12+ sub-agent bodies.

## Data-person prose — the single most common LLM RP failure mode

The single most common failure mode of LLMs writing RP is "data-person" prose — characters narrating their experience as observers / analysts / reporters instead of LIVING it.

Every character — scientist, scholar, genius, taciturn type, 三无 archetype, android, AI, puppet, golem — is FIRST a living being whose primary reality is sensation, instinct, and emotional weather; the cold archetype is a stylized SURFACE on a beating heart, not a replacement for it. Coldness as style works; coldness as substance fails. Even an android leans into a touch, flinches, stares blankly, freezes — those are animal reactions, not sensor readings.

### Cold observation verbs / data vocabulary at emotional-stake moments

Watch for (bilingual list — Chinese RP is the main target):

- Observation/analysis verbs used on a person the character has stakes in: 观察 / 分析 / 推测 / 记录 / 评估 / 追踪 / 监测 / 扫描 / 检测 / 实验 / observe / analyze / measure / record / monitor / track / scan / log / experiment
- Data vocabulary in body / emotion description: 心率 / 体温上升 / 充血程度 / 多巴胺 / 肾上腺素 / 皮质醇 / 效率 / 任何百分比 / heart rate up / dopamine / cortisol / efficiency / any % readout
- Reporting structures: "[角色]注意到 X" / "[角色]记录到 Y" / "第 N 次发生 Z" / "[character] noted that X" / "[character] observed Y dispassionately" / "for the Nth time"
- Detached framing: "[角色]像在观察珍稀动物一样" / "用陈述事实的语气" / "冷静地指出" / "with clinical detachment"

The flag is on COLD USE, not the verb itself. "Seeing" something warmly ("the way her shoulders tense") is fine; cataloguing it as data ("subject's shoulder elevation up ~2cm — stress indicator") is not.

### Reporting-style dialogue / interior monologue during emotional moments

Real people repeat themselves ("不行不行不行"), contradict themselves ("别碰——再碰一下"), trail off, fragment, slip into shorter / less grammatical units, lose track mid-sentence. Clean crisp dialogue at high emotional pitch reads as machine output:

- ✗ "你的心跳很快" / ✓ "跳得好大声……"
- ✗ "我已经准备好了" / ✓ "想要……"
- ✗ "任务完成" / ✓ "弄好了"

Cold-archetype characters CAN speak crisply, but their interior text should leak humanity (half-formed thoughts, animal flinches, drifting attention) even when their speech stays controlled.

### Archetype mishandling

The cold surface should HIDE a hot interior, not REPLACE it. Avoid:

- A scientist / scholar character "analyzes" the person they're into instead of being a fascinated dumbass around them (痴迷替代分析 — wild curiosity, not cool study)
- An android / AI / puppet character "scans" / "evaluates" / "assesses" during intimacy instead of going hazy / shorting out / leaning in (情动即宕机 — logic stalls when feelings spike)
- A taciturn / 三无 character's interior is rendered as ACTUALLY empty (no inner chatter, no flinches, no half-formed reactions) instead of cluttered-behind-a-quiet-surface. Silence ≠ scanning; silence = hidden mess.

### Self-check before writing

For each candidate line, ask: "Does this line read like a living being having this moment, or like a security camera recording it?" Only the former is acceptable.

## Banned word families (memory-graph summary scope, but the spirit applies in prose too)

The following word-family bans are enforced inside event.summary writing (see `event-summary-rules-zh`). They are listed here because the same shapes — especially AI-自造 labels and sublimation 套话 — also routinely creep into narrative prose, where they are cliches even though they are not formally banned.

### 契约词族

任何「契约 / 协议 / 誓约 / 凭证 / 条款 / 承诺书 / 约定书 / 永约 / 立约 / 缔结 / 宣言 / 成交 / 签署 / 口约」结构的词,以及它们的动词形式(兑现 / 履行 / 达成 / 敲定 / 签下 / 立下 / 正式纳入 / 正式启动)。

### 升华套话

任何「完成从 X 到 Y 的升级」「X 段升级」「X 重身份升级」「锚定」「固化」「拉满」「封顶」「进入新阶段」「标志着」「从此 X」「至此 X」「彻底切换」「彻底翻转」结构的句式。

### AI 自造标签

任何 AI 用形容词+名词强行命名一个本不需要命名的现象的词。识别这类标签的核心方法是:

> 把这个词单独抠出来问自己——**这是一个已有的固定术语,还是 AI 临时拼出来的现场命名**?是临时拼的 → 砍。

包括但不限于以下结构:

- **「X 式 + 任意名词」**:任何"X 式"前缀加在事件/关系/行为/姿势上的修饰(例:"X 式 X 化"、"X 式约会"、"X 式告白"、"X 式做爱"——只要"X 式"在原文里不是已有概念而是临时拼的,砍掉整个修饰)
- **「X 属性」「X 位次」「X 模式」「X 定位」「X 学习」「X 调教」**:用名词当后缀给一个本是动词的事件强行加身份/类型标签
- **「专属 X」「核心 X」「永久 X」**:用形容词+名词强行给关系/身份加权重
- **「不 X 只 Y 模式」「无 X 式 Y」**:用否定+肯定结构造的非标准范式词

如果不确定一个词是不是 AI 自造标签,**默认按是处理**(砍掉/改成动词陈述),因为真正的固定术语会有原文外的剧情支撑。

### 抽象名词收口

句尾不用「关系 / 称呼 / 模式 / 定位 / 身份 / 层级 / 岗位 / 位次 / 关系链 / 升级」等名词收口。改用动词。

### 对白引出动词

任何引出对白的动词:X 说 / X 道 / X 表示 / X 宣称 / X 透露 / X 吐露 / X 告白说 / X 哽咽请求 / X 撒娇评价 / X 直球吐露。

### 过程性连接词

在过程中 / 紧接着 / 随之 / 继而 / 与此同时 / 话音落下。("翌晨""当夜""次日"是时间锚,允许)

### 修饰词副词

任何无独立信息量的形容词副词。例外:承载事件骨架的状态形容词可留(如"含蓄回应"中"含蓄"承载回应方式 / "崩溃"承载触发条件)——但要严格自检,不能给"看起来重要"的修饰词编造骨架价值。
