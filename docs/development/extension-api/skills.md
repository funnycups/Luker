# Skills

`context.skills.*` is the JavaScript surface for installing, reading, editing, and packaging skills. Extensions reach for it through `Luker.getContext()`; CardApps reach for the same shape on their `ctx.skills`.

Skills are the [knowledge packs](/features/skills/) the orchestrator uses; this API is the read/write transport that backs the skill manager subpanel, the inline editor, and the iter-studio's 17 skill tools.

::: tip Read the user-facing docs first
For the conceptual model — scopes, visibility policy, embed lifecycle — start at [Skills overview](/features/skills/). This page is the API reference.
:::

## Accessing the API

```js
const context = Luker.getContext();
const skills = context.skills;

// Or from a CardApp ctx (same shape):
async function init(ctx) {
  await ctx.skills.list({ scope: 'all' });
}
```

The CardApp ctx surface is a thin wrapper around the same underlying functions — call signatures and return shapes are identical (per Luker's [API parity convention](https://github.com/funnycups/Luker/blob/release/CLAUDE.md)).

## Scope shapes

Every skill operation takes a `scope`. Three shapes:

```ts
type SkillScope =
  | { kind: 'global' }
  | { kind: 'preset',    apiId: string, name: string }
  | { kind: 'character', characterFile: string }
```

For `list()`, you can also pass the literal string `'all'` to fetch from every scope at once.

## Inventory

### `list(opts?)`

List installed skill index entries (no content).

```ts
list(opts?: {
  scope?: SkillScope | 'all'
}): Promise<SkillIndexEntry[]>
```

`SkillIndexEntry`:

| Field | Type | Description |
|---|---|---|
| `scope` | `SkillScope` | Where this skill physically lives. |
| `name` | `string` | Frontmatter `name`. |
| `description` | `string` | Frontmatter `description`. |
| `license` | `string \| null` | Frontmatter `license` if present. |
| `metadata` | `object` | Free-form Anthropic-standard metadata. |
| `installedHash` | `string` | sha256 of the full file tree. Stable across read; changes on every write. |
| `fileCount` | `number` | Total files in the skill directory. |
| `totalBytes` | `number` | Sum of file sizes. |
| `hasScripts` | `boolean` | True if the skill ships a `scripts/` directory. |
| `hasBinary` | `boolean` | True if any file looks binary (null bytes in first 512 B). |
| `installedAt` | `string` | ISO timestamp of the directory's mtime. |

Example:

```js
const all = await context.skills.list({ scope: 'all' });
console.log(all.map(s => `${s.scope.kind}:${s.name}`));

const globalOnly = await context.skills.list({ scope: { kind: 'global' } });
```

### `get(name, scope?)`

Convenience: find a single entry by name (within a scope, or anywhere).

```ts
get(name: string, scope?: SkillScope | 'all'): Promise<SkillIndexEntry | null>
```

Returns `null` if no skill of that name exists in the searched scope.

When `scope` is omitted, returns the first match — useful as a "does this skill exist somewhere" check, but not a substitute for the orchestrator's later-wins resolution. Pass a specific scope when you need a deterministic lookup.

## Reading content

### `readFile(opts)`

Read a single file inside a skill.

```ts
readFile(opts: {
  scope: SkillScope,
  name: string,
  path?: string,        // default 'SKILL.md'
  offset?: number,      // 1-based line offset
  limit?: number,       // line count
}): Promise<{
  content: string,
  totalLines: number,
  truncated: boolean,
}>
```

- `path` defaults to `SKILL.md`. Pass a sub-path like `references/checklist.md` to read other files.
- `offset` and `limit` operate on lines (1-based).
- Server enforces a 50 KB response cap. If the response is capped, `truncated: true` — re-call with `offset` to continue.

### `listFiles(opts)`

Enumerate every file in a skill with size and binary-flag metadata.

```ts
listFiles(opts: {
  scope: SkillScope,
  name: string,
}): Promise<{
  files: Array<{
    path: string,
    size: number,
    isBinary: boolean,
  }>
}>
```

`SKILL.md` is always first; the rest follow `localeCompare` order. Use this before `readFile` if you don't know what's in the skill.

### `search(opts)`

Substring search inside a single skill's files.

```ts
search(opts: {
  scope: SkillScope,
  name: string,
  query: string,
  path?: string,        // optional file scope; default all text files
  limit?: number,
  contextLines?: number,
}): Promise<{
  hits: Array<{
    path: string,
    lineStart: number,
    lineEnd: number,
    snippet: string,
  }>
}>
```

Search is case-insensitive substring (not regex). Binary files are skipped.

## Writing content

All writes go through a `.staging/` directory on disk and atomic-commit only on full validation. Failed writes leave the original untouched.

### `writeFile(opts)`

Replace an entire file.

```ts
writeFile(opts: {
  scope: SkillScope,
  name: string,
  path: string,
  content: string,
  expectedSha256?: string,  // optimistic concurrency
}): Promise<{ sha256: string }>
```

If `expectedSha256` is supplied and doesn't match the current file's hash, the write fails with a `409` conflict — useful for editor-style concurrent-edit detection.

The returned `sha256` is the new file's content hash.

### `editFile(opts)`

In-place string replacement. Cheaper than `writeFile` when you only want to change one section.

```ts
editFile(opts: {
  scope: SkillScope,
  name: string,
  path: string,
  oldString: string,
  newString: string,
  replaceAll?: boolean,  // default false
}): Promise<{
  sha256: string,
  changesApplied: number,
}>
```

- `oldString` must appear in the file (or the call throws). With `replaceAll: false`, `oldString` must appear **exactly once**.
- `oldString` must be non-empty (the server rejects empty `oldString` to prevent ambiguous matches).
- Returned `changesApplied` is 1 (or the match count when `replaceAll: true`).

### `deleteFile(opts)`

Delete a single file inside a skill. `SKILL.md` cannot be deleted via this route — use `delete(scope, name)` to remove the whole skill.

```ts
deleteFile(opts: {
  scope: SkillScope,
  name: string,
  path: string,
}): Promise<void>
```

## Management

### `install(opts)`

Install a skill from a JSON payload (inline files) or an archive.

```ts
install(opts: {
  scope: SkillScope,
  payload: SkillInstallPayload,
  conflictStrategy?: 'skip' | 'replace',  // default: throws on conflict
}): Promise<{
  installed: boolean,
  conflict?: 'same' | 'different',
  name: string,
}>
```

`SkillInstallPayload` is one of:

```ts
// Inline files (preferred for text-only skills, ≤ 10 files, ≤ 64 KB each)
{
  bundleFormat: 'inline-files-v1',
  name: string,
  files: Array<{ path: string, encoding: 'utf8' | 'base64', content: string }>
}

// Base64-encoded zip (any size up to per-skill limit)
{
  bundleFormat: 'archive-base64-v1',
  name: string,
  fileName: string,
  contentBase64: string,
  sha256: string,
}
```

If a same-named skill exists in the target scope:

- Same content (hash matches) → silently no-op.
- Different content → throws unless `conflictStrategy: 'replace'`. Use `'skip'` to no-op on conflict.

### `delete(scope, name)`

```ts
delete(scope: SkillScope, name: string): Promise<void>
```

Removes the skill directory atomically. Orchestrator profiles that referenced the skill keep their (now-stale) name in `skills.visible` — references soft-fail at dispatch.

### `rename(scope, oldName, newName)`

```ts
rename(scope: SkillScope, oldName: string, newName: string): Promise<void>
```

Atomically renames the directory and the frontmatter `name`. References don't auto-update.

### `moveScope(name, fromScope, toScope)`

```ts
moveScope(
  name: string,
  fromScope: SkillScope,
  toScope: SkillScope,
): Promise<void>
```

Atomic filesystem move across scopes. Orchestrator references (which use name only) stay valid. Use `'replace'` semantics by deleting the destination-scope skill first if you want to overwrite.

### `importBundled()`

Re-install all bundled skills from `default/skills/global/`, overwriting any same-named local copies.

```ts
importBundled(): Promise<{
  installed: number,   // total bundled skills processed
  replaced: number,    // existed locally, overwritten
  added: number,       // didn't exist locally, added
}>
```

::: warning Destructive
This is `git reset --hard` for skills — it overwrites every same-named global skill with the bundled version. Save local edits first.
:::

### `listBundledManifest()`

List the bundled skills shipped under `default/skills/global/`, each with the install hash they'd produce on import. Used by the **Browse bundled** tab to compare against local installations without re-running install.

```ts
listBundledManifest(): Promise<Array<{
  name: string,
  installedHash: string,
  fileCount: number,
  totalBytes: number,
  description: string,
}>>
```

## Transport

These functions support cross-host skill distribution via character cards and presets.

### `packForEmbed(opts)`

Pack one or more skills into an embed payload suitable for sticking into a preset or character card.

```ts
packForEmbed(opts: {
  scope: SkillScope,
  names: string[],
  mode?: 'inline-files-v1' | 'archive-base64-v1' | 'auto',  // default 'auto'
}): Promise<EmbeddedPayload>
```

`EmbeddedPayload`:

```ts
{
  version: 1,
  items: Array<SkillInstallPayload>
}
```

With `mode: 'auto'`, the packer picks per skill: inline for small text-only skills, archive for larger/binary skills.

The orchestrator's embed export hooks write the payload into `preset.extensions.luker.embedded_skills_source` (presets) or `character.data.extensions.luker.embedded_skills_source` (character cards) at save time.

### `previewExtractEmbed(opts)`

Preview the conflict outcome of extracting an embed payload into a target scope. Read-only — no filesystem changes.

```ts
previewExtractEmbed(opts: {
  payload: EmbeddedPayload,
  targetScope: SkillScope,
}): Promise<{
  items: Array<{
    name: string,
    conflict: 'new' | 'same' | 'different',
  }>
}>
```

The skill manager's import dialog uses this to render the per-skill skip/replace choice.

### `executeExtractEmbed(opts)`

Execute extraction using per-skill conflict resolutions.

```ts
executeExtractEmbed(opts: {
  payload: EmbeddedPayload,
  targetScope: SkillScope,
  conflictStrategies?: Record<string, 'skip' | 'replace'>,
}): Promise<{
  installed: string[],   // names installed
  skipped: string[],     // names skipped (per conflictStrategies or 'same')
  failed: Array<{ name: string, error: string }>,
}>
```

`conflictStrategies` is keyed by skill name; missing entries default to throwing on `'different'`. `'same'` entries are always silently no-op.

### `importFromUrl(opts)`

Fetch a single `SKILL.md` from an HTTPS URL and install as a single-file skill.

```ts
importFromUrl(opts: {
  url: string,         // must be https://
  targetScope: SkillScope,
}): Promise<{
  name: string,
  conflict: 'new' | 'same' | 'different',
}>
```

Multi-file skills can't be imported via URL — use `install()` with an `archive-base64-v1` payload (or the skill manager's **Import from file** flow).

## Error handling

All methods throw on server errors. The thrown `Error` carries:

| Property | Type | Description |
|---|---|---|
| `.message` | `string` | Server error message. |
| `.status` | `number` | HTTP status (e.g. `404`, `409`, `400`). |
| `.body` | `object` | Parsed response body (often `{ error, code, ... }`). |

Common shapes:

```js
try {
  await context.skills.editFile({ ... });
} catch (err) {
  if (err.status === 409) {
    // SHA mismatch — file changed underneath us. Reload and retry.
  } else if (err.status === 404) {
    // Skill or file not found.
  } else {
    throw err;
  }
}
```

## CardApp parity

The CardApp `ctx.skills` surface mirrors `context.skills.*` 1:1 — identical signatures, identical return shapes. CardApps can therefore use the same patterns:

```js
async function init(ctx) {
  // List skills visible to anyone (CardApps don't see the orchestrator's
  // per-agent visibility filtering — they see the raw inventory).
  const skills = await ctx.skills.list({ scope: 'all' });

  // Read a skill body
  const { content } = await ctx.skills.readFile({
    scope: { kind: 'character', characterFile: ctx.characterFile },
    name: 'card-voice-rules',
  });

  ctx.setVariable('voice_rules', content);
}
```

The `ctx.skills` wrapper is intentionally thin — never richer than `getContext().skills`. New API additions land in both places at the same time.

## Related

- [Skills overview](/features/skills/) — what a skill is, three scopes
- [Authoring skills](/features/skills/authoring) — frontmatter + body conventions
- [Skill management](/features/skills/management) — UI surface for the same operations
- [Orchestrator integration](/features/skills/orchestrator-integration) — how the runtime filters by `skills.visible` / `deny`
- [Extension API overview](/development/extension-api/) — other namespaces on `context.*`
