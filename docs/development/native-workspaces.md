# Native workspaces: Memory Lens, Orchestra Lens, Workbench

Maintainer and reviewer notes for the three workspaces that used to be third-party extensions.

## Scope

Memory Lens and Orchestra Lens are the only interface to the `memory-graph` and `orchestrator` extensions. Workbench is a new floating window.

- Memory Lens covers graph, timeline and table views, manual node and relationship editing, schema editing, all settings, graph operations, and entry points to the two iteration studios.
- Orchestra Lens covers the agent flow, run history, preset management, structural profile editing, general settings, tools, skills, notes and the Iteration Studio entry point. Its dock shows orchestrator and search runs.
- Workbench provides an overview, a read-only assistant, AI iteration and undoable change history.

Removed: the settings drawers and editors of both extensions, the graph inspector, and the orchestrator's run panel wrapper. The maintainer agreed to replace these UIs directly, so there is no switch back.

Kept on purpose: runtime and persistence code, external APIs, the iteration studios and their tools, and the shared `public/scripts/run-panel/` API for other extensions. The studios, custom tool editor, ST tool picker and skill manager remain standalone popups opened from the lens.

The look matches the plugins. Adopting theme variables or `luker-window.js` is a separate decision.

## File map

| Path | Purpose | Origin |
|---|---|---|
| `public/scripts/extensions/lens-shared/` | DOM and formatting helpers and their locale data | `util.js` of all three plugins |
| `public/scripts/extensions/memory-graph/lens/` | Memory Lens | `memory-lens` |
| `public/scripts/extensions/orchestrator/lens/` | Orchestra Lens, recorder, run dock | `orchestra-lens` |
| `public/scripts/extensions/workbench/` | Workbench, a new built-in found by the folder scan | `luker-workbench` |
| `tests/lens-shared/`, `tests/memory-graph/lens/`, `tests/orchestrator/lens/`, `tests/workbench/` | Ported unit tests | plugin tests |

Commits are layered in that order: shared helpers, Memory Lens, Orchestra Lens, Workbench, then parity work, removal of the replaced UIs, and this document.

## Changes to existing Luker files

Review these first.

| File | Change | Why |
|---|---|---|
| `public/script.js` | Optional save acknowledgement | Lets Workbench confirm its own settings payload was saved when requests overlap. |
| `memory-graph/main.js` | Drawer, inspector, schema editor and their CSS removed; click-handler logic extracted into exported functions (`runFillGraph`, `runRebuildGraph`, `runManualCompression` and others) | The lens calls those functions. `updateUiStatus` now only notifies the lens; `refreshUiStats` is a no-op kept for runtime callers. |
| `memory-graph/ui-templates.js` | Deleted | Drawer markup only. |
| `memory-graph/graph-ops.js` | Gains `reparentNode` and `willCreateParentCycle` | Moved from `main.js` for the lens. |
| `orchestrator/main.js` | Drawer and popup editors removed; new API methods (`openIterationStudio`, `openRunDock` and others) | The lens uses the API. `updateUiStatus` only logs. |
| `orchestrator/preset-io.js` | New, extracted from `main.js` | Preset import, export and spec/agenda conversion without DOM. |
| `orchestrator/ui-templates.js`, `styles.js` | Reduced to the notes template and rules still used by the notes panel and popups | The rest belonged to the removed UI. |
| `orchestrator/run-panel/panel.js` | Deleted | The dock shows runs directly from the store. |
| `search-tools/main.js`, `run-panel.js` | Builds a run store only and exposes `getRunStore`; "show run panel" opens the dock | Search no longer mounts a panel. |
| `workbench/source-luker.js` | Stops syncing the removed input | The element is gone. |
| `manifest.json` of both extensions | Load `lens/style.css` | Lens stylesheets. |

## Runs and old plugins

- **Run display.** The recorder attaches directly to the orchestrator and search run stores, so quiet runs are recorded too. Third-party extensions using `createRunPanel` keep their own panel.
- **Old plugin still installed.** Each lens checks `extensionNames` for its `third-party/...` copy. If that copy is enabled, the built-in lens still adds its menu entry and shows a warning, but skips the background work the plugin would duplicate: the tag filter and token recorder for Memory Lens, and the dock and run recording for Orchestra Lens. Old plugin versions may rely on removed DOM, so users should remove them.
- **Disabled host extension.** With `memory-graph` or `orchestrator` disabled, its lens does not load. Workbench still opens and reports that workspace as unavailable.

## Data compatibility

Legacy data has no owner, so it is never attached to an account. `workbench.sessions.v1` is now in `accountStorage` and starts empty; the old localStorage key is left untouched and unread. The session list is capped at 1M characters because it is sent with every settings save, and each session at 200K (oldest model history, then oldest turns, then long text is cut first), so one long chat cannot push out the others. Run and change history are kept per account under `<key>::<user handle>` in localStorage; the unsuffixed keys are left untouched and unread. With accounts on and no known user, history is not stored.

| Workspace | Keys |
|---|---|
| Memory Lens | `extensionSettings.memory_lens`, `chatMetadata.memory_lens_tokens`, `memoryLens.prefs.v1`, `memoryLens.aiAutoApply`, regex owner `memory-lens-tag-filter`, id prefix `memory-lens-tagfilter-`, `memoryLensLabels` in exports |
| Orchestra Lens | `extensionSettings.orchestra_lens.ai`, `orchestraLens.history.v1::<handle>`, `.prefs.v1`, `.dock.v1`, `.ai.v1`, `.aiAutoApply` (a leftover `.takeover` value is ignored) |
| Workbench | `extensionSettings.luker_workbench`, `accountStorage` `workbench.sessions.v1`, localStorage `workbench.prefs.v1`, `workbench.history.v1::<handle>`; the unowned `workbench.orchRuns.v1` is no longer read |

## Differences from the plugins

- Memory Lens and Workbench schema iteration moved from the removed `schema-iteration` module to `config-iteration` tools with `LEGACY_SCHEMA_ITER_SYSTEM_PROMPT`. A custom `schemaIterSystemPrompt` is still honoured. **This has not been run against a real model.**
- Workbench no longer records orchestrator runs. It reads Orchestra Lens history.
- Plugin globals (`MemoryLens`, `OrchestraLens`, `LukerWorkbench`) are gone. Fallbacks for older Luker versions are gone.
- User-visible strings use English keys with zh-cn and zh-tw tables. Some keys are reworded so they do not overwrite existing Luker translations.
- In non-Chinese locales, dates and token counts follow the locale, and memory schema labels are shown as stored.

## Review hints

Areas that deserve the closest look:

1. The AI assistant path into `config-iteration` (`memory-graph/lens/source-luker.js`, `workbench/source-iterate.js`).
2. Writes to user data: schema save, node and relationship edits (`memory-graph/lens/edit/`), agent, structure and preset edits (`orchestrator/lens/source-write.js`, `orchestrator/lens/model/edit.js`), iteration apply and undo (`workbench/`). Workbench apply and undo follow one rule (`workbench/model/patch.js`): field changes are computed from the proposal baseline by the same diff the preview shows, merged onto freshly read data at a target fixed when the action started, and a field changed elsewhere makes its unit a conflict. Undo is the same merge reversed. Failed reads and saves stop with an error and leave history unchanged; world book writes require the cached and persisted documents to agree, because Luker caches edits before they reach the server.
3. The tag filter runtime (`memory-graph/lens/filter/filter-runtime.js`), which registers regex scripts.
4. Functions extracted from the old click handlers in `memory-graph/main.js`, whose behavior should be unchanged.
5. Secret redaction in Workbench's request reader (`workbench/model/requests.js`).

Chinese text remaining in JS outside locale tables is limited to:

- regexes and punctuation that parse stored text or user input (Memory Lens and `orchestrator/lens/model/run.js`);
- text sent to the model in Workbench (`model/ask.js`, `model/iterate.js`, `model/requests.js`, and notes in `source-luker.js`, `source-iterate.js` and `pages/`).

The Workbench prompts are not localized yet.

## Tests

```bash
cd tests && npm run test:unit -- --maxWorkers=1 memory-graph mg-config-iteration orchestrator orch-iteration search-tools workbench lens-shared run-panel --testPathIgnorePatterns ' 2\.' /node_modules/
```

Put test paths before `--testPathIgnorePatterns`; the option takes every following value.

E2E and Playwright tests that drive the removed DOM were not updated: `tests/e2e/memorygraph`, `iterstudio`, `orchestrator`, `preset`, `regression`, `sync`, `_lib`, plus `tests/frontend` and `tests/skills-ui/playwright`.

## Not verified

The lens-only UI has not been run in an automated browser. Rendering, stacking of toasts and popups, mobile layouts, settings pages, graph operations, preset and structural edits, and real AI calls still need checking on a device. `orchestrator/styles.js` was reduced by matching class names as text, so popup styling should be checked by eye.

Known behavior changes: a stale embedding or rerank profile ID is no longer cleared automatically, and field help buttons from the old drawers were not carried over.
