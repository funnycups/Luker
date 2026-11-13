# 角色卡編輯助手 API

`character-editor-assistant`（CEA）擴充提供角色卡、世界書與 CardApp 的 AI 輔助編輯能力。其獨立彈窗（`editor-ui.js`）和 CardApp Studio（`studio/`）結合了 `context.iterationLibrary.tools` 中的外掛無關工具集，以及 CEA 自有的角色卡欄位工具和自訂 `edits-lib` op（`cardapp_patch_file`、`cardapp_rename_file`、`lorebook_entry_add`、`lorebook_entry_update`、`lorebook_entry_remove`）。

在工作台整合方面，Luker 內建了位於 `public/scripts/workbench/targets/` 下的 `card` 與 `world` 迭代目標；CEA 則繼續負責獨立的**開啟編輯器**彈窗、角色卡取代時的**世界書同步**合併對話框以及 **CardApp Studio**。

## 共享的世界書與預設工具輔助模組

跨外掛迭代介面（包括工作台中的編排與記憶圖迭代目標）直接透過 `context.iterationLibrary.tools` 讀寫世界書，而無需跨外掛匯入 `character-editor-assistant/`：

- `LOREBOOK_READ_TOOL_DEFS` / `isLorebookReadTool` / `runLorebookReadTool`（`world_book_list`、`lorebook_list`、`lorebook_query`、`lorebook_get`）
- `LOREBOOK_WRITE_TOOL_DEFS` / `isLorebookWriteTool` / `runLorebookWriteTool` / `applyLorebookProposal`
- `CHARACTER_PRESET_READ_TOOL_DEFS` / `isCharacterPresetReadTool` / `runCharacterPresetReadTool`

`extensions/character-editor-assistant/main.js` 中的 `buildCharacterEditorHelperApis`、`runCharacterEditorHelperToolCall` 與 `applyCharacterEditorLorebookProposal` 仍供 CEA 自身的彈窗和取代合併流程呼叫。

## 相關頁面

- [工作台 API](/zh-TW/development/extension-api/workbench) —— 向工作台註冊 AI 迭代目標
- [迭代工具函式庫](/zh-TW/development/extension-api/iteration-studio) —— 共享 `iteration-library/*` 工具、runner 與提案匯流排
- [Edits 函式庫](/zh-TW/development/extension-api/edits-lib) —— 自訂 op（`lorebook_entry_*`、`cardapp_*`）
- [記憶圖擴充 API](/zh-TW/development/extension-api/memory-graph) —— 記憶圖讀寫介面
