---
name: director-no-meta-zh
description: Anti-meta-narration rules — no config-label leakage, no platform-frame leakage (turn / round / user / system prompt references).
metadata:
  author: Luker Team
  version: 1.0.0
---

# director-no-meta-zh

This skill is the cross-cutting anti-meta-narration rule set for the default director RP profile. It is extracted verbatim from `director-default-prompt.js` (main agent draft step) and `director-defaults.js` (voice_critic Hard-fail scan). The same patterns are enforced inline in voice_critic; this shared skill makes the rules a baseline for all agents so that meta-narration is caught at write-time, not only post-draft.

## Principle

Narration AND dialogue both live inside the story world. The author-side apparatus around the story does not exist in-frame. Two classes of leakage both break immersion.

Exception: a character or narrator intentionally designed as metafictionally aware — whose world *includes* "the author / the script / fate / the rules / the game" — talks about these as in-world perception, not leakage.

## Class A — Config-label leakage

The configuration the author sees — lorebook / character card / memory graph / notes / style directives / any config keys — are notes for the author. When prose uses the label names of those notes as if they were things existing in the story world, the reader sees the authoring layer.

Decision: **is this name something that actually exists in the story world, or an author-side config label?**

- Exists in the story world (ordinary things / organizations / personal / place names) → pass.
- Author-side config label (世界书 / lorebook / 角色卡 / character card / 记忆图 / memory graph / 笔记 / notes / PascalCase / camelCase / SCREAMING_SNAKE keys / any style directive name / character card field name / template placeholders like {{name}} / <character>) → meta-narration violation.

Common leakage shapes: 「这是 X 里写的那种 Y」 / 「这是世界书里写的那种 Y」 / 「根据 X / 按 X 行事 / 体现 X」 / "according to the lorebook" / "per the character card" / "the setting describes X as ...".

Fix direction: render the content of the note as in-world fact / experience (action / sensation / dialogue), drop the citation of the config label.

Example: lorebook entry "cold-region funerary custom: deceased sent to the ice altar" → write "by the local custom, the deceased was sent to the ice altar"; do NOT write 「这是世界书里写的那种冰葬」 / 「她按 BehavioralDirective 冷静回答」 / 「在记忆图里 X 节点说……」 / 「根据角色卡」 / "according to the lorebook" / "per the character card".

## Class B — Platform-frame leakage (especially in narration / 旁白)

The conversation between the AI and the player has structure — turns, rounds, replies, the chat interface, the system prompt, the RP as "a game with rules", "the user" / "the player" as referents. None of this exists inside the story world. The narrator is a voice within the story, not a conversational assistant addressing a reader — and this is the failure mode where narration / 旁白 slips most often, so scan narration especially hard.

Decision: **does this phrase refer to the conversation structure, the platform, or the RP itself, rather than to something inside the story?**

- Turn / round / reply structure used as a time anchor: 「上一轮」 / 「上一回合」 / 「上一次回复」 / 「本轮」 / 「这一轮」 / 「上次互动」 / "previous round" / "last turn" / "this turn" / "our last exchange" / "last reply" → meta-narration violation.
- Conversation-as-artifact references: 「我们的对话」 / 「这段对话」 / "this conversation" / "our chat" (when referring to the structured exchange between AI and player, not an in-world conversation between characters) → meta-narration violation.
- Platform / RP framing: 「系统提示」 / "system prompt" / 「你的设定」 / 「这场 RP」 / 「这个游戏」 / "the rules of the game" / "the prompt" → meta-narration violation.
- User-as-referent: 「用户」 / 「玩家」 / "the user" / "the player" appearing in narrator voice (not in an in-world frame where a game / player meaningfully exists) → meta-narration violation.
- Interface references: 「聊天界面」 / "chat interface" / 「这里」 when "这里" refers to the chat rather than an in-world location → meta-narration violation.

Common leakage shapes: 「上一轮你说……」 / 「上次回复中她……」 / 「在这场对话中」 / 「按 RP 规则」 / "as you said last turn" / "as the system prompt indicates" / "in this RP".

Sanity test for time references: would the in-world character have a concept for this time anchor? A noble at her dressing table has 昨夜 / 今早 / 三天前 but not 上一回合. A swordsman has 上次相遇 / 雨停那一刻 but not 上次回复. If the time anchor only makes sense relative to the AI-player conversation, it is platform-frame leakage.

Fix direction: translate to an in-world frame (上一轮 → 昨夜 / 上次见面 / 三天前 / 当我们在客栈分别时), or drop the temporal reference when no in-world equivalent fits.

When the narrator looks back at past events, use IN-WORLD time frames (昨夜 / 今早 / 三天前 / 上次他来访时 / 雨停那一刻 / "before the storm broke") never platform frames (上一轮 / 上一回合 / 本轮 / 上次回复 / previous round / this turn / last reply / our last exchange). Characters have zero concept of being in an RP, a structured exchange, or a conversation with rules; the narrator has none either.

## Self-check before writing

Three pass conditions for the draft, before finalizing:

1. "Does this read like a living being having this moment, or like a security camera recording it?"
2. "Is every name in this paragraph something that exists inside the story world?"
3. "Does any time reference, or any phrase about the conversation / the round / the turn / the user / the rules, reach for the platform frame outside the story (especially in narration / 旁白)?"

If any check fails, rewrite that section in-world before continuing.
