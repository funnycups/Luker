# 斜線指令

註冊自訂斜線指令、從外掛程式碼執行斜線指令流水線的相關 API。

## 註冊指令

當前的入口點是 `SlashCommandParser.addCommandObject()`，接收一個由 `SlashCommand.fromProps()` 建構的 `SlashCommand` 實例。

### 基本註冊

```js
const ctx = Luker.getContext();

ctx.SlashCommandParser.addCommandObject(ctx.SlashCommand.fromProps({
    name: 'mygreet',
    helpString: 'Print a friendly greeting.',
    callback: () => 'Hello from my plugin!',
    returns: ctx.ARGUMENT_TYPE.STRING,
}));
```

註冊後該指令可作為 `/mygreet` 呼叫。

### 帶具名與不具名引數

```js
ctx.SlashCommandParser.addCommandObject(ctx.SlashCommand.fromProps({
    name: 'translate',
    helpString: 'Translate text to a target language.',
    namedArgumentList: [
        new ctx.SlashCommandNamedArgument(
            'target',
            'Target language code (e.g. en, ja, zh-cn)',
            ctx.ARGUMENT_TYPE.STRING,
            false,            // isRequired
            false,            // acceptsMultiple
            'en',             // defaultValue
            ['en', 'ja', 'zh-cn'],  // enumList
        ),
    ],
    unnamedArgumentList: [
        new ctx.SlashCommandArgument(
            'Text to translate',
            ctx.ARGUMENT_TYPE.STRING,
            true,   // isRequired
        ),
    ],
    callback: async (args, value) => {
        const target = args?.target ?? 'en';
        return await translate(String(value), target);
    },
    returns: ctx.ARGUMENT_TYPE.STRING,
}));
```

呼叫方式：`/translate target=ja Hello, world!`

## SlashCommand.fromProps

```ts
SlashCommand.fromProps({
    name: string,
    callback: (
        namedArgs: Record<string, any>,
        unnamedArg: string | string[],
    ) => string | Promise<string> | SlashCommandClosure,
    helpString?: string,
    aliases?: string[],
    returns?: string,
    namedArgumentList?: SlashCommandNamedArgument[],
    unnamedArgumentList?: SlashCommandArgument[],
    splitUnnamedArgument?: boolean,
    splitUnnamedArgumentCount?: number,
    rawQuotes?: boolean,
}): SlashCommand
```

| 屬性 | 說明 |
|------|------|
| `name` | 指令名稱（不含開頭的 `/`） |
| `callback` | 處理函式。接收解析後的具名引數（含 `_scope`、`_parserFlags`、`_abortController`、`_hasUnnamedArgument`）和不具名引數 |
| `helpString` | 自動完成中顯示的 HTML 格式說明 |
| `aliases` | 該指令的別名 |
| `returns` | 自由文字的回傳類型描述，或一個 `ARGUMENT_TYPE` 值 |
| `namedArgumentList` | `SlashCommandNamedArgument` 列表（例如 `target=value`） |
| `unnamedArgumentList` | `SlashCommandArgument` 列表（位置型值） |
| `splitUnnamedArgument` | 把不具名引數依 token 拆成陣列 |
| `splitUnnamedArgumentCount` | 拆分數量上限 |
| `rawQuotes` | 在不具名值中保留外層引號 |

`callback` 可以同步或非同步回傳；回傳一個 `SlashCommandClosure` 可組合流水線。

## 引數類型

`context.ARGUMENT_TYPE` 列舉：

| 值 | 含義 |
|------|------|
| `STRING` | 純文字 |
| `NUMBER` | 整數或浮點數 |
| `RANGE` | `min-max` 區間 |
| `BOOLEAN` | `true`/`false` |
| `VARIABLE_NAME` | 聊天 / 全域變數的識別碼 |
| `CLOSURE` | 巢狀斜線指令閉包 |
| `SUBCOMMAND` | 對另一個指令的參照 |
| `LIST` | 陣列字面量 |
| `DICTIONARY` | 物件字面量 |

## SlashCommandArgument

位置型值描述符。

```ts
SlashCommandArgument.fromProps({
    description: string,
    typeList?: ARGUMENT_TYPE | ARGUMENT_TYPE[],
    isRequired?: boolean,
    acceptsMultiple?: boolean,
    defaultValue?: string | SlashCommandClosure,
    enumList?: (string | SlashCommandEnumValue)[],
    enumProvider?: (executor, scope) => SlashCommandEnumValue[],
    forceEnum?: boolean,
}): SlashCommandArgument
```

或透過位置式建構子：

```js
new SlashCommandArgument(description, typeList, isRequired, acceptsMultiple, defaultValue, enumList);
```

當 `typeList` 為 `[BOOLEAN]` 且未提供列舉值時，會自動補上 `true`/`false` 列舉。

## SlashCommandNamedArgument

具名值描述符（`name=value` 風格）。

```ts
SlashCommandNamedArgument.fromProps({
    name: string,
    description: string,
    typeList?: ARGUMENT_TYPE | ARGUMENT_TYPE[],
    isRequired?: boolean,
    acceptsMultiple?: boolean,
    defaultValue?: string | SlashCommandClosure,
    enumList?: (string | SlashCommandEnumValue)[],
    enumProvider?: (executor, scope) => SlashCommandEnumValue[],
    forceEnum?: boolean,
    aliasList?: string[],
}): SlashCommandNamedArgument
```

位置式建構子鏡像 `SlashCommandArgument`，再加上 `name` 與末尾的 `aliasList`：

```js
new SlashCommandNamedArgument(
    name, description, typeList,
    isRequired, acceptsMultiple, defaultValue,
    enumList, aliasList, enumProvider, forceEnum,
);
```

## SlashCommandEnumValue

描述自動完成的列舉選項。

```ts
new SlashCommandEnumValue(
    value: string,
    description?: string | null,
    type?: string,         // 來自 enumTypes 的值
    typeIcon?: string,     // 單一字元 / emoji
    matchProvider?: ((input) => boolean) | null,
    valueProvider?: ((input) => string) | null,
    makeSelectable?: boolean,
);
```

當選項需要在解析時動態計算（例如根據當前設定）時，在引數描述符上使用 `enumProvider`。

## 執行指令

### executeSlashCommandsWithOptions

```ts
executeSlashCommandsWithOptions(
    text: string,
    options?: {
        handleParserErrors?: boolean,
        scope?: SlashCommandScope | null,
        handleExecutionErrors?: boolean,
        parserFlags?: number | null,
        abortController?: AbortController,
        debugController?: DebugController,
        onProgress?: (info) => void,
        source?: string | null,
    },
): Promise<SlashCommandClosureResult>
```

解析並執行斜線指令流水線。預設情況下，解析錯誤會以 toast 形式呈現；執行錯誤會擲出。設 `handleExecutionErrors: true` 可把執行錯誤也以 toast 形式接住。

```js
const result = await ctx.executeSlashCommandsWithOptions('/echo Hello');
console.log(result.pipe);  // 鏈尾的最終 piped 值
```

結果包含：

| 欄位 | 說明 |
|------|------|
| `pipe` | 鏈中最後一個指令之後的最終值 |
| `interrupt` | `/abort` 或類似指令是否中斷了鏈 |
| `isError` | 是否捕獲並 toast 過錯誤 |
| `errorMessage` | toast 出去的錯誤文字（若有） |

### executeSlashCommands（已棄用）

```ts
executeSlashCommands(text, handleParserErrors?, ...positionalOptions): Promise<SlashCommandClosureResult>
```

轉發到 `executeSlashCommandsWithOptions`。遷移時把選項作為單一物件傳入。

### registerSlashCommand（已棄用）

```ts
registerSlashCommand(name, callback, aliases?, helpString?): void
```

傳統的註冊輔助函式。請遷移到 `SlashCommandParser.addCommandObject(SlashCommand.fromProps({...}))`，以取得完整的具名引數支援、自動完成和合適的說明渲染。

## 範例：註冊指令後以程式呼叫

```js
const ctx = Luker.getContext();

// 註冊
ctx.SlashCommandParser.addCommandObject(ctx.SlashCommand.fromProps({
    name: 'plugin-status',
    helpString: 'Print plugin status.',
    callback: () => JSON.stringify({ ok: true, ts: Date.now() }),
    returns: ctx.ARGUMENT_TYPE.STRING,
}));

// 執行
const result = await ctx.executeSlashCommandsWithOptions('/plugin-status | /echo');
console.log(result.pipe);
```
