# 角色卡取代流程

使用者在角色管理選單中執行**取代／更新**時，新卡檔案會覆蓋舊卡 PNG。聊天、資源和群組成員關係會保留，但舊卡存在 `data.extensions.*` 裡的一切、以及角色卡的世界書狀態，都需要核心來協調。核心透過兩個按順序執行的登錄表承擔這份協調，時機都在 `CHARACTER_REPLACED` 事件發出之前：

1. **卡繫結保護** —— 槽位登錄表：新卡缺少的本地繫結靜默寫回，衝突的彈窗詢問。
2. **取代後世界書動作** —— 動作登錄表：決定世界書的去向——匯入新卡的內嵌世界書、保留原來繫結的世界書、或執行外掛註冊的動作。

兩個登錄表共享同一套形態：屬主在擴充 init 中登錄描述元，核心不硬編碼外掛語意；被停用的外掛不會登錄——它的保護/動作隨之消失，而核心自己的始終生效。

## 流程順序

```text
取代／更新（檔案或 URL）
  → 新卡原樣匯入同一 avatar
  → 卡繫結保護引擎              （槽位登錄表）
  → 取代後世界書彈窗            （動作登錄表）
  → 發出 CHARACTER_REPLACED
```

兩步都在 `emitCharacterReplacedEvent` 內部、任何監聽器被通知之前執行，因此寫入發生在外掛回應事件之前。世界書這一步是 await 的：如果某個動作開啟了長時間存在的介面（例如角色卡編輯助手的合併工作台），該事件會延後到介面關閉之後，監聽器隨後看到的是已定狀態——要麼新書已繫結，要麼回滾已恢復舊書。

## 第一部分 —— 卡繫結保護

沒有保護機制時，存在 `data.extensions.*` 裡的本地繫結——繫結的對話補全預設、角色專屬人設、編排的本卡預設、記憶圖訂製、CardApp 開關——都會隨舊卡一起遺失。槽位登錄表保護它們。引擎會針對每個已登錄槽位比較舊卡和新卡：

- **僅舊卡有** —— 舊卡設定了該繫結，新卡沒有。引擎靜默寫回本地值。
- **衝突** —— 兩張卡都定義了該繫結且值不同。彈窗逐類列出衝突項，使用者可按類選擇保留本地值或採用新卡的值。
- **相同** —— 值深度相等，不做任何處理。
- **僅新卡有** —— 新卡自帶的繫結原樣保留（與一般匯入一致）。

### 登錄槽位

屬主在擴充 init 中為每個繫結類別登錄一個描述元：

```js
const context = Luker.getContext();

context.registerCardBindingSlot({
    id: 'my-binding',
    label: () => context.translate('My binding'),
    read: character => readMyBinding(character),
    isPresent: value => Boolean(value),
    summarize: value => summarizeMyBinding(value),
    write: async (characterId, value) => {
        const previous = context.characters[characterId]?.data?.extensions?.my_namespace;
        await context.writeExtensionField(characterId, 'my_namespace', { ...previous, my_binding: value });
    },
});
```

| 欄位 | 類型 | 說明 |
| --- | --- | --- |
| `id` | `string` | 唯一且穩定的槽位 id。僅允許字母、數字、`_` 與 `-`，且必須以字母開頭。重複登錄同一 id 會印出警告並覆蓋舊描述元。 |
| `label` | `() => string` | 使用者可見的類別名稱，由屬主負責翻譯。 |
| `read` | `(character) => value \| null` | 從角色物件純讀取，不得排程寫入或遷移。 |
| `isPresent` | `(value) => boolean` | 該值是否算作用戶設定過。 |
| `summarize` | `(value) => string` | 衝突彈窗中該側的一行摘要。 |
| `write` | `async (characterId, value) => void` | 寫回值。`characterId` 是 `context.characters` 的索引。 |

描述元缺少必需函式時 `registerCardBindingSlot` 會直接拋錯，讓錯誤在載入期暴露，而不是等到取代發生。

### 寫回責任

`write` 只收到 `read` 產出的值。屬主需要：

- 透過 `context.characters[characterId]` 解析角色；
- 合併兄弟鍵——`context.writeExtensionField` 會整體置換該命名空間的值，先讀取目前資料再展開、覆蓋被保護的鍵；
- 失敗時拋錯。引擎會 toast 報錯並繼續處理其餘槽位，絕不阻斷取代。

### 已停用的擴充

槽位在擴充 init 時登錄。被停用或未載入的擴充不會登錄槽位，因此其卡繫結在取代時不受保護。這是刻意設計：引擎不硬編碼擴充的欄位語意。核心繫結（繫結預設、角色專屬人設）始終受保護。

當繫結預設被保留時，引擎還會重新套用角色卡繫結預設，讓目前工作階段採用保留的預設值。

## 第二部分 —— 取代後世界書動作

繫結保護之後，核心會執行一步決策：只要本次取代存在至少一個可用動作，就會彈出對話框詢問使用者如何處理角色卡的世界書。核心註冊兩個動作——「匯入新世界書」（把新卡自帶的內建世界書另存為獨立檔案並繫結）和「保留舊世界書」（重新繫結原來的主世界書）。外掛可以註冊更多動作。

### 註冊動作

```js
const ctx = Luker.getContext();

ctx.registerPostReplaceAction({
    id: 'my-action',
    label: () => ctx.translate('My action'),
    description: (detail) => ctx.translate('What this action does.'),
    isAvailable: (detail) => detail.hasNewEmbeddedBook,
    run: async (detail) => { /* 執行動作 */ },
});
```

| 欄位 | 型別 | 契約 |
| ---- | ---- | ---- |
| `id` | string | 唯一且穩定。只允許字母、數字、`_` 和 `-`，且必須以字母開頭。非法 id、缺少函式或非物件描述元會拋出 `TypeError`。重複登錄同一個 id 會記錄警告並取代舊描述元，同時保留它在清單中的位置。 |
| `label()` | 函式 → string | 按鈕文字。 |
| `description(detail)` | 函式 → string | 對話框中標籤旁的一行說明。 |
| `isAvailable(detail)` | 函式 → boolean | 本次取代是否提供該動作。檢查過程拋錯會記錄警告並跳過該動作。 |
| `run(detail)` | 非同步函式 | 執行動作。執行拋錯會記錄警告並顯示錯誤提示，取代流程本身不受影響。 |

規則：

- 按鈕按註冊順序排列，第一個可用動作是彈窗的預設項（實心按鈕）。
- 只有存在至少一個可用動作時才會彈出對話框。沒有全域開關：外掛被停用就不會註冊，其動作自然消失，而核心動作始終生效。
- 彈窗最多顯示 9 個動作（彈窗 API 的自訂按鈕上限），超出部分會被截斷並輸出主控台警告。
- `label()` 拋錯時回退為動作 id；`description()` 拋錯會記錄警告並顯示空說明。取消對話框不會執行任何動作，取代流程照常繼續。

### `detail` 物件

| 欄位 | 說明 |
| ---- | ---- |
| `characterId` | 被取代角色在 `ctx.characters` 中的索引。 |
| `character` | 取代後的即時角色物件。 |
| `previousCharacter` | 取代前的角色卡複本，可能為 `null`。 |
| `previousLorebookSnapshot` | 從原主世界書擷取的 `{ avatar, characterName, bookName, entries, capturedAt }`，可能為 `null`。 |
| `previousBookName` | 原來的主世界書名（沒有則為 `''`）。 |
| `previousBookExists` | 該世界書是否仍然存在。 |
| `hasNewEmbeddedBook` | 新卡是否帶有非空的 `data.character_book`。 |
| `source` | 目前恆為 `'replace_update'`。 |

### 上下文 API

| 函式 | 說明 |
| ---- | ---- |
| `registerCardBindingSlot(descriptor)` | 登錄繫結槽位，見第一部分。 |
| `listCardBindingSlots()` | 按登錄順序回傳槽位描述元清單。 |
| `registerPostReplaceAction(descriptor)` | 登錄動作，見第二部分。 |
| `listPostReplaceActions()` | 按登錄順序回傳動作描述元清單。 |
| `importEmbeddedBookForCharacter(characterId)` | 把角色卡的內嵌世界書另存為獨立檔案並繫結為主世界書。角色不存在或匯入入口不可用時拋出例外。 |
| `rebindPreviousPrimaryBook(characterId, bookName)` | 把已有世界書繫結為角色的主世界書。 |
