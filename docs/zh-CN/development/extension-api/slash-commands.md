# Slash 命令

注册自定义 slash 命令，以及在插件代码中执行 slash 命令流水线的相关 API。

## 注册命令

当前入口是 `SlashCommandParser.addCommandObject()`，接受通过 `SlashCommand.fromProps()` 构建的 `SlashCommand` 实例。

### 基础注册

```js
const ctx = Luker.getContext();

ctx.SlashCommandParser.addCommandObject(ctx.SlashCommand.fromProps({
    name: 'mygreet',
    helpString: 'Print a friendly greeting.',
    callback: () => 'Hello from my plugin!',
    returns: ctx.ARGUMENT_TYPE.STRING,
}));
```

注册后该命令可作为 `/mygreet` 调用。

### 带命名参数和非命名参数

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

调用：`/translate target=ja Hello, world!`

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

| 字段 | 说明 |
|------|------|
| `name` | 命令名（不带前导 `/`） |
| `callback` | 处理器。接收解析后的命名参数（含 `_scope`、`_parserFlags`、`_abortController`、`_hasUnnamedArgument`）和非命名参数 |
| `helpString` | 自动补全里展示的 HTML 帮助文本 |
| `aliases` | 命令的备用名 |
| `returns` | 自由文本的返回类型描述，或 `ARGUMENT_TYPE` 枚举值 |
| `namedArgumentList` | `SlashCommandNamedArgument` 列表（如 `target=value`） |
| `unnamedArgumentList` | `SlashCommandArgument` 列表（位置参数） |
| `splitUnnamedArgument` | 是否按 token 把非命名参数拆成数组 |
| `splitUnnamedArgumentCount` | 拆分上限 |
| `rawQuotes` | 保留非命名值外层的引号 |

`callback` 可以同步或异步返回；返回 `SlashCommandClosure` 可以让你组合流水线。

## 参数类型

`context.ARGUMENT_TYPE` 枚举：

| 值 | 含义 |
|------|------|
| `STRING` | 纯文本 |
| `NUMBER` | 整数或浮点数 |
| `RANGE` | `min-max` 区间 |
| `BOOLEAN` | `true`/`false` |
| `VARIABLE_NAME` | 聊天 / 全局变量名 |
| `CLOSURE` | 嵌套 slash 命令闭包 |
| `SUBCOMMAND` | 引用另一个命令 |
| `LIST` | 数组字面量 |
| `DICTIONARY` | 对象字面量 |

## SlashCommandArgument

位置参数描述符。

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

或通过位置参数构造函数：

```js
new SlashCommandArgument(description, typeList, isRequired, acceptsMultiple, defaultValue, enumList);
```

当 `typeList` 是 `[BOOLEAN]` 且未提供枚举时，会自动补上 `true`/`false` 枚举。

## SlashCommandNamedArgument

命名参数描述符（`name=value` 风格）。

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

位置参数构造函数与 `SlashCommandArgument` 类似，多了 `name` 和末尾的 `aliasList`：

```js
new SlashCommandNamedArgument(
    name, description, typeList,
    isRequired, acceptsMultiple, defaultValue,
    enumList, aliasList, enumProvider, forceEnum,
);
```

## SlashCommandEnumValue

描述自动补全里的一个枚举选项。

```ts
new SlashCommandEnumValue(
    value: string,
    description?: string | null,
    type?: string,         // 取自 enumTypes
    typeIcon?: string,     // 单字符 / emoji
    matchProvider?: ((input) => boolean) | null,
    valueProvider?: ((input) => string) | null,
    makeSelectable?: boolean,
);
```

如果选项需要在解析时计算（例如来自当前设置），请在参数描述符上使用 `enumProvider`。

## 执行命令

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

解析并执行 slash 命令流水线。默认情况下，解析错误以 toast 形式呈现；执行错误会抛出。把 `handleExecutionErrors` 设为 `true` 可以同样以 toast 形式捕获执行错误。

```js
const result = await ctx.executeSlashCommandsWithOptions('/echo Hello');
console.log(result.pipe);  // 流水线最终的管道值
```

结果包含：

| 字段 | 说明 |
|------|------|
| `pipe` | 链上最后一个命令的最终值 |
| `interrupt` | 是否被 `/abort` 之类打断 |
| `isError` | 是否捕获并 toast 了错误 |
| `errorMessage` | 已 toast 的错误文本，如有 |

### executeSlashCommands（已弃用）

```ts
executeSlashCommands(text, handleParserErrors?, ...positionalOptions): Promise<SlashCommandClosureResult>
```

转发到 `executeSlashCommandsWithOptions`。请将选项作为单一对象传入以完成迁移。

### registerSlashCommand（已弃用）

```ts
registerSlashCommand(name, callback, aliases?, helpString?): void
```

旧版注册助手。迁移到 `SlashCommandParser.addCommandObject(SlashCommand.fromProps({...}))` 以获得完整的命名参数支持、自动补全和正确的帮助渲染。

## 示例：注册命令并以编程方式调用

```js
const ctx = Luker.getContext();

// 注册
ctx.SlashCommandParser.addCommandObject(ctx.SlashCommand.fromProps({
    name: 'plugin-status',
    helpString: 'Print plugin status.',
    callback: () => JSON.stringify({ ok: true, ts: Date.now() }),
    returns: ctx.ARGUMENT_TYPE.STRING,
}));

// 执行
const result = await ctx.executeSlashCommandsWithOptions('/plugin-status | /echo');
console.log(result.pipe);
```
