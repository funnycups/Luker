# AI Iteration Studio

The AI Iteration Studio is the **primary way to customize the orchestrator**. In 99% of cases, stages and nodes do not need manual editing and Planner prompts do not need to be written by hand — describe the goal in one sentence, the AI returns a proposal, and each change is approved individually. Spec / Agenda / Loop / Director all use the same Studio; only the artifact differs.

::: tip Try the Studio first; edit manually only if it cannot reach the result
If you are about to open the orchestration editor to add nodes manually, consider the Studio first — in most cases it can produce a workable proposal within seconds. Manual editing is reserved for corner cases the Studio cannot reach.
:::

## Open the Studio

Switch to the execution mode you want (Spec / Agenda / Loop), then click **Open AI Iteration Studio** in the orchestrator panel's actions area.

![Quick Build and Iteration Studio buttons](/images/orchestrator/orch-quickbuild-button.png)

A new panel opens. The left side is your conversation with the Studio's AI; the right side shows the current orchestration state.

![Iteration Studio main view](/images/orchestrator/orch-iteration-studio.png)

## Describe what you want

In the input box, write one sentence describing what the orchestration should do. A specific description is better than a general one.

> Example: *"I want the AI to recall recent important events before each reply, keep characters consistent, and not break the fourth wall."*

![Studio input with sample prompt](/images/orchestrator/orch-iter-input.png)

Click **Send to AI**.

## Watch the AI work

The AI replies with a short plan and a proposal showing what it intends to change. The exact form depends on the mode:

- **Spec / Agenda** — the AI produces a diff: green-add / red-delete / yellow-modify entries. You can approve or reject each one, or simply wait — the Studio iterates automatically until the proposal stabilizes, with each round showing its diff.
- **Loop** — the AI uses tool calls to patch the profile directly (`system_prompt` / tool toggles / `max_rounds` / preset routing). No per-change approval surface; the AI decides when it is done.
- **Director** — direct profile patches via tool calls against the main agent and the sub-agent roster: prompts, tool sets, preset routing, skills. The roster view marks the rows that changed; no per-change diff approval.

![Pending diff review](/images/orchestrator/orch-iter-diff-inline.png)

If a change isn't obvious, click the magnifier icon next to it for a side-by-side comparison.

![Diff side-by-side detail](/images/orchestrator/orch-iter-diff-side.png)

## Apply

When the AI reports that it has nothing more to suggest, click **Apply to Global** (use everywhere) or **Apply to Character Card** (only for this card).

## What the Studio can do

- **Multi-round dialogue.** Each round takes one sentence of feedback; the AI proposes a focused change, and you review it.
- **Per-change approval (Spec / Agenda).** Each diff entry has its own Approve / Reject, so only part of a proposal can be accepted.
- **Program-driven auto-continue.** The Studio starts another round whenever the AI emits any tool call in the current round, and stops as soon as the AI responds with plain text and no tool calls. **There is no manual Auto-Continue toggle and no AI-side continue / finalize tool — the loop simply reacts to what the AI did.**
- **Simulation.** Run the workflow against the actual current chat — exactly as if a new message had just been sent, World Info activation included — but the result appears only in the Studio, *not* in the real chat. For example, asking "will my Constraint Agent really catch the OOC-prone moments?" makes the Studio run the pipeline and display each node's output.
- **Sessions.** Up to 24 saved sessions per scope. Different cards or different experiments each get their own thread.
- **Rollback.** Changes can be reverted even after Apply.
- **Foldable thinking.** `<thought>` tags from reasoning models are folded by default; messages over ~1200 chars are folded.

## A typical iteration (Spec example)

> **Round 1.** You: *"Don't break the fourth wall."*
> AI: "Adding a Constraint Agent to Stage 2 with anti-meta checks; enabling Anti-Data Guard." Diff: 1 new node, 1 setting changed. You approve. <!-- banned-words-allow -->
>
> **Round 2.** You: *"Make it read the lorebook so it knows the world rules."*
> AI: "Added a `lorebook_reader` node to Stage 1 so the Constraint Agent can see the active world rules." Diff: 1 new node. Approve.
>
> **Round 3.** You: *"Simulate against an obviously-meta input — does it actually catch it?"*
> AI: Switches to Simulation mode, runs the pipeline against a fake user message that breaks the fourth wall, returns the Constraint Agent's verdict.

![Simulation result](/images/orchestrator/orch-iter-simulation.png)

> **Round 4.** Stable. You click **Apply**.

Every step is visible, interruptible, and reversible — that is the point. Control is never handed to a black box: the AI proposes and you decide.

## What each mode produces

| Mode | Studio output | What you see |
|---|---|---|
| **Spec** | Diff against stages / nodes: add/remove nodes, edit prompt templates, tweak execution flags, override API/preset | Green/red/yellow diff list, per-change approval |
| **Agenda** | Diff against the Planner Prompt + Agent pool: add agents, edit Planner dispatch logic | Green/red/yellow diff list, per-change approval |
| **Loop** | Direct profile patches via tool calls: `system_prompt` / tool toggles / `max_rounds` / preset routing | No diff surface — the AI tells you the result after applying |
| **Director** | Direct profile patches via tool calls against the main agent + sub-agent roster: prompts, tool sets, preset routing, skills | Roster view with changed rows marked; no per-change diff surface |

## Loop-mode iteration tips

To avoid writing the system prompt by hand, open the Studio in Loop mode and describe the agent's behaviour in plain language:

> I want this agent to read the last 5 floors first, then look up relevant lorebook entries, then check the memory graph for conflicts, then write the capsule. Don't have it take notes.

The Studio's AI reads your current profile and patches it via tool calls. The Studio auto-continues whenever the AI emits any tool call this round and stops the moment the AI responds with plain text and no tool calls — so iteration continues for as long as the AI keeps making changes.

## Per-card lorebook hygiene

When you open the Studio scoped to a character card, the AI also reconciles the orchestration being built against the card's bound lorebooks. Format-related lorebook entries fall into two categories that require different handling:

- **Process coercion** — entries that pin *how the model thinks during the run* (mandatory thinking templates, every-round CoT prefixes, "always check X before answering", "follow steps 1-N in order before responding"). These interfere with the agent loop in an orchestration: they fire every tool-call round, force narrative-shaped text where the agent needs to plan and call tools, and starve the planning channel. The Studio strips the format and extracts the underlying intent — the topics, angles, persona habits, scene anchors the author cared about — rewriting it as worldbuilding / persona / scene-anchor content the agent reads as narrative input, not as another rule.
- **Final-output shape** — entries that describe *what the final committed reply looks like* ("all output must be markdown", "wrap the response in a tag", "end with a closing summary block", "speak in poetry"). These are legitimate stylistic preferences and the Studio keeps them. It only rewrites them so the finalize semantics are explicit, so intermediate orchestration nodes (planner, tool-callers, reviewers) stay free to use whatever form they need on the way to the final commit.

The Studio prefers surgical clause-level rewrites that preserve the rest of an entry; whole-entry disabling happens only when the entry is pure format coercion with no salvageable content. Nothing is ever deleted.

**Approval flow.** Lorebook adjustments are *proposed*, not applied immediately. Each proposal appears below the assistant message that produced it as a diff card with **Approve** / **Reject** controls — the same per-change review you already have for orchestration changes. Only approved proposals are committed to the on-disk world book when **Apply** is clicked; rejected proposals are dropped, and undecided ones remain in the panel for later review. A summary row above the composer shows the running counts (pending / approved / rejected) and offers a dedicated "Commit approved lorebook edits" button when approved proposals exist but no orchestration changes are pending alongside them.

Global Studio sessions never touch any lorebook — this only runs in character scope.

## Authoring skills via iter-studio

To avoid writing a skill by hand, open the Studio and describe what is needed. It writes the SKILL.md, installs it, and (on request) attaches it in the right place — with the same per-change approval flow as every other change.

The prompt can be a plain sentence. For example:

> Write a skill that keeps the director from using stiff translated-Chinese phrasing — no "当……的时候" stem, no "——" dash-splitting sentences, prefer "是吧" over "是吗"。Add it so every agent in director mode sees it.

The Studio drafts the SKILL.md, opens the install round, and you approve. The skill is written to disk and is ready to use as soon as it is approved. If you also asked the Studio to attach it ("…so every agent sees it" / "…for voice_critic"), it wires it into the right place too; otherwise you can attach it yourself later from the [skill list section](/features/orchestrator/skills) of the director editor.

![Studio after the install round](/_screenshots/skills/iter-studio-05-after-llm-round.png)

See the [recipe](/recipes/rp-skills-walkthrough) for the full walkthrough.

## Sessions

Different cards, different experiments — each keeps its own session.

![Session list](/images/orchestrator/orch-iter-sessions.png)

Sessions persist across reloads, scoped to global or to a character card. Up to 24 saved sessions per scope.

## Sidebar — Quick Build (Spec / Agenda)

Quick Build is the one-shot version of the Iteration Studio, available for Spec and Agenda. Type a description into the **AI Generation Goal** field at the top of the orchestration editor and click **AI Quick Build**:

![Quick Build button](/images/orchestrator/orch-quickbuild-input.png)

After a single LLM round, a complete workflow is produced:

![Quick Build result](/images/orchestrator/orch-quickbuild-result.png)

Quick Build is appropriate when:

1. The Studio has been used enough times that the target is clear and only the boilerplate is needed.
2. The simplest workable path is preferred and how the AI arrived at it does not matter.

In most cases, the Iteration Studio is the better choice: the extra 1–2 minutes produce a workflow that is understood and adjustable.

::: info Loop mode has no Quick Build
Loop mode iterates only through the Studio — there's no "generate a complete profile in one shot" entry point, because the loop's system prompt usually needs scenario-specific tuning, and a one-shot output tends to be off target.
:::

## Related

- [Orchestrator overview](/features/orchestrator/) — common configuration / triggers / character card binding
- [Spec mode](/features/orchestrator/spec) — the default DAG mode
- [Single Agent mode](/features/orchestrator/single) — degenerate Spec
- [Agenda mode](/features/orchestrator/agenda) — Planner-driven dynamic dispatch
- [Loop mode](/features/orchestrator/loop) — single-agent tool loop
- [Skills in the orchestrator](/features/orchestrator/skills) — making a skill visible to a particular agent
- [Character Card Editor](/features/card-editor/) — shares the diff engine with Iteration Studio
