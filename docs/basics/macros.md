# Macros

Macros are <span v-pre>`{{name}}`</span> placeholders that get replaced with dynamic content at the moment a prompt is built. They show up in presets, world info, character cards, chat messages, slash commands, regex replacements — anywhere prompt text is assembled. By the time a request reaches the AI, every macro has been resolved to its final string.

## Macros 2.0 / experimental engine

The features on this page run on the chevrotain-based macro engine — the same one SillyTavern introduced as **Macros 2.0** (the "Experimental Macro Engine"). It's on by default in Luker. Toggle it under **User Settings → Chat/Message Handling → Experimental Macro Engine**.

With the experimental engine **off**, macros still resolve but the following fall back to the legacy regex pipeline and stop working:

| Feature | Requires experimental engine |
|---|---|
| <span v-pre>`{{if}}`</span> / <span v-pre>`{{else}}`</span> / <span v-pre>`{{each}}`</span> control flow | ✓ |
| Scoped macros like <span v-pre>`{{setvar::k}}body{{/setvar}}`</span> | ✓ |
| Variable shorthand (<span v-pre>`{{.var}}`</span>, <span v-pre>`{{$var}}`</span>, expressions) | ✓ |
| Flags (`#`, `/`, …) | ✓ |
| Nested macros inside macro arguments | ✓ |
| Leading-whitespace preservation inside scoped bodies | ✓ |
| Stable substitution order across passes | ✓ |
| Plain <span v-pre>`{{user}}`</span>, <span v-pre>`{{setvar::name::value}}`</span>, <span v-pre>`{{time}}`</span>, … | works either way |

If a feature on this page seems not to work, check this setting first.

## Syntax

A macro looks like <span v-pre>`{{name}}`</span>, <span v-pre>`{{name::arg}}`</span>, or <span v-pre>`{{name::arg1::arg2}}`</span>. Macro names are **case-insensitive** — <span v-pre>`{{user}}`</span>, <span v-pre>`{{User}}`</span>, and <span v-pre>`{{USER}}`</span> all resolve to the same macro. Whitespace between the braces and the name is allowed: <span v-pre>`{{ user }}`</span> works the same as <span v-pre>`{{user}}`</span>.

Macro identifiers must match `^[a-zA-Z][\w-_]*$` — start with a letter, then word characters, underscores, or hyphens. The only exception is the comment macro <span v-pre>`{{//}}`</span>.

### Arguments

Separate positional arguments with `::`:

```text
{{setvar::hp::50}}
{{datetimeformat::YYYY-MM-DD HH:mm:ss}}
{{roll::3d6+4}}
```

A single `:` is accepted as a fallback (<span v-pre>`{{roll: 1d20}}`</span>) but `::` is the preferred form because real content frequently contains single colons.

For comma-style list macros (<span v-pre>`{{random}}`</span>, <span v-pre>`{{pick}}`</span>), either form is accepted:

```text
{{random::red::green::blue}}
{{random::red,green,blue}}
```

If you need a literal comma inside a list item, escape it as `\,`.

### Nested macros

Macros nest. Inner macros are resolved first, and the result becomes the argument of the outer macro:

```text
{{setvar::greeting::Hello, {{user}}!}}
{{if {{getvar::showHeader}}}}# Header{{/if}}
{{each::{{getvar::roster}}}}- {{loop_value::name}}{{/each}}
```

There is no nesting depth limit beyond the recursion budget of the parser, but very deep trees are a sign the macro is doing too much — break it up with intermediate variables.

### Scoped macros

Some macros (<span v-pre>`{{if}}`</span>, <span v-pre>`{{each}}`</span>, <span v-pre>`{{trim}}`</span>, <span v-pre>`{{//}}`</span>, and most user-registered macros that accept arguments) accept a body of content between an opening and a closing tag. The body becomes the **last positional argument**:

```text
{{if .ready}}
The character is ready.
{{/if}}

{{each::npcs}}
- {{loop_key}}: {{loop_value::hp}} HP
{{/each}}
```

By default, scoped bodies are **auto-trimmed and dedented** — leading and trailing whitespace is removed, and the common leading indent of the first non-empty line is stripped from every line. To preserve everything verbatim, add the `#` flag:

```text
{{#trim}}
   exact   spaces   preserved
{{/trim}}
```

### Escaping

To emit a literal pair of braces, prefix with a backslash:

```text
\{{not a macro}}
```

The backslash is stripped during post-processing and the raw <span v-pre>`{{...}}`</span> reaches the AI unchanged. This is the supported way to *teach* the model macro syntax inside a prompt without accidentally executing the example on every assembly.

### Legacy tags

Five non-curly tags from very old SillyTavern character cards are auto-rewritten to their macro equivalents before resolution:

| Legacy | Modern equivalent |
|---|---|
| `<USER>` | <span v-pre>`{{user}}`</span> |
| `<BOT>` / `<CHAR>` | <span v-pre>`{{char}}`</span> |
| `<GROUP>` / `<CHARIFNOTGROUP>` | <span v-pre>`{{group}}`</span> / <span v-pre>`{{charIfNotGroup}}`</span> |

Use the curly form in new content. The legacy tags exist for backward compatibility.

The form <span v-pre>`{{time_UTC+N}}`</span> is also rewritten to <span v-pre>`{{time::UTC+N}}`</span>.

## Variable shorthand

In addition to the verbose <span v-pre>`{{getvar::name}}`</span> / <span v-pre>`{{setvar::name::value}}`</span> macros, Luker provides a compact **variable expression** syntax that reads like an assignment:

| Form | Meaning | Returns |
|---|---|---|
| <span v-pre>`{{.name}}`</span> | Read **local** variable | Current value |
| <span v-pre>`{{$name}}`</span> | Read **global** variable | Current value |
| <span v-pre>`{{.name = 5}}`</span> | Set | `''` (empty) |
| <span v-pre>`{{.name += 1}}`</span> | Add (numeric add or string append) | `''` |
| <span v-pre>`{{.name -= 1}}`</span> | Subtract (numeric only; warns otherwise) | `''` |
| <span v-pre>`{{.name++}}`</span> | Increment | `''` |
| <span v-pre>`{{.name--}}`</span> | Decrement | `''` |
| <span v-pre>`{{.name ?? "default"}}`</span> | Value, or default if **undefined** | Value or default |
| <span v-pre>`{{.name &#124;&#124; "default"}}`</span> | Value, or default if **falsy** | Value or default |
| <span v-pre>`{{.name ??= "x"}}`</span> | Set only if undefined | New value |
| <span v-pre>`{{.name &#124;&#124;= "x"}}`</span> | Set only if falsy | New value |
| <span v-pre>`{{.name == 5}}`</span> | String equality | `"true"` / `"false"` |
| <span v-pre>`{{.name != 5}}`</span> | String inequality | `"true"` / `"false"` |
| <span v-pre>`{{.name > 5}}`</span> | Numeric `>` | `"true"` / `"false"` |
| <span v-pre>`{{.name >= 5}}`</span> | Numeric `>=` | `"true"` / `"false"` |
| <span v-pre>`{{.name < 5}}`</span> | Numeric `<` | `"true"` / `"false"` |
| <span v-pre>`{{.name <= 5}}`</span> | Numeric `<=` | `"true"` / `"false"` |

`.` always means a chat-local variable, `$` always means a global variable. The two scopes don't share names.

Variable expressions compose with control flow:

```text
{{if .hp <= 0}}
You die.
{{else}}
You have {{.hp}} HP left.
{{/if}}
```

Names in variable expressions accept hyphens and underscores but must end with a word character: `my-var` is valid, `my-` is not (that would clash with the `--` decrement operator).

::: tip Lazy fallback evaluation
The `??` and `||` operators only evaluate the fallback expression when the variable is missing / falsy. Use this to skip expensive defaults: <span v-pre>`{{.cachedSummary ?? {{summary}}}}`</span> only calls <span v-pre>`{{summary}}`</span> on a cache miss.
:::

## Control flow

### Conditionals — <span v-pre>`{{if}}`</span> / <span v-pre>`{{else}}`</span>

```text
{{if condition}}then-content{{/if}}
{{if condition}}then{{else}}otherwise{{/if}}
{{if !condition}}negated{{/if}}
```

The condition can be:

- A literal value — empty string, `false`, `off`, `0` are falsy; anything else is truthy.
- A registered macro name without braces — <span v-pre>`{{if description}}# Description{{/if}}`</span> resolves `description` first.
- A nested macro — <span v-pre>`{{if {{getvar::showHeader}}}}...{{/if}}`</span>.
- A variable shorthand — <span v-pre>`{{if .ready}}`</span>, <span v-pre>`{{if $debugFlag}}`</span>.
- A variable expression — <span v-pre>`{{if .hp > 0}}`</span>.
- A `!`-prefixed inversion of any of the above — <span v-pre>`{{if !.dead}}`</span>.

::: tip Lazy branch evaluation
Only the chosen branch resolves its nested macros. <span v-pre>`{{if .casting}}{{.mana -= 10}}{{/if}}`</span> will not subtract mana when `.casting` is false. <span v-pre>`{{if}}`</span> is safe to wrap around expensive or side-effectful inner macros.
:::

### Iteration — <span v-pre>`{{each}}`</span>

```text
{{each::collection}}
{{loop_key}}: {{loop_value}}
{{/each}}
```

`collection` accepts three forms:

1. An inline JSON literal — <span v-pre>`{{each::["sword","shield"]}}`</span> or <span v-pre>`{{each::{"a":1,"b":2}}}`</span>.
2. A variable name — <span v-pre>`{{each::npcs}}`</span> reads the local variable `npcs` (and falls back to global) and parses its JSON.
3. A nested macro that resolves to a collection — <span v-pre>`{{each::{{getglobalvar::roster}}}}`</span>.

Inside the body:

| Macro | Meaning |
|---|---|
| <span v-pre>`{{loop_key}}`</span> | Current key (or array index as a string) |
| <span v-pre>`{{loop_value}}`</span> | Whole value (objects auto-JSON-stringify) |
| <span v-pre>`{{loop_value::field}}`</span> | Drill into the value, same dotted-path semantics as <span v-pre>`{{getvar}}`</span> |

Nested <span v-pre>`{{each}}`</span> blocks naturally shadow `loop_key` / `loop_value` for the inner scope. Object iteration order is JavaScript native — insertion order for string keys, ascending for integer-like keys.

Empty or non-iterable collections render to an empty string. There is no built-in iteration cap — a body that re-enters <span v-pre>`{{each}}`</span> on the same collection is your responsibility.

### Comments — <span v-pre>`{{//}}`</span>

Inline:

```text
{{// this line is ignored}}
```

Scoped:

```text
{{//}}
Multi-line comment.
Free to contain {{macros}} and \{escapes\} — none of it runs.
{{///}}
```

Comments resolve to an empty string and consume their content verbatim. Useful for annotating prompt entries that the AI shouldn't see.

## Variables

Variables come in two scopes:

- **Local** — keyed per chat, stored in `chat_metadata.variables`. Use for chat-specific state (HP, current quest, turn count).
- **Global** — shared across all chats, stored in extension settings. Use for cross-chat counters or plugin config.

### Reading

| Macro | Variable shorthand | Purpose |
|---|---|---|
| <span v-pre>`{{getvar::name}}`</span> | <span v-pre>`{{.name}}`</span> | Read local |
| <span v-pre>`{{getglobalvar::name}}`</span> | <span v-pre>`{{$name}}`</span> | Read global |
| <span v-pre>`{{hasvar::name}}`</span> (alias `varexists`) | — | `"true"` / `"false"` |
| <span v-pre>`{{hasglobalvar::name}}`</span> (alias `globalvarexists`) | — | `"true"` / `"false"` |

Missing variables produce the empty string.

### Writing

| Macro | Variable shorthand | Purpose |
|---|---|---|
| <span v-pre>`{{setvar::name::value}}`</span> | <span v-pre>`{{.name = value}}`</span> | Set local |
| <span v-pre>`{{addvar::name::value}}`</span> | <span v-pre>`{{.name += value}}`</span> | Add (numeric) / append (string) / push (JSON array) |
| <span v-pre>`{{incvar::name}}`</span> | <span v-pre>`{{.name++}}`</span> | +1 |
| <span v-pre>`{{decvar::name}}`</span> | <span v-pre>`{{.name--}}`</span> | -1 |
| <span v-pre>`{{deletevar::name}}`</span> (alias `flushvar`) | — | Remove |

`setglobalvar` / `addglobalvar` / `incglobalvar` / `decglobalvar` / `deleteglobalvar` are the global-scope equivalents.

`addvar` is overloaded: when both sides parse as numbers, it does numeric addition; when the existing value is a JSON array, it pushes; otherwise it concatenates as strings.

::: tip Anchor whitespace with <code v-pre>{{noop}}</code>
String concat, scoped bodies, `+= "  text"` and similar contexts often have leading or trailing whitespace stripped by the engine's auto-trim or argument trimming. Insert a <code v-pre>{{noop}}</code> (resolves to the empty string) next to the whitespace you need to keep — e.g. <code v-pre>{{addvar::story::{{noop}}  This is the new paragraph.}}</code>.
:::

### Dotted paths for structured values

A variable can hold any JSON-serializable value. When a variable's value is a JSON-stringified object or array, dotted-path reads work out of the box:

```text
{{setvar::npcs::{"alice":{"hp":40},"bob":{"hp":30}}}}
{{getvar::npcs.alice.hp}}    → 40
{{getvar::npcs.alice}}        → {"hp":40}
{{getvar::list.0}}            → first element of `list`
```

Path lookups against non-JSON values fall back to a literal flat-key lookup, so a variable literally named `a.b` still works.

This pairs naturally with <span v-pre>`{{each}}`</span>: an NPC roster, an inventory dict, or a quest journal can live in a single variable and be rendered into the prompt or a world book entry on each pass.

```text
{{each::npcs}}
- {{loop_key}}: {{loop_value::hp}} HP
{{/each}}
```

### Per-message (floor) variables {#per-message-variables}

In stock SillyTavern, side-effect macros like <span v-pre>`{{setvar::hp::50}}`</span> only run when they appear in a *prompt template* — preset, world info, or the very first message. When the AI writes the same literal in its reply, it does nothing and shows up verbatim in the chat.

Luker fixes this with **per-message variable extraction**. When a message (AI reply, user message, swipe, continue) is saved, Luker:

1. Scans the text for <span v-pre>`{{setvar}}`</span>, <span v-pre>`{{addvar}}`</span>, <span v-pre>`{{incvar}}`</span>, <span v-pre>`{{decvar}}`</span>, <span v-pre>`{{deletevar}}`</span>.
2. Resolves any nested display macros (<span v-pre>`{{user}}`</span>, <span v-pre>`{{getvar::other}}`</span>, <span v-pre>`{{time}}`</span>, …) against the current state.
3. Applies the op to `chat_metadata.variables` immediately.
4. Records a structured op on `message.extra.var_ops`.
5. Strips the literal from the visible text.

When you delete a message, switch swipes, regenerate, or edit, Luker **replays the surviving op log** so your variables stay consistent with the visible timeline.

This is what the **Per-Message Variables** UI surfaces — a flask icon on every message with extracted ops, opening an editor where you can inspect, edit, delete, or add ops. The result is that the AI can own and mutate state directly through its replies, and that state survives all the chat-structure operations users routinely perform.

See [Per-Message Variables](/features/variable-op-log) for the full feature page (replay semantics, swipe lifecycle, the op editor, and recommended authoring patterns).

::: warning Global variables are not extracted
<span v-pre>`{{setglobalvar}}`</span> and the rest of the global family are not on the per-message extraction list — global state is cross-chat and is not tied to a specific message in the log. They keep stock SillyTavern semantics.
:::

## Built-in catalog

`/? macros` opens an in-app browser with the same descriptions, search, and live signatures.

### Names & participants

| Macro | Returns |
|---|---|
| <span v-pre>`{{user}}`</span> | Current persona name |
| <span v-pre>`{{char}}`</span> | Current character name |
| <span v-pre>`{{group}}`</span> (alias `charIfNotGroup`) | Comma-separated group members, or char name in solo |
| <span v-pre>`{{groupNotMuted}}`</span> | Same as `group` minus muted members |
| <span v-pre>`{{notChar}}`</span> | All participants except the current speaker |

### Character card fields

| Macro | Returns |
|---|---|
| <span v-pre>`{{charDescription}}`</span> (alias `description`) | Description field |
| <span v-pre>`{{charPersonality}}`</span> (alias `personality`) | Personality field |
| <span v-pre>`{{charScenario}}`</span> (alias `scenario`) | Scenario field |
| <span v-pre>`{{persona}}`</span> | Current persona description |
| <span v-pre>`{{charPrompt}}`</span> | Main Prompt override |
| <span v-pre>`{{charInstruction}}`</span> | Post-History Instructions override |
| <span v-pre>`{{charDepthPrompt}}`</span> | @ Depth Note |
| <span v-pre>`{{charCreatorNotes}}`</span> (alias `creatorNotes`) | Creator notes |
| <span v-pre>`{{charVersion}}`</span> | Card version string |
| <span v-pre>`{{charFirstMessage}}`</span> (alias `greeting`) | Main greeting (index 0) |
| <span v-pre>`{{greeting::N}}`</span> | Greeting at index N — 0 is the main, 1+ are alt greetings |
| <span v-pre>`{{mesExamples}}`</span> | Dialogue examples, formatted for instruct mode when enabled |
| <span v-pre>`{{mesExamplesRaw}}`</span> | Dialogue examples, raw |
| <span v-pre>`{{original}}`</span> | Original prompt content inside a character-level override. **One-shot per pass** — second call in the same substitution returns `""`. Meaningful inside `charPrompt` / `charInstruction`. |

### Chat state

| Macro | Returns |
|---|---|
| <span v-pre>`{{lastMessage}}`</span> | Text of the last message |
| <span v-pre>`{{lastMessageId}}`</span> | Index of the last message |
| <span v-pre>`{{lastUserMessage}}`</span> | Text of the last user message |
| <span v-pre>`{{lastCharMessage}}`</span> | Text of the last character message |
| <span v-pre>`{{firstIncludedMessageId}}`</span> | Index of the first message in the current context window |
| <span v-pre>`{{firstDisplayedMessageId}}`</span> | Index of the first visible message in the chat scroll area |
| <span v-pre>`{{lastSwipeId}}`</span> | 1-based count of swipes on the last message |
| <span v-pre>`{{currentSwipeId}}`</span> | 1-based index of the active swipe |
| <span v-pre>`{{allChatRange}}`</span> | Range string like `0-12`, or empty if the chat is empty |
| <span v-pre>`{{idleDuration}}`</span> (alias `idle_duration`) | Human-readable time since the last user message |
| <span v-pre>`{{lastGenerationType}}`</span> | `normal` / `impersonate` / `regenerate` / `quiet` / `swipe` / `continue` |

### Time & date

| Macro | Returns |
|---|---|
| <span v-pre>`{{time}}`</span> | Local time (locale-formatted short time, e.g. `3:45 PM`) |
| <span v-pre>`{{time::UTC+2}}`</span> | Local time at a UTC offset |
| <span v-pre>`{{date}}`</span> | Local date (locale-formatted long date) |
| <span v-pre>`{{weekday}}`</span> | Day name (`Monday`, …) |
| <span v-pre>`{{isotime}}`</span> | `HH:mm` |
| <span v-pre>`{{isodate}}`</span> | `YYYY-MM-DD` |
| <span v-pre>`{{datetimeformat::FORMAT}}`</span> | Current time using a moment.js format string |
| <span v-pre>`{{timeDiff::A::B}}`</span> | Human-readable absolute difference between two times |

### Variables

See the [Variables](#variables) section above for the full list.

### Control flow & utilities

| Macro | Returns |
|---|---|
| <span v-pre>`{{if cond}}…{{/if}}`</span> | Conditional content |
| <span v-pre>`{{else}}`</span> | Else branch marker inside <span v-pre>`{{if}}`</span> |
| <span v-pre>`{{each::col}}…{{/each}}`</span> | Iteration |
| <span v-pre>`{{loop_key}}`</span> / <span v-pre>`{{loop_value}}`</span> / <span v-pre>`{{loop_value::path}}`</span> | Inside <span v-pre>`{{each}}`</span> |
| <span v-pre>`{{trim}}`</span> | Inline: trims surrounding newlines in post-processing. Scoped: returns trimmed content |
| <span v-pre>`{{newline}}`</span> / <span v-pre>`{{newline::N}}`</span> | Insert one or N newlines |
| <span v-pre>`{{space}}`</span> / <span v-pre>`{{space::N}}`</span> | Insert one or N spaces |
| <span v-pre>`{{noop}}`</span> | Empty string. Useful as a whitespace anchor in concat / scoped contexts |
| <span v-pre>`{{reverse::text}}`</span> | Reversed string |
| <span v-pre>`{{//comment}}`</span> (alias `comment`) | Comment (empty output) |

### Randomness

| Macro | Returns |
|---|---|
| <span v-pre>`{{roll::1d20}}`</span> | Dice roll using droll syntax (`1d6`, `3d6+4`, …). A plain integer `N` is treated as `1dN`. Re-rolls on every render. |
| <span v-pre>`{{random::red::green::blue}}`</span> | Random element. Re-rolls on every render. |
| <span v-pre>`{{pick::red::green::blue}}`</span> | Random element, **stable** per chat + macro position. Seed = chat hash + content hash + position + reroll seed. Reset with `/reroll-pick`. |

### Environment & API

| Macro | Returns |
|---|---|
| <span v-pre>`{{model}}`</span> | Active model identifier |
| <span v-pre>`{{maxPrompt}}`</span> (alias `maxPromptTokens`) | Max prompt context tokens |
| <span v-pre>`{{maxContext}}`</span> (alias `maxContextTokens`) | Max context tokens |
| <span v-pre>`{{maxResponse}}`</span> (alias `maxResponseTokens`) | Max response tokens |
| <span v-pre>`{{isMobile}}`</span> | `"true"` on mobile clients |
| <span v-pre>`{{hasExtension::name}}`</span> | `"true"` if a given extension is loaded **and** enabled |
| <span v-pre>`{{input}}`</span> | Current contents of the send textarea |
| <span v-pre>`{{outlet::key}}`</span> | World info outlet content for the given key |
| <span v-pre>`{{banned::word}}`</span> | Adds a banned word for Text Completion backends; returns empty |

### Author's note & summary

| Macro | Returns |
|---|---|
| <span v-pre>`{{authorsNote}}`</span> | Effective author's note text for the current chat |
| <span v-pre>`{{charAuthorsNote}}`</span> | Character-scoped author's note |
| <span v-pre>`{{defaultAuthorsNote}}`</span> | Configured default author's note |
| <span v-pre>`{{summary}}`</span> | Chat summary — only registered when the Summarize extension is loaded |

### Reasoning template

| Macro | Returns |
|---|---|
| <span v-pre>`{{reasoningPrefix}}`</span> | Reasoning section prefix |
| <span v-pre>`{{reasoningSuffix}}`</span> | Reasoning section suffix |
| <span v-pre>`{{reasoningSeparator}}`</span> | Separator between reasoning and answer |

### Instruct & system prompts

These macros only return content when the relevant instruct / system-prompt features are enabled.

| Macro | Returns |
|---|---|
| <span v-pre>`{{systemPrompt}}`</span> | Active system prompt. Switches to <span v-pre>`{{charPrompt}}`</span> when **Prefer Character Prompt** is on. |
| <span v-pre>`{{defaultSystemPrompt}}`</span> (aliases `instructSystem`, `instructSystemPrompt`) | Configured default system prompt |
| <span v-pre>`{{instructStoryStringPrefix}}`</span> / <span v-pre>`{{instructStoryStringSuffix}}`</span> | Story string wrappers |
| <span v-pre>`{{instructUserPrefix}}`</span> (alias `instructInput`) / <span v-pre>`{{instructUserSuffix}}`</span> | User turn sequences |
| <span v-pre>`{{instructAssistantPrefix}}`</span> (alias `instructOutput`) / <span v-pre>`{{instructAssistantSuffix}}`</span> (alias `instructSeparator`) | Assistant turn sequences |
| <span v-pre>`{{instructFirstAssistantPrefix}}`</span> (alias `instructFirstOutputPrefix`) / <span v-pre>`{{instructLastAssistantPrefix}}`</span> (alias `instructLastOutputPrefix`) | First / last variants |
| <span v-pre>`{{instructFirstUserPrefix}}`</span> (alias `instructFirstInput`) / <span v-pre>`{{instructLastUserPrefix}}`</span> (alias `instructLastInput`) | First / last variants |
| <span v-pre>`{{instructSystemPrefix}}`</span> / <span v-pre>`{{instructSystemSuffix}}`</span> | System turn sequences |
| <span v-pre>`{{instructSystemInstructionPrefix}}`</span> | Last-system sequence |
| <span v-pre>`{{instructStop}}`</span> | Stop sequence |
| <span v-pre>`{{instructUserFiller}}`</span> | Alignment filler |
| <span v-pre>`{{exampleSeparator}}`</span> (alias `chatSeparator`) / <span v-pre>`{{chatStart}}`</span> | Context template markers |

### Extension-provided

Only present when the named extension is installed and enabled:

| Macro | Source | Returns |
|---|---|---|
| <span v-pre>`{{charPrefix}}`</span> | Stable Diffusion | Positive image-gen prompt prefix |
| <span v-pre>`{{charNegativePrefix}}`</span> | Stable Diffusion | Negative image-gen prompt prefix |
| <span v-pre>`{{summary}}`</span> | Summarize | Stored chat summary |

Third-party extensions may register additional macros; the macro browser flags each one's source.

## Flags

Flags are single characters placed between the opening <code v-pre>{{</code> and the macro name. They modify how the macro is parsed or resolved.

### `/` — closing block

Marks a tag as the closing half of a scoped/block macro. Pairs with the opening tag of the same identifier and consumes the content in between:

```text
{{if .ready}} ...body... {{/if}}
{{each::npcs}} ...body... {{/each}}
{{setvar::longText}} ...body... {{/setvar}}
```

A closing tag never takes its own arguments — everything between opening and closing is folded into the opening macro's *last positional argument*.

### `#` — preserve whitespace

**Only meaningful on scoped/block macros.** By default the engine auto-trims and dedents the body before handing it to the handler (strips leading and trailing whitespace, then removes the common leading indent of the first non-empty line from every line). The `#` flag suppresses that behavior so the body is passed through verbatim:

```text
{{#if .verbose}}
    every space, including this 4-space indent,
    is preserved exactly as written.
{{/if}}
```

The flag also doubles as backward compatibility for the old Handlebars-style <code v-pre>{{#if …}}</code> writing — that syntax still works today and is equivalent to <code v-pre>{{if …}}</code> with auto-trim disabled.

On non-scoped macros the flag is accepted but has no behavioral effect.

### `!` `?` `~` `>` — reserved

| Flag | Intended meaning | Status |
|---|---|---|
| `!` | Resolve before other macros in the same text | Parsed only |
| `?` | Resolve after other macros | Parsed only |
| `~` | Mark for re-evaluation | Parsed only |
| `>` | Treat `\|` as an output-filter pipe | Parsed only (see *Pipe* below) |

These tokens are recognized by the parser today but no runtime hook consumes them, so they have no effect on output. The lone `!` in <code v-pre>{{if !.dead}}</code> is a separate construct — it's *condition negation* inside <code v-pre>{{if}}</code>, not the flag.

Flags can be combined and whitespace between flag and name is allowed: <code v-pre>{{ #each ::list}} … {{/each}}</code>.

### `|` — pipe (argument terminator)

The pipe character is special inside macro arguments **even without the `>` flag**. The lexer transitions out of argument mode when it sees `\|`, so:

```text
{{getvar::name|filter}}
```

…parses as the macro `getvar` with the single argument `name` followed by a "filter" identifier `filter`. The filter handler isn't wired up yet, so the filter name is discarded and the macro behaves as <code v-pre>{{getvar::name}}</code>. The practical implication is that **a literal `\|` inside an argument terminates that argument** — to keep `\|` as part of the value, escape it as `\|`:

```text
{{setvar::menu::sword \| shield \| bow}}
```

::: warning Pipe is reserved
Today, writing <code v-pre>{{macro\|uppercase}}</code> does **not** uppercase anything — it just parses without error, drops the filter name, and runs the macro on the args before the pipe. If you need string transforms, register a custom macro or use a regex extension. The pipe-filter chain itself is reserved for a future engine version.
:::

## Slash command pipes — <code v-pre>{{pipe}}</code>, <code v-pre>{{var::name}}</code>

Inside a **slash command closure** (STscript — `/command1 | /command2 | …` chains, Quick Replies, and similar), two extra macros are bound by the slash-command scope:

| Macro | Scope | Meaning |
|---|---|---|
| <code v-pre>{{pipe}}</code> | Slash command closure | The output of the previous command in the pipe chain |
| <code v-pre>{{var::name}}</code> | Slash command closure | A closure-scope variable created with `/let` / `/var`. **Different** from chat variables (which are accessed via <code v-pre>{{getvar::name}}</code>) |

Both only exist inside the slash command parser. Outside an STscript context they render literally (no closure to bind them to).

The `\|` character is also the slash command pipe operator at the STscript level — that's a feature of the command parser, not the macro engine. Inside a single macro's args, `\|` follows the *macro* pipe rule described above.

## Resolution semantics

The engine walks each text fragment once and resolves macros left to right.

- **Nested macros** resolve before their parent is called. The parent sees fully-resolved string arguments unless the macro definition opts into `delayArgResolution` (currently <span v-pre>`{{if}}`</span> and <span v-pre>`{{each}}`</span> only).
- **Side-effect macros** (<span v-pre>`{{setvar}}`</span>, <span v-pre>`{{addvar}}`</span>, <span v-pre>`{{incvar}}`</span>, <span v-pre>`{{decvar}}`</span>, <span v-pre>`{{deletevar}}`</span>) apply immediately, so a later macro in the same pass sees the new value.
- **Per-message extraction** (see [Per-Message Variables](#per-message-variables)) happens **at message save time**, not at prompt-build time.
- **Unknown macros** render as the raw <span v-pre>`{{...}}`</span> text (with nested arguments still resolved). No exception, no warning by default.
- **Argument arity / type mismatches** with the default `strictArgs: true` log a runtime warning and emit the raw macro text; with `strictArgs: false` they emit a warning but the handler still runs.
- **Result normalization** — every handler return is normalized: `null` / `undefined` → `''`, `Date` → ISO string, arrays / objects → `JSON.stringify(...)`, everything else → `String(...)`. That's why <span v-pre>`{{loop_value}}`</span> on an object renders as JSON.
- **Comment stripping** — orphan <span v-pre>`{{trim}}`</span> markers and stray `else` sentinels left behind by partial parses are cleaned up in a post-processing pass.

## Custom & plugin-registered macros

Extensions can register their own macros:

```js
const ctx = Luker.getContext();

ctx.macros.register('myStatus', {
    description: 'Returns the plugin status string.',
    category: 'utility',
    handler: () => 'My plugin is active.',
});

ctx.macros.register('greet', {
    description: 'Greets a name.',
    unnamedArgs: [
        { name: 'name', type: 'string', description: 'Person to greet' },
    ],
    handler: (mctx) => `Hello, ${mctx.unnamedArgs[0]}!`,
});
```

After registration both <span v-pre>`{{myStatus}}`</span> and <span v-pre>`{{greet::Bob}}`</span> are available everywhere a macro is, including world info, presets, and chat messages.

The full registration surface — argument typing, aliases, scoped macros, lazy resolution, `dynamicMacros` for one-off injection — is in [Extension API › Macros & Variables](/development/extension-api/macros-and-variables).

## Discovery & debugging

- Type <code v-pre>{{</code> in any field that resolves macros to trigger autocomplete. Press **Ctrl+Space** to invoke it anywhere.
- Enable autocomplete in all fields under **Settings → AutoComplete Settings → Show in all macro fields**.
- Run `/? macros` (or `/? macro` / `/? 4`) to open the **Macro Browser** — a searchable popup listing every registered macro, its category, aliases, arguments, return type, examples, and source (core / extension / third-party).
- Run `/reroll-pick` to reset all <span v-pre>`{{pick}}`</span> outcomes in the current chat. Pass a specific seed (`/reroll-pick mySeed`) for reproducibility.

## Where macros are resolved

Every text field that flows through the prompt pipeline:

- Character card fields (description, personality, scenario, first message, alt greetings, dialogue examples, @ Depth Note, character prompts)
- World info entry content, keys, and headers
- Preset prompt entries
- Author's note
- Chat messages (user and AI), with per-message variable extraction
- Slash command arguments and Quick Reply scripts
- Regex extension replacements
- Macro arguments themselves (nesting)

A field that takes literal text and never reaches the model — a connection profile's API URL, for instance — does **not** resolve macros. When in doubt, drop in <span v-pre>`{{date}}`</span>: if it renders as literal <span v-pre>`{{date}}`</span>, the field doesn't run macros.

## Common patterns

### Conditional sections in a preset

```text
{{if .difficulty == "hard"}}
The world is unforgiving. Failure is permanent.
{{else}}
The world is forgiving. Death is a setback, not an end.
{{/if}}
```

### Counter that survives swipes and deletes

In a character's `first_mes` or in an alt greeting, seed the variable:

```text
{{setvar::turn::0}}
```

In the AI's reply (set up via a world book entry that instructs the model), let the AI increment it:

```text
{{incvar::turn}}
```

Because per-message extraction strips the literal and records the op, the user sees clean narrative and the variable still increments. Deleting that message reverses the op on replay.

### Stable random choice for a chat

```text
{{pick::a tavern brawl::a quiet evening::an unexpected guest}}
```

Once rolled, the choice stays fixed for that chat at that macro position — useful for "today's mood" style randomness that should not flicker on re-render.

### Render a structured collection

```text
# Active quests
{{each::quests}}{{if {{loop_value::status}} == "active"}}
- {{loop_value::name}}
{{/if}}{{/each}}
```

The AI maintains `quests` with <span v-pre>`{{setvar::quests::…}}`</span> in its replies; the world book entry above lays them out on each turn.

### Author's note that adapts to a flag

```text
{{if $debug_verbose}}
[narrative voice: be especially explicit about reasoning]
{{/if}}
```

A global flag toggled from a Quick Reply or slash command becomes an opt-in instruction shipped only when wanted.

## Reference

- [Per-Message Variables](/features/variable-op-log) — the floor-variable feature in depth.
- [Extension API › Macros & Variables](/development/extension-api/macros-and-variables) — registering custom macros from plugins.
- [World Info](/basics/world-info) — where most prompt-side macros end up living.
- [Presets](/basics/presets) — the other place prompt-side macros live.
