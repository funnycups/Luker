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

Returns the avatar filename **without extension** for a character. Falls back to the current character when `chid` is omitted. Pass `manualAvatarKey` when you only have the avatar key string (e.g. from a state entry). Returns `null` if no avatar can be resolved.

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

Writes `data.extensions[key]` on a character card and persists.

**Replace semantics.** The full `value` becomes the new `data.extensions[key]` on disk. Sibling subkeys present in the previous on-disk value are **not** preserved — callers wanting a partial update must read the previous value, spread it, and overlay changes themselves. Other extension keys under `data.extensions.*` (other plugins' data) are never touched.

Pass `value: context.constants.unset` (the `UNSET_VALUE` sentinel) to delete the key entirely. Plain `null` writes a literal `null` (the key remains).

```js
const ctx = Luker.getContext();

// Replace data.extensions.my_plugin_state with exactly { level: 5 }.
// Any other keys previously under my_plugin_state are wiped.
await ctx.writeExtensionField(ctx.characterId, 'my_plugin_state', { level: 5 });

// Partial update: read previous, overlay, write back.
const prev = ctx.characters[ctx.characterId]?.data?.extensions?.my_plugin_state ?? {};
await ctx.writeExtensionField(ctx.characterId, 'my_plugin_state', { ...prev, level: 5 });

// Delete the key entirely.
await ctx.writeExtensionField(ctx.characterId, 'my_plugin_state', ctx.constants.unset);
```

This is the **safe path** for plugin extension fields — it bypasses the `context.characters` Proxy entirely.

### writeExtensionFieldBulk

```ts
writeExtensionFieldBulk(
    avatars: string[] | null,
    key: string,
    value: any,
    options?: { filterPath?: string },
): Promise<{ updated: string[], skipped: string[], failed: string[] }>
```

Single batched write across many characters, same replace semantics as `writeExtensionField` applied per card. `avatars: null` or `[]` targets every character. When `value` is the `unset` sentinel and no `filterPath` is supplied, automatically defaults `filterPath` to `data.extensions.<key>` so cards without that field are skipped.

### createCharacterData

```ts
context.createCharacterData: NewCharacterDraft
```

Live mutable buffer holding the in-progress "Create New Character" form. Read or mutate this directly while `context.menuType === 'create'` — for example, [`getCharaAuxWorlds`](/development/extension-api/world-info#getcharaauxworlds) reads `extra_books` from here.

### updateCharacterData

```ts
updateCharacterData(
    charId: number | string,
    patch: Record<string, any>,
    options?: { persist?: boolean, immediate?: boolean }
): Promise<void>
```

Update one or more **form-level** fields on a character's `data` object without requiring the character editor popup to be open. The patch shape is dot-paths into `character.data` for form-level fields (`description`, `name`, `personality`, ...). Intermediate objects are auto-created.

```js
const ctx = Luker.getContext();
// Update a top-level field
await ctx.updateCharacterData(ctx.characterId, { description: 'A new description.' });
```

**Restriction:** dot-paths starting with `extensions.` (or the bare key `extensions`) are **rejected** — use `writeExtensionField` for extension data, which has the correct replace semantics for plugin blobs.

```js
// Throws — use writeExtensionField instead.
await ctx.updateCharacterData(ctx.characterId, { 'extensions.world': 'my_book' });
```

Companion to the existing `saveCharacterDebounced` / form path — that route is still used when the popup *is* open (the form is the source of truth in that mode). `updateCharacterData` is the data-driven alternative for AI tools, slash commands, and any other caller that may run while the editor is closed.

Emits [`event_types.CHARACTER_FIELDS_UPDATED`](#character_fields_updated-event) with `{ charId, keys }` after the in-memory write, so views (open popup, CardApp UI) can sync from canonical data.

| Option | Default | Meaning |
|---|---|---|
| `persist` | `true` | Schedule a save. Pass `false` for transient writes another caller will persist. |
| `immediate` | `false` | Persist now (await) instead of debouncing. Use when followup code needs the file already written. |

### persistCharacterData

```ts
persistCharacterData(charId: number | string): Promise<void>
```

Flush a character's current in-memory `data` to disk by serializing it into the multipart shape `/api/characters/edit` expects, and POSTing. The form is **not** consulted — only `characters[charId]`. The server deep-merges the payload with the existing on-disk JSON, which is the correct behavior for form-level fields (it preserves unknown extension data the form never touches).

Throws on HTTP failure. Extension data does **not** flow through here — it has its own `/api/characters/merge-attributes` path with replace semantics ([`writeExtensionField`](#writeextensionfield)).

Most callers should use `updateCharacterData` (which schedules this for you). Call directly only when you've already mutated the in-memory object yourself and want to flush.

### persistCharacterDataDebounced

```ts
persistCharacterDataDebounced(charId: number | string): void
```

Schedule a debounced `persistCharacterData(charId)` call (per-character — concurrent writes to different cards don't coalesce into a single wrong-target save). Subsequent calls within the debounce window are coalesced.

### `character_fields_updated` event

Fires after `updateCharacterData` mutates `characters[charId].data` and before persistence completes. Listeners receive `{ charId, keys }` where `keys` is the dotted-path array from the patch. Use this to sync views (popup form, CardApp panels) without polling.

```js
const ctx = Luker.getContext();
ctx.eventSource.on(ctx.eventTypes.CHARACTER_FIELDS_UPDATED, ({ charId, keys }) => {
    if (charId === ctx.characterId && keys.includes('description')) {
        // refresh your UI from characters[charId].data.description
    }
});
```

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

## Per-Character State

For data that should follow a character across chats but **not** modify the card JSON, use the per-character state file. This is distinct from extension fields ([`writeExtensionField`](#writeextensionfield)) which are persisted inside the card itself.

### getCharacterState

```ts
getCharacterState(avatar: string, namespace: string): Promise<any | null>
```

Reads state for the given character avatar and namespace. Returns `null` when no data exists.

### setCharacterState

```ts
setCharacterState(avatar: string, namespace: string, data: any): Promise<void>
```

Writes state. Pass `data: null` to delete the state for that namespace.

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
- Writing **form-level** fields — use `updateCharacterData` (or, when mutating `data.*` directly, follow up with `persistCharacterData`).
- Writing **extension data** — use `writeExtensionField` / `writeExtensionFieldBulk`. Replace semantics: the caller controls the full value of `data.extensions.<key>`; sibling subkeys are not preserved.
