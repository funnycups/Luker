// Storage Inspector · sensitive-file handling + refresh button.
//
// Two behaviours locked here:
//   1. Under Other, secrets.json is rendered with .storageInspectorSensitiveBlob
//      (lock icon, no chevron), clicking it does not drill, and a direct
//      deep-request against /api/users/storage/inspect returns 400 with
//      code=E_NOT_INSPECTABLE.
//   2. The refresh button on the Inspector re-issues an inspect POST.
//
// Both tests exercise the same server + fixture from a fresh Inspector
// popup — no shared UI state between them.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { awaitMainUI } from '../_lib/page.js';
import { seedFixtureUser } from './_helpers.js';

let server;

test.beforeAll(async () => {
    server = await startServer({
        batchKey: 'storage-inspector',
        scenarioId: 'sensitive-refresh',
    });
    await seedFixtureUser(server.dataRoot, 'default-user');
});

test.afterAll(async () => {
    await tearDownServer(server);
});

async function openInspector(page) {
    await awaitMainUI(page, server.baseURL);
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
    await profilePopup.locator('.userStorageInspectorButton').click();
    const inspector = page.locator('dialog.popup[open]').last().locator('.storageInspectorContainer');
    await inspector.waitFor({ state: 'visible', timeout: 10_000 });
    await inspector.locator('.storageInspectorLoading.displayNone').waitFor({ state: 'attached', timeout: 15_000 });
    return inspector;
}

test.describe('Storage Inspector · sensitive & refresh', () => {
    test('secrets.json shows lock, is not drillable, deep inspect returns 400', async ({ page }) => {
        const inspector = await openInspector(page);

        // Drill into Other.
        await inspector.locator('.storageInspectorEntry[data-key="other"]').click();
        await inspector.locator('.storageInspectorLoading.displayNone').waitFor({ state: 'attached', timeout: 15_000 });

        const secretsRow = inspector.locator('.storageInspectorEntry.storageInspectorSensitiveBlob');
        await expect(secretsRow).toBeVisible();

        // Sensitive blob rows have no chevron (canDrill=false → chevron is
        // not appended by the frontend renderer).
        await expect(secretsRow.locator('.storageInspectorEntryChevron')).toHaveCount(0);

        // Clicking it must not navigate — the row has no click handler
        // when canDrill=false. Breadcrumb stays on Other.
        await secretsRow.click({ force: true });
        await expect(inspector.locator('.storageInspectorBreadcrumbCurrent')).toHaveText(/Other|其他/);

        // Programmatic deep-inspect: bypasses the UI (which never sends
        // this path) to verify the endpoint's own guard. Runs through
        // page.request so the session cookie / CSRF headers propagate
        // exactly as they would from a browser fetch call.
        //
        // Read the CSRF token from the /csrf-token endpoint the app uses.
        const csrfResp = await page.request.get(`${server.baseURL}/csrf-token`);
        expect(csrfResp.ok()).toBe(true);
        const { token } = await csrfResp.json();
        const resp = await page.request.post(`${server.baseURL}/api/users/storage/inspect`, {
            data: { path: ['other', 'secrets.json', 'api_key_openai'] },
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
        });
        expect(resp.status()).toBe(400);
        const body = await resp.json();
        expect(body.error.code).toBe('E_NOT_INSPECTABLE');
    });

    test('refresh button re-fetches the current view', async ({ page }) => {
        let inspectCalls = 0;
        // Count inspect POSTs from the moment the page is created; the
        // initial L1 fetch on open bumps the counter to 1 before we start
        // asserting.
        page.on('request', (req) => {
            if (req.url().includes('/api/users/storage/inspect') && req.method() === 'POST') {
                inspectCalls++;
            }
        });

        const inspector = await openInspector(page);
        const initial = inspectCalls;
        // Sanity: opening the Inspector already fired at least one inspect
        // POST (the L1 fetch). If not, our request counter setup is broken.
        expect(initial).toBeGreaterThanOrEqual(1);

        await inspector.locator('.storageInspectorRefreshButton').click();
        // Wait for a new inspect POST to land — poll the counter rather
        // than a networkidle, which would be racy with the app's
        // background heartbeats.
        await expect.poll(() => inspectCalls, { timeout: 10_000 }).toBeGreaterThan(initial);
    });
});
