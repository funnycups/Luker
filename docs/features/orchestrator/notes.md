# Notes — Agent Plot Thread Tracker

Notes is the orchestrator's per-chat store for **what the agent (as plot author) wants to make happen later**. Foreshadowing planted, promises made by characters, chapter outlines written ahead, mystery-genre solutions drafted before the investigation — anything that captures an obligation the agent has committed to honoring in a future turn.

It is deliberately distinct from **memory-graph**:

| Subsystem | Answers | Author |
|---|---|---|
| memory-graph | "What has already happened" — objective record of scenes, character states, locations | Auto-extracted; user can curate |
| **notes** | **"What does the agent (as author) want to happen next"** — planted but not yet triggered | **Agent itself, via tools during the loop** |

You (the player) can view, close, edit, and hard-delete notes through the **Notes panel** — but you are not the primary author. If you want to inject plot direction, use lorebook entries or memory-graph always-injected nodes; notes is for the agent's own bookkeeping.

## Tools the agent uses

| Tool | Behavior |
|---|---|
| `note_open(text)` | Open a new note. Returns its id. The note shows up in the agent's "## Open Notes" system block every subsequent run, until closed. |
| `note_close(id, reason?)` | Close a note by id with an optional one-line reason. The note disappears from the prompt block; the closure stays in the archive (visible in the panel). |

Open notes are always visible in the agent's system prompt — there is no auto-LRU, no token budget, no auto-expiry. **The agent is responsible for its own note hygiene**: if it opens 80 stale notes and never closes them, it pays the prompt-budget cost itself. The orchestrator does not bail it out.

## Anti-pollution principle

Notes is for **genuine commitments**, not a turn diary. A polluted notes list (entries that were never real obligations, or stale entries that should have been closed) drags every subsequent round. The director mode default sub-agents enforce this:

- `notes_pickup_scout` runs pre-draft and picks only the **ripe** open notes for this turn's beat
- `notes_curator` runs post-draft, defaults to **do nothing**, closes only on explicit textual evidence in the draft, and opens new notes only when the draft itself committed to a future-payoff obligation

If you write your own director sub-agents or operate in loop mode without a curator, the same discipline applies — close more aggressively than you open.

## The Notes panel

The Notes panel lives in the orchestrator extension's panel, scoped to the current chat. It shows two tabs:

- **Open notes** — currently active threads. Each row has Close / Edit / Delete actions.
- **Closed notes** — the archive. Closure reasons are shown beneath each row.

Per-row actions:

| Action | Effect |
|---|---|
| Close this note | Same as the agent's `note_close` — a closure-reason prompt appears; submitting moves the note to Closed. |
| Edit note | Inline text edit. Status and id are preserved. Useful for typo / clarity fixes. |
| Delete note (permanent) | Hard delete from storage. Two-step confirm. **Not** the same as Close — Delete erases the entry; Close keeps it for the record. |

The panel updates live as agents open / close notes via tools, and your panel actions update agents' next-turn prompts the same way.

## Common questions

**Q: Should I manually open notes in the panel to give the agent plot hints?**
No. Notes is the agent's instrument. If you want to seed plot direction, use a lorebook entry or a memory-graph always-injected node — those are designed as user-side authoring surfaces.

**Q: Are notes shared across chats?**
No — each chat has its own notes store. Switching chats shows that chat's own open / closed lists.
