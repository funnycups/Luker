# Edits Library

Op-typed structured edits with drift-aware apply and interactive conflict resolution.

## When to use

Use this library when your plugin has this shape:

1. AI tool calls propose changes to a user-owned structured object (JSON,
   preset, character card, graph, etc.)
2. The user reviews proposed changes and decides whether to apply
3. The object can be edited externally between proposal and apply

Without the library you must manually track baselines, detect drift, and
write your own conflict UI per plugin. With the library, all consumers
share one merge engine and one resolution UX.

## Concepts

- **Edit** — a tagged object describing a single op-typed change.
  Built-in ops: `set`, `unset`, `str_replace`, `str_insert`, `str_delete`,
  `list_insert`, `list_remove`, `list_move`.
- **Apply** — `applyEdits(edits, live)` returns `{ newLive, clean,
  conflicts, alreadyDone }`. The engine drift-checks every edit against
  current live before mutating.
- **Inverse** — `inverseEdit(edit)` returns the edit that undoes it.
  Suitable for rollback.
- **Custom op** — `registerOp(name, handler)` lets plugins define
  domain-specific mutations.

## API

All three layers expose the same surface:

```js
// Layer 1 — ESM
import { applyEdits, inverseEdit, registerOp, getRegisteredOp,
         listRegisteredOps, showConflictResolution,
         BUILT_IN_OPS } from '/scripts/lib/edits/index.js';

// lukerContext
lukerContext.edits.applyEdits(...);
lukerContext.edits.showConflictResolution(...);

// getContext
SillyTavern.getContext().edits.applyEdits(...);
SillyTavern.getContext().edits.showConflictResolution(...);
```

`showConflictResolution` is also re-exported from `/scripts/lib/edits/conflict-ui.js`
for backward compatibility, but new code should import it from `index.js` (or use
the `lukerContext` / `getContext()` layers) to stay consistent with the rest of
the API surface.

### `applyEdits(edits, live)`

| Argument | Type | Description |
| --- | --- | --- |
| `edits` | `Edit[]` | List of op-typed edits to apply in order |
| `live`  | `any`    | The current live object (deep-cloned internally; not mutated) |

Returns:

```js
{
    newLive: any,                   // post-application live
    clean:    Edit[],               // edits applied without conflict (augmented in-place by some ops for inverse)
    conflicts: ConflictEntry[],     // edits whose anchor/baseline mismatched current live
    alreadyDone: Edit[],            // edits whose effect was already in current live
}
```

### `inverseEdit(edit)`

Returns the Edit that undoes `edit`. For some ops, `edit` must have been
through `applyEdits` first (so internal anchor context like `_inserted_at`
or `_anchor_context` is populated) — the engine does this for you when
you store `result.clean` rather than the original edit array.

### `registerOp(name, handler)`

| Field | Required? | Description |
| --- | --- | --- |
| `apply(deps, edit, live)` | yes | Mutate live in place, return it |
| `inverse(edit)` | yes | Return the inverse Edit |
| `detectConflict(deps, edit, live)` | yes | Return `null` for clean, `{reason, baseline?, current?}` for conflict, `{reason: 'already_done'}` for no-op |
| `renderConflict(entry)` | no | Optional custom DOM for conflict UI |

`deps` is `{get, set, unset, isEqual, cloneDeep}` (lodash methods).
Reserved op names: `set`, `unset`, `str_*`, `list_*`. Use `domain.action`
naming for custom ops (e.g. `node.add`, `entry.update`).

### Built-in op reference

#### `set`
```js
{ op: 'set', path, oldValue, newValue }
```
Replace the value at a lodash path. Conflict when current is neither
`oldValue` nor `newValue`. Already-done when current equals `newValue`.

#### `unset`
```js
{ op: 'unset', path, expected_value? }
```
Delete a key (vs setting to undefined). Already-done when path absent.
Conflict when `expected_value` is set and current deep-unequals it.

#### `str_replace`
```js
{ op: 'str_replace', path, find, replace, expected_count? }
```
Replace all occurrences of `find` in the string at `path`. `expected_count`
defaults to 1 — set explicitly when the AI wants to replace multiple
occurrences. Conflicts: `anchor_missing` (count 0), `anchor_ambiguous`
(count ≠ expected).

#### `str_insert`
```js
{ op: 'str_insert', path, after_text, insert_text }
```
Insert `insert_text` after the unique occurrence of `after_text`.
Conflicts: anchor missing or ambiguous.

#### `str_delete`
```js
{ op: 'str_delete', path, find }
```
Delete unique `find` from the string. Captures surrounding context at
apply time so the inverse `str_insert` can find the right position.

#### `list_insert`
```js
{ op: 'list_insert', path, anchor: { before_index|after_index|after_value }, value }
```
Insert `value` into an array. `after_value` is the most drift-resistant
anchor (survives reorderings as long as the value is still unique).

#### `list_remove`
```js
{ op: 'list_remove', path, index, expected_value? }
```
Splice out element at `index`. `expected_value` guards against external
shifts.

#### `list_move`
```js
{ op: 'list_move', path, from_index, to_index, expected_value? }
```
Move an element. No-op when `from === to`.

## Conflict UI

`showConflictResolution(conflicts, opts?)` returns a `Promise<Resolution[] | null>`.
- `null` means user cancelled the whole apply.
- Each `Resolution` is one of:
  - `{ decision: 'apply-mine', edit }` — overwrite live with proposed
  - `{ decision: 'keep-theirs', edit }` — skip this edit
  - `{ decision: 'manual', edit, newValue }` — user-supplied value

To honor user decisions, re-build the edits array with resolved values and
call `applyEdits` again (the result should have no conflicts if user
chose deterministic resolutions).

## Out-of-scope reminders

- The lib does NOT manage edit history, journals, undo stacks, or sessions.
  That's your plugin's responsibility — typically store `result.clean` on
  the message that produced the edits, then iterate them in reverse via
  `inverseEdit` for rollback.
- The lib does NOT prompt the AI on conflict — the user decides. If you
  want AI-driven reconciliation, implement that in your plugin on top of
  the conflict result.
