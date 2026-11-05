// Genuine Sync walkthrough. Documentation images are opt-in; state assertions are not.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';

import { startServer, tearDownServer } from '../_lib/server.js';
import { startRustfsContainer } from '../_lib/s3-container.js';
import { startS3Proxy } from '../_lib/s3-proxy.js';
import { onboardS3Page, reloadS3Page, createReadyWorldBook, selectReadyWorldBook } from '../_lib/sync-s3.js';
import { addWorldEntry } from '../_lib/ui-worldinfo.js';
import { openCharacterList } from '../_lib/ui-character.js';
import { editMessageViaUI, renameCurrentChatViaUI, closeAnyOpenTopSettingsDrawer } from '../_lib/page.js';
import {
    openLanSyncPanel, generatePairingLink, acceptPairingLink, selectCategories, fillPairingForm,
    setSyncSchedule, setSyncDeviceLabel, waitForBackendSync, clickSyncNow, openAddBackend,
    closeAllPopups, waitForSyncPopup, syncPopup, closeSyncPopup, waitForStatusChecks,
    listPopupConflicts, listPopupNotices, conflictChoiceShowing, chooseConflictVersion, expandConflictDiff,
    applyConflictChoices, openBranchFromNotice, dismissNotice, openChatByName,
    fillS3Form, readUserFile, syncFlash, conflictRow, pairingLinkField,
} from '../_lib/sync.js';
import { accountWindow, pageHead, formError, windowConfirm } from '../_lib/account-window.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const IMAGES = path.join(ROOT, 'docs/public/images/sync');
const UPDATE_IMAGES = process.env.LUKER_UPDATE_DOC_SCREENSHOTS === '1';
const VIEWPORT = { width: 1440, height: 1400 };
const CATEGORIES = ['characters', 'chats', 'worlds'];
const AVATAR = 'default_Seraphina.png';
const CHAT_DIR = 'chats/default_Seraphina';
const LORE = 'worlds/Cascade Lore.json';
const WORDS = {
    base: 'The moonwell lies beyond the old cascade, where birches shelter the standing stones.',
    desk: 'Follow the birches north; the moonwell lies beyond the standing stones.',
    tablet: 'Stay beside the river until you hear the moonwell beneath the reeds.',
    later: 'Wait beneath the silver birch; I will bring the moonwell lantern when the mist clears.',
};
const MANIFEST = {
    pairing: ['01-panel-empty', '02-pair-new-form-filled', '03-pair-link-generated', '04-pair-existing-pasted',
        '05-pair-success-banner', '06-backends-after-pair', '07-conflict-banner', '08-conflict-popup', '09-resolved-success'],
    stale: ['conflict-stale', 'conflict-stale-confirm'],
    storage: ['s3-form', 's3-second-device-passphrase', 'backend-list', 'sync-activity'],
    characterFork: ['chat-fork-notice'],
    groupFork: ['group-chat-fork-notice'],
    characterRestore: ['chat-restored-notice'],
    groupRestore: ['group-chat-restored-notice'],
};
const FILENAMES = Object.values(MANIFEST).flat();
test.describe.configure({ mode: 'default', timeout: 300_000 });

test.beforeAll(() => {
    expect(new Set(FILENAMES).size, 'Documentation image filenames must be unique').toBe(FILENAMES.length);
});

// The Account window replaced the sync panel, its popups and the S3 form popup.
const panel = page => accountWindow(page);
const backend = (page, label) => accountWindow(page).locator('.dw-card[data-backend]').filter({ has: page.locator('.dw-card-name', { hasText: new RegExp(`^${RegExp.escape(label)}$`) }) });
const conflict = page => conflictRow(page, LORE);
const observe = promise => promise.then(value => ({ value }), error => ({ error }));
async function observed(promise) {
    const result = await promise;
    if (result.error) throw result.error;
    return result.value;
}
const statusChecks = page => page.evaluate(() => Number(document.body.dataset.syncStatusChecks || 0));
async function status(page) {
    const result = await page.evaluate(async () => {
        const response = await fetch('/api/sync/v1/status');
        if (!response.ok) throw new Error(`Sync status returned HTTP ${response.status}`);
        return response.json();
    });
    expect(result.ok, 'Walkthrough decisions require a complete, readable pending-status response').toBe(true);
    expect(result.errors, 'An unreadable backend cannot establish that pending decisions are absent').toEqual({});
    return result;
}

/** All ownership is local to a scenario, including startup and assertion failure exits. */
async function journey(browser, testInfo, name, body) {
    const servers = [], contexts = [], proxies = [], storage = [], jobs = [], holds = [];
    const captured = [];
    const frames = [];
    const failures = [];
    const scope = {
        async device(label, { lan = false } = {}) {
            const server = await startServer({ batchKey: 'sync', scenarioId: `docs-${name}-${label}-${randomBytes(4).toString('hex')}`,
                extraConfig: lan ? { listen: true, securityOverride: true, whitelistMode: false } : null });
            servers.push(server);
            const context = await browser.newContext({ viewport: VIEWPORT, locale: 'en-US', timezoneId: 'UTC' });
            contexts.push(context);
            const page = await context.newPage();
            await onboardS3Page(page, server.baseURL);
            await reloadS3Page(page);
            await openLanSyncPanel(page);
            await setSyncSchedule(page, { idleSeconds: 3600, pollSeconds: 3600 });
            await setSyncDeviceLabel(page, label);
            await expect(accountWindow(page).locator('[data-model="device.label"]')).toHaveValue(label);
            await leavePanels(page);
            return { server, page, context, label };
        },
        async storage() {
            const provider = await startRustfsContainer();
            storage.push(provider);
            const sdk = new S3Client({ endpoint: provider.endpoint, region: provider.region, forcePathStyle: true,
                credentials: { accessKeyId: provider.accessKeyId, secretAccessKey: provider.secretAccessKey }, maxAttempts: 1 });
            const bucket = `seraphina-${randomBytes(8).toString('hex')}`;
            try { await sdk.send(new CreateBucketCommand({ Bucket: bucket })); } finally { sdk.destroy(); }
            const proxy = await startS3Proxy({ upstream: provider.endpoint, region: provider.region,
                credentials: { accessKeyId: provider.accessKeyId, secretAccessKey: provider.secretAccessKey } });
            proxies.push(proxy);
            return { proxy, options: { ...provider, endpoint: proxy.endpoint, bucket, prefix: 'seraphina/', label: 'Shared archive',
                passphrase: 'Silver birches shelter the moonwell', forcePathStyle: true, categories: ['worlds'] } };
        },
        response(page, endpoint, timeout = 60_000) {
            const waiting = page.waitForResponse(response => new URL(response.url()).pathname === endpoint, { timeout });
            const job = observe(waiting);
            jobs.push(job);
            return job;
        },
        hold(proxy) {
            const hold = proxy.addFault({ match: { method: 'GET', keySuffix: '/head' }, hold: 'before-forward' });
            holds.push(hold);
            return hold;
        },
        record(name, value) {
            return testInfo.attach(name, { body: JSON.stringify(value, null, 2), contentType: 'application/json' });
        },
        async capture(id, page, target, assertions) {
            await test.step(`${id}: required real state`, async () => {
                await assertions();
                await dismissToasts(page);
                await expect(page.locator('dialog.popup[open][opening]')).toHaveCount(0);
                await expect(target, `${id}: capture region must be visible`).toBeVisible();
                await target.scrollIntoViewIfNeeded();
                await expect(target, `${id}: the complete region and its actions must fit the native viewport`).toBeInViewport({ ratio: 1 });
            });

            expect(FILENAMES, `Unknown documentation capture ${id}`).toContain(id);
            expect(captured, `Duplicate documentation capture ${id}`).not.toContain(id);
            captured.push(id);
            frames.push({ id, bounds: await target.boundingBox() });

            if (!UPDATE_IMAGES) return;

            fs.mkdirSync(IMAGES, { recursive: true });
            await target.screenshot({ path: path.join(IMAGES, `${id}.png`) });
        },
    };
    try {
        await body(scope);
        expect([...captured].sort(), `${name}: every named capture must be reached even with screenshots disabled`).toEqual([...MANIFEST[name]].sort());
        await testInfo.attach('documentation-captures', { body: JSON.stringify({ updateImages: UPDATE_IMAGES, captured, viewport: VIEWPORT, frames }), contentType: 'application/json' });
    } catch (error) {
        failures.push(error);
    } finally {
        for (const hold of holds) hold.release();
        // Release real storage before settling callers; their timeout remains bounded.
        const settled = await Promise.all(jobs);
        failures.push(...settled.flatMap(result => result.error ? [result.error] : []));
        const closed = await Promise.allSettled(contexts.map(context => context.close()));
        const stoppedProxies = await Promise.allSettled(proxies.map(proxy => proxy.close()));
        const attached = await Promise.allSettled(servers.map((server, index) => testInfo.attach(`server-${index}.log`, { body: server.output, contentType: 'text/plain' })));
        const stopped = await Promise.allSettled(servers.map(server => tearDownServer(server)));
        const stoppedStorage = await Promise.allSettled(storage.map(provider => provider.stop()));
        failures.push(...[...closed, ...stoppedProxies, ...attached, ...stopped, ...stoppedStorage].filter(result => result.status === 'rejected').map(result => result.reason));
        const recorded = await Promise.allSettled([scope.record('resource-settlement', {
            contexts: closed.map(result => result.status),
            proxies: stoppedProxies.map(result => result.status),
            servers: stopped.map((result, index) => ({ port: servers[index].port, execArgv: servers[index].execArgv, status: result.status })),
            storage: stoppedStorage.map(result => result.status),
            requests: settled.map(result => result.error ? 'rejected' : 'fulfilled'),
            releasedHolds: holds.length,
        })]);
        failures.push(...recorded.filter(result => result.status === 'rejected').map(result => result.reason));
    }
    if (failures.length) throw new AggregateError(failures, `${name}: walkthrough or cleanup failed`, { cause: failures[0] });
    return captured;
}

async function dismissToasts(page) {
    const toasts = page.locator('#toast-container .toast:visible');
    while (await toasts.count()) {
        // Keep this notification's identity; the next toast becomes .first() on dismissal.
        const toast = await toasts.first().elementHandle();
        await toast.click();
        await expect.poll(() => toast.evaluate(element => element.isConnected)).toBe(false);
    }
}

async function leavePanels(page) {
    await closeAllPopups(page);
    await closeAnyOpenTopSettingsDrawer(page);
    await dismissToasts(page);
}

/** The chips of one sync content picker (`set`) that are selected. */
async function assertCategories(page, set, categories) {
    const chips = accountWindow(page).locator(`[data-act="cat"][data-set="${set}"]`);
    await expect(chips.first()).toBeVisible();
    expect(await chips.evaluateAll(els => els.filter(el => el.classList.contains('on')).map(el => el.dataset.id).sort())).toEqual([...categories].sort());
}

async function assertBackend(page, label, kind) {
    const row = backend(page, label);
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute('data-kind', kind);
    await expect(row.locator('.dw-kind')).toHaveText(kind.toUpperCase());
    await expect(row.locator('.dw-card-meta')).not.toContainText('Never synced');
    await expect(row.locator('[data-act="sync-now"]')).toBeVisible();
    await expect(row.locator('[data-act="sync-now"]')).toHaveText('Sync now');
    // Undo, Edit and Remove live in the card's menu.
    await row.locator('[data-act="menu"]').click();
    for (const [act, text] of [['undo', 'Undo last sync'], ['edit', 'Edit'], ['remove', 'Remove'], ...(kind === 's3' ? [['unlock', 'Unlock']] : [])]) {
        await expect(row.locator(`.dw-menu [data-act="${act}"]`)).toBeVisible();
        await expect(row.locator(`.dw-menu [data-act="${act}"]`)).toHaveText(text);
    }
    await row.locator('[data-act="menu"]').click();
    await expect(row.locator('.dw-menu')).toHaveCount(0);
    await expect(row).not.toHaveClass(/\blocked\b/);
}

async function createLore(device) {
    await createReadyWorldBook(device.page, 'Cascade Lore');
    await expect.poll(() => readUserFile(device.server, LORE), { timeout: 30_000 }).not.toBeNull();
    await closeAnyOpenTopSettingsDrawer(device.page);
}

async function addLore(device, content) {
    await selectReadyWorldBook(device.page, 'Cascade Lore');
    await addWorldEntry(device.page, { key: 'moonwell', content });
    await expect.poll(() => readUserFile(device.server, LORE), { timeout: 30_000 }).toContain(content);
    await closeAnyOpenTopSettingsDrawer(device.page);
}

async function paired(a, b, categories = CATEGORIES) {
    await openLanSyncPanel(a.page);
    const link = await generatePairingLink(a.page, { label: 'Tablet', categories });
    await openLanSyncPanel(b.page);
    const since = Date.now();
    expect(await acceptPairingLink(b.page, link, { categories, localLabel: 'Desk' })).toBe('success');
    await settlePair(a, b, since);
    await leavePanels(a.page);
    await leavePanels(b.page);
    await reloadS3Page(a.page);
    await reloadS3Page(b.page);
}

async function settlePair(a, b, since) {
    await waitForBackendSync(a.page, { label: 'Tablet', since });
    await waitForBackendSync(b.page, { label: 'Desk', since });
}

async function divergentLore(a, b) {
    await addLore(a, WORDS.desk);
    await addLore(b, WORDS.tablet);
    await openLanSyncPanel(b.page);
    expect(await clickSyncNow(b.page, 'Desk')).toBe('warning');
    await waitForSyncPopup(b.page);
    expect(await listPopupConflicts(b.page)).toEqual([{ path: LORE, stale: false }]);
}

async function assertLoreCards(page, { stale = false } = {}) {
    const row = conflict(page);
    const titles = row.locator('.dw-version:not([data-v="current"]) .dw-version-head > span:nth-child(2)');
    await expect(row.locator('.dw-conflict-head b')).toHaveText(LORE);
    await expect(row.locator('.dw-version[data-v="current"] .dw-version-head')).toHaveText('Current version');
    await expect(row.locator('.dw-version[data-v="current"] .dw-pilltag')).toHaveCount(0);
    await expect(titles).toContainText(['Version from', 'Version from']);
    expect((await titles.allTextContents()).sort()).toEqual(['Version from Desk', 'Version from Tablet']);
    await expect(row.locator('.dw-version .dw-pilltag.is-ok')).toHaveCount(1);
    await expect(row.locator('.dw-preview')).toHaveCount(0);
    await expect(row.locator('.dw-banner.warning')).toHaveCount(stale ? 1 : 0);
    const diff = row.locator('.syncConflictDiff').first();
    await expect(diff).toBeVisible();
    await expect(diff.locator('.syncConflictDiffSummary')).not.toHaveText('Comparing versions…');
    await expect(diff.locator('.syncDiffSection').first()).toBeVisible();
    await expect(syncPopup(page).locator('[data-act="apply"]')).toBeVisible();
    await expect(syncPopup(page).locator('[data-act="apply"]')).toHaveText('Apply choices');
}

async function assertNoPendingAfterReload(device) {
    await reloadS3Page(device.page);
    await waitForStatusChecks(device.page, 1);
    expect((await status(device.page)).conflicts).toEqual([]);
    await expect(syncPopup(device.page)).toHaveCount(0);
    await expect(device.page.locator('.dw-conflict')).toHaveCount(0);
}

test('LAN pairing, pending lore and resolution images', async ({ browser }, testInfo) => {
    await journey(browser, testInfo, 'pairing', async scope => {
        const a = await scope.device('Desk', { lan: true });
        const b = await scope.device('Tablet', { lan: true });
        await createLore(a);
        await openLanSyncPanel(a.page);
        await scope.capture('01-panel-empty', a.page, panel(a.page), async () => {
            await expect(pageHead(a.page).locator('.dw-h2')).toHaveText('Sync');
            await expect(pageHead(a.page)).toHaveAttribute('data-view', 'list');
            await expect(panel(a.page).locator('.dw-empty')).toContainText('No sync backends yet');
            await expect(panel(a.page).locator('.dw-empty [data-act="push"][data-view="add"]')).toBeVisible();
            // The sync schedule moved to its own Device settings page.
            await expect(panel(a.page).locator('.dw-tab[data-tab="settings"]')).toContainText('Device settings');
        });
        await openAddBackend(a.page, 'pairNew');
        await panel(a.page).locator('[data-model="top.label"]').fill('Tablet');
        await selectCategories(panel(a.page), CATEGORIES, 'pairNew');
        await scope.capture('02-pair-new-form-filled', a.page, panel(a.page), async () => {
            await expect(panel(a.page).locator('[data-model="top.label"]'), '02-pair-new-form-filled must identify Tablet, not the old generic device').toHaveValue('Tablet');
            await assertCategories(a.page, 'pairNew', CATEGORIES);
            await expect(panel(a.page).locator('[data-act="pair-gen"]')).toBeVisible();
        });
        const link = await generatePairingLink(a.page, { label: 'Tablet', categories: CATEGORIES });
        const parsed = new URL(link);
        await scope.capture('03-pair-link-generated', a.page, panel(a.page), async () => {
            await expect(pairingLinkField(a.page)).toHaveValue(link);
            await expect(panel(a.page).locator('.dw-step').first()).toHaveText('Link generated. "Tablet" was added to the sync list and is waiting for the other device to connect');
            const select = panel(a.page).locator('select[data-act-change="pair-addr"]');
            await expect(select).toBeVisible();
            const bases = await select.locator('option').evaluateAll(options => options.map(option => option.value));
            expect(bases.some(base => !['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname)), 'LAN-listening fixture must offer a non-loopback address').toBe(true);
            expect(parsed.searchParams.get('base')).toBe(await select.inputValue());
            await expect(panel(a.page).locator('.dw-banner.warning')).toHaveCount(0);
            await expect(panel(a.page).locator('.dw-linkbox [data-act="copy"]')).toBeVisible();
        });
        await openLanSyncPanel(b.page);
        await fillPairingForm(b.page, link, { categories: CATEGORIES, localLabel: 'Desk' });
        await scope.capture('04-pair-existing-pasted', b.page, panel(b.page), async () => {
            await expect(panel(b.page).locator('summary.dw-more')).toHaveText('Enter manually / the other device has a login password');
            for (const [model, value] of [['top.form.url', parsed.searchParams.get('base')], ['top.form.peerId', parsed.searchParams.get('peer')]]) {
                await expect(panel(b.page).locator(`[data-model="${model}"]`)).toBeVisible();
                await expect(panel(b.page).locator(`[data-model="${model}"]`)).toHaveValue(value);
            }
            await expect(panel(b.page).locator('[data-model="top.form.link"]')).toHaveValue(link);
            await expect(panel(b.page).locator('[data-model="top.form.label"]')).toHaveValue('Desk');
            await assertCategories(b.page, 'pairExist', CATEGORIES);
            await expect(panel(b.page).locator('[data-act="pair-accept"]')).toBeVisible();
        });
        const since = Date.now();
        const accepted = scope.response(b.page, '/api/sync/v1/pair/accept');
        await panel(b.page).locator('[data-act="pair-accept"]').click();
        expect((await observed(accepted)).ok()).toBe(true);
        await settlePair(a, b, since);
        await scope.capture('05-pair-success-banner', b.page, panel(b.page), async () => {
            await expect(syncFlash(b.page)).toHaveAttribute('data-flash', 'success');
            await expect(syncFlash(b.page)).toContainText('Paired and synced with "Desk"');
            expect(readUserFile(b.server, LORE)).toBe(readUserFile(a.server, LORE));
        });
        await scope.capture('06-backends-after-pair', b.page, panel(b.page), () => assertBackend(b.page, 'Desk', 'lan'));
        await leavePanels(a.page);
        await leavePanels(b.page);
        await reloadS3Page(b.page);
        await divergentLore(a, b);
        // The result banner stays on the Sync list the issues page was opened from.
        await pageHead(b.page).locator('[data-act="back"]').click();
        await expect(pageHead(b.page)).toHaveAttribute('data-view', 'list');
        await scope.capture('07-conflict-banner', b.page, syncFlash(b.page), async () => {
            await expect(syncFlash(b.page)).toHaveAttribute('data-flash', 'warning');
            await expect(syncFlash(b.page)).toContainText('Synced with "Desk"; 1 files need you to choose a version');
            expect((await status(b.page)).conflicts.map(entry => entry.path)).toEqual([LORE]);
        });
        await syncFlash(b.page).locator('[data-act="conflicts"]').click();
        await waitForSyncPopup(b.page);
        await scope.capture('08-conflict-popup', b.page, panel(b.page), () => assertLoreCards(b.page));
        await closeSyncPopup(b.page);
        await reloadS3Page(b.page);
        await waitForStatusChecks(b.page, 1);
        await waitForSyncPopup(b.page);
        expect(await listPopupConflicts(b.page)).toEqual([{ path: LORE, stale: false }]);
        await chooseConflictVersion(b.page, LORE, await conflictChoiceShowing(b.page, LORE, WORDS.desk));
        expect(await applyConflictChoices(b.page)).toBe('success');
        for (const device of [a, b]) {
            await expect.poll(() => readUserFile(device.server, LORE), { timeout: 60_000 }).toContain(WORDS.desk);
            expect(readUserFile(device.server, LORE)).not.toContain(WORDS.tablet);
        }
        await openLanSyncPanel(b.page);
        expect(await clickSyncNow(b.page, 'Desk')).toBe('success');
        await scope.capture('09-resolved-success', b.page, panel(b.page), async () => {
            await expect(syncFlash(b.page)).toHaveAttribute('data-flash', 'success');
            await expect(syncFlash(b.page)).toContainText('Synced with "Desk"');
            expect((await status(b.page)).conflicts).toEqual([]);
        });
        await assertNoPendingAfterReload(b);
        await assertNoPendingAfterReload(a);
    });
});

test('Stale lore preview and cancelled then confirmed overwrite images', async ({ browser }, testInfo) => {
    await journey(browser, testInfo, 'stale', async scope => {
        const a = await scope.device('Desk');
        const b = await scope.device('Tablet');
        await createLore(a);
        await paired(a, b, ['worlds']);
        await divergentLore(a, b);
        await leavePanels(b.page);
        await selectReadyWorldBook(b.page, 'Cascade Lore');
        const entry = b.page.locator('#world_popup_entries_list .world_entry[uid]');
        await expect(entry).toHaveCount(1);
        const content = entry.locator('textarea[name="content"]');
        if (!await content.isVisible()) await entry.locator('.wi-entry-toggle').click();
        await content.fill(WORDS.later);
        await content.blur();
        await expect.poll(() => readUserFile(b.server, LORE), { timeout: 30_000 }).toContain(WORDS.later);
        await closeAnyOpenTopSettingsDrawer(b.page);
        await openLanSyncPanel(b.page);
        expect(await clickSyncNow(b.page, 'Desk')).toBe('warning');
        await reloadS3Page(b.page);
        await waitForSyncPopup(b.page);
        await scope.capture('conflict-stale', b.page, panel(b.page), async () => {
            await assertLoreCards(b.page, { stale: true });
            await expect(conflict(b.page).locator('.dw-banner.warning')).toContainText('This file was edited again after the conflict');
            await expect(await expandConflictDiff(b.page, LORE, { index: 1 })).toContainText(WORDS.later);
        });
        await chooseConflictVersion(b.page, LORE, await conflictChoiceShowing(b.page, LORE, WORDS.desk));
        await syncPopup(b.page).locator('[data-act="apply"]').click();
        const confirm = windowConfirm(b.page);
        await scope.capture('conflict-stale-confirm', b.page, confirm.locator('.dw-modal-card'), async () => {
            await expect(confirm).toContainText(`Overwrite "${path.posix.basename(LORE)}"?`);
            await expect(confirm.locator('[data-r="1"]')).toHaveText('Overwrite');
            await expect(confirm.locator('[data-r="0"]')).toHaveText('Cancel');
        });
        const unchanged = readUserFile(b.server, LORE);
        await confirm.locator('[data-r="0"]').click();
        await expect(confirm).toHaveCount(0);
        expect(readUserFile(b.server, LORE)).toBe(unchanged);
        expect(await listPopupConflicts(b.page)).toEqual([{ path: LORE, stale: true }]);
        expect((await status(b.page)).conflicts.map(row => row.path)).toEqual([LORE]);
        expect(await applyConflictChoices(b.page, { confirmOverwrite: true })).toBe('success');
        for (const device of [a, b]) {
            await expect.poll(() => readUserFile(device.server, LORE), { timeout: 60_000 }).toContain(WORDS.desk);
            expect(readUserFile(device.server, LORE)).not.toContain(WORDS.later);
        }
        await assertNoPendingAfterReload(b);
    });
});

async function assertS3Form(page, options) {
    const win = accountWindow(page);
    const field = model => win.locator(`[data-model="top.form.${model}"]`);
    await expect(pageHead(page)).toHaveAttribute('data-view', 's3');
    await expect(pageHead(page).locator('.dw-h2')).toHaveText('Add S3 storage');
    for (const [model, value] of [['label', options.label], ['endpoint', options.endpoint], ['bucket', options.bucket], ['prefix', 'seraphina/']]) {
        await expect(field(model)).toBeVisible();
        await expect(field(model)).toHaveValue(value);
    }
    await expect(field('region')).toHaveValue(options.region);
    for (const [model, value] of [['accessKey', options.accessKeyId], ['secretKey', options.secretAccessKey], ['passphrase', options.passphrase]]) {
        await expect(field(model)).toHaveAttribute('type', 'password');
        await expect(field(model)).toHaveValue(value);
        await expect(field(model)).toBeVisible();
    }
    await expect(win.locator('label.dw-field', { has: field('passphrase') })).toContainText('Encryption passphrase');
    await assertCategories(page, 's3', ['worlds']);
    await expect(win.locator('[data-act="s3-save"]')).toBeVisible();
}

async function submitS3(scope, page, { rejected = false } = {}) {
    const response = scope.response(page, '/api/sync/v1/backends/s3');
    await accountWindow(page).locator('[data-act="s3-save"]').click();
    const actual = await observed(response);
    if (rejected) {
        expect(actual.status()).toBe(422);
        expect(await actual.json()).toMatchObject({ code: 'S3_WRONG_PASSPHRASE' });
        await expect(pageHead(page)).toHaveAttribute('data-view', 's3');
        await expect(formError(page)).toHaveText('The passphrase does not match this bucket and prefix.');
        return;
    }
    expect(actual.ok()).toBe(true);
    await expect(pageHead(page)).toHaveAttribute('data-view', 'list', { timeout: 60_000 });
    await waitForBackendSync(page, { label: 'Shared archive' });
}

test('S3 setup, second-device pull, mixed backends and genuine active capsule images', async ({ browser }, testInfo) => {
    await journey(browser, testInfo, 'storage', async scope => {
        const { options, proxy } = await scope.storage();
        const a = await scope.device('Desk');
        const b = await scope.device('Tablet');
        await createLore(a);
        await addLore(a, WORDS.base);
        await openAddBackend(a.page, 's3');
        await fillS3Form(a.page, options);
        await scope.capture('s3-form', a.page, panel(a.page), () => assertS3Form(a.page, options));
        await submitS3(scope, a.page);
        await openAddBackend(b.page, 's3');
        const wrong = { ...options, passphrase: 'The river lantern is not the moonwell key' };
        await fillS3Form(b.page, wrong);
        await scope.capture('s3-second-device-passphrase', b.page, panel(b.page), () => assertS3Form(b.page, wrong));
        await submitS3(scope, b.page, { rejected: true });
        await accountWindow(b.page).locator('[data-model="top.form.passphrase"]').fill(options.passphrase);
        await submitS3(scope, b.page);
        expect(readUserFile(b.server, LORE)).toContain(WORDS.base);
        await leavePanels(b.page);
        await reloadS3Page(b.page);
        await selectReadyWorldBook(b.page, 'Cascade Lore');
        const content = b.page.locator('#world_popup_entries_list textarea[name="content"]');
        if (!await content.isVisible()) await b.page.locator('#world_popup_entries_list .wi-entry-toggle').click();
        await expect(content).toHaveValue(WORDS.base);
        await closeAnyOpenTopSettingsDrawer(b.page);
        await leavePanels(a.page);
        await paired(a, b, ['worlds']);
        await openLanSyncPanel(a.page);
        await scope.capture('backend-list', a.page, panel(a.page), async () => {
            await assertBackend(a.page, 'Tablet', 'lan');
            // assertBackend also checks the Unlock entry of the S3 card's menu.
            await assertBackend(a.page, 'Shared archive', 's3');
            // The device name shows in the summary; the schedule is on Device settings.
            await expect(panel(a.page).locator('.dw-summary')).toContainText('This device Desk');
        });
        await leavePanels(a.page);
        await selectSeraphina(a.page);
        await editMessageViaUI(a.page, 0, WORDS.desk);
        await renameChat(a.page, 'Forest Path');
        await openLanSyncPanel(a.page);
        const id = await backend(a.page, 'Shared archive').getAttribute('data-backend');
        const held = scope.hold(proxy);
        const response = scope.response(a.page, `/api/sync/v1/backends/${id}/sync`, 90_000);
        await backend(a.page, 'Shared archive').locator('[data-act="sync-now"]').click();
        await expect.poll(() => proxy.requests.some(request => request.method === 'GET' && request.relativeKey === 'seraphina/head' && !request.responseDelivered && !request.closed), { timeout: 30_000, message: 'Active capsule must be backed by a genuinely held storage read' }).toBe(true);
        await held.reached;
        await leavePanels(a.page);
        const composer = a.page.locator('#send_textarea');
        await composer.fill('*I raise the lantern beneath the birches.* "Show me the way to the moonwell."');
        await composer.focus();
        await waitForStatusChecks(a.page, await statusChecks(a.page) + 1);
        const pill = a.page.locator('#luker-sync-activity-pill');
        await scope.capture('sync-activity', a.page, a.page.locator('#sheld'), async () => {
            await expect(composer).toBeFocused();
            await expect(composer).toHaveValue(/moonwell/);
            await expect(panel(a.page)).toHaveCount(0);
            await expect(pill).toHaveText('Syncing: Shared archive');
            await expect(pill).toHaveAttribute('data-tone', 'running');
            await expect(pill.getByRole('progressbar')).toBeVisible();
            await expect(pill.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
            await expect(pill).not.toContainText(/\d+%|elapsed|phase/i);
        });
        await expect(composer).toBeFocused();
        await pill.click();
        await expect(panel(a.page)).toHaveCount(1);
        await expect(backend(a.page, 'Shared archive')).toHaveClass(/\blocked\b/);
        held.release();
        expect((await observed(response)).ok()).toBe(true);
        await waitForBackendSync(a.page, { label: 'Shared archive' });
        await expect(pill).toBeHidden({ timeout: 15_000 });
    });
});

async function selectSeraphina(page) {
    await closeAllPopups(page);
    await closeAnyOpenTopSettingsDrawer(page);
    await openCharacterList(page);
    const card = page.locator('#rm_print_characters_block .character_select').filter({ has: page.locator(`img[src*="file=${AVATAR}"]`) });
    await expect(card, 'Bundled Seraphina avatar must be selected unambiguously').toHaveCount(1);
    await card.click();
    await page.waitForFunction(avatar => {
        const context = window.Luker.getContext();
        return context.characters[context.characterId]?.avatar === avatar && !context.groupId && context.chat.length > 0;
    }, AVATAR);
    await expect(page.locator('#character_name_pole')).toHaveValue('Seraphina');
    await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).not.toBeEmpty();
    await closeAnyOpenTopSettingsDrawer(page);
}

async function renameChat(page, name) {
    await renameCurrentChatViaUI(page, name);
    // Renaming schedules a real reopening of Manage chat files after its save.
    await expect(page.locator('#shadow_select_chat_popup')).toBeVisible();
    await expect(page.locator('.select_chat_block_filename', { hasText: new RegExp(`^\\s*${RegExp.escape(name)}(\\.jsonl)?\\s*$`) })).toHaveCount(1);
    await page.locator('#select_chat_cross').click();
    await expect(page.locator('#shadow_select_chat_popup')).toBeHidden();
}

async function createCharacterChat(device) {
    await selectSeraphina(device.page);
    await editMessageViaUI(device.page, 0, WORDS.base);
    await renameChat(device.page, 'Forest Path');
    await expect.poll(() => readUserFile(device.server, `${CHAT_DIR}/Forest Path.jsonl`)).toContain(WORDS.base);
}

async function openGroup(device, id, chat = 'River Ford') {
    await closeAllPopups(device.page);
    await closeAnyOpenTopSettingsDrawer(device.page);
    await openCharacterList(device.page);
    const card = device.page.locator(`#rm_print_characters_block .group_select[data-grid="${id}"]`);
    await expect(card).toHaveCount(1);
    await card.click();
    await device.page.waitForFunction(({ id, chat }) => {
        const context = window.Luker.getContext();
        return context.groupId === id && context.getCurrentChatId() === chat;
    }, { id, chat });
    await expect(device.page.locator('#rm_group_chat_name')).toHaveValue('Moonwell Watch');
    await expect(device.page.locator('#chat .mes[mesid="0"] .mes_text')).not.toBeEmpty();
    await closeAnyOpenTopSettingsDrawer(device.page);
}

async function createGroup(device, scope) {
    await openCharacterList(device.page);
    await device.page.locator('#rm_button_group_chats').click();
    await device.page.locator('#rm_group_chat_name').fill('Moonwell Watch');
    const member = device.page.locator('#rm_group_add_members .group_member').filter({ has: device.page.locator(`img[title="${AVATAR}"]`) });
    await expect(member).toHaveCount(1);
    await member.locator('[data-action="add"]').click();
    await expect(device.page.locator('#rm_group_members .group_member')).toHaveCount(1);
    const created = scope.response(device.page, '/api/groups/create');
    await device.page.locator('#rm_group_submit').click();
    const response = await observed(created);
    expect(response.ok()).toBe(true);
    const { id } = await response.json();
    await expect(device.page.locator('.toast-success', { hasText: 'Group Created' })).toBeVisible();
    await openCharacterList(device.page);
    await device.page.locator(`#rm_print_characters_block .group_select[data-grid="${id}"]`).click();
    await device.page.waitForFunction(id => {
        const context = window.Luker.getContext();
        return context.groupId === id && !!context.chatMetadata.integrity && context.chat.length > 0;
    }, id);
    await expect(device.page.locator('#chat .mes[mesid="0"] .mes_text')).not.toBeEmpty();
    await closeAnyOpenTopSettingsDrawer(device.page);
    // Start a real conversation through the composer's native no-generation command.
    // Check its persisted transcript before preparing any shared sync history.
    const firstTurn = '*I lift the lantern over the reeds.* "Will you guide me across the ford?"';
    const initialChat = await device.page.evaluate(() => window.Luker.getContext().getCurrentChatId());
    const greetingText = await device.page.evaluate(() => window.Luker.getContext().chat[0].mes);
    await device.page.locator('#send_textarea').fill(`/send ${firstTurn}`);
    await device.page.locator('#send_textarea').press('Enter');
    await expect(device.page.locator('#chat .mes[mesid="1"] .mes_text')).toContainText('Will you guide me across the ford?');
    await expect.poll(() => readUserFile(device.server, `group chats/${initialChat}.jsonl`), { timeout: 30_000, message: 'The group conversation must persist its actual typed RP turn before editing' }).toContain(JSON.stringify(firstTurn));
    const persisted = readUserFile(device.server, `group chats/${initialChat}.jsonl`).trim().split('\n').map(line => JSON.parse(line));
    await scope.record('group-baseline-persistence', {
        groupId: id, chatId: initialChat, persisted,
        visible: await device.page.evaluate(() => window.Luker.getContext().chat.map(message => ({ name: message.name, is_user: message.is_user, mes: message.mes }))),
    });
    expect(persisted[1], 'The fresh group must retain the displayed Seraphina greeting when its first RP turn is saved').toMatchObject({ name: 'Seraphina', is_user: false, mes: greetingText });
    await editMessageViaUI(device.page, 0, WORDS.base);
    await renameChat(device.page, 'River Ford');
    await expect.poll(() => readUserFile(device.server, 'group chats/River Ford.jsonl')).toContain(WORDS.base);
    return id;
}

async function deleteCharacterChat(device) {
    await device.page.locator('#options_button').click();
    await device.page.locator('#option_select_chat').click();
    const row = device.page.locator('.select_chat_block_wrapper').filter({ has: device.page.locator('.select_chat_block_filename', { hasText: /^\s*Forest Path(\.jsonl)?\s*$/ }) });
    await expect(row).toHaveCount(1);
    await row.locator('.PastChat_cross').click();
    const confirm = device.page.locator('dialog.popup[open]', { hasText: 'Delete the Chat File?' });
    await confirm.locator('.popup-button-ok').click();
    await expect.poll(() => readUserFile(device.server, `${CHAT_DIR}/Forest Path.jsonl`)).toBeNull();
    // Reload closes the manager and forgets the deleted active chat before synchronization.
    await reloadS3Page(device.page);
}

async function deleteGroup(device, id, scope) {
    await openGroup(device, id);
    await device.page.locator('#rightNavDrawerIcon').click();
    await device.page.locator('#rm_group_delete').click();
    const confirm = device.page.locator('dialog.popup[open]', { hasText: 'Delete the group?' });
    const removed = scope.response(device.page, '/api/groups/delete');
    await confirm.locator('.popup-button-ok').click();
    expect((await observed(removed)).ok()).toBe(true);
    await expect.poll(() => readUserFile(device.server, `groups/${id}.json`)).toBeNull();
    expect(readUserFile(device.server, 'group chats/River Ford.jsonl')).toBeNull();
    await reloadS3Page(device.page);
}

async function captureNotice(scope, device, image, notice, expectedText, openText) {
    await scope.capture(image, device.page, panel(device.page), async () => {
        expect(await listPopupConflicts(device.page)).toEqual([]);
        expect(await listPopupNotices(device.page)).toEqual([{ path: notice.path, text: expectedText }]);
        await expect(syncPopup(device.page).locator('[data-act="notice-open"]')).toHaveText(openText);
        await expect(syncPopup(device.page).locator('[data-act="notice-open"]')).toBeEnabled();
        await expect(syncPopup(device.page).locator('[data-act="notice-x"]')).toHaveText('Close');
    });
}

async function prepareChatPair(scope, group) {
    const a = await scope.device('Desk');
    const b = await scope.device('Tablet');
    // Establish the shared bundled-card ancestor before chat creation updates its bookkeeping.
    await paired(a, b, ['characters', 'chats']);
    let groupId;
    if (group) groupId = await createGroup(a, scope);
    else await createCharacterChat(a);
    await openLanSyncPanel(a.page);
    const since = Date.now();
    expect(await clickSyncNow(a.page, 'Tablet')).toBe('success');
    await settlePair(a, b, since);
    for (const device of [a, b]) {
        await leavePanels(device.page);
        await reloadS3Page(device.page);
    }
    return { a, b, groupId };
}

async function forkJourney(browser, testInfo, { group, name, image }) {
    return journey(browser, testInfo, name, async scope => {
        const { a, b, groupId } = await prepareChatPair(scope, group);
        for (const [device, words] of [[a, WORDS.desk], [b, WORDS.tablet]]) {
            if (group) await openGroup(device, groupId);
            else { await selectSeraphina(device.page); await openChatByName(device.page, 'Forest Path'); }
            await editMessageViaUI(device.page, 0, words);
            await expect.poll(() => readUserFile(device.server, group ? 'group chats/River Ford.jsonl' : `${CHAT_DIR}/Forest Path.jsonl`)).toContain(words);
        }
        await openLanSyncPanel(b.page);
        expect(await clickSyncNow(b.page, 'Desk')).toBe('success');
        await waitForSyncPopup(b.page);
        const notices = (await status(b.page)).notices;
        expect(notices).toHaveLength(1);
        const [notice] = notices;
        expect(notice.kind).toBe('fork');
        expect(['Desk', 'Tablet']).toContain(notice.device);
        const original = group ? 'River Ford' : 'Forest Path';
        expect(notice.target.name).toMatch(new RegExp(`^${original} - Sync conflict ${notice.device} `));
        const rel = group ? 'group chats/River Ford.jsonl' : `${CHAT_DIR}/Forest Path.jsonl`;
        const keptWords = notice.device === 'Desk' ? WORDS.tablet : WORDS.desk;
        const branchWords = notice.device === 'Desk' ? WORDS.desk : WORDS.tablet;
        await captureNotice(scope, b, image, notice, `${rel} was edited on two devices. The version from ${notice.device} was saved as the branch chat ${notice.target.name}.`, 'Open branch');
        const branchBytes = readUserFile(b.server, notice.path);
        expect(branchBytes).toContain(branchWords);
        expect(readUserFile(b.server, rel)).toContain(keptWords);
        await expect.poll(() => readUserFile(a.server, notice.path), { timeout: 60_000 }).toBe(branchBytes);
        if (group) expect(JSON.parse(readUserFile(b.server, `groups/${groupId}.json`)).chats).toContain(notice.target.name);
        await openBranchFromNotice(b.page, notice.path, notice.target.name);
        await expect(b.page.locator('.mes[mesid="0"] .mes_text')).toContainText(branchWords);
        if (group) expect(await b.page.evaluate(() => window.Luker.getContext().groupId)).toBe(groupId);
        await reloadS3Page(b.page);
        await waitForSyncPopup(b.page);
        await dismissNotice(b.page, notice.path);
        expect((await status(b.page)).notices).toEqual([]);
        expect(readUserFile(b.server, notice.path)).toBe(branchBytes);
        if (group) expect(JSON.parse(readUserFile(b.server, `groups/${groupId}.json`)).chats).toContain(notice.target.name);
        await reloadS3Page(b.page);
        await waitForStatusChecks(b.page, 1);
        await expect(syncPopup(b.page)).toHaveCount(0);
        if (group) await openGroup(b, groupId, notice.target.name);
        else { await selectSeraphina(b.page); await openChatByName(b.page, notice.target.name); }
        await expect(b.page.locator('.mes[mesid="0"] .mes_text')).toContainText(branchWords);
    });
}

async function restoredJourney(browser, testInfo, { group, name, image }) {
    return journey(browser, testInfo, name, async scope => {
        const { a, b, groupId } = await prepareChatPair(scope, group);
        if (group) await openGroup(b, groupId);
        else { await selectSeraphina(b.page); await openChatByName(b.page, 'Forest Path'); }
        await editMessageViaUI(b.page, 0, WORDS.tablet);
        const rel = group ? 'group chats/River Ford.jsonl' : `${CHAT_DIR}/Forest Path.jsonl`;
        await expect.poll(() => readUserFile(b.server, rel)).toContain(WORDS.tablet);
        if (group) await deleteGroup(a, groupId, scope);
        else { await selectSeraphina(a.page); await deleteCharacterChat(a); }
        await openLanSyncPanel(b.page);
        expect(await clickSyncNow(b.page, 'Desk')).toBe('success');
        await waitForSyncPopup(b.page);
        const notices = (await status(b.page)).notices;
        expect(notices).toHaveLength(1);
        const [notice] = notices;
        expect(notice).toMatchObject({ path: rel, kind: 'restored', device: 'Tablet', deletedBy: 'Desk' });
        await captureNotice(scope, b, image, notice, `${group ? 'River Ford' : 'Forest Path'} was deleted on Desk but kept on Tablet, so it was restored.`, 'Open chat');
        for (const device of [a, b]) {
            await expect.poll(() => readUserFile(device.server, rel), { timeout: 60_000 }).toContain(WORDS.tablet);
            if (group) {
                const owner = JSON.parse(readUserFile(device.server, `groups/${groupId}.json`));
                expect(owner.name).toBe('Moonwell Watch');
                expect(owner.chats).toContain('River Ford');
            }
        }
        await openBranchFromNotice(b.page, rel, notice.target.name);
        await expect(b.page.locator('.mes[mesid="0"] .mes_text')).toContainText(WORDS.tablet);
        if (group) expect(await b.page.evaluate(() => window.Luker.getContext().groupId)).toBe(groupId);
    });
}

test('Character chat branch notice image opens the preserved RP version', async ({ browser }, testInfo) => {
    expect(await forkJourney(browser, testInfo, { group: false, name: 'characterFork', image: 'chat-fork-notice' })).toEqual(MANIFEST.characterFork);
});

test('Group chat branch notice image opens its owning group', async ({ browser }, testInfo) => {
    expect(await forkJourney(browser, testInfo, { group: true, name: 'groupFork', image: 'group-chat-fork-notice' })).toEqual(MANIFEST.groupFork);
});

test('Restored character chat notice image names keeping and deleting devices', async ({ browser }, testInfo) => {
    expect(await restoredJourney(browser, testInfo, { group: false, name: 'characterRestore', image: 'chat-restored-notice' })).toEqual(MANIFEST.characterRestore);
});

test('Restored group chat notice image opens the restored owning group', async ({ browser }, testInfo) => {
    expect(await restoredJourney(browser, testInfo, { group: true, name: 'groupRestore', image: 'group-chat-restored-notice' })).toEqual(MANIFEST.groupRestore);
});
