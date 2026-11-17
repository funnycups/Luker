# 角色卡编辑助手 API

`character-editor-assistant`（CEA）扩展提供角色卡、世界书与 CardApp 的 AI 辅助编辑能力。其独立弹窗（`editor-ui.js`）和 CardApp Studio（`studio/`）结合了 `context.iterationLibrary.tools` 中的插件无关工具集，以及 CEA 自有的角色卡字段工具和自定义 `edits-lib` op（`cardapp_patch_file`、`cardapp_rename_file`、`lorebook_entry_add`、`lorebook_entry_update`、`lorebook_entry_remove`）。

在工作台集成方面，Luker 内置了位于 `public/scripts/workbench/targets/` 下的 `card` 与 `world` 迭代目标；CEA 则继续负责独立的**打开编辑器**弹窗、角色卡替换时的**世界书同步**合并对话框以及 **CardApp Studio**。

## 共享的世界书与预设工具辅助模块

跨插件迭代界面（包括工作台中的编排与记忆图迭代目标）直接通过 `context.iterationLibrary.tools` 读写世界书，而无需跨插件导入 `character-editor-assistant/`：

- `LOREBOOK_READ_TOOL_DEFS` / `isLorebookReadTool` / `runLorebookReadTool`（`world_book_list`、`lorebook_list`、`lorebook_query`、`lorebook_get`）
- `LOREBOOK_WRITE_TOOL_DEFS` / `isLorebookWriteTool` / `runLorebookWriteTool` / `applyLorebookProposal`
- `CHARACTER_PRESET_READ_TOOL_DEFS` / `isCharacterPresetReadTool` / `runCharacterPresetReadTool`

`extensions/character-editor-assistant/main.js` 中的 `buildCharacterEditorHelperApis`、`runCharacterEditorHelperToolCall` 与 `applyCharacterEditorLorebookProposal` 仍供 CEA 自身的弹窗和替换合并流程调用。

## 相关页面

- [工作台 API](/zh-CN/development/extension-api/workbench) —— 向工作台注册 AI 迭代目标
- [迭代工具库](/zh-CN/development/extension-api/iteration-studio) —— 共享 `iteration-library/*` 工具、runner 与提案总线
- [Edits 库](/zh-CN/development/extension-api/edits-lib) —— 自定义 op（`lorebook_entry_*`、`cardapp_*`）
- [记忆图扩展 API](/zh-CN/development/extension-api/memory-graph) —— 记忆图读写接口
