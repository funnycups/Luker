// End-to-end verification for the post-update "What's New" modal:
// 1. Fresh install seeds lastSeenVersion and does NOT open the modal.
// 2. Multi-version upgrade renders the Workbench-styled modal with localized
//    multi-version changelog entries, rewrites relative docs links to
//    https://luker.cups.moe/..., and persists ack across page reloads.
// 3. Multi-user mode with an unread critical announcement waits until the
//    critical announcement popup is dismissed before showing the update modal.

import { test, expect } from '../harness/playwright.js';
import path from 'node:path';
import storage from 'node-persist';

import { startServer } from '../harness/server.js';
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

test('fresh install stays silent; multi-version upgrade displays changelog, rewrites links, and persists ack', async ({ page, resources }) => {
    const server = await startServer({ scope: resources, batchKey: 'server', scenarioId: 'single-user-upgrade' });
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
        await server.stop();
        await mutateUserStorage(dataRoot, async (store) => {
            const user = await store.getItem('user:default-user');
            expect(user).toBeTruthy();
            user.lastSeenVersion = '2.9.0-rc.2';
            user.lastSeenRevision = '111111111';
            await store.setItem('user:default-user', user);
        });
        await server.restart();

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

        // Verify whats-new.css wins over Workbench's @import of tokens.css (620px dialog, not shrunk to 480px).
        const desktopDialogWidth = await backdrop.locator('.wn-dialog').evaluate(el => Math.round(el.getBoundingClientRect().width));
        expect(desktopDialogWidth).toBeGreaterThanOrEqual(600);

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
        await server.stop();
    }
});

test('multi-user mode waits for unread critical announcement before displaying What\'s New modal', async ({ page, resources }) => {
    const server = await startServer({
        scope: resources,
        batchKey: 'server',
        scenarioId: 'multi-user-announcement-order',
        extraConfig: { enableUserAccounts: true },
    });
    const { dataRoot } = server;
    markOnboarded({ dataRoot });

    try {
        await server.stop();
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

        await server.restart();

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
        await server.stop();
    }
});

test('announcements fetch failure still resolves gate and allows What\'s New modal to appear', async ({ page, resources }) => {
    const server = await startServer({
        scope: resources,
        batchKey: 'server',
        scenarioId: 'announcements-fail-whats-new',
        extraConfig: { enableUserAccounts: true },
    });
    const { dataRoot } = server;
    markOnboarded({ dataRoot });

    try {
        await server.stop();
        await mutateUserStorage(dataRoot, async (store) => {
            const user = await store.getItem('user:default-user');
            expect(user).toBeTruthy();
            user.lastSeenVersion = '2.9.0-rc.3';
            user.lastSeenRevision = '111111111';
            await store.setItem('user:default-user', user);
        });

        await server.restart();

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
        await server.stop();
    }
});

test('mobile viewport keeps What\'s New modal within viewport, covers full screen scrim, scrolls cleanly, and stacks above Workbench pill', async ({ page, resources }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const server = await startServer({ scope: resources, batchKey: 'server', scenarioId: 'mobile-whats-new-layout' });
    const { dataRoot } = server;
    markOnboarded({ dataRoot });

    try {
        await server.stop();
        await mutateUserStorage(dataRoot, async (store) => {
            const user = await store.getItem('user:default-user');
            expect(user).toBeTruthy();
            user.lastSeenVersion = '2.9.0-rc.2';
            user.lastSeenRevision = '111111111';
            await store.setItem('user:default-user', user);
        });
        await server.restart();

        await page.addInitScript(() => {
            window.localStorage.setItem('language', 'zh-cn');
            window.localStorage.setItem('workbench.prefs.v1', JSON.stringify({ theme: 'light' }));
        });
        await awaitMainUI(page, server.baseURL);

        const backdrop = page.locator('.lw-dialog-backdrop.lw-surface.wn-backdrop');
        await expect(backdrop).toBeVisible({ timeout: 15_000 });

        const metrics = await page.evaluate(() => {
            const vpW = window.innerWidth;
            const vpH = window.innerHeight;
            const bd = document.querySelector('.wn-backdrop');
            const dlg = bd?.querySelector('.wn-dialog');
            const head = bd?.querySelector('.wn-head');
            const body = bd?.querySelector('.wn-body');
            const foot = bd?.querySelector('.wn-foot');
            const closeBtn = bd?.querySelector('.wn-head .lw-ibtn');
            const gotItBtn = bd?.querySelector('.wn-foot button.lw-btn.is-primary');
            const wb = document.querySelector('.wbench');
            const rect = (el) => {
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return {
                    top: Math.round(r.top),
                    left: Math.round(r.left),
                    right: Math.round(r.right),
                    bottom: Math.round(r.bottom),
                    width: Math.round(r.width),
                    height: Math.round(r.height),
                };
            };
            const closeRect = closeBtn?.getBoundingClientRect();
            const gotItRect = gotItBtn?.getBoundingClientRect();
            const hitClose = closeRect
                ? document.elementFromPoint(closeRect.left + closeRect.width / 2, closeRect.top + closeRect.height / 2)
                : null;
            const hitGotIt = gotItRect
                ? document.elementFromPoint(gotItRect.left + gotItRect.width / 2, gotItRect.top + gotItRect.height / 2)
                : null;
            const hitBottomCorner = document.elementFromPoint(4, vpH - 4);
            return {
                vpW,
                vpH,
                htmlRect: rect(document.documentElement),
                backdrop: rect(bd),
                dialog: rect(dlg),
                head: rect(head),
                body: rect(body),
                foot: rect(foot),
                bodyScrollHeight: body?.scrollHeight ?? 0,
                bodyClientHeight: body?.clientHeight ?? 0,
                bodyTouchAction: body ? getComputedStyle(body).touchAction : '',
                bodyOverscroll: body ? getComputedStyle(body).overscrollBehaviorY : '',
                closeHitInsideClose: Boolean(hitClose && closeBtn?.contains(hitClose)),
                gotItHitInsideGotIt: Boolean(hitGotIt && gotItBtn?.contains(hitGotIt)),
                bottomCornerHitsBackdrop: Boolean(hitBottomCorner && bd?.contains(hitBottomCorner)),
                backdropZ: bd ? Number(getComputedStyle(bd).zIndex || 0) : 0,
                wbZ: wb ? Number(getComputedStyle(wb).zIndex || 0) : 0,
                activeTag: document.activeElement?.tagName ?? '',
                activeIsPrimaryBtn: document.activeElement === gotItBtn,
            };
        });

        // 1. Backdrop must span the full visible viewport (no collapse to 0px/padding from html transform + fixed body).
        expect(metrics.backdrop.top).toBe(0);
        expect(metrics.backdrop.left).toBe(0);
        expect(metrics.backdrop.width).toBe(metrics.vpW);
        expect(metrics.backdrop.height).toBe(metrics.vpH);
        expect(metrics.bottomCornerHitsBackdrop).toBe(true);

        // 2. Dialog, header, body, and footer must sit strictly within the viewport with zero clipping.
        expect(metrics.dialog.top).toBeGreaterThanOrEqual(8);
        expect(metrics.dialog.left).toBeGreaterThanOrEqual(8);
        expect(metrics.dialog.right).toBeLessThanOrEqual(metrics.vpW - 8);
        expect(metrics.dialog.bottom).toBeLessThanOrEqual(metrics.vpH - 8);
        expect(metrics.head.top).toBeGreaterThanOrEqual(metrics.dialog.top);
        expect(metrics.head.height).toBeGreaterThanOrEqual(40);
        expect(metrics.foot.bottom).toBeLessThanOrEqual(metrics.dialog.bottom);
        expect(metrics.foot.height).toBeGreaterThanOrEqual(48);
        expect(metrics.closeHitInsideClose).toBe(true);
        expect(metrics.gotItHitInsideGotIt).toBe(true);

        // 3. Multi-version changelog body overflows and scrolls cleanly inside the dialog without moving header/footer.
        expect(metrics.bodyScrollHeight).toBeGreaterThan(metrics.bodyClientHeight);
        expect(metrics.bodyTouchAction).toContain('pan-y');
        expect(metrics.bodyOverscroll).toBe('contain');
        const scrolledTop = await page.evaluate(() => {
            const body = document.querySelector('.wn-body');
            body.scrollTop = 240;
            return body.scrollTop;
        });
        expect(scrolledTop).toBeGreaterThan(0);

        // 4. Stacks above Workbench layer when present, and initial focus does not paint a stray ring on primary button.
        expect(metrics.backdropZ).toBeGreaterThan(metrics.wbZ);
        expect(metrics.activeIsPrimaryBtn).toBe(false);

        // 5. Real dismiss via close button works cleanly on mobile.
        const ackPromise = page.waitForResponse(
            res => res.url().endsWith('/api/users/whats-new/ack') && res.status() === 204,
        );
        await backdrop.locator('.wn-head .lw-ibtn').click();
        await ackPromise;
        await expect(backdrop).toHaveCount(0);
    } finally {
        await server.stop();
    }
});
