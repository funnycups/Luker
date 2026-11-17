# 執行面板

## 它是什麼

一個可重用的記憶體內執行軌跡，供任何執行多步 LLM 任務的外掛使用。外掛把輪次、串流分節、工具呼叫和 token 用量寫入 `RunStore`，再掛載到 Luker 共享的**執行面板**懸浮窗（`attachDock`），也可以透過 `createRunPanel` 建立獨立面板。

共享懸浮窗在桌面端顯示為可拖曳、可縮放的浮動視窗（閒置或收起時摺疊為狀態膠囊），窄螢幕下轉為底部抽屜，提供輪次卡片、串流內容、停止按鈕、JSON 軌跡匯出，以及跳轉至[工作台](/zh-TW/development/extension-api/workbench)檢視詳情或 AI 診斷的鉤子。

共享層位於 `public/scripts/run-panel/`，在 Luker context 上暴露為 `runPanel`。倉庫內消費方：

- 編排器 —— `public/scripts/extensions/orchestrator/lens/index.js`
- 搜尋工具 —— `public/scripts/extensions/search-tools/run-panel.js`

![搜尋 Agent 在共享面板中的執行](/images/search-tools/run-panel.png)

## 快速上手（共享執行面板）

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

透過寫入 store 驅動面板：

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

在選單項目或按鈕中呼叫 `await openRunDock()` 或 `await toggleRunDock()` 即可按需開啟。

## 儲存 API

`createRunStore()` 返回一個隔離的 store。每次呼叫都會產生一個獨立實例，因此兩個外掛不會共享執行狀態或產生衝突。

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

`quiet: true` 只填充 store 而不自動開啟面板；之後呼叫 `openRunDock()`（或 `panel.open()`）即可顯示。

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

## 共享懸浮窗與記錄器 API

| 函式 | 用途 |
| --- | --- |
| `attachDock(store, opts)` | 把 `RunStore` 掛載到共享記錄器與懸浮執行面板（`{ source, getRunContext, getFlow, onInspect, onDiagnose }`）。 |
| `openRunDock()` | 確保並開啟共享執行面板。 |
| `toggleRunDock()` | 切換共享執行面板的開啟與關閉狀態。 |
| `getRunRecorder()` | 返回按帳號儲存近期執行歷史的共享記錄器。 |

使用者可以在懸浮窗選單中直接切換**執行時自動開啟**（預設開啟；關閉後非 quiet 執行僅顯示狀態膠囊，不會自動展開）。

## 獨立 `createRunPanel` 選項

若需要獨立於共享懸浮窗的自訂面板，`createRunPanel(options)` 返回 `{ init, open, destroy }`：

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
import { createRunStore, attachDock, openRunDock } from '/scripts/run-panel/index.js';

// Layer 2 —— lukerContext 屬性
const { createRunStore, attachDock, openRunDock } = lukerContext.runPanel;

// Layer 3 —— getContext（第三方擴充功能）
const { createRunStore, attachDock, openRunDock } = Luker.getContext().runPanel;
```

## 參考消費方

- 編排器在 `public/scripts/extensions/orchestrator/lens/index.js` 將其 `RunStore` 掛載到共享執行面板，將**檢視執行詳情**接入工作台（`ws: 'orch', subview: 'run'`），將 **AI 診斷**接入工作台（`page: 'ai', ws: 'orch'`）。
- 搜尋工具在 `public/scripts/extensions/search-tools/run-panel.js` 將其 `RunStore` 掛載到共享執行面板（`source: 'search'`）。
