# Character Editor Assistant Extension API

`character-editor-assistant`（CEA）擴充透過 Luker 的 extension 註冊表發布三個 helper，讓其他外掛擁有的迭代工作台能複用 CEA 的 helper-tool 面，而不必跨外掛邊界 import。這正是編排器 iter-studio 彈窗和記憶圖 schema iter-studio 彈窗共同消費的介面。

## 為什麼需要這套介面

CEA 擁有一組 helper 工具，給迭代彈窗用來讀寫角色卡和它的 lorebook：

- `lorebook_query` / `lorebook_list` / `lorebook_get` —— 讀 lorebook
- `world_book_list` —— 列出某角色可見的世界書
- `simulate_prompt` —— dry-run 一次 prompt 並擷取 prompt 與世界資訊命中
- 一組卡欄位 + 詞條寫入工具，把 AI 提議翻譯成可提交的 edits

之前兄弟 iter-studio（例如編排器的 iter-studio 彈窗）需要把這些工具也暴露給自己的 LLM 時，是直接 ES 模組 import 進來的。這會把消費者和 CEA 的內部檔案路徑耦合死，並打破外掛↔外掛邊界。下面這套 extension api 就是來取代那種耦合的。

## 介面

```js
const cea = SillyTavern.getContext().getExtensionApi('character-editor-assistant');
if (!cea) {
    // CEA 未安裝；依賴這些 helper 的 iter-studio 彈窗應當拒絕開啟，
    // 並給出清晰的「請安裝 CEA」錯誤。
    return;
}

const helperApis = cea.buildCharacterEditorHelperApis(context, { avatar });
const toolResult = await cea.runCharacterEditorHelperToolCall(call, helperApis);
await cea.applyCharacterEditorLorebookProposal(context, { kind, args });
```

## 方法

### `buildCharacterEditorHelperApis(context, opts?)`

回傳 CEA 統一編輯器讀工具分發用的 helper-tool API 陣列。每個 entry 暴露 `isToolName(name)` 加 `invoke(call)`，`runCharacterEditorHelperToolCall` 會迭代這個陣列，把呼叫路由到匹配的 helper。

```ts
buildCharacterEditorHelperApis(
    context: SillyTavernContext,
    opts?: { avatar?: string },
): Array<{ isToolName: (n: string) => boolean; invoke: (call) => Promise<any> }>
```

- `context` —— SillyTavern context（必須暴露 `characters`、`loadWorldInfo`、……）。
- `opts.avatar` —— 角色 avatar，用於把 lorebook / world-book-list 介面限定到正確的角色卡。全域彈窗可省略。

回傳的陣列恆定包含四個 helper（lorebook 讀、lorebook 寫、simulate、world-book-list），當 `globalThis.Luker.searchTools` 接好時會額外多一個 web 搜尋 helper。

### `runCharacterEditorHelperToolCall(call, helperApis)`

分發一次 helper 工具呼叫。呼叫端傳入 `buildCharacterEditorHelperApis` 回傳的 helper API 陣列；分發器透過 `isToolName` 找到匹配的 helper 並轉發。匹配不到時拋 `Unsupported helper tool: <name>`。

這正是 iter-studio 彈窗注入到共享的 `iteration-library/tools/lorebook-reads.js` 和 `lorebook-writes.js` 裡的分發器 —— 那兩個模組本身與外掛無關，按呼叫注入分發器。

### `applyCharacterEditorLorebookProposal(context, { kind, args })`

針對詞條當前的磁碟狀態重新推導 lorebook 提議的 after-image 並提交。`kind` 是 `'update'` 或 `'str_replace'`；`args` 是提議原始的 `args` payload。

iter-studio 彈窗就是用這個方法提交 AI 提議的 lorebook 編輯 —— 不信任提議時間點抓的快照，而是重新對齊當前狀態。這樣同一個 `book#uid` 的多次連環提議能正確依次提交，平行會話飄移也會冒成一次新鮮的驗證錯誤，而不是被靜默覆蓋。

## 延遲解析 api

彈窗應該在開啟時解析 api，而不是在模組載入時。CEA 的註冊時機可能晚於消費者模組求值；推遲解析也讓彈窗在依賴缺失時有機會給使用者一個清晰的「請安裝 CEA」錯誤。

```js
function getCea() {
    const api = SillyTavern.getContext().getExtensionApi('character-editor-assistant');
    if (!api) {
        throw new Error('該迭代彈窗需要 character-editor-assistant 擴充。');
    }
    return api;
}
```

## 相關

- [外掛整合](./plugin-integration.md) —— `registerExtensionApi(name, api)` / `getExtensionApi(name)` 註冊表，發布 `'character-editor-assistant'`
- [迭代工作台框架](./iteration-studio.md) —— 消費者彈窗使用的共享 `iteration-library/*` 介面，CEA 分發器注入到其中
- [編排器工具 API](./orchestrator-tools.md) —— 兄弟參考消費者
- [記憶圖擴充 API](./memory-graph.md) —— 兄弟參考消費者
