# Per-Message Variables

Roleplay state is often written inside the AI's reply: stamina drops to 40, a dagger is acquired, an NPC leaves the party. Per-message variables make those assignments take effect and keep them tied to the chat history. Delete a message, switch a swipe or regenerate, and the variables return to the values the current timeline should have.

## The problem it solves

In stock SillyTavern, <code v-pre>{{setvar::hp::50}}</code> runs only inside prompt templates such as presets, world books and the first message. The same text in an AI reply changes nothing and is shown to the user as literal text, breaking the scene.

Luker extracts those assignments when a message is saved, stores them with the message, and removes them from the visible text. Variables update immediately; when a message is deleted or a swipe changes, Luker recalculates from the assignments that still exist instead of keeping stale values.

```d2
direction: down

AI: "Reply saved to the chat"
EXTRACT: "Extract assignment macros\nsetvar / addvar / incvar / decvar / deletevar / pushvar / popvar" {
  style.fill: "#e1f5ff"
}
EVAL: "Resolve nested display macros"
APPLY: "Write the current variables"
LOG: "Record the operations on the message"
CLEAN: "Remove assignments from visible text"
DISPLAY: "Chat shows the narrative alone"

AI -> EXTRACT -> EVAL -> APPLY -> LOG -> CLEAN -> DISPLAY

REPLAY: "The chat structure changes" {
  shape: diamond
}
DEL: "Message deleted"
SWIPE: "Swipe changed"
SWIPED: "Swipe deleted"
EDIT: "Message edited"
CHANGED: "Chat switched"
REBUILD: "Recalculate from surviving assignments" {
  style.fill: "#fff3e0"
}

DEL -> REPLAY
SWIPE -> REPLAY
SWIPED -> REPLAY
EDIT -> REPLAY
CHANGED -> REPLAY
REPLAY -> REBUILD
```

## Supported assignments

These are extracted from a message:

- <code v-pre>{{setvar::name::value}}</code>
- <code v-pre>{{addvar::name::value}}</code>
- <code v-pre>{{incvar::name}}</code>
- <code v-pre>{{decvar::name}}</code>
- <code v-pre>{{deletevar::name}}</code>
- <code v-pre>{{pushvar::name::value}}</code>
- <code v-pre>{{popvar::name}}</code>

Variable names accept dotted paths, for example <code v-pre>{{setvar::roster.alice.hp::50}}</code>. Assignments run in the order they appear, so a later one can read an earlier result.

Display macros nested in a value are resolved against the current state first, so <code v-pre>{{setvar::greeting::{{user}}}}</code> writes the current user name.

## Reviewing and editing

A message with variable operations shows a flask icon. Open it to:

- view every operation recorded on the message
- change the operation, variable name or value
- delete an operation
- add an operation

Saving recalculates the variables from the edited record. Prefer this panel for manual changes: the edit belongs to a specific message, so later deletions and swipes still resolve correctly.

## Deletion, editing and swipes

Luker replays only the variable operations that remain in the chat. Deleting a message rolls back variables that message wrote; switching a swipe follows the active swipe's record. Editing message text does not re-extract assignments; use the flask panel when you need to change them.

Replay only affects the top-level variable names named in the operation records. Variables written by world books, slash commands, Quick Replies or third-party extensions are not overwritten.

## Coexistence with other sources

| Source | Behavior |
| --- | --- |
| World book <code v-pre>{{setvar}}</code> | Runs during prompt assembly and overwrites the name every turn. Suited to initialization or values recalculated from the current situation. |
| Preset <code v-pre>{{setvar}}</code> | Same as world books. |
| Slash command `/setvar` | Writes chat variables directly. If a later message operation also writes the same name, replay uses the message record. |
| Quick Reply | Same as slash commands. Give Quick Reply variables names the AI will not use. |
| <code v-pre>{{setglobalvar}}</code> family | Not extracted per message. Global variables are shared across chats and keep their native behavior. |

## Advice for card authors

- For variables the AI should change during the story, let the AI write the assignment in its reply and do not also write the same name from a world book or Quick Reply.
- For values initialized once at chat start, put the assignment in the first message or an alternate greeting.
- For values recalculated every turn, keep them in a world book entry so prompt assembly overwrites them.
- For panel data that advances with the story, model it as chat variables: initialize in the greeting, let a world book entry instruct the AI to update them, and have the CardApp read and render them.

## Structured variables

One variable can hold a complete structure: an NPC roster, party inventory, quest log or relationship table. The AI changes one leaf at a time instead of rewriting the whole structure.

```text
{{setvar::roster.alice.hp::50}}
{{setvar::roster.alice.mood::cautious}}
{{pushvar::roster.alice.inventory::dagger}}
{{setvar::roster.alice.hp::40}}
{{deletevar::roster.bob}}
```

When a message is deleted or a swipe changes, the structure is rebuilt from the operations that remain, and the change lands on the corresponding leaf.

Render it with <code v-pre>{{each}}</code>:

```text
{{each::roster}}
- {{loop_key}}: {{loop_value::hp}} HP
{{/each}}
```

<code v-pre>{{loop_key}}</code> is the current key, <code v-pre>{{loop_value}}</code> the whole value, and <code v-pre>{{loop_value::field}}</code> reads a field inside it. A collection can also be an inline array or a nested macro.

## Related pages

- [Macros](/basics/macros) — the full variable macro syntax
- [World Info basics](/basics/world-info) — using entries to instruct the AI to update variables
- [CardApp](/features/cardapp) — reading variables and rendering them in an interface
