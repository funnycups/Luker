import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';
import { closeAllPopups, generatePairingLink, openLanSyncPanel } from '../_lib/sync.js';

test.describe.configure({ timeout: 180_000 });

const fixture = { server: null };

test.beforeAll(async () => {
    fixture.server = await startServer({ batchKey: 'sync', scenarioId: 'status-read-retry' });
    markOnboarded({ dataRoot: fixture.server.dataRoot });
});

test.afterAll(async () => { await tearDownServer(fixture.server); });

const STATUS_PATH = '/api/sync/v1/status';
const checks = page => page.evaluate(() => Number(document.body.dataset.syncStatusChecks || 0));
const pill = page => page.locator('#luker-sync-activity-pill');

/** Record every sync-status error toast the page ever renders. */
async function recordSyncToasts(page) {
    await page.addInitScript(() => {
        window.__syncStatusToasts = [];
        const record = () => {
            for (const element of document.querySelectorAll('#toast-container .toast-error')) {
                const text = element.textContent.trim();
                if (text && !window.__syncStatusToasts.includes(text)) window.__syncStatusToasts.push(text);
            }
        };
        // `document.documentElement` is still empty when an init script runs.
        new MutationObserver(record).observe(document, { childList: true, subtree: true, characterData: true });
        document.addEventListener('DOMContentLoaded', record);
    });
}

test('an interrupted status read retries and stays silent while no backend is configured', async ({ browser }) => {
    const context = await browser.newContext();
    let other;
    try {
        const page = await context.newPage();
        await recordSyncToasts(page);
        let attempts = 0;
        // Only the retry can answer this read: before it the next scheduled
        // check is 30 s away.
        const answered = page.waitForResponse(response => new URL(response.url()).pathname === STATUS_PATH && response.ok(), { timeout: 20_000 });
        await page.route(`**${STATUS_PATH}`, async route => {
            attempts += 1;
            if (attempts === 1) await route.abort('connectionfailed');
            else await route.continue();
        });
        try {
            await awaitMainUI(page, fixture.server.baseURL);
            // The first read fails with a transport error; the retry answers.
            await answered;
            await page.waitForFunction(() => Number(document.body.dataset.syncStatusChecks || 0) >= 1, null, { timeout: 60_000 });
            expect(attempts, 'the failed read must be retried').toBeGreaterThanOrEqual(2);
            expect((await page.evaluate(() => window.__syncStatusToasts)).filter(text => /sync status|同步状态|同步狀態/i.test(text)), 'a recovered read must not surface an error').toEqual([]);
            await expect(pill(page)).toBeHidden();
        } finally { await page.unroute(`**${STATUS_PATH}`); }

        let failed = 0;
        const allFail = async route => { failed += 1; await route.abort('connectionfailed'); };
        await page.route(`**${STATUS_PATH}`, allFail);
        try {
            const before = await checks(page);
            // A real tab switch, the same path that exposed the error.
            other = await context.newPage();
            await other.goto('about:blank');
            await other.bringToFront();
            await page.bringToFront();
            await page.waitForFunction(count => Number(document.body.dataset.syncStatusChecks || 0) > count, before, { timeout: 60_000 });
            expect(failed, 'the retry attempts a second read before giving up').toBeGreaterThanOrEqual(2);
            // The failure toast, if any, is rendered before the check settles.
            expect((await page.evaluate(() => window.__syncStatusToasts)).filter(text => /sync status|同步状态|同步狀態/i.test(text)), 'an account without sync has nothing to report').toEqual([]);
            await expect(pill(page)).toBeHidden();
        } finally { await page.unroute(`**${STATUS_PATH}`, allFail); }

        // Configure a real backend so status reads now matter to the user.
        await openLanSyncPanel(page);
        await generatePairingLink(page, { label: 'Peer', categories: ['worlds'] });
        await closeAllPopups(page);
        const sawConfigured = page.waitForResponse(response => new URL(response.url()).pathname === STATUS_PATH && response.ok(), { timeout: 60_000 });
        await other.bringToFront();
        await page.bringToFront();
        expect(Object.keys((await (await sawConfigured).json()).backends)).not.toEqual([]);

        let configuredFailed = 0;
        const allFailConfigured = async route => { configuredFailed += 1; await route.abort('connectionfailed'); };
        await page.route(`**${STATUS_PATH}`, allFailConfigured);
        try {
            const before = await checks(page);
            await other.bringToFront();
            await page.bringToFront();
            await page.waitForFunction(count => Number(document.body.dataset.syncStatusChecks || 0) > count, before, { timeout: 60_000 });
            expect(configuredFailed, 'the retry attempts a second read for a configured account too').toBeGreaterThanOrEqual(2);
            await expect(page.locator('#toast-container .toast-error', { hasText: /sync status|同步状态|同步狀態/i })).toBeVisible();
            await expect(pill(page)).toHaveAttribute('data-tone', 'unknown');
        } finally { await page.unroute(`**${STATUS_PATH}`, allFailConfigured); }
    } finally {
        await other?.close();
        await context.close();
    }
});
