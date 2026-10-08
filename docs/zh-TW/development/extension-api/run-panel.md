# 執行面板

## 它是什麼

一個可重用的記憶體內執行軌跡，供任何執行多步 LLM 任務的外掛使用。它會在聊天區旁渲染一塊滑入式面板（窄屏下改為底部抽屜），每一輪是一張可折疊的卡片，分節內容串流填充，附帶停止按鈕與匯出動作，執行進行中還會顯示一枚懸浮膠囊。

共享層位於 `public/scripts/run-panel/`，在 Luker context 上暴露為 `runPanel`。倉庫內消費方：

- 編排器 —— `public/scripts/extensions/orchestrator/run-panel/panel.js`

## 快速上手

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

這就是完整的整合方式。透過寫入 store 驅動面板：

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

## 儲存 API

`createRunStore()` 返回一個隔離的 store。每次呼叫都會產生一個獨立實例，因此兩個外掛絕不會共享執行狀態或產生衝突。

| 方法 | 用途 |
| --- | --- |
| `subscribe(listener)` | 訂閱事件；返回一個取消訂閱函式。 |
| `getCurrentRun()` | 當前執行物件，無則為 `null`。 |
| `startRun({ mode, chatKey, abortFn, stopFn, quiet })` | 開始一次執行；返回 `runId`。若該 store 已有執行中的執行則拋出錯誤。 |
| `clearCurrentRun()` | 丟棄當前執行並發出 `run_cleared`。 |
| `appendRound({ runId, round: { id, label } })` | 新增一輪；返回 `roundId`。 |
| `setRoundStatus({ runId, roundId, status })` | 更新輪次狀態。 |
| `ensureSection({ runId, roundId, section: { id, kind, title, meta } })` | 分節不存在時建立；返回 `sectionId`。 |
| `appendToSection({ runId, roundId, sectionId, delta })` | 向分節正文追加串流文字。 |
| `setSectionStatus({ runId, roundId, sectionId, status, meta })` | 更新分節狀態。 |
| `finishRun({ runId, status, finalText, error })` | 結束執行。 |
| `setRunMeta({ runId, tokensSpent, cost })` | 設定執行級中繼資料。 |
| `addTokenUsage({ runId, usage })` | 把 LLM 用量物件累加進執行中的 token 總數。 |

`quiet: true` 只填充 store 而不自動開啟面板；之後呼叫 `panel.open()` 即可顯示。

## 事件

監聽器接收 `{ type, ... }` 負載。常數從 `run-panel/events.js` 匯出（也可透過 `context.runPanel.events` 存取）。

| 事件 | 負載 |
| --- | --- |
| `run_started` | `runId`、`mode`、`quiet` |
| `round_appended` | `runId`、`roundId` |
| `section_ensured` | `runId`、`roundId`、`sectionId` |
| `section_appended` | `runId`、`roundId`、`sectionId`、`delta` |
| `section_status` | `runId`、`roundId`、`sectionId`、`status`、`meta` |
| `round_status` | `runId`、`roundId`、`status` |
| `run_meta` | `runId` |
| `run_finished` | `runId`、`status` |
| `run_cleared` | `runId` |

## 面板選項

`createRunPanel(options)` 返回 `{ init, open, destroy }`。

| 選項 | 預設值 | 用途 |
| --- | --- | --- |
| `store` | 必需 | 來自 `createRunStore()` 的 store。 |
| `t` | 恆等函式 | 翻譯函式 `(template, ...args) => string`。 |
| `idPrefix` | `luker-run-panel` | DOM id 前綴；面板根為 `#<idPrefix>`，懸浮膠囊為 `#<idPrefix>-pill`。 |
| `stylesheetUrl` | 共享的 `panel.css` | 要注入的樣式表。 |
| `kindIcons` | `DEFAULT_KIND_ICONS` | 分節類型到圖示的對映。 |
| `defaultCollapsedKinds` | `[]` | 預設折疊渲染的分節類型。 |
| `modeLabels` | `{}` | mode 到徽章文字的對映；缺失時回退為原始 mode。 |
| `exportFilename` | `run-<runId>-<mode>.json` | 匯出動作的檔名。 |
| `autoOpen` | `true` | 非 quiet 的 `run_started` 時自動開啟。 |
| `emptyStateText` | 一段預設提示 | 無執行時 `open()` 顯示的文案。 |
| `onStop` | `null` | 覆寫停止處理器。 |

## 輔助函式

以下便捷封裝層用於終結輪次與分節狀態。首個參數為 store 實例，因此可用於任意 store。

| 輔助函式 | 用途 |
| --- | --- |
| `withRound(store, runId, { id, label }, fn)` | 追加輪次、執行 `fn(roundId)`，隨後將輪次標記為 `done`；拋出錯誤時標記為 `failed`。返回 `fn` 的結果；返回 Promise 時，在其落定後終結該輪次。 |
| `withStreamingSection(store, runId, roundId, { id, kind, title }, asyncFn)` | 確保分節存在，將 `append(delta)` 函式與分節 id 傳給 `asyncFn`，隨後將分節標記為 `done`；拋出錯誤時標記為 `failed`。 |

## 三層 API 暴露

```js
// Layer 1 —— 直接 ESM import（倉庫內擴充功能）
import { createRunStore, createRunPanel } from '/scripts/run-panel/index.js';

// Layer 2 —— lukerContext 屬性
const { createRunPanel } = lukerContext.runPanel;

// Layer 3 —— getContext（第三方擴充功能）
const { createRunStore } = SillyTavern.getContext().runPanel;
```

## 參考消費方

- 編排器執行時寫入輪次與分節，面板在每次執行時自動開啟：`public/scripts/extensions/orchestrator/loop-runtime.js`、`director-runtime.js`、`agenda-runtime.js`、`spec-runtime.js`。
- 編排器封裝層設定 i18n 與匯出檔名：`public/scripts/extensions/orchestrator/run-panel/panel.js`。
