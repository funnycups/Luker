# Storage Inspector

Luker has two storage inspectors: one for the server-side data directory of an account, one for the current browser's local storage. Both live under **User Settings → Account** and share the same layout: a quota row, a stacked usage bar, a legend, and a drill-down list.

## Server-Side Storage Inspector

**Entry:** User Settings → Account → **Storage Inspector**

It groups an account's disk usage into ten categories: Chats, Characters, Worldbooks, Images, Attachments, Presets, Extensions, Vectors, Backups, and Other. Click a category to see individual files.

The inspector is read-only. Delete through the matching UI instead: chats in the chat panel, characters in the character list. Sensitive files such as `secrets.json` show their size only.

Admins can inspect any account, or an aggregate across all accounts, from Admin Panel → Storage Management.

![Server storage overview](/images/storage-inspector/01-self-l1.png)

![Chats drill-down](/images/storage-inspector/02-self-chats-drilldown.png)

![Admin aggregate](/images/storage-inspector/05-admin-aggregate.png)

## Browser Storage Inspector

**Entry:** User Settings → Account → **Browser Storage**

It shows the storage an origin gets: `localStorage`, `sessionStorage`, `IndexedDB`, `Cache Storage`, and the storage quota. Click a category to see individual keys, databases, object stores, or caches.

You can delete a `localStorage` or `sessionStorage` key, clear an object store, delete a database, or delete a cache. Each deletion asks for confirmation and cannot be undone. The quota view is informational.

This inspector covers the current browser only. The same account on another device has its own storage.

![Browser storage overview](/images/browser-storage-inspector/01-browser-l1.png)

![IndexedDB drill-down](/images/browser-storage-inspector/02-indexeddb-l2.png)

![Delete confirmation](/images/browser-storage-inspector/03-delete-confirm.png)

## FAQ

**Why does Storage Quota show "unlimited"?**
Some browsers do not report a quota for the origin. Luker shows "unlimited"; the browser still enforces its own limit.

**Does deleting a `localStorage` key break Luker?**
It depends on the key. Luker stores the UI language override, unsaved drafts, and some connection URLs there; deleting one of those resets the setting on the next page load. The confirmation dialog names the key.

**Why is the size `?` for IndexedDB and Cache Storage?**
Browsers do not expose a per-database or per-cache byte total through a fast API. Computing it means reading every record or cached response. The top of the inspector shows the browser's aggregate estimate from `navigator.storage.estimate()`.

**I deleted an IndexedDB database and something broke.**
Voice synthesis, model caches, and offline resources store state in IndexedDB and Cache Storage. Reload the page; they re-fetch or re-initialize what they need.
