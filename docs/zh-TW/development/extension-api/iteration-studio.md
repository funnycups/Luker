# 迭代工作台框架

一個共享的彈窗外殼，用於 **AI 驅動地迭代式編輯由適配器提供的工件**。外殼負責對話、工具分發、感知漂移的應用、歷史列表和批准 / 拒絕 UI；插件透過適配器提供「編輯什麼、哪些工具能提出變更、會話存儲在哪」。

倉庫內有兩份參考適配器：

- `public/scripts/extensions/orchestrator/iteration-adapter.js` —— 編輯編排器 profile（spec / agenda / loop）
- `public/scripts/extensions/memory-graph/schema-adapter.js` —— 編輯記憶圖節點類型 schema

本頁是契約和構建自己適配器的 walkthrough。

## 它是什麼

一個迭代工作台會話，是用戶與 LLM 之間的彈窗對話，LLM 輸出**描述編輯動作的工具呼叫**。每一輪：

1. 用戶輸入請求並點擊發送。
2. 外殼帶著適配器的工具集(外加適配器自己宣告的任何控制工具)請求 LLM。
3. 對每個返回的工具呼叫,適配器將其歸一化為一組 op 類型化的 `Edit`(見 [edits-lib](./edits-lib.md))。
4. 外殼透過 edits 庫把編輯應用到 `adapter.live()`,在應用時逐條做漂移檢測。
5. 批准的變更透過 `adapter.commit(newLive)` 提交回去。
6. 只要這一輪發出過任何工具呼叫,外殼就會自動續到下一輪(程式按工具呼叫是否存在判定)。一旦 AI 改回純文字、不再發工具,迭代就結束,控制權回到用戶。

外殼不持有工件的工作副本。`adapter.live()` 是唯一權威源，外殼每次需要當前值時都重新呼叫它。

**迭代工作台不合適的時候：** 如果你的介面需要 viewport 所有權（全屏 IDE、行動端接管），或者已經有一套成熟的獨立 UI 想保留，直接用 [edits-lib](./edits-lib.md) —— 從 `/scripts/lib/edits/index.js` import `applyEdits` / `inverseEdit` / `showConflictResolution`，自己控制 UI。CardApp Studio（`extensions/character-editor-assistant/studio/`）是倉庫內的參考實作。

## 快速上手：最小適配器

```js
import { defineAdapter, openIterationStudio } from '/scripts/iteration-studio/index.js';

const TOOL_SET = 'mything_set_value';

export function createMyThingAdapter({ readValue, writeValue, listMetas, loadMeta, saveMeta, deleteMeta }) {
    return defineAdapter({
        id: 'mything',
        title: 'My Thing Studio',
        mode: 'mything',
        layout: 'popup',
        i18n: (s) => s,
        i18nFormat: (s, ...args) => args.reduce((out, v, i) => out.split('${' + i + '}').join(String(v)), s),

        live: () => readValue(),
        commit: async (newLive) => { await writeValue(newLive); },
        sessionScope: () => 'global',

        listSessions: async () => listMetas(),
        loadSession: async (_scope, id) => loadMeta(id),
        saveSession: async (_scope, session) => saveMeta(session),
        deleteSession: async (_scope, id) => deleteMeta(id),

        buildSystemPrompt: () => 'You edit a single string. Call mything_set_value with the new value.',
        buildUserPrompt: (session, userText) => `[Current]\n${readValue()}\n\n[Request]\n${userText}`,

        buildToolCatalog: () => [{
            type: 'function',
            function: {
                name: TOOL_SET,
                description: 'Set the value.',
                parameters: {
                    type: 'object',
                    properties: { next: { type: 'string' } },
                    required: ['next'],
                    additionalProperties: false,
                },
            },
        }],
        normalizeToolCallToEdit: (call) => {
            if (call?.name !== TOOL_SET) return null;
            const next = String(call?.args?.next ?? '');
            return [{ op: 'set', path: '', oldValue: readValue(), newValue: next }];
        },

        renderMessageCard: (message) => `<div>${message.role}: ${message.content}</div>`,
        renderHistoryItem: (meta) => `<div>${meta.title}</div>`,
    });
}

await openIterationStudio(adapter, SillyTavern.getContext(), settings, document.body);
```

這就是完整適配器。外殼負責彈窗外觀、對話渲染、歷史列表、自動續寫、abort 接線、LLM 重試 / 超時、感知漂移的應用、衝突 UI 和回滾。

## 權威模型

`adapter.live()` 是唯一可信來源。

- 外殼不快取工作 profile。每次渲染和每次應用都重新呼叫 `live()`。
- `adapter.commit(newLive)` 是唯一寫入路徑。適配器決定寫到哪裡（擴展設置、角色狀態、IndexedDB、遠端 API 都行）。
- 漂移檢測**在應用時逐條**透過 edits 庫進行。若用戶在 LLM 提案與點擊批准之間從外部修改了工件，衝突會透過 `edits-lib` 標準衝突 UI 暴露出來。
- 回滾把訊息上 `appliedEdits` 陣列逆序送入 `inverseEdit(edit)`，再重新提交。

這意味著工件隨時可以在工作台之外被編輯。工作台只是眾多編輯器中的一個。

## 工具分發

`buildToolCatalog(session)` 返回適配器自己的可編輯工具加上自定義控制工具。外殼不再注入 continue / finalize 控制工具——多輪自動續輪由程式判定:這一輪發出過任意工具呼叫就續到下一輪,只回純文字不呼叫工具就停下來。如果你的適配器需要 popup 側控制工具(比如重置狀態、切模式),自行在 catalog 裡宣告,透過 `classifyToolCall` / `executeControlToolCall` 走和普通適配器特定控制工具一樣的路徑。

每個 LLM 工具呼叫先經過 `classifyToolCall(call)`(預設:不匹配適配器宣告的控制名的都是可編輯)。可編輯呼叫進入:

```ts
normalizeToolCallToEdit(call, { session, live }): Edit[] | null | Promise<Edit[] | null>
```

返回 op 類型化編輯(op 形態見 [edits-lib](./edits-lib.md))。返回 `null` 跳過此呼叫。

**sandbox-diff 模式** —— 當你已經有一個原地變更器時,這是快速 bootstrap 的方式:

1. 把 `live` 克隆成一個 sandbox profile。
2. 在 sandbox 上跑現有變更器。
3. 發射一條粗粒度的 `{ op: 'set', path: '', oldValue: live, newValue: sandbox }` 編輯。

兩個參考適配器都用此模式。它足夠上線,但產出 profile 級衝突(任何併發變更都會與整批衝突)。要做生產級衝突解決,應當把每個工具呼叫歸一化成逐欄位 op(`set` / `str_replace` / `list_insert` 等)。

適配器宣告的控制工具(重置、切模式等)透過 runner 的 `isControlCall` 謂詞路由到你的 `onControlCall` 處理函式,不走 normalize-to-edit 路徑。外殼把它們也算成「這一輪有工具呼叫」——任意控制工具發射都會觸發下一輪。

## Runner 設定

Runner 有三項影響每次 LLM 往返的旋鈕——重試次數、每分鐘請求數上限、串流傳輸。適配器透過 `getRunnerSettings` 接入：

```ts
getRunnerSettings(settings): RunnerSettings | null
```

`settings` 是你傳給 `openIterationStudio` 的那個物件。回傳形狀：

```ts
type RunnerSettings = {
    toolCallRetryMax?: number;       // 預設 0——工具呼叫畸形/缺失時的重試次數
    rpmLimit?: number;               // 預設 0——iteration-studio 共享的 RPM 上限（0 表示不限）
    useStreamingTransport?: boolean; // 預設 false——使用 generateTaskStream() 而非 generateTask()
};
```

回傳 `null` / `undefined` / `{}` 即採用全部預設值。外殼不會直接讀取你的 settings 欄位——只走這一個 hook。這樣每個適配器可以自由暴露自己的設定 UI（CPA 把三項全部暴露在面板上；CardApp Studio 只暴露 `useStreamingTransport`），外殼不需要知道你的儲存路徑。

## 會話存儲

適配器擁有會話持久化。四個鉤子：

```ts
listSessions(scope): Promise<SessionMeta[]>           // 最新在前
loadSession(scope, id): Promise<Session | null>
saveSession(scope, session): Promise<void>
deleteSession(scope, id): Promise<void>
```

`scope` 即 `sessionScope()` 的返回值。常見樣式：`'global'`、`'character_<avatar>'`、`'chat_<chatId>'`。

會話存到哪完全由你決定。典型模式：

- 全域 → 擴展設置桶：`extension_settings.my_extension.iterStudioSessions`
- 按角色 → `context.getCharacterState(avatar, 'my_ext_iter_sessions')`
- 按聊天 → chat metadata

會話形狀由外殼定義（見 `public/scripts/iteration-studio/adapter.js` 的 JSDoc typedef）。適配器可以把任意 blob 資料塞到 `session.surfaceState`。

## 佈局選擇

`layout: 'popup' | 'split'`。

- `'popup'` —— 單列對話。輸入區與歷史是堆疊的。適合工件預覽很短、或 diff 已經放在訊息卡裡的適配器。
- `'split'` —— 雙列對話 + 預覽面板。右側面板由 `renderPreviewPane(state)` 渲染。適合工件具有有意義的規範視圖（圖 schema、profile 樹、角色卡）、用戶希望與對話同時可見的場景。

外殼呼叫的插槽鉤子：

| 鉤子 | 何時 | 必需 |
|---|---|---|
| `renderMessageCard(message, state)` | 每條對話訊息 | 是 |
| `renderHistoryItem(meta)` | 歷史列表的每個會話 | 是 |
| `renderPreviewPane(state)` | `split` 佈局的右側面板 | `split` 必需 |
| `renderToolbarSlots(state)` | 工具欄額外 `{start, end}` HTML | 可選 |
| `handleAction(actionId, ctx)` | 彈窗內 `[data-iter-custom-action="<id>"]` 的任何點擊或 change | 可選 |

## 預覽面板

`renderPreviewPane(state) => string` 為 `split` 佈局回傳右側面板的 HTML。外殼每次 rerender（每次聊天 tick、busy 狀態切換、AI 工具呼叫等）都會整體替換預覽面板。適合：欄位摘要、tab 佔位、唯讀 diff 清單。如果轉接器持有需要在 rerender 之間存活的元件狀態（CodeMirror、圖表等），那塊介面應該放在迭代工作台外殼之外 —— 直接用 [edits-lib](./edits-lib.md)。

## 對比基準

適配器可以提供「與...對比」選擇器，從別處拉取一份快照與實時數據並排渲染。兩個鉤子：

```ts
listReferences(session): { id: string, label: string }[]
loadReference(id): Promise<any>
```

外殼在工具欄顯示下拉選單，用戶選擇時呼叫 `loadReference(id)`，結果透過 `state.reference` 傳給渲染鉤子。兩個都省略則整個選擇器隱藏。

## 自定義 op

外殼每次呼叫 `openIterationStudio()` 時會觸發一次 `adapter.registerCustomOps?.(registry)`。`registry` 是對 edits-lib 引擎 `registerOp` 的封裝，帶 `getRegisteredOp` 守衛，所以重新開啟彈窗不會重複註冊（也不會因重複註冊而失敗）。需要 schema 專屬 op 的適配器在此註冊。

範例 —— CEA 的世界書條目自定義 op：

```js
import {
    createLorebookEntryAddOp,
    createLorebookEntryUpdateOp,
    createLorebookEntryRemoveOp,
} from './lorebook-ops.js';

registerCustomOps: (registry) => {
    registry.registerOp('lorebook_entry_add', createLorebookEntryAddOp());
    registry.registerOp('lorebook_entry_update', createLorebookEntryUpdateOp());
    registry.registerOp('lorebook_entry_remove', createLorebookEntryRemoveOp());
},
```

每個 handler 實作 `{ apply, inverse, detectConflict }` —— 完整 op 契約見 [edits-lib](./edits-lib.md)。當條目以非陣列索引的方式（如世界書 `uid`）作為鍵時使用自定義 op；這種場景下內建 `list_*` op 會在重新排序時悄然漂移。

## 遷移：clearObsoleteSessions

```ts
clearObsoleteSessions?(scope): Promise<void>
```

一個一次性鉤子，外殼在升級後首次打開時按適配器呼叫一次。用它清掉舊的 v1 存儲 key（外殼在 localStorage 中記錄按適配器的清理標記，因此只跑一次）。兩個參考適配器都實現了它，用來丟掉 v1 歷史桶：

```js
clearObsoleteSessions: async () => {
    const root = getMySettings();
    if (root && Object.prototype.hasOwnProperty.call(root, LEGACY_GLOBAL_HISTORY_KEY)) {
        delete root[LEGACY_GLOBAL_HISTORY_KEY];
        persistSettings();
    }
}
```

無需遷移則省略該鉤子。

## 三層 API 暴露

按 Luker API 約定，外殼每個能力都在三層暴露 —— 與 `edits-lib` 一致：

```js
// Layer 1 —— 直接 ESM import（倉庫內擴展）
import { openIterationStudio, defineAdapter } from '/scripts/iteration-studio/index.js';

// Layer 2 —— lukerContext 屬性（持有 context 的 CardApp / 擴展程式碼）
const { openIterationStudio, defineAdapter } = lukerContext.iterationStudio;

// Layer 3 —— getContext（第三方擴展）
const { open, defineAdapter } = SillyTavern.getContext().iterationStudio;
```

Layer 3 表面重新匯出與 Layer 1 相同的函式；`open` 是 `openIterationStudio` 的短別名。

## 參考適配器

閱讀這些檔案可以看到契約的端到端樣例：

- `public/scripts/extensions/orchestrator/iteration-adapter.js` —— 用 sandbox-diff 模式包裹編排器既有的變更器。佈局 `split`、按 mode 分桶的會話、執行時 world-info 解析、自定義控制工具名。
- `public/scripts/extensions/memory-graph/schema-adapter.js` —— 直接基於 v2 契約構建的節點類型 schema 編輯器。佈局 `split`、僅全域會話、預覽面板裡有「應用到全域」/「應用到角色」動作按鈕。
- **CEA 角色編輯器** —— `public/scripts/extensions/character-editor-assistant/character-editor-adapter.js`，佈局 `split`、按角色範圍 `char_<avatar>`。即時資料結構為 `{ card, lorebook: { bookName, entries: { [uid]: entry } } }`。透過 `mergeCharacterAttributes` 編輯角色卡欄位，透過 `context.saveWorldInfo` 編輯世界書。註冊 3 個以條目 uid 為鍵的自定義 op（`lorebook_entry_add / update / remove`）。
- **CPA（補全預設助手）** —— `public/scripts/extensions/completion-preset-assistant/cpa-iteration/`（studio 透過 `openCpaIterationStudio` 自掛為 popup，獨立於分層 `iterationStudio` open / defineAdapter 契約）。按預設範圍 `preset_<name>`。即時目標是使用者當前選擇的 OpenAI 預設（透過 `context.presets.get`）；`commit()` 透過 `context.presets.save(..., { select: true })` 寫回。工具集為 15 個可編輯預設操作 + 5 個唯讀檢查工具 + 12 個 Skills 編寫工具（清單 + 寫入 + 逐字擷取，僅在會話模式為 `orchestrator-optimize` 時暴露，直接重用編排器側 `skill-iter-studio-tools.js` 的註冊表）。無預覽面板——聊天中的每則訊息編輯摘要即為差異顯示。

適配器契約 JSDoc 位於 `public/scripts/iteration-studio/adapter.js` —— 該檔案是必需 vs 可選欄位與精確簽名的規範來源。
