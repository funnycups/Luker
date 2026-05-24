# Per-Message Variables

Luker introduces **per-message variables** on top of SillyTavern's existing variable system: AI replies can write variables that are extracted, structured, persisted with the message, and replayed deterministically when chat history changes — so deleting a message, switching swipes, or regenerating a reply leaves your variables in the right state automatically.

## Why this exists

In stock SillyTavern, side-effect macros like <code v-pre>{{setvar::hp::50}}</code> only run when they appear in a *prompt template* (preset, world info, or the very first message). If the AI writes the same literal in its reply, nothing happens — the macro is just text. Even worse, when the literal is rendered to the user it shows up verbatim, polluting the narrative.

Luker fixes this by extracting side-effect macros out of AI / user messages at save time, recording them as structured ops attached to that message, and replaying them when needed. The literal is removed from the visible text; the operation is preserved as data.

## How it works

```d2
direction: down

AI: "AI reply / user message saved"
EXTRACT: "Scan mes for side-effect macros\nsetvar / addvar / incvar / decvar / deletevar / pushvar / popvar" {
  style.fill: "#e1f5ff"
}
EVAL: "Resolve nested display macros\n{{user}} / {{getvar}} / {{time}} ..."
APPLY: "Forward-apply to\nchat_metadata.variables"
LOG: "Append structured record to\nmessage.extra.var_ops"
CLEAN: "Strip literals from mes"
DISPLAY: "Chat UI sees\nclean narrative"

AI -> EXTRACT -> EVAL -> APPLY -> LOG -> CLEAN -> DISPLAY

REPLAY: "Chat structure changed" {
  shape: diamond
}
DEL: "MESSAGE_DELETED"
SWIPE: "MESSAGE_SWIPED"
SWIPED: "MESSAGE_SWIPE_DELETED"
CHANGED: "CHAT_CHANGED"
EDIT: "MESSAGE_EDITED"
REBUILD: "Replay surviving ops\nonly keys mentioned in op log" {
  style.fill: "#fff3e0"
}

DEL -> REPLAY
SWIPE -> REPLAY
SWIPED -> REPLAY
CHANGED -> REPLAY
EDIT -> REPLAY
REPLAY -> REBUILD
```

### Extraction

When a message is saved (AI reply, continue, regenerate, swipe, or user message), Luker scans `mes` for the recognized side-effect macros:

- <code v-pre>{{setvar::name::value}}</code>
- <code v-pre>{{addvar::name::value}}</code>
- <code v-pre>{{incvar::name}}</code>
- <code v-pre>{{decvar::name}}</code>
- <code v-pre>{{deletevar::name}}</code>
- <code v-pre>{{pushvar::name::value}}</code>
- <code v-pre>{{popvar::name}}</code>

Every recognized op also accepts a dotted name (<code v-pre>{{setvar::roster.alice.hp::50}}</code>) — see the [structured object workflow](#structured-objects) below.

For each match in source order:

1. Any nested **display** macros inside the value (e.g. <code v-pre>{{user}}</code>, <code v-pre>{{getvar::other_key}}</code>, <code v-pre>{{time}}</code>) are resolved against the current state.
2. The op is forward-applied to `chat_metadata.variables` immediately, so subsequent ops in the same message see the result.
3. A structured record is appended to `message.extra.var_ops`.
4. The literal is stripped from `mes`.

The chat now shows clean narrative; the variables are up to date; the operation history is queryable.

::: info Sequential resolve
Two ops in the same message that depend on each other work as expected:

```
{{setvar::a::1}} {{setvar::b::{{getvar::a}}}}
```

After extraction: `a = 1`, `b = 1`. Each macro is fully resolved and applied before the next is processed.
:::

::: info JSON-shaped values
A value ending in a literal `}` (typical for `{"x":1}` or `[1,2]` payloads) puts three `}` in a row at the end of the macro — one for the JSON, two for the macro close. The scanner treats the **last** `}}` in any trailing run as the macro close, so <span v-pre>`{{setvar::config::{"x":1}}}`</span> parses as expected without escaping.

The flip side: a macro followed by a literal `}` in narrative text (e.g. <span v-pre>`... {{macro}}}`</span>) absorbs that `}` into the value. Insert whitespace (<span v-pre>`{{macro}} }`</span>) when you need the macro and the trailing `}` to stay separate.
:::

### Replay on structural changes

When something changes the chat structure, Luker rebuilds the relevant parts of the variable cache:

| Event | What we do |
|-------|------------|
| `MESSAGE_DELETED` | Replay surviving ops; only keys that appeared in the surviving log are touched |
| `MESSAGE_SWIPED` | Replay (the active swipe's `extra.var_ops` is now in scope) |
| `MESSAGE_SWIPE_DELETED` | Replay |
| `CHAT_CHANGED` | Replay against the freshly loaded chat |
| `MESSAGE_EDITED` | Replay (does not re-extract — editing the narrative will not fire setvar) |

The replay is deliberately minimal: it only touches keys that are mentioned somewhere in the surviving op log. Any variable written by some other source — world info side effect, slash command, Quick Reply, third-party extension, legacy chat metadata — is left exactly where it was.

### Swipe lifecycle

`var_ops` lives on `message.extra`, which SillyTavern already mirrors per swipe via `swipe_info[i].extra`. Switching swipes hands you the right ops for free.

When a new swipe begins generating, `clearMessageData` drops the previous swipe's `var_ops` (Luker added it to the whitelist), so extraction starts from a clean slate.

### Continue

A continued reply appends new tokens to the existing `mes`. Because the previous extraction already stripped its literals out of `mes`, the next extraction pass simply sees the new portion and appends new ops to the same `var_ops` array. No timestamps, offsets, or flags required.

## Operation panel

Every message that carries any op-log gets a small flask icon in its button row:

![Flask icon on a message's button row](/images/variable-op-log/var-ops-flask-button.png)

Clicking it opens a panel where you can:

- See every operation recorded for that message.
- Edit `op`, `key`, or `value` inline.
- Delete an operation.
- Add a new operation.

![Variable operations panel](/images/variable-op-log/var-ops-panel.png)

When you save, the message's op array is replaced with your edits, the cache is rebuilt, and the chat is persisted. This is the recommended way to manually adjust variables — it lands the change at a specific message in the timeline so future structural changes (delete, swipe) preserve the intent.

## Coexistence with other variable sources

| Source | Behavior |
|--------|----------|
| World info <code v-pre>{{setvar}}</code> | Runs at prompt assembly via stock SillyTavern. Cache is overwritten with the WI value each time. To make WI act as initialization rather than per-turn override, place its variable-setting entries at high depth / front of prompt. |
| Preset <code v-pre>{{setvar}}</code> | Same as world info. |
| Slash command `/setvar` | Writes directly to `chat_metadata.variables`. Survives until the next replay touches the same key — i.e. as long as no surviving AI op mentions that key. |
| Quick Reply scripts | Same as slash command. Keep QR-managed variables on names that AI ops do not touch. |
| <code v-pre>{{setglobalvar}}</code> and friends | Not extracted. Global variables live outside the chat-local op-log. They follow stock SillyTavern semantics. |

## Recommendation for character authors

If a variable is meant to be **owned and mutated by AI** during the roleplay, expose it through AI-authored <code v-pre>{{setvar}}</code> calls and never write to it from world info or QR.

If a variable is meant to be **set up once at the start** of a chat, use the character card's first message or an alt greeting — those are extracted into `chat[0].extra.var_ops` like any other source.

If a variable is meant to be a **per-turn render-time override** (e.g. weather based on current location), keep it in world info; the cache will be overwritten each turn and that is the correct behavior.

## When to use variable-driven UI

When some fields need to change as the conversation advances and some UI consumes them — a CardApp panel, a world book entry, a custom renderer — model them as chat variables. Three production paths:

1. setvar bootstrap in `first_mes` / alt greetings for initial values
2. world book entries instructing the AI to emit setvar in its replies
3. the AI emitting setvar directly in replies

Consumers read via `getvar`; the UI re-renders whenever `chat_metadata` changes.

This pattern fits "narrative-header" data — current chapter / phase, active quest progress, location status, the headline of an ongoing case, and similar fields whose values advance with the plot.

## Storage layout

```jsonc
chat[i] = {
    "mes": "...narrative with side-effect macros stripped...",
    "extra": {
        "var_ops": [
            { "op": "setvar", "key": "hp", "value": "50" },
            { "op": "setvar", "key": "roster", "path": "alice.hp", "value": "50" },
            { "op": "incvar", "key": "turn" }
        ]
    },
    "swipe_info": [
        { "extra": { "var_ops": [...] } },
        { "extra": { "var_ops": [...] } }
    ]
}
```

`chat_metadata.variables` remains the SillyTavern-native cache and the source of truth for <code v-pre>{{getvar}}</code>. The op-log is the *origin* of the values that we own; the cache is the runtime view of all sources combined.

When an op carries a `path`, `op.key` is still the top-level variable name — the path is a sub-selector inside the JSON-encoded value of that variable. The op log keeps the rollback unit at the top-level key. See [structured object workflow](#structured-objects) below.

## Structured object workflow {#structured-objects}

Path-aware ops let one variable carry an entire structured payload — an NPC roster, an inventory dict, a quest journal — that the AI mutates one leaf at a time across the conversation. Instead of rewriting the whole blob each turn (which would lose granularity in the op log and make swipes look like full-state rewrites), the AI emits one op per change:

```text
{{setvar::roster.alice.hp::50}}              <!-- introduce Alice -->
{{setvar::roster.alice.mood::cautious}}      <!-- describe her state -->
{{pushvar::roster.alice.inventory::dagger}}  <!-- give her a dagger -->
{{setvar::roster.alice.hp::40}}              <!-- she takes damage -->
{{deletevar::roster.bob}}                    <!-- Bob leaves the party -->
```

`op.key` is always the top-level variable name (`roster` in the example above), so the tracked-keys / replay / swipe-restore logic treats the whole structure as one unit. Deleting the message that wrote a particular leaf rebuilds the structure from the surviving ops, naturally reverting that leaf — `roster` as a whole stays consistent with whatever the surviving timeline says.

This is the recommended pattern for any variable that holds a structured collection an AI maintains across turns: NPC rosters, party inventories, quest logs, relationship maps, location states. The per-leaf granularity gives delete / swipe / branch the smallest possible unit of rollback, and renders naturally with <code v-pre>{{each::roster}}…{{/each}}</code> against the JSON object stored under the top-level key.

## Rendering structured variables — `{{each}}` and `loop_value`

Chat variables hold any JSON-serializable value, so a structured collection (an NPC roster, a quest journal, an inventory map) can live in a single variable and be rendered into the prompt or a world book entry on each pass.

- **Path access** — <code v-pre>{{getvar::npcs.alice.hp}}</code> parses the JSON stored in `npcs` and walks the dotted path. Missing intermediate keys / failed parse / non-iterable head → empty string. Falls back to a literal flat-key lookup when the head segment isn't JSON, so a variable named `a.b` still works.
- **Iteration** — <code v-pre>{{each::npcs}}{{loop_key}}: {{loop_value::hp}}{{/each}}</code> walks the collection (objects → key/value pairs, arrays → string-index/element pairs). Inside the body:
  - <code v-pre>{{loop_key}}</code> — the current key (or the array index as a string)
  - <code v-pre>{{loop_value}}</code> — the whole value (objects auto-JSON-stringify)
  - <code v-pre>{{loop_value::path}}</code> — drill into the value via dotted path, same semantics as <code v-pre>{{getvar}}</code>

  Both shadow naturally when <code v-pre>{{each}}</code> is nested. The collection argument also accepts an inline JSON-array literal (<code v-pre>{{each::["sword","shield"]}}</code>) and a nested macro that resolves to a collection (<code v-pre>{{each::{{getvar::roster}}}}</code>), so you can iterate without round-tripping through a named variable.

This is what makes "variable holds a JSON object → world book entry renders it" a complete pattern: the AI maintains the structure with <code v-pre>{{setvar::npcs::...}}</code>; an entry's body uses <code v-pre>{{each::npcs}}…{{/each}}</code> to lay it out for the prompt.
