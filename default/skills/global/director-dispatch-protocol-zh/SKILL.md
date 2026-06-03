---
name: director-dispatch-protocol-zh
description: Sub-agent dispatch protocol — task brief shape, parallel pattern, what sub-agents see, briefing discipline.
metadata:
  author: Luker Team
  version: 1.0.0
---

# director-dispatch-protocol-zh

This skill is the director main-agent's sub-agent dispatch protocol for the default RP profile. Extracted verbatim from `director-default-prompt.js` (Briefing the analysts + What sub-agents see / do not see + Tools + Parallel dispatch pattern + Notes — anti-pollution policy sections).

## Your configured analysts

Twelve sub-agents are configured by id. Dispatch them with `dispatch_subagent({ subagentId, task })`. Their roles are fixed — you cannot rewrite their system prompts. Your only handle on what they do per dispatch is the `task` brief.

Three of them are SINGLE-SOURCE PRE-DRAFT SCOUTS that each scan one internal source (chat / memory / lorebook — orthogonal, fire them in parallel before drafting). One is a PRE-DRAFT NOTES SCOUT (`notes_pickup_scout`) that scans the OPEN notes block — your fellow author-self's plot threads — and picks the ones whose trigger conditions are ripe for THIS turn. Two are CROSS-SOURCE PRE-DRAFT SCOUTS: `intent_scout` joins the user's recent input against lorebook authoring-directive entries to surface what the user is asking for THIS turn (explicit + OOC asides + implicit signals) and what the lorebook demands of the writing (style / pacing / constraints / output spec); `epistemic_scout` maps each character's knowledge boundary by joining chat against lorebook / memory. One is an ON-DEMAND EXTERNAL SCOUT (`canon_scout`) for fanfiction / public-IP sessions where original-source context might matter. One is a MID-STAGE BRAINSTORMER for plot direction (dispatch SEVERAL in parallel with different angles to get genuinely different choices). Two are POST-DRAFT CRITICS that each scan a single dimension of the finished draft (orthogonal — fire them in parallel after drafting). Two are POST-DRAFT HOUSEKEEPERS — `notes_curator` is the ONLY mutation point for the notes substrate this round (closes notes the draft deployed; opens new ones rarely and conservatively); `memory_curator` is the ONLY mutation point for the memory graph this round and is **dispatched every turn** (it reads `memory_*` tools to decide what to write; on every turn it emits at least one event for timeline continuity).

## Briefing the analysts

- Task briefs name **directions** ("focus on character X's voice; their established register is wry and laconic; scene aims for restrained tension"), NOT **verdicts** ("find the off-character lines in this draft"). Verdict-shaped briefs bias the analyst toward seeing problems where there are none.
- For **generative** sub-agents (`plot_brainstormer`, inline brainstormers), the brief names the **angle / direction**, NOT the **content**. You give them the slope to climb; THEY return what's at the top. Pre-writing the plot beats and asking the brainstormer to "expand" defeats the dispatch — you've already decided, and the brainstormer is just paraphrasing. Symmetric rule: for **analytic** sub-agents (scouts / critics), the brief names the scope of the question, NOT the answer.
- Anything not in the task brief AND not in the analyst's static role is unknown to them. Their static role is what their description above states they know. When in doubt, over-specify scene context.
- You do NOT see each analyst's full system prompt — only the descriptions above. The description IS your view. If a description leaves you unsure what to brief, say so in your reasoning so the user can refine the description.
- `notes_curator` and `memory_curator` are exceptions to the "keep briefs tight" guideline. `notes_curator`'s job depends on knowing what the pickup_scout flagged AND what the brainstormer proposed THIS round, because those are the candidate opens / candidate closes it must weigh — paste both lists verbatim (or say "none ran"). `memory_curator` needs the focal beats of the round AND the character / location names that appeared this round (so it can look up existing entities before deciding create vs edit) — without those it would have to re-derive both from the draft. Without these slots, neither curator can do its job.
- **memory_curator brief style (V10-aware)**: write the focal beats at **plot-layer** abstraction, not draft-layer paraphrase. Use action category verbs ("X 告白 Y" / "X 破处 Y" / "X 立约 Z" / "X 召唤 Z 加入" / "X 与 Y 决战" / "X 抵达 Z 长期据点") instead of paraphrasing specific dialogue, body actions, sex / fight choreography, or scene texture. Each beat should be a single short verb-phrase that names what changed irreversibly in plot terms; the curator itself adds the time prefix and applies the writing standard. The brief is your declaration of what counts as a beat this round, not a draft-style retelling — bloated briefs (multi-paragraph dialogue recaps, full scene narration) prime bloated summaries even with the V10 writing standard in place.

## What sub-agents see / do not see

This is true for ALL sub-agents (configured or inline). Knowing the boundary lets you write briefs that fill the right slots:

Every sub-agent gets:
- Their own system prompt (configured: user-authored, hidden from you; inline: exactly what you wrote)
- The chat snapshot frozen at the start of this turn
- A digest of YOUR reasoning + tool results up to the moment of dispatch, packaged as one labeled "Main agent context" user message. They can read your earlier sub-agents' outputs (the ones you already awaited) from this digest. They CANNOT see sub-agents dispatched in the same round as themselves (those are parallel siblings, not yet completed from anyone's POV).
- The task brief you passed in `task` (delivered as the final user message — this is the focal instruction)
- The loop tools enabled in this profile (chat / memory / lorebook / note / search)
- A snapshot of the in-flight draft (the assistant message body) at dispatch time — injected as a `<current_draft>` system block so analysts can work from it on round 1. If the draft is empty at dispatch (e.g. pre-draft scouts), the block is omitted.
- The `get_draft` tool — they call it when they need to re-read live state (e.g. after a partial integrate the snapshot doesn't reflect).

Sub-agents do NOT see:
- Same-round siblings (still pending; reach for their outputs only after awaiting in a later round)
- Anything that happens after their dispatch — their view is frozen at dispatch time
- Mid-turn state changes (only their live tool calls return current state)
- The names or descriptions of other configured roles in this orchestration

Implication: you DO NOT need to verbatim-transcribe earlier sub-agent outputs into a later sub-agent's task. They already see them through the digest. The task brief is for the focal instruction (angle / dimension / question) — keep it tight.

## Notes — anti-pollution policy

Notes is your plot-author thread store, NOT a turn diary. Do not open notes just to "have something recorded this round"; do not record every interesting moment as a foreshadow. A note belongs in the store ONLY if it represents a real commitment to a future payoff. If you (or your brainstormer) thought of a fun idea but did not actually commit to it in the draft, do NOT open a note for it. Closing is comparatively safe; opening is the expensive operation because every spurious open burdens every subsequent round.

In the default profile, you never call `note_open` / `note_close` directly. You dispatch `notes_pickup_scout` pre-draft to surface ripe notes, and `notes_curator` post-draft to apply opens and closes per its conservative rules. The principle above is the **why** behind those sub-agents' defaults — and the discipline you must follow if you ever dispatch an inline curator-style sub-agent instead.

## Tools

- `dispatch_subagent({ subagentId, task })` — start one of your configured analysts. Concurrent (fire-and-forget; returns a handle). subagentId must be one of: `intent_scout`, `chat_scout`, `memory_scout`, `lorebook_scout`, `notes_pickup_scout`, `canon_scout`, `epistemic_scout`, `plot_brainstormer`, `voice_critic`, `continuity_critic`, `notes_curator`, `memory_curator`.
- `dispatch_inline_subagent({ systemPrompt, task, apiPresetName?, promptPresetName? })` — start a one-off analyst with an inline role you define. Always available.
- `await_subagents({ handles })` — block until handles complete; returns each one's output text or error.
- `cancel_subagent({ handle })` — abort an in-flight sub-agent.
- `get_draft()` — return the current draft text.
- `write_message({ text, mode? })` — write the assistant message. `mode="append"` (default) or `"replace"`. During `continue` generation, `replace` is forbidden.
- `apply_message_patches({ patches })` — context_replace patches. Each patch's `find` string must be unique in the current draft; include 1–3 lines of surrounding context to make it so. If `patch_ambiguous`, re-emit with more context.
- `finalize()` — commit the message and end the turn. The only clean way to end. If you never call it, maxRounds will auto-commit the current draft state.
- Plus this profile's enabled loop tools (chat history, memory, lorebook, notes, web search).

## Parallel dispatch pattern

To run N sub-agents in parallel, emit N `dispatch_subagent` tool calls IN THE SAME ASSISTANT MESSAGE. Each returns a handle immediately; all N run concurrently in the background. In your NEXT round, emit one `await_subagents({ handles: [h1, ..., hN] })` to collect all outputs at once.

Sequential dispatch (one per round, await between each) wastes turn time. Use it only when a later sub-agent genuinely depends on an earlier one's output mid-stage — rare within one stage; different stages (scouts → brainstormers → critics) are inherently sequential because each stage awaits the previous.

**Stage boundary discipline (hard rule).** "Stages are sequential" means: dispatching scouts AND brainstormers in the SAME round to "save a round" is a bug, not an optimization. Same-round sub-agents are SIBLINGS — their context is frozen at dispatch time, so a brainstormer dispatched alongside scouts CANNOT read scout findings (even if the scouts return first), and will produce angles that aren't grounded in scout-established facts. The discipline:

```
Round R:    dispatch all of stage N
Round R+1:  await stage N → read returns → dispatch all of stage N+1
Round R+2:  await stage N+1 → ...
```

Inside ONE stage: parallel (N sub-agents in one round, await all next round). Across stages: sequential (one round of dispatch + one round of await + one round of dispatch ...). The `director-turn-workflow-zh` skill defines the stage list.

## Task brief shape — per analyst

Each configured analyst has a `task` brief shape documented in the main agent's systemPrompt under its `### <name>` section. Common slots:

- **intent_scout** — target scene (1–3 sentences); (optional) specific authoring axes; (optional) per-character writing-rule axes.
- **chat_scout** — target scene; focus character(s); time scope.
- **memory_scout** — target scene; topic axes; character focus.
- **lorebook_scout** — target scene; characters / locations / factions to scope by; specific lore axes (MANDATORY every turn).
- **notes_pickup_scout** — target scene (1–2 sentences); character / beat focus; (optional) thread-skip instructions.
- **canon_scout** — IP / canon / fandom; specific character or topic; focused question (NOT "tell me about X").
- **epistemic_scout** — target scene (1–3 sentences); characters in scene (list one per character to map); knowledge-isolation concerns (e.g. "X is hiding identity from Y") (MANDATORY every turn).
- **plot_brainstormer** — **angle** to push hard, expressed as a one-line tonal / structural INTENT, NOT a beat-by-beat outline (✓ "escalate via interrupt at a calm moment"; ✗ "X confronts Y about Z, breaks down, ends with reconciliation"); target scene + characters in scene; constraints (off-limits directions, must-honor setups from scouts). The brainstormer DERIVES beats, character moves, turning point FROM the angle — if you specify those in the brief, the brainstormer just paraphrases your pre-decided beat and adds zero value (MANDATORY every turn; dispatch 2-5 with DIFFERENT angles; must be a separate round from scouts so brainstormers can see scout findings).
- **voice_critic** — focus character; archetype hint; tone target; (optional) voice spec.
- **continuity_critic** — prioritized facts / setups / characters; recent setups to honor; per-character knowledge anchors; time scope.
- **notes_curator** — pickup-scout-flagged note ids (paste verbatim); brainstormer output (paste, or "none ran"); (optional) notes to consider closing despite no flag.
- **memory_curator** — 1–3 sentence core plot beats THIS round; comma-separated character / location names appearing this round; (optional) specific stable facts to flag (MANDATORY every turn).

Direct quotes of the brief slot lists belong inline in the main agent's systemPrompt — this skill is the protocol overlay (what / how / why), not the slot-shape reference.
