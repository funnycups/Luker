# Iteration Library

`context.iterationLibrary` provides shared building blocks for AI-driven iterative editing surfaces: LLM tool-call runners, message and diff rendering, zoom overlays, ProposalBus for reviewing proposed changes, and plugin-agnostic lorebook, skill, preset and discovery tool helpers.

To integrate an AI-editable target directly into Luker's unified **Workbench → AI iteration** tab, register an `IterateTarget` through [`context.workbench.registerIterateTarget`](/development/extension-api/workbench#registering-an-ai-iteration-target). Use `context.iterationLibrary` directly when you own a standalone popup or full-viewport editor such as CardApp Studio.

## Access

```js
// Layer 1 — ESM import
import { runner, ui, proposalBus } from '/scripts/iteration-library/index.js';

// Layer 2 — lukerContext
const { runner, ui, proposalBus } = lukerContext.iterationLibrary;

// Layer 3 — getContext()
const { runner, ui, proposalBus } = Luker.getContext().iterationLibrary;
```

`iterationLibrary` is a frozen object; Layer 2 and Layer 3 return the same object.

| Member | Type | Purpose |
| --- | --- | --- |
| `applyEdits`, `inverseEdit`, `registerOp`, `BUILT_IN_OPS`, `showConflictResolution` | function / array | [Edits Library](./edits-lib.md) |
| `render` | namespace | Markdown rendering of message bodies |
| `runner` | namespace | Tool-call request driver, stored tool-call messages, abort helpers |
| `textDiff` | namespace | Side-by-side text diff |
| `zoomOverlay` | namespace | Fullscreen view and column resizing of text diffs |
| `ui` | namespace | Message cards, diff cards, shared stylesheet |
| `tools` | namespace | Shared tool catalogs and executors |
| `proposalBus` | namespace | ProposalBus factory and kind descriptors |
| `bindIterWorkspaceResizer` | function | Draggable split of the two-column workspace |

The ESM entry also exports `createRenderScheduler`. Importing `/scripts/iteration-library/index.js` loads every namespace; a module that needs a single helper imports that helper's file instead, for example `/scripts/iteration-library/text-diff.js`.

Members whose names start with `_` reset module caches for unit tests and are not part of the runtime contract.

## Edits

`applyEdits(edits, live)`, `inverseEdit(edit)`, `registerOp(name, handler)`, `BUILT_IN_OPS` and `showConflictResolution(conflicts, opts)` are the [Edits Library](./edits-lib.md) functions, re-exported so a studio reaches everything through one object.

## render

| Member | Signature | Behavior |
| --- | --- | --- |
| `ensureMarkdownDeps` | `() => Promise<boolean>` | Loads the markdown converter and the HTML sanitizer once. Resolves `true` when both are ready, `false` when loading failed. |
| `renderMessageMarkdown` | `(text) => string` | Returns sanitized HTML. Until `ensureMarkdownDeps` has resolved it returns HTML-escaped text and starts loading. |

## runner

### `requestToolCallsWithRetry(context, settings, options)`

Sends one request through `context.generateTask`, or through `context.generateTaskStream` when `context.isStreamingPresetEnabled(llmPresetName)` is true, validates the returned tool calls against the tool schemas, and retries failed attempts.

- `context` — the object returned by `Luker.getContext()`.
- `settings` — read for `toolCallRetryMax`, the number of retries, and `rpmLimit`, the requests-per-minute limit. A missing `toolCallRetryMax` means no retry; the retry count has no upper bound. `rpmLimit: 0` disables the limit.

| Option | Default | Purpose |
| --- | --- | --- |
| `tools` | — | Required non-empty array of OpenAI-style function definitions |
| `taskMessages` | `[]` | Chat-completion messages sent as the task |
| `apiPresetName` | `''` | Connection profile; empty uses the current connection |
| `llmPresetName` | `''` | Chat-completion preset; empty uses the current preset |
| `runtimeWorldInfo` | `null` | Pre-resolved world info passed to `generateTask` |
| `allowedNames` | `null` | Array or `Set`; when non-empty, calls with other names are dropped |
| `retriesOverride` | `null` | Replaces `settings.toolCallRetryMax` |
| `abortSignal` | `null` | Aborts the request; an aborted attempt rejects without retrying |
| `includeAssistantText` | `false` | Resolve to the object form described below |
| `allowNoToolCalls` | `false` | Accept a reply that has text but no matching tool call |
| `allowEmptyResponse` | `false` | Accept any reply without a matching tool call, with or without text |
| `substituteMacros` | `false` | Substitute macros in the task messages; studios that edit macro-bearing source text leave it off |
| `toolChoice` | `'auto'` | Tool choice sent to the provider |
| `requiredFunctionName` | `''` | Function the provider is asked to call |
| `reservedToolCallIds` | `null` | Iterable of tool-call ids the session already uses. When set, a returned call whose id is reserved, appears in `taskMessages` or repeats within the reply receives a fresh id. |
| `rpmBucket` | `'default'` | Requests-per-minute window; callers passing the same key share one window |
| `logLabel` | `'orchestrator'` | Prefix of retry warnings |
| `isControlCall` | `null` | `(call) => boolean`; matching calls go to `onControlCall` |
| `onToolCall` | `null` | `(call)`, once per non-control call, in order |
| `onControlCall` | `null` | `(call)`, once per control call |
| `onAssistantText` | `null` | `(text)`, once per successful attempt with non-empty text |
| `onUsage` | `null` | `(usage)`, with the provider's token usage |
| `onFirstChunk` | `null` | `()`, once per attempt on the first streamed chunk |

Callbacks run after validation and before the promise resolves. A callback that throws is logged and does not fail the request.

The promise resolves to an array of `{ name, args, id, raw }`; with `includeAssistantText: true` it resolves to `{ toolCalls, assistantText, rawAssistantText, reasoning, reasoningBlocks, reasoningDetails }`. It rejects when `tools` is empty, when `context.generateTask` is missing, when the reply has no matching tool call and neither `allowNoToolCalls` nor `allowEmptyResponse` accepts it, or when validation still fails after the last retry.

### Stored tool-call messages

Studio sessions store assistant turns with OpenAI-shaped `tool_calls` and `tool_results`, so a later round replays them as chat-completion history.

| Member | Behavior |
| --- | --- |
| `buildPersistentToolCallsFromRawCalls(rawCalls = [])` | Converts runner calls `{ name, args, id }` to `{ id, type: 'function', function: { name, arguments } }`. Dots in tool names become underscores, a missing id is generated, and calls without a name are dropped. |
| `buildExecutionToolCalls(rawCalls = [])` | Same conversion, returning `{ id, name, args }` with parsed arguments. |
| `buildPendingToolResults(toolCalls = [], summaryText = '')` | Returns one `{ tool_call_id, content }` per call; `content` is the JSON of `{ ok: true, pending: true, summary }`, with `summary` defaulting to `Pending review.` |
| `createPersistentToolTurnMessage({ messageId, assistantText, toolCalls, toolResults, toolSummary, toolState, auto, at, extra })` | Builds one stored assistant message `{ id, role, content, auto, at, tool_calls, tool_results }`, plus `toolSummary` and `toolState` when they are non-empty, with the fields of `extra` merged in. `toolCalls` take the stored shape; results whose `tool_call_id` matches no call are dropped. |
| `buildPersistentToolHistoryMessages(messages = [])` | Expands stored assistant messages that carry both calls and results into history: the assistant message with `tool_calls`, then one `tool` message per result. |
| `collectIterToolCallIds(messages = [])` | `Set` of every tool-call id used by the messages, read from `toolCalls`, `tool_calls`, `toolResults` and `tool_call_id`. Pass it as `reservedToolCallIds`. |
| `makeAiIterationMessageId(prefix = 'orch_msg')` | Returns `<prefix>_<time>_<random>`. |

The Layer 1 module `/scripts/lib/iter-tool-calling.js` additionally exports:

| Member | Behavior |
| --- | --- |
| `normalizeToolCallRetryMax(value, fallback)` | Returns `fallback` for `null`, `undefined` and blank strings, otherwise the number floored and clamped at `0`; a non-numeric value returns `fallback` |
| `serializeToolResultContentPreferText(result)` | Returns `result.toolResultText` verbatim when it is a non-empty string, otherwise `result` as a string or as indented JSON |

### `runner.abortUtils`

| Member | Behavior |
| --- | --- |
| `isAbortSignalLike(value)` | `true` for an object with an `aborted` property |
| `isAbortError(error, abortSignal = null)` | `true` when the signal is aborted, the error is named `AbortError`, or the error message mentions abort |
| `isStrictAbortError(error, signal = null)` | `true` when the error is named `AbortError` or the signal is aborted; the message is not inspected |
| `createAbortError(message = 'Operation aborted.')` | A `DOMException` named `AbortError`; an `Error` with that name where `DOMException` is unavailable |
| `throwIfAborted(abortSignal, message = 'Operation aborted.')` | Throws `createAbortError(message)` when the signal is aborted |
| `linkAbortSignals(...signals)` | Returns `{ signal, cleanup }`. `signal` aborts when any input aborts; `cleanup()` removes the listeners. Without a valid input `signal` is `null`; with one input it is that signal. |
| `raceAbortSignal(promise, signal)` | Settles with `promise`, or rejects with an abort error as soon as `signal` aborts. The promise itself keeps running. |

## textDiff

| Member | Behavior |
| --- | --- |
| `renderInlineTextDiffHtml(beforeValue, afterValue, options = {})` | Returns a `<details>` block with a side-by-side line and word diff; all text is HTML-escaped. Options: `fileLabel`, the title of the fullscreen view; `i18n`, a translator; `expandAffordance: false` hides the expand button; `forceOpen: true` renders the block open. A string third argument is used as `fileLabel`. Injects the stylesheet. |
| `renderInlineTextDiffElement(beforeValue, afterValue, options = {})` | Parses the `<details>` block returned by `renderInlineTextDiffHtml` into a DOM element and returns it. Accepts the same arguments and options. |
| `ensureStylesheetInjected()` | Adds the diff stylesheet `<link>` once |
| `STYLESHEET_ID`, `STYLESHEET_HREF` | Id and URL of that `<link>` |
| `sanitizeDiffPlaceholderValue(value)` | Returns `''` for empty text and for the `Not set` placeholder in English, Simplified or Traditional Chinese; other text unchanged |
| `formatDiffValue(value)` | Same as `sanitizeDiffPlaceholderValue` |

## zoomOverlay

| Member | Behavior |
| --- | --- |
| `attachZoomOverlay(popupRoot, options = {})` | Binds delegated handlers under `popupRoot` — an element, a jQuery object or a selector; an element without an id receives one. Clicking `[data-luker-lib-action="expand-line-diff"]` opens the diff fullscreen; the close button, the backdrop and Esc close it; dragging `.luker_lib_diff_splitter` resizes the columns. `options.namespace`, default `.luker_lib_diff`, is the jQuery event namespace; binding again with the same namespace replaces the earlier binding, so each popup passes its own. `options.i18n` translates the overlay labels. Returns an unbind function. |
| `openExpandedDiff(rootElement, triggerElement, options = {})` | Opens the fullscreen view of the diff that contains `triggerElement` inside `rootElement` |

## ui

### `ui.message`

`renderMessageCard(message, opts = {})` returns the HTML of one conversation message. Message fields: `id`, `role` (`'user'`, `'assistant'` or `'system'`), `content`, `toolCalls`, `toolResults` (`{ tool_call_id, content, status }`), `edits`, `appliedAt`, `appliedTarget`, `rolledBackAt`, `auto`, and the reasoning fields `reasoning`, `reasoningBlocks`, `reasoningDetails`.

| Option | Purpose |
| --- | --- |
| `toolDisplay` | `{ [toolName]: { icon, label, type, summarize } }`. `type` is `'read'`, `'edit'` or `'control'`; `label` is the English source string, translated through `i18n` at render time; `summarize(args, result, i18n)` returns the one-line summary. |
| `renderEditCard` | `(edit, message) => html`, called for each entry of `message.edits` |
| `renderApplyControls` | `(message) => html`, placed between the edit cards and the regenerate button |
| `renderMarkdown` | `(text) => html`; without it text is escaped |
| `i18n` | `(template, ...args) => string` with `${0}` placeholders |
| `actionAttribute` | Attribute set on the buttons; default `data-luker-lib-action` |

Buttons carry the action attribute with the value `regenerate` or `edit-user-message`, plus `data-luker-lib-msg-id`. A user message with `auto: true` and an assistant message with nothing to show render as `''`.

`bindChainBrokenBanner(root, bus, opts = {})` listens for the bus event `bus:chain-broken`, disables `[data-iter-input]` inside `root` and appends a banner translated by `opts.translate`. Returns an unbind function.

### `ui.diff`

`renderDiffCard(input, opts = {})`:

- `input` is an edits array: returns the HTML string of one card per edit.
- `input` is a ProposalBus entry `{ target, inverse }`: returns `Promise<string>`. Reads the current value through the target registry, rebuilds the value at proposal time and renders the change; when that fails it renders the raw record.

| Option | Purpose |
| --- | --- |
| `fieldLabels` | Map from field path to display label |
| `includeRawArgs` | Append the raw arguments under each card |
| `live` | Value that string edits resolve their path against; pass it for pending edits |
| `i18n`, `translate` | Translator |

### `ui.ensureUiStylesheetInjected()`

Adds the shared `luker_lib_*` stylesheet once and installs the copy-button handler of reasoning blocks.

## tools

Each tool namespace provides tool names, OpenAI-style definitions to splice into a studio's catalog, a predicate and an executor. Executors take a runner call `{ id, name, args }` and resolve to `{ ok: true, result }` or `{ ok: false, error }`. Every failure of `runCharacterPresetReadTool`, failures of `runLorebookReadTool` raised during execution, and argument or target failures of the lorebook write and skill executors also carry `reason`, a state error code such as `VALIDATION_ARGS` or `CONFLICT`, and a short `hint`.

### `tools.lorebookReads`

| Member | Behavior |
| --- | --- |
| `LOREBOOK_READ_TOOL_NAMES` | `world_book_list`, `lorebook_list`, `lorebook_query`, `lorebook_get` |
| `LOREBOOK_READ_TOOL_DEFS` | Tool definitions |
| `isLorebookReadTool(name)` | Predicate |
| `runLorebookReadTool(call, { context, avatar = '' })` | Runs one call; `avatar` selects the character whose books `world_book_list` lists |

### `tools.lorebookWrites`

| Member | Behavior |
| --- | --- |
| `LOREBOOK_WRITE_TOOL_NAMES` | `lorebook_update_entry`, `lorebook_str_replace_in_entry` |
| `LOREBOOK_WRITE_TOOL_DEFS` | Tool definitions |
| `isLorebookWriteTool(name)` | Predicate |
| `runLorebookWriteTool(call, { context })` | Computes the proposal `{ book_name, uid, kind, before, after, ... }` without writing; `before` and `after` are the whole entry |

A studio proposes the result on its ProposalBus with the `lorebookWrite` kind and the target `{ type: LOREBOOK_ENTRY_TARGET_TYPE, name: book_name, uid }`; the lorebook entry target writes approved entries.

### `tools.characterPresetsReads`

| Member | Behavior |
| --- | --- |
| `CHARACTER_PRESET_READ_TOOL_NAMES` | `inspect_bound_preset` |
| `CHARACTER_PRESET_READ_TOOL_DEFS` | Tool definition |
| `isCharacterPresetReadTool(name)` | Predicate |
| `runCharacterPresetReadTool(call, { context, avatar = '' })` | Lists or reads the presets embedded on a character card; `avatar` defaults to the current character |

### `tools.skillIterStudio`

| Member | Behavior |
| --- | --- |
| `SKILL_ITER_STUDIO_TOOL_NAMES`, `SKILL_ITER_STUDIO_TOOL_DEFS` | Skill inventory, authoring, policy and migration tools |
| `isSkillIterStudioTool(name)` | Predicate |
| `runSkillIterStudioTool(call, mutationCtx = {})` | Resolves to `{ ok: true, result }`, to `{ ok: true, result, pendingEdit }` for a working-profile edit, to `{ ok: true, result, pendingSkillEdit }` for an authoring proposal, or to `{ ok: false, error }`. `mutationCtx.getWorkingProfile()` returns the profile that policy and splice tools edit; `mutationCtx.defaultScope` is the skill scope used when a call omits `scope`, and the global scope when unset. |
| `commitApprovedSkillProposal(op)` | Replays an approved authoring operation `{ name, args }` against the skills on disk. Throws on failure. Validation failures throw `SkillProposalError`; a missing `SKILL.md`, or a server refusal because the skill changed on disk after the proposal, throws it with `reason` `CONFLICT`. Other skills API errors propagate unchanged. |
| `SkillProposalError` | Error with `reason` and `hint` |
| `applyFrontmatterPatch(content, patch)` | Returns SKILL.md content with the patch keys assigned; a `null` value deletes the key |
| `buildSkillVisibilityChange(beforeProfile, afterProfile, { kind, agentId, list })` | Describes how a policy edit changed the visible or denied skills of a mode or an agent |
| `ensureSkillRegistryTarget()` | Registers the `skill-registry` ProposalBus target once. The target address is `{ type: 'skill-registry', name, path, _op }`; approving writes by replaying `_op` through `commitApprovedSkillProposal`. |

### `tools.ctxAndDocsDiscovery`

Executors without tool definitions; the caller chooses tool names and schemas. Failures resolve to `{ ok: false, error }`.

| Member | Behavior |
| --- | --- |
| `listCtxKeys({ filter = '' } = {})` | `{ ok, count, keys: [{ key, type }] }` of the top-level context keys |
| `describeCtxPath({ path })` | For a dot path: type, arity and preview of a function, keys of an object, value of a scalar |
| `listLukerDocs({ filter = '', includeTranslations = false, fetchImpl = null } = {})` | `{ ok, count, totalCount, hiddenTranslations, files }`; translations are hidden by default |
| `readLukerDoc({ path, fetchImpl = null })` | `{ ok, path, size, content }` of one doc under `docs/` |

## proposalBus

ProposalBus holds the changes a studio's AI proposes until the user approves, rejects or rolls them back. Each entry stores the forward and inverse JSON patches of its change. Reads and writes go through a target handler; before writing, the bus checks that every path the change touches still holds the expected value, and a mismatch parks the entry as `conflict`.

### Factory and kind descriptors

| Member | Behavior |
| --- | --- |
| `createProposalBus({ i18n, onChange, onCommitted } = {})` | Creates one bus per popup mount. `onChange()` runs after every mutation; `onCommitted(entry)` runs after each successful forward write. |
| `profileEdit`, `lorebookWrite`, `skillAuthor`, `presetClone`, `customToolAuthor` | Kind descriptors `{ kind, targetType }`, listed below |
| `createProfileEditHandler()`, `createLorebookWriteHandler()`, `createSkillAuthorHandler()`, `createPresetCloneHandler()`, `createCustomToolAuthorHandler()` | Return the matching descriptor |

| Descriptor | `kind` | `targetType` | Rollback |
| --- | --- | --- | --- |
| `profileEdit` | `profile-edit` | `profile` | yes |
| `lorebookWrite` | `lorebook-write` | `orch-lorebook` | yes |
| `skillAuthor` | `skill-author` | `skill-registry` | no |
| `presetClone` | `preset-clone` | `preset` | no |
| `customToolAuthor` | `custom-tool-author` | `orch-custom-tool` | no |

A studio registers each kind with `bus.registerKind(kind, handler)`; registering a kind twice throws. The handler extends a descriptor with the card renderers `icon(entry)`, `label(entry)`, `target(entry)` and `renderDiffCard(entry, { escapeHtml, formatTime, i18n })`, which `renderCardsForMessage` calls. A handler with `inverseAvailable: false` marks a kind whose committed entries are irreversible: rollback refuses them and the bulk rollback methods skip them.

### Targets

Targets are registered through the Layer 1 module `/scripts/iteration-library/storage/target-registry.js`.

| Member | Behavior |
| --- | --- |
| `registerTarget(type, { read, write, describe })` | `read(target)` returns the current value, `write(target, next)` stores a value, `describe(target)` returns a display name. Registering a type again replaces the handler. |
| `hasTarget(type)` | Whether a handler is registered for `type` |
| `resolveTarget(target)` | Returns the handler of `target.type`; throws `UnknownTargetError` when none is registered |

The Layer 1 module `/scripts/iteration-library/proposal-bus/targets/lorebook-entry.js` provides the target of the `lorebookWrite` kind:

| Member | Behavior |
| --- | --- |
| `LOREBOOK_ENTRY_TARGET_TYPE` | Target type `'orch-lorebook'` of lorebook entry proposals; the target address is `{ type, name, uid }` |
| `ensureLorebookEntryTarget(context)` | Registers the lorebook entry target once and binds it to `context`, which supplies `loadWorldInfo` and `saveWorldInfo`; a later call rebinds the context |

### Bus methods

| Method | Behavior |
| --- | --- |
| `propose({ kind, target, before, after, sourceCallId, meta })` | Adds a `pending` entry and resolves to `{ id, target }`. Throws for an unknown kind or target, or when `target.type` differs from the kind's `targetType`. |
| `approve(id)` | Writes a `pending` or `conflict` entry and resolves to `{ ok, status }`. `status` is `committed` on success; on drift or a failed write the entry becomes `conflict` and the result also carries `reason`, `hint` and `error`. |
| `reject(id)`, `reset(id)` | `pending` or `conflict` → `rejected`; `rejected` → `pending` |
| `rollback(id)` | Restores the value before a `committed` entry → `rolledBack`. On drift or a failed write the entry becomes `conflict` and `bus:rollback-failed` is dispatched; an irreversible entry resolves to `{ ok: false, status, reason: 'not_reversible' }`. |
| `forceDiscard(id)` | `conflict` → `rolledBack` without writing |
| `exportRecord(id)` | Dispatches `bus:export-record` with the entry's target and inverse patch |
| `approveAllPendingInTurn(message)`, `rejectAllPendingInTurn(message)`, `rollbackAllInTurn(message)` | Act on the entries whose `sourceCallId` is one of `message.toolCalls[].id` |
| `rollbackAllInMessages(messages)` | Rolls back the reversible committed entries of several messages, newest first; stops at the first failure and resolves to `{ results, ok, failedAt }` |
| `countCommittedInMessages(messages)` | Number of reversible committed entries of those messages |
| `hasOutstanding()` | Whether any entry is `pending` |
| `listPending()` | `[{ id, sourceCallId }]` of the pending entries |
| `listEntries()` | Shallow copies of every entry in proposal order, with `id`, `kind`, `status`, `target`, `sourceCallId`, `meta`, `conflictError` and the timestamps `createdAt`, `decidedAt`, `committedAt`, `rolledBackAt` |
| `getCurrentPendingState(kind, target)` | Current value of `target` with the pending proposals of `kind` applied; dispatches `bus:chain-broken` when they cannot be applied |
| `drainOutcomes()` | Returns and clears the outcomes recorded since the last drain |
| `serialize()`, `hydrate(data)` | Session persistence; the serialized form carries `version: 3`. Pending entries restored by `hydrate` can be approved. |
| `setAutoApprove(enabled)`, `isAutoApprove()` | Approve each new proposal right after it is added |
| `renderCardsForMessage(messageOrCallId)` | HTML of the proposal cards of a message, or of one tool-call id |
| `renderTurnActions(messageOrCallId)` | HTML of the bulk approve, reject and rollback buttons |
| `handleClick(event)`, `setMessageResolver(fn)` | Route clicks on `[data-proposal-action]`; `handleClick` resolves `false` for other clicks. `fn(messageId)` returns the message that bulk actions act on. |
| `events` | `EventTarget` dispatching `bus:chain-broken`, `bus:rollback-failed` and `bus:export-record` |

## Workspace helpers

| Member | Behavior |
| --- | --- |
| `bindIterWorkspaceResizer(workspaceRoot)` | Lets the user drag `.luker-iter-workspace-resizer` to resize the columns of `.luker-iter-workspace-grid` inside `workspaceRoot`; the split is not saved. Returns an unbind function. |
| `createRenderScheduler({ handler, frameRequester, onError })` | Layer 1 only. Returns `{ schedule, flush, dispose }`: `schedule()` calls coalesce into one `handler()` run on the next animation frame, `flush()` runs a scheduled run immediately, `dispose()` cancels pending work. `onError(err)` receives errors thrown by `handler`. |

## Reference consumers

- **Workbench targets** (`public/scripts/workbench/targets/`, `orchestrator/lens/iterate-target.js`, `memory-graph/lens/iterate-targets.js`) — consume `proposalBus`, `tools` and `runner` helpers while delegating window chrome, target switching and change history to Workbench.
- **CardApp Studio** (`public/scripts/extensions/character-editor-assistant/studio/`) — owns its standalone full-viewport IDE while using `iterationLibrary` for runner retries, lorebook and discovery tools, diff rendering, and `edits-lib` apply and rollback.

## Related pages

- [Workbench API](/development/extension-api/workbench) — register AI iteration targets inside Workbench
- [Edits Library](/development/extension-api/edits-lib) — op-typed patch engine and conflict resolution
