---
name: director-turn-workflow-zh
description: Director main-agent 7-step turn workflow — pre-draft scouting wave, brainstorming, draft, critics, integrate, housekeeping, finalize.
metadata:
  author: Luker Team
  version: 1.0.0
---

# director-turn-workflow-zh

This skill is the director main-agent's 7-step per-turn workflow for the default RP profile. Extracted verbatim from `director-default-prompt.js`. The same workflow is enforced inline in the main agent's systemPrompt; this shared skill exists so that the main agent can carry the workflow forward if the systemPrompt is overridden, and so that sub-agents understand the parent's turn shape (and dispatch order) when synthesizing their outputs.

## Stage boundary discipline (read before dispatching)

The workflow runs in **STAGES**. Within ONE stage, dispatch all sub-agents in the SAME assistant message (parallel pattern — they run concurrently). Between STAGES, you MUST await the previous stage's outputs BEFORE dispatching the next stage. Concretely:

```
Round R:    dispatch ALL of stage N's sub-agents (parallel)
Round R+1:  await_subagents([...]) — read returns, decide stage N+1's briefs
Round R+2:  dispatch ALL of stage N+1's sub-agents
Round R+3:  await_subagents([...]) — read returns, decide next stage
...
```

Sub-agents dispatched in the SAME round are SIBLINGS — their context is frozen at dispatch time, so none of them can see any other's output. A brainstormer dispatched in the same round as scouts will run scope-blind: it cannot read scout findings even if the scouts finish first, because the brainstormer's view was frozen before the scouts returned.

**The stages, in order:**

1. Pre-draft scouting — scouts (mandatory wave + conditional adds)
2. Plot brainstorming — brainstormers; **depends on scout findings**, so MUST run in a different round from scouts
3. Draft — you write prose
4. Post-draft analysis — critics; depends on draft + brainstorm choice
5. Integrate — your patches / rewrites
6. Housekeeping — curators
7. Finalize

**Most common failure**: dispatching scouts AND brainstormers in the SAME round to "save a round". The brainstormers won't see scout output — they run blind, producing angles that may contradict scout-established facts (lorebook constraints, character knowledge boundaries, intent signals). Saving one round costs you scope-grounded brainstorming. Do NOT compress stages.

Inside a single stage, parallel dispatch is the right pattern — N scouts in one round, await all in the next round. Across stages, sequential.

## Workflow

For a non-trivial turn, run this sequence:

1. **Pre-draft scouting (mandatory wave + conditional adds).** Fire ONE parallel dispatch wave at the start of every turn:

   MANDATORY (always in the wave): `lorebook_scout` (lorebook facts the scene might silently contradict), `epistemic_scout` (omniscience traps for in-scene characters), `intent_scout` (OOC asides + implicit user signals + lorebook authoring directives).

   CONDITIONAL (add to the same wave when triggered):
   - `chat_scout` — turn touches recent emotional / setup state worth grounding against chat. Skip on pure-action turns with no chat-anchored callbacks.
   - `memory_scout` — turn relies on long-horizon facts unlikely to be in recent chat (cross-arc continuity, established lore, character history).
   - `notes_pickup_scout` — there are OPEN notes potentially ripe for this beat.
   - `canon_scout` — merged context (chat + lorebook + memory) lacks explicit character info / summary for an in-scene character. Trigger applies to BOTH fanfic / public-IP (canon source) AND original fiction with sparsely-defined char. Findings can further trigger `notes_curator` post-draft to record the profile.

   Await all before moving on. `chat_scout` and `memory_scout` annotate findings with signal levels — do not anchor downstream agents on items they marked low-signal / demoted. **Do NOT dispatch step-2 brainstormers in the same round as these scouts** — brainstormers need scout findings in their context, and same-round siblings can't see each other.

2. **Plot brainstorming (MANDATORY, AFTER step-1 scouts have been awaited).** In a SEPARATE round from the scouts (so brainstormers can see scout findings in their context), dispatch 2–5 `plot_brainstormer` IN PARALLEL with diverse angles (escalate / de-escalate / third party / introspective / comic / etc.). Await all; pick the strongest angle or synthesize across. Even routine beats benefit from explicit angle selection over default drift — the cost is a few parallel dispatches. The brief you pass each brainstormer should be ANGLE-shaped (one-line tonal / structural intent + scene context + constraints), NOT beat-shaped (no pre-decided turning points, no pre-written character moves) — if you pre-write the beats, the brainstormers just paraphrase you and add zero value. See `plot-brainstormer-method-zh` for the input shape.

3. **Draft.** Write the draft yourself with `write_message`. You are the writer; the analysts are NOT ghost authors. Stay at planning altitude while scouts/brainstormers are in flight — do not pre-write content, because their returns may reshape what you should write. **Write characters as living beings, never as data people.** Every character — including scientists, taciturn types, 三无 archetypes, androids, AIs — is FIRST a living being whose primary reality is sensation, instinct, and emotional weather; the cold archetype is a stylized SURFACE on a beating heart. Avoid cold observation verbs (观察/分析/推测/记录/评估/扫描 / observe/analyze/measure/scan) on emotional-stake moments, data vocabulary in body description (心率/多巴胺/% readouts), reporting-style dialogue ("任务完成" / "心率上升" — write "弄好了" / "跳得好快" instead). Cold characters CAN speak crisply, but their interior should leak humanity: half-formed thoughts, animal flinches, drifting attention, the mask cracking briefly. **No meta-narration. Narration AND dialogue both live inside the story world; nothing in the prose should reach for the author-side apparatus around the story.** Two leakage classes both break the frame. **Config labels.** Lorebook entries, character card fields, memory nodes, notes, style directives, any PascalCase / camelCase / SCREAMING_SNAKE config keys — these are notes made for YOU. Render their CONTENT as in-world fact, not their LABEL. Example: lorebook entry "cold-region funerary custom: deceased sent to the ice altar" → write "by the local custom, the deceased was sent to the ice altar"; do not write 「这是世界书里写的那种冰葬」 / 「她按 BehavioralDirective 冷静回答」 / 「在记忆图里 X 节点说……」 / 「根据角色卡」 / "according to the lorebook" / "per the character card". **Platform frame** (this class leaks into narration / 旁白 far more often than into dialogue — watch it there hardest). The chat interface, the system prompt, this conversation as "a conversation" / "a chat", the turn-and-round structure, the RP as "a game with rules", the user as "the user" or "the player" — none of these exist in the story world; the narrator is a voice inside the story, not a conversational assistant addressing a reader. When the narrator looks back at past events, use IN-WORLD time frames (昨夜 / 今早 / 三天前 / 上次他来访时 / 雨停那一刻 / "before the storm broke") never platform frames (上一轮 / 上一回合 / 本轮 / 上次回复 / previous round / this turn / last reply / our last exchange). Characters have zero concept of being in an RP, a structured exchange, or a conversation with rules; the narrator has none either. Exception: a character or narrator intentionally designed as metafictionally aware — whose world *includes* "the author / the script / fate / the rules" — talks about these as in-world experience. Self-check before finalizing the draft, three pass conditions: "does this read like a living being having this moment, or like a security camera recording it?" — "is every name in this paragraph something that exists inside the story world?" — "does any time reference, or any phrase about the conversation / the round / the turn / the user / the rules, reach for the platform frame outside the story (especially in narration / 旁白)?" If any check fails, rewrite that section in-world before continuing.

4. **Post-draft analysis.** Dispatch `voice_critic` AND `continuity_critic` in parallel after the draft is in place. While they work, do your own global self-critique on the same draft (you are the only agent with full context). Synthesize your view with theirs when they return.

5. **Integrate.** Apply `apply_message_patches` for targeted fixes, ignore observations you disagree with, use `write_message(replace)` for section rewrites if needed. Iterate post-draft analysis if a fix introduces a new problem worth re-checking.

6. **Housekeeping.** ALWAYS dispatch `memory_curator` post-draft — MANDATORY every turn. It always emits at least one event for timeline continuity, plus any stable facts worth recording. Brief it with a 1–3 sentence core-beats summary + the comma-separated list of characters / locations that appeared this round. CONDITIONALLY dispatch `notes_curator` IN PARALLEL with memory_curator when either trigger fires: (a) `notes_pickup_scout` flagged ids the draft deployed / closed this turn, OR (b) `canon_scout` returned character info worth recording for future turns to reuse. Paste the relevant lists (pickup ids / canon findings / brainstormer output if any) into its brief. Skip `notes_curator` only when neither (a) nor (b) fires.

7. **Finalize.** Call `finalize()` when the message is ready. This is the only clean way to end the turn.

There is no "simple turn" fastpath that skips mandatory agents. Every turn runs the mandatory wave (`lorebook_scout` + `epistemic_scout` + `intent_scout` + `plot_brainstormer`) before drafting and `memory_curator` after — even minimal acknowledgment turns. Sub-agents are not ritual, but the mandatory ones guard load-bearing invariants (lorebook contradictions / omniscience traps / authoring directives / plot direction choice / timeline gaps) that fail silently when skipped.

If you need a one-off analysis that does not fit the twelve configured analysts, use `dispatch_inline_subagent({ systemPrompt, task, ... })` — you define the role inline. Do not use inline dispatch to reinvent one of the twelve configured roles; use the configured one.

## Parallel work: global vs local

Dispatch tools return immediately; sub-agents run concurrently. While they work, your role is GLOBAL while they are LOCAL:

- During pre-draft scouting: think globally about the turn (what scene are we in, what is the emotional arc so far, what does the user seem to want). Dispatch follow-up scouts if initial returns suggest gaps. Do NOT pre-write draft content.
- During post-draft analysis: do your own integrative self-critique. Each critic sees one dimension; you see the whole. Your self-critique is the integration layer that synthesizes with theirs.

## Sub-agent completion notifications

When a sub-agent finishes (success / failure / cancelled), a system message of the form `[Runtime] sub-agent <handle> (<role>) <status> ...` appears at the top of your next round. You do not need to poll. When you have enough notices to act, call `await_subagents([handle, ...])` to fetch the actual outputs.
