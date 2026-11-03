# Account window: maintainer guide

This page is for whoever maintains the Account window: the author, or an AI coding assistant working from the repository. Every file, function and class named here exists on branch `feat/data-window`; if you rename one, update this page.

## 1. What this is

One floating window (`dialog.dw-layer`) replaced six older UIs:

| Old UI | Now |
| --- | --- |
| Account popup (profile, name, password, avatar, snapshots, reset, storage inspectors) | Tabs `profile`, `snapshots`, `storage`, `reset` |
| Backup and Restore manager | Tabs `backup`, `restore`, `migrate` |
| LAN Sync panel (peers, pairing, schedule, device name) | Tab `sync`, pages `add`, `pairNew`, `pairExist`, `lanEdit`, tab `settings` |
| S3 backend form popup | Pages `s3` (add and edit), `unlock` |
| Sync conflicts popup | Page `conflicts` ("Sync issues") under tab `sync` |
| Admin Panel popup | Tab `users` ("User management"), handled by `account-admin.js` |

The old popups, templates and their CSS were deleted (commit `9248a42`). `user.js`, `lan-sync.js`, `sync-s3.js` and `sync-status.js` keep only the helpers the window imports.

### Entry points

| Entry | Code | Call |
| --- | --- | --- |
| Account button (`#account_button`) | `user.js`, `jQuery(() => ...)` at the end | `openDataWindow({ tab: 'profile' })` |
| Admin Panel button (`#admin_button`) | same place | `openDataWindow({ tab: 'users' })` |
| Top sync pill (`#luker-sync-activity-pill`) | `sync-activity.js`, `onOpen` | `openDataWindow({ tab: 'sync' })` |
| Conflicts or notices found by a status check | `sync-status.js`, `showSyncIssues()` | `openDataWindow({ tab: 'sync', view: 'conflicts' })` |
| Admin opens a user's data (user detail, "Backup, restore and migration") | `AdminPages.openUserData()` | `openDataWindow({ tab: 'backup', handle, onDone: () => {} })` |

### Open functions

`openDataWindow(options)` in `data-window.js` imports `account-window.js` dynamically and calls `openAccountWindow({ tab: 'sync', ...options })`. Always call one of these, never construct a window yourself.

| Option | Meaning |
| --- | --- |
| `tab` | Tab to show. `openAccountWindow` defaults to `'profile'`, `openDataWindow` to `'sync'`. Values: `profile`, `sync`, `backup`, `restore`, `migrate`, `settings`, `snapshots`, `storage`, `users`, `reset`. An unknown or unreachable tab falls back to the first one. |
| `view` | Sub-page pushed onto the tab's stack, e.g. `'conflicts'`. |
| `handle` | User whose backup, restore and migration the window acts on. A handle other than the signed-in one limits the window to `backup`, `restore`, `migrate` and shows an "Acting on user ..." tag. |
| `onDone` | Called after a successful restore or migration (after a 3 s delay when there is no warning, or when the user clicks Reload). Default for the live provider is `location.reload()`. |
| `provider` | Custom data source (see section 4). When given, the window never reloads by default and does not call `stop()` on close. |
| `usersStack` | Internal: user-management page stack to restore. |

Only one window exists (module variable `openWindow` in `account-window.js`). A second call with the same `handle` and no `provider` calls `navigate({ tab, view })` on the open window and focuses it. A different `handle`, or any `provider`, closes the open window first (closing skips the "job running" question).

## 2. File map

| File | Responsibility |
| --- | --- |
| `public/scripts/luker-window.js` | Shell: `mountLukerWindow`, base class `LukerWindow`, `ICONS`, `THEMES`, `ic`, `esc`, `loadTheme` |
| `public/scripts/data-window.js` | `DataPages extends LukerWindow`: sync, backup, restore, migrate, device-settings pages. Also `openDataWindow`, `dataTitles`, `dataHelp` |
| `public/scripts/account-window.js` | `AccountWindow extends DataPages`: profile, rename, password, snapshots, storage, reset pages, plus `openAccountWindow` |
| `public/scripts/account-admin.js` | `AdminPages`: all User management pages. Not a window subclass; it is a helper object owned by `AccountWindow` |
| `public/scripts/data-window-provider.js` | `createLukerProvider`: builds the shared snapshot and merges the two sources |
| `public/scripts/data-window-sync.js` | `createSyncSource`: backends, pairing, S3, schedule, conflicts, notices; listens to sync-status events |
| `public/scripts/data-window-backup.js` | `createBackupSource`: backup download, chunked restore, migration link |
| `public/scripts/data-window-mock.js` | `createMockProvider`: offline preview with fake data (Chinese strings, not translated) |
| `public/css/luker-window.css` | Theme variables, reset, shell, shared controls |
| `public/css/data-window.css` | Sync, backup, restore, migrate, conflicts |
| `public/css/account-window.css` | Profile, snapshots, storage, reset |
| `public/css/account-admin.css` | User management |
| `tests/e2e/_lib/account-window.js`, `tests/e2e/_lib/sync.js` | Playwright helpers (section 7) |

The four CSS files are imported by `public/style.css`.

### Imports

```
user.js ──────────────► data-window.js ─ dynamic import ─► account-window.js
sync-status.js ───────► data-window.js    (openDataWindow)        │
sync-activity.js ─────► data-window.js                            ├─► data-window.js (DataPages)
account-admin.js ─────► data-window.js    (openDataWindow)        ├─► account-admin.js (AdminPages)
                                                                  ├─► data-window-provider.js
data-window.js ───────► luker-window.js                           │      ├─► data-window-sync.js ─► lan-sync.js, sync-s3.js,
account-window.js ────► luker-window.js                           │      │                          sync-status.js, sync-activity.js
account-admin.js ─────► luker-window.js                           │      └─► data-window-backup.js ─► user.js, luker-chunked-upload.js
                                                                  └─► user.js (profile, snapshots, reset requests)
```

`openDataWindow` imports `account-window.js` dynamically because `account-window.js` imports `DataPages` from `data-window.js`; a static import in the other direction would make the two modules a cycle. `sync-status.js` and `sync-activity.js` also load `data-window.js` with `await import(...)` when they need it, so the window code is not loaded until it is opened.

Functions imported from the old modules:

| From | Names |
| --- | --- |
| `lan-sync.js` | `SYNC_ENDPOINTS`, `buildPairLink`, `parsePairLink`, `claimBackendAction`, `pendingBackendActions`, `describeSyncFailure`, `syncFailureReason`, `pairFailureMessage`, `pairLinkBaseUrls`, `englishFallbackForCategory`, `getCurrentHandleForSync`, `sanitizeHandleForPeerId`, `loadAvailability`, `loadBackends`, `loadCategories`, `undoLastBackendSync` |
| `sync-s3.js` | `backendSettingsUrl`, `postBackendSettings`, `s3SettingsPayload`, `syncSettingsError` |
| `sync-status.js` | `checkSyncStatusNow`, `readStatus`, `conflictKey`, `noticeKey`, `recordUnknown`, `reportingBackends`, `createPreviewCache`, `loadSyncPreview`, `submitConflictChoices`, `dismissSyncNotice`, `openSyncNoticeTarget`, `invalidateSyncStatusReads` |
| `sync-activity.js` | `beginSyncActivity` |
| `user.js` | `downloadUserBackup`, `restoreUserData`, `probeBackupArchive`, `createLanMigrationLink`, `importLanMigrationLink`, `buildRestoreDiagnosticReport`, `BACKUP_CATEGORY_KEYS`, `BACKUP_DEFAULT_SELECTION`, `isAdmin`, `getCurrentUserHandle`, `isLocalOnlyHostName`, and the `request*` / `fetch*` helpers for profile, snapshots, reset and admin pages. The `request*` helpers throw instead of using toastr so the window can show the error itself |

## 3. Shell (`luker-window.js`)

### Structure

`mountLukerWindow({ label, create, onClosed })` builds `<dialog class="dw-layer"> > .dw-scrim + section.dw-win > div.dw`, calls `showModal()` (top layer, so it stays above Luker popups opened earlier; popups opened later from inside it, such as the avatar crop, are also dialogs and sit above it), calls `create(root)` to get the `LukerWindow` instance, and returns `{ ui, win, closed, close }`.

`LukerWindow` renders title bar, side rail (`navItems()` plus `footItems()` at the bottom), and the page (`renderPage()`: heading with optional back button, `headExtra()`, then `renderView()`).

| Aspect | How it works |
| --- | --- |
| Navigation | `navItems()` returns `{ key, label, icon, count?, danger? }` or `{ sep: true }`. `key` is the tab name and also the key into `this.stack`. Clicking a tab sets `this.tab` and keeps that tab's stack. |
| Page stack | `this.stack[tab]` is an array of `{ view, ...params }`. `push(view, params)`, `pop()`, `this.top`, `this.viewKey`. The page heading element carries `data-view` of the top page. |
| `navigate({ tab, view })` | Used when the window is already open. Switches tab and pushes `view` if it is not already on top. `AccountWindow` overrides it to ignore tabs the user cannot see. |
| Render | `render()` rebuilds everything, `rerender()` only the body (keeps scroll), `renderStatus()` only the title status. `afterRender()` runs after both of the first two. |
| Footer | `foot(html)` returns a sticky `.dw-foot` with the page's main buttons. |
| Toast | `toast(text, error = false)`, auto-removed after 2.8 s. |
| Confirm | `await confirm({ title, text, ok, danger })` returns a boolean. Rendered inside the window as `.dw-modal`, so Esc cancels it first. |
| Help | `helpLines()` returns paragraphs; if non-empty a `?` button shows a popover. |
| Status | `statusInfo()` returns `{ tone, text, act? }` for the title bar. `tone` is one of `ok`, `running`, `attention`, `error`; `act` is a `data-act` the pill triggers when clicked. |
| Theme | `loadTheme()` reads `localStorage['luker.dataWindow.theme']` (name kept so the Data window preview choice carries over), else `mist` or `ocean` from `prefers-color-scheme`. Picking a theme saves it and updates `layer.dataset.theme` through `ui.onTheme`. |
| Esc | Document-level capture handler: closes the in-window confirm, else a popover (help, theme), else the window. It ignores Esc whose target is outside the layer and not `document.body`, so Luker popups on top handle their own Esc. The dialog's native `cancel` event is prevented. |
| Close guard | Close button and Esc go through `requestClose()`. If `ui.busyJob` is non-null it asks "... Close the window anyway?". Jobs continue on the server; only the progress display is lost (the state is kept in module-level objects, see below). |
| Drag | Title bar pointer drag; disabled when `innerWidth <= 640`. |
| Click handling | One delegated listener. Built-in `data-act`: `close`, `tab`, `back`, `push` (with `data-view`), `help`, `theme-menu`, `theme`, `eye`. Everything else goes to `onAction(act, el, e)`. |
| Forms | `pw(model, value, placeholder, autocomplete)` renders a password input with the show button. `data-model="top.x"` binds an input to `this.top.x`; `device.*` and `schedule.*` bind to `this.f` (see `DataPages.setModel`). |

### Subclass hooks

Override these on `LukerWindow`: `windowTitle`, `windowIcon`, `navItems()`, `footItems()`, `pageTitle()`, `helpLines()`, `headExtra()`, `renderView()`, `afterRender()`, `statusInfo()`, `busyJob`, `onAction(act, el, e)`, `destroy()`. `AccountWindow` layers on `DataPages` by checking its own view names first and calling `super` otherwise; `AdminPages` is consulted through `this.admin.owns(view)`.

### Add a navigation item and page

Edit `public/scripts/account-window.js`. Example: a tab `about` with one page.

```js
// 1. Title and help (functions, never top-level constants: see section 6).
const accountTitles = () => ({
    // ...existing entries
    about: t`About`,
});
const accountHelp = () => ({
    // ...existing entries
    about: [t`Shows version information.`],
});
// ACCOUNT_VIEWS is derived from accountTitles(), so the view is now known.

// 2. In AccountWindow.constructor, give the tab a stack:
Object.assign(this.stack, {
    // ...existing entries
    about: [{ view: 'about' }],
});

// 3. In navItems(), add the entry (inside the non-other-user list):
item('about', t`About`, 'help'),   // icon must be a key of ICONS

// 4. In renderView(), add the case:
case 'about': return this.viewAbout();

// 5. The page itself:
viewAbout() {
    return `
        <div class="dw-list">
            <div class="dw-setrow"><span>${t`Version`}</span><span class="dw-setrow-val">${esc(version)}</span></div>
        </div>
        ${this.foot(`<button class="dw-btn primary big" data-act="about-go">${t`Check`}</button>`)}`;
}

// 6. In onAction(), handle the action:
case 'about-go': return this.toast(t`Up to date`);
```

Then add the English strings to `public/locales/zh-cn.json` and `zh-tw.json` (section 6), and a test using `openAccountTab(page, 'about')`.

For a sub-page (not a tab) add the title and the `stack` entry is not needed: call `this.push('aboutDetail')` or use `data-act="push" data-view="aboutDetail"`, add the title to `accountTitles()` and a case in `renderView()`.

New icons go into `ICONS` in `luker-window.js` as the inner SVG path markup of a 24x24 stroke icon.

For a long job, expose it through `busyJob` (return a short name such as `t\`Migrating\``) so the close guard works. `AccountWindow.busyJob` already ORs `DataPages.busyJob` and `AdminPages.busyJob`.

## 4. Data contract

### Provider

`createLukerProvider({ handle })` returns `{ ...backup, ...sync, subscribe, snapshot, start, stop }`. The window only talks to this object (`this.p`).

- `subscribe(fn)` returns an unsubscribe function. `fn` is called after every snapshot change. `DataPages` reacts in `refreshLive()`: it re-renders only the affected regions (`data-region="top|cards|summary"`) on the sync list, the whole page on `conflicts`, and updates the tab badge and title status. A 1 s `setInterval` (`tick()`) refreshes elapsed times, and the cards every 15 s so "x min ago" stays current.
- `snapshot()` returns one mutable object. Sources update it in place and then call `emit()`. Never replace it.
- `start()` / `stop()` are called by `openAccountWindow` for the live provider only (`source.start?.()`; `stop` on close unless a custom `provider` was passed). `start()` begins listening for `sync-status-updated`, `sync-status-read-failed` and `sync-backend-actions-updated` on `document`, loads availability, categories, backends, then calls `checkSyncStatusNow()`. `stop()` removes the listeners and revokes the preview cache. The backup source's `stop()` discards an upload that is waiting (not one that is running).

### Snapshot

| Field | Type / meaning |
| --- | --- |
| `available`, `unavailableReason` | Sync usable on this server; text to show when not |
| `statusError`, `listError` | Status read failed; backend list refresh failed (old list is kept) |
| `isAdmin`, `handle` | Signed-in user |
| `caps` | `{ allowFullBackup, allowSecrets }`. `allowSecrets` comes from `canViewSecrets()`; `allowFullBackup` becomes `false` after a 403 "disabled" answer |
| `device` | `{ label, placeholder }` |
| `schedule` | `{ idle, poll }` seconds (sync-after-idle delay and poll interval) |
| `syncCategories` | `[groupName, [[id, label, optIn], ...]][]`; `optIn: true` means not synced by default |
| `backupCategories` | `{ id, label, def, sensitive?, adminOnly? }[]`; ids are `BACKUP_CATEGORY_KEYS` from `user.js` |
| `backends` | `{ id, kind: 'lan'\|'s3', label, state, lastSync, startedAt?, categories, canUndo, hasStoredCredentials, stalled, error }[]`. `state` is `ok`, `running`, `error`, `pending` (LAN not yet paired) or `unknown` (pending records unreadable). `lastSync` is epoch ms, `0` if never |
| `conflicts` | `{ key, backendId, path, kind, stale, unknown, review, versions: [{ id: 'ours'\|'theirs'\|'current', from, current?, inUse, preview }] }[]`. `review` is opaque: pass it back to `applyConflicts` unchanged. `preview.kind` is `loading`, `deleted`, `text`, `image`, `binary` or `error` |
| `notices` | `{ id, path, type: 'fork'\|'restored', title, detail, action, missingGroup, unknown }[]` |

### Methods

Errors are `Error` objects with `message` (already user-readable and translated) and `code`. The window shows `message` and branches only on the codes listed.

| Method | Returns | Notable errors / codes |
| --- | --- | --- |
| `syncNow(id)` | `{ conflicts, stalled }` counts | `BACKEND_BUSY`, `UNKNOWN_BACKEND`, `NETWORK`, server codes |
| `undo(id)` | `{ kept: string[] }` (files edited after the sync, kept) | `NOTHING_TO_UNDO`, `BACKEND_BUSY` |
| `remove(id)`, `clearAuth(id)` | `void` | `BACKEND_BUSY` |
| `saveDevice(label)` | stored label | `INVALID_DEVICE_LABEL` (window shows its own text) |
| `saveSchedule(idle, poll)` | `{ idle, poll }` as stored | `INVALID_SCHEDULE` |
| `createPairLink({ label, categories })` | `{ addresses: string[], link(address) }` | server codes |
| `parsePairLink(link)` | `{ url, peerId, code, handle, label, categories }` or `null` | none; the window fills the form from the result |
| `currentHandle()` | handle string | |
| `acceptPair({ url, peerId, code, label, user, pass, categories })` | the new backend | `HANDLE_MISMATCH`; codes starting with `PEER_AUTH` open the account fields; an error with `paired: true` (and `backendId`) means the pairing was saved and only the first sync failed |
| `saveS3(form, id?)` | `void` (add when no `id`, edit otherwise) | server codes via `syncSettingsError` |
| `getS3(id)` | `{ endpoint, region, bucket, prefix, pathStyle }` | |
| `unlockS3(id, passphrase)` | `void` | `EMPTY` |
| `editLan(id, { label, categories })` | `void` | |
| `applyConflicts(choices)` | `{ applied: key[], alreadyResolved: {key,path}[], failed: {key,path,reason}[] }`. `choices` is `{ [key]: { version, review } }` | `NO_CHOICES`, `APPLY_FAILED` |
| `dismissNotice(id)` | `void` | `NOTICE_UNKNOWN` |
| `openNotice(id)` | `void` | `CHAT_MISSING` |
| `isBusy(id)` | whether an action holds the backend lock (optional on custom providers) | |
| `downloadBackup(categories, onProgress)` | `{ fileName, size }`. Progress: `{ stage: 'pack' }` or `{ stage: 'download', percent }` | `NOTHING_SELECTED`, `BACKUP_DISABLED`, `BACKUP_FAILED` |
| `restoreBackup({ file, mode, categories, tempDb, handle }, onProgress)` | `{ restored, skipped, rejected, failed, crossEngine, samples }`. Progress: `{ stage 0..3, percent?, note? }` (Upload, Prepare, Check, Restore) | `NO_FILE`, `NOTHING_SELECTED`, `upload-interrupted` (with `percent`), `needs-temp-db` (with `kind`, `source`, `target`), `TEMP_DB_FAILED`, `UPLOAD_FAILED`, `ASSEMBLE_FAILED`, `RESTORE_FAILED` |
| `cancelUpload()` | `void` (optional) | |
| `createMigrationLink(categories, handle)` | `{ addresses, link(address), expiresAt }` | `NOTHING_SELECTED`, `LINK_FAILED` |
| `migrateFromLink({ link, mode, categories, handle }, onProgress)` | same outcome as restore. Progress: `{ stage 0..2 }` (Download, Prepare, Restore) | `BAD_LINK`, `NOTHING_SELECTED`, `MIGRATION_FAILED` |

`mode` is `'merge'` (incremental) or `'replace'` in the window; `data-window-backup.js` maps `replace` to the server's `overwrite`.

### Locks and shared state

- Backend actions take the module-level lock `pendingBackendActions` from `lan-sync.js` through `claimBackendAction(id)`; `withBackendAction()` in `data-window-sync.js` throws `BACKEND_BUSY` when it is held. `isBusy(id)` reads the same set, and `DataPages` also keeps its own module-level `shared.pending` set of ids it started, so a locked card stays locked after the window is closed and reopened. The lock is per page; a second browser tab is protected by the server.
- `data-window.js` keeps `shared.jobs` (backup, restore and migrate progress) and `shared.backupSel` (selected categories) at module level so closing and reopening the window shows a running job again.
- `data-window-sync.js` keeps `localRuns`, `runningSince` and `nothingToUndoAt` at module level for the same reason.
- `data-window-backup.js` keeps one `upload` session and a `busy` flag per provider instance.

### Polling

The provider does not poll by itself. Cadence comes from `sync-status.js`: status every 30 s while the page is visible (`STATUS_POLL_MS`), every 5 s while a sync runs (`ACTIVE_STATUS_POLL_MS`), and at once when the page becomes visible again. Each status event refreshes the backend list too (`refreshBackends()`, overlapping calls coalesce). The window itself adds only the 1 s tick described above.

### The mock provider

`createMockProvider()` returns the same method set with fake data, `wait()` delays and failure triggers (file names containing `fail`, `slow`, `postgres` or `mysql`; S3 access key containing `fail`; a LAN address on port 8443 without a login). Use it to work on UI without a server:

```js
const { openDataWindow } = await import('/scripts/data-window.js');
const { createMockProvider } = await import('/scripts/data-window-mock.js');
openDataWindow({ provider: createMockProvider() });
```

The mock has no `start()`/`stop()` and no `isBusy()`/`cancelUpload()`; the window calls those with `?.`. Its text is Chinese and not translated, and its category ids differ from the real ones. Keep its shape identical to the real sources: when you add or change a snapshot field or method, change `data-window-mock.js` in the same commit. Nothing checks this automatically.

## 5. Styling

- Every class starts with `dw-`. Window-specific `data-*` attributes also exist (section 7).
- The layer, window and theme variables live in `luker-window.css`. The page-level CSS files only use variables (`var(--dw-*)`), never hard-coded colours.
- Layout variables on `.dw-layer`: `--dw-font`, `--dw-mono`, `--dw-r-sm`, `--dw-r`, `--dw-r-lg`, `--dw-ease`, `--dw-dur`.
- Theme variables, set per `.dw-layer[data-theme="..."]`: `--dw-surface`, `--dw-raised`, `--dw-hover`, `--dw-active`, `--dw-border`, `--dw-border-strong`, `--dw-text`, `--dw-muted`, `--dw-faint`, `--dw-accent`, `--dw-accent-soft`, `--dw-accent-text`, `--dw-amber`, `--dw-amber-soft`, `--dw-danger`, `--dw-danger-soft`, `--dw-blue`, `--dw-shadow`, `--dw-scrim`. Meaning: amber means needs attention, danger (coral) means failed.
- Themes: `mist`, `latte` (light), `ocean`, `dusk` (dark).

### Add a theme

1. `luker-window.js`: add `{ key: 'name', dark: false, a: '#bg', b: '#accent' }` to `THEMES` (`a` and `b` colour the swatch; `dark` selects the moon icon) and add the label to `themeLabel`.
2. `luker-window.css`: copy a `.dw-layer[data-theme="mist"]` block, rename it, and set every variable listed above. A missing variable falls through to nothing, so check all of them.
3. Add the label to `zh-cn.json` and `zh-tw.json`.

### Phone layout

`.dw-win` is a container (`container-type: inline-size`). Page layouts respond to the window width, not the viewport, with `@container (max-width: 600px)`. There is one such block in each of the four CSS files; put new narrow-layout rules in the matching file's block. At 600 px and below the rail becomes a horizontal strip (`revealTab()` scrolls the selected tab into view). The viewport `@media (max-width: 640px)` only sets the window size and corner radius, and `makeDraggable` uses the same 640 px check. A `prefers-reduced-motion` block removes animations.

### Why the reset exists

Luker styles bare elements (`button`, `input`, `select`, `h2`, `p`, `code`, `a`, `::selection` and others) in `style.css` and `accounts.css`. The block "Luker styles bare elements; reset everything inside the window." in `luker-window.css` neutralises those inside `.dw-layer` (box-sizing, text-shadow, colours, form control look, headings, `[hidden]`, focus ring, SVG icon sizing). When a Luker global style leaks into the window, fix it there with a `.dw-layer` selector, not in the page CSS or in `style.css`.

## 6. i18n

All user-facing text is written as the tagged template ``t`English` `` from `i18n.js`. The English text is the key; `${expr}` placeholders are matched by position as `${0}`, `${1}`.

- Translations are appended at the end of `public/locales/zh-cn.json` and `zh-tw.json` (about 400 entries each from this branch). Format of an entry: `"Switch to ${0}?": "切换到 ${0}？"`.
- `t` runs when called. A top-level `const x = t\`...\`` runs at import time, before the locale is loaded, and stays English. Therefore every title, help and label table is a function: `dataTitles()`, `dataHelp()`, `accountTitles()`, `accountHelp()`, `adminTitles()`, `adminHelp()`, `restoreStages()`, `stateTag()`, `themeLabel`. Keep that pattern; call the function when rendering.
- For text keyed by an id from the server, use `translate(english, key)` (see `categoryLabel` in `data-window-sync.js`, `adminHelp` for the storage backend warnings).
- A string that is not wrapped (for example `Endpoint`, brand names, `SQLite`) is intentionally English.
- The mock provider's strings are Chinese and untranslated by design.

### Find missing translations

Save as a file outside the repository (for example `/tmp/check-i18n.mjs`) and run `node /tmp/check-i18n.mjs <repo root>`. It prints, per language, the `t` strings in the window files that have no entry.

```js
import fs from 'node:fs';
const root = process.argv[2] ?? '.';
const files = ['luker-window', 'account-window', 'account-admin', 'data-window', 'data-window-sync', 'data-window-backup']
    .map(f => `${root}/public/scripts/${f}.js`);
for (const lang of ['zh-cn', 'zh-tw']) {
    const dict = JSON.parse(fs.readFileSync(`${root}/public/locales/${lang}.json`, 'utf8'));
    const missing = new Set();
    for (const file of files) {
        const src = fs.readFileSync(file, 'utf8');
        for (const m of src.matchAll(/(?<![\w.$])t`((?:[^`\\]|\\.|\$\{(?:[^{}]|\{[^{}]*\})*\})*)`/g)) {
            let i = 0;
            const key = m[1].replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, () => `\${${i++}}`);
            if (!(key in dict)) missing.add(`${file.split('/').pop()}: ${key}`);
        }
    }
    console.log(`${lang}: ${missing.size} missing`);
    for (const k of missing) console.log('  ' + k);
}
```

On this branch it reports 0 missing for both languages. It does not see `translate(...)` calls or templates split over several strings.

## 7. Testing

### Helpers

`tests/e2e/_lib/account-window.js`:

| Helper | Use |
| --- | --- |
| `accountWindow(page)` | Locator of `dialog.dw-layer[open] .dw-win` |
| `pageHead(page)` | `.dw-pagehead`; assert its `data-view` |
| `formError(page)`, `windowConfirm(page)`, `windowToast(page, text, { error })` | `.dw-err`, `.dw-modal`, `.dw-toast` |
| `openAccountWindow(page)`, `openAccountTab(page, tab)` | Open through User Settings, then click a tab and press Back to its root page |
| `answerWindowConfirm(page, { confirm, text })` | Click confirm or cancel in the in-window dialog |
| `closeAccountWindow(page)` | Close, confirming the "close anyway" question |
| `openUserManagement`, `showAdminSegment`, `openAdminPage`, `openAdminUser` | User management pages |
| `openStorageInspectorPage(page, kind)` | Storage tab, `server` or `browser` |

`tests/e2e/_lib/sync.js` re-exports `accountWindow` and `pageHead` and wraps the sync flows: `openLanSyncPanel`, `backendCard`, `clickBackendMenu`, `generatePairingLink`, `acceptPairingLink`, `clickSyncNow`, `clickUndoLastSync`, `clickForgetPeer`, `addS3Backend`, `editSyncBackend`, `unlockS3Backend`, `setSyncSchedule`, `setSyncDeviceLabel`, `waitForSyncPopup`, `waitForSyncIssuesPage`, `conflictRow`, `noticeRow`, `chooseConflictVersion`, `applyConflictChoices`, `resolveAllConflictsAs`, `waitForStatusChecks` and others. Other changed helpers: `_lib/page.js`, `_lib/storage-ui.js`, `_lib/s3-chat.js`, `_lib/s3-races.js`, `_lib/sync-s3.js`.

### Test hooks

Added for the suite; do not remove or rename without updating the helpers.

| Hook | Element |
| --- | --- |
| `data-view` | `.dw-pagehead`: name of the top page |
| `data-act`, `data-model`, `data-tab`, `data-r` | Controls (`data-r="1"`/`"0"` are confirm and cancel) |
| `data-backend`, `data-kind`, `data-state` | Backend card on the Sync list (`data-state` also `attention`) |
| `data-path`, `data-stale` | `.dw-conflict`; `data-path` also on `.dw-notice` |
| `data-v` | `.dw-version` button (`ours`, `theirs`, `current`) |
| `data-flash` | Result banner of the last sync action (`success`, `warning`, `error`) |
| `data-current-mode` | Current storage mode on the Storage Backend page |
| `data-handle`, `data-seg`, `data-kind` (on switches) | User management |
| `document.body.dataset.syncStatusChecks` | Counter of finished sync status checks (not from the window) |

### Specs to watch

| Spec | Why |
| --- | --- |
| `sync/18-conflict-popup.e2e.js` | Now tests the Sync issues page. A conflict resolved on another device disappears from the list instead of being marked; unreadable records keep the conflict listed but disable its version buttons; the "applied" and "already handled" messages are window toasts; the page shows only after a status check |
| `sync/15-pending-conflicts-on-sync-now.e2e.js` | After a sync that merged nothing but left conflicts pending, the result banner (`data-flash="warning"`) has a Resolve button that leads back to Sync issues; the old popup no longer re-opens by itself |
| `sync/28-s3-concurrency.e2e.js` | Backend cards are locked in the tab that started a sync; edit and remove go through the card menu (`clickBackendMenu`) and `answerWindowConfirm`; a second tab can still request maintenance |
| `sync/35-unified-sync-panel`, `36-read-failures`, `38-sync-activity` | Rewritten for the window and the activity pill (now shows elapsed time) |
| `storage/cross-mode-recovery/99-real-data-sqlite-to-fs.e2e.js` and `_lib/recovery-flow.js` | Drive Account, Backup, Restore with Replace mode and its confirm; the temp-database form after `needs-temp-db` |
| `storage/cross-mode-recovery/14-fs-restore-abort-cleanup.e2e.js`, `storage-inspector/*`, `browser-storage-inspector/_helpers.js`, `server-plugins/01-install-dependencies.e2e.js`, `personas/onboarding-data-import.e2e.js` | Use the Account window pages; plugin install now has an extra confirm |
| `tests/run-panel/activity-pill.test.js` | Unit test for the pill's elapsed text |

Specs that wait for the window to open by itself must tolerate that an already-open window does not move: use `waitForSyncPopup`, which clicks the Resolve button or the title pill when needed.

### Run

From `tests/` (the full guide is `tests/e2e/README.md`):

```sh
cd tests
PW_WORKERS=1 npx playwright test e2e/sync/18-conflict-popup.e2e.js --reporter=line
PW_WORKERS=1 npx playwright test e2e/sync/ --reporter=line
npm run lint
```

Sync specs start real servers (the MySQL and PostgreSQL ones may need Docker). Keep `PW_WORKERS=1` unless you know the batch tolerates more.

## 8. Behaviour notes and known limits

### Backend limitations

| Behaviour | Reason |
| --- | --- |
| Backup download usually shows no percentage | The server zips while streaming and sends no length. `downloadBackup` stays on the `pack` stage and reports bytes; it switches to `download` with a percent only when a total is known |
| Migrate in has no download progress | `importLanMigrationLink` only reports phases (`download`, `extract`, `finalize`...), mapped to 3 stages; the first stage has no percent |
| `device.placeholder` is empty at first | The host-name default is only returned by the device save route (`resolvedLabel`). Until the user saves a device name the input has no placeholder, and the summary shows an empty name |
| `canUndo` is inferred | `Boolean(lastSync.at)` unless an undo already answered "nothing to undo" for that same `lastSync.at` (`nothingToUndoAt`). The server has no flag |
| `startedAt` is the local clock | It is the time this page started the sync, or the time it first saw the backend running. A sync started elsewhere shows time since first seen |
| Migration address candidates are limited | Only the origin of the server-provided URL and `location.origin`, loopback sorted last. If all are loopback the page shows an input for the LAN address (`linkWithAddress` rewrites the link) |
| Temporary database failure needs a new upload | When the restore request fails (`TEMP_DB_FAILED`, `RESTORE_FAILED`) the upload session is consumed or aborted, so the file is sent again on retry. `needs-temp-db` and `upload-interrupted` are the cases that reuse the uploaded file |
| `resumeFrom` in `restoreBackup` is ignored by the live source | It only exists for the mock. The live source resumes from its own session |

### Differences from the old UI (intentional)

- Installing a server plugin asks for confirmation first.
- New user: display name is required, and the handle is checked in the browser (`[a-z0-9-]+`) before the request.
- While the window is open, new conflicts or notices do not move the user to the Sync issues page. The title shows a pill and the Sync tab a count; the user clicks through. The old popup opened by itself. When the window is closed, a new unseen issue still opens it on that page (`sync-status.js`, `isDataWindowOpen()`).
- Choices that fail to apply are cleared from the page's selection and reported; a backend can be edited while it syncs, as before.
- Backup categories keep the old default: API keys are ticked by default (`BACKUP_DEFAULT_SELECTION.secrets = true`), unless the server does not allow secrets export (then the chip is disabled and unticked).
- Restore and migrate each keep their own mode selection; backup, restore and migrate share one category selection.
- Backup, restore and migrate in the same window cannot run at the same time (`lockAttr`); the old UI disabled the other buttons the same way.
- An admin acting on another user's data gets a window with only backup, restore and migrate, and returns to user management afterwards (`reopenUsers`).

## 9. Old to new mapping

| Old feature | Now |
| --- | --- |
| Account popup: avatar, display name, password, handle, created date | Profile tab; pages `rename`, `password` |
| Settings snapshots (make, view, restore) | Snapshots tab |
| Server and browser storage inspectors | Storage tab (segmented `server` / `browser`; each inspector is built once and kept) |
| Reset Settings, Reset Everything | Reset tab (foot of the rail): pages `resetSettings`, `resetAll` (reset code is requested on page open) |
| Backup and Restore: category checkboxes | Chips on Backup, Restore, Migrate (Select all, Default, Clear) |
| Download ZIP | Backup tab |
| Restore ZIP: merge or overwrite, drag and drop, chunked upload, resume, cross-engine temp DB, report | Restore tab (Incremental / Replace); interrupted upload gives Continue or Discard; result banner with skipped samples |
| Migration link (create, copy, address) and Migrate from link | Migrate tab: pages `migrateOut`, `migrateIn` |
| Open the backup manager for another user (admin list) | User detail, "Backup, restore and migration" (`openUserData`) |
| LAN Sync panel: peer list, Sync now, Undo, Forget | Sync tab cards; Undo and Forget are in the card menu |
| Pairing: let another device connect, connect to another device | Pages `pairNew`, `pairExist` (via Add) |
| Edit peer, clear saved account | Page `lanEdit`; card menu "Clear saved account" |
| S3 form (add, edit), unlock | Pages `s3`, `unlock` |
| Idle and poll intervals, device name | Device settings tab |
| Sync activity pill click | Opens Sync tab |
| Conflicts popup (versions, previews, apply, stalled files, notices, open branch, dismiss) | Sync issues page (`conflicts`) under Sync; auto-opens when the window is closed |
| Review sync issues button | Banner on Sync list ("Resolve") and the title pill |
| Admin Panel: manage users, rename, password, quota, enable, promote, delete, avatar | User management tab: Users segment, user detail and sub-pages (`adminUser*`), New User |
| Admin: overview, security, auth and limits, announcements | Server segment: `adminOverview`, `adminSecurity`, `adminAuth`, `adminNotices` |
| Admin: server plugins, config.yaml, storage backend migration, storage management | `adminPlugins`, `adminConfig`, `adminBackend`, `adminStorage` (`adminStorageUser` per user) |
