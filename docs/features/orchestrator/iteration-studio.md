# AI Iteration for Orchestration

**Workbench → AI iteration → Orchestration** is the primary way to customize any orchestration profile. Instead of writing stage graphs, planner prompts, or custom tools by hand, describe the goal in plain language, review the proposed edits in the **Change list**, and apply them. Spec, Agenda, Loop, and Director all share the same workspace.

::: tip Start with AI iteration
Describe the workflow or fix you want first; manual editing under **Workbench → Orchestration** (**Flow** / **Setup**) is always available for direct fine-tuning.
:::

## Opening it

1. Open **Workbench** (`Alt+W`, wand menu → **Workbench**, or corner pill) → **AI iteration** → **Orchestration**.
2. Or click the **AI** button in the **Orchestration** workspace topbar (or the AI button under **Setup**).
3. To diagnose a specific run, click **Not happy with the result? AI diagnosis** in the **Run panel** dock, **Diagnose this run** in **Orchestration → Run**, or the target icon in **Orchestration → Stats**.

![Iteration view](/images/orchestrator/orch-iteration-studio.png)

Choose the target scope at the top: **Global** edits the shared profile, while **Character-only** edits the active character card's profile (saving one automatically if needed, or editing the chat profile in Agenda mode).

## Describing what you want

Write a clear sentence in the composer describing what should change:

> Example: *"I want the AI to recall recent important events before each reply, keep characters consistent, and not break the fourth wall."*

![Input with sample prompt](/images/orchestrator/orch-iter-input.png)

Send the message. The AI inspects the active profile, reads relevant lorebook entries or skills when needed, and stages edits via tool calls. The loop continues across rounds whenever the AI calls tools and stops as soon as it responds with plain text.

## Reviewing and applying changes

Proposed changes appear in the **Change list** with inline before/after diffs (and expandable line diffs). Tick the changes to apply and click **Apply selected**, or discard them. Enabling **Apply automatically** writes edits directly as they arrive; every applied change is recorded in **Workbench → Change history** and can be undone individually.

![Pending diff review](/images/orchestrator/orch-iter-diff-inline.png)

![Diff side-by-side detail](/images/orchestrator/orch-iter-diff-side.png)

## What AI iteration can do

- **Edit any mode.** Add, remove, or reorder Spec stages and nodes; adjust Agenda's dispatcher prompt and worker pool; rewrite Loop's system prompt, tool toggles, and limits; or update Director's lead writer and sub-agents.
- **Diagnose runs & stats.** Inspect failed or slow runs and adjust prompts, tool permissions, or model routing to fix bottlenecks.
- **Simulate.** Run the workflow against the current chat (including World Info activation) without adding anything to the real chat, then annotate issues in the simulation review popup for root-cause fixes.
- **Reconcile card lorebooks.** In character scope, detect lorebook entries whose formatting rules interfere with orchestration tool loops and propose surgical rewrites as reviewable cards.
- **Author skills and custom tools.** Draft, install, and attach skills or dry-run custom JavaScript tools with code review before applying.
- **Persistent sessions.** Conversations stay saved per scope so you can close Workbench and pick up later.

![Simulation result](/images/orchestrator/orch-iter-simulation.png)

## Typical workflow (Spec example)

> **You:** *"Don't break the fourth wall."*
> **AI:** Adds a review/guard node and enables style checks. You apply the change.
>
> **You:** *"Make it read the lorebook so it knows the world rules."*
> **AI:** Adds a lorebook reader node so downstream nodes see active rules. You apply the change.
>
> **You:** *"Simulate against an obviously-meta input — does it actually catch it?"*
> **AI:** Runs a simulation on the current chat and returns each node's output.

## Per-card lorebook hygiene

When editing a character-scoped profile, the AI also checks the card's bound world books for formatting rules that clash with orchestration:

- **Process coercion** — rules that dictate *how the model thinks on every round* (mandatory thinking templates, step-by-step checklists before answering). These interfere with tool-calling rounds, so the AI proposes extracting the underlying persona or worldbuilding intent as narrative content.
- **Final-output shape** — rules describing *how the final reply should look* (tags, markdown structure, closing blocks). The AI scopes these clearly to the final output so intermediate planning and tool-calling agents stay unobstructed.

All lorebook proposals appear in the **Change list** for explicit approval. Global sessions never touch lorebooks.

## Authoring skills via AI iteration {#authoring-skills-via-iter-studio}

Describe a new rule in plain language and tell the AI which agents should see it:

> Write a skill that keeps the director from using stiff translated-Chinese phrasing — no "当……的时候" stem, no "——" dash-splitting sentences, prefer "是吧" over "是吗". Add it so every agent in director mode sees it.

The AI drafts `SKILL.md`, stages the skill installation proposal, and wires visibility to the requested agents in the same approval list.

![Install round completed](/images/skills/iter-studio-05-after-llm-round.png)

See [Shaping RP output with skills](/recipes/rp-skills-walkthrough) for a full walkthrough.

## Sessions

Each scope keeps its own conversation history so experiments on one character card stay separate from global defaults.

![Session list](/images/orchestrator/orch-iter-sessions.png)

## Related

- [Workbench](/features/workbench) — unified workspace, Q&A, and change history
- [Orchestrator overview](/features/orchestrator/) — modes, Run panel, and card binding
- [Spec mode](/features/orchestrator/spec) — fixed-stage pipeline
- [Single Agent mode](/features/orchestrator/single) — single-node pipeline
- [Agenda mode](/features/orchestrator/agenda) — dynamic dispatch
- [Loop mode](/features/orchestrator/loop) — single-agent tool loop
- [Skills in the orchestrator](/features/orchestrator/skills) — making a skill visible to specific agents
