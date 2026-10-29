import { test, expect } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { awaitMainUI } from '../_lib/page.js';
import { importWorldBook, openWorldInfoDrawer } from '../_lib/ui-worldinfo.js';

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
    await page.locator('dialog.popup[open] .popup-button-ok').first().click({ timeout: 2000 }).catch(() => {});

    const fixtureDir = mkdtempSync(join(tmpdir(), 'luker-resource-doc-'));
    const bookPath = join(fixtureDir, `${BOOK}.json`);
    writeFileSync(bookPath, JSON.stringify({
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
    }));
    await importWorldBook(page, { filePath: bookPath, expectedName: BOOK });

    await page.evaluate(async (setName) => {
        const api = globalThis.quickReplyApi;
        await api.createSet(setName, { disableSend: false, placeBeforeInput: false, injectInput: false });
        api.createQuickReply(setName, 'Recite', {
            icon: '',
            showLabel: true,
            message: 'The ledger is open.',
            title: 'Recite the ledger',
        });
        await api.getSetByName(setName).save();
        await api.settings.save();
    }, QR_SET);

    const savedSet = JSON.parse(readFileSync(
        join(server.dataRoot, 'default-user', 'quickreplies', `${QR_SET}.json`), 'utf8'));
    expect(savedSet.qrList).toHaveLength(1);

    const requests = [];
    page.on('request', request => requests.push(request.url()));

    await awaitMainUI(page, server.baseURL);
    await page.waitForFunction(() => !!globalThis.quickReplyApi, { timeout: 30_000 });
    await openWorldInfoDrawer(page);

    const loadedEntries = await page.evaluate(async (name) => {
        const data = await window.Luker.getContext().loadWorldInfo(name);
        return Object.values(data?.entries || {}).map(entry => entry?.content).filter(Boolean);
    }, BOOK);
    expect(loadedEntries).toContain(SENTINEL);

    const loadedSet = await page.evaluate((name) => {
        const set = globalThis.quickReplyApi.getSetByName(name);
        return set ? { name: set.name, replies: set.qrList.map(qr => qr.label) } : null;
    }, QR_SET);
    expect(loadedSet).toEqual({ name: QR_SET, replies: ['Recite'] });

    expect(requests.some(url => url.includes('/api/settings/fields?'))).toBe(true);
    expect(requests.some(url => url.includes('/api/settings/field?'))).toBe(true);
    expect(requests.some(url => url.includes('/api/worldinfo/get?'))).toBe(true);
    expect(requests.some(url => url.includes('/api/quick-replies/list?'))).toBe(true);
    expect(requests.some(url => url.includes('/api/quick-replies/get?'))).toBe(true);
    expect(requests.some(url => url.endsWith('/api/settings/get'))).toBe(false);
});
