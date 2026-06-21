# 外掛整合

把外掛接入 Luker 流水線、以及外掛之間互通的 API：正則處理、搜尋工具、跨外掛 API 註冊表、事件系統。

## 正則執行時 API

外掛可以透過 `registerManagedRegexProvider()` 註冊託管的正則處理器，參與 Luker 的正則處理流程。該函數從正則引擎模組匯出：

```js
import { registerManagedRegexProvider } from '../../extensions/regex/engine.js';

const handle = registerManagedRegexProvider('my-plugin', {
  reloadOnChange: true,
});

// 添加正則腳本
handle.upsertScript({
  id: 'my-rule-1',
  scriptName: 'My Regex Rule',
  findRegex: 'foo',
  replaceString: 'bar',
  // ...其他正則腳本欄位
});

// 卸載時取消註冊
handle.unregister();
```

`registerManagedRegexProvider` 回傳的句柄提供 `upsertScript`、`removeScript`、`setScripts`、`clearScripts` 和 `unregister` 方法。

## 搜尋工具 API

搜尋外掛透過 `Luker.searchTools` 全域物件暴露 API，供其他外掛呼叫搜尋能力：

```js
// 檢查搜尋外掛是否可用
if (globalThis?.Luker?.searchTools) {
  // 取得可用的搜尋工具名稱列表
  const toolNames = Luker.searchTools.toolNames;
  // 取得工具定義（用於函數呼叫）
  const toolDefs = Luker.searchTools.getToolDefs();
  // 檢查某個工具名是否屬於搜尋工具
  const isSearchTool = Luker.searchTools.isToolName('web_search');
}
```

`Luker.searchTools` 暴露的是工具定義中繼資料，實際的搜尋執行透過內部的工具呼叫迴圈完成。詳見[搜尋外掛](/zh-TW/features/search-tools)。

## 擴充功能間通訊

### registerExtensionApi

```js
context.registerExtensionApi('my-plugin', {
  doSomething: () => { /* ... */ },
  getData: () => myData,
});
```

將一個API物件註冊到指定名稱下，供其他擴充功能透過`getExtensionApi`取得。如果同名API已被註冊，會在控制台輸出警告並覆蓋。

### getExtensionApi

```js
const api = context.getExtensionApi('other-plugin');
if (api) {
  api.doSomething();
}
```

按名稱取得其他擴充功能註冊的API物件。如果該名稱尚未註冊，返回`undefined`。

### 典型用途

擴充功能間通訊最常見的場景是解耦：一個擴充功能提供能力，另一個擴充功能消費能力，而不需要硬編碼依賴。例如，CardApp Studio透過`registerExtensionApi`將自身的編輯器API暴露出來，其他擴充功能可以在Studio就緒後直接呼叫。

編排器擴充遵循同樣的約定 —— 它發布 `'orchestrator'`，帶 `registerOrchestrationTool` / `unregisterOrchestrationTool` / `listExtensionTools`（以及 SillyTavern 橋接相關的輔助函式），讓任何其他擴充都能貢獻工具，由編排 agent 呼叫。詳見 [編排器工具 API](./orchestrator-tools.md)。

## 事件系統

### eventSource

```js
// 監聽
context.eventSource.on(eventName, handler, options?);

// 取消監聽
context.eventSource.off(eventName, handler);

// 確保最先執行
context.eventSource.makeFirst(eventName, handler);

// 確保最后執行
context.eventSource.makeLast(eventName, handler);

// 查看監聽器資訊（除錯用）
context.eventSource.getListenersMeta(eventName);

// 設定外掛排序
context.eventSource.setOrderConfig(config);
```

### 監聽器選項

```js
context.eventSource.on(eventName, handler, {
  priority: 10,  // 數字越大越先執行
});
```

### 事件類型

所有事件類型透過 `context.eventTypes` 存取。完整集合涵蓋聊天生命週期、訊息事件、生成鉤子和 app 級訊號。

| 分組 | 範例 |
|------|------|
| 聊天生命週期 | `CHAT_CHANGED`、`CHAT_LOADED`、`CHAT_BRANCH_CREATED` |
| 訊息事件 | `MESSAGE_SENT`、`MESSAGE_RECEIVED`、`MESSAGE_RENDERED`、`MESSAGE_EDITED`、`MESSAGE_UPDATED`、`MESSAGE_DELETED`、`MESSAGE_SWIPED`、`MESSAGE_SWIPE_DELETED` |
| 生成鉤子 | `GENERATION_STARTED`、`GENERATION_CONTEXT_READY`、`GENERATION_BEFORE_WORLD_INFO_SCAN`、`GENERATION_BEFORE_API_REQUEST`、`GENERATION_ENDED`、`GENERATION_STOPPED`、`WORLD_INFO_ACTIVATED` |
| 圖像生成 | `IMAGE_GENERATION_STARTED`、`IMAGE_GENERATION_ENDED` |
| App 級 | `APP_READY`、`SETTINGS_LOADED_AFTER`、`EXTENSIONS_FIRST_LOAD` |

完整事件 payload 結構見 [前端外掛開發 → 事件系統](/zh-TW/development/frontend-plugin#事件系統)。

## 國際化（i18n）

外掛應透過 i18n 輔助函式本地化使用者可見字串。語系資料會在 `zh-CN ↔ zh-TW` 之間做退回。

### t（template tag）

```ts
t`Tag ${name} not found`
```

使用樣板字面量形式 `'Tag ${0} not found'` 作為查找鍵，再把 `name` 代回結果中。執行時翻譯最方便的 API。

### translate

```ts
translate(text: string, key?: string | null): string
```

在已載入的語系資料中查找 `text`（或 `key`，當提供時）。沒有對應條目時原樣回傳 `text`。當你有沒有插值的靜態字串時使用。

### getCurrentLocale

```ts
getCurrentLocale(): string
```

回傳啟動時解析出的小寫語系識別碼——通常是 `'en'`、`'zh-cn'`、`'zh-tw'`、`'ja-jp'` 等。如果你需要按語系分支行為，讀這個。

### addLocaleData

```ts
addLocaleData(localeId: string, data: Record<string, string>): void
```

把外掛提供的翻譯合併到已載入的語系資料中。在 i18n 系統啟動之後呼叫（例如在 `APP_READY` 上）。當 `localeId` 為主要語系時，條目總是覆寫；為退回語系時，條目只填補缺失鍵。

```js
const ctx = Luker.getContext();

ctx.eventSource.on(ctx.eventTypes.APP_READY, () => {
    ctx.addLocaleData('zh-cn', {
        'My Plugin': '我的插件',
        'Settings saved': '设置已保存',
    });
    ctx.addLocaleData('en', {
        'My Plugin': 'My Plugin',
        'Settings saved': 'Settings saved',
    });
});
```

## 設定與儲存

### extensionSettings

```ts
context.extensionSettings: object
```

擴充功能儲存設定的全域純物件。每個擴充功能通常用自己的命名空間鍵：

```js
const ctx = Luker.getContext();

if (!ctx.extensionSettings.my_extension) {
    ctx.extensionSettings.my_extension = { enabled: true, level: 1 };
}

ctx.extensionSettings.my_extension.level += 1;
ctx.saveSettingsDebounced();
```

### saveSettingsDebounced

```ts
context.saveSettingsDebounced(): void
```

防抖的持久化觸發。在突變 `extensionSettings` 或任何設定物件後呼叫。多次快速呼叫會合併為單次儲存。

### saveSettings

```ts
context.saveSettings(loopCounter?: number, options?: object): Promise<void>
```

`saveSettingsDebounced` 的可 await 版本。繞過防抖佇列,網路往返完成後才解析。僅當後續邏輯依賴「設定已落盤」時才用（少見——絕大多數呼叫點都應優先選防抖版）。

### saveMetadataDebounced

```ts
context.saveMetadataDebounced(): void
```

`saveMetadata` 的防抖包裝，用於 `chat_metadata` 的突變。

### getExtensionManifest

```ts
getExtensionManifest(name: string): ExtensionManifest | null
```

回傳指定擴充功能 manifest 的結構化拷貝。接受短名稱（`SillyTavern-MyExt`）或內部鍵（`third-party/SillyTavern-MyExt`）；查找對大小寫和重音不敏感。找不到時回傳 `null`。

### openThirdPartyExtensionMenu

```ts
openThirdPartyExtensionMenu(suggestUrl?: string): Promise<void>
```

開啟第三方擴充功能的安裝對話框。提供 `suggestUrl` 時預填 URL 欄位。

### accountStorage

```ts
context.accountStorage: {
    getItem(key: string): string | null,
    setItem(key: string, value: any): void,
    removeItem(key: string): void,
    getState(): object,
}
```

帳號作用域的 key/value 儲存。值會被強制轉成字串。透過 `saveSettingsDebounced` 持久化。用於應跨聊天保留但不應隨角色卡匯出的使用者特定設定。

```js
const ctx = Luker.getContext();
ctx.accountStorage.setItem('my-extension:last-seen', String(Date.now()));
const lastSeen = ctx.accountStorage.getItem('my-extension:last-seen');
```

## 除錯函式

### registerDebugFunction

```ts
registerDebugFunction(
    functionId: string,
    name: string,
    description: string,
    func: () => void | Promise<void>,
): void
```

在使用者設定的除錯選單中加一個按鈕。點擊時呼叫 `func`。適合外掛維護動作（清快取、傾倒狀態、強制重載等）。

```js
const ctx = Luker.getContext();
ctx.registerDebugFunction(
    'my-plugin-clear-cache',
    'Clear my-plugin cache',
    'Removes all cached data stored by my-plugin.',
    () => {
        ctx.extensionSettings.my_plugin.cache = {};
        ctx.saveSettingsDebounced();
        toastr.success('Cache cleared');
    },
);
```

## Data Bank Scraper

### registerDataBankScraper

```ts
registerDataBankScraper(scraper: {
    id: string,
    name: string,
    description: string,
    iconClass: string,
    iconAvailable: boolean,
    init?: () => Promise<void>,
    isAvailable: () => Promise<boolean>,
    scrape: () => Promise<File[]>,
}): void
```

註冊一個自訂 Data Bank 來源。當使用者在 Data Bank UI 中選中此 scraper 時，呼叫 `scrape()` 並把回傳的 `File[]` 加入到 bank 中。

| 欄位 | 說明 |
|------|------|
| `id` | 唯一識別碼；重複註冊會被拒絕 |
| `name` / `description` | 在 scraper 選擇器中顯示 |
| `iconClass` | FontAwesome 類別（例如 `'fa-solid fa-globe'`） |
| `iconAvailable` | 圖示是否可渲染 |
| `init` | 可選的一次性設置；延遲呼叫 |
| `isAvailable` | scraper 當前是否可執行（前置條件已滿足） |
| `scrape` | 執行抓取；回傳新檔案 |

## Tokenization

用於 token 計算任務（預算控制、context 視窗計算）。

### getTokenCountAsync

```ts
getTokenCountAsync(text: string, padding?: number): Promise<number>
```

使用當前活躍 tokenizer 回傳 `text` 的 token 數。以 `${tokenizerType}-${hash}${modelHash}+${padding}` 為鍵快取。空輸入回傳 `0`。

### getTextTokens

```ts
getTextTokens(tokenizerType: number, text: string): Promise<number[]>
```

回傳 token id。`tokenizerType` 是 `context.tokenizers.*` 之一（例如 `context.tokenizers.OPENAI`、`context.tokenizers.LLAMA3`）。不支援編碼的 tokenizer 回傳 `[]`。

### getTokenizerModel

```ts
getTokenizerModel(): string
```

回傳 tokenizer 配置使用的模型識別碼（例如 `'gpt-4o'`、`'claude'`、`'llama3'`）。

### tokenizers

```ts
context.tokenizers: { NONE, GPT2, OPENAI, LLAMA, LLAMA3, MISTRAL, GEMMA, CLAUDE, ... }
```

支援的 tokenizer 類型的數字列舉。作為 `getTextTokens` 的第一個引數。

## 工具輔助函式

### uuidv4

```ts
uuidv4(): string
```

回傳 RFC 4122 UUID v4。可用時使用 `crypto.randomUUID()`，否則用 hex 字串退回。

### timestampToMoment

```ts
timestampToMoment(timestamp: string | number): moment.Moment
```

回傳一個透過 `getCurrentLocale()` 本地化的 `moment` 物件。輸入無法解析時回傳 `moment.invalid()`。

### humanizedDateTime

```ts
humanizedDateTime(timestamp?: number): string
```

回傳檔名友善的時間戳字串，格式為 `YYYY-MM-DD@HHhMMmSSsMSms`。預設取 `Date.now()`。

### isMobile

```ts
isMobile(): boolean
```

行動或平板平台（依 UA 解析）回傳 `true`。

### shouldSendOnEnter

```ts
shouldSendOnEnter(): boolean
```

依使用者偏好和平台，按下 Enter 應該發送（而非插入換行）時回傳 `true`。

### escapeHtml

```ts
context.escapeHtml(str: string): string
```

跳脫 `&`、`<`、`>`、`"`、`'`,便於把純文字安全嵌入 HTML。比手寫跳脫更穩。

### download

```ts
context.download(content: string | Blob, fileName: string, contentType: string): void
```

按指定檔名與 MIME 型別觸發瀏覽器下載。`content` 可以是字串或 `Blob`。

### getFileText

```ts
context.getFileText(file: File): Promise<string>
```

把 `<input type="file">` change 事件裡的 `File` 當文字讀出。讀取失敗時拒絕。

### getStringHash

```ts
context.getStringHash(str: string, seed?: number): number
```

穩定的 32 位元 FNV 風格雜湊。適合做快取 key、按內容防抖的識別、「上次以來變沒變」之類的判斷。**不是**加密雜湊。

### createThumbnail

```ts
context.createThumbnail(dataUrl: string, maxWidth?: number, maxHeight?: number, type?: string): Promise<string>
```

把 data URL 解碼為圖片再縮成新的 data URL 回傳。type 預設 `'image/jpeg'`。任一維度傳 `null` 表示只按另一維度約束。

### isValidUrl

```ts
context.isValidUrl(value: string): boolean
```

`value` 能被 `new URL()` 解析時回傳 `true`。發起 fetch 前做輸入校驗用。

### performFuzzySearch

```ts
context.performFuzzySearch(
    type: string,
    data: object[],
    keys: Array<string | { name: string, weight?: number }>,
    searchValue: string,
    fuzzySearchCaches?: object | null,
): Array<{ item: object, score: number, refIndex: number }>
```

在平台已命名的某個索引（`'characters'`、`'groups'`、`'tags'` 等）上跑一次 Fuse.js 模糊比對,按相關度排序回傳 Fuse 風格的結果物件。傳入一個 out-cache 物件可在多次呼叫之間複用建好的索引。

## 函式庫捆綁（Lib Bundle）

外掛偶爾需要用到核心已經打包進 `lib.core.bundle.js` 的第三方函式庫。比起在每個外掛裡再打一次或者依賴全域物件,建議走 `context.lib`。

### context.lib

```ts
context.lib: {
    DOMPurify,
    lodash,
    DiffMatchPatch,
    showdown,
    yaml,
}
```

| 欄位 | 函式庫 |
|------|------|
| `DOMPurify` | HTML 消毒器（[DOMPurify](https://github.com/cure53/DOMPurify)） |
| `lodash` | 工具集合（[lodash](https://lodash.com/)） |
| `DiffMatchPatch` | diff/patch 引擎（[diff-match-patch](https://github.com/google/diff-match-patch)） |
| `showdown` | Markdown → HTML（[showdown](https://github.com/showdownjs/showdown)） |
| `yaml` | YAML 解析/序列化（[yaml](https://eemeli.org/yaml/)） |

```js
const ctx = Luker.getContext();
const safe = ctx.lib.DOMPurify.sanitize(userHtml);
const md = new ctx.lib.showdown.Converter().makeHtml(text);
```

## 密鑰（Secrets）

供外掛檢查或列舉連線密鑰槽（API key、憑證等）的狀態。context 表面唯讀——實際的 key 值留在 secrets 後端。

### context.secrets.KEYS

```ts
context.secrets.KEYS: Record<string, string>
```

公認的密鑰槽識別子目錄（`OPENAI`、`CLAUDE`、`MISTRALAI` 等）。當作 `context.secrets.state` 的 key 使用。

### context.secrets.state

```ts
context.secrets.state: Record<string, boolean>
```

每個密鑰槽當前是否已填的布林實時對應。唯讀快照——直接修改不會持久化。

```js
const ctx = Luker.getContext();
if (!ctx.secrets.state[ctx.secrets.KEYS.OPENAI]) {
    toastr.warning('OpenAI API key 未設定。');
}
```

## 向量嵌入服務

### context.embeddingService

```ts
context.embeddingService: {
    embed(items: string[], options?: object): Promise<number[][]>,
    // ……EmbeddingService 完整表面
}
```

vectors / memory-graph 子系統共用的向量嵌入服務,會按當前設定的嵌入 provider 走。需要做相似度檢索又不想自己重寫一次 provider 裝配的外掛可以用。

## Symbols 與常數

### context.symbols.ignore

```ts
context.symbols.ignore: typeof IGNORE_SYMBOL
```

哨兵 symbol，用來在 patch 上下文中表示「保留此值不動」——這時 `null` 和 `undefined` 已有其他含義。

### context.constants.unset

```ts
context.constants.unset: typeof UNSET_VALUE
```

傳給 `writeExtensionField` / `writeExtensionFieldBulk` 的哨兵值，用來**刪除**一個鍵而非把它設為 `null`：

```js
await ctx.writeExtensionField(chid, 'my_field', ctx.constants.unset);  // 刪除
await ctx.writeExtensionField(chid, 'my_field', null);                  // 設為 null
```

### context.constants.promptRoles / promptTypes

```ts
context.constants.promptRoles: { SYSTEM, USER, ASSISTANT }
context.constants.promptTypes: { NONE, IN_PROMPT, IN_CHAT, BEFORE_PROMPT }
```

`setExtensionPrompt` 及相關注入路徑用的數值列舉。`promptRoles` 選擇被注入 prompt 的 message role;`promptTypes` 選擇注入位置。

```js
const ctx = Luker.getContext();
ctx.setExtensionPrompt(
    'my-plugin-pre',
    '前置上下文備註。',
    ctx.constants.promptTypes.BEFORE_PROMPT,
    0,
    false,
    ctx.constants.promptRoles.SYSTEM,
);
```

關於 `wiAnchor` / `wiPosition` 見[世界書 → 位置常數](/zh-TW/development/extension-api/world-info#位置常數)。

### CONNECT_API_MAP

```ts
context.CONNECT_API_MAP: Record<string, ConnectApiEntry>
```

支援的 API source 識別碼（例如 `'openai'`、`'claude'`、`'novel'`）及其 UI 中繼資料的唯讀目錄。在填充連線相關下拉選單時用得到。

### createModelIcon

```ts
context.createModelIcon(apiName: string, modelName?: string): string
```

回傳某 provider 品牌圖示的內聯 SVG 標記,尺寸適合嵌在下拉選單 / chip 中和模型名並排。`apiName` 傳 `CONNECT_API_MAP` 的某個 key;可選的 `modelName` 讓 helper 挑特定模型的變體（例如 Claude 普通 vs Claude reasoning）。

### mainApi / maxContext / menuType

```ts
context.mainApi: 'openai' | 'kobold' | 'novel' | 'textgenerationwebui'
context.maxContext: number
context.menuType: 'characters' | 'character_edit' | 'create' | 'group_create' | 'group_edit' | ''
```

當前主要 API、配置的最大 context 大小、當前開啟的右側面板選單類型的實時唯讀視圖。
