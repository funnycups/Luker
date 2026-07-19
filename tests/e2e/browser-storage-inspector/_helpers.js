// Browser Storage Inspector e2e fixtures.
//
// Seeds browser-side storage (localStorage / sessionStorage / IndexedDB /
// Cache Storage) inside the Playwright page context — no server-side
// state involved. The Inspector reads the same origin's window APIs so
// any change here is immediately visible via real UI drill.
//
// In-character content (chat filenames as demo keys, character names as
// vendor cache names) so doc screenshots read as user data instead of
// scaffolding.

/**
 * Seed a plausible fixture set into the page's origin storage.
 *
 * @param {import('@playwright/test').Page} page
 * @param {object} [opts]
 * @param {Record<string,string>} [opts.localStorage]  key → value (utf-16)
 * @param {Record<string,string>} [opts.sessionStorage]
 * @param {Array<{name:string, stores:string[]}>} [opts.indexeddb]  DBs with named stores
 * @param {Array<{name:string, requests:string[]}>} [opts.caches]   cache name → request URLs to Response.put()
 */
export async function seedBrowserFixture(page, opts = {}) {
    await page.evaluate(async (seed) => {
        // localStorage
        for (const [k, v] of Object.entries(seed.localStorage ?? {})) {
            localStorage.setItem(k, v);
        }
        // sessionStorage
        for (const [k, v] of Object.entries(seed.sessionStorage ?? {})) {
            sessionStorage.setItem(k, v);
        }
        // IndexedDB — sequential (Promise chain) so store creation is awaited.
        for (const dbSpec of seed.indexeddb ?? []) {
            await new Promise((resolve, reject) => {
                const req = indexedDB.open(dbSpec.name, 1);
                req.onupgradeneeded = () => {
                    const db = req.result;
                    for (const s of dbSpec.stores) {
                        if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
                    }
                };
                req.onsuccess = () => { req.result.close(); resolve(); };
                req.onerror = () => reject(req.error);
            });
        }
        // Cache Storage — put a plaintext Response for each request URL.
        for (const cacheSpec of seed.caches ?? []) {
            const c = await caches.open(cacheSpec.name);
            for (const url of cacheSpec.requests) {
                await c.put(new Request(url), new Response('fake body'));
            }
        }
    }, opts);
}

/**
 * Clear every browser storage this suite touches.
 */
export async function wipeBrowserFixture(page) {
    await page.evaluate(async () => {
        localStorage.clear();
        sessionStorage.clear();
        for (const info of (await indexedDB.databases?.()) ?? []) {
            if (!info.name) continue;
            await new Promise((resolve) => {
                const req = indexedDB.deleteDatabase(info.name);
                req.onsuccess = () => resolve();
                req.onerror = () => resolve();     // best-effort cleanup
                req.onblocked = () => resolve();   // don't hang if blocked
            });
        }
        for (const name of await caches.keys?.() ?? []) {
            await caches.delete(name);
        }
    });
}

/**
 * Open the Browser Storage Inspector popup via real UI gestures.
 * Returns the Inspector container locator.
 */
export async function openBrowserStorageInspector(page) {
    const drawerClosed = await page.locator('#user-settings-button .drawer-icon.closedIcon').count().then(n => n > 0);
    if (drawerClosed) {
        await page.locator('#user-settings-button .drawer-toggle').click();
        await page.waitForFunction(() => {
            const el = document.getElementById('user-settings-block');
            return el && !el.classList.contains('closedDrawer');
        }, { timeout: 5_000 });
    }
    await page.locator('#account_button').click();
    const profilePopup = page.locator('dialog.popup[open]').last();
    await profilePopup.locator('.userBrowserStorageInspectorButton').click();
    // Scope by container class so a later confirm popup on top of the
    // inspector doesn't shift `.last()` off the inspector. Use `.first()`
    // — there is only ever one inspector container mounted per test but
    // being explicit makes the locator stable across popup stacking.
    const inspector = page.locator('dialog.popup[open] .storageInspectorContainer').first();
    await inspector.waitFor({ state: 'visible', timeout: 10_000 });
    await inspector.locator('.storageInspectorLoading.displayNone').waitFor({ state: 'attached', timeout: 15_000 });
    return inspector;
}
