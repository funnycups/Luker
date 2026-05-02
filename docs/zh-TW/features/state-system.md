# 狀態系統

Luker 引入了一套狀態系統，允許角色卡、聊天和預設攜帶持久化的狀態資料。擴充功能和 CardApp 可以利用這套系統儲存和讀取自訂資料，而無需修改角色卡或聊天記錄本身。

## 角色狀態

每個角色可以擁有獨立的狀態資料，按命名空間隔離。不同的擴充功能或 CardApp 使用各自的命名空間，互不干擾。

例如，一個記憶擴充功能可以在角色狀態中儲存該角色的記憶摘要，而一個 CardApp 可以在同一角色上儲存遊戲進度——兩者透過不同的命名空間各自獨立運作。

### 運作方式

- **讀取狀態**：透過角色標識和命名空間取得該角色在該命名空間下的狀態資料
- **寫入狀態**：將資料儲存到指定角色的指定命名空間中
- **自動持久化**：狀態資料會自動儲存到磁碟，服務重啟後不會遺失

角色狀態的生命週期與角色本身綁定——當角色被刪除時，其關聯的狀態資料也會被清理。

## 聊天狀態

Luker 將聊天狀態按命名空間儲存為聊天檔案旁的 sidecar 檔案，命名模式為 `<聊天檔案基名>.luker-state.<namespace>.json`。

### 狀態檔案的特點

- 以 sidecar 檔案形式儲存在聊天檔案所在目錄（不是單一全域狀態檔）
- 同一聊天可存在多個狀態 sidecar（每個 namespace 一個），在首次寫入時懶建立
- 與聊天檔案生命週期綁定：聊天被重新命名時，關聯 sidecar 同步重新命名；聊天被刪除時，關聯 sidecar 同步刪除
- 支援增量更新，不需要每次都寫入完整資料

### 儲存內容

聊天狀態檔案可以儲存各種與聊天相關的輔助資訊，例如：

- 生成任務的確認狀態
- 擴充功能為該聊天儲存的自訂資料
- 其他不適合直接寫入聊天記錄的中繼資料

::: tip
聊天狀態檔案是 Luker 自動管理的，你通常不需要手動編輯它們。如果你從 SillyTavern 遷移資料，這些檔案會在首次使用時自動建立。
:::

## 預設狀態

Luker 同樣支援為預設附加狀態資料。預設狀態允許擴充功能在特定預設上儲存設定或執行時資訊，當使用者切換預設時，相關的狀態資料也會隨之切換。

## 狀態的持久化和生命週期

狀態系統遵循以下原則：

| 狀態類型 | 儲存位置 | 生命週期 |
| --- | --- | --- |
| 角色狀態 | 角色卡同目錄 sidecar（`<角色名>.state.<namespace>.json`） | 首次命名空間寫入時建立；隨角色重新命名/刪除聯動 |
| 聊天狀態 | 聊天同目錄 sidecar（`<聊天名>.luker-state.<namespace>.json`） | 首次命名空間寫入時建立；隨聊天重新命名/刪除聯動 |
| 預設狀態 | 預設同目錄 sidecar（`<預設名>.luker-state.<namespace>.json`） | 首次命名空間寫入時建立；隨預設重新命名/刪除聯動 |

所有狀態資料都會持久化到磁碟，不會因為服務重啟而遺失。狀態檔案的清理是自動的——當關聯的角色、聊天或預設被刪除時，對應的狀態檔案也會被自動清理。

## 使用場景

### CardApp 狀態追蹤

CardApp 是狀態系統最典型的使用者。角色卡內嵌的應用可以透過狀態系統儲存遊戲進度、使用者偏好、互動歷史等資料。例如，一個 RPG 類型的 CardApp 可以將角色的等級、裝備、任務進度等資訊儲存在角色狀態中。

詳見 [CardApp](/zh-TW/features/cardapp)。

### 擴充功能資料儲存

第三方擴充功能可以利用狀態系統為每個角色或聊天儲存自訂資料，而無需自行管理檔案讀寫。這簡化了擴充功能開發，也確保了資料的生命週期管理是正確的。

詳見 [擴充 API](/zh-TW/development/extension-api)。

### 記憶系統

[Memory Graph](/zh-TW/features/memory-graph) 等記憶類擴充功能可以利用角色狀態儲存記憶摘要和索引資料，實現按角色隔離的記憶管理。

## 樓層狀態（可回退的聊天狀態）

普通聊天狀態只能整體覆寫：使用者回切 swipe、刪訊息或切換聊天時，外掛得自己重新讀取命名空間、自己對帳資料。樓層狀態在聊天狀態之上加了一層薄封裝，自動處理這件事。每次寫入都會附帶聊天尾端的位置（樓層索引 + swipe 編號）記入日誌，聊天結構變化時自動重播。

### 運作方式

一個樓層狀態實例獨佔一個聊天狀態命名空間（`<ns>`）以及一份私有提交日誌（`<ns>__floor_log`）。所有寫入都透過實例的 `update` 方法進入：它讀取目前狀態、執行你的 reducer、計算差異、把差異寫入業務命名空間並追加一筆提交。實例訂閱四個聊天事件：

- `CHAT_CHANGED`——切換到新聊天，依這份聊天的日誌重建資料
- `MESSAGE_SWIPED`——使用者切換 swipe，依新的作用 swipe 重建資料
- `MESSAGE_DELETED`——聊天被截短，丟棄樓層超出新長度的提交後重建
- `MESSAGE_SWIPE_DELETED`——聊天尾端某個 swipe 被刪除,該樓層的提交重新編號後重建

每筆提交存的是「提交當下 materialized 狀態 → 下一份狀態」的增量 diff。重建依寫入順序遍歷所有提交,丟棄 `(floor, swipeId)` 已不在當前作用 swipe 上的提交,然後把倖存的 patch 依序套用在 `{}` 上。刪除事件都只發生在尾端——`MESSAGE_DELETED` 只截尾端、`MESSAGE_SWIPE_DELETED` 也只在聊天尾端觸發——所以作用路徑上的倖存提交始終是連續的鏈,增量 patch 正確組合。

### 建立實例

在外掛或 CardApp 裡使用 `getContext().createFloorState({ namespace })`。每個實例綁定一個命名空間；若業務狀態分多塊，請建立多個實例。

```js
const ctx = SillyTavern.getContext();
const fs = await ctx.createFloorState({ namespace: 'my-plugin' });

// 推薦:reducer 風格寫入。reducer 收到目前狀態、回傳下一份狀態,差異自動算完並提交。
await fs.update((current) => ({ ...current, score: 10 }));
await fs.update((current) => ({ ...current, level: (current?.level ?? 0) + 1 }));
await fs.update((current) => {
    const { temp, ...rest } = current ?? {};
    return rest;
});

// 讀取目前狀態:
const state = await fs.get();

// 在讀取前等待重建完成:
await fs.ready();

// 解除事件監聽(極少需要,實例通常與頁面同壽):
fs.destroy();
```

::: warning
reducer 必須回傳普通物件。回傳陣列、基本型別、`null`、`undefined` 一律視作「無變化」,呼叫直接成功回傳但不寫入。
:::

### 把狀態掛到非尾端的樓層

`update` 接受一個可選的第二參數 `{ floor, swipeId? }`,用來把這次提交顯式掛到指定樓層,而不是聊天尾端。常見場景是「滯後寫入」——例如記憶擴充功能在使用者設定「最後 N 層不參與生成」時,需要把摘要掛到 `chat.length - N` 而不是目前最新樓層。

```js
// 只指定 floor:swipeId 自動取 chat[floor].swipe_id
await fs.update(
    (current) => ({ ...current, summaries: { ...(current?.summaries ?? {}), 0: '...' } }),
    { floor: targetFloor },
);

// 同時指定 floor + swipeId(用於回填某條具體 swipe 上的狀態)
await fs.update((current) => nextState, { floor: targetFloor, swipeId: 0 });
```

不傳 `options` 時依聊天尾端推斷。`floor` 必須是目前 `chat` 的有效索引(`0 <= floor < chat.length`),越界、負數、非整數、負 `swipeId` 都會被拒絕並回傳 `false`,避免悄無聲息地把狀態錯掛到不存在的樓層。

::: tip
覆寫只影響這條提交在日誌中的標籤——`MESSAGE_DELETED` 仍依 floor 截斷,`MESSAGE_SWIPE_DELETED` 仍依 (floor, swipeId) 重新編號。重建順序由日誌的寫入順序決定,不會因為你指定了較小的 `floor` 就被「插隊」到前面執行。
:::

### 進階:預先算好的 patch

如果你已經手上有一份針對目前 materialized 狀態的增量 RFC 6902 diff——例如基於效能考量自己算了 diff、或者在跑一次性遷移——可以呼叫 `instance.patch(operations, options?)` 直接追加。operations 必須是 `buildObjectPatchOperationsAsync(prev, next)` 形式的增量 diff,prev 取自 `await fs.get()`;不能傳「整盤覆寫」式的 snapshot patch,因為重建假設每筆提交的 patch 與前面倖存提交的 patch 依序組合。

其他場景一律走 `update`——它會幫你算好 diff。

### 何時需要 `await ready()`

若外掛在 `GENERATION_STARTED` 之類緊接在四個結構事件之後的鉤子裡讀樓層狀態，請先 `await fs.ready()`。沒有重建進行時，這個 Promise 會立即解析，開銷可以忽略。

### 約定

- 一個命名空間一個主人。不要在同一個命名空間同時使用 `patchChatState(ns, ...)` 與 `floorState.update(...)`——重建時會把直接寫入的部分覆蓋掉。
- 命名空間結尾為 `__floor_log` 的字串保留給樓層狀態的私有日誌，請勿佔用。
- reducer 必須回傳普通物件。陣列、基本型別、`null`、`undefined` 一律忽略。

### 參考

- `createFloorState({ namespace })`——非同步工廠，回傳凍結的實例。
- `instance.update(reducer, options?)`——讀—改—寫;reducer 收到目前狀態、回傳下一份狀態,差異自動算完並提交。可選的 `options = { floor, swipeId? }` 把提交掛到指定樓層而非聊天尾端。**這是建議的寫入 API。**
- `instance.patch(operations, options?)`——進階:追加一筆「自己已經算好 patch」的提交。operations 必須是相對 `await instance.get()` 的增量 RFC 6902 diff(`buildObjectPatchOperationsAsync(prev, next)`),不能是整盤覆寫式 snapshot。`options` 與 `update` 相同。
- `instance.get()`——讀取業務命名空間。
- `instance.ready()`——重建結束時解析。
- `instance.destroy()`——解除事件監聽並凍結實例。

## 相關頁面

- [CardApp](/zh-TW/features/cardapp) — 角色卡內嵌應用系統
- [擴充 API](/zh-TW/development/extension-api) — 擴充功能開發介面
- [增量同步](/zh-TW/improvements/incremental-sync) — 聊天資料的增量儲存機制
