# Per-Message Variables

Luker introduces **per-message variables** on top of SillyTavern's existing variable system: AI replies can write variables that are extracted, structured, persisted with the message, and replayed deterministically when chat history changes — so deleting a message, switching swipes, or regenerating a reply leaves your variables in the right state automatically.

## Why this exists

In stock SillyTavern, side-effect macros like <code v-pre>{{setvar::hp::50}}</code> only run when they appear in a *prompt template* (preset, world info, or the very first message). If the AI writes the same literal in its reply, nothing happens — the macro is just text. Even worse, when the literal is rendered to the user it shows up verbatim, polluting the narrative.

Luker fixes this by extracting side-effect macros out of AI / user messages at save time, recording them as structured ops attached to that message, and replaying them when needed. The literal is removed from the visible text; the operation is preserved as data.

## How it works

### Extraction

When a message is saved (AI reply, continue, regenerate, swipe, or user message), Luker scans `mes` for the recognized side-effect macros:

- <code v-pre>{{setvar::name::value}}</code>
- <code v-pre>{{addvar::name::value}}</code>
- <code v-pre>{{incvar::name}}</code>
- <code v-pre>{{decvar::name}}</code>
- <code v-pre>{{deletevar::name}}</code>

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

Every message that carries any op-log gets a small flask icon in its button row. Clicking it opens a panel where you can:

- See every operation recorded for that message.
- Edit `op`, `key`, or `value` inline.
- Delete an operation.
- Add a new operation.

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

## Storage layout

```jsonc
chat[i] = {
    "mes": "...narrative with side-effect macros stripped...",
    "extra": {
        "var_ops": [
            { "op": "setvar", "key": "hp", "value": "50" },
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
