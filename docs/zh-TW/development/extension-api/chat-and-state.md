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
```

::: warning
reducer 必須回傳普通物件。回傳陣列、基本型別、`null`、`undefined` 一律視作「無變化」，呼叫直接成功回傳但不寫入。
:::

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
覆寫只影響這條提交在日誌中的標籤——`MESSAGE_DELETED` 仍依 floor 截斷，`MESSAGE_SWIPE_DELETED` 仍依 (floor, swipeId) 重新編號。重建順序由日誌的寫入順序決定，不會因為你指定了較小的 `floor` 就被「插隊」到前面執行。
:::

### 進階：預先算好的 patch

如果你已經手上有一份針對目前 materialized 狀態的增量 RFC 6902 diff——例如基於效能考量自己算了 diff、或者在跑一次性遷移——可以呼叫 `instance.patch(operations, options?)` 直接追加。operations 必須是 `buildObjectPatchOperationsAsync(prev, next)` 形式的增量 diff，prev 取自 `await fs.get()`；不能傳「整盤覆寫」式的 snapshot patch，因為重建假設每筆提交的 patch 與前面倖存提交的 patch 依序組合。

其他場景一律走 `update`——它會幫你算好 diff。

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
- `instance.get()`——讀取業務命名空間。
- `instance.ready()`——重建結束時解析。
- `instance.destroy()`——從註冊表移除實例並凍結它。

## 角色狀態

角色狀態是綁定到角色卡本身的持久化儲存，在該角色的所有聊天之間共享。與聊天狀態（僅在單個聊天內有效）不同，角色狀態適合儲存跨聊天的角色級別設定。

### getCharacterState

```ts
getCharacterState(namespace: string): Promise<any | null>
```

讀取指定命名空間下的角色狀態資料。如果該命名空間沒有儲存過資料，回傳 `null`。

| 參數 | 說明 |
|------|------|
| `namespace` | 儲存命名空間，通常使用外掛名稱（如 `'my-extension'`） |

### setCharacterState

```ts
setCharacterState(namespace: string, data: any): Promise<void>
```

寫入指定命名空間下的角色狀態資料。傳入 `null` 作為 `data` 可以刪除該命名空間的狀態。

| 參數 | 說明 |
|------|------|
| `namespace` | 儲存命名空間 |
| `data` | 要儲存的資料（任意可序列化物件），傳 `null` 刪除 |

### 使用範例

```js
const context = Luker.getContext();

// 讀取角色狀態
const state = await context.getCharacterState('my-extension');
console.log(state); // { someConfig: true } 或 null

// 寫入角色狀態
await context.setCharacterState('my-extension', {
  someConfig: true,
  lastUpdated: Date.now(),
});

// 刪除角色狀態
await context.setCharacterState('my-extension', null);
```

### 角色狀態 vs 聊天狀態

| | 角色狀態 | 聊天狀態 |
|------|------|------|
| 作用範圍 | 綁定到角色卡，所有聊天共享 | 綁定到單個聊天 |
| 典型用途 | 角色級別的外掛設定、CardApp 應用狀態 | 聊天內的臨時資料、對話上下文 |
| API | `getCharacterState` / `setCharacterState` | `getChatState` / `getChatStateBatch` / `updateChatState` / `deleteChatState` |
| 儲存位置 | 角色卡 JSON 檔案 | 聊天中繼資料 |
