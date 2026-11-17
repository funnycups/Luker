# Iteration Library

`context.iterationLibrary` provides shared building blocks for AI-driven iterative editing surfaces: LLM tool-call runners, scoped session storage, word/line text diffs, zoom overlays, shared proposal types, and plugin-agnostic lorebook/skill/preset read-write tool helpers.

To integrate an AI-editable target directly into Luker's unified **Workbench → AI iteration** tab, register an `IterateTarget` through [`context.workbench.registerIterateTarget`](/development/extension-api/workbench#registering-an-ai-iteration-target). Use `context.iterationLibrary` directly when you own a standalone popup or full-viewport editor (such as Character Card Editor's popup or CardApp Studio).

## Three-layer API exposure

```js
// Layer 1 — direct ESM import (in-tree extensions)
import {
    applyEdits,
    inverseEdit,
    registerOp,
    runner,
    storage,
    proposalBus,
    tools,
} from '/scripts/iteration-library/index.js';

// Layer 2 — lukerContext property
const { runner, storage, proposalBus } = lukerContext.iterationLibrary;

// Layer 3 — Luker.getContext() (third-party extensions)
const { applyEdits, runner, storage, textDiff, zoomOverlay, ui, tools, proposalBus } =
    Luker.getContext().iterationLibrary;
```

## Core modules

| Export | Purpose |
| --- | --- |
| `applyEdits`, `inverseEdit`, `registerOp`, `BUILT_IN_OPS`, `showConflictResolution` | Re-exports from [edits-lib](/development/extension-api/edits-lib) for drift-aware apply, rollback, and conflict resolution |
| `runner` | `requestToolCallsWithRetry` and shared LLM round execution helpers |
| `storage` | Scoped session persistence helpers, safe cloning, and per-character/global state helpers |
| `proposalBus` | `createProposalBus` plus built-in proposal adapters: `profileEdit`, `lorebookWrite`, `skillAuthor`, `presetClone`, `customToolAuthor` |
| `tools` | Plugin-agnostic tool catalogs and dispatchers (`lorebook-reads`, `lorebook-writes`, `character-presets-reads`, `skill-iter-studio`) |
| `render`, `textDiff`, `zoomOverlay`, `ui` | Diff cards, line-by-line side-by-side overlays, message markdown rendering, and collapsible thinking helpers |
| `bindIterWorkspaceResizer` | Split-pane drag resizer helper (Layer 1 `/scripts/iteration-library/index.js` also exports `createRenderScheduler`) |

## Reference consumers

- **Workbench targets** (`public/scripts/workbench/targets/` and `orchestrator/lens/iterate-target.js`, `memory-graph/lens/iterate-targets.js`) — consume `proposalBus`, `tools`, and `storage` helpers while delegating window chrome, target switching, and change history to Workbench.
- **CardApp Studio & CEA Popup** (`public/scripts/extensions/character-editor-assistant/`) — own their standalone UIs while using `iterationLibrary` for runner retries, lorebook tools, diff rendering, and `edits-lib` apply/rollback.

## Related pages

- [Workbench API](/development/extension-api/workbench) — register AI iteration targets inside Workbench
- [Edits Library](/development/extension-api/edits-lib) — op-typed patch engine and conflict resolution
- [Character Editor Assistant API](/development/extension-api/character-editor-assistant) — helper tools for card and world book mutations
