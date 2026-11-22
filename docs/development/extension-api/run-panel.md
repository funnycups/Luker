# Run Panel

## What it is

A reusable, in-memory run trace for any plugin that runs a multi-step LLM task. Plugins write rounds, streaming sections, tool calls, and token usage to a `RunStore` and attach that store to Luker's shared **Run Dock** (`attachDock`) — or mount a standalone `createRunPanel` instance.

The shared Run Dock renders a rounded floating live window across desktop and narrow mobile (`<= 640px`) viewports—with configurable `small` or `large` default size, independent desktop/mobile drag persistence, and a draggable status pill when idle or collapsed—along with round cards, streaming sections, a Stop button, JSON trace export, and optional Inspect / AI diagnosis hooks into [Workbench](/development/extension-api/workbench).

The shared layer lives in `public/scripts/run-panel/` and is exposed as `runPanel` on the Luker context. In-tree consumers:

- Orchestrator — `public/scripts/extensions/orchestrator/lens/index.js`
- Search Tools — `public/scripts/extensions/search-tools/run-panel.js`

![Search agent run in the shared panel](/images/search-tools/run-panel.png)

## Quick start (Shared Run Dock)

```js
const ctx = Luker.getContext();
const { createRunStore, attachDock, openRunDock } = ctx.runPanel;

const store = createRunStore();
attachDock(store, {
    source: 'my-plugin',
    getRunContext: () => ({ chatId: ctx.chatId, chatLabel: ctx.name2 }),
    onInspect: (runKey) => ctx.workbench?.open?.({ ws: 'my-ext', subview: 'run', runKey }),
});
```

Drive the dock by writing to the store:

```js
const runId = store.startRun({ mode: 'myTask', stopFn: () => abortController.abort() });
const roundId = store.appendRound({ runId, round: { id: 'round-1', label: 'Round 1' } });
const sectionId = store.ensureSection({
    runId, roundId,
    section: { id: 'reasoning', kind: 'reasoning', title: 'Reasoning' },
});
store.appendToSection({ runId, roundId, sectionId, delta: 'thinking…' });
store.setSectionStatus({ runId, roundId, sectionId, status: 'done' });
store.finishRun({ runId, status: 'committed', finalText: 'Result' });
```

Call `await openRunDock()` or `await toggleRunDock()` from a menu item or button to open the dock on demand.

## Store API

`createRunStore()` returns an isolated store. Each call produces an independent instance, so two plugins never share or collide on run state.

| Method | Purpose |
| --- | --- |
| `subscribe(listener)` | Subscribe to events; returns an unsubscribe function. |
| `getCurrentRun()` | The live run object, or `null`. |
| `startRun({ mode, chatKey, abortFn, stopFn, quiet })` | Begin a run; returns the `runId`. Throws if this store already has a running run. |
| `clearCurrentRun()` | Drop the current run and emit `run_cleared`. |
| `appendRound({ runId, round: { id, label } })` | Add a round; returns the `roundId`. |
| `setRoundStatus({ runId, roundId, status })` | Update a round's status. |
| `ensureSection({ runId, roundId, section: { id, kind, title, meta } })` | Create a section if absent; returns the `sectionId`. |
| `appendToSection({ runId, roundId, sectionId, delta })` | Append streaming text to a section body. |
| `setSectionStatus({ runId, roundId, sectionId, status, meta })` | Update a section's status. |
| `finishRun({ runId, status, finalText, error })` | End the run. |
| `setRunMeta({ runId, tokensSpent, cost })` | Set run-level metadata. |
| `addTokenUsage({ runId, usage })` | Fold an LLM usage object into the running token totals. |

`quiet: true` populates the store without auto-opening the dock or panel; call `openRunDock()` (or `panel.open()`) to show it later.

## Events

Listeners receive `{ type, ... }` payloads. Constants are exported from `run-panel/events.js` (also available as `context.runPanel.events`).

| Event | Payload |
| --- | --- |
| `run_started` | `runId`, `mode`, `quiet` |
| `round_appended` | `runId`, `roundId` |
| `section_ensured` | `runId`, `roundId`, `sectionId` |
| `section_appended` | `runId`, `roundId`, `sectionId`, `delta` |
| `section_status` | `runId`, `roundId`, `sectionId`, `status`, `meta` |
| `round_status` | `runId`, `roundId`, `status` |
| `run_meta` | `runId` |
| `run_finished` | `runId`, `status` |
| `run_cleared` | `runId` |

## Shared Run Dock & Recorder API

| Function | Purpose |
| --- | --- |
| `attachDock(store, opts)` | Attach a `RunStore` to the shared singleton recorder and floating dock (`{ source, getRunContext, getFlow, onInspect, onDiagnose }`). |
| `openRunDock()` | Ensure and open the shared Run Dock. |
| `toggleRunDock()` | Toggle the shared Run Dock open/closed. |
| `getRunRecorder()` | Return the shared recorder holding live and recent per-account run history. |
| `getRunDockPrefs()` | Read the signed-in account's Run Dock preferences (`{ autoOpen: boolean, defaultSize: 'small' \| 'large' }`). |
| `setRunDockPrefs(patch)` | Update Run Dock preferences (`{ autoOpen?, defaultSize?, resetPosition? }`), sync live dock instances, and notify subscribers. |
| `resetRunDockPosition()` | Clear saved desktop and mobile dock/pill coordinates for the signed-in account. |
| `subscribeRunDockPrefs(listener)` | Subscribe to Run Dock preference changes; returns an unsubscribe function. |

Users control **Open automatically on run** and **Run panel default size** (`Small window` / `Large window`) from the dock menu, Search Tools settings, Orchestrator settings, or Workbench **Settings → Window** (auto-open is enabled by default; when turned off, non-quiet runs show the compact status pill instead of expanding automatically).

## Standalone `createRunPanel` options

When you need an isolated custom panel instead of the shared dock, `createRunPanel(options)` returns `{ init, open, destroy }`:

| Option | Default | Purpose |
| --- | --- | --- |
| `store` | required | A store from `createRunStore()`. |
| `t` | identity | Translator `(template, ...args) => string`. |
| `idPrefix` | `luker-run-panel` | DOM id prefix; the panel root is `#<idPrefix>` and the pill is `#<idPrefix>-pill`. |
| `stylesheetUrl` | the shared `panel.css` | Stylesheet to inject. |
| `kindIcons` | `DEFAULT_KIND_ICONS` | Map of section kind to icon. |
| `defaultCollapsedKinds` | `[]` | Section kinds rendered collapsed. |
| `modeLabels` | `{}` | Map of mode to badge label; falls back to the raw mode. |
| `exportFilename` | `run-<runId>-<mode>.json` | Filename for the export action. |
| `autoOpen` | `true` | Auto-open on a non-quiet `run_started`. |
| `emptyStateText` | a default hint | Copy shown by `open()` when there is no run. |
| `onStop` | `null` | Override the Stop handler. |

## Helpers

These convenience wrappers finalize round and section status. They take the store as their first argument, so they work with any store instance.

| Helper | Purpose |
| --- | --- |
| `withRound(store, runId, { id, label }, fn)` | Append a round, run `fn(roundId)`, then mark the round `done`. A thrown error marks it `failed`. Returns `fn`'s result; a returned promise finalizes the round once it settles. |
| `withStreamingSection(store, runId, roundId, { id, kind, title }, asyncFn)` | Ensure a section, pass an `append(delta)` function and the section id to `asyncFn`, then mark the section `done`. A thrown error marks it `failed`. |

## Three-layer API exposure

```js
// Layer 1 — direct ESM import (in-tree extensions)
import { createRunStore, attachDock, openRunDock } from '/scripts/run-panel/index.js';

// Layer 2 — lukerContext property
const { createRunStore, attachDock, openRunDock } = lukerContext.runPanel;

// Layer 3 — getContext (third-party extensions)
const { createRunStore, attachDock, openRunDock } = Luker.getContext().runPanel;
```

## Reference consumers

- Orchestrator attaches its `RunStore` to the shared Run Dock in `public/scripts/extensions/orchestrator/lens/index.js`, wiring **Inspect run** to Workbench (`ws: 'orch', subview: 'run'`) and **AI diagnosis** to Workbench (`page: 'ai', ws: 'orch'`).
- Search Tools attaches its `RunStore` to the shared Run Dock (`source: 'search'`) in `public/scripts/extensions/search-tools/run-panel.js`.
