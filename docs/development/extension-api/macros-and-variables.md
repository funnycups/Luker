# Macros & Variables

APIs for registering custom macros, evaluating macros in text, and reading/writing chat-scoped or global variables.

## Macros

Luker exposes a macro system through the `macros` namespace, plus the legacy `MacrosParser` for backwards compatibility. Built-in macros like `{{user}}`, `{{char}}`, `{{lastMessage}}`, and `{{getvar::name}}` are registered by core; plugins can add their own through `macros.register()`.

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

Registers a macro. Returns the registered definition, or `null` if validation failed.

| Option | Description |
|------|------|
| `handler` | Macro body. Receives an execution context with parsed args |
| `aliases` | Alternate names. Each `{ alias, visible }` registers the same handler |
| `category` | Grouping for autocomplete (e.g. `'utility'`, `'character'`, `'time'`) |
| `unnamedArgs` | Either a count (all required) or an array of arg defs |
| `list` | Whether the macro accepts a variadic list of args |
| `strictArgs` | When `false`, arity/type mismatches log warnings instead of throwing |
| `delayArgResolution` | When `true`, nested macros in args are NOT pre-resolved — the handler must call `ctx.resolve(text)` itself. Use only for control-flow macros |

#### Handler context

The handler receives a `MacroExecutionContext` with:

| Field | Description |
|------|------|
| `name` | Macro name as invoked |
| `args` | Named arg values |
| `unnamedArgs` | Unnamed positional args |
| `list` | Variadic list args |
| `env` | Macro evaluation environment (chat, character, persona, etc.) |
| `normalize(value)` | Coerce a value to the macro's return type |
| `trimContent(content, opts?)` | Trim a multi-line block |
| `resolve(text, opts?)` | Resolve nested macros in `text` |
| `warn(message, error?)` | Log a warning attributed to this macro |

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

After registration, both `{{myStatus}}` and `{{greet::Bob}}` work.

### macros.registry

The underlying registry. Use it for unregistration and inspection:

```js
ctx.macros.registry.unregisterMacro('myStatus');
ctx.macros.registry.hasMacro('greet');
const def = ctx.macros.registry.getMacro('greet');
```

### Built-in macro reference

A non-exhaustive list of macros registered by core. See the source under `public/scripts/macros/definitions/` for full coverage.

| Macro | Returns |
|------|------|
| `{{user}}` | Current user / persona name |
| `{{char}}` | Current character name |
| `{{persona}}` | Current persona description |
| `{{charDescription}}` / `{{charPersonality}}` / `{{charScenario}}` | Card fields |
| `{{charDepthPrompt}}` / `{{charCreatorNotes}}` / `{{charFirstMessage}}` / `{{charVersion}}` | Card fields |
| `{{mesExamples}}` / `{{mesExamplesRaw}}` | Dialogue examples |
| `{{group}}` / `{{groupNotMuted}}` | Group member names |
| `{{lastMessage}}` / `{{lastMessageId}}` / `{{lastUserMessage}}` / `{{lastCharMessage}}` | Recent chat content |
| `{{firstIncludedMessageId}}` / `{{firstDisplayedMessageId}}` | Visibility window |
| `{{lastSwipeId}}` / `{{currentSwipeId}}` | Swipe state |
| `{{model}}` | Active model identifier |
| `{{maxPrompt}}` / `{{maxContext}}` / `{{maxResponse}}` | Token budgets |
| `{{time}}` / `{{date}}` / `{{weekday}}` / `{{isotime}}` / `{{isodate}}` | Local clock |
| `{{datetimeformat::FORMAT}}` | `moment.format(FORMAT)` |
| `{{idleDuration}}` / `{{timeDiff}}` | Time deltas |
| `{{getvar::name}}` / `{{setvar::name::value}}` / `{{addvar::name::value}}` | Local variables |
| `{{incvar::name}}` / `{{decvar::name}}` / `{{hasvar::name}}` / `{{deletevar::name}}` | Local variables |
| `{{getglobalvar::name}}` / `{{setglobalvar::name::value}}` / ... | Global variables |
| `{{if::cond::then::else}}` / `{{else::...}}` / `{{each::...}}` | Control flow |
| `{{trim}}` / `{{newline}}` / `{{space}}` / `{{noop}}` | Whitespace helpers |
| `{{roll::XdY}}` / `{{random::a,b,c}}` / `{{pick::a,b,c}}` | Randomness |
| `{{//comment}}` | Comment (ignored output) |
| `{{outlet::name}}` | Custom WI outlet content |
| `{{isMobile}}` / `{{hasExtension::name}}` | Environment checks |
| `{{lastGenerationType}}` / `{{systemPrompt}}` | Pipeline state |

### MacrosParser (deprecated)

```ts
MacrosParser.registerMacro(key: string, value: string | (nonce) => string, description?: string): void
MacrosParser.unregisterMacro(key: string): void
```

Older API for registering simple string-substitution macros. Logs a deprecation warning. Migrate to `macros.register({ handler })` for full feature support, or pass `dynamicMacros` to `substituteParams` for one-off invocation.

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

Resolves all macros in `content`. Use `dynamicMacros` to inject ad-hoc 0-arg macros for a single call:

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

Convenience wrapper around `substituteParams` that adds `additionalMacros` for the current call only:

```js
const result = ctx.substituteParamsExtended(
    'Query: {{queryText}}',
    { queryText: userInput },
);
```

The `additionalMacros` are not registered globally — they exist only for this single substitution.

## Variables

Two scopes are available: **local** (per-chat, persisted in `chat_metadata.variables`) and **global** (cross-chat, persisted in `extension_settings.variables.global`).

### Local Variables

```ts
context.variables.local.get(name: string, args?: object): string | number
context.variables.local.set(name: string, value: any, args?: object): any
context.variables.local.add(name: string, value: any): any
context.variables.local.inc(name: string): any
context.variables.local.dec(name: string): any
context.variables.local.del(name: string): ''
context.variables.local.has(name: string): boolean
```

| Method | Description |
|------|------|
| `get` | Reads the variable. Numeric strings are auto-coerced to numbers. Returns `''` for missing |
| `set` | Writes the variable. Returns the value |
| `add` | If both are numeric, performs numeric addition. If existing is a JSON array, pushes. Otherwise concatenates as strings |
| `inc` / `dec` | Shortcuts for `add(name, ±1)` |
| `del` | Removes the variable. Returns `''` |
| `has` | Boolean existence check |

The optional `args` parameter on `get` / `set` supports:
- `args.key` — alternative variable name (overrides `name`)
- `args.index` — index/key into a JSON list/dict stored in the variable
- `args.as` (set only) — coerce to `'string'` / `'number'` / `'boolean'` for indexed writes

### Global Variables

```ts
context.variables.global.get / set / add / inc / dec / del / has
```

Same surface as local. Persisted across chats.

### Usage Example

```js
const ctx = Luker.getContext();

// Read a local var with default
const turns = Number(ctx.variables.local.get('turns_taken')) || 0;

// Increment
ctx.variables.local.inc('turns_taken');

// Check + initialize a global config var
if (!ctx.variables.global.has('api_endpoint')) {
    ctx.variables.global.set('api_endpoint', 'https://api.example.com');
}
const endpoint = ctx.variables.global.get('api_endpoint');

// Indexed write into a JSON list stored in a local var
ctx.variables.local.set('inventory', 'sword', { index: 0, as: 'string' });
ctx.variables.local.set('inventory', 'shield', { index: 1, as: 'string' });
```

### Local vs Global

| | Local | Global |
|------|------|------|
| Scope | Single chat | All chats |
| Storage | `chat_metadata.variables` | `extension_settings.variables.global` |
| Save trigger | `saveMetadataDebounced` | `saveSettingsDebounced` |
| Use for | Chat-specific counters, in-progress state | Plugin config, cross-chat data |
