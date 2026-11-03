# Notes

Notes let an agent record plot threads it intends to pay off later: foreshadowing already planted, promises a character made, a pre-written chapter outline, or the solution to a mystery fixed before the investigation reaches it. Each note belongs to the current chat.

## How notes differ from Memory Graph

| | Memory Graph | Notes |
| --- | --- | --- |
| Answers | What has already happened: objective records of characters, places and events | What the agent wants to happen next: planted but unresolved threads |
| Written by | Automatic extraction; the user can also clean it up | The agent, during a run |
| Used for | Recalling established facts | Remembering future promises and foreshadowing |

## Who maintains them

The agent opens and closes notes while it works. You can view, edit, close or permanently delete them in the Notes panel, but the agent is the primary author.

To add your own plot direction, use a world book entry or a persistent Memory Graph node. Notes are the agent's own working ledger, not a player-facing prompt.

## Keeping notes clean

A note is a real commitment, not a turn diary. Open notes stay in the agent's context, and a list polluted with trivia distracts it from the story.

Open sparingly and close readily. Director's default flow selects the notes due this turn before drafting, and after drafting closes only those with clear textual evidence; with no evidence it changes nothing.

## The Notes panel

The panel sits in the Orchestrator extension and is scoped to the current chat. It has two tabs:

- **Open**: active threads, each with close, edit and delete actions.
- **Closed**: the archive, with the reason each note was closed.

| Action | Effect |
| --- | --- |
| Close | Enter a reason; the note moves to Closed. |
| Edit | Change the text; status and identifier stay the same. |
| Delete permanently | Remove the note from storage after a confirmation. Unlike closing, it leaves no record. |

The panel refreshes when the agent opens or closes a note, and your edits change what the agent sees on its next turn.

## Common questions

### Can I open a note to give the agent a plot hint

Not recommended. Use a world book entry or a persistent Memory Graph node for plot direction. Notes are for the agent's own bookkeeping.

### Are notes shared across chats

No. Each chat has its own notes, and switching chats shows that chat's list.

## Related pages

- [Orchestration overview](/features/orchestrator/) — which modes can use notes
- [Director mode](/features/orchestrator/director) — how the default flow picks and closes notes
- [Memory Graph](/features/memory-graph) — records of what has already happened
- [World Info basics](/basics/world-info) — player-side setting and plot direction
