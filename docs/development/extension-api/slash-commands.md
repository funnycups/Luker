# Slash Commands

APIs for registering custom slash commands and executing slash command pipelines from plugin code.

## Registering a Command

The current entry point is `SlashCommandParser.addCommandObject()`, accepting a `SlashCommand` instance built via `SlashCommand.fromProps()`.

### Basic registration

```js
const ctx = Luker.getContext();

ctx.SlashCommandParser.addCommandObject(ctx.SlashCommand.fromProps({
    name: 'mygreet',
    helpString: 'Print a friendly greeting.',
    callback: () => 'Hello from my plugin!',
    returns: ctx.ARGUMENT_TYPE.STRING,
}));
```

After registration, the command is invokable as `/mygreet`.

### With named and unnamed arguments

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

Invocation: `/translate target=ja Hello, world!`

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

| Prop | Description |
|------|------|
| `name` | Command name (no leading `/`) |
| `callback` | Handler. Receives parsed named args (incl. `_scope`, `_parserFlags`, `_abortController`, `_hasUnnamedArgument`) and the unnamed arg |
| `helpString` | HTML-formatted help shown in autocomplete |
| `aliases` | Alternative names for the command |
| `returns` | Free-text return-type description, or an `ARGUMENT_TYPE` value |
| `namedArgumentList` | List of `SlashCommandNamedArgument` (e.g., `target=value`) |
| `unnamedArgumentList` | List of `SlashCommandArgument` (positional values) |
| `splitUnnamedArgument` | Split the unnamed arg into an array per token |
| `splitUnnamedArgumentCount` | Cap on the split count |
| `rawQuotes` | Keep wrapping quotes intact in unnamed values |

The `callback` may return synchronously or asynchronously; returning a `SlashCommandClosure` lets you compose pipelines.

## Argument Types

`context.ARGUMENT_TYPE` enum:

| Value | Meaning |
|------|------|
| `STRING` | Plain text |
| `NUMBER` | Integer or float |
| `RANGE` | `min-max` range |
| `BOOLEAN` | `true`/`false` |
| `VARIABLE_NAME` | Identifier of a chat/global variable |
| `CLOSURE` | Nested slash-command closure |
| `SUBCOMMAND` | Reference to another command |
| `LIST` | Array literal |
| `DICTIONARY` | Object literal |

## SlashCommandArgument

Positional value descriptor.

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

Or via the positional constructor:

```js
new SlashCommandArgument(description, typeList, isRequired, acceptsMultiple, defaultValue, enumList);
```

When `typeList` is `[BOOLEAN]` and no enums are provided, an automatic `true`/`false` enum is supplied.

## SlashCommandNamedArgument

Named value descriptor (`name=value` style).

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

The positional constructor mirrors `SlashCommandArgument` plus a `name` and trailing `aliasList`:

```js
new SlashCommandNamedArgument(
    name, description, typeList,
    isRequired, acceptsMultiple, defaultValue,
    enumList, aliasList, enumProvider, forceEnum,
);
```

## SlashCommandEnumValue

Describes an enum option for autocomplete.

```ts
new SlashCommandEnumValue(
    value: string,
    description?: string | null,
    type?: string,         // a value from enumTypes
    typeIcon?: string,     // single character / emoji
    matchProvider?: ((input) => boolean) | null,
    valueProvider?: ((input) => string) | null,
    makeSelectable?: boolean,
);
```

Use `enumProvider` on an argument descriptor when the choices need to be computed at parse time (e.g., from current settings).

## Executing Commands

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

Parses and executes a slash command pipeline. By default, parser errors surface as toasts; execution errors throw. Set `handleExecutionErrors: true` to catch them as toasts as well.

```js
const result = await ctx.executeSlashCommandsWithOptions('/echo Hello');
console.log(result.pipe);  // The final piped value
```

The result includes:

| Field | Description |
|------|------|
| `pipe` | Final value after the last command in the chain |
| `interrupt` | Whether `/abort` or similar interrupted the chain |
| `isError` | Whether an error was caught and toasted |
| `errorMessage` | Toasted error text, if any |

### executeSlashCommands (deprecated)

```ts
executeSlashCommands(text, handleParserErrors?, ...positionalOptions): Promise<SlashCommandClosureResult>
```

Forwards to `executeSlashCommandsWithOptions`. Migrate by passing the options as a single object.

### registerSlashCommand (deprecated)

```ts
registerSlashCommand(name, callback, aliases?, helpString?): void
```

Legacy registration helper. Migrate to `SlashCommandParser.addCommandObject(SlashCommand.fromProps({...}))` to get full named-argument support, autocomplete, and proper help rendering.

## Example: registering a command, then calling it programmatically

```js
const ctx = Luker.getContext();

// Register
ctx.SlashCommandParser.addCommandObject(ctx.SlashCommand.fromProps({
    name: 'plugin-status',
    helpString: 'Print plugin status.',
    callback: () => JSON.stringify({ ok: true, ts: Date.now() }),
    returns: ctx.ARGUMENT_TYPE.STRING,
}));

// Execute
const result = await ctx.executeSlashCommandsWithOptions('/plugin-status | /echo');
console.log(result.pipe);
```
