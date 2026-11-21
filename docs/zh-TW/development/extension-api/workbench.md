# 工作台 API

`context.workbench` 暴露 Luker 統一工作台的註冊表與導航執行時。擴充功能可以透過它註冊嵌入式工作區、AI 迭代目標、問答唯讀資料來源與本機建議規則，無需直接匯入工作台內部檔案或跨外掛耦合。

倉庫內參考實作：

- `public/scripts/extensions/memory-graph/lens/index.js` —— 工作區（`'memory'`）、AskProvider、SuggestRuleProvider，以及 `'memory'` / `'memory_graph'` 迭代目標
- `public/scripts/extensions/orchestrator/lens/index.js` —— 工作區（`'orch'`）、AskProvider、SuggestRuleProvider，以及 `'orch'` 迭代目標
- `public/scripts/extensions/stable-diffusion/lens/index.js` —— 工作區（`'sd'`）、AskProvider、SuggestRuleProvider，以及 `'sd'` 迭代目標
- `public/scripts/workbench/targets/{preset,card,world}.js` —— 內建 `'preset'`、`'card'` 與 `'world'` 迭代目標

## 三層 API 暴露

```js
// Layer 1 —— 直接 ESM import（倉庫內擴充功能）
import {
    registerWorkspace,
    registerIterateTarget,
    registerAskProvider,
    registerSuggestRuleProvider,
    open,
} from '/scripts/workbench/registry.js';

// Layer 2 —— lukerContext 屬性
const { registerWorkspace, open } = lukerContext.workbench;

// Layer 3 —— Luker.getContext()（第三方擴充功能）
const { registerWorkspace, registerIterateTarget, open } = Luker.getContext().workbench;
```

所有 `register*` 方法均與載入順序無關，並依 `id` 冪等（重複註冊相同 `id` 會取代舊定義並保留排序槽位），回傳值均為帶唯一權杖校驗的 `unregister()` 清理函式。

## 開啟與導航

```ts
workbench.open(opts?: {
    page?: 'home' | 'ask' | 'ai' | 'hist' | 'settings' | `ws:${string}`;
    ws?: string;       // 工作區 id（導航至 ws:<id>），或在 page === 'ai' 時指定迭代目標 id
    subview?: string;  // 工作區子視圖，例如 'run'、'graph'、'schema'
    runKey?: string;   // 例如 'orchestrator:<runId>'，跳轉至特定執行記錄
    scope?: string;    // 例如 'global' | 'character' | 'preset' | 'chat'
    draft?: string;    // 開啟 page: 'ai' 時預填的輸入框文字
}): Promise<WorkbenchHandle | null>
```

在工作台 UI 掛載完成前發起的 `open()` 會自動排隊，待啟動時 `setOpenHandler` 就緒後依序執行。

## 註冊嵌入式工作區

`registerWorkspace(def)` 在工作台左側欄核心頁面下方新增一個工作區分頁。

```js
const unregister = Luker.getContext().workbench.registerWorkspace({
    id: 'my-ext',
    title: 'My Workspace',
    icon: 'mark',        // 工作台內建圖示名稱或 DOM 節點
    order: 30,           // 側欄升序排列權重
    tone: 'other',       // 強調色權杖
    flush: true,         // 佔滿主內容區高度（取消外層內邊距）
    isEnabled: () => true,
    mount(container, { app, opts }) {
        const root = document.createElement('div');
        root.textContent = 'Workspace content';
        container.appendChild(root);
        return {
            show(showOpts) {},
            hide() {},
            update(nextOpts) {},
            onEscape() { return false; },
            onSnapshot() {},
            destroy() { root.remove(); },
        };
    },
});
```

`mount()` 在使用者首次切換至該工作區時按需執行，`destroy()` 在取消註冊或工作台卸載時呼叫。

## 註冊 AI 迭代目標

`registerIterateTarget(def)` 向 **AI 迭代**頁面（`page: 'ai'`）註冊一個可對話編輯的目標。

`targetDef` 核心欄位：

| 欄位 | 用途 |
| --- | --- |
| `id` | 唯一目標 id（`'memory'`、`'orch'`、`'preset'`、`'card'`、`'world'` 等） |
| `label` | 頂部目標切換器顯示的名稱（字串或 `() => string`） |
| `order` / `tone` | 排序權重與徽章色調 |
| `chips` | 可選，空會話時顯示的快捷範例陣列或 `() => string[]` |
| `scopes?(ctx)` | 非同步回傳 `{ global?, character?, preset?, chat? }` 可用性 |
| `scopeNotes` | 函式 `(scope, ctx) => string` 或映射 `{ [scope]: string \| (() => string) }`，顯示於作用域選擇器下方 |
| `isEnabled?(ctx)` | 可選的啟用條件檢查 |
| `getNativeAi?(ctx)` | 當工作台 AI 設定設為**跟隨外掛設定**時回傳 `{ connection, preset }` |
| `promptInfo?(ctx)` | 非同步回傳 `{ from, custom, text }`，供**設定 → 提示詞**顯示 |
| `load(scope, ctx)` | 讀取即時目標資料，回傳 `{ live, target, title }` |
| `tools(live, scope, ctx, { target })` | 回傳 OpenAI 風格的函式工具定義陣列（或 Promise） |
| `systemPrompt?(scope, live, { wrapper, ctx, target })` / `prompt?(live, scope, ctx, { wrapper, target })` | 目標專屬提示詞（`systemPrompt` 回傳完整系統提示詞；未提供時工作台會為 `prompt` 自動前置 `wrapper`） |
| `isRead(name)` | 回傳 `true` 表示唯讀工具，`false` 表示修改工具 |
| `runRead(call, live, helpers)` | 執行唯讀工具（`call` 為 `{ id, name, args }`） |
| `runEdit(call, live, helpers)` | 執行修改工具；回傳更新後的 `live` 或 `{ live, proposals }`，或透過 `helpers.propose(...)` 暫存提案 |
| `proposalKinds` | 可選 `ProposalBus` 配接器或內建類型名稱（`'profile-edit'`、`'lorebook-write'`、`'skill-author'`、`'preset-clone'`、`'custom-tool-author'`） |
| `units(data, targetRef)` | 單元投影，用於產生**改動清單**的差異項目 |
| `rebuild(base, ai, fieldKeys, targetRef)` | 基於 `base` 與使用者勾選的 `ai` 中 `fieldKeys` 重建待提交的 `next` |
| `commit(targetRef, base, next, fieldKeys)` | 將批准的修改寫回 Luker，回傳 `{ applied?, skipped?, failure?, undo() }` |
| `renderControls?({ live, scope, settings, onReload })` | 可選，對話區上方工具列控制項 DOM 節點 |
| `renderPreview?({ base, ai, target })` | 可選，右側即時預覽欄 DOM 節點 |

`runEdit` 作用於複製後的工作副本（`live`）或透過 `helpers.propose(...)` 將非欄位類提案暫存到 `ProposalBus`。當模型某一輪回傳零次工具呼叫時，迭代迴圈自動結束並將控制權交還使用者。

## 註冊問答資料來源

`registerAskProvider(def)` 向**總覽**與**問問**提供外掛的狀態快照、概覽卡片與唯讀工具：

```js
const unregister = Luker.getContext().workbench.registerAskProvider({
    id: 'my-ext',
    label: 'My Extension',
    tone: 'other',
    icon: 'mark',
    overviewKey: 'myExtension',
    order: 30,
    async getSnapshot(ctx) {
        return { installed: true, items: 12 };
    },
    async getOverview(ctx) {
        return { enabled: true, items: 12 };
    },
    getSideInfo(pSnap, snap) {
        return {
            label: 'My Extension',
            countText: pSnap ? `${pSnap.items} items` : 'Not present',
            status: pSnap ? 'ok' : 'warn',
        };
    },
    renderHomeCard(pSnap, { snap, warn, status, askBtn, wsBtn, workspace }) {
        return {
            tone: 'other',
            iconName: 'mark',
            name: 'My Extension',
            by: pSnap ? 'Enabled' : 'Not installed',
            pill: status('my-ext', Boolean(pSnap)),
            stats: pSnap ? [['Items', String(pSnap.items)]] : [],
            acts: [
                pSnap ? askBtn('my-ext') : null,
                workspace ? wsBtn(workspace) : null,
            ],
        };
    },
    tools: [{
        type: 'function',
        function: {
            name: 'wb_read_my_ext',
            description: 'Read read-only status from My Extension.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
    }],
    readers: {
        wb_read_my_ext: async (args, ctx) => ({ items: 12 }),
    },
});
```

`tools` 與 `readers` 中註冊到**問問**的工具必須嚴格唯讀，不產生任何狀態變更。

## 註冊本機建議規則

`registerSuggestRuleProvider(def)` 註冊在**總覽**展示、且可在**設定 → 小建議**中開關的零 AI 本機規則檢查：

```js
const unregister = Luker.getContext().workbench.registerSuggestRuleProvider({
    id: 'my-ext',
    tone: 'other',
    rules: [
        {
            id: 'my-ext.high-count',
            name: 'High item count',
            when: 'Item count exceeds 100',
            defaultOn: true,
            check(snap) {
                const count = snap?.providers?.['my-ext']?.items || 0;
                if (count <= 100) return null;
                return {
                    text: `${count} items in My Extension`,
                    why: 'Large lists slow down processing.',
                    source: 'Based on My Extension state',
                    sig: String(count),
                    actions: [
                        { kind: 'ai', ws: 'my-ext', label: 'Have the AI look', prompt: 'Review My Extension items.' },
                    ],
                };
            },
        },
    ],
});
```

`actions` 支援的動作形態：

- `{ kind: 'ai', label, ws, prompt, primary? }` —— 開啟對應目標 `ws` 的 **AI 迭代**並預填 `prompt`
- `{ kind: 'ask', label, question, primary? }` —— 開啟**問問**並預填 `question`
- `{ kind: 'session', label, sessionId, primary? }` —— 開啟已有的 **AI 迭代**會話
- `{ kind: 'setHorizon', label, value, primary? }` —— 調整記憶圖常駐注入最大回溯樓層數
- `{ label, run: async (app) => { ... }, primary? }` —— 執行接收工作台 `app` 句柄的自訂非同步回呼

## 查詢與訂閱

- `workbench.getWorkspaces({ enabledOnly? })`
- `workbench.getIterateTargets()`
- `workbench.getAskProviders()`
- `workbench.getSuggestRuleProviders()`
- `workbench.subscribe(listener)` —— 註冊表變更時觸發，回傳 `unsubscribe()`
- `workbench.saveSettingsChecked(ctx)` —— 重新整理儲存設定，失敗時拋出帶類型的錯誤
