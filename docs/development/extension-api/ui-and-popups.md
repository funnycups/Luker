# UI & Popups

APIs for showing dialogs, blocking the UI during long operations, rendering plugin templates, and formatting message content.

## Popups

### Popup class

```ts
new Popup(content: string | HTMLElement | JQuery, type: POPUP_TYPE, inputValue?: string, options?: PopupOptions): Popup
```

The full-control popup primitive. Use this when you need a result, custom buttons, or input controls.

| `PopupOptions` field | Description |
|------|------|
| `okButton` / `cancelButton` | Custom button text. Pass `false` to hide |
| `rows` | Input rows (INPUT type) |
| `placeholder` | Input placeholder |
| `tooltip` | Tooltip on the popup body |
| `wide` / `wider` / `large` | Size presets |
| `transparent` | Transparent background |
| `defaultResult` | Default `POPUP_RESULT` when escape-closed |
| `customButtons` | Array of `{ text, tooltip?, result?, classes?, icon?, action?, appendAtEnd? }` |
| `customInputs` | Array of `{ id, label, tooltip?, defaultState?, type?, rows?, min?, max?, step?, disabled? }` |
| `allowEscapeClose` | Allow Esc to dismiss |
| `onOpen(popup)` / `onClosing(popup)` / `onClose(popup)` | Lifecycle hooks |
| `cropAspect` / `cropImage` | CROP type configuration |

### Popup instance methods

| Method | Returns | Notes |
|------|------|------|
| `await popup.show()` | `Promise<string \| number \| boolean \| null>` | Append + display. Resolves with the result value |
| `await popup.complete(result)` | `Promise<void>` | Programmatic close. Returns `undefined` if `onClosing` cancelled |
| `popup.completeAffirmative()` | — | Shortcut for OK |
| `popup.completeNegative()` | — | Shortcut for Cancel |
| `popup.completeCancelled()` | — | Shortcut for Esc |

`popup.value` holds the input string for INPUT type; `popup.cropData` holds the data URL for CROP type.

### POPUP_TYPE

```ts
context.POPUP_TYPE: {
    TEXT: 1,        // content + buttons
    CONFIRM: 2,     // Yes / No focus
    INPUT: 3,       // text input, returns value
    DISPLAY: 4,     // content only, X-close
    CROP: 5,        // image crop, returns data URL
}
```

### POPUP_RESULT

```ts
context.POPUP_RESULT: {
    AFFIRMATIVE: 1,
    NEGATIVE: 0,
    CANCELLED: null,
    CUSTOM1: 1001,
    // ...
    CUSTOM9: 1009,
}
```

Custom buttons that omit a `result` field receive auto-assigned `CUSTOM1`–`CUSTOM9` values.

### callGenericPopup

```ts
callGenericPopup(
    content: string | HTMLElement | JQuery,
    type: POPUP_TYPE,
    inputValue?: string,
    popupOptions?: PopupOptions,
): Promise<POPUP_RESULT | string | boolean | null>
```

Function-style shortcut equivalent to `new Popup(...).show()`. Use this when you don't need to hold a reference to the popup instance.

```js
const ctx = Luker.getContext();

// Confirm
const result = await ctx.callGenericPopup(
    'Delete this conversation?',
    ctx.POPUP_TYPE.CONFIRM,
);
if (result === ctx.POPUP_RESULT.AFFIRMATIVE) {
    // ...
}

// Input
const userInput = await ctx.callGenericPopup(
    'Enter your name:',
    ctx.POPUP_TYPE.INPUT,
    'Anonymous',
    { rows: 1 },
);

// Display only
await ctx.callGenericPopup(
    '<h3>Done</h3><p>Plugin initialized.</p>',
    ctx.POPUP_TYPE.DISPLAY,
);
```

### callPopup (deprecated)

```ts
callPopup(text: string, type: string, ...): Promise<any>
```

Legacy popup helper using string-keyed types (`'text'`, `'confirm'`, `'input'`, etc.). Migrate to `callGenericPopup` with the numeric `POPUP_TYPE` values.

## Loader

### loader.show / loader.hide

```ts
loader.show(options?: ActionLoaderOptions): ActionLoaderHandle
loader.hide(handle?: ActionLoaderHandle): Promise<void>
```

Recommended API for blocking the UI during a long operation. `loader.show()` returns a handle; pass it back to `loader.hide(handle)` to dismiss specifically that loader. `loader.hide()` with no argument hides all loaders.

| `ActionLoaderOptions` field | Default | Description |
|------|------|------|
| `blocking` | `true` | Whether the overlay blocks input |
| `toastMode` | `'stoppable'` | `'none'` / `'static'` / `'stoppable'` |
| `slug` | `null` | Optional ID for handle lookup |
| `message` | `'Generating...'` | Text shown in the overlay |
| `title` | `''` | Optional title above the message |
| `stopTooltip` | `'Stop'` | Tooltip on the stop button |
| `overlayContent` | `null` | Custom DOM content |
| `onStop` | `null` | Called when user clicks Stop |
| `onHide` | `null` | Called when the loader is hidden |

```js
const ctx = Luker.getContext();

const handle = ctx.loader.show({
    message: 'Importing...',
    toastMode: 'stoppable',
    onStop: () => abortController.abort(),
});

try {
    await doImport();
} finally {
    await ctx.loader.hide(handle);
}
```

### loader namespace utilities

| Method | Description |
|------|------|
| `loader.active()` | All currently-active handles |
| `loader.get(id)` | Lookup a handle by id |
| `loader.isBlocking()` | Whether any blocking loader is active |
| `loader.ToastMode` | Enum of toast modes |
| `loader.Handle` | The `ActionLoaderHandle` class |
| `loader.createOverlay()` | Build a default overlay element |

### showLoader / hideLoader (deprecated)

Older entry points. Migrate to `loader.show` / `loader.hide`. The legacy `showLoader()` is now a thin wrapper that delegates to the modern API.

## Templates

### renderExtensionTemplateAsync

```ts
renderExtensionTemplateAsync(
    extensionName: string,
    templateId: string,
    templateData?: object,
    sanitize?: boolean,
    localize?: boolean,
): Promise<string>
```

Loads an HTML template from `scripts/extensions/${extensionName}/${templateId}.html` and returns the rendered HTML. Sanitization (DOMPurify) and localization (i18n auto-translation) are applied.

For a third-party extension at `scripts/extensions/third-party/MyExt/dialog.html`:

```js
const ctx = Luker.getContext();
const html = await ctx.renderExtensionTemplateAsync('third-party/MyExt', 'dialog', {
    title: 'Settings',
    items: ['a', 'b', 'c'],
});
const popup = new ctx.Popup(html, ctx.POPUP_TYPE.DISPLAY);
await popup.show();
```

### renderExtensionTemplate (deprecated)

Synchronous variant. Migrate to the async version — the underlying loader is async and the sync version blocks the event loop.

## Message Formatting

### messageFormatting

```ts
messageFormatting(
    mes: string,
    ch_name: string,
    isSystem: boolean,
    isUser: boolean,
    messageId: number,
    sanitizerOverrides?: object,
    isReasoning?: boolean,
): string
```

Returns the rendered HTML for a message, applying:
- Markdown rendering
- Custom CSS class injection
- Code syntax highlighting
- Macro substitution
- Regex pipeline (with placement `AI_OUTPUT` / `USER_INPUT` based on flags)

Use this when rendering message-like content in plugin UI (e.g., a preview popup) so it matches the styling of the chat.

```js
const ctx = Luker.getContext();
const html = ctx.messageFormatting(
    rawText,
    'Preview',
    /* isSystem */ false,
    /* isUser */ false,
    /* messageId */ -1,
);
```

### markdownConverter

```ts
context.markdownConverter: showdown.Converter
```

The shared `showdown.Converter` instance configured with Luker's project-wide markdown rules (emoji, mid-word underscores, tables, GitHub-flavored extensions, etc.). Use `.makeHtml(source)` to render markdown the same way Luker's chat pipeline does, without rebuilding a converter and having to mirror its option set. Live binding — read fresh each access (the underlying converter is rebuilt when markdown options change).

```js
const ctx = Luker.getContext();
const html = ctx.markdownConverter.makeHtml('**hello**');
```

## Utility Wrappers

### ModuleWorkerWrapper

```ts
new ModuleWorkerWrapper(updateFn: () => Promise<void>): { update(): Promise<void> }
```

Mutex wrapper for periodic worker functions — prevents overlapping ticks when the previous run hasn't finished. Typical pattern:

```js
const ctx = Luker.getContext();

const worker = new ctx.ModuleWorkerWrapper(async () => {
    await doExpensiveTick();
});

// Trigger periodically; concurrent calls serialize
setInterval(() => worker.update(), 5000);
```

### Toasts

Toast notifications use the global `toastr` library (see [toastr.js docs](https://github.com/CodeSeven/toastr)). Available everywhere — not exposed through `getContext()` because it's already a global:

```js
toastr.success('Imported successfully');
toastr.warning('Some entries skipped', 'Import Warning', { timeOut: 5000 });
toastr.error('Import failed: ' + error.message);
```

## Shared Components

Reusable HTML-string builders for common extension-drawer / popup UI patterns. Each is exposed on all three API layers.

### renderLukerTabs

```ts
renderLukerTabs(options: {
    id: string,
    scope: string,
    tabs: Array<{ key: string, label: string, contentHtml: string }>,
    defaultTab?: string,
    moduleName: string,
}): string
```

Renders a tabbed panel for extension drawer or popup UIs. Returns a complete HTML string; visibility is toggled by a delegated click handler installed on module load, so callers only need to insert the returned markup. Tab selection persists to `extension_settings[moduleName].tabState[scope]` — distinct `scope` values get independent persisted selections within the same module.

All three layers expose the same function:

```js
// Layer 1 — ESM
import { renderLukerTabs } from '/scripts/extensions/luker-tabs.js';

// Layer 2 — lukerContext
const { renderLukerTabs } = lukerContext;

// Layer 3 — getContext
const { renderLukerTabs } = SillyTavern.getContext();
```

| Field | Type | Description |
|------|------|------|
| `id` | `string` | Unique DOM id for the tabs root element |
| `scope` | `string` | Panel scope key; distinct scopes get independent persisted selections |
| `tabs` | `Array<{key,label,contentHtml}>` | Tab definitions in display order |
| `defaultTab` | `string?` | Initial tab key when no persisted state exists |
| `moduleName` | `string` | `extension_settings` bucket key (e.g. `'memory_graph'`) |

```js
const ctx = Luker.getContext();

const html = ctx.renderLukerTabs({
    id: 'my_ext_tabs',
    scope: 'my-ext-drawer',
    moduleName: 'my_extension',
    defaultTab: 'general',
    tabs: [
        { key: 'general',  label: 'General',  contentHtml: '<div>…</div>' },
        { key: 'advanced', label: 'Advanced', contentHtml: '<div>…</div>' },
    ],
});
```

### renderFieldHelpButton

```ts
renderFieldHelpButton(options: {
    title: string,
    bodyHtml: string,
    targetSelectId?: string,
}): string
```

Renders a small "?" icon button that opens a title + body popup on click. Use it for generic field explanations attached to labels or headings. For preset-slot help (which needs preset-scoped resolution), use `renderPresetHelpButton` instead.

All three layers expose the same function:

```js
// Layer 1 — ESM
import { renderFieldHelpButton } from '/scripts/extensions/field-help.js';

// Layer 2 — lukerContext
const { renderFieldHelpButton } = lukerContext;

// Layer 3 — getContext
const { renderFieldHelpButton } = SillyTavern.getContext();
```

| Field | Type | Description |
|------|------|------|
| `title` | `string` | Popup title |
| `bodyHtml` | `string` | Popup body HTML — sanitize untrusted content before passing |
| `targetSelectId` | `string?` | Optional id of a nearby `<select>` used for context-sensitive help |

```js
const ctx = Luker.getContext();

const labelHtml = `<label>Query rewrite ${ctx.renderFieldHelpButton({
    title: 'About query rewrite',
    bodyHtml: escapeHtml('Rewrites the raw query for better vector search…'),
})}</label>`;
```
