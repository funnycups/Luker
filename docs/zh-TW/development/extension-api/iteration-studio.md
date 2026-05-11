# IterationStudio

一個共享的彈窗框架，用於 **AI 驅動地迭代式編輯一個典型工件**。Studio 負責對話、會話歷史、工具分發、diff 預覽、批准 / 拒絕生命週期；外掛透過 adapter 提供「工件長什麼樣、哪些工具能編輯、怎麼持久化」。

倉庫內有兩份參考實作：

- `public/scripts/extensions/orchestrator/iteration-adapter.js` — 編輯編排器 profile（spec / agenda / loop）
- `public/scripts/extensions/memory-graph/schema-adapter.js` — 編輯記憶圖節點類型 schema

本頁是契約和建構你自己 adapter 的 walkthrough。

## 心智模型

Shell 擁有**工作台外殼** —— 跨所有 studio 通用的部分：

- popup 生命週期（開啟 / 關閉、abort 接線、焦點）
- 對話面板（user / assistant 訊息、pending 審批塊）
- 輸入區（textarea + 發送 / 終止 / 清空 / Auto-apply 開關）
- 工具呼叫 round trip（透過 `context.generateTask` 呼叫 LLM,帶重試 / RPM / 逾時）
- 工具呼叫拆分（editable vs control）、pending vs 自動執行
- Auto-continue（AI 標記 `continueRequested` 時）
- Auto-apply（按 adapter 持久儲存的偏好，跳過審批步驟）
- 會話歷史列表 + 新建 / 載入 / 刪除
- profile delta 計算（jsondiffpatch）和渲染（自帶文本 diff + 放大 + 拖曳分欄）

Adapter 擁有**工件** —— 每個 studio 獨有的部分：

- `workingProfile` 的形狀（clone + sanitize）
- 初始 profile（從目前設定 / 角色卡覆寫讀出）
- prompt 建構（system + user + 可選的 auto-continue）
- 工具集 + 每個工具的執行（mutate `session.workingProfile`）
- 右側「工作 profile」預覽面板（HTML）
- 持久化（會話歷史的儲存路徑 + adapter 自訂的 apply 動作）

## 入口

**Layer 2（推薦第三方外掛使用）：**

```js
const ctx = SillyTavern.getContext();
const { open, defineAdapter, createSettingsBackedHistoryStore } = ctx.iterationStudio;
```

**Layer 1（倉庫內程式碼直接 import）：**

```js
import {
    open,
    defineAdapter,
    createSettingsBackedHistoryStore,
    buildProfileDelta,
    renderProfileDeltaHtml,
} from '/scripts/iteration-studio/index.js';
```

開啟 studio：

```js
const adapter = defineAdapter({ /* … 見下方契約 … */ });
await open(adapter, context, settings, root);
```

`open` 在使用者關閉 popup 之前一直 await。

## 快速上手 —— 最小可用 adapter

最簡單有用的 adapter，編輯外掛設定中的一個字串欄位：

```js
import { defineAdapter, createSettingsBackedHistoryStore, open as openIterationStudio } from '/scripts/iteration-studio/index.js';
import { i18n, i18nFormat } from './i18n.js';   // 你自己外掛的 i18n
import { escapeHtml } from '/scripts/utils.js';

const TOOL_SET = 'mything_set_value';

export function createMyThingAdapter() {
    return defineAdapter({
        id: 'mything',
        title: i18n('My Thing Studio'),
        mode: 'mything',
        i18n,
        i18nFormat,

        getInitialProfile(ctx, settings) {
            return { value: String(settings.myThingValue || '') };
        },
        cloneWorkingProfile(profile) {
            return { value: String(profile?.value ?? '') };
        },
        getDefaultScope(ctx) {
            return ctx.characterId != null ? 'character' : 'global';
        },

        // 內建 helper 處理常見的「全域 → settings、角色 → character state」模式
        ...createSettingsBackedHistoryStore({
            moduleName: 'my_extension',
            globalSettingsKey: 'iterationHistory',
            characterStateNamespace: 'my_ext_iteration_history',
        }),

        buildSystemPrompt() {
            return 'You edit a single string field. Call mything_set_value with the new value.';
        },
        buildUserPrompt(settings, session, text) {
            return `[Current]\n${session.workingProfile.value}\n\n[Request]\n${text}`;
        },

        buildEditableToolSet() {
            return [{
                type: 'function',
                function: {
                    name: TOOL_SET,
                    description: 'Set the value to a new string.',
                    parameters: {
                        type: 'object',
                        properties: { next: { type: 'string' } },
                        required: ['next'],
                        additionalProperties: false,
                    },
                },
            }];
        },
        async executeEditableToolCall(ctx, session, call) {
            const args = call?.args && typeof call.args === 'object' ? call.args : {};
            session.workingProfile.value = String(args.next ?? '');
            return {
                content: JSON.stringify({ ok: true }),
                action: i18n('Updated value'),
                changed: true,
            };
        },

        renderWorkingProfile(session) {
            return `
<div class="luker-studio-panel-title">${escapeHtml(i18n('Current value'))}</div>
<pre>${escapeHtml(session.workingProfile.value)}</pre>
<div class="luker-studio-composer-buttons">
    <div class="menu_button" data-iter-custom-action="apply">${escapeHtml(i18n('Apply'))}</div>
</div>`;
        },
        async handleAction(actionId, ctx) {
            if (actionId === 'apply') {
                ctx.settings.myThingValue = ctx.session.workingProfile.value;
                await SillyTavern.getContext().saveSettings();
            }
        },

        getRequestPresetOptions(settings) {
            return {
                apiPresetName: String(settings.myThingApiPresetName || '').trim(),
                llmPresetName: String(settings.myThingPresetName || '').trim(),
            };
        },
    });
}
```

整個 adapter 就這些。Shell 負責：popup 外殼、對話、歷史、auto-continue、Auto-apply 開關、diff 渲染、批准 / 拒絕、abort 接線、LLM 重試 / 逾時、會話持久化。

## ProfileAdapter 契約

必填欄位（`defineAdapter` 缺任意一項會拋錯）：

| 欄位 | 簽名 | 用途 |
|------|------|------|
| `id` | `string` | 穩定識別符（如 `'mything'`）。用作 popup id 前綴、會話歷史 mode filter、Auto-apply 偏好的儲存 key |
| `title` | `string` | 本地化後的 popup 標題 |
| `mode` | `string` | 歷史過濾 key。一個 adapter 一個 mode。存到 `Session.mode` |
| `i18n` | `(key) => string` | adapter 自己的翻譯函式。僅用於 adapter 自有字串 —— shell 外殼走 shell 自己的 i18n |
| `i18nFormat` | `(key, ...args) => string` | `${0}` / `${1}` 風格的插值。`defineAdapter` 自帶預設實作 |
| `getInitialProfile` | `(context, settings) => WorkingProfile` | 新會話開打時建構 workingProfile |
| `cloneWorkingProfile` | `(profile) => WorkingProfile` | 深拷貝 + sanitize。必須冪等 |
| `loadHistoryState` | `(context, scope, avatar) => Promise<HistoryState>` | 讀取指定 scope 下的會話歷史 |
| `persistHistoryState` | `(context, state, scope, avatar) => Promise<void>` | 寫入會話歷史 |
| `getDefaultScope` | `(context) => 'global'\|'character'` | 決定開啟時預設使用的 scope |
| `buildSystemPrompt` | `(settings, session) => string` | adapter 自己的完整 system prompt |
| `buildUserPrompt` | `(settings, session, userText, opts) => string` | 拼接使用者請求 + 目前 profile + 歷史 |
| `buildEditableToolSet` | `(session) => ToolDefinition[]` | 只回傳可編輯工具 —— shell 會自動注入 `continue` / `finalize` |
| `executeEditableToolCall` | `(ctx, session, call, signal) => Promise<{content, action, changed}>` | 處理單次 editable 呼叫。只能 mutate `session.workingProfile` / `session.lastSimulation` |
| `renderWorkingProfile` | `(session, opts) => string` | 右側面板 HTML，包含 adapter 想要的任何 apply / save / publish 按鈕 |

可選欄位：

| 欄位 | 簽名 | 預設 |
|------|------|------|
| `popupClassName` | `string` | popup 根元素附加 class，供 adapter 私有 CSS 鉤入 |
| `getGlobalBaselineProfile` | `(settings, session) => WorkingProfile\|null` | `null` —— 回傳非 null 可以讓 LLM 看到「持久化的 vs 會話內已改的」 |
| `buildAutoContinuePrompt` | `(executionResult) => string` | shell 自帶預設（引用 control 工具名） |
| `controlToolNames` | `{ continue?: string, finalize?: string }` | `{continue: 'iter_continue', finalize: 'iter_finalize'}`。僅為相容性才覆寫 |
| `describeTool` | `(name) => string` | 預設原樣回傳。用於 pending 審批摘要裡的友善工具名 |
| `getRequestPresetOptions` | `(settings) => { apiPresetName, llmPresetName }` | `{'', ''}` —— 兩個空字串表示「使用目前啟用的」 |
| `resolveRuntimeWorldInfo` | `(ctx, settings, session, signal) => Promise<any\|null>` | `null` —— 回傳物件可以給 LLM 注入額外的 world info |
| `renderMessageDiff` | `(session, message, popupId) => string` | 走 `renderProfileDeltaHtml(adapter, message.profileDelta, …)`。僅在需要徹底改版面時覆寫 |
| `renderTextDiff` | `(beforeText, afterText, path) => string` | shell 自帶完整的表格式行 / 詞級 diff（帶放大 + 拖曳分欄）。僅在需要完全不同的內聯 UI 時覆寫 |
| `formatDiffPathLabel` | `(path, item) => string` | 預設原樣回傳。覆寫後可以把 `presets.critic.systemPrompt` 渲染成 `Preset 'critic' / System Prompt` |
| `renderDiffItem` | `(item) => string\|null` | `null` —— 回傳 HTML 可以接管單張 diff 卡片的預設渲染 |
| `handleAction` | `(actionId, ctx) => Promise<void>\|void` | 空操作。接 popup 內任何 `[data-iter-custom-action]` 元素的點擊 |
| `ensureStyles` | `(popupClassName) => void` | 空操作。在 popup 開啟時一次性注入 adapter 自己的樣式 |

## 生命週期

```
open(adapter, context, settings, root)
  │
  ├─ adapter.ensureStyles(popupClassName)
  ├─ adapter.getDefaultScope(context)        → scope ('global' | 'character')
  ├─ adapter.loadHistoryState(...)           → HistoryState
  ├─ adapter.getInitialProfile / cloneWorkingProfile  → 新 Session
  ├─ （若歷史裡有匹配 mode 的最近會話，則用它替換）
  ├─ popup 開啟;rerender() 繪製對話 / profile / 歷史
  │
  ├─ 使用者輸入並點 Send
  │   ├─ adapter.buildSystemPrompt
  │   ├─ adapter.buildUserPrompt
  │   ├─ adapter.buildEditableToolSet + shell 的 control 工具
  │   ├─ adapter.getRequestPresetOptions → 透過 generateTask 請求 LLM
  │   ├─ 拆分工具呼叫:editable vs control(continue / finalize)
  │   ├─ 若有 editable 呼叫且 !autoApply:
  │   │     ├─ 在複製 session 上沙盒執行 editable 呼叫 → 預測出 delta
  │   │     ├─ 把預測 delta 一起存到 pending 訊息
  │   │     └─ 渲染 批准 / 拒絕 按鈕
  │   └─ 否則:
  │         ├─ 對每個 editable 呼叫 adapter.executeEditableToolCall
  │         ├─ 計算實際 delta 與 before
  │         ├─ 存為 completed 訊息
  │         └─ 若 continueRequested → 再循環一輪
  │
  ├─ 使用者點 批准
  │   ├─ 對每個 editable 呼叫(實際而非沙盒)呼叫 adapter.executeEditableToolCall
  │   ├─ 計算 delta,存為 completed
  │   └─ 若 continueRequested → 再循環一輪
  │
  └─ 使用者點 拒絕 / 終止 / 關閉 → 清理
```

## Session 形狀

Shell 維護的 `Session` 欄位：

```ts
{
    id: string,                    // 'session_<ts>_<rand>'
    mode: string,                  // adapter.mode
    chatKey: string,               // 用於聊天綁定的重設
    sourceScope: 'global'|'character',
    sourceAvatar: string,          // 全域時為 ''
    sourceName: string,            // adapter 提供的標籤（如角色名）
    revision: number,              // 每次 editable 呼叫自增
    createdAt: number,
    updatedAt: number,
    workingProfile: WorkingProfile,  // adapter 自己定義形狀
    baseWorkingProfile: WorkingProfile,
    messages: SessionMessage[],
    lastSimulation: Simulation|null,
    pendingApproval: PendingApproval|null,
}
```

Adapter 一般只讀 `workingProfile` / `sourceScope` / `sourceAvatar` / `sourceName` / `messages`。其他欄位是內部的但對你可見。

## 儲存

`createSettingsBackedHistoryStore({ moduleName, globalSettingsKey, characterStateNamespace, historyLimit?, modeFilter? })` 回傳一對 `{ loadHistoryState, persistHistoryState }`，adapter 把它展開到自己定義裡：

- 全域 scope → `extension_settings[moduleName][globalSettingsKey]`（透過 `saveSettingsDebounced` 儲存）
- 角色 scope → `context.getCharacterState(avatar, characterStateNamespace)` / `setCharacterState(...)`
- `historyLimit`（預設 24）限制每個 scope 保留的最近會話數
- `modeFilter` 讓多個 adapter 共享同一份底層儲存但各自只看自己的 sessions（編排器的 spec / agenda / loop 三個 adapter 就用它，所以現有歷史不需要遷移）

需要自訂儲存的 adapter（IndexedDB、加密、雲端同步）直接實作 `loadHistoryState` / `persistHistoryState` —— shell 只檢查回傳形狀（`{ version: 3, sessions: Session[] }`）。

## Adapter 驅動的動作

Shell 把 popup 內 `[data-iter-custom-action="<id>"]` 的點擊委派給 `adapter.handleAction(id, ctx)`。用它來做 apply 按鈕、save-as-new、發布、復原，等等。

```js
renderWorkingProfile(session) {
    return `
${profileHtml}
<div class="luker-studio-composer-buttons">
    <div class="menu_button" data-iter-custom-action="apply-global">${escapeHtml(i18n('Apply to Global'))}</div>
    ${session.sourceAvatar ? `<div class="menu_button" data-iter-custom-action="apply-character">${escapeHtml(i18n('Apply to Character'))}</div>` : ''}
</div>`;
},
async handleAction(actionId, ctx) {
    const { context, settings, session, root } = ctx;
    if (actionId === 'apply-global') {
        // ... 把 session.workingProfile 寫入 settings
    }
    if (actionId === 'apply-character') {
        // ... 寫入角色 state
    }
},
```

Shell 不解釋動作 id —— 任意命名，符合你的領域即可。不需要持久化的 studio 可以完全省略 `handleAction` 並不渲染動作按鈕。

## diff 自訂

預設行為已經涵蓋大部分場景 —— 不需要覆寫：

- 物件 vs 物件 整體替換會**自動遞迴**展開成逐欄位卡片（最多深度 3），不會看到兩塊大 JSON
- 長字串欄位自動走 shell 內建的**行級 / 詞級內聯 diff**（帶放大 + 拖曳分欄）
- pending 審批會**預投影** diff（使用者點批准之前就能看到將要改什麼）

預設不夠用時，透過可選鉤子定制：

- `renderTextDiff(beforeText, afterText, path)` —— 接管字串內聯渲染
- `formatDiffPathLabel(path, item)` —— 把 `presets.critic.systemPrompt` 美化成 `Preset 'critic' / System Prompt`
- `renderDiffItem(item)` —— 接管整張 path 卡片（回傳 `null` 退回到預設）
- `renderMessageDiff(session, message, popupId)` —— 整個 diff 塊都接管

傳給 `renderDiffItem` 的 `item` 形狀：

```ts
{
    path: string,                                    // e.g. 'presets.critic'
    beforeValue: any,
    afterValue: any,
    beforePayload: { text: string, missing: boolean },  // 已預先格式化方便使用
    afterPayload: { text: string, missing: boolean },
}
```

## i18n 注意

- Shell 用自己的翻譯表（`public/scripts/iteration-studio/i18n.js`）渲染外殼字串。adapter 不用翻譯 `對話` / `發送給 AI` / `批准並套用` 這些
- 本地化註冊延遲到 DOM-ready，因為 SillyTavern 的 `addLocaleData` 在 locale 檔案載入前呼叫會靜默 no-op
- Adapter 提供自己的 `i18n` 函式指向自己的翻譯表 —— 用於 popup 標題、system prompt、工具動作描述、自訂按鈕文字

## 相容性

- `getApplyTargets` / `applyToGlobal` / `applyToCharacter` / `canApplyToCharacter` —— 這些是設計過程中的中間方案，不是目前契約的一部分。用 `renderWorkingProfile` + `handleAction` 來做按鈕
- Shell 不假定「global / character」的 scope 模型 —— 編輯 chat scope 或 preset scope 工件的 adapter 自由渲染自己合適的按鈕

## 參考

- `public/scripts/iteration-studio/adapter.js` —— JSDoc 標註的契約（權威來源）
- `public/scripts/extensions/orchestrator/iteration-adapter.js` —— 包裹現有編排器 helper；參考「舊程式碼薄包裝」模式
- `public/scripts/extensions/memory-graph/schema-adapter.js` —— 直接基於契約從零建構;參考新 adapter 模式
