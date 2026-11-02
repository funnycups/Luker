import { test, expect } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { startServer, tearDownServer } from '../_lib/server.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';
import { editSelectedCharacterFields, importCharacterFile } from '../_lib/ui-character.js';
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
            tags: [],
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
    await importCharacterFile(page, { filePath: pngPath, expectedName: NAME });

    const requests = [];
    page.on('request', request => requests.push(new URL(request.url())));

    const selecting = selectCharacterByName(page, NAME);
    const lorePrompt = page.getByRole('dialog').filter({ hasText: 'This character has an embedded World/Lorebook.' });
    await lorePrompt.getByRole('button', { name: 'No', exact: true }).click();
    await selecting;
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

    const avatar = await page.evaluate(() => {
        const context = window.Luker.getContext();
        return context.characters[context.characterId].avatar;
    });
    expect(readdirSync(join(server.dataRoot, 'default-user', 'characters'))).toContain(avatar);
    expect(avatar).toBeTruthy();
    expect(read.jsonData).toBe(readPngCard(readFileSync(join(server.dataRoot, 'default-user', 'characters', avatar))));

    expect(requests.some(url => url.pathname === '/api/characters/fields')).toBe(true);
    expect(requests.some(url => url.pathname === '/api/characters/field')).toBe(true);
    expect(requests.some(url => url.pathname === '/api/characters/projection')).toBe(true);
    expect(requests.some(url => url.pathname === '/api/characters/get')).toBe(false);

    await page.waitForFunction(() => window.Luker.getContext().chat.length > 0);
    const patchResponse = page.waitForResponse(response =>
        response.url().includes('/api/characters/patch') && response.request().method() === 'POST');
    await editSelectedCharacterFields(page, { description: 'Edited through the cached field path.' });
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
    await selectCharacterByName(page, NAME);
    await page.waitForFunction(() => {
        const context = window.Luker.getContext();
        return Boolean(context.characters[context.characterId]?.json_data);
    }, { timeout: 20_000 });
    expect(await page.evaluate(() => {
        const context = window.Luker.getContext();
        return context.characters[context.characterId].data.extensions.cache_fixture.history[0].text;
    })).toBe(`${SENTINEL}-0`);

    for (const description of ['Round trip A', 'Round trip B', 'Round trip A']) {
        await editSelectedCharacterFields(page, { description });
        await expect(page.locator('#description_textarea')).toHaveValue(description);
    }

    await page.reload();
    await awaitMainUI(page, server.baseURL);
    await selectCharacterByName(page, NAME);
    await page.waitForFunction(() => {
        const context = window.Luker.getContext();
        return Boolean(context.characters[context.characterId]?.json_data);
    }, { timeout: 20_000 });
    expect(await page.evaluate(() => {
        const context = window.Luker.getContext();
        return context.characters[context.characterId].data.description;
    })).toBe('Round trip A');
});
