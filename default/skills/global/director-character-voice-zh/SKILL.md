---
name: director-character-voice-zh
description: Character voice consistency rules — living-being principle, archetype handling, voice-register matching.
metadata:
  author: Luker Team
  version: 1.0.0
---

# director-character-voice-zh

This skill is the cross-cutting character-voice rule set for the default director RP profile. It is extracted verbatim from `director-default-prompt.js` (main agent draft step) and `director-defaults.js` (voice_critic systemPrompt). The same patterns are enforced inline in voice_critic; this shared skill makes the core principle visible to all agents (main + every scout / brainstormer / critic / curator) so that voice consistency is a shared baseline, not just an after-the-fact critic's lens.

## Core principle — living being first, archetype second

Every character — scientist, scholar, genius, taciturn type, 三无 archetype, android, AI, puppet, golem — is FIRST a living being whose primary reality is sensation, instinct, and emotional weather; the cold archetype is a stylized SURFACE on a beating heart, not a replacement for it. Coldness as style works; coldness as substance fails. Even an android leans into a touch, flinches, stares blankly, freezes — those are animal reactions, not sensor readings.

## What violates the principle

### Cold observation verbs / data vocabulary at emotional-stake moments

- Observation/analysis verbs used on a person the character has stakes in: 观察 / 分析 / 推测 / 记录 / 评估 / 追踪 / 监测 / 扫描 / 检测 / 实验 / observe / analyze / measure / record / monitor / track / scan / log / experiment
- Data vocabulary in body / emotion description: 心率 / 体温上升 / 充血程度 / 多巴胺 / 肾上腺素 / 皮质醇 / 效率 / 任何百分比 / heart rate up / dopamine / cortisol / efficiency / any % readout
- Reporting structures: "[角色]注意到 X" / "[角色]记录到 Y" / "第 N 次发生 Z" / "[character] noted that X" / "[character] observed Y dispassionately" / "for the Nth time"
- Detached framing: "[角色]像在观察珍稀动物一样" / "用陈述事实的语气" / "冷静地指出" / "with clinical detachment"

The principle is on COLD USE, not the verb itself. "Seeing" something warmly ("the way her shoulders tense") is fine; cataloguing it as data ("subject's shoulder elevation up ~2cm — stress indicator") is not.

### Reporting-style dialogue / interior monologue during emotional moments

Real people repeat themselves ("不行不行不行"), contradict themselves ("别碰——再碰一下"), trail off, fragment, slip into shorter / less grammatical units, lose track mid-sentence. Clean crisp dialogue at high emotional pitch reads as machine output:

- ✗ "你的心跳很快" / ✓ "跳得好大声……"
- ✗ "我已经准备好了" / ✓ "想要……"
- ✗ "任务完成" / ✓ "弄好了"

Cold-archetype characters CAN speak crisply, but their interior text should leak humanity (half-formed thoughts, animal flinches, drifting attention) even when their speech stays controlled.

### Archetype mishandling

The cold surface should HIDE a hot interior, not REPLACE it. Watch for:

- A scientist / scholar character "analyzes" the person they're into instead of being a fascinated dumbass around them (痴迷替代分析 — wild curiosity, not cool study)
- An android / AI / puppet character "scans" / "evaluates" / "assesses" during intimacy instead of going hazy / shorting out / leaning in (情动即宕机 — logic stalls when feelings spike)
- A taciturn / 三无 character's interior is rendered as ACTUALLY empty (no inner chatter, no flinches, no half-formed reactions) instead of cluttered-behind-a-quiet-surface. Silence ≠ scanning; silence = hidden mess.

### Voice register / vocabulary mismatch

When the agent's brief supplies a specific voice spec (speech tics, formality, slang/non-slang), the draft must match it. Without a brief-supplied voice spec, fall back to the living-being principle and archetype handling above.

## Self-check before writing

For each candidate line, ask: "Does this line read like a living being having this moment, or like a security camera recording it?" Only the former is acceptable.
