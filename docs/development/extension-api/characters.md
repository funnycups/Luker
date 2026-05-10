# Characters

APIs for reading character cards, modifying card fields, importing characters, and managing tags. The `context.characters` array is wrapped in a Proxy with specific read/write semantics — see [Proxy semantics](#proxy-semantics) below.

## Reading Characters

### context.characters

```ts
context.characters: Character[]
```

Array of all loaded character objects. Wrapped in a Proxy that supports both V2 (`character.data.*`) and legacy root-level field access — see [Proxy semantics](#proxy-semantics).

### context.characterId

```ts
context.characterId: number | undefined
```

Index into `context.characters` for the currently selected character. `undefined` when no character is selected (e.g., during a group chat).

### getOneCharacter

```ts
getOneCharacter(avatarUrl: string): Promise<void>
```

Re-fetches a single character from the server and replaces its slot in `context.characters` (matched by `avatar` field). Useful after server-side mutations to refresh in-memory state.

### getCharacters

```ts
getCharacters(): Promise<void>
```

Re-fetches the full character list. Triggers UI re-render. Surfaces a warning toast if the server reports an oversized payload.

### getOneCharacter vs getCharacters

| Use | When |
|------|------|
| `getOneCharacter(avatar)` | A specific card was modified server-side; refresh just that one |
| `getCharacters()` | Bulk import / delete happened; refresh everything |

### getCharacterCardFields

```ts
getCharacterCardFields(options?: { chid?: number }): {
    system: string,
    mesExamples: string,
    description: string,
    personality: string,
    persona: string,
    scenario: string,
    jailbreak: string,
    version: string,
    charDepthPrompt: string,
    creatorNotes: string,
    firstMessage: string,
    alternateGreetings: string[],
}
```

Returns the resolved card fields after macro substitution and persona injection. Defaults to the current character when `chid` is omitted. Use this in place of reading `character.data.*` directly when you need fields prepared for prompt assembly.

### getCharacterSource

```ts
getCharacterSource(chId?: number | string): string
```

Returns the canonical source URL (chub, pygmalion, github, perchance, risuai, or `data.extensions.source_url`) for a card. Returns `''` when no source metadata is present.

### getCharaFilename

```ts
getCharaFilename(
    chid?: number | string | null,
    options?: { manualAvatarKey?: string },
): string | null
```

Returns the avatar filename **without extension** for a character. Falls back to the current character when `chid` is omitted. Pass `manualAvatarKey` when you only have the avatar key string (e.g. from a sidecar entry). Returns `null` if no avatar can be resolved.

```js
const ctx = Luker.getContext();
const filename = ctx.getCharaFilename();  // e.g. 'tavernkeeper'
```

### getThumbnailUrl

```ts
getThumbnailUrl(type: string, file: string, t?: boolean): string
```

Builds the thumbnail endpoint URL for an avatar/background/world. Pass `t: true` to append a cache-busting timestamp.

## Selecting & Loading Characters

### selectCharacterById

```ts
selectCharacterById(id: number, options?: { switchMenu?: boolean }): Promise<void>
```

Switches the active character. Bails silently when:
- The character doesn't exist
- A chat save is currently in progress (a toast is shown)

`switchMenu` defaults to `true` and opens the character edit panel when re-selecting the same character.

### unshallowCharacter

```ts
unshallowCharacter(characterId: number | string): Promise<void>
```

Loads the full record for a character that was returned in shallow form (only avatar + basic metadata). No-op when the character is already fully loaded. Always call before reading large fields like `description` or `mes_example` if you obtained the character from a list endpoint.

### unshallowGroupMembers

```ts
unshallowGroupMembers(groupId: string): Promise<void>
```

Bulk variant for groups — calls `unshallowCharacter` on every member of the group.

## Writing Card Fields

### writeExtensionField

```ts
writeExtensionField(
    characterId: number | string,
    key: string,
    value: any,
): Promise<void>
```

Writes `data.extensions[key]` on a character card and persists. Pass `value: context.constants.unset` (the `UNSET_VALUE` sentinel) to delete the key. This is the **safe path** for plugin extension fields — it bypasses the `context.characters` Proxy entirely.

```js
const ctx = Luker.getContext();
await ctx.writeExtensionField(ctx.characterId, 'my_plugin_state', { level: 5 });
// Delete:
await ctx.writeExtensionField(ctx.characterId, 'my_plugin_state', ctx.constants.unset);
```

### writeExtensionFieldBulk

```ts
writeExtensionFieldBulk(
    avatars: string[] | null,
    key: string,
    value: any,
    options?: { filterPath?: string },
): Promise<{ updated: string[], skipped: string[], failed: string[] }>
```

Single batched write across many characters. `avatars: null` or `[]` targets every character. When `value` is the `unset` sentinel and no `filterPath` is supplied, automatically defaults `filterPath` to `data.extensions.<key>` so cards without that field are skipped.

### createCharacterData

```ts
context.createCharacterData: NewCharacterDraft
```

Live mutable buffer holding the in-progress "Create New Character" form. Read or mutate this directly while `context.menuType === 'create'` — for example, [`getCharaAuxWorlds`](/development/extension-api/world-info#getcharaauxworlds) reads `extra_books` from here.

## Tags

### context.tags

```ts
context.tags: Tag[]
```

Master list of all tag definitions: `{ id, name, folder?, color?, color2?, create_date }`.

### context.tagMap

```ts
context.tagMap: Record<string, string[] | null>
```

Maps each character avatar (or group id) to its assigned tag ids.

### importTags

```ts
importTags(
    character: Character,
    options?: { importSetting?: TagImportSetting | null },
): Promise<boolean>
```

Imports the character's declared tags (`character.tags[]`) into the master tag list and assigns them. Caps imports at 50 tags per character to guard against troll cards. Returns `true` when at least one tag was actually added.

## Import / Export

### importFromExternalUrl

```ts
importFromExternalUrl(
    url: string,
    options?: { preserveFileName?: string | null },
): Promise<void>
```

Imports a character or lorebook from an external URL or content UUID. The server inspects the response `Content-Type` and routes to the appropriate import path:

- `'character'` → drops into `processDroppedFiles`
- `'lorebook'` → drops into `importWorldInfo`
- otherwise → unknown-type toast

`preserveFileName` overrides the response filename in the dispatch step.

## Per-Character Sidecar State

For data that should follow a character across chats but **not** modify the card JSON, use the per-character sidecar state. This is distinct from extension fields ([`writeExtensionField`](#writeextensionfield)) which are persisted inside the card itself.

### getCharacterState

```ts
getCharacterState(avatar: string, namespace: string): Promise<any | null>
```

Reads sidecar state for the given character avatar and namespace. Returns `null` when no data exists.

### setCharacterState

```ts
setCharacterState(avatar: string, namespace: string, data: any): Promise<void>
```

Writes sidecar state. Pass `data: null` to delete the sidecar entry for that namespace.

```js
const ctx = Luker.getContext();
const character = ctx.characters[ctx.characterId];

await ctx.setCharacterState(character.avatar, 'my-plugin', {
    initialized: true,
    counter: 1,
});

const state = await ctx.getCharacterState(character.avatar, 'my-plugin');
```

::: tip Sidecar vs Extension Field
- Extension field (`writeExtensionField` → `data.extensions.<key>`) is part of the card. It exports with the card and is visible to anyone who has the card.
- Sidecar (`get/setCharacterState`) is a separate file kept next to the card. It does not export with the card.
:::

## Proxy Semantics

`context.characters` is a Proxy that smooths over the V2 character format (where text fields live under `character.data.*`) and the legacy root-level shape (`character.name`, `character.description`, etc.). Understanding it is important because reads behave differently from writes.

### Reading

You can read either path — the Proxy resolves to whichever has data:

```js
const character = ctx.characters[ctx.characterId];

character.name              // OK — falls through to data.name when present
character.data.name         // OK — direct V2 access
character.data.extensions.foo  // OK — also proxied
```

`Object.keys()`, `for...in`, and spreads also see the legacy keys, so existing code that does `{ ...character }` keeps working.

### Writing

Writing the legacy root fields **works**, but emits a deprecation warning + a one-time toast:

```js
character.name = 'Bob';        // Warns; mirrors to data.name and triggers toast
character.data.name = 'Bob';   // Recommended; no warning
```

The deprecation surface covers exactly:

| Legacy field | Canonical path |
|------|------|
| `name` | `data.name` |
| `description` | `data.description` |
| `personality` | `data.personality` |
| `scenario` | `data.scenario` |
| `first_mes` | `data.first_mes` |
| `mes_example` | `data.mes_example` |
| `creatorcomment` | `data.creator_notes` |
| `tags` | `data.tags` |
| `talkativeness` | `data.extensions.talkativeness` |
| `fav` | `data.extensions.fav` |

### Mirroring Rules

Writes through the canonical path automatically mirror back to the legacy field, and vice versa:

```js
character.data.name = 'Alice';
character.name === 'Alice';         // true — automatic mirror

character.data.extensions.fav = true;
character.fav === true;             // true — automatic mirror
```

Field normalization is applied during writes:
- Text fields → coerced to string
- `tags` → array of trimmed non-empty strings (also accepts comma-separated strings)
- `talkativeness` → finite number, defaulting to `0.5` for non-numeric input
- `fav` → boolean, with string `'true'`/`'false'` recognized

### writeExtensionField bypasses the Proxy

`writeExtensionField` writes through the underlying live `characters` reference, so it never triggers the deprecation toast even when targeting the legacy fields. Prefer it for any persistent extension data.

### Practical takeaways

- Reading any field, root or nested — fine.
- Writing any field — works. Use `data.*` paths to silence the deprecation warning.
- Plugin extension data — always go through `writeExtensionField` / `writeExtensionFieldBulk`.
