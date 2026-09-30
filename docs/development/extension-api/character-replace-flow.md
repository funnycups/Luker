# The Character Card Replace Flow

When a user replaces a character card (**Replace / Update** in the character management menu), the incoming file overwrites the previous card PNG. Chats, assets, and group memberships survive, but everything the old card carried inside `data.extensions.*` — and the card's world-book state — needs reconciliation. Core owns that reconciliation through two registries that run in order, before the `CHARACTER_REPLACED` event is emitted:

1. **Card binding preservation** — a slot registry that silently writes back local bindings the new card lacks, and asks about conflicting ones.
2. **Post-replace world book actions** — an action registry that decides what happens to the world book: import the new card's embedded book, keep the previously bound book, or run a plugin-registered action.

Both registries share the same shape: owners register descriptors from their extension init, core never hard-codes plugin semantics, and a disabled plugin simply never registers — its protection/action disappears, while core's own keep working.

## Flow order

```text
Replace / Update (file or URL)
  → new card imported verbatim over the same avatar
  → card binding preservation engine          (slot registry)
  → post-replace world book popup             (action registry)
  → CHARACTER_REPLACED emitted
```

Both steps run inside `emitCharacterReplacedEvent` before any listener is notified, so writes land before plugins react to the event. The world book step is awaited: an action that opens a long-lived UI (such as the Character Editor Assistant's merge studio) delays the event until that UI closes, and listeners then observe a settled state — either the new book bound, or the previous book restored by rollback.

## Part 1 — Card binding preservation

Without protection, every local binding stored in `data.extensions.*` — bound chat completion presets, dedicated personas, orchestration card presets, Memory Graph overrides, CardApp enablement — would be lost with the old card. The slot registry protects them. For every registered slot the engine compares the previous card with the incoming one:

- **Local only** — the previous card had the binding and the new card does not. The engine writes the local value back silently.
- **Conflict** — both cards define the binding and the values differ. A popup lists every conflicting category and lets the user keep the local value or accept the new card's value, per category.
- **Equal** — the values are deep-equal. Nothing happens.
- **New card only** — the new card's own binding stays untouched (same as a plain import).

### Registering a slot

Owners register one descriptor per binding category from their extension init:

```js
const context = Luker.getContext();

context.registerCardBindingSlot({
    id: 'my-binding',
    label: () => context.translate('My binding'),
    read: character => readMyBinding(character),
    isPresent: value => Boolean(value),
    summarize: value => summarizeMyBinding(value),
    write: async (characterId, value) => {
        const previous = context.characters[characterId]?.data?.extensions?.my_namespace;
        await context.writeExtensionField(characterId, 'my_namespace', { ...previous, my_binding: value });
    },
});
```

| Field | Type | Description |
| --- | --- | --- |
| `id` | `string` | Unique, stable slot id. Letters, digits, `_` and `-` only; must start with a letter. Re-registering the same id logs a warning and replaces the previous descriptor. |
| `label` | `() => string` | User-visible category name, translated by the owner. |
| `read` | `(character) => value \| null` | Pure read from a character object. Must not schedule writes or migrations. |
| `isPresent` | `(value) => boolean` | Whether the value counts as configured by the user. |
| `summarize` | `(value) => string` | One-line summary for this side of the conflict popup. |
| `write` | `async (characterId, value) => void` | Writes the value back. `characterId` is the index into `context.characters`. |

`registerCardBindingSlot` throws when the descriptor is missing a required function, so mistakes surface at load time instead of during a replacement.

### Write responsibility

`write` receives only the value produced by `read`. It is the owner's job to:

- resolve the character via `context.characters[characterId]`;
- merge sibling keys — `context.writeExtensionField` replaces the whole namespace value, so read the current blob and spread it before overlaying the preserved key;
- throw on failure. The engine toasts the failure and continues with the remaining slots; it never blocks the replacement.

### Disabled plugins

Slots are registered from extension init. A disabled or unloaded plugin never registers its slot, so its card binding is not preserved during a replacement. This is intentional: the engine does not hard-code plugin field semantics. Core bindings (bound presets, dedicated personas) are always protected.

When a bound preset was preserved, the engine also re-runs the character-bound preset application so the current chat adopts the kept default.

## Part 2 — Post-replace world book actions

After binding preservation, core runs a decision step: if at least one action is available for this replacement, a popup asks the user what should happen to the card's world book. Core registers two actions — **Import new book** (save the new card's embedded world book as a standalone file and bind it) and **Keep old book** (re-bind the previously bound primary book). Extensions can register additional actions.

### Registering an action

```js
const ctx = Luker.getContext();

ctx.registerPostReplaceAction({
    id: 'my-action',
    label: () => ctx.translate('My action'),
    description: (detail) => ctx.translate('What this action does.'),
    isAvailable: (detail) => detail.hasNewEmbeddedBook,
    run: async (detail) => { /* do the work */ },
});
```

| Field | Type | Contract |
| ----- | ---- | -------- |
| `id` | string | Unique and stable. Letters, digits, `_` and `-` only; must start with a letter. Invalid ids, missing fields, and non-object descriptors throw a `TypeError`. Registering a duplicate id logs a warning and replaces the previous descriptor, keeping its position in the list. |
| `label()` | function → string | Button text. |
| `description(detail)` | function → string | One-line explanation rendered next to the label in the dialog body. |
| `isAvailable(detail)` | function → boolean | Whether this action is offered for this replacement. A throwing check logs a warning and skips the action. |
| `run(detail)` | async function | Executes the action. A throwing run logs a warning and shows an error toast; the replacement itself is never affected. |

Rules:

- Buttons follow registration order. The first available action is the popup default (solid button).
- The popup only appears when at least one action is available. There is no global toggle: a disabled plugin does not register, so its actions disappear, while core actions keep running.
- The popup shows at most 9 actions (the popup API's custom-button ceiling); extra actions are truncated with a console warning.
- A throwing `label()` falls back to the action id; a throwing `description()` logs a warning and renders an empty explanation. Cancelling the dialog runs no action and the replacement proceeds normally.

### The `detail` object

| Field | Description |
| ----- | ----------- |
| `characterId` | Index of the replaced character in `ctx.characters`. |
| `character` | The replaced, live character object. |
| `previousCharacter` | Clone of the card before the replacement, or `null`. |
| `previousLorebookSnapshot` | `{ avatar, characterName, bookName, entries, capturedAt }` captured from the previous primary book, or `null`. |
| `previousBookName` | Normalized name of the previous primary book (`''` when none). |
| `previousBookExists` | Whether that book still exists. |
| `hasNewEmbeddedBook` | Whether the new card carries a non-empty `data.character_book`. |
| `source` | Always `'replace_update'` today. |

### Context API

| Function | Description |
| -------- | ----------- |
| `registerCardBindingSlot(descriptor)` | Register a binding slot; see Part 1. |
| `listCardBindingSlots()` | Registered slot descriptors in registration order. |
| `registerPostReplaceAction(descriptor)` | Register an action; see Part 2. |
| `listPostReplaceActions()` | Registered action descriptors in registration order. |
| `importEmbeddedBookForCharacter(characterId)` | Save the character's embedded book as a standalone file and bind it as the primary book. Throws when the character or the import entry point is unavailable. |
| `rebindPreviousPrimaryBook(characterId, bookName)` | Bind an existing book as the character's primary world book. |
