# World Info

APIs for reading, writing, and scanning World Info (lorebook) entries. All functions are exposed through `Luker.getContext()`; raw HTTP routes are listed in [Low-Level Endpoints](/development/extension-api/low-level-endpoints).

## Reading World Info

### loadWorldInfo

```ts
loadWorldInfo(name: string): Promise<WorldInfoData | null>
```

Reads a single World Info file by name. Name lookup is case- and accent-insensitive. Returns `null` when no matching file exists. Internally cached — repeated reads of the same file are served from memory.

```js
const ctx = Luker.getContext();
const book = await ctx.loadWorldInfo('My Lorebook');
console.log(Object.keys(book.entries).length);
```

### loadWorldInfoBatch

```ts
loadWorldInfoBatch(names: string[]): Promise<Map<string, WorldInfoData | null>>
```

Reads multiple World Info files in a single HTTP round-trip. Returns a `Map` keyed by the resolved name; entries that don't exist map to `null`. Cached files and in-flight requests are merged automatically.

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

Returns a snapshot copy of all World Info file names known to the editor. Use this to populate UI dropdowns.

### getWorldInfoPrompt

```ts
getWorldInfoPrompt(
    chat: string[],
    maxContext: number,
    isDryRun: boolean,
    globalScanData: WIGlobalScanData,
): Promise<WIPromptResult>
```

Lower-level scanner that produces World Info prompt fragments for a given chat slice. Most plugins should prefer [`resolveWorldInfoForMessages`](/development/extension-api/presets-and-prompts#resolveworldinfoformessages) instead — it wraps this with normalization and a post-activation hook.

`WIPromptResult` shape:

| Field | Type | Description |
|------|------|------|
| `worldInfoString` | `string` | `before` + `after` joined by newline |
| `worldInfoBeforeEntries` | `string[]` | Entries injected before the chat |
| `worldInfoAfterEntries` | `string[]` | Entries injected after the chat |
| `worldInfoExamples` | `Array<{position, content}>` | Dialogue example entries |
| `worldInfoDepth` | `Array<{depth, role, entries}>` | Depth-injection entries |
| `anBefore` / `anAfter` | `string[]` | Author's note injections |
| `outletEntries` | `Record<string, string[]>` | Custom outlet payloads |

When `isDryRun` is `false`, an `event_types.WORLD_INFO_ACTIVATED` event is emitted with the activated entries.

## Writing World Info

### saveWorldInfo

```ts
saveWorldInfo(
    name: string,
    data: WorldInfoData,
    immediately?: boolean,
    options?: object,
): Promise<void>
```

Persists a World Info file to disk. Cache is updated synchronously; the network write goes through a debounced queue by default.

| Parameter | Description |
|------|------|
| `name` | File name (without `.json` extension) |
| `data` | Full World Info object (`{ entries: Record<number, WIEntry> }`) |
| `immediately` | When `true`, awaits the actual save instead of debouncing |

A no-op if `name` or `data` is falsy.

### updateWorldInfoList

```ts
updateWorldInfoList(): Promise<void>
```

Refreshes the global `world_names` list from the server. Call after creating, deleting, or renaming a file from outside the editor UI.

### createWorldBook

```ts
createWorldBook(name: string, options?: { interactive?: boolean }): Promise<boolean>
```

Create a new empty world book file. Returns `true` on success, `false` on failure (e.g. duplicate name when `interactive` is false). Pass `interactive: false` (default) to skip the duplicate-name confirmation popup, useful for programmatic creation. The created file has zero entries — populate via [`saveWorldInfo`](#saveworldinfo) or via the editor.

### importEmbeddedWorldInfo

```ts
importEmbeddedWorldInfo(skipPopup?: boolean): Promise<void>
```

Import the V2/V3 `data.character_book` carried inside a third-party PNG card as a real world book file and bind it as the character's primary world. The character to import for is read from the `#import_character_info` element's `chid` data attribute (the character editor sets this when a card with an embedded book is opened). Pass `skipPopup: true` to bypass the confirmation popup and import unconditionally — used by tooling that's already obtained explicit confirmation. After import, `characters[chid].data.extensions.world` points at the new file and the embedded book is no longer offered for re-import.

### charUpdatePrimaryWorld

```ts
charUpdatePrimaryWorld(name: string): Promise<void>
```

Bind the character's primary world book by name (or unbind by passing `''`). Persists via the character editor save path, so it requires an active character context.

### getCharacterEmbeddedWorld

```ts
getCharacterEmbeddedWorld(charId: number | string): {
    present: boolean,
    name: string | null,
    entryCount: number,
    bound: boolean,
}
```

Read-only inspector for a card's V2/V3 embedded `data.character_book`:
- `present` — whether the card carries an embedded book.
- `name` — the embedded book's `name` field.
- `entryCount` — number of entries inside the embedded book.
- `bound` — whether the card is already bound to a real world book file (i.e. `data.extensions.world` resolves to a known world). When `present && !bound`, the embedded book has not yet been imported via `importEmbeddedWorldInfo`. When `present && bound`, the embedded book is just a stale mirror of the bound world (a benign post-export artifact) and should be ignored at runtime.

### reloadWorldInfoEditor

```ts
reloadWorldInfoEditor(file: string, loadIfNotSelected?: boolean): void
```

Re-renders the World Info editor for `file`. By default a no-op when `file` isn't the currently open one; set `loadIfNotSelected` to `true` to switch to it.

## Activation Scanning

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

Runs a World Info activation pass against the supplied messages and returns the activation result. This is the primitive backing [`resolveWorldInfoForMessages`](/development/extension-api/presets-and-prompts#resolveworldinfoformessages); call it directly only when you need finer control over scan inputs.

| Parameter | Description |
|------|------|
| `coreChat` | Message list (`{ name, mes, is_user, is_system }`) used as scan source |
| `maxContext` | Token budget; falls back to `getMaxPromptTokens()` when omitted or `<= 0` |
| `dryRun` | If `true`, suppress `WORLD_INFO_ACTIVATED` event |
| `type` | Generation trigger label (`'normal'`, `'quiet'`, `'regenerate'`, etc.) |
| `chatForWI` | Pre-built scan input; skips `buildWorldInfoChatInput` when supplied |
| `includeNames` | Whether to prepend `name:` to each scan line |
| `globalScanData` | Override for character-card-derived scan fields |

The returned object echoes `chatForWI`, `maxContext`, and `globalScanData` actually used, so callers can inspect the resolved scan inputs.

### buildWorldInfoChatInput

```ts
buildWorldInfoChatInput(messages: ChatMessage[], includeNames?: boolean): string[]
```

Builds the **reversed** array of scan strings the WI scanner expects. Each line is `"name: mes"` when `includeNames`, otherwise just `mes`. Useful when you want to feed `simulateWorldInfoActivation` a pre-formatted slice.

### buildWorldInfoGlobalScanData

```ts
buildWorldInfoGlobalScanData(type: string, overrides?: Partial<WIGlobalScanData>): WIGlobalScanData
```

Builds the character-card-derived scan fields (`personaDescription`, `characterDescription`, `characterPersonality`, `characterDepthPrompt`, `scenario`, `creatorNotes`, `trigger`) for the current character. Pass `overrides` to substitute individual fields without rebuilding the whole object.

### getActiveWorldInfoPromptFields

```ts
getActiveWorldInfoPromptFields(): {
    worldInfoBeforeEntries: string[],
    worldInfoAfterEntries: string[],
}
```

Returns the most recent World Info `before`/`after` fragments captured during the live generation pipeline. Returns empty arrays when no chat is active or the snapshot belongs to another chat. Use this when you want to read what was last injected without re-running a scan.

## Character Auxiliary World Books

Character cards can declare auxiliary World Info bindings beyond the primary `world` field — for example, a CardApp may bind extra reference books for in-character tools.

### getCharaAuxWorlds

```ts
getCharaAuxWorlds(charaFilename: string): string[]
```

Returns the deduped list of auxiliary World Info names bound to a character. Resolution rules:

- During character creation (`menu_type === 'create'`), reads from the in-flight new-character buffer.
- Otherwise reads from the persisted `world_info.charLore` entry matching `charaFilename`.

Returns `[]` when `charaFilename` is falsy or no binding exists. Pair with [`getCharaFilename`](/development/extension-api/characters#getcharafilename) to resolve the current character:

```js
const ctx = Luker.getContext();
const auxBooks = ctx.getCharaAuxWorlds(ctx.getCharaFilename());
const datas = await ctx.loadWorldInfoBatch(auxBooks);
```

## Format Conversion

### convertCharacterBook

```ts
convertCharacterBook(characterBook: V2CharacterBook): {
    entries: Record<number, WIEntry>,
    originalData: V2CharacterBook,
}
```

Converts a V2 character-card `character_book` payload into the internal World Info shape. Used when importing character cards or projecting V2 lore into editable entries. `originalData` is preserved for round-trip serialization.

## Entry-Level Helpers

For programmatic entry creation and UI synchronization. All exposed under `context.worldInfoEntry`.

### worldInfoEntry.template

```ts
context.worldInfoEntry.template: WIEntry
```

The canonical default entry shape (`uid: 0` placeholder, empty keys, `position: 0`, etc.). Clone-and-modify when constructing entries in bulk, so future additions to the entry schema flow through automatically.

```js
const ctx = Luker.getContext();
const fresh = { ...ctx.worldInfoEntry.template, uid: newUid, key: ['npc:Bob'], content: 'A baker.' };
```

### worldInfoEntry.create

```ts
context.worldInfoEntry.create(name: string, data: WorldInfoData): WIEntry
```

Creates and inserts a new entry into the supplied World Info `data` object, returning the inserted entry. Allocates the next free `uid`, fills defaults, and mutates `data.entries` in place. Persist with `saveWorldInfo()` afterwards.

### worldInfoEntry.delete

```ts
context.worldInfoEntry.delete(data: WorldInfoData, uid: number, options?: { silent?: boolean }): Promise<boolean>
```

Removes the entry with the given `uid` from `data.entries` and returns whether the deletion succeeded. Pass `silent: true` to skip the user-facing confirmation toast — useful for bulk programmatic edits. Persist via `saveWorldInfo()` afterwards.

### worldInfoEntry.setButtonClass

```ts
context.worldInfoEntry.setButtonClass(chid: number | string, forceValue?: boolean): void
```

Updates the "world info bound" pill class on the character card UI. Pass `forceValue` to override the computed binding state. Call after programmatic binding changes (e.g., after `charUpdatePrimaryWorld`).

### worldInfoEntry.setGlobalSelection

```ts
context.worldInfoEntry.setGlobalSelection(
    worldInfoName: string,
    selected: boolean,
    options?: object,
): Promise<void>
```

Adds or removes a world book from the global activation list (i.e. the multi-select shown at the top of the World Info panel). Persists immediately; UI re-renders on the next selector refresh.

## Chat-Bound World Info

Per-chat world-book bindings live in `chat_metadata.world_info` and travel with the chat. Use `context.chatWorldInfo` to inspect and mutate them.

### chatWorldInfo.getNames

```ts
context.chatWorldInfo.getNames(
    metadata?: object,
    options?: { resolveNames?: boolean, onlyExisting?: boolean },
): string[]
```

Returns the list of world-book names bound to the chat. Defaults to the current chat's metadata. `resolveNames: true` (default) maps any uid-style entries back to file names; `onlyExisting: true` (default) drops names whose file no longer exists.

### chatWorldInfo.setSelection

```ts
context.chatWorldInfo.setSelection(names: string[], metadata?: object): boolean
```

Replaces the chat-bound world-book selection with `names`. Mutates the metadata in place and returns whether the selection actually changed. Callers persist via `saveMetadata()` / `saveMetadataDebounced()`.

### chatWorldInfo.globalSelection

```ts
context.chatWorldInfo.globalSelection: string[]
```

Live read-only snapshot of the user's globally-activated world books (the books active on every chat). Mutate via `worldInfoEntry.setGlobalSelection` — direct writes are not persisted.

## Position Constants

### context.constants.wiAnchor

```ts
context.constants.wiAnchor: { before, after }
```

Numeric enum for the anchor side of an example-dialogue entry. Use when constructing or comparing `worldInfoExamples[i].position`.

### context.constants.wiPosition

```ts
context.constants.wiPosition: {
    before, after, ANTop, ANBottom, atDepth, EMTop, EMBottom, outlet,
}
```

Numeric enum for entry-level `position` values. Use when constructing entries or filtering by injection slot.

```js
const ctx = Luker.getContext();
const entry = {
    ...ctx.worldInfoEntry.template,
    position: ctx.constants.wiPosition.before,
};
```

## Practical Patterns

### Plugin reads + edits a lorebook

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

### Plugin scans WI without affecting the main chat

```js
const wi = await ctx.simulateWorldInfoActivation({
    coreChat: [
        { name: 'User', mes: 'Tell me about the tavernkeeper.', is_user: true },
    ],
    dryRun: true,
});

console.log(wi.worldInfoBeforeEntries);
```

For higher-level usage that produces a result you can pass to `buildPresetAwarePromptMessages`, use [`resolveWorldInfoForMessages`](/development/extension-api/presets-and-prompts#resolveworldinfoformessages) instead.
