# 編排器工具 API

註冊可被各編排模式（loop、spec、agenda、director）調度的工具。

## 什麼時候用這個 API

你的擴充提供了一項能力，讓某個編排 agent 自主呼叫會更順手——查資料庫、呼叫第三方 API、跑 Stable Diffusion 出圖，均可。如果使用者裝了編排器擴充，你註冊的工具會出現在**工作台 → 編排 → 準備階段 → 自訂工具**中，由他們按編排粒度決定開還是關。

如果使用者沒裝編排器，你的工具也不會丟——註冊呼叫會靜默 no-op。你的擴充獨立使用時仍然完整可用。

## API 入口

編排器擴充透過 Luker 的擴充註冊表暴露 API。多個入口指向同一組函式參考——按你的程式碼情境挑一種：

```js
import { getExtensionApi } from '/scripts/extensions.js';

// 1. 透過 getExtensionApi（最常用）
const orch = getExtensionApi('orchestrator');
if (orch) orch.registerOrchestrationTool({ /* ... */ });

// 2. 透過 SillyTavern context（擴充會收到這個物件）
ctx.getExtensionApi('orchestrator')?.registerOrchestrationTool({ /* ... */ });

// 3. 直接 ES module 匯入（只在 Luker 樹內合適）
import { registerOrchestrationTool } from
    '/scripts/extensions/orchestrator/register-custom-tool.js';
```

任何時候均加一層「編排器是否在場」的保護，讓你的擴充在獨立裝的場景下仍然可用。

## registerOrchestrationTool(spec)

```ts
{
  name: string,            // /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/。不能跟內建工具
                           // 或別的擴充工具重名。
  description: string,     // 寫給 LLM 看的，不是給使用者。
  parameters: object,      // OpenAI 風格的 JSON Schema。
  exec: async (args, ctx) => any,
  mode: 'read' | 'write',  // 必填。寫工具在模擬評審期會被隔離。
  simulate?: async (args, ctx) => any,  // 選填。寫工具進入模擬評審時，
                                        // 改呼叫它而不是 exec。不提供時，
                                        // 寫工具回傳佔位
                                        // { ok: true, simulated: true,
                                        //   unvalidated: true }。
  displayName?: string,
}
```

`exec` 被呼叫時拿到 LLM 解析後的參數和編排 ctx。回傳值就是 LLM 看到的工具結果。`throw` 把錯誤拋回給 agent。

### ctx 參數

`ctx` 原型鏈上繼承 SillyTavern `getContext()` 的所有欄位，外加編排執行時掛的幾個內部欄位。用法跟你在 Luker 任何其他地方用 context 一樣。

來自 SillyTavern:

- `ctx.chat`、`ctx.characters`、`ctx.characterId`、`ctx.groups`、`ctx.groupId`、`ctx.name1`、`ctx.name2`
- `ctx.eventSource`、`ctx.eventTypes` —— 執行時事件總線
- `ctx.getExtensionApi(name)` —— 其他擴充功能發布的 API

編排執行時掛的（只在編排過程中存在）:

| 欄位 | 用途 |
|---|---|
| `ctx.__lukerRun` | 本次 run 的執行時狀態。`ctx.__lukerRun.activatedEntryKeys` 是一個 `Set`，裡面是本輪已被注入的 World Info 條目 key（供 lorebook 風格的工具去重）。`ctx.__lukerRun.abortSignal` 是本 run 的 abort signal —— 可取消的工作要尊重它。 |
| `ctx.__floorStateForNotes` | `note_open` / `note_close` 工具底層的 floor-state 實例。想跟便箋系統協作就讀它。 |
| `ctx.__customToolRegistry` | 本 run 的 Layer-3（手寫）工具註冊表。絕大多數工具用不到。 |
| `ctx.__memoryGraphSession` | 由本 run 內第一次 `memory_*` 工具呼叫 lazy 開啟；在那之前不存在。 |

命名：SillyTavern 占頂層 key；編排執行時只掛 `__` 前綴欄位，兩邊互不踩。

保守一些 —— 只依賴你這個工具真正需要的欄位，這樣下游 context 演進時你也不會壞。

## 錯誤處理

`exec` 和 `simulate` 均可以 `throw`。普通 `Error` 就夠用；想要 LLM 能從結構化失敗裡恢復，附帶 `{ code, hint }`：

```js
throw Object.assign(new Error('Database is read-only.'), {
    code: 'DB_READONLY',
    hint: 'Wait for the next write window or use a different store.',
});
```

編排器內部會把你拋的錯包成 `ToolError` 形狀，再以 `role: tool` 訊息的形式交回給 LLM。

## unregisterOrchestrationTool(name)

把工具從註冊表裡摘掉。在你的擴充要關停、或者要換工具面的時候呼叫。

## listExtensionTools()

回傳目前所有已註冊擴充工具的 `{ name, mode, description, displayName, hasSimulate, source }`。給「展示有哪些工具可用」的 UI 用。

## ST function tool 橋接

如果你的擴充已經在用 SillyTavern 的 `registerFunctionTool` API，使用者可以在**工作台 → 編排 → 準備階段**透過「橋接 SillyTavern 工具……」選擇器把它橋接進來。橋接出來的工具叫 `st_<你的工具名>`，預設 `mode: 'write'`。你這邊不用改任何程式碼。

如果你想精確控制 mode 和 simulate 語意，就用 `registerOrchestrationTool` 包一層；不在意的話橋接是零成本路徑。選擇器的標籤和模式選項透過 `listAvailableSillyTavernTools()` / `bridgeSillyTavernTool(name, { mode })` 暴露，呼叫方想自己驅動橋接也行。

## collectResolvedSkillsForOrchPreset(payload)

接受包含 `mode`、`name` 與 `profile` 的匯出預設資料。返回 `Promise<Map<string, {scope: object, names: string[]}>>`，按來源範圍分組收集預設中 agent 可見的技能，技能名稱去重並排序。不包含角色範圍的技能，無效資料返回空 Map。

## 角色級 override 存取器

除了工具註冊介面，`'orchestrator'` 這個 extension api 還發布了存取器與寫入 helper，其他擴充用它讀取或切換角色卡的編排預設。CardApp 的 `ctx.getOrchestratorOverride` / `setOrchestratorOverride` / `clearOrchestratorOverride`，以及 CardApp Studio 的工具 `character_get_orchestrator` / `character_update_orchestrator` / `character_clear_orchestrator` 均走這同一套介面。

```js
const orch = ctx.getExtensionApi('orchestrator');
if (!orch) { /* 編排器未安裝 */ return; }

const mode = orch.getCharacterSavedExecutionModeByAvatar(ctx, avatar);
if (mode) {
    const result = await orch.setCharacterActivePresetForSavedMode(
        ctx, ctx.extensionSettings?.orchestrator, avatar, 'preset_id_from_the_card_library',
    );
    // result: { ok: true, mode } | { ok: false, mode, reason }
}
```

| 方法 | 用途 |
| --- | --- |
| `getCharacterSavedExecutionModeByAvatar(ctx, avatar)` | 回傳角色卡釘住的執行 mode：卡上存在該 mode 的預設庫時取 `override.mode`，否則取第一個帶預設庫的 mode；卡上沒有預設庫時回傳 `''`。 |
| `getRuntimePresetScope(ctx, avatar, mode)` | 角色卡在 `mode` 下的啟用槽指向卡內預設庫中的預設時回傳 `'character'`，否則回傳 `'global'`。 |
| `getCharacterActivePresetId(ctx, avatar, mode)` | 回傳角色卡在 `mode` 下的啟用預設 id；槽為空或指向不存在的預設時回傳 `''`。 |
| `setCharacterActivePresetForSavedMode(ctx, settings, avatar, presetId)` | 切換角色卡在已儲存 mode 下的啟用預設，儲存角色卡，並重新對齊 `settings.executionMode`。`presetId` 取卡內該 mode 預設庫中的 id；傳 `''` 則執行全域啟用預設並保留卡內預設庫。回傳 `{ ok: true, mode }` 或 `{ ok: false, mode, reason }`，`reason` 取值為 `character_not_found`、`no_saved_mode`、`preset_not_found`、`set_failed`、`persist_failed`。 |
| `getCharacterIndexByAvatar(ctx, avatar)` | 解析 `persistOrchestratorCharacterExtension` 需要的角色索引；找不到回傳 `-1`。 |
| `getCharacterExtensionDataByAvatar(ctx, avatar)` | 讀取完整的 `character.data.extensions.orchestrator` blob。寫入前 spread 一下，避免誤刪兄弟子鍵。 |
| `applyCharacterExecutionModeForAvatar(ctx, settings, avatar)` | 把 `settings.executionMode` 重新對齊到該角色已儲存的 mode；變動時回傳 `true`。 |
| `persistOrchestratorCharacterExtension(ctx, characterIndex, modulePayload)` | 透過 `ctx.writeExtensionField` 持久化整個 `extensions.orchestrator` blob。傳入 `null` 作為 `modulePayload` 會刪除整個 blob。HTTP 成功時回傳 `true`，角色不存在、HTTP 失敗或網路異常時回傳 `false`。 |

除 `applyCharacterExecutionModeForAvatar` 與 `setCharacterActivePresetForSavedMode` 會重新對齊 `settings.executionMode` 外，這些存取器只修改角色卡。

## 共享技能工具目錄

`context.iterationLibrary.tools`（`public/scripts/iteration-library/tools/skill-iter-studio.js`）提供了一組共享的技能管理工具（庫存查詢、創作、策略繫結、遷移輔助），供工作台的**編排**與**預設設定檔**迭代目標共同使用：

| 匯出項 | 型別 | 用途 |
| --- | --- | --- |
| `SKILL_ITER_STUDIO_TOOL_DEFS` | `readonly array` | OpenAI 形狀的工具定義（`skill_*` 工具）。按 `function.name` 過濾出目標所需的子集。 |
| `isSkillIterStudioTool(name)` | `(string) => boolean` | 判斷一個工具呼叫名是否屬於技能工具的判定式。 |
| `runSkillIterStudioTool(call, mutationCtx)` | `async ({name, args}, {getWorkingProfile}) => result` | 單次技能工具呼叫的分發器。純庫存 / 創作 / 遷移 handler 忽略 `mutationCtx`；策略繫結類 handler（`skill_bind_to_agent` / `skill_unbind_from_agent` / `skill_set_mode_defaults` / `skill_replace_in_systemprompt`）要求 `getWorkingProfile()` 回傳可變的編排工作 profile。 |

工作台的 `preset` 目標（`public/scripts/workbench/targets/preset-tools.js`）透過傳入 `{ getWorkingProfile: () => null }` 只暴露與 profile 無關的 handler；`orchestrator/lens/iterate-target.js` 則傳入 `getWorkingProfile: () => live`。

## 範例 —— memory-graph

memory-graph 擴充正是透過這套 API 發布它的讀 / 寫工具，pattern 如下：

```js
// memory-graph/orchestrator-tools.js
import { getExtensionApi } from '/scripts/extensions.js';

export function registerMemoryGraphOrchestrationTools() {
    const orch = getExtensionApi('orchestrator');
    if (!orch || typeof orch.registerOrchestrationTool !== 'function') return;
    for (const spec of SCHEMAS) {
        orch.registerOrchestrationTool(spec);
    }
}
```

在 memory-graph 的 init handler 裡呼叫一次。每個工具的具體 spec 參見 [記憶圖擴充 API](./memory-graph.md)。

## 相關頁面

- [自訂工具（使用者文件）](/zh-TW/features/orchestrator/custom-tools) —— 使用者視角下多條通道（擴充 / SillyTavern 橋接 / 手寫）在**工作台 → 編排 → 準備階段**的呈現方式
- [外掛整合](./plugin-integration.md) —— 註冊 `'orchestrator'` 與其他擴充入口的擴充 API 註冊表全貌
- [記憶圖擴充 API](./memory-graph.md) —— 本 API 的參考消費者
