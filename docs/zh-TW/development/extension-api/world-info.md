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
