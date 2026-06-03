---
name: director-zh-style-baseline
description: Chinese RP language baseline — bilingual signals are Chinese-first; in-world time frames use Chinese phrasings.
metadata:
  author: Luker Team
  version: 1.0.0
---

# director-zh-style-baseline

This skill is the Chinese-RP style baseline for the default director RP profile. The default profile targets Chinese-language RP as the primary use case, and many of the pattern lists in the sub-agent prompts (especially `voice_critic`) are bilingual but list the Chinese form first. This skill consolidates the Chinese-specific markers so all agents share the baseline.

The baseline is extracted verbatim from `director-default-prompt.js` and `director-defaults.js` (voice_critic + EVENT_SUMMARY_RULES_BODY).

## Bilingual signal lists — Chinese form is primary

When the original prompts list a pattern to avoid (cold observation verb, data vocabulary, meta-narration leak, etc.), the Chinese form is typically the primary form and the English is the fallback. Examples:

### Cold observation verbs (Chinese primary)

观察 / 分析 / 推测 / 记录 / 评估 / 追踪 / 监测 / 扫描 / 检测 / 实验 / observe / analyze / measure / record / monitor / track / scan / log / experiment

### Data vocabulary in body / emotion description (Chinese primary)

心率 / 体温上升 / 充血程度 / 多巴胺 / 肾上腺素 / 皮质醇 / 效率 / 任何百分比 / heart rate up / dopamine / cortisol / efficiency / any % readout

### Reporting structures (Chinese primary)

"[角色]注意到 X" / "[角色]记录到 Y" / "第 N 次发生 Z" / "[character] noted that X" / "[character] observed Y dispassionately" / "for the Nth time"

### Detached framing (Chinese primary)

"[角色]像在观察珍稀动物一样" / "用陈述事实的语气" / "冷静地指出" / "with clinical detachment"

### Reporting-style dialogue (Chinese primary)

- ✗ "你的心跳很快" / ✓ "跳得好大声……"
- ✗ "我已经准备好了" / ✓ "想要……"
- ✗ "任务完成" / ✓ "弄好了"

## Meta-narration shapes — Chinese-specific examples

### Config-label leakage (Class A)

Author-side config labels in Chinese: 世界书 / 角色卡 / 记忆图 / 笔记 — all of these are author-substrate names that must NOT appear in-prose. Common leakage shapes:
- 「这是 X 里写的那种 Y」
- 「这是世界书里写的那种 Y」
- 「根据 X / 按 X 行事 / 体现 X」

### Platform-frame leakage (Class B)

Turn / round / reply structure used as a time anchor (the most common Chinese-RP failure mode):
- 「上一轮」 / 「上一回合」 / 「上一次回复」 / 「本轮」 / 「这一轮」 / 「上次互动」

Conversation-as-artifact references:
- 「我们的对话」 / 「这段对话」

Platform / RP framing:
- 「系统提示」 / 「你的设定」 / 「这场 RP」 / 「这个游戏」

User-as-referent:
- 「用户」 / 「玩家」

Interface references:
- 「聊天界面」 / 「这里」 when "这里" refers to the chat rather than an in-world location

## In-world time frames — Chinese preferred forms

When the narrator looks back at past events, use IN-WORLD time frames:

- 昨夜 / 今早 / 三天前 / 上次他来访时 / 雨停那一刻

Never use platform frames:

- 上一轮 / 上一回合 / 本轮 / 上次回复

Sanity test: would the in-world character have a concept for this time anchor? A noble at her dressing table has 昨夜 / 今早 / 三天前 but not 上一回合. A swordsman has 上次相遇 / 雨停那一刻 but not 上次回复. If the time anchor only makes sense relative to the AI-player conversation, it is platform-frame leakage.

## Quoted dialogue conventions

The event-summary writing rules (see `event-summary-rules-zh`) forbid 「」 / "" quoted dialogue inside summary text. In narrative prose this is allowed, but be aware that all 8 ASCII / CJK quote variants are tracked as dialogue markers when the voice_critic / memory_curator scan looks for paraphrase residue or quoted dialogue leaking into structured fields.

## Diagnostic question for Chinese-RP authoring

When evaluating a candidate phrasing, ask in Chinese: "这句话读起来像一个真实人物在经历这一刻吗,还是像一台保安摄像头在记录?" (Does this line read like a living being having this moment, or like a security camera recording it?) — the data-person failure mode is the most common cliche in Chinese-RP, and this is the single sharpest filter.
