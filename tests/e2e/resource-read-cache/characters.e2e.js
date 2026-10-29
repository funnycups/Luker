import { test, expect } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { startServer, tearDownServer } from '../_lib/server.js';
import { awaitMainUI } from '../_lib/page.js';
import { importCharacterFile } from '../_lib/ui-character.js';
import { clickCharacterCard, dismissAnyPopup, disableTagImportPopup, openCharacterEditPanel } from '../character/_helpers.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { write as writePngCard, read as readPngCard } from '../../../src/character-card-parser.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const NAME = 'Resource Reader';
const SENTINEL = 'cache-sensitive-extension-value';

let server;
let tmpDir;
let pngPath;

test.beforeAll(async () => {
    server = await startServer({
        batchKey: 'server',
        scenarioId: 'resource-character',
        extraConfig: { 'storage.mode': 'fs' },
    });

    markOnboarded({ dataRoot: server.dataRoot });
    disableTagImportPopup({ dataRoot: server.dataRoot });

    tmpDir = mkdtempSync(join(tmpdir(), 'luker-resource-character-'));
    const seed = readFileSync(resolve(REPO_ROOT, 'default/content/default_Seraphina.png'));
    const payload = {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        unknown_root: { keep: true },
        data: {
            name: NAME,
            description: 'A visitor from the cache ledger.',
            personality: 'Patient.',
            scenario: 'A quiet room.',
            first_mes: 'The ledger is open.',
            mes_example: '',
            tags: ['fixture'],
            extensions: {
                cache_fixture: {
                    enabled: true,
                    history: Array.from({ length: 400 }, (_, index) => ({ index, text: `${SENTINEL}-${index}` })),
                },
            },
            character_book: {
                name: 'resource-book',
                entries: [{ keys: ['ledger'], content: 'Embedded text.', enabled: true }],
            },
        },
    };
    pngPath = join(tmpDir, 'resource-reader.png');
    writeFileSync(pngPath, writePngCard(seed, JSON.stringify(payload)));
});

test.afterAll(async () => {
    await tearDownServer(server);
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

test('loads a complete character from source fields and projection', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);
    await page.locator('dialog.popup[open] .popup-button-ok').first().click({ timeout: 2000 }).catch(() => {});
    await importCharacterFile(page, { filePath: pngPath, expectedName: NAME });

    const requests = [];
    page.on('request', request => requests.push(new URL(request.url())));

    await dismissAnyPopup(page);
    await clickCharacterCard(page, NAME);
    await page.waitForFunction(() => {
        const context = window.Luker.getContext();
        return Boolean(context.characters[context.characterId]?.json_data);
    }, { timeout: 20_000 });

    const read = await page.evaluate(() => {
        const context = window.Luker.getContext();
        const character = context.characters[context.characterId];
        return {
            jsonData: character.json_data,
            description: character.data?.description,
            extension: character.data?.extensions?.cache_fixture,
            rootUnknown: character.unknown_root,
        };
    });
    expect(read.description).toBe('A visitor from the cache ledger.');
    expect(read.extension.enabled).toBe(true);
    expect(read.extension.history).toHaveLength(400);
    expect(read.extension.history[399].text).toBe(`${SENTINEL}-399`);
    expect(read.rootUnknown).toEqual({ keep: true });

    const avatar = readdirSync(join(server.dataRoot, 'default-user', 'characters'))
        .find(file => file.endsWith('.png'));
    expect(avatar).toBeTruthy();
    expect(read.jsonData).toBe(readPngCard(readFileSync(join(server.dataRoot, 'default-user', 'characters', avatar))));

    expect(requests.some(url => url.pathname === '/api/characters/fields')).toBe(true);
    expect(requests.some(url => url.pathname === '/api/characters/field')).toBe(true);
    expect(requests.some(url => url.pathname === '/api/characters/projection')).toBe(true);
    expect(requests.some(url => url.pathname === '/api/characters/get')).toBe(false);

    await page.waitForFunction(() => window.Luker.getContext().chat.length > 0);
    await dismissAnyPopup(page);
    await openCharacterEditPanel(page);
    await dismissAnyPopup(page);
    await page.waitForFunction(() =>
        document.querySelector('#description_textarea')?.value === 'A visitor from the cache ledger.');
    const patchResponse = page.waitForResponse(response =>
        response.url().includes('/api/characters/patch') && response.request().method() === 'POST');
    const description = page.locator('#description_textarea');
    await description.click();
    await description.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await description.pressSequentially('Edited through the cached field path.');
    await page.evaluate(() => document.querySelector('#form_create').requestSubmit());
    const patched = await patchResponse;
    expect(patched.status()).toBe(200);
    const patchBody = JSON.parse(patched.request().postData() || '{}');
    expect(patchBody.operations).toEqual([
        { op: 'add', path: '/data/description', value: 'Edited through the cached field path.' },
    ]);
    await page.waitForFunction(() => window.Luker.getContext().characters[window.Luker.getContext().characterId]?.data?.description === 'Edited through the cached field path.');
    expect(await page.evaluate(() => {
        const context = window.Luker.getContext();
        return context.characters[context.characterId].data.extensions.cache_fixture.history.length;
    })).toBe(400);

    await page.reload();
    await awaitMainUI(page, server.baseURL);
    await dismissAnyPopup(page);
    await clickCharacterCard(page, NAME);
    await page.waitForFunction(() => {
        const context = window.Luker.getContext();
        return Boolean(context.characters[context.characterId]?.json_data);
    }, { timeout: 20_000 });
    expect(await page.evaluate(() => {
        const context = window.Luker.getContext();
        return context.characters[context.characterId].data.extensions.cache_fixture.history[0].text;
    })).toBe(`${SENTINEL}-0`);

    await page.evaluate(async () => {
        const context = window.Luker.getContext();
        const id = context.characterId;
        await context.updateCharacterData(id, { description: 'Round trip A' }, { immediate: true });
        await context.updateCharacterData(id, { description: 'Round trip B' }, { immediate: true });
        await context.updateCharacterData(id, { description: 'Round trip A' }, { immediate: true });
    });

    await page.reload();
    await awaitMainUI(page, server.baseURL);
    await dismissAnyPopup(page);
    await clickCharacterCard(page, NAME);
    await page.waitForFunction(() => {
        const context = window.Luker.getContext();
        return Boolean(context.characters[context.characterId]?.json_data);
    }, { timeout: 20_000 });
    expect(await page.evaluate(() => {
        const context = window.Luker.getContext();
        return context.characters[context.characterId].data.description;
    })).toBe('Round trip A');
});
