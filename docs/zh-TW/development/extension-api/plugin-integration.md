# 外掛整合

把外掛接入 Luker 流水線、以及外掛之間互通的 API：正則處理、搜尋工具、跨外掛 API 註冊表、事件系統與後台活動保護。

## 正則執行時 API

外掛統一透過 `Luker.getContext().regex` 註冊記憶體態正則規則、執行正則改寫以及讀寫各作用域腳本，無需直接匯入正則擴充功能內部檔案。執行時規則與使用者規則一同參與每次正則處理，不會寫入使用者的持久化正則清單。

### `context.regex` 介面與列舉

| 屬性 | 型別 | 說明 |
|------|------|------|
| `applyRegex(rawString, placement, params?)` | 函式 | 依指定影響條目與通道參數執行全部匹配的正則規則 |
| `runRegexScript(regexScript, rawString, options?)` | 函式 | 對輸入字串單獨執行一條正則腳本物件 |
| `placement` | 列舉 | 影響條目常數：`USER_INPUT`、`AI_OUTPUT`、`SLASH_COMMAND`、`WORLD_INFO`、`REASONING` |
| `substituteFindRegex` | 列舉 | `findRegex` 巨集替換模式：`NONE`、`RAW`、`ESCAPED` |
| `SCRIPT_TYPES` | 列舉 | 持久化腳本作用域：`GLOBAL`、`PRESET`、`SCOPED` |
| `registerRegexProvider(owner, provider, options?)` | 函式 | 註冊依需求計算的執行時規則回呼，回傳 `{ refresh, unregister }` |
| `registerManagedRegexProvider(owner, options?)` | 函式 | 註冊由引擎託管儲存的執行時腳本集，回傳 `{ upsertScript, setScripts, removeScript, clearScripts, unregister }` |
| `unregisterRegexProvider(owner)` | 函式 | 依 owner 識別碼註銷執行時或託管正則提供者 |
| `getScripts(options?)` | 函式 | 列出目前生效的持久化與執行時正則腳本 |
| `getScriptsByType(scriptType, options?)` | 函式 | 依 `SCRIPT_TYPES` 作用域讀取持久化腳本清單，不觸發執行時回呼 |
| `saveScriptsByType(scripts, scriptType)` | 函式 | 將更新後的腳本陣列儲存至指定 `SCRIPT_TYPES` 作用域 |
| `getPluginLanes(script)` | 函式 | 擷取腳本正規化後的 `'request'` 與 `'reply'` 外掛通道清單 |
| `omitLegacyPluginScope(script)` | 函式 | 回傳剝離舊版 `pluginOnly` 欄位後的淺拷貝物件 |
| `normalizePluginScriptRecord(script)` | 函式 | 正規化腳本記錄並補齊 `pluginLanes` 欄位 |

### registerRegexProvider

規則集合由目前狀態推導、需要隨時重新計算時使用。回呼在每次正則處理時執行，始終讀取目前的聊天、角色與設定。

```js
const { regex } = Luker.getContext();

const registration = regex.registerRegexProvider('my-plugin', () => [
  {
    id: 'my-rule-1',
    scriptName: 'My Regex Rule',
    findRegex: '/foo/g',
    replaceString: 'bar',
    trimStrings: [],
    placement: [regex.placement.USER_INPUT, regex.placement.AI_OUTPUT],
  },
]);

// 重新計算自動執行，refresh() 同時重新整理已渲染的聊天訊息
registration.refresh({ requestReload: true });

// 卸載
registration.unregister();
```

### registerManagedRegexProvider

由引擎保管腳本儲存時使用，回傳的句柄管理該外掛的腳本集合。

```js
const { regex } = Luker.getContext();

const handle = regex.registerManagedRegexProvider('my-plugin', {
  reloadOnChange: true,
});

handle.upsertScript({
  id: 'my-rule-1',
  scriptName: 'My Regex Rule',
  findRegex: '/foo/g',
  replaceString: 'bar',
  trimStrings: [],
  placement: [regex.placement.USER_INPUT, regex.placement.AI_OUTPUT],
});
handle.setScripts([ /* 整組替換 */ ]);
handle.removeScript('my-rule-1');
handle.clearScripts();

// 卸載
handle.unregister();
```

### 腳本欄位

| 欄位 | 型別 | 必填 | 說明 |
|------|------|------|------|
| `id` | string | 僅託管入口 | 穩定識別碼，`registerManagedRegexProvider` 以它作為儲存鍵 |
| `scriptName` | string | 是 | 顯示名稱，出現在正則編輯器的「外掛正則腳本」分組 |
| `findRegex` | string | 是 | `/pattern/flags` 形式的匹配式 |
| `replaceString` | string | 是 | 替換文字，`$1` 與 `$<name>` 引用捕獲組 |
| `trimStrings` | string[] | 否 | 替換前從每個捕獲組移除的字串，預設為空清單 |
| `placement` | number[] | 否 | 「影響條目」，`1` 是使用者輸入，`2` 是 AI 輸出。規則至少需要一個 placement，除非只使用外掛回覆 |
| `pluginLanes` | string[] | 否 | 外掛應用點。`request` 處理進入外掛請求的文字，至少需要一個 `placement`；`reply` 處理外掛請求回傳的助手正文，不使用 `placement` |
| `disabled` | boolean | 否 | 為 true 時略過該規則 |
| `markdownOnly` | boolean | 否 | 「僅修改聊天顯示」，規則改寫聊天介面顯示的內容 |
| `promptOnly` | boolean | 否 | 「僅修改系統提示詞」，規則改寫主聊天傳送給模型的提示詞 |
| `runOnEdit` | boolean | 否 | 編輯訊息時也執行 |
| `substituteRegex` | number | 否 | `findRegex` 的巨集替換模式，`0` 表示不替換 |
| `minDepth` | number \| null | 否 | 「最小深度」，只處理深度不小於該值的訊息，深度 0 是最新一則 |
| `maxDepth` | number \| null | 否 | 「最大深度」，只處理深度不大於該值的訊息 |

`placement` 與 `pluginLanes` 選擇訊息目標，`markdownOnly` 與 `promptOnly` 選擇暫時性檢視。兩組互相獨立，規則可以組合使用，每個已選擇的選項僅增加自己對應的處理。執行時腳本在全部持久化規則之後執行。

## 搜尋工具 API

搜尋外掛透過 `context.registerExtensionApi('search-tools', ...)` 發布跨外掛服務，並透過 `Luker.searchTools` 暴露函式呼叫工具定義與執行入口：

```js
const searchApi = Luker.getContext().getExtensionApi('search-tools');
if (searchApi) {
  const caps = searchApi.getActiveProviderCapabilities();
  const webResults = await searchApi.search({ query: '角色設定' });
  if (caps.supportsImageSearch) {
    const images = await searchApi.searchImages({ query: '角色設定圖' });
  }
  const pageImages = await searchApi.extractPageImages({ url: 'https://example.com/wiki/Character' });
}

if (globalThis?.Luker?.searchTools) {
  const toolNames = Luker.searchTools.toolNames;
  const toolDefs = Luker.searchTools.getToolDefs();
  const isSearchTool = Luker.searchTools.isToolName('luker_web_image_search');
}
```

完整簽章參見[搜尋外掛](/zh-TW/features/search-tools)與[圖像生成 API](/zh-TW/development/extension-api/image-generation)。

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

編排器擴充遵循同樣的約定 —— 它發布 `'orchestrator'`，帶 `registerOrchestrationTool` / `unregisterOrchestrationTool` / `listExtensionTools`（以及 SillyTavern 橋接相關的輔助函式），讓任何其他擴充均能貢獻工具，由編排 agent 呼叫。詳見 [編排器工具 API](./orchestrator-tools.md)。

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

## 後台活動保護

`context.activityGuard` 與 `lukerContext.activityGuard` 提供基於租約的統一登記機制，將瀏覽器離開頁面提醒、行動端後台保活與應用內切換聊天確認收斂到同一處狀態。外掛應透過租約登記長時間執行的任務，而不要自行綁定 `beforeunload` 監聽器或直接操作保活內部狀態。

### `context.activityGuard`

```ts
interface ActivityLeaseOptions {
    source: string;                      // 必填的非空識別碼，例如 'my-plugin:sync'
    label?: string;                      // 在切換聊天確認視窗中顯示的任務名稱
    scope?: 'global' | 'chat';           // 預設: 'global'
    guardUnload?: boolean;               // 預設: true
    guardChatSwitch?: boolean;           // 預設: scope === 'chat'
    keepAlive?: boolean;                 // 預設: true
    ambient?: boolean;                   // 預設: false
    onCancel?: (() => void) | null;      // 僅在確認應用內切換聊天時呼叫
}

interface ActivitySnapshot {
    readonly source: string;
    readonly label: string;
    readonly scope: 'global' | 'chat';
    readonly guardUnload: boolean;
    readonly guardChatSwitch: boolean;
    readonly keepAlive: boolean;
    readonly ambient: boolean;
    readonly startedAt: number;
}

context.activityGuard: {
    acquire(options: ActivityLeaseOptions): () => void;
    run<T>(options: ActivityLeaseOptions, fn: () => T | Promise<T>): Promise<T>;
    hasUnloadGuard(): boolean;
    hasChatSwitchGuard(): boolean;
    hasKeepAliveHold(options?: {
        excludeAmbient?: boolean;
        excludeSources?: Iterable<string>;
    }): boolean;
    list(): Array<Readonly<ActivitySnapshot>>;
    subscribe(listener: () => void): () => void;
}
```

### 租約選項與方法

| 欄位 / 方法 | 預設值 / 回傳值 | 行為說明 |
|---|---|---|
| `source` | 必填字串 | 去除前後空白後非空的識別碼；缺失或為空時擲出 `TypeError`。 |
| `label` | `''` | 經過本地化的任務描述；當 `guardChatSwitch` 為 `true` 且內容非空時顯示在切換聊天確認視窗中。 |
| `scope` | `'global'` | 繫結目前對話的任務傳 `'chat'`；跨聊天保留的工作區、檔案或帳號級任務傳 `'global'`。 |
| `guardUnload` | `true` | 計入 `hasUnloadGuard()`，並在活躍期間觸發瀏覽器 `beforeunload` 離開提醒。 |
| `guardChatSwitch` | `scope === 'chat'` | 計入 `hasChatSwitchGuard()`，並在開啟、新建、關閉、建立分支或刪除聊天時觸發應用內切換確認。 |
| `keepAlive` | `true` | 計入 `hasKeepAliveHold()`，在活躍期間維持行動端後台保活。 |
| `ambient` | `false` | 標記隱式請求級租約。`hasKeepAliveHold({ excludeAmbient: true })` 會跳過這類租約；當存在任意非 `ambient` 的聊天切換保護租約時，確認視窗也會抑制 `ambient` 標籤。 |
| `onCancel` | `null` | 僅在使用者確認應用內切換聊天時呼叫，絕不在 `beforeunload` 時觸發，可用於中止 `AbortController` 或取消目前聊天任務。 |
| `acquire(options)` | `() => void` | 註冊租約並回傳冪等的 `release()` 釋放回呼。 |
| `run(options, fn)` | `Promise<T>` | 申請租約、等待 `fn()` 執行完成，並在 `finally` 中釋放租約。 |
| `list()` | `Readonly<ActivitySnapshot>[]` | 回傳目前活躍租約的淺凍結快照陣列，不包含內部 token 與 `onCancel` 鉤子。 |
| `subscribe(listener)` | `() => void` | 在租約申請或釋放時呼叫 `listener()`，並回傳冪等的 `unsubscribe()` 取消訂閱回呼。 |

```js
const ctx = Luker.getContext();
const controller = new AbortController();

const summary = await ctx.activityGuard.run({
    source: 'my-plugin:summarize',
    label: ctx.translate('Chat summary'),
    scope: 'chat',
    onCancel: () => controller.abort(),
}, async () => {
    return await ctx.generateTask({
        taskMessages: [{ role: 'user', content: '總結最近一段劇情。' }],
        abortSignal: controller.signal,
    });
});
```

核心 LLM 請求介面 `generateTask`、`generateTaskStream`、`generateRaw`、`generateRawData`、`ChatCompletionService` 與 `TextCompletionService` 預設自動附帶全域隱式租約，可透過傳入 `activity: false` 退出或傳入物件覆寫設定。詳見[生成請求 → 後台活動保護](/zh-TW/development/extension-api/generation#後台活動保護)。

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

`saveSettingsDebounced` 的可 await 版本。繞過防抖佇列，網路往返完成後才解析。僅當後續邏輯依賴「設定已落盤」時才用（少見——絕大多數呼叫點均應優先選防抖版）。

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

跳脫 `&`、`<`、`>`、`"`、`'`，便於把純文字安全嵌入 HTML。比手寫跳脫更穩。

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

在平台已命名的某個索引（`'characters'`、`'groups'`、`'tags'` 等）上跑一次 Fuse.js 模糊比對，按相關度排序回傳 Fuse 風格的結果物件。傳入一個 out-cache 物件可在多次呼叫之間複用建好的索引。

## 函式庫捆綁（Lib Bundle）

外掛偶爾需要用到核心已經打包進 `lib.core.bundle.js` 的第三方函式庫。比起在每個外掛裡再打一次或者依賴全域物件，建議走 `context.lib`。

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

vectors / memory-graph 子系統共用的向量嵌入服務，會按當前設定的嵌入 provider 走。需要做相似度檢索又不想自己重寫一次 provider 裝配的外掛可以用。

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

回傳某 provider 品牌圖示的內聯 SVG 標記，尺寸適合嵌在下拉選單 / chip 中和模型名並排。`apiName` 傳 `CONNECT_API_MAP` 的某個 key；可選的 `modelName` 讓 helper 挑特定模型的變體（例如 Claude 普通 vs Claude reasoning）。

### mainApi / maxContext / menuType

```ts
context.mainApi: 'openai' | 'kobold' | 'novel' | 'textgenerationwebui'
context.maxContext: number
context.menuType: 'characters' | 'character_edit' | 'create' | 'group_create' | 'group_edit' | ''
```

當前主要 API、配置的最大 context 大小、當前開啟的右側面板選單類型的實時唯讀視圖。
