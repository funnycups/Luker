# 迭代工具函式庫（Iteration Library）

`context.iterationLibrary` 為 AI 驅動的迭代式編輯介面提供共享基礎設施：LLM 工具呼叫 runner、依作用域隔離的會話儲存、詞級 / 行級文字 diff、全螢幕縮放對比浮層、統一提案匯流排（`proposalBus`），以及與外掛解耦的世界書 / 技能 / 預設讀寫工具集。

如果希望將可迭代編輯的目標直接接入 Luker 統一的**工作台 → AI 迭代**分頁，請使用 [`context.workbench.registerIterateTarget`](/zh-TW/development/extension-api/workbench#註冊-ai-迭代目標)。當外掛需要保留獨立彈窗或全螢幕 IDE 介面（例如角色卡編輯彈窗或 CardApp Studio）時，可以直接呼叫 `context.iterationLibrary`。

## 三層 API 暴露

```js
// Layer 1 —— 直接 ESM import（倉庫內擴充功能）
import {
    applyEdits,
    inverseEdit,
    registerOp,
    runner,
    storage,
    proposalBus,
    tools,
} from '/scripts/iteration-library/index.js';

// Layer 2 —— lukerContext 屬性
const { runner, storage, proposalBus } = lukerContext.iterationLibrary;

// Layer 3 —— Luker.getContext()（第三方擴充功能）
const { applyEdits, runner, storage, textDiff, zoomOverlay, ui, tools, proposalBus } =
    Luker.getContext().iterationLibrary;
```

## 核心模組

| 匯出項 | 用途 |
| --- | --- |
| `applyEdits`、`inverseEdit`、`registerOp`、`BUILT_IN_OPS`、`showConflictResolution` | 從 [Edits 函式庫](/zh-TW/development/extension-api/edits-lib) 重新匯出，用於感知漂移的套用、復原與衝突解決 |
| `runner` | `requestToolCallsWithRetry` 與通用 LLM 輪次執行輔助函式 |
| `storage` | 依作用域隔離的會話持久化、安全深層複製及角色 / 全域狀態讀寫輔助 |
| `proposalBus` | `createProposalBus` 與內建提案配接器：`profileEdit`、`lorebookWrite`、`skillAuthor`、`presetClone`、`customToolAuthor` |
| `tools` | 與具體外掛解耦的工具定義與分發器（`lorebook-reads`、`lorebook-writes`、`character-presets-reads`、`skill-iter-studio`） |
| `render`、`textDiff`、`zoomOverlay`、`ui` | 差異卡片、逐行並排對比浮層、訊息 Markdown 渲染與可折疊思考區塊 |
| `bindIterWorkspaceResizer` | 分欄拖曳調整器（Layer 1 `/scripts/iteration-library/index.js` 還額外匯出 `createRenderScheduler`） |

## 參考消費方

- **工作台迭代目標**（`public/scripts/workbench/targets/` 以及 `orchestrator/lens/iterate-target.js`、`memory-graph/lens/iterate-targets.js`）—— 重用 `proposalBus`、`tools` 與 `storage` 輔助能力，同時由工作台統一託管視窗、目標切換和改動記錄。
- **CardApp Studio 與角色卡編輯彈窗**（`public/scripts/extensions/character-editor-assistant/`）—— 自行管理獨立介面，並呼叫 `iterationLibrary` 處理工具重試、世界書工具、差異渲染及 `edits-lib` 套用與復原。

## 相關頁面

- [工作台 API](/zh-TW/development/extension-api/workbench) —— 向工作台註冊 AI 迭代目標
- [Edits 函式庫](/zh-TW/development/extension-api/edits-lib) —— 基於 op 的修補引擎與衝突解決
- [角色卡編輯助手 API](/zh-TW/development/extension-api/character-editor-assistant) —— 角色卡與世界書修改輔助工具
