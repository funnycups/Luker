# 角色卡

讀取角色卡、修改角色欄位、匯入角色、管理標籤的相關 API。`context.characters` 陣列被一個 Proxy 包裹，讀寫語義有特殊規則——詳見下方 [Proxy 語義](#proxy-semantics)。

## 讀取角色

### context.characters

```ts
context.characters: Character[]
```

所有已載入角色物件的陣列。被 Proxy 包裹後同時支援 V2（`character.data.*`）和傳統根層級欄位存取——詳見 [Proxy 語義](#proxy-semantics)。

### context.characterId

```ts
context.characterId: number | undefined
```

當前選中角色在 `context.characters` 中的索引。沒有選中角色時（例如群組聊天中）為 `undefined`。

### getOneCharacter

```ts
getOneCharacter(avatarUrl: string): Promise<void>
```

從伺服器重新拉取單一角色，並替換 `context.characters` 中對應的 slot（以 `avatar` 欄位匹配）。在伺服器端變動後刷新記憶體狀態時用得到。

### getCharacters

```ts
getCharacters(): Promise<void>
```

重新拉取完整角色列表。會觸發 UI 重渲染。如果伺服器回報資料量過大，會顯示警告 toast。

### getOneCharacter vs getCharacters

| 用法 | 何時使用 |
|------|------|
| `getOneCharacter(avatar)` | 某張卡在伺服器端被改了，只刷新那一張 |
| `getCharacters()` | 發生了批量匯入 / 刪除，全部刷新 |

### getCharacterCardFields

```ts
getCharacterCardFields(options?: { chid?: number }): {
    system: string,
    mesExamples: string,
    description: string,
    personality: string,
    persona: string,
    scenario: string,
    jailbreak: string,
    version: string,
    charDepthPrompt: string,
    creatorNotes: string,
    firstMessage: string,
    alternateGreetings: string[],
}
```

回傳經過巨集替換和 persona 注入後解析完成的角色欄位。`chid` 省略時預設取當前角色。當你需要為 prompt 組裝準備好的欄位時，應該用這個函式取代直接讀 `character.data.*`。

### getCharacterSource

```ts
getCharacterSource(chId?: number | string): string
```

回傳角色卡的標準來源 URL（chub、pygmalion、github、perchance、risuai 或 `data.extensions.source_url`）。沒有來源中繼資料時回傳 `''`。

### getCharaFilename

```ts
getCharaFilename(
    chid?: number | string | null,
    options?: { manualAvatarKey?: string },
): string | null
```

回傳角色的頭像檔案名稱**不含副檔名**。`chid` 省略時退回到當前角色。當你只持有 avatar key 字串時（例如來自角色狀態條目）可傳 `manualAvatarKey`。無法解析出 avatar 時回傳 `null`。

```js
const ctx = Luker.getContext();
const filename = ctx.getCharaFilename();  // 例如 'tavernkeeper'
```

### getThumbnailUrl

```ts
getThumbnailUrl(type: string, file: string, t?: boolean): string
```

為頭像 / 背景 / 世界建構縮圖端點 URL。`t: true` 會附上一個破快取的時間戳。

## 選擇與載入角色

### selectCharacterById

```ts
selectCharacterById(id: number, options?: { switchMenu?: boolean }): Promise<void>
```

切換當前角色。在以下情況靜默放棄：
- 角色不存在
- 聊天儲存正在進行中（會顯示一個 toast）

`switchMenu` 預設 `true`，再次選中同一角色時會開啟角色編輯面板。

### unshallowCharacter

```ts
unshallowCharacter(characterId: number | string): Promise<void>
```

為以淺層形式回傳的角色（只有 avatar + 基本中繼資料）載入完整紀錄。已完整載入時為 no-op。如果你從列表端點取得角色，在讀取 `description`、`mes_example` 這類大欄位前一定要先呼叫這個。

### unshallowGroupMembers

```ts
unshallowGroupMembers(groupId: string): Promise<void>
```

群組批次版——對群組中每個成員都呼叫一次 `unshallowCharacter`。

## 寫入角色欄位

### writeExtensionField

```ts
writeExtensionField(
    characterId: number | string,
    key: string,
    value: any,
): Promise<void>
```

寫入角色卡的 `data.extensions[key]` 並持久化。

**替換語義。** 完整的 `value` 會成為磁碟上新的 `data.extensions[key]`。先前磁碟值中存在的兄弟子鍵**不會**被保留——希望做局部更新的呼叫方必須自行讀取舊值、展開並疊加變更。`data.extensions.*` 下的其他擴充 key（其他外掛的資料）則永遠不會被觸碰。

傳 `value: context.constants.unset`（即 `UNSET_VALUE` 哨兵值）可徹底刪除該 key。傳裸 `null` 寫入的是字面量 `null`（key 仍然保留）。

```js
const ctx = Luker.getContext();

// 把 data.extensions.my_plugin_state 整體替換為 { level: 5 }。
// my_plugin_state 之前的任何其他子鍵都會被清除。
await ctx.writeExtensionField(ctx.characterId, 'my_plugin_state', { level: 5 });

// 局部更新：讀取舊值、疊加、寫回。
const prev = ctx.characters[ctx.characterId]?.data?.extensions?.my_plugin_state ?? {};
await ctx.writeExtensionField(ctx.characterId, 'my_plugin_state', { ...prev, level: 5 });

// 徹底刪除該 key。
await ctx.writeExtensionField(ctx.characterId, 'my_plugin_state', ctx.constants.unset);
```

這是寫入外掛擴充欄位的**安全路徑**——它完全繞過 `context.characters` Proxy。

### writeExtensionFieldBulk

```ts
writeExtensionFieldBulk(
    avatars: string[] | null,
    key: string,
    value: any,
    options?: { filterPath?: string },
): Promise<{ updated: string[], skipped: string[], failed: string[] }>
```

跨多個角色的單次批次寫入，每張卡都套用與 `writeExtensionField` 相同的替換語義。`avatars: null` 或 `[]` 表示作用於所有角色。當 `value` 是 `unset` 哨兵且未提供 `filterPath` 時，自動把 `filterPath` 預設為 `data.extensions.<key>`，從而跳過沒有該欄位的卡片。

### createCharacterData

```ts
context.createCharacterData: NewCharacterDraft
```

實時可變的緩衝區，承載進行中的「建立新角色」表單。當 `context.menuType === 'create'` 時可直接讀寫——例如 [`getCharaAuxWorlds`](/zh-TW/development/extension-api/world-info#getcharaauxworlds) 就是從這裡讀 `extra_books`。

### updateCharacterData

```ts
updateCharacterData(
    charId: number | string,
    patch: Record<string, any>,
    options?: { persist?: boolean, immediate?: boolean }
): Promise<void>
```

更新某張卡 `data` 物件上的一個或多個**表單層**欄位，**不依賴**角色編輯器彈窗開啟。patch 形態是 `character.data` 的 dot-path 映射，用於表單層欄位（`description`、`name`、`personality`……）。中間物件會自動按需建立。

```js
const ctx = Luker.getContext();
// 更新一個頂層欄位
await ctx.updateCharacterData(ctx.characterId, { description: '新的描述。' });
```

**限制：** 以 `extensions.` 開頭的 dot-path（或裸 key `extensions`）會被**拒絕**——擴充資料請改用 `writeExtensionField`，它對外掛資料區塊採用正確的替換語義。

```js
// 擲出例外——請改用 writeExtensionField。
await ctx.updateCharacterData(ctx.characterId, { 'extensions.world': 'my_book' });
```

跟現有的 `saveCharacterDebounced` / 表單路徑互補 — 彈窗打開時仍走表單（那時表單是 source of truth）。`updateCharacterData` 是面向 AI 工具、slash command、以及其他可能在編輯器關閉時執行的程式化呼叫方的資料驅動替代路徑。

寫入 in-memory 後會觸發 [`event_types.CHARACTER_FIELDS_UPDATED`](#character_fields_updated-event)，攜帶 `{ charId, keys }`，讓 view（開啟的彈窗、CardApp UI）從權威 data sync。

| 選項 | 預設 | 含義 |
|---|---|---|
| `persist` | `true` | 是否排程一次儲存。需要做「另一呼叫方稍後會儲存」的暫時寫入時傳 `false`。 |
| `immediate` | `false` | 立刻 await 儲存，不走防抖。後續程式碼需要檔案已落盤時使用。 |

### persistCharacterData

```ts
persistCharacterData(charId: number | string): Promise<void>
```

把某張卡當前的 in-memory `data` 序列化成 `/api/characters/edit` 期望的 multipart shape 後 POST 落盤。表單**不參與** — 只看 `characters[charId]`。伺服器會把 payload 與磁碟上現有的 JSON 深合併，這對表單層欄位是正確行為（保留了表單從未觸及的未知擴充資料）。

HTTP 失敗時擲出例外。擴充資料**不會**走這條路徑——它有自己的 `/api/characters/merge-attributes` 路徑，採用替換語義（[`writeExtensionField`](#writeextensionfield)）。

絕大多數呼叫方應該用 `updateCharacterData`（它會替你排程這個）。只有當你已經親自 mutate 過 in-memory 物件、想 flush 時才直接呼叫。

### persistCharacterDataDebounced

```ts
persistCharacterDataDebounced(charId: number | string): void
```

在標準 save-edit 超時上排程一次防抖的 `persistCharacterData(charId)` 呼叫（按 character 各自排程 — 同時寫兩張不同的卡不會被合併成單次錯誤目標的儲存）。視窗內的後續呼叫會被合併。

### `character_fields_updated` event

`updateCharacterData` mutate `characters[charId].data` 之後、持久化完成之前觸發。監聽器接收 `{ charId, keys }`，`keys` 是 patch 裡的 dot-path 陣列。用它來 sync view（彈窗表單、CardApp 面板）而無需輪詢。

```js
const ctx = Luker.getContext();
ctx.eventSource.on(ctx.eventTypes.CHARACTER_FIELDS_UPDATED, ({ charId, keys }) => {
    if (charId === ctx.characterId && keys.includes('description')) {
        // 從 characters[charId].data.description 重新整理你的 UI
    }
});
```

## 標籤

### context.tags

```ts
context.tags: Tag[]
```

所有標籤定義的主列表：`{ id, name, folder?, color?, color2?, create_date }`。

### context.tagMap

```ts
context.tagMap: Record<string, string[] | null>
```

把每個角色頭像（或群組 id）映射到指派的標籤 id。

### importTags

```ts
importTags(
    character: Character,
    options?: { importSetting?: TagImportSetting | null },
): Promise<boolean>
```

把角色宣告的標籤（`character.tags[]`）匯入到主標籤列表並指派。為了防範惡作劇卡，每張角色最多匯入 50 個標籤。當至少有一個標籤被新增時回傳 `true`。

## 匯入 / 匯出

### importFromExternalUrl

```ts
importFromExternalUrl(
    url: string,
    options?: { preserveFileName?: string | null },
): Promise<void>
```

從外部 URL 或內容 UUID 匯入角色或世界書。伺服器檢查回應的 `Content-Type` 並路由到對應的匯入路徑：

- `'character'` → 進入 `processDroppedFiles`
- `'lorebook'` → 進入 `importWorldInfo`
- 否則 → 顯示「未知類型」toast

`preserveFileName` 在分派步驟覆寫回應檔名。

## 角色狀態

對於應該跟隨角色跨聊天保留、但**不應**修改角色卡 JSON 的資料，使用角色狀態。這與擴充欄位（[`writeExtensionField`](#writeextensionfield)，持久化在角色卡內部）是不同的東西。

### getCharacterState

```ts
getCharacterState(avatar: string, namespace: string): Promise<any | null>
```

讀取指定 avatar 與命名空間下的狀態。沒有資料時回傳 `null`。

### setCharacterState

```ts
setCharacterState(avatar: string, namespace: string, data: any): Promise<void>
```

寫入角色狀態。傳 `data: null` 可刪除該命名空間的狀態。

```js
const ctx = Luker.getContext();
const character = ctx.characters[ctx.characterId];

await ctx.setCharacterState(character.avatar, 'my-plugin', {
    initialized: true,
    counter: 1,
});

const state = await ctx.getCharacterState(character.avatar, 'my-plugin');
```

::: tip Sidecar vs 擴充欄位
- 擴充欄位（`writeExtensionField` → `data.extensions.<key>`）是角色卡的一部分。隨卡匯出，任何人拿到卡都能看到。
- Sidecar（`get/setCharacterState`）是與卡放在一起的另一個檔案。**不會**隨卡匯出。
:::

## Proxy 語義 {#proxy-semantics}

`context.characters` 是一個 Proxy，撫平了 V2 角色格式（文字欄位放在 `character.data.*` 下）和傳統根層級結構（`character.name`、`character.description` 等）之間的差異。理解它很重要，因為讀和寫的行為並不相同。

### 讀取

兩條路徑都可以讀——Proxy 會解析到任何有資料的那條：

```js
const character = ctx.characters[ctx.characterId];

character.name              // OK——當 data.name 存在時穿透到那裡
character.data.name         // OK——直接走 V2
character.data.extensions.foo  // OK——也是被代理的
```

`Object.keys()`、`for...in` 和展開操作也能看到傳統鍵，所以 `{ ...character }` 這類舊程式碼仍能正常工作。

### 寫入

寫入傳統根層級欄位**有效**，但會發出一條棄用警告 + 一次性 toast：

```js
character.name = 'Bob';        // 警告；鏡像到 data.name 並觸發 toast
character.data.name = 'Bob';   // 推薦；無警告
```

棄用範圍精確涵蓋以下對應：

| 傳統欄位 | 標準路徑 |
|------|------|
| `name` | `data.name` |
| `description` | `data.description` |
| `personality` | `data.personality` |
| `scenario` | `data.scenario` |
| `first_mes` | `data.first_mes` |
| `mes_example` | `data.mes_example` |
| `creatorcomment` | `data.creator_notes` |
| `tags` | `data.tags` |
| `talkativeness` | `data.extensions.talkativeness` |
| `fav` | `data.extensions.fav` |

### 鏡像規則

透過標準路徑寫入會自動鏡像回傳統欄位，反之亦然：

```js
character.data.name = 'Alice';
character.name === 'Alice';         // true——自動鏡像

character.data.extensions.fav = true;
character.fav === true;             // true——自動鏡像
```

寫入時會應用欄位正規化：
- 文字欄位 → 強制轉為字串
- `tags` → 已修剪的非空字串陣列（也接受逗號分隔字串）
- `talkativeness` → 有限數字，非數字輸入預設為 `0.5`
- `fav` → 布林值，識別字串 `'true'`/`'false'`

### writeExtensionField 繞過 Proxy

`writeExtensionField` 透過底層實時的 `characters` 參照寫入，所以即使目標是傳統欄位也不會觸發棄用 toast。任何持久化的擴充資料都應該優先用它。

### 實務要點

- 讀取任何欄位，根層級或巢狀 —— 都沒問題。
- 寫入**表單層**欄位 —— 用 `updateCharacterData`（或者，當你直接 mutate `data.*` 時，緊跟一個 `persistCharacterData`）。
- 寫入**擴充資料** —— 用 `writeExtensionField` / `writeExtensionFieldBulk`。替換語義：呼叫方完整控制 `data.extensions.<key>` 的值；兄弟子鍵不會被保留。
