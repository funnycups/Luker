// End-to-end verification for the post-update "What's New" modal:
// 1. Fresh install seeds lastSeenVersion and does NOT open the modal.
// 2. Multi-version upgrade renders the Workbench-styled modal with localized
//    multi-version changelog entries, rewrites relative docs links to
//    https://luker.cups.moe/..., and persists ack across page reloads.
// 3. Multi-user mode with an unread critical announcement waits until the
//    critical announcement popup is dismissed before showing the update modal.

import { test, expect } from '@playwright/test';
import path from 'node:path';
import storage from 'node-persist';

import { startServer, tearDownServer } from './_lib/server.js';
import { markOnboarded } from './_lib/fixtures.js';
import { awaitMainUI } from './_lib/page.js';
import { ANNOUNCEMENTS_STORAGE_KEY } from '../../src/announcements.js';

async function mutateUserStorage(dataRoot, mutator) {
    const store = storage.create({
        dir: path.join(dataRoot, '_storage'),
        ttl: false,
        expiredInterval: 0,
    });
    await store.init();
    await mutator(store);
}

test('fresh install stays silent; multi-version upgrade displays changelog, rewrites links, and persists ack', async ({ page }) => {
    let server = await startServer({ batchKey: 'server', scenarioId: 'single-user-upgrade' });
    const { dataRoot } = server;
    markOnboarded({ dataRoot });

    try {
        // 1. Fresh install: seeded at boot, must not display modal.
        const freshCheck = page.waitForResponse(
            res => res.url().endsWith('/api/users/whats-new') && res.status() === 200,
        );
        await awaitMainUI(page, server.baseURL);
        const freshRes = await freshCheck;
        expect(await freshRes.json()).toEqual({ show: false });
        await expect(page.locator('.wn-backdrop')).toHaveCount(0);

        // 2. Simulate upgrading from 2.9.0-rc.2 to current version on restart.
        await tearDownServer(server, { removeData: false });
        await mutateUserStorage(dataRoot, async (store) => {
            const user = await store.getItem('user:default-user');
            expect(user).toBeTruthy();
            user.lastSeenVersion = '2.9.0-rc.2';
            user.lastSeenRevision = '111111111';
            await store.setItem('user:default-user', user);
        });
        server = await startServer({
            batchKey: 'server',
            scenarioId: 'single-user-upgrade',
            useExistingDataRoot: dataRoot,
        });

        await page.addInitScript(() => {
            window.localStorage.setItem('language', 'zh-cn');
            window.localStorage.setItem('workbench.prefs.v1', JSON.stringify({ theme: 'light' }));
        });
        await awaitMainUI(page, server.baseURL);

        const backdrop = page.locator('.lw-dialog-backdrop.lw-surface.wn-backdrop');
        await expect(backdrop).toBeVisible({ timeout: 15_000 });
        await expect(backdrop).toHaveAttribute('data-theme', 'light');
        await expect(backdrop.locator('.lw-dialog-title')).toContainText('已更新至 Luker v');
        await expect(backdrop.locator('.wn-range-pill')).toContainText('v2.9.0-rc.2 → v');

        // Verify light-theme inline <code> color is dark readable text (not leaked host white70a).
        const codeColor = await backdrop.locator('.wn-md code').first().evaluate((el) => {
            const style = getComputedStyle(el);
            return style.color;
        });
        expect(codeColor).toBe('rgb(27, 29, 34)');

        const versionText = await backdrop.locator('.wn-body').textContent();
        expect(versionText).toContain('v2.9.0-rc.4');
        expect(versionText).toContain('v2.9.0-rc.3');
        expect(versionText).not.toContain('v2.9.0-rc.2');

        const docLink = backdrop.locator('.wn-body a[href="https://luker.cups.moe/zh-CN/features/workbench"]');
        await expect(docLink).toHaveCount(1);
        await expect(backdrop.locator('a.wn-changelog-link')).toHaveAttribute('href', 'https://luker.cups.moe/zh-CN/changelog');

        // 3. Click real "知道了" button and verify ack persists across reload.
        const ackPromise = page.waitForResponse(
            res => res.url().endsWith('/api/users/whats-new/ack') && res.status() === 204,
        );
        await backdrop.locator('button.lw-btn.is-primary').click();
        await ackPromise;
        await expect(backdrop).toHaveCount(0);

        const postReloadCheck = page.waitForResponse(
            res => res.url().endsWith('/api/users/whats-new') && res.status() === 200,
        );
        await awaitMainUI(page, server.baseURL);
        expect(await (await postReloadCheck).json()).toEqual({ show: false });
        await expect(page.locator('.wn-backdrop')).toHaveCount(0);
    } finally {
        await tearDownServer(server);
    }
});

test('multi-user mode waits for unread critical announcement before displaying What\'s New modal', async ({ page }) => {
    let server = await startServer({
        batchKey: 'server',
        scenarioId: 'multi-user-announcement-order',
        extraConfig: { enableUserAccounts: true },
    });
    const { dataRoot } = server;
    markOnboarded({ dataRoot });

    try {
        await tearDownServer(server, { removeData: false });
        await mutateUserStorage(dataRoot, async (store) => {
            const user = await store.getItem('user:default-user');
            expect(user).toBeTruthy();
            user.lastSeenVersion = '2.9.0-rc.3';
            user.lastSeenRevision = '111111111';
            user.readAnnouncementIds = [];
            await store.setItem('user:default-user', user);
            await store.setItem(ANNOUNCEMENTS_STORAGE_KEY, {
                items: [{
                    id: 'ann-critical-1',
                    level: 'critical',
                    title: 'Scheduled Maintenance',
                    body: 'Please finish saving your chats.',
                    createdAt: Date.now(),
                    createdBy: 'default-user',
                }],
            });
        });

        server = await startServer({
            batchKey: 'server',
            scenarioId: 'multi-user-announcement-order',
            extraConfig: { enableUserAccounts: true },
            useExistingDataRoot: dataRoot,
        });

        await page.addInitScript(() => {
            window.localStorage.setItem('language', 'en');
        });
        await awaitMainUI(page, server.baseURL);

        // Critical announcement popup must appear first; What's New must NOT stack over it.
        const announcementItem = page.locator('.announcement-item[data-id="ann-critical-1"]');
        await expect(announcementItem).toBeVisible({ timeout: 15_000 });
        await expect(page.locator('.wn-backdrop')).toHaveCount(0);

        // Dismiss the critical announcement popup -> What's New appears immediately after.
        await page.locator('.popup-button-ok').click();
        await expect(announcementItem).toHaveCount(0);

        const backdrop = page.locator('.wn-backdrop');
        await expect(backdrop).toBeVisible({ timeout: 15_000 });
        await expect(backdrop.locator('.wn-range-pill')).toContainText('v2.9.0-rc.3 → v');

        const ackPromise = page.waitForResponse(
            res => res.url().endsWith('/api/users/whats-new/ack') && res.status() === 204,
        );
        await backdrop.locator('button.lw-btn.is-primary').click();
        await ackPromise;
        await expect(backdrop).toHaveCount(0);
    } finally {
        await tearDownServer(server);
    }
});

test('announcements fetch failure still resolves gate and allows What\'s New modal to appear', async ({ page }) => {
    let server = await startServer({
        batchKey: 'server',
        scenarioId: 'announcements-fail-whats-new',
        extraConfig: { enableUserAccounts: true },
    });
    const { dataRoot } = server;
    markOnboarded({ dataRoot });

    try {
        await tearDownServer(server, { removeData: false });
        await mutateUserStorage(dataRoot, async (store) => {
            const user = await store.getItem('user:default-user');
            expect(user).toBeTruthy();
            user.lastSeenVersion = '2.9.0-rc.3';
            user.lastSeenRevision = '111111111';
            await store.setItem('user:default-user', user);
        });

        server = await startServer({
            batchKey: 'server',
            scenarioId: 'announcements-fail-whats-new',
            extraConfig: { enableUserAccounts: true },
            useExistingDataRoot: dataRoot,
        });

        // Simulate announcements backend failure: real announcements.js must still resolve its gate.
        await page.route('**/api/users/announcements/me/list', route => route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'simulated failure' }),
        }));
        await page.addInitScript(() => {
            window.localStorage.setItem('language', 'en');
        });
        await awaitMainUI(page, server.baseURL);

        const backdrop = page.locator('.wn-backdrop');
        await expect(backdrop).toBeVisible({ timeout: 15_000 });
        await backdrop.locator('button.lw-btn.is-primary').click();
        await expect(backdrop).toHaveCount(0);
    } finally {
        await tearDownServer(server);
    }
});
