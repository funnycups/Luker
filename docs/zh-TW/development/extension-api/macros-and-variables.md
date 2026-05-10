# 巨集與變數

註冊自訂巨集、在文字中求值巨集、讀寫聊天作用域或全域變數的相關 API。

## 巨集

Luker 透過 `macros` 命名空間暴露巨集系統，並為了向後相容保留了傳統的 `MacrosParser`。<span v-pre>`{{user}}`</span>、<span v-pre>`{{char}}`</span>、<span v-pre>`{{lastMessage}}`</span>、<span v-pre>`{{getvar::name}}`</span> 之類的內建巨集由 core 註冊；外掛可以透過 `macros.register()` 加入自己的巨集。

### macros.register

```ts
macros.register(name: string, options: {
    handler: (ctx: MacroExecutionContext) => string,
    aliases?: { alias: string, visible?: boolean }[],
    category?: string,
    unnamedArgs?: number | UnnamedArgDef[],
    list?: boolean | { min: number, max?: number },
    strictArgs?: boolean,
    description?: string,
    returns?: string,
    returnType?: 'string' | 'integer' | 'number' | 'boolean',
    displayOverride?: string,
    exampleUsage?: string | string[],
    delayArgResolution?: boolean,
}): MacroDefinition | null
```

註冊一個巨集。回傳已註冊的定義；驗證失敗時回傳 `null`。

| 選項 | 說明 |
|------|------|
| `handler` | 巨集本體。接收一個帶有解析後引數的執行上下文 |
| `aliases` | 別名。每個 `{ alias, visible }` 註冊相同的處理器 |
| `category` | 自動完成中的分組（例如 `'utility'`、`'character'`、`'time'`） |
| `unnamedArgs` | 一個數量（全部必填）或一個引數定義陣列 |
| `list` | 巨集是否接受可變引數列表 |
| `strictArgs` | 為 `false` 時，arity / 類型不匹配只記錄警告而不擲出 |
| `delayArgResolution` | 為 `true` 時，引數中的巢狀巨集**不會**被預先解析——處理器必須自行呼叫 `ctx.resolve(text)`。僅用於控制流類型的巨集 |

#### 處理器上下文

處理器接收一個 `MacroExecutionContext`，包含：

| 欄位 | 說明 |
|------|------|
| `name` | 呼叫時使用的巨集名 |
| `args` | 具名引數值 |
| `unnamedArgs` | 不具名位置型引數 |
| `list` | 可變列表引數 |
| `env` | 巨集求值環境（聊天、角色、persona 等） |
| `normalize(value)` | 把值強制轉成巨集的回傳類型 |
| `trimContent(content, opts?)` | 修剪多行區塊 |
| `resolve(text, opts?)` | 解析 `text` 中的巢狀巨集 |
| `warn(message, error?)` | 記錄一條歸屬到此巨集的警告 |

```js
const ctx = Luker.getContext();

ctx.macros.register('myStatus', {
    description: 'Returns the plugin status string.',
    category: 'utility',
    handler: () => 'My plugin is active.',
});

ctx.macros.register('greet', {
    description: 'Greets a name.',
    unnamedArgs: [
        { name: 'name', optional: false, type: 'string', description: 'Person to greet' },
    ],
    handler: (mctx) => `Hello, ${mctx.unnamedArgs[0]}!`,
});
```

註冊後 <span v-pre>`{{myStatus}}`</span> 和 <span v-pre>`{{greet::Bob}}`</span> 都能正常工作。

### macros.registry

底層的註冊表。用於反註冊和檢視：

```js
ctx.macros.registry.unregisterMacro('myStatus');
ctx.macros.registry.hasMacro('greet');
const def = ctx.macros.registry.getMacro('greet');
```

### 內建巨集參考

下列為 core 註冊的非詳盡列表。完整覆蓋見 `public/scripts/macros/definitions/` 下的原始碼。

| 巨集 | 回傳 |
|------|------|
| <span v-pre>`{{user}}`</span> | 當前使用者 / persona 名稱 |
| <span v-pre>`{{char}}`</span> | 當前角色名 |
| <span v-pre>`{{persona}}`</span> | 當前 persona 描述 |
| <span v-pre>`{{charDescription}}`</span> / <span v-pre>`{{charPersonality}}`</span> / <span v-pre>`{{charScenario}}`</span> | 角色卡欄位 |
| <span v-pre>`{{charDepthPrompt}}`</span> / <span v-pre>`{{charCreatorNotes}}`</span> / <span v-pre>`{{charFirstMessage}}`</span> / <span v-pre>`{{charVersion}}`</span> | 角色卡欄位 |
| <span v-pre>`{{mesExamples}}`</span> / <span v-pre>`{{mesExamplesRaw}}`</span> | 對話範例 |
| <span v-pre>`{{group}}`</span> / <span v-pre>`{{groupNotMuted}}`</span> | 群組成員名稱 |
| <span v-pre>`{{lastMessage}}`</span> / <span v-pre>`{{lastMessageId}}`</span> / <span v-pre>`{{lastUserMessage}}`</span> / <span v-pre>`{{lastCharMessage}}`</span> | 最近的聊天內容 |
| <span v-pre>`{{firstIncludedMessageId}}`</span> / <span v-pre>`{{firstDisplayedMessageId}}`</span> | 可見視窗 |
| <span v-pre>`{{lastSwipeId}}`</span> / <span v-pre>`{{currentSwipeId}}`</span> | swipe 狀態 |
| <span v-pre>`{{model}}`</span> | 當前模型識別碼 |
| <span v-pre>`{{maxPrompt}}`</span> / <span v-pre>`{{maxContext}}`</span> / <span v-pre>`{{maxResponse}}`</span> | token 預算 |
| <span v-pre>`{{time}}`</span> / <span v-pre>`{{date}}`</span> / <span v-pre>`{{weekday}}`</span> / <span v-pre>`{{isotime}}`</span> / <span v-pre>`{{isodate}}`</span> | 本地時鐘 |
| <span v-pre>`{{datetimeformat::FORMAT}}`</span> | `moment.format(FORMAT)` |
| <span v-pre>`{{idleDuration}}`</span> / <span v-pre>`{{timeDiff}}`</span> | 時間差 |
| <span v-pre>`{{getvar::name}}`</span> / <span v-pre>`{{setvar::name::value}}`</span> / <span v-pre>`{{addvar::name::value}}`</span> | 本地變數 |
| <span v-pre>`{{incvar::name}}`</span> / <span v-pre>`{{decvar::name}}`</span> / <span v-pre>`{{hasvar::name}}`</span> / <span v-pre>`{{deletevar::name}}`</span> | 本地變數 |
| <span v-pre>`{{getglobalvar::name}}`</span> / <span v-pre>`{{setglobalvar::name::value}}`</span> / ... | 全域變數 |
| <span v-pre>`{{if::cond::then::else}}`</span> / <span v-pre>`{{else::...}}`</span> / <span v-pre>`{{each::...}}`</span> | 控制流 |
| <span v-pre>`{{trim}}`</span> / <span v-pre>`{{newline}}`</span> / <span v-pre>`{{space}}`</span> / <span v-pre>`{{noop}}`</span> | 空白輔助 |
| <span v-pre>`{{roll::XdY}}`</span> / <span v-pre>`{{random::a,b,c}}`</span> / <span v-pre>`{{pick::a,b,c}}`</span> | 隨機 |
| <span v-pre>`{{//comment}}`</span> | 註解（輸出忽略） |
| <span v-pre>`{{outlet::name}}`</span> | 自訂 WI outlet 內容 |
| <span v-pre>`{{isMobile}}`</span> / <span v-pre>`{{hasExtension::name}}`</span> | 環境檢查 |
| <span v-pre>`{{lastGenerationType}}`</span> / <span v-pre>`{{systemPrompt}}`</span> | 流水線狀態 |

### MacrosParser（已棄用）

```ts
MacrosParser.registerMacro(key: string, value: string | (nonce) => string, description?: string): void
MacrosParser.unregisterMacro(key: string): void
```

註冊單純字串替換巨集的舊 API。會記錄棄用警告。請遷移到 `macros.register({ handler })` 以取得完整功能支援，或在單次呼叫中傳 `dynamicMacros` 給 `substituteParams`。

### substituteParams

```ts
substituteParams(content: string, options?: {
    name1Override?: string,
    name2Override?: string,
    original?: string,
    groupOverride?: string,
    replaceCharacterCard?: boolean,
    dynamicMacros?: Record<string, string | (() => string)>,
    postProcessFn?: (text: string) => string,
}): string
```

解析 `content` 中的所有巨集。用 `dynamicMacros` 為單次呼叫注入即用即拋的 0 引數巨集：

```js
const result = ctx.substituteParams('Hello, {{user}}! Today is {{date}}.');
```

### substituteParamsExtended

```ts
substituteParamsExtended(
    content: string,
    additionalMacros?: Record<string, string | (() => string)>,
    postProcessFn?: (text: string) => string,
): string
```

`substituteParams` 的便利包裝，僅為當前呼叫加入 `additionalMacros`：

```js
const result = ctx.substituteParamsExtended(
    'Query: {{queryText}}',
    { queryText: userInput },
);
```

`additionalMacros` 不會被全域註冊——僅在這次替換中存在。

## 變數

有兩個作用域：**本地**（按聊天，持久化在 `chat_metadata.variables`）和**全域**（跨聊天，持久化在 `extension_settings.variables.global`）。

### 本地變數

```ts
context.variables.local.get(name: string, args?: object): string | number
context.variables.local.set(name: string, value: any, args?: object): any
context.variables.local.add(name: string, value: any): any
context.variables.local.inc(name: string): any
context.variables.local.dec(name: string): any
context.variables.local.del(name: string): ''
context.variables.local.has(name: string): boolean
```

| 方法 | 說明 |
|------|------|
| `get` | 讀取變數。數字字串會自動強制成數字。不存在時回傳 `''` |
| `set` | 寫入變數。回傳該值 |
| `add` | 兩者都是數字時做數字加法。已有值是 JSON 陣列時 push。否則作為字串串接 |
| `inc` / `dec` | `add(name, ±1)` 的捷徑 |
| `del` | 移除變數。回傳 `''` |
| `has` | 布林存在性檢查 |

`get` / `set` 上可選的 `args` 參數支援：
- `args.key` —— 替代變數名（覆寫 `name`）
- `args.index` —— 對儲存於變數中的 JSON list / dict 的索引 / 鍵
- `args.as`（僅 set） —— 為索引寫入強制成 `'string'` / `'number'` / `'boolean'`

### 全域變數

```ts
context.variables.global.get / set / add / inc / dec / del / has
```

與本地變數有相同的介面。跨聊天持久化。

### 使用範例

```js
const ctx = Luker.getContext();

// 帶預設值讀取本地變數
const turns = Number(ctx.variables.local.get('turns_taken')) || 0;

// 自增
ctx.variables.local.inc('turns_taken');

// 檢查 + 初始化全域設定變數
if (!ctx.variables.global.has('api_endpoint')) {
    ctx.variables.global.set('api_endpoint', 'https://api.example.com');
}
const endpoint = ctx.variables.global.get('api_endpoint');

// 對儲存於本地變數中的 JSON 列表做索引寫入
ctx.variables.local.set('inventory', 'sword', { index: 0, as: 'string' });
ctx.variables.local.set('inventory', 'shield', { index: 1, as: 'string' });
```

### 本地 vs 全域

| | 本地 | 全域 |
|------|------|------|
| 作用域 | 單一聊天 | 所有聊天 |
| 儲存 | `chat_metadata.variables` | `extension_settings.variables.global` |
| 儲存觸發 | `saveMetadataDebounced` | `saveSettingsDebounced` |
| 用途 | 聊天特定計數器、進行中狀態 | 外掛設定、跨聊天資料 |
