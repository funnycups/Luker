# `luker/edits` — structured edit primitives for AI-driven editing

A small library for plugins where an AI tool-call layer proposes edits to
user-owned structured data, and the user reviews & applies them with
IDE-style conflict handling.

## What it does

- Apply a list of op-typed edits to a live object
- Detect per-edit drift against the live state at apply time
- Surface conflicts for interactive resolution
- Compute inverse edits for surgical rollback

## What it doesn't do

- No journal / replay / time-travel — the live is the only source of truth
- No multi-agent / concurrent / streaming editing
- No binary / image data
- No automatic AI reconciliation — conflicts go to the user

## Quick start

```js
import { applyEdits, inverseEdit, registerOp } from '/scripts/lib/edits/index.js';
import { showConflictResolution } from '/scripts/lib/edits/conflict-ui.js';

// AI tool calls collected as a draft
const draft = [
    { op: 'set', path: 'name', oldValue: 'old', newValue: 'new' },
    { op: 'str_replace', path: 'body', find: 'foo', replace: 'bar' },
];

const result = applyEdits(draft, currentLive);
if (result.conflicts.length > 0) {
    const resolutions = await showConflictResolution(result.conflicts);
    // ... write resolutions back, re-call applyEdits with resolved edits
}
const newLive = result.newLive;
```

## Custom ops

For domain-specific mutations not covered by built-ins, register your own:

```js
registerOp('node.add', {
    apply:          (deps, edit, live) => { live.nodes[edit.id] = edit.data; return live; },
    inverse:        (edit) => ({ op: 'node.remove', id: edit.id }),
    detectConflict: (deps, edit, live) =>
        live.nodes[edit.id]
            ? { reason: 'duplicate', current: live.nodes[edit.id] }
            : null,
    renderConflict: (entry) => { /* optional custom DOM */ },
});
```

See `docs/development/extension-api/edits-lib.md` for the full reference.
