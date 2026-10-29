import { test, expect } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { startServer, tearDownServer } from '../_lib/server.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';
import { importCharacterFile } from '../_lib/ui-character.js';
import { clickCharacterCard, dismissAnyPopup, disableTagImportPopup } from '../character/_helpers.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { write as writePngCard } from '../../../src/character-card-parser.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const NAME = 'State Reader';

let server;
let tmpDir;
let pngPath;

test.beforeAll(async () => {
    server = await startServer({
        batchKey: 'server',
        scenarioId: 'resource-state',
        extraConfig: { 'storage.mode': 'fs' },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    disableTagImportPopup({ dataRoot: server.dataRoot });

    tmpDir = mkdtempSync(join(tmpdir(), 'luker-resource-state-'));
    const seed = readFileSync(resolve(REPO_ROOT, 'default/content/default_Seraphina.png'));
    const payload = {
        spec: 'charap_card_v2',
        spec_version: '2.0',
        data: {
            name: NAME,
            description: 'Writes state through the public context.',
            first_mes: 'State is ready.',
            extensions: {},
        },
    };
    pngPath = join(tmpDir, 'state-reader.png');
    writeFileSync(pngPath, writePngCard(seed, JSON.stringify(payload)));
});

test.afterAll(async () => {
    await tearDownServer(server);
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

test('restores character and chat state through cached GET resources', async ({ page }) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    const network = [];
    const requestHeaders = new Map();
    cdp.on('Network.requestWillBeSentExtraInfo', event => {
        requestHeaders.set(event.requestId, event.headers);
    });
    cdp.on('Network.responseReceived', event => {
        network.push({
            url: event.response.url,
            requestId: event.requestId,
            status: event.response.status,
            fromDiskCache: event.response.fromDiskCache,
        });
    });

    const requests = [];
    page.on('request', request => requests.push({
        method: request.method(),
        path: new URL(request.url()).pathname,
    }));

    await awaitMainUI(page, server.baseURL);
    await importCharacterFile(page, { filePath: pngPath, expectedName: NAME });
    await dismissAnyPopup(page);
    await clickCharacterCard(page, NAME);
    await page.waitForFunction(() => window.Luker.getContext().chat.length > 0);

    const written = await page.evaluate(async () => {
        const context = window.Luker.getContext();
        const avatar = context.characters[context.characterId].avatar;
        const characterSet = await context.setCharacterState(avatar, 'example', { enabled: true });
        const characterGet = await context.getCharacterState(avatar, 'example');
        const chatSet = await context.updateChatState('example', () => ({ cursor: 4 }));
        const chatGet = await context.getChatState('example');
        return { characterSet, characterGet, chatSet, chatGet };
    });
    expect(written.characterSet.ok).toBe(true);
    expect(written.characterGet).toEqual({ ok: true, state: { enabled: true } });
    expect(written.chatSet.ok).toBe(true);
    expect(written.chatGet).toEqual({ ok: true, state: { cursor: 4 } });
    expect(requests.some(request => request.method === 'GET' && request.path === '/api/characters/state/get')).toBe(true);
    expect(requests.some(request => request.method === 'GET' && request.path === '/api/chats/state/get')).toBe(true);
    expect(requests.some(request => request.method === 'POST' && request.path === '/api/characters/state/get')).toBe(false);
    expect(requests.some(request => request.method === 'POST' && request.path === '/api/chats/state/get')).toBe(false);

    const reloadMarker = network.length;
    await reloadAndAwait(page, server.baseURL);
    await dismissAnyPopup(page);
    await clickCharacterCard(page, NAME);
    await page.waitForFunction(() => window.Luker.getContext().chat.length > 0);
    const restored = await page.evaluate(async () => {
        const context = window.Luker.getContext();
        const avatar = context.characters[context.characterId].avatar;
        return {
            character: await context.getCharacterState(avatar, 'example'),
        };
    });
    expect(restored.character).toEqual({ ok: true, state: { enabled: true } });

    const reloadNetwork = network.slice(reloadMarker);
    const stateReads = reloadNetwork.filter(entry => entry.url.includes('/api/characters/state/get?'));
    expect(stateReads.length).toBeGreaterThan(0);
    expect(stateReads.some(entry => {
        const headers = requestHeaders.get(entry.requestId) || {};
        return entry.fromDiskCache || Boolean(headers['If-None-Match']);
    })).toBe(true);
});
