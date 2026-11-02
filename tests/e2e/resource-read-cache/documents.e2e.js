import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { awaitMainUI, openExtensionsDrawer, openInlineDrawer } from '../_lib/page.js';
import { importWorldDocument, selectWorldBook } from '../_lib/ui-worldinfo.js';

let server;

const BOOK = 'Cache Ledger';
const SENTINEL = 'The ledger records every revalidated resource.';
const QR_SET = 'cache-set';

test.beforeAll(async () => {
    server = await startServer({
        batchKey: 'server',
        scenarioId: 'resource-documents',
        extraConfig: { 'storage.mode': 'fs' },
    });
});

test.afterAll(async () => {
    await tearDownServer(server);
});

test('loads world books and quick replies through domain resources', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);
    await page.waitForFunction(() => !!globalThis.quickReplyApi, { timeout: 30_000 });
    await importWorldDocument(page, BOOK, {
        entries: {
            0: {
                uid: 0,
                key: ['ledger'],
                keysecondary: [],
                comment: 'cache sentinel',
                content: SENTINEL,
                constant: false,
                selective: true,
                order: 100,
                position: 0,
            },
        },
    });
    await openExtensionsDrawer(page);
    await openInlineDrawer(page, 'qr--settings');
    const chooser = page.waitForEvent('filechooser');
    await page.locator('#qr--set-import').click();
    const saved = page.waitForResponse(response =>
        new URL(response.url()).pathname === '/api/quick-replies/save' && response.request().method() === 'POST');
    await (await chooser).setFiles({
        name: `${QR_SET}.json`,
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify({
            version: 2, name: QR_SET, idIndex: 1,
            disableSend: false, placeBeforeInput: false, injectInput: false,
            qrList: [{ id: 1, label: 'Recite', icon: '', showLabel: true,
                message: 'The ledger is open.', title: 'Recite the ledger' }],
        })),
    });
    expect((await saved).ok()).toBe(true);
    await expect(page.locator('#qr--set')).toHaveValue(QR_SET);

    const savedSet = JSON.parse(readFileSync(
        join(server.dataRoot, 'default-user', 'quickreplies', `${QR_SET}.json`), 'utf8'));
    expect(savedSet.qrList).toHaveLength(1);

    const requests = [];
    page.on('request', request => requests.push(request.url()));

    await awaitMainUI(page, server.baseURL);
    await page.waitForFunction(() => !!globalThis.quickReplyApi, { timeout: 30_000 });
    await selectWorldBook(page, BOOK);
    const entry = page.locator('#world_popup_entries_list .world_entry[uid="0"]');
    const content = entry.locator('textarea[name="content"]');
    if (!await content.isVisible()) await entry.locator('.wi-entry-toggle').click();
    await expect(content).toHaveValue(SENTINEL);

    const loadedSet = await page.evaluate((name) => {
        const set = globalThis.quickReplyApi.getSetByName(name);
        return set ? { name: set.name, replies: set.qrList.map(qr => qr.label) } : null;
    }, QR_SET);
    expect(loadedSet).toEqual({ name: QR_SET, replies: ['Recite'] });
    await openExtensionsDrawer(page);
    await openInlineDrawer(page, 'qr--settings');
    await page.locator('#qr--set').selectOption(QR_SET);
    await expect(page.locator('#qr--set-qrList .qr--set-itemLabel')).toHaveValue('Recite');

    expect(requests.some(url => url.includes('/api/settings/fields?'))).toBe(true);
    expect(requests.some(url => url.includes('/api/settings/field?'))).toBe(true);
    expect(requests.some(url => url.includes('/api/worldinfo/get?'))).toBe(true);
    expect(requests.some(url => url.includes('/api/quick-replies/list?'))).toBe(true);
    expect(requests.some(url => url.includes('/api/quick-replies/get?'))).toBe(true);
    expect(requests.some(url => url.endsWith('/api/settings/get'))).toBe(false);
});
