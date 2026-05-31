# 編排器工具 API

註冊可被編排器四種模式（loop、spec、agenda、director）調度的工具。

## 什麼時候用這個 API

你的擴充提供了一項能力，讓某個編排 agent 自主呼叫會更順手——查資料庫、呼叫第三方 API、跑 Stable Diffusion 出圖，都行。如果使用者裝了編排器擴充，你註冊的工具會出現在他們的編排編輯器「自訂工具 → 擴充（來自其他外掛）」分組裡，由他們按編排粒度決定開還是關。

如果使用者沒裝編排器，你的工具也不會丟——註冊呼叫會靜默 no-op。你的擴充獨立使用時仍然完整可用。

## API 入口

編排器擴充透過 Luker 的擴充註冊表暴露 API。三種入口指向同一組函式參考——按你的程式碼情境挑一種：

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

任何時候都加一層「編排器是否在場」的保護，讓你的擴充在獨立裝的場景下仍然可用。

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

ctx 物件裡有目前編排模式附加的所有執行時欄位：聊天陣列、執行時狀態、手寫工具的 per-run 註冊表等。保守一些——只依賴你這個工具真正需要的欄位。

## 錯誤處理

`exec` 和 `simulate` 都可以 `throw`。普通 `Error` 就夠用；想要 LLM 能從結構化失敗裡恢復，附帶 `{ code, hint }`：

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

如果你的擴充已經在用 SillyTavern 的 `registerFunctionTool` API，使用者可以在編排編輯器裡透過「橋接 SillyTavern 工具……」選擇器把它橋接進來。橋接出來的工具叫 `st_<你的工具名>`，預設 `mode: 'write'`。你這邊不用改任何程式碼。

如果你想精確控制 mode 和 simulate 語意，就用 `registerOrchestrationTool` 包一層；不在意的話橋接是零成本路徑。選擇器的標籤和模式選項透過 `listAvailableSillyTavernTools()` / `bridgeSillyTavernTool(name, { mode })` 暴露，呼叫方想自己驅動橋接也行。

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

- [自訂工具（使用者文件）](/zh-TW/features/orchestrator/custom-tools) —— 使用者視角下三條通道（擴充 / SillyTavern 橋接 / 手寫）在編排編輯器裡的呈現方式
- [外掛整合](./plugin-integration.md) —— 註冊 `'orchestrator'` 與其他擴充入口的擴充 API 註冊表全貌
- [記憶圖擴充 API](./memory-graph.md) —— 本 API 的參考消費者
