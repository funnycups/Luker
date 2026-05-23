# Macros & Variables

APIs for registering custom macros, evaluating macros in text, and reading/writing chat-scoped or global variables.

## Macros

Luker exposes a macro system through the `macros` namespace, plus the legacy `MacrosParser` for backwards compatibility. Built-in macros like <span v-pre>`{{user}}`</span>, <span v-pre>`{{char}}`</span>, <span v-pre>`{{lastMessage}}`</span>, and <span v-pre>`{{getvar::name}}`</span> are registered by core; plugins can add their own through `macros.register()`.

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

After registration, both <span v-pre>`{{myStatus}}`</span> and <span v-pre>`{{greet::Bob}}`</span> work.

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
| <span v-pre>`{{user}}`</span> | Current user / persona name |
| <span v-pre>`{{char}}`</span> | Current character name |
| <span v-pre>`{{persona}}`</span> | Current persona description |
| <span v-pre>`{{charDescription}}`</span> / <span v-pre>`{{charPersonality}}`</span> / <span v-pre>`{{charScenario}}`</span> | Card fields |
| <span v-pre>`{{charDepthPrompt}}`</span> / <span v-pre>`{{charCreatorNotes}}`</span> / <span v-pre>`{{charFirstMessage}}`</span> / <span v-pre>`{{charVersion}}`</span> | Card fields |
| <span v-pre>`{{mesExamples}}`</span> / <span v-pre>`{{mesExamplesRaw}}`</span> | Dialogue examples |
| <span v-pre>`{{group}}`</span> / <span v-pre>`{{groupNotMuted}}`</span> | Group member names |
| <span v-pre>`{{lastMessage}}`</span> / <span v-pre>`{{lastMessageId}}`</span> / <span v-pre>`{{lastUserMessage}}`</span> / <span v-pre>`{{lastCharMessage}}`</span> | Recent chat content |
| <span v-pre>`{{firstIncludedMessageId}}`</span> / <span v-pre>`{{firstDisplayedMessageId}}`</span> | Visibility window |
| <span v-pre>`{{lastSwipeId}}`</span> / <span v-pre>`{{currentSwipeId}}`</span> | Swipe state |
| <span v-pre>`{{model}}`</span> | Active model identifier |
| <span v-pre>`{{maxPrompt}}`</span> / <span v-pre>`{{maxContext}}`</span> / <span v-pre>`{{maxResponse}}`</span> | Token budgets |
| <span v-pre>`{{time}}`</span> / <span v-pre>`{{date}}`</span> / <span v-pre>`{{weekday}}`</span> / <span v-pre>`{{isotime}}`</span> / <span v-pre>`{{isodate}}`</span> | Local clock |
| <span v-pre>`{{datetimeformat::FORMAT}}`</span> | `moment.format(FORMAT)` |
| <span v-pre>`{{idleDuration}}`</span> / <span v-pre>`{{timeDiff}}`</span> | Time deltas |
| <span v-pre>`{{getvar::name}}`</span> / <span v-pre>`{{setvar::name::value}}`</span> / <span v-pre>`{{addvar::name::value}}`</span> | Local variables |
| <span v-pre>`{{incvar::name}}`</span> / <span v-pre>`{{decvar::name}}`</span> / <span v-pre>`{{hasvar::name}}`</span> / <span v-pre>`{{deletevar::name}}`</span> | Local variables |
| <span v-pre>`{{pushvar::name::value}}`</span> / <span v-pre>`{{popvar::name}}`</span> | Local variables — array push / pop. Auto-creates `[]` when missing; supports dotted paths |
| <span v-pre>`{{getglobalvar::name}}`</span> / <span v-pre>`{{setglobalvar::name::value}}`</span> / ... | Global variables |
| <span v-pre>`{{if::cond::then::else}}`</span> / <span v-pre>`{{else::...}}`</span> / <span v-pre>`{{each::...}}`</span> | Control flow |
| <span v-pre>`{{trim}}`</span> / <span v-pre>`{{newline}}`</span> / <span v-pre>`{{space}}`</span> / <span v-pre>`{{noop}}`</span> | Whitespace helpers |
| <span v-pre>`{{roll::XdY}}`</span> / <span v-pre>`{{random::a,b,c}}`</span> / <span v-pre>`{{pick::a,b,c}}`</span> | Randomness |
| <span v-pre>`{{//comment}}`</span> | Comment (ignored output) |
| <span v-pre>`{{outlet::name}}`</span> | Custom WI outlet content |
| <span v-pre>`{{isMobile}}`</span> / <span v-pre>`{{hasExtension::name}}`</span> | Environment checks |
| <span v-pre>`{{lastGenerationType}}`</span> / <span v-pre>`{{systemPrompt}}`</span> | Pipeline state |

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
context.variables.local.push(name: string, value: any): string | undefined
context.variables.local.pop(name: string): string | undefined
```

| Method | Description |
|------|------|
| `get` | Reads the variable. Numeric strings are auto-coerced to numbers. Returns `''` for missing |
| `set` | Writes the variable. Returns the value |
| `add` | If both are numeric, performs numeric addition. If existing is a JSON array, pushes. Otherwise concatenates as strings |
| `inc` / `dec` | Shortcuts for `add(name, ±1)` |
| `del` | Removes the variable. Returns `''` |
| `has` | Boolean existence check |
| `push` | Pushes `value` onto the JSON array at `name`. Auto-creates `[]` when missing. The macro form is <span v-pre>`{{pushvar::name::value}}`</span> |
| `pop` | Pops the last element from the JSON array at `name`. No-op when empty or missing. The macro form is <span v-pre>`{{popvar::name}}`</span> |

`name` on every method above accepts a dotted path (e.g. `roster.alice.hp`) to read or write a leaf inside a structured variable. The write methods mutate `chat_metadata.variables[root]` in place, the same way the macro-side <span v-pre>`{{setvar::roster.alice.hp::value}}`</span> does; intermediate nodes are created on demand.

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

### Floor-bound writes

Beyond the seven-method `local` / `global` CRUD, luker also exports a top-level `setVariable` that can bind a single write to a specific floor — the code-side equivalent of writing <span v-pre>`{{setvar::name::value}}`</span> inside that floor's text.

```ts
context.setVariable(
    name: string,
    value: any,
    options?: { floor?: number },
): Promise<any>
```

| Call form | Effect |
|---|---|
| `await ctx.setVariable(k, v)` | Writes `chat_metadata.variables[k] = v` directly. Same bucket as `ctx.variables.local.set(k, v)`; useful when you want an awaitable shortcut |
| `await ctx.setVariable(k, v, { floor: N })` | Appends a `setvar` op to floor N's `extra.var_ops`, bound to that floor's current swipe. On swipe switches / message deletions / branch creates, the variable-op-log replays in lockstep with the floors |

Details when `floor` is set:

- **The value is coerced to a string** — `extra.var_ops` entries only carry strings (since <span v-pre>`{{getvar}}`</span> also returns strings). For structured state, use `createFloorState` instead (see [floor-bound structured state](./chat-and-state.md#createfloorstate)).
- **It's a replay, not an overwrite** — on swipe / delete / branch, the rebuilder walks every surviving var_op in write order and replays the keys those ops touch onto `chat_metadata.variables`. Keys that no surviving var_op writes (world-info side effects, slash commands, third-party extension writes) are left untouched. A floor write doesn't mutate storage directly; it contributes one instruction to every future replay.
- **`floor` must be a valid floor index** (`0 <= floor < chat.length`); out-of-range throws.
- **Dotted names work the same way for floor-bound writes** — `setVariable('roster.alice.hp', 50, { floor })` splits on the first `.` and forwards `path` into the op record. `op.key` stays as the top-level variable name, so replay treats the whole structure as one unit.

```js
const ctx = Luker.getContext();

// Immediate write — same bucket as ctx.variables.local.set
await ctx.setVariable('quest_stage', 'intro');

// Bound to the last floor; replays alongside swipe / delete / branch
await ctx.setVariable('hp', 42, { floor: ctx.chat.length - 1 });
```

#### Floor writes vs `createFloorState`

| | Floor write | `createFloorState` |
|---|---|---|
| Data shape | Scalar (string / number) | Structured object |
| Bucket | Shares `chat_metadata.variables` with <span v-pre>`{{getvar::k}}`</span> | Independent namespace, never reaches macros |
| Commit log | variable-op-log (floor `extra.var_ops`) | Floor structured commit log (`__floor_log`) |
| Use for | Rollback-friendly scalars co-owned with AI-written <span v-pre>`{{setvar}}`</span> | Plugin- or CardApp-managed rollback-friendly structured state |

The two mechanisms have independent commit logs. **Don't write the same key from both** — replay order isn't guaranteed across them, and you'll see one clobber the other.
