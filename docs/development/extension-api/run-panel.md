# Run Panel

## What it is

A reusable, in-memory run trace for any plugin that runs a multi-step LLM task. It renders a slide-in panel beside the chat (or a bottom drawer on narrow screens) with one collapsible card per round, streaming section bodies, a Stop button, an export action, and a floating pill while a run is in progress.

The shared layer lives in `public/scripts/run-panel/` and is exposed as `runPanel` on the Luker context. In-tree consumers:

- Orchestrator — `public/scripts/extensions/orchestrator/run-panel/panel.js`
- Search Tools — `public/scripts/extensions/search-tools/run-panel.js`

![Search agent run in the shared panel](/images/search-tools/run-panel.png)

## Quick start

```js
import { createRunStore, createRunPanel } from '/scripts/run-panel/index.js';

const store = createRunStore();
const panel = createRunPanel({
    store,
    t: (text, ...args) => text,   // supply your plugin's translator
    idPrefix: 'luker-my-run-panel',
    modeLabels: { myTask: 'My task' },
    exportFilename: ({ runId }) => `my-run-${runId}.json`,
});
panel.init();   // call once at boot
panel.open();   // call from a menu action
```

That is the entire integration. Drive the panel by writing to the store:

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

`quiet: true` populates the store without auto-opening the panel; call `panel.open()` to show it later.

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

## Panel options

`createRunPanel(options)` returns `{ init, open, destroy }`.

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
import { createRunStore, createRunPanel } from '/scripts/run-panel/index.js';

// Layer 2 — lukerContext property
const { createRunPanel } = lukerContext.runPanel;

// Layer 3 — getContext (third-party extensions)
const { createRunStore } = SillyTavern.getContext().runPanel;
```

## Reference consumers

- Orchestrator runtimes write rounds and sections, and the panel auto-opens on each run: `public/scripts/extensions/orchestrator/loop-runtime.js`, `director-runtime.js`, `agenda-runtime.js`, `spec-runtime.js`.
- The orchestrator wrapper configures i18n and the export filename: `public/scripts/extensions/orchestrator/run-panel/panel.js`.
