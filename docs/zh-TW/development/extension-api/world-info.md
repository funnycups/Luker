# 世界書

讀取、寫入、掃描世界書（lorebook）條目的相關 API。所有函式都透過 `Luker.getContext()` 暴露；原始 HTTP 路由列在 [底層端點](/zh-TW/development/extension-api/low-level-endpoints)。

## 讀取世界書

### loadWorldInfo

```ts
loadWorldInfo(name: string): Promise<WorldInfoData | null>
```

按名稱讀取單一世界書檔案。名稱查找對大小寫和重音不敏感。檔案不存在時回傳 `null`。內部有快取——對同一檔案的重複讀取會直接從記憶體返回。

```js
const ctx = Luker.getContext();
const book = await ctx.loadWorldInfo('My Lorebook');
console.log(Object.keys(book.entries).length);
```

### loadWorldInfoBatch

```ts
loadWorldInfoBatch(names: string[]): Promise<Map<string, WorldInfoData | null>>
```

在一次 HTTP 往返中讀取多個世界書檔案。回傳一個以解析後名稱為鍵的 `Map`；不存在的條目映射到 `null`。已快取的檔案以及進行中的請求會自動合併。

```js
const books = await ctx.loadWorldInfoBatch(['Book A', 'Book B']);
for (const [name, data] of books) {
    if (data) console.log(name, Object.keys(data.entries).length);
}
```

### getWorldInfoNames

```ts
getWorldInfoNames(): string[]
```

回傳編輯器已知的所有世界書檔案名稱的快照副本。用於填充 UI 下拉選單。

### getWorldInfoPrompt

```ts
getWorldInfoPrompt(
    chat: string[],
    maxContext: number,
    isDryRun: boolean,
    globalScanData: WIGlobalScanData,
): Promise<WIPromptResult>
```

較底層的掃描器，針對指定的聊天切片產出世界書 prompt 片段。多數外掛應改用 [`resolveWorldInfoForMessages`](/zh-TW/development/extension-api/presets-and-prompts#resolveworldinfoformessages)——它在此基礎上包裹了正規化和 post-activation hook。

`WIPromptResult` 結構：

| 欄位 | 類型 | 說明 |
|------|------|------|
| `worldInfoString` | `string` | `before` + `after` 以換行符串接 |
| `worldInfoBeforeEntries` | `string[]` | 注入到聊天前的條目 |
| `worldInfoAfterEntries` | `string[]` | 注入到聊天後的條目 |
| `worldInfoExamples` | `Array<{position, content}>` | 對話範例條目 |
| `worldInfoDepth` | `Array<{depth, role, entries}>` | 深度注入條目 |
| `anBefore` / `anAfter` | `string[]` | 作者註記注入 |
| `outletEntries` | `Record<string, string[]>` | 自訂 outlet 內容 |

當 `isDryRun` 為 `false` 時，會觸發 `event_types.WORLD_INFO_ACTIVATED` 事件，攜帶啟動的條目。

## 寫入世界書

### saveWorldInfo

```ts
saveWorldInfo(
    name: string,
    data: WorldInfoData,
    immediately?: boolean,
    options?: object,
): Promise<void>
```

把世界書檔案持久化到硬碟。快取會同步更新；網路寫入預設走防抖佇列。

| 參數 | 說明 |
|------|------|
| `name` | 檔案名稱（不含 `.json` 副檔名） |
| `data` | 完整的世界書物件（`{ entries: Record<number, WIEntry> }`） |
| `immediately` | `true` 時等待實際儲存完成而非走防抖 |

`name` 或 `data` 為 falsy 時是 no-op。

### updateWorldInfoList

```ts
updateWorldInfoList(): Promise<void>
```

從伺服器重新整理全域 `world_names` 列表。在編輯器 UI 之外建立、刪除或重新命名檔案後呼叫。

### createWorldBook

```ts
createWorldBook(name: string, options?: { interactive?: boolean }): Promise<boolean>
```

建立一個新的空世界書檔案。成功傳回 `true`，失敗傳回 `false`（例如 `interactive` 為 false 時遇到重名）。`interactive: false`（預設）會跳過重名確認彈窗，適合程式化建立。新建檔案沒有任何條目，透過 [`saveWorldInfo`](#saveworldinfo) 或編輯器寫入條目。

### importEmbeddedWorldInfo

```ts
importEmbeddedWorldInfo(skipPopup?: boolean): Promise<void>
```

把 V2/V3 PNG 卡內嵌的 `data.character_book` 匯入為獨立的世界書檔案並繫結為該角色的 primary world。要匯入哪張卡透過 `#import_character_info` 元素的 `chid` data 屬性讀取（角色編輯器在開啟含內嵌書的卡時會設定這個值）。`skipPopup: true` 用來跳過確認彈窗直接匯入，適合已經取得過明確確認的工具呼叫。匯入完成後，`characters[chid].data.extensions.world` 指向新檔案，內嵌書不再被提示重新匯入。

### charUpdatePrimaryWorld

```ts
charUpdatePrimaryWorld(name: string): Promise<void>
```

透過名字繫結角色的主世界書（傳 `''` 解綁）。走角色編輯器的儲存路徑，因此需要當前有活躍的角色上下文。

### getCharacterEmbeddedWorld

```ts
getCharacterEmbeddedWorld(charId: number | string): {
    present: boolean,
    name: string | null,
    entryCount: number,
    bound: boolean,
}
```

唯讀地查詢某張卡的 V2/V3 內嵌 `data.character_book` 狀態：
- `present` — 卡是否攜帶內嵌書。
- `name` — 內嵌書的 `name` 欄位。
- `entryCount` — 內嵌書包含的條目數。
- `bound` — 卡是否已經繫結了一個真實的世界書檔案（即 `data.extensions.world` 解析得到一個已知的世界書）。`present && !bound` 表示內嵌書還沒透過 `importEmbeddedWorldInfo` 匯入。`present && bound` 表示內嵌書只是繫結世界的過期映象（匯出時留下的良性副產物），執行時應忽略。

### reloadWorldInfoEditor

```ts
reloadWorldInfoEditor(file: string, loadIfNotSelected?: boolean): void
```

針對 `file` 重新渲染世界書編輯器。預設情況下若 `file` 不是當前開啟的檔案則為 no-op；設 `loadIfNotSelected` 為 `true` 可強制切換過去。

## 啟動掃描

### simulateWorldInfoActivation

```ts
simulateWorldInfoActivation(request: {
    coreChat?: ChatMessage[],
    maxContext?: number,
    dryRun?: boolean,
    type?: string,
    chatForWI?: string[],
    includeNames?: boolean,
    globalScanData?: WIGlobalScanData,
}): Promise<WIPromptResult & {
    chatForWI: string[],
    maxContext: number,
    globalScanData: WIGlobalScanData,
}>
```

針對提供的訊息執行一次世界書啟動掃描並回傳結果。這是 [`resolveWorldInfoForMessages`](/zh-TW/development/extension-api/presets-and-prompts#resolveworldinfoformessages) 背後的原語；只有在你需要對掃描輸入做更精細的控制時才直接呼叫它。

| 參數 | 說明 |
|------|------|
| `coreChat` | 用作掃描來源的訊息列表（`{ name, mes, is_user, is_system }`） |
| `maxContext` | token 預算；省略或 `<= 0` 時退回 `getMaxPromptTokens()` |
| `dryRun` | `true` 時抑制 `WORLD_INFO_ACTIVATED` 事件 |
| `type` | 生成觸發標籤（`'normal'`、`'quiet'`、`'regenerate'` 等） |
| `chatForWI` | 預先建構好的掃描輸入；提供時跳過 `buildWorldInfoChatInput` |
| `includeNames` | 是否在每行掃描內容前加上 `name:` |
| `globalScanData` | 覆寫從角色卡衍生的掃描欄位 |

回傳物件會回拋實際使用的 `chatForWI`、`maxContext`、`globalScanData`，方便呼叫端檢視解析後的掃描輸入。

### buildWorldInfoChatInput

```ts
buildWorldInfoChatInput(messages: ChatMessage[], includeNames?: boolean): string[]
```

建構世界書掃描器期望的**反轉**掃描字串陣列。`includeNames` 為 `true` 時每行為 `"name: mes"`，否則只是 `mes`。當你想餵給 `simulateWorldInfoActivation` 一份預先格式化的切片時用得到。

### buildWorldInfoGlobalScanData

```ts
buildWorldInfoGlobalScanData(type: string, overrides?: Partial<WIGlobalScanData>): WIGlobalScanData
```

為當前角色建構從角色卡衍生的掃描欄位（`personaDescription`、`characterDescription`、`characterPersonality`、`characterDepthPrompt`、`scenario`、`creatorNotes`、`trigger`）。傳 `overrides` 可在不重建整個物件的情況下替換個別欄位。

### getActiveWorldInfoPromptFields

```ts
getActiveWorldInfoPromptFields(): {
    worldInfoBeforeEntries: string[],
    worldInfoAfterEntries: string[],
}
```

回傳生成流水線最近一次擷取的世界書 `before`/`after` 片段。沒有活躍聊天，或快照屬於另一個聊天時，回傳空陣列。在不重新跑掃描的前提下想讀「上次注入了什麼」時用這個。

## 角色輔助世界書

角色卡可以在主要 `world` 欄位之外宣告輔助世界書綁定——例如 CardApp 可能為角色內工具綁定額外的參考書。

### getCharaAuxWorlds

```ts
getCharaAuxWorlds(charaFilename: string): string[]
```

回傳綁定到角色的輔助世界書名稱去重後列表。解析規則：

- 角色建立期間（`menu_type === 'create'`），從進行中的新角色緩衝區讀取。
- 否則從 `world_info.charLore` 中匹配 `charaFilename` 的條目讀取。

`charaFilename` 為 falsy 或無綁定時回傳 `[]`。搭配 [`getCharaFilename`](/zh-TW/development/extension-api/characters#getcharafilename) 解析當前角色：

```js
const ctx = Luker.getContext();
const auxBooks = ctx.getCharaAuxWorlds(ctx.getCharaFilename());
const datas = await ctx.loadWorldInfoBatch(auxBooks);
```

## 格式轉換

### convertCharacterBook

```ts
convertCharacterBook(characterBook: V2CharacterBook): {
    entries: Record<number, WIEntry>,
    originalData: V2CharacterBook,
}
```

把 V2 角色卡的 `character_book` payload 轉為內部世界書結構。在匯入角色卡或把 V2 lore 投影成可編輯條目時使用。`originalData` 保留下來供來回往返序列化。

## 條目級輔助函式

用於程式化建立條目與同步 UI。全部掛在 `context.worldInfoEntry` 之下。

### worldInfoEntry.template

```ts
context.worldInfoEntry.template: WIEntry
```

條目的標準預設結構（佔位 `uid: 0`、空 key 清單、`position: 0` 等）。批次建構條目時用「複製—修改」方式使用,這樣未來 schema 新增欄位會自動跟上。

```js
const ctx = Luker.getContext();
const fresh = { ...ctx.worldInfoEntry.template, uid: newUid, key: ['npc:Bob'], content: '一位麵包師。' };
```

### worldInfoEntry.create

```ts
context.worldInfoEntry.create(name: string, data: WorldInfoData): WIEntry
```

在指定的世界書 `data` 中建立並插入一筆新條目,回傳插入的條目物件。會分配下一個空閒 `uid`,填預設值,並就地修改 `data.entries`。之後用 `saveWorldInfo()` 持久化。

### worldInfoEntry.delete

```ts
context.worldInfoEntry.delete(data: WorldInfoData, uid: number, options?: { silent?: boolean }): Promise<boolean>
```

從 `data.entries` 中移除指定 `uid` 的條目,回傳刪除是否成功。傳 `silent: true` 跳過給使用者的確認 toast——批次程式化編輯時有用。之後用 `saveWorldInfo()` 持久化。

### worldInfoEntry.setButtonClass

```ts
context.worldInfoEntry.setButtonClass(chid: number | string, forceValue?: boolean): void
```

更新角色卡 UI 上「世界書已綁定」狀態徽章的樣式類。傳 `forceValue` 可強制覆寫計算出的綁定狀態。程式化改完綁定（例如 `charUpdatePrimaryWorld`）後呼叫。

### worldInfoEntry.setGlobalSelection

```ts
context.worldInfoEntry.setGlobalSelection(
    worldInfoName: string,
    selected: boolean,
    options?: object,
): Promise<void>
```

把某本世界書加入或移出全域啟用清單（即世界書面板頂部的多選）。立即持久化;UI 在下次 selector 重整時同步。

### worldInfoEntry.getSorted

```ts
context.worldInfoEntry.getSorted(): Promise<WIEntry[]>
```

回傳目前所有啟用世界書（按聊天 + 全域 + 角色主書 + 角色輔助書）裡的全部條目,預先合併並依注入順序排好。需要拿到「掃描器當下看到的視圖」時用——例如外掛想列「現在哪些條目有資格觸發」而不想重新跑一遍完整啟用流程。

## 聊天綁定的世界書

按聊天的世界書綁定存在 `chat_metadata.world_info` 中,跟著聊天走。用 `context.chatWorldInfo` 檢視與修改。

### chatWorldInfo.getNames

```ts
context.chatWorldInfo.getNames(
    metadata?: object,
    options?: { resolveNames?: boolean, onlyExisting?: boolean },
): string[]
```

回傳綁定到該聊天的世界書名稱清單。預設走當前聊天的 metadata。`resolveNames: true`（預設）把 uid 形式的條目映射回檔名;`onlyExisting: true`（預設）捨棄檔案已不存在的名稱。

### chatWorldInfo.setSelection

```ts
context.chatWorldInfo.setSelection(names: string[], metadata?: object): boolean
```

把聊天綁定的世界書選擇替換為 `names`。就地修改 metadata,回傳選擇是否實際變了。呼叫者透過 `saveMetadata()` / `saveMetadataDebounced()` 持久化。

### chatWorldInfo.globalSelection

```ts
context.chatWorldInfo.globalSelection: string[]
```

使用者全域啟用世界書清單（在每個聊天都生效的那些）的唯讀實時快照。要修改請用 `worldInfoEntry.setGlobalSelection`——直接寫入不會持久化。

## 位置常數

### context.constants.wiAnchor

```ts
context.constants.wiAnchor: { before, after }
```

樣例對話條目錨點側的數值列舉。建構或比對 `worldInfoExamples[i].position` 時使用。

### context.constants.wiPosition

```ts
context.constants.wiPosition: {
    before, after, ANTop, ANBottom, atDepth, EMTop, EMBottom, outlet,
}
```

條目級 `position` 值的數值列舉。建構條目或依注入槽位過濾時使用。

```js
const ctx = Luker.getContext();
const entry = {
    ...ctx.worldInfoEntry.template,
    position: ctx.constants.wiPosition.before,
};
```

## 實用模式

### 外掛讀取 + 編輯一份世界書

```js
const ctx = Luker.getContext();

const book = await ctx.loadWorldInfo('Setting Bible');
if (!book) {
    console.warn('Lorebook not found');
    return;
}

const newUid = Math.max(0, ...Object.keys(book.entries).map(Number)) + 1;
book.entries[newUid] = {
    uid: newUid,
    key: ['npc:Tavernkeeper'],
    keysecondary: [],
    content: 'A burly man with a scar across his cheek.',
    comment: 'Auto-added by my-plugin',
    constant: false,
    selective: true,
    order: 100,
    position: 0,
    disable: false,
    excludeRecursion: false,
    probability: 100,
    useProbability: true,
};

await ctx.saveWorldInfo('Setting Bible', book);
ctx.reloadWorldInfoEditor('Setting Bible', true);
```

### 外掛掃描 WI 而不影響主聊天

```js
const wi = await ctx.simulateWorldInfoActivation({
    coreChat: [
        { name: 'User', mes: 'Tell me about the tavernkeeper.', is_user: true },
    ],
    dryRun: true,
});

console.log(wi.worldInfoBeforeEntries);
```

如果想要更高層、能直接餵給 `buildPresetAwarePromptMessages` 的結果，請改用 [`resolveWorldInfoForMessages`](/zh-TW/development/extension-api/presets-and-prompts#resolveworldinfoformessages)。
