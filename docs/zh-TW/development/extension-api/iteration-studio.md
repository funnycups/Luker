# 迭代工作台框架

一個共享的彈窗外殼，用於 **AI 驅動地迭代式編輯由適配器提供的工件**。外殼負責對話、工具分發、感知漂移的應用、歷史列表和批准 / 拒絕 UI；插件透過適配器提供「編輯什麼、哪些工具能提出變更、會話存儲在哪」。

倉庫內有兩份參考適配器：

- `public/scripts/extensions/orchestrator/iteration-adapter.js` —— 編輯編排器 profile（spec / agenda / loop）
- `public/scripts/extensions/memory-graph/schema-adapter.js` —— 編輯記憶圖節點類型 schema

本頁是契約和構建自己適配器的 walkthrough。

## 它是什麼

一個迭代工作台會話，是用戶與 LLM 之間的彈窗對話，LLM 輸出**描述編輯動作的工具呼叫**。每一輪：

1. 用戶輸入請求並點擊發送。
2. 外殼帶著適配器的工具集（外加外殼自動注入的 `continue` / `finalize` 控制工具）請求 LLM。
3. 對每個返回的工具呼叫，適配器將其歸一化為一組 op 類型化的 `Edit`（見 `edits-lib.md`）。
4. 外殼透過 edits 庫把編輯應用到 `adapter.live()`，在應用時逐條做漂移檢測。
5. 批准的變更透過 `adapter.commit(newLive)` 提交回去。
6. 若 LLM 標記了 `continueRequested`，外殼帶著自動續寫 prompt 進入下一輪。

外殼不持有工件的工作副本。`adapter.live()` 是唯一權威源，外殼每次需要當前值時都重新呼叫它。

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

`buildToolCatalog(session)` 只返回適配器自己的可編輯工具加上自定義控制工具。外殼自動注入兩個控制工具：

| 工具 | 預設名 | 效果 |
|---|---|---|
| Continue | `iter_continue` | 用自動續寫 prompt 再跑一輪 LLM。 |
| Finalize | `iter_finalize` | 乾淨結束迭代，附帶總結。 |

如果需要命名空間隔離，可透過 `controlToolNames: { continue, finalize }` 覆寫預設值（兩個參考適配器都覆寫了 —— `luker_orch_continue_iteration`、`luker_mg_schema_continue_iteration` 等）。

每個 LLM 工具呼叫先經過 `classifyToolCall(call)`（預設：不匹配控制名的都是可編輯）。可編輯呼叫進入：

```ts
normalizeToolCallToEdit(call, { session, live }): Edit[] | null | Promise<Edit[] | null>
```

返回 op 類型化編輯（op 形態見 `edits-lib.md`）。返回 `null` 跳過此呼叫。

**sandbox-diff 模式** —— 當你已經有一個原地變更器時，這是快速 bootstrap 的方式：

1. 把 `live` 克隆成一個 sandbox profile。
2. 在 sandbox 上跑現有變更器。
3. 發射一條粗粒度的 `{ op: 'set', path: '', oldValue: live, newValue: sandbox }` 編輯。

兩個參考適配器都用此模式。它足夠上線，但產出 profile 級衝突（任何併發變更都會與整批衝突）。要做生產級衝突解決，應當把每個工具呼叫歸一化成逐欄位 op（`set` / `str_replace` / `list_insert` 等）。

控制工具（continue / finalize）由外殼直接處理。僅當你想在 continue 或 finalize 上加額外行為時，才覆寫 `executeControlToolCall(call, ctx, signal)`。

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
| `handleAction(actionId, ctx)` | 彈窗內 `[data-iter-action="<id>"]` 的任何點擊 | 可選 |

## 對比基準

適配器可以提供「與...對比」選擇器，從別處拉取一份快照與實時數據並排渲染。兩個鉤子：

```ts
listReferences(session): { id: string, label: string }[]
loadReference(id): Promise<any>
```

外殼在工具欄顯示下拉選單，用戶選擇時呼叫 `loadReference(id)`，結果透過 `state.reference` 傳給渲染鉤子。兩個都省略則整個選擇器隱藏。

## 自定義 op

edits-lib 的 8 個內建 op（`set` / `unset` / `str_*` / `list_*`）覆蓋大多數場景。對於面向特定表面的變更，適配器可以宣告 `registerCustomOps(registry)` 鉤子；registry 接受與 edits-lib 相同形態的 `registerOp(name, handler)`。

SP-1 階段，由於 sandbox-diff 模式讓參考適配器只在 path `''` 上發射 `set`，無需自定義 op。當升級到逐欄位歸一化、發現某個內建 op 不適合某種領域變更（如 `graph.node.add`、`preset.entry.move`）時，直接用 `registerOp` —— handler 契約見 `edits-lib.md`。

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
- `public/scripts/extensions/character-editor-assistant/studio/adapter.js` —— 卡片應用工作室、按角色的自訂前端編輯器。佈局 `split`、按角色範圍 `char_<avatar>`。即時預覽是彈窗背後的宿主卡片應用（透過 `card-app` 擴充功能 API 重新載入）；轉接器在右側面板呈現檔案樹和 CM6 編輯器。所有檔案 CRUD 均透過現有的 `fetchFileList / saveFileContent / deleteFile / renameFile` 輔助函式完成；4 個寫工具走 `normalizeToolCallToEdit`、2 個讀工具走 `executeControlToolCall`。

適配器契約 JSDoc 位於 `public/scripts/iteration-studio/adapter.js` —— 該檔案是必需 vs 可選欄位與精確簽名的規範來源。
