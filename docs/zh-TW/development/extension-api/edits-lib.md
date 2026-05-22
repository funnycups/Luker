# Edits 函式庫

帶 op 型別的結構化編輯，具備漂移感知套用與互動式衝突解決。

## 何時使用

當您的擴充具有以下形態時，使用本函式庫：

1. AI 工具呼叫對一個使用者擁有的結構化物件（JSON、preset、角色卡、圖等）
   提出修改建議
2. 使用者審閱這些修改建議，並決定是否套用
3. 該物件在「提出建議」與「套用」之間，可能被外部編輯

不使用本函式庫時，您必須自己手動維護基線、偵測漂移，並為每個擴充單獨寫
衝突 UI。使用本函式庫後，所有消費者共用同一套合併引擎與同一套解決 UX。

## 概念

- **Edit** —— 一個帶標籤的物件，描述一次帶 op 型別的修改。
  內建 op：`set`、`unset`、`str_replace`、`str_insert`、`str_delete`、
  `list_insert`、`list_remove`、`list_move`。
- **Apply** —— `applyEdits(edits, live)` 回傳 `{ newLive, clean,
  conflicts, alreadyDone }`。引擎在改動之前，會針對目前 live 對每一條
  編輯做漂移檢查。
- **Inverse** —— `inverseEdit(edit)` 回傳能夠撤銷該編輯的反向編輯，
  適合用於回滾。
- **自訂 op** —— `registerOp(name, handler)` 允許擴充定義領域特定的
  變更。

## API

三層介面暴露同一套表面：

```js
// Layer 1 — ESM
import { applyEdits, inverseEdit, registerOp, getRegisteredOp,
         listRegisteredOps, showConflictResolution,
         BUILT_IN_OPS } from '/scripts/lib/edits/index.js';

// lukerContext
lukerContext.edits.applyEdits(...);
lukerContext.edits.showConflictResolution(...);

// getContext
SillyTavern.getContext().edits.applyEdits(...);
SillyTavern.getContext().edits.showConflictResolution(...);
```

`showConflictResolution` 同時也從 `/scripts/lib/edits/conflict-ui.js`
re-export 出來以保持向後相容，但新程式碼應從 `index.js` 匯入（或走
`lukerContext` / `getContext()` 這兩層），以便與 API 的其餘部分保持一致。

### `applyEdits(edits, live)`

| 參數 | 型別 | 說明 |
| --- | --- | --- |
| `edits` | `Edit[]` | 依序套用的帶 op 型別編輯清單 |
| `live`  | `any`    | 目前的 live 物件（內部會深層複製，不會被修改） |

回傳：

```js
{
    newLive: any,                   // 套用後的 live
    clean:    Edit[],               // 無衝突套用的編輯(部分 op 會就地補上資訊以支援反向)
    conflicts: ConflictEntry[],     // 錨點 / 基線與目前 live 不相符的編輯
    alreadyDone: Edit[],            // 效果已經存在於目前 live 中的編輯
}
```

### `inverseEdit(edit)`

回傳能夠撤銷 `edit` 的反向編輯。某些 op 會要求 `edit` 必須先經過
`applyEdits`（以便填入諸如 `_inserted_at` 或 `_anchor_context` 之類
的內部錨點上下文）—— 當您儲存的是 `result.clean` 而非原始編輯陣列
時，引擎會自動幫您處理這一點。

### `registerOp(name, handler)`

| 欄位 | 是否必填 | 說明 |
| --- | --- | --- |
| `apply(deps, edit, live)` | 是 | 就地修改 live 並回傳它 |
| `inverse(edit)` | 是 | 回傳反向 Edit |
| `detectConflict(deps, edit, live)` | 是 | 乾淨時回傳 `null`，衝突時回傳 `{reason, baseline?, current?}`，無操作時回傳 `{reason: 'already_done'}` |
| `renderConflict(entry)` | 否 | 可選，自訂衝突 UI 的 DOM |

`deps` 是 `{get, set, unset, isEqual, cloneDeep}`（lodash 方法）。
保留的 op 名稱：`set`、`unset`、`str_*`、`list_*`。自訂 op 請使用
`domain.action` 命名（如 `node.add`、`entry.update`）。

### 內建 op 參考

#### `set`
```js
{ op: 'set', path, oldValue, newValue }
```
取代 lodash path 處的值。目前值既不是 `oldValue` 也不是 `newValue`
時為衝突；目前值等於 `newValue` 時視為已完成。

#### `unset`
```js
{ op: 'unset', path, expected_value? }
```
刪除某個鍵（差別於將其設為 undefined）。path 不存在時視為已完成。
設定了 `expected_value` 且目前值與之深度不等時為衝突。

#### `str_replace`
```js
{ op: 'str_replace', path, find, replace, expected_count? }
```
取代 `path` 處字串中所有出現的 `find`。`expected_count` 預設為 1
—— 當 AI 想要取代多處時需要明確設定。衝突：`anchor_missing`
（計數為 0）、`anchor_ambiguous`（計數 ≠ 預期）。

#### `str_insert`
```js
{ op: 'str_insert', path, after_text, insert_text }
```
在 `after_text` 的唯一出現之後插入 `insert_text`。衝突：錨點缺失
或不唯一。

#### `str_delete`
```js
{ op: 'str_delete', path, find }
```
從字串中刪除唯一的 `find`。在 apply 時擷取周邊上下文，以便反向
的 `str_insert` 能找回正確的位置。

#### `list_insert`
```js
{ op: 'list_insert', path, anchor: { before_index|after_index|after_value }, value }
```
將 `value` 插入陣列。`after_value` 是最抗漂移的錨點（只要該值仍然
唯一，即使發生了重新排序也能保留）。

#### `list_remove`
```js
{ op: 'list_remove', path, index, expected_value? }
```
splice 掉 `index` 處的元素。`expected_value` 用於防範外部的偏移。

#### `list_move`
```js
{ op: 'list_move', path, from_index, to_index, expected_value? }
```
移動一個元素。`from === to` 時為無操作。

## 衝突 UI

`showConflictResolution(conflicts, opts?)` 回傳 `Promise<Resolution[] | null>`。
- `null` 代表使用者取消了整次套用。
- 每一個 `Resolution` 為以下之一：
  - `{ decision: 'apply-mine', edit }` —— 用提案覆寫 live
  - `{ decision: 'keep-theirs', edit }` —— 跳過這一條編輯
  - `{ decision: 'manual', edit, newValue }` —— 使用者提供的值

要讓使用者的決策生效，請用解析後的值重新建構編輯陣列，並再次呼叫
`applyEdits`（如果使用者選擇的是確定性的解決方案，結果中應該不會再
有衝突）。

## Path 2: library-only（自定義 UI / 全屏）

如果你的擴充套件已經擁有自己的彈窗，或者想接管 viewport（例如 IDE 風格的編輯器），可以不走 iteration-studio 外殼直接用 edits-lib。直接 import 三個原語：

```js
import { applyEdits, inverseEdit, registerOp } from '/scripts/lib/edits/index.js';
import { showConflictResolution } from '/scripts/lib/edits/conflict-ui.js';
```

UI、生命週期、會話儲存、工具分發、審批流程全歸你。edits-lib 給你的能力：

- **Op 類型化的 Edit 批次** —— 對你的業務程式碼不透明，但語義足以支援 inverse 與衝突檢測。
- **感知漂移的 apply** —— `applyEdits(edits, live)` 回傳 `{ newLive, clean, conflicts, alreadyDone }`。衝突會暴露「使用者在 AI 提案之後又改了什麼」，可直接交給 `showConflictResolution`。
- **Inverse op** —— `inverseEdit(edit)` 給任意一條 edit 生成撤銷操作。倒序遍歷一條訊息上的 `appliedEdits` 就能 undo 一整輪。
- **自定義 op** —— `registerOp('myCustomOp', handler)` 讓你給 lib 加上業務專用語義（檔案 patch、世界書 entry 增刪等），並讓自定義 op 跟內建 op 一起參與 conflict / inverse。

**參考實作**：`extensions/character-editor-assistant/studio/`。CardApp Studio 是一個全屏 IDE（兩塊 `position:fixed` 面板 + CodeMirror 6 + 檔案樹 + 行動端 tab bar），接管 viewport。AI 的檔案操作走 `applyEdits` + 自定義 `cardapp_patch_file` op（在 `index.js` 模組載入時註冊），由 studio 自己的審批卡片在 commit 前顯示逐檔案 DiffMatchPatch diff。

**Path 2 vs Path 1（iteration-studio 外殼適配器）選哪條：**

| 需求 | Path |
|---|---|
| 工件短，彈窗形式合適 | Path 1 |
| 讓外殼處理會話 / 歷史 / abort / 重試 / 自動續寫 | Path 1 |
| 想用一個適配器檔案快速 ship | Path 1 |
| 需要 viewport 所有權（IDE、行動端接管） | Path 2 |
| 已經有一套成熟獨立 UI 想保留 | Path 2 |
| 想完全掌控 UX 細節 | Path 2 |

兩條路徑在程式碼層並不互斥 —— 它們共享 edits-lib。Path 2 的介面以後想換成 Path 1（或反過來），只需替換 UI 宿主。

## 範圍外提醒

- 本函式庫**不**管理編輯歷史、journal、復原堆疊或會話 —— 這是您擴充的
  責任。典型做法是把 `result.clean` 存到產生這些編輯的訊息上，然後
  透過 `inverseEdit` 反序走訪來完成回滾。
- 本函式庫**不**會在衝突時去提示 AI —— 由使用者決定。如果您想要 AI 驅動
  的合併，請在您的擴充裡基於衝突結果自行實作。
