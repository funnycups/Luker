# Native workspaces: Memory Lens, Orchestra Lens, Workbench

Maintainer and reviewer notes for the three workspaces that used to be third-party extensions.

## Scope

Added:

- Memory Lens, a visual workspace for the `memory-graph` extension.
- Orchestra Lens, a visual workspace and run dock for the `orchestrator` extension.
- Workbench, a floating window with an overview, a read-only assistant, AI iteration and undoable change history.

Deliberately not done:

- **No native panel or code is removed.** Old and new UIs run side by side. Removing the old panels is a separate later change, once the new code has proved stable.
- **No restyling.** The look matches the plugins. Adopting theme variables or `luker-window.js` is a separate decision.

## File map

| Path | Purpose | Origin |
|---|---|---|
| `public/scripts/extensions/lens-shared/` | DOM and formatting helpers and their locale data | `util.js` of all three plugins |
| `public/scripts/extensions/memory-graph/lens/` | Memory Lens | `memory-lens` |
| `public/scripts/extensions/orchestrator/lens/` | Orchestra Lens, recorder, run dock | `orchestra-lens` |
| `public/scripts/extensions/workbench/` | Workbench, a new built-in found by the folder scan | `luker-workbench` |
| `tests/lens-shared/`, `tests/memory-graph/lens/`, `tests/orchestrator/lens/`, `tests/workbench/` | Ported unit tests | plugin tests |

Commits are layered in that order: shared helpers, Memory Lens, Orchestra Lens, Workbench, then coexistence guards and this document.

## Changes to existing Luker files

Review these first. Everything else in the branch is a new file.

| File | Change | Why |
|---|---|---|
| `public/script.js` | Optional save acknowledgement | Lets Workbench confirm its own settings payload was saved when requests overlap. |
| `memory-graph/main.js` | +3 lines | Dynamic import of `lens/index.js` at bootstrap. It is dynamic because a static import broke partial mocks in tests that import `main.js`. |
| `memory-graph/manifest.json` | +1 line | Loads `lens/style.css`. |
| `orchestrator/main.js` | +3 lines | Same bootstrap import. |
| `orchestrator/manifest.json` | +1 line | Loads `lens/style.css`. |

## Coexistence

- **Native panels stay available** alongside each workspace.
- **The run dock replaces native run panels by default.** `orchestrator/lens/dock/takeover.js` wraps `PanelRenderer.prototype.handle` to get each run store. This is intentional, because it leaves the native renderer untouched while both UIs exist. The dock's menu turns takeover off (`orchestraLens.takeover`), which restores the native panels after a reload. A proper hook can replace the wrapper when the old panels are removed.
- **Old plugin still installed:** each native workspace checks `extensionNames` for its `third-party/...` copy. If that copy is enabled, the native workspace stays inactive and logs a warning, so nothing runs twice. Removing the plugin activates the native one.
- **Disabled host extension:** with `memory-graph` or `orchestrator` disabled, its lens does not load. Workbench still opens and reports that workspace as unavailable.

## Data compatibility

Legacy data has no owner, so it is never attached to an account. `workbench.sessions.v1` is now in `accountStorage` and starts empty; the old localStorage key is left untouched and unread. The session list is capped at 1M characters because it is sent with every settings save, and each session at 200K (oldest model history, then oldest turns, then long text is cut first), so one long chat cannot push out the others. Run and change history are kept per account under `<key>::<user handle>` in localStorage; the unsuffixed keys are left untouched and unread. With accounts on and no known user, history is not stored.

| Workspace | Keys |
|---|---|
| Memory Lens | `extensionSettings.memory_lens`, `chatMetadata.memory_lens_tokens`, `memoryLens.prefs.v1`, `memoryLens.aiAutoApply`, regex owner `memory-lens-tag-filter`, id prefix `memory-lens-tagfilter-`, `memoryLensLabels` in exports |
| Orchestra Lens | `extensionSettings.orchestra_lens.ai`, `orchestraLens.history.v1::<handle>`, `.prefs.v1`, `.dock.v1`, `.ai.v1`, `.aiAutoApply`, `.takeover` |
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
2. Writes to user data: schema save, inline edit (`memory-graph/lens/edit/`), agent edit (`orchestrator/lens/source-write.js`), iteration apply and undo (`workbench/`). Workbench apply and undo follow one rule (`workbench/model/patch.js`): field changes are computed from the proposal baseline by the same diff the preview shows, merged onto freshly read data at a target fixed when the action started, and a field changed elsewhere makes its unit a conflict. Undo is the same merge reversed. Failed reads and saves stop with an error and leave history unchanged; world book writes require the cached and persisted documents to agree, because Luker caches edits before they reach the server.
3. The tag filter runtime (`memory-graph/lens/filter/filter-runtime.js`), which registers regex scripts.
4. The run-panel wrapper (`orchestrator/lens/dock/takeover.js`).
5. Secret redaction in Workbench's request reader (`workbench/model/requests.js`).

Chinese text remaining in JS outside locale tables is limited to:

- regexes and punctuation that parse stored text or user input (Memory Lens and `orchestrator/lens/model/run.js`);
- text sent to the model in Workbench (`model/ask.js`, `model/iterate.js`, `model/requests.js`, and notes in `source-luker.js`, `source-iterate.js` and `pages/`).

The Workbench prompts are not localized yet.

## Tests

```bash
cd tests && npm run test:unit -- --maxWorkers=1 workbench memory-graph/lens orchestrator/lens lens-shared
```

Full-suite comparison on macOS against a clean `release` export: 667 failures on this branch, 674 on `release`, 664 of them shared. The shared failures come from the local environment (for example a missing sqlite native binding). The 11 failures seen only on the branch were all server-side, and all passed when rerun serially. The two full runs executed at the same time, so they were competing for resources. The coexistence guards were added after that comparison.

## Not verified

Nothing has been run in a browser or on a device. That includes rendering, CSS loading, mobile layouts, the dock and takeover switch, tag filter at runtime, every save path and all real AI calls. The four Traditional Chinese locale tables have been proofread for Taiwan usage.
