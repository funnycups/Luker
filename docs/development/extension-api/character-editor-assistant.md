# Character Editor Assistant

The `character-editor-assistant` (CEA) extension provides AI-assisted editing for character cards, world books, and CardApps. Its standalone popup (`editor-ui.js`) and CardApp Studio (`studio/`) use the plugin-agnostic helpers exported from `context.iterationLibrary.tools` alongside CEA's card-field tools and custom `edits-lib` ops (`cardapp_patch_file`, `cardapp_rename_file`, `lorebook_entry_add`, `lorebook_entry_update`, `lorebook_entry_remove`).

For Workbench integration, Luker also ships built-in `card` and `world` iterate targets under `public/scripts/workbench/targets/`, while CEA continues to own the standalone **Open Editor** popup, the **World Info Sync** merge dialog on character replacement, and **CardApp Studio**.

## Shared lorebook & preset tool helpers

Cross-plugin iteration surfaces (including Workbench targets for Orchestrator and Memory Graph) read and write lorebooks directly through `context.iterationLibrary.tools` rather than importing from `character-editor-assistant/`:

- `LOREBOOK_READ_TOOL_DEFS` / `isLorebookReadTool` / `runLorebookReadTool` (`world_book_list`, `lorebook_list`, `lorebook_query`, `lorebook_get`)
- `LOREBOOK_WRITE_TOOL_DEFS` / `isLorebookWriteTool` / `runLorebookWriteTool` / `applyLorebookProposal`
- `CHARACTER_PRESET_READ_TOOL_DEFS` / `isCharacterPresetReadTool` / `runCharacterPresetReadTool`

Inside `extensions/character-editor-assistant/main.js`, `buildCharacterEditorHelperApis`, `runCharacterEditorHelperToolCall`, and `applyCharacterEditorLorebookProposal` remain exported for CEA's own popup and replace-merge flows.

## Related pages

- [Workbench API](/development/extension-api/workbench) — register AI iteration targets in Workbench
- [Iteration Library](/development/extension-api/iteration-studio) — shared `iteration-library/*` tools, runner, and proposal bus
- [Edits Library](/development/extension-api/edits-lib) — custom ops (`lorebook_entry_*`, `cardapp_*`)
- [Memory Graph Extension API](/development/extension-api/memory-graph) — memory-graph read/write APIs
