// Shared real-storage lifecycle for the S3 setup and data DOM specifications.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';
import { startRustfsContainer } from './s3-container.js';
import { startS3Proxy } from './s3-proxy.js';
import { startServer, tearDownServer } from './server.js';
import { backendCard, openLanSyncPanel, setSyncSchedule, userRootOf } from './sync.js';
import { createWorldBook, selectWorldBook } from './ui-worldinfo.js';

/** Card of a sync backend on the Sync page of the Account window (`data-backend` holds its id). */
export const backendRow = (page, label = 'Cloud') => backendCard(page, label);
/** Failure reason a backend card shows after a failed sync. */
export const backendError = (page, label = 'Cloud') => backendRow(page, label).locator('.dw-card-note.bad');
/** Paths a backend card lists as files sync could not update. */
export const backendStalled = (page, label = 'Cloud') => backendRow(page, label).locator('.dw-stalled code');
export const registryOf = server => JSON.parse(fs.readFileSync(path.join(userRootOf(server), '.sync/state.json'), 'utf8'));

export async function awaitS3Page(page) {
    await page.waitForFunction(() => document.getElementById('preloader') === null && !!window.Luker?.getContext
        && performance.getEntriesByName('[init] complete').length > 0, null, { timeout: 60_000 });
    await expect(page.locator('#user-settings-button .drawer-toggle')).toBeVisible();
    // These scenarios use Sync and file editors, not an LLM connection.
    // Do not start a connection handshake merely to declare the page ready.
}

export async function reloadS3Page(page) {
    await page.reload();
    await awaitS3Page(page);
    await expect(page.locator('dialog.popup[open] .onboarding')).toHaveCount(0);
}

export async function onboardS3Page(page, baseURL) {
    await page.goto(baseURL);
    await awaitS3Page(page);
    const welcome = page.locator('dialog.popup[open]', { has: page.locator('.onboarding') });
    await expect(welcome).toBeVisible({ timeout: 30_000 });
    const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/settings/save' && response.request().method() === 'POST');
    await welcome.locator('.popup-button-ok').click();
    await expect(welcome).toHaveCount(0);
    expect((await saved).ok()).toBe(true);
}

export async function createReadyWorldBook(page, name) {
    await createWorldBook(page, name);
    await awaitWorldEditor(page, name);
}

export async function selectReadyWorldBook(page, name) {
    await selectWorldBook(page, name);
    await awaitWorldEditor(page, name);
}

async function awaitWorldEditor(page, name) {
    // The name popup closes before createNewWorldInfo finishes saving/loading
    // and binding the new editor. Read its existing render state, never mutate it.
    await page.waitForFunction(wanted => {
        const list = window.$('#world_popup_entries_list');
        return list.data('worldEntryRenderName') === wanted
            && document.querySelector('#world_info_pagination .paginationjs') !== null
            && document.querySelector('#world_editor_select option:checked')?.textContent === wanted
            && window.$._data(document.querySelector('#world_popup_new'), 'events')?.click?.some(entry => String(entry.handler).includes('createWorldInfoEntry'))
            && window.$._data(document.querySelector('#world_popup_name_button'), 'events')?.click?.some(entry => String(entry.handler).includes('renameWorldInfo'));
    }, name, { timeout: 30_000 });
}

export function s3Fixture(test) {
    let storage;
    const servers = [], contexts = [], proxies = [], clients = [];

    test.beforeAll(async () => { storage = await startRustfsContainer(); });

    test.afterEach(async () => {
        for (const context of contexts.splice(0)) await context.close();
        for (const server of servers.splice(0)) await tearDownServer(server);
        for (const proxy of proxies.splice(0)) await proxy.close();
        for (const client of clients.splice(0)) client.destroy();
    });

    test.afterAll(async () => { await storage?.stop(); });

    function client() {
        const sdk = new S3Client({ endpoint: storage.endpoint, region: storage.region, forcePathStyle: true,
            credentials: { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey }, maxAttempts: 1 });
        clients.push(sdk);
        return sdk;
    }
    return {
        client,
        async options(categories = ['worlds']) {
            const bucket = `s3-dom-${randomBytes(8).toString('hex')}`;
            await client().send(new CreateBucketCommand({ Bucket: bucket }));
            return { ...storage, bucket, prefix: 'shared/', label: 'Cloud', passphrase: `s3 DOM phrase ${randomBytes(12).toString('hex')}`, forcePathStyle: true, categories };
        },
        async proxy() {
            const proxy = await startS3Proxy({ upstream: storage.endpoint, region: storage.region,
                credentials: { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey } });
            proxies.push(proxy);
            return proxy;
        },
        async device(browser, name, extraEnv = {}, { extraConfig, timezoneId = 'UTC', jitless = false } = {}) {
            const server = await startServer({ batchKey: 'sync', scenarioId: `s3-${name}-${randomBytes(4).toString('hex')}`, extraEnv: { TZ: 'UTC', ...extraEnv }, extraConfig });
            servers.push(server);
            if (jitless || process.env.LUKER_TASK12_ACTUAL_JITLESS === '1' || process.env.LUKER_TASK13_ACTUAL_JITLESS === '1' || process.env.LUKER_TASK14_ACTUAL_JITLESS === '1') {
                const cache = path.join(server.dataRoot, '_webpack');
                const bundles = fs.readdirSync(cache).map(dir => path.join(cache, dir, 'output')).find(dir => fs.existsSync(path.join(dir, 'lib.core.bundle.js')));
                expect(bundles).toBeTruthy();
                await server.restart({ jitless: true, extraEnv: { LUKER_FORCE_JITLESS: '1', LUKER_PREBUILT_BUNDLES_DIR: bundles } });
                expect(server.execArgv).toContain('--jitless');
            }
            const context = await browser.newContext({ timezoneId });
            contexts.push(context);
            const page = await context.newPage();
            await onboardS3Page(page, server.baseURL);
            await openLanSyncPanel(page);
            await setSyncSchedule(page, { idleSeconds: 3600, pollSeconds: 3600 });
            return { page, server, context };
        },
    };
}
