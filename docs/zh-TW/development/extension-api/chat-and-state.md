# 聊天與狀態

讀取聊天資料、發送和編輯訊息、持久化聊天中繼資料、按聊天 / 按角色儲存狀態的相關 API。

## 聊天資料（唯讀）

以下屬性提供當前聊天的唯讀存取：

| 屬性 | 類型 | 說明 |
|------|------|------|
| `context.chat` | `ChatMessage[]` | 當前聊天訊息陣列 |
| `context.characters` | `Character[]` | 角色列表 |
| `context.groups` | `Group[]` | 群組列表 |
| `context.name1` | `string` | 使用者名稱 |
| `context.name2` | `string` | 角色名 |
| `context.characterId` | `number` | 當前角色 ID |
| `context.groupId` | `string` | 當前群組 ID |
| `context.chat_metadata` | `object` | 當前聊天的中繼資料 |
| `context.online_status` | `string` | API 連線狀態 |

## 訊息 API

Luker 提供了統一的高層訊息操作 API。每個操作都是完整的一條龍流程：記憶體更新 + DOM 渲染 + 事件觸發 + 持久化。

### addMessages

```ts
addMessages(
 messages: ChatMessage | ChatMessage[],
 options?: { scroll?: boolean, silent?: boolean }
): Promise<number | number[]>
```

新增一條或多條訊息到聊天中。

- 自動 push 到 `chat[]`、渲染 DOM、觸發 `MESSAGE_SENT`/`MESSAGE_RECEIVED` 和 `MESSAGE_RENDERED` 事件、持久化到後端
- 傳入陣列時批次操作，只觸發一次持久化
- 回傳新訊息的索引（單條回傳 `number`，批次回傳 `number[]`）

```js
// 新增單條訊息
const index = await context.addMessages({
 name: 'System',
 mes: '這是一條系統訊息',
 is_system: true,
});

// 批次新增
const indices = await context.addMessages([
 { name: 'User', mes: '你好', is_user: true },
 { name: 'Assistant', mes: '你好！有什麼可以幫你的？', is_user: false },
]);
```

### updateMessages

```ts
updateMessages(
 updates: { index: number, patch: object } | { index: number, patch: object }[],
 options?: { rerender?: boolean, silent?: boolean }
): Promise<void>
```

更新一條或多條訊息的內容並持久化。

- `patch` 物件的欄位會合併到 `chat[index]` 中
- 自動重新渲染 DOM、觸發 `MESSAGE_EDITED` 和 `MESSAGE_UPDATED` 事件、透過 RFC 6902 增量持久化
- 批次操作時合併為一次持久化呼叫

```js
// 更新單條訊息
await context.updateMessages({
 index: 4,
 patch: { mes: '修改後的內容' },
});

// 批次更新
await context.updateMessages([
 { index: 3, patch: { mes: '新內容 A' } },
 { index: 5, patch: { mes: '新內容 B', extra: { model: 'gpt-4o' } } },
]);
```

### deleteMessages

```ts
deleteMessages(
 index: number | number[],
 options?: { swipe?: number, silent?: boolean }
): Promise<ChatMessage | ChatMessage[]>
```

刪除一條或多條訊息。

- 自動從 `chat[]` 移除、清理 DOM、觸發 `MESSAGE_DELETED` 事件、透過 RFC 6902 增量持久化
- 批次刪除時自動處理索引偏移
- 指定 `swipe` 選項時，只刪除該訊息的特定 swipe 而非整條訊息
- 回傳被刪除的訊息物件

```js
// 刪除單條訊息
const deleted = await context.deleteMessages(5);

// 批次刪除
const deletedList = await context.deleteMessages([3, 5, 7]);

// 只刪除特定 swipe
await context.deleteMessages(5, { swipe: 2 });
```

### getMessage

```ts
getMessage(index: number): Readonly<ChatMessage> | null
```

取得指定索引的訊息（唯讀）。回傳一個 Proxy 物件，嘗試修改屬性會拋出錯誤並引導使用 `updateMessages()`。

### getMessageCount

```ts
getMessageCount(): number
```

回傳當前聊天的訊息總數。

### sendTextareaMessage

```ts
sendTextareaMessage(): Promise<void>
```

像「使用者在訊息文字框裡打了字然後按了傳送」一樣,程式化觸發使用者側傳送管道。會傳送文字框裡現有內容（先 `$('#send_textarea').val(...)` 餵入）,然後跑標準生成流程。傳送完成時解析。

---

::: warning 已棄用的底層 API
以下函式仍然可用但已標記為 deprecated，外掛開發者應使用上述統一 API：

- `addOneMessage()` → 使用 `addMessages()`
- `deleteLastMessage()` → 使用 `deleteMessages(chat.length - 1)`
- `deleteMessage()` → 使用 `deleteMessages()`
- `updateMessageBlock()` → 使用 `updateMessages()`
- `patchChatMessages()` → 底層 RFC 6902 傳輸層，使用 `updateMessages()` / `deleteMessages()`
- `appendChatMessages()` → 底層追加傳輸層，使用 `addMessages()`
:::

## 聊天持久化

### saveChatMetadata

```ts
saveChatMetadata(withMetadata?: object): Promise<boolean>
```

儲存聊天中繼資料。如果傳入 `withMetadata`，會先合併到 `chat_metadata` 再儲存。

## 聊天狀態

聊天狀態是 Luker 新增的聊天綁定狀態機制，讓外掛可以將結構化資料綁定到特定聊天，而不是塞進 `chat_metadata`。

### getChatState

```ts
getChatState(
  namespace: string,
  options?: { target?: ChatTarget }
): Promise<any | null>
```

讀取指定命名空間的聊天狀態。回傳 `null` 表示該命名空間無資料。

- `namespace`：外掛的唯一識別碼，建議使用外掛名
- `target`：可選，指定目標聊天（用於跨聊天讀取，如分支場景）

### getChatStateBatch

```ts
getChatStateBatch(
  namespaces: string[],
  options?: { target?: ChatTarget }
): Promise<Record<string, any>>
```

批次讀取多個命名空間的聊天狀態。回傳一個以命名空間為鍵的物件。

### updateChatState

```ts
updateChatState(
  namespace: string,
  updater: (current: any) => any,
  options?: { target?: ChatTarget }
): Promise<{ ok: boolean }>
```

**推薦的讀-改-寫方式。** `updater` 函數接收當前狀態，回傳新狀態。系統會自動處理並行衝突。

```js
await context.updateChatState('my-plugin', (current = {}) => ({
  ...current,
  counter: (current.counter || 0) + 1,
  lastUpdated: Date.now(),
}));
```

### deleteChatState

```ts
deleteChatState(
  namespace: string,
  options?: { target?: ChatTarget }
): Promise<{ ok: boolean }>
```

刪除指定命名空間的聊天狀態。

### 最佳實踐

- 使用 `updateChatState()` 進行讀-改-寫，而非手動鏈式呼叫 `getChatState()` + `patchChatState()`
- 保持 payload 為可 JSON 序列化的純物件
- 處理 `ok: false` 回傳值，保持外掛 UI 的彈性
- 對於大型外掛資料，優先使用聊天狀態而非 `chat_metadata`
- 若狀態需要隨 swipe、刪訊息、切換聊天自動跟進，請使用 [樓層狀態](#樓層狀態)，而不是在 `updateChatState` 之上自己寫對帳邏輯

## 樓層狀態

樓層狀態在聊天狀態之上加了一層薄封裝：每次寫入都會附帶聊天尾端的位置（樓層索引 + swipe 編號）記入日誌，聊天結構變化時自動重播倖存提交。需要讓狀態跟著 swipe、刪訊息、切換聊天而不必手動對帳的外掛或 CardApp，應該使用這套 API，而不是直接呼叫 `updateChatState`。

### 運作方式

一個樓層狀態實例獨佔一個聊天狀態命名空間（`<ns>`）以及一份私有提交日誌（`<ns>__floor_log`）。所有寫入都透過實例的 `update` 方法進入：它讀取目前狀態、執行你的 reducer、計算差異、把差異寫入業務命名空間並追加一筆提交。每個實例建立時會註冊到 `floor-state.js` 內部的實例表；聊天結構發生變化時，core 程式碼會先把所有已註冊實例同步推平到對應的處理器，**然後**才觸發對應的 `eventSource` 事件通知插件訂閱者——任何插件在監聽器裡讀取樓層狀態都能看到已經 settle 完的資料。四種結構性轉換是：

- `CHAT_CHANGED`——切換到新聊天，依這份聊天的日誌重建資料
- `MESSAGE_SWIPED`——使用者切換 swipe，依新的作用 swipe 重建資料
- `MESSAGE_DELETED`——聊天被截短，丟棄樓層超出新長度的提交後重建
- `MESSAGE_SWIPE_DELETED`——聊天尾端某個 swipe 被刪除，該樓層的提交重新編號後重建

每筆提交存的是「提交當下 materialized 狀態 → 下一份狀態」的增量 diff。重建依寫入順序遍歷所有提交，丟棄 `(floor, swipeId)` 已不在當前作用 swipe 上的提交，然後把倖存的 patch 依序套用在 `{}` 上。刪除事件都只發生在尾端——`MESSAGE_DELETED` 只截尾端、`MESSAGE_SWIPE_DELETED` 也只在聊天尾端觸發——所以作用路徑上的倖存提交始終是連續的鏈，增量 patch 正確組合。

### createFloorState

```ts
createFloorState(options: { namespace: string }): Promise<FloorStateInstance>
```

在外掛或 CardApp 裡使用 `getContext().createFloorState({ namespace })`。每個實例綁定一個命名空間；若業務狀態分多塊，請建立多個實例。

```js
const ctx = SillyTavern.getContext();
const fs = await ctx.createFloorState({ namespace: 'my-plugin' });

// 推薦：reducer 風格寫入。reducer 收到目前狀態、回傳下一份狀態，差異自動算完並提交。
await fs.update((current) => ({ ...current, score: 10 }));
await fs.update((current) => ({ ...current, level: (current?.level ?? 0) + 1 }));
await fs.update((current) => {
    const { temp, ...rest } = current ?? {};
    return rest;
});

// 讀取目前狀態：
const state = await fs.get();

// 在讀取前等待重建或寫入完成：
await fs.ready();

// 從註冊表移除（極少需要，實例通常與頁面同壽）：
fs.destroy();

// 抹除該命名空間的狀態並從註冊表移除：
await fs.destroy({ purge: true });
```

::: warning
reducer 必須回傳普通物件。回傳陣列、基本型別、`null`、`undefined` 一律視作「無變化」，呼叫直接成功回傳但不寫入。
:::

### 整盤替換日誌（匯入 / 重建）

`update` 與 `patch` 都是 append-only——每次呼叫都在現有歷史末尾追加一筆提交。當你需要整盤替換歷史（匯入備份、從聊天重建、重置到已知基線）時，請用 `reset(commits)`：

```js
// 用這組提交原子性替換整段日誌。
const ok = await fs.reset([
    { floor: 0, swipeId: 0, patches: [{ op: 'add', path: '/intro', value: '...' }] },
    { floor: 3, swipeId: 0, patches: [{ op: 'add', path: '/scene', value: '...' }] },
]);
if (!ok) {
    // 校驗失敗（提交結構非法、floor 越出目前聊天範圍）或底層寫被拒，日誌保持原狀。
}

// 傳空陣列等於清空日誌。
await fs.reset([]);
```

每筆提交都依 `patch` 同樣的結構校驗（`floor` 與 `swipeId` 是非負整數、`patches` 是非空陣列），外加 `floor < chat.length` 的範圍檢查。任一筆不合規即整批拒絕——日誌絕不會落到「半合規」狀態。沒有獨立的 data 命名空間要同步：下一次 `get()` 會按新日誌重新重放，行程內 cache 自動失效。

### 把狀態掛到非尾端的樓層

`update` 接受一個可選的第二參數 `{ floor, swipeId? }`，用來把這次提交顯式掛到指定樓層，而不是聊天尾端。常見場景是「滯後寫入」——例如記憶擴充功能在使用者設定「最後 N 層不參與生成」時，需要把摘要掛到 `chat.length - N` 而不是目前最新樓層。

```js
// 只指定 floor：swipeId 自動取 chat[floor].swipe_id
await fs.update(
    (current) => ({ ...current, summaries: { ...(current?.summaries ?? {}), 0: '...' } }),
    { floor: targetFloor },
);

// 同時指定 floor + swipeId（用於回填某條具體 swipe 上的狀態）
await fs.update((current) => nextState, { floor: targetFloor, swipeId: 0 });
```

不傳 `options` 時依聊天尾端推斷。`floor` 必須是目前 `chat` 的有效索引（`0 <= floor < chat.length`），越界、負數、非整數、負 `swipeId` 都會被拒絕並回傳 `false`，避免悄無聲息地把狀態錯掛到不存在的樓層。

::: tip
覆寫只影響這條提交在日誌中的標籤——`MESSAGE_DELETED` 仍依 floor 截斷，`MESSAGE_SWIPE_DELETED` 仍依 （floor， swipeId） 重新編號。重建順序由日誌的寫入順序決定，不會因為你指定了較小的 `floor` 就被「插隊」到前面執行。
:::

### 進階：預先算好的 patch

如果你已經手上有一份針對目前 materialized 狀態的增量 RFC 6902 diff——例如基於效能考量自己算了 diff、或者在跑一次性遷移——可以呼叫 `instance.patch(operations, options?)` 直接追加。operations 必須是 `buildObjectPatchOperationsAsync(prev, next)` 形式的增量 diff，prev 取自 `await fs.get()`；不能傳「整盤覆寫」式的 snapshot patch，因為重建假設每筆提交的 patch 與前面倖存提交的 patch 依序組合。

其他場景一律走 `update`——它會幫你算好 diff。

### buildObjectPatchOperationsAsync

```ts
context.buildObjectPatchOperationsAsync(
    previousState: object,
    nextState: object,
    options?: object,
): Promise<RFC6902Operation[]>
```

驅動 Luker patch-first 持久化的 diff 引擎。回傳把 `previousState` 變成 `nextState` 的最小 RFC 6902 操作。需要給 `instance.patch()` 餵一份預先算好的 diff 時用。同一個引擎內部驅動聊天持久化、聊天狀態、樓層狀態、預設狀態——直接呼叫它能讓外掛程式加入同一份增量儲存管道。

### 何時需要 `await ready()`

四種結構性轉換由 core 在對應 `eventSource` 事件觸發**之前**同步推平。所以外掛在 `MESSAGE_DELETED` / `MESSAGE_SWIPED` / `MESSAGE_SWIPE_DELETED` / `CHAT_CHANGED` / `CHAT_BRANCH_CREATED` 監聽器裡讀樓層狀態時，看到的一定是已 settle 完的資料，**不需要** `ready()`。

`ready()` 現在主要用於跟可能並發的 `update` / `patch` in-flight 寫入串行化。沒有重建或寫入進行時，這個 Promise 會立即解析，開銷可以忽略。

### 約定

- 一個命名空間一個主人。不要在同一個命名空間同時使用 `updateChatState(ns, ...)` 與 `floorState.update(...)`——重建時會把直接寫入的部分覆蓋掉。
- 命名空間結尾為 `__floor_log` 的字串保留給樓層狀態的私有日誌，請勿佔用。
- reducer 必須回傳普通物件。陣列、基本型別、`null`、`undefined` 一律忽略。

### 參考

- `createFloorState({ namespace })`——非同步工廠，回傳凍結的實例。
- `instance.update(reducer, options?)`——讀—改—寫；reducer 收到目前狀態、回傳下一份狀態，差異自動算完並提交。可選的 `options = { floor, swipeId? }` 把提交掛到指定樓層而非聊天尾端。**這是建議的寫入 API。**
- `instance.patch(operations, options?)`——進階：追加一筆「自己已經算好 patch」的提交。operations 必須是相對 `await instance.get()` 的增量 RFC 6902 diff（`buildObjectPatchOperationsAsync(prev, next)`），不能是整盤覆寫式 snapshot。`options` 與 `update` 相同。
- `instance.reset(commits)`——原子性整盤替換日誌為給定提交清單。用於匯入 / 重建 / 重置類工作流。每筆提交都會被校驗，任意一筆結構非法或 `floor` 越界，整批拒絕。
- `instance.get()`——讀取目前 materialized 狀態。按需對日誌做重放（以目前 swipe map 為準），不讀獨立的 data 命名空間。
- `instance.ready()`——所有飛行中寫入完成時解析。
- `instance.destroy(options?)`——從註冊表移除實例。傳 `{ purge: true }` 時同時把該命名空間的狀態從磁碟抹除（用於永久重置 / 抹除場景）。

### resolveChatStateTarget

```ts
context.resolveChatStateTarget(target?: { chatId?: string, characterId?: number | string } | null): { chatId: string, characterId: number | string } | null
```

把 chat-state target 描述符按當前活躍聊天做歸一化。傳 `null`（或省略）拿到目前聊天的 `{ chatId, characterId }`;傳部分物件則用提供的欄位覆寫,另一欄位從活躍狀態填補。沒有活躍聊天且 `target` 缺 `chatId` 時回傳 `null`。

實作「預設跟隨活躍聊天但允許程式化指定目標」的儲存層時使用（例如 floor-state、chat-state API）。

## 角色狀態

角色狀態是綁定到角色卡本身的持久化儲存，在該角色的所有聊天之間共享。與聊天狀態（僅在單個聊天內有效）不同，角色狀態適合儲存跨聊天的角色級別設定。

### getCharacterState

```ts
getCharacterState(avatar: string, namespace: string): Promise<any | null>
```

讀取指定 avatar 與命名空間下的角色狀態。如果該命名空間沒有儲存過資料，回傳 `null`。

| 參數 | 說明 |
|------|------|
| `avatar` | 角色頭像檔案名（例如 `'tavernkeeper.png'`） |
| `namespace` | 儲存命名空間，通常使用外掛名稱（例如 `'my-extension'`） |

### setCharacterState

```ts
setCharacterState(avatar: string, namespace: string, data: any): Promise<void>
```

在指定命名空間下寫入角色狀態。傳 `null` 作為 `data` 可以刪除該命名空間的狀態。

| 參數 | 說明 |
|------|------|
| `avatar` | 角色頭像檔案名 |
| `namespace` | 儲存命名空間 |
| `data` | 要儲存的資料（任意可序列化物件），傳 `null` 刪除 |

### 使用範例

```js
const context = Luker.getContext();
const character = context.characters[context.characterId];

// 讀取角色狀態
const state = await context.getCharacterState(character.avatar, 'my-extension');
console.log(state); // { someConfig: true } 或 null

// 寫入角色狀態
await context.setCharacterState(character.avatar, 'my-extension', {
  someConfig: true,
  lastUpdated: Date.now(),
});

// 刪除角色狀態
await context.setCharacterState(character.avatar, 'my-extension', null);
```

### 角色狀態 vs 聊天狀態

| | 角色狀態 | 聊天狀態 |
|------|------|------|
| 作用範圍 | 綁定到角色卡，所有聊天共享 | 綁定到單個聊天 |
| 典型用途 | 角色級別的外掛設定、CardApp 應用狀態 | 聊天內的臨時資料、對話上下文 |
| API | `getCharacterState` / `setCharacterState` | `getChatState` / `getChatStateBatch` / `updateChatState` / `deleteChatState` |
| 儲存位置 | 角色卡 JSON 檔案 | 聊天中繼資料 |

## 聊天生命週期

### getCurrentChatId

```ts
getCurrentChatId(): string | undefined
```

回傳當前聊天的檔名（不含 `.jsonl`）。群組回傳群組的 `chat_id`，單人聊天回傳 `characters[characterId].chat`。沒有選中角色或群組時回傳 `undefined`。

### reloadCurrentChat

```ts
reloadCurrentChat(): Promise<void>
```

從硬碟重新載入當前聊天。使用互斥鎖——併發呼叫會被串行化，所以從多個事件處理器中呼叫是安全的。

### renameChat

```ts
renameChat(oldFileName: string, newName: string): Promise<void>
```

重新命名聊天檔案。`newName` 應該不帶 `.jsonl` 副檔名。

### openCharacterChat

```ts
openCharacterChat(fileName: string): Promise<void>
```

切換到當前角色的另一個聊天。會先清空當前的聊天資料。

### closeCurrentChat

```ts
closeCurrentChat(): Promise<boolean>
```

關閉當前聊天，返回角色列表。返回 `true` 表示成功，`false` 表示生成正在進行且使用者拒絕中斷。

### doNewChat

```ts
doNewChat(options?: { deleteCurrentChat?: boolean }): Promise<void>
```

為當前角色建立一個全新的聊天。當 `deleteCurrentChat: true` 時會刪除之前活躍的聊天檔案 — 謹慎使用，這是破壞性操作。

### getPastCharacterChats

```ts
getPastCharacterChats(characterId?: number): Promise<Array<{
    file_name: string,    // 含 ".jsonl" — 想拿 chat id 用 path.parse(name).name 取
    file_id: string,      // 不帶 ".jsonl" 的 basename;openCharacterChat 期望這種形式
    file_size: string,    // 格式化後的大小(如 "12.3 KB")
    mes: string,          // 第一條訊息預覽
    last_mes: number,     // 最後修改時間戳(ms)
}>>
```

列出某個角色已有的全部聊天。`characterId` 省略時預設為當前角色（`this_chid`）。`file_id` 欄位是應用層 chat 識別符 — 把它傳回 `openCharacterChat` / `deleteCharacterChat` / `renameChat`（這些函式期望不帶 `.jsonl` 後綴的名字）。

### deleteCharacterChat

```ts
deleteCharacterChat(characterId: string, fileName: string): Promise<void>
```

永久刪除指定角色的某個歷史聊天。`fileName` 是 chat id（不帶後綴）；末尾若帶 `.jsonl` 會被自動剝除。

### openGroupChat

```ts
openGroupChat(groupId: string, chatId: string): Promise<void>
```

切換到某個群組內的特定聊天。

### saveChat

```ts
saveChat(): Promise<void>
```

如果當前還沒在儲存，把當前聊天寫到硬碟。會等一個短時間視窗讓進行中的儲存完成，再觸發自己的儲存。多數外掛不需要呼叫這個——[訊息 API](#訊息-api) 會自動持久化。

### printMessages

```ts
printMessages(options?: { clear?: boolean }): Promise<void>
```

從記憶體中的 `chat` 陣列重新渲染聊天 DOM。在訊息 API 之外執行了大量聊天突變後使用。

### clearChat

```ts
clearChat(options?: { clearData?: boolean }): Promise<void>
```

清空已渲染的訊息。`clearData: true` 還會清空記憶體中的 `chat` 陣列並重置 `extensionPrompts`。

### sendSystemMessage

```ts
sendSystemMessage(type: string, text?: string, extra?: object): void
```

把一條系統訊息插入聊天。`type` 必須是系統訊息類型之一（`HELP`、`WELCOME`、`EMPTY`、`GENERIC`、`NARRATOR`、`COMMENT`、`SLASH_COMMANDS`、`FORMATTING`、`HOTKEYS`、`MACROS`、`WELCOME_PROMPT`、`ASSISTANT_NOTE`、`ASSISTANT_MESSAGE`）。

```js
ctx.sendSystemMessage('GENERIC', 'Plugin loaded successfully.');
```

## 擴充提示詞（深度注入）

擴充提示詞讓外掛可以在 prompt 的指定位置與深度注入文字。它們在 prompt 組裝期間被求值，並應用於每次生成請求。

### setExtensionPrompt

```ts
setExtensionPrompt(
    key: string,
    value: string,
    position: number,
    depth: number,
    scan?: boolean,
    role?: number,
    filter?: () => boolean | Promise<boolean>,
): void
```

| 參數 | 說明 |
|------|------|
| `key` | 此提示詞 slot 的唯一識別碼。重用同一 key 會覆寫 |
| `value` | 要注入的文字。傳 `''` 移除 |
| `position` | `0` = 故事字串之後（BEFORE_PROMPT）、`1` = 在聊天中於 `depth`（IN_CHAT）、`2` = 聊天之後（IN_PROMPT） |
| `depth` | `position === 1` 時，距離聊天尾端的距離。`0` = 在最後一條訊息之後 |
| `scan` | 為 `true` 時，提示詞文字會貢獻給世界書掃描 |
| `role` | 說話者角色（`0` = system、`1` = user、`2` = assistant） |
| `filter` | 可選 gate；提供且解析為 falsy 時，跳過此提示詞 |

```js
const ctx = Luker.getContext();

ctx.setExtensionPrompt(
    'my-plugin-context',
    'You have access to a calculator tool.',
    1,                  // IN_CHAT
    0,                  // depth：插在最後一條訊息之後
    false,              // 不作為 WI 來源掃描
    0,                  // SYSTEM 角色
);

// 移除提示詞
ctx.setExtensionPrompt('my-plugin-context', '');
```

### extensionPrompts

```ts
context.extensionPrompts: Record<string, ExtensionPrompt>
```

當前已註冊擴充提示詞的唯讀視圖。每次呼叫 `clearChat` 時這個 map 會被重置為 `{}`。

## Swipe API

外掛可以用程式驅動 swipe 導航，並檢視 swipe 狀態。

```ts
context.swipe.left(event?, options?): Promise<void>
context.swipe.right(event?, options?): Promise<void>
context.swipe.to(event, direction, options?): Promise<void>
context.swipe.show(): void
context.swipe.hide(options?: { hideCounters?: boolean }): void
context.swipe.refresh(updateCounters?: boolean, fade?: boolean): void
context.swipe.isAllowed(): boolean
context.swipe.state(): SwipeState
```

| 方法 | 說明 |
|------|------|
| `left` / `right` | 在指定方向 swipe（event 引數可選，僅 UI 整合需要） |
| `to` | 通用 swipe；`direction` 為 `SWIPE_DIRECTION.LEFT` / `RIGHT`。支援 `forceMesId`、`forceSwipeId`、`forceDuration` 覆寫 |
| `show` / `hide` | 切換 swipe 按鈕顯示 |
| `refresh` | 重新計算每條訊息的 swipe 控制項 |
| `isAllowed` | 當前是否允許 swipe（聊天存在、未在生成、未在動畫中） |
| `state` | 當前的 `SWIPE_STATE`（`NONE` 加上動畫中狀態） |

```js
const ctx = Luker.getContext();

if (ctx.swipe.isAllowed()) {
    await ctx.swipe.right();
}
```

## 訊息媒體輔助函式

管理訊息上的圖片 / 檔案附件的輔助函式。它們作用於訊息物件的 `extra.media` 與 `extra.files` 陣列。

### appendMediaToMessage

```ts
appendMediaToMessage(messageObj: ChatMessage, messageElement: JQuery, scrollBehavior?: string): void
```

把 `messageObj.extra.media[]` 與 `messageObj.extra.files[]` 中的所有媒體渲染到指定的訊息元素中。會遵循 `media_display` 與 `inline_image` 旗標。在重新渲染加入了媒體的訊息時用得到。

### ensureMessageMediaIsArray

```ts
ensureMessageMediaIsArray(messageObj: ChatMessage): void
```

就地把舊版的單條 `extra.media` / `extra.image` 屬性遷移成陣列。若需要處理可能由舊程式寫過的訊息，先呼叫此函式再讀 `extra.media`。

### getMediaDisplay

```ts
getMediaDisplay(messageObj: ChatMessage): string
```

回傳訊息的 `MEDIA_DISPLAY` 模式（預設取全域設定）。

### getMediaIndex

```ts
getMediaIndex(messageObj: ChatMessage): number
```

回傳當前選中的媒體索引，會被夾到有效的 `0..media.length-1` 範圍內。索引超出範圍時回傳 `0`。

### scrollChatToBottom

```ts
scrollChatToBottom(options?: { waitForFrame?: boolean }): void
```

把聊天滾動到底部。當使用者已往上滾且 `auto_scroll_chat_to_bottom` 為關時是 no-op。`waitForFrame: true` 會先等 `requestAnimationFrame` 讓 layout 穩定。

### scrollOnMediaLoad

```ts
scrollOnMediaLoad(): Promise<void>
```

等所有聊天 `<img>` / `<video>` / `<audio>` 元素的 load 事件（帶 timeout）並在它們確定 layout 後重新錨定捲動位置。在加入媒體後呼叫，這樣聊天不會跳動。
