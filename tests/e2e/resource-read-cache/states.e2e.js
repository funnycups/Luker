import { test, expect } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { startServer, tearDownServer } from '../_lib/server.js';
import { awaitMainUI, reloadAndAwait, selectCharacterByName } from '../_lib/page.js';
import { importCharacterFile } from '../_lib/ui-character.js';
import { write as writePngCard } from '../../../src/character-card-parser.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const NAME = 'State Reader';
const CARD_APP_ENTRY = `
export async function init(ctx) {
    const output = document.createElement('pre');
    output.id = 'resource-state-result';
    const presetTarget = { collection: 'openai', name: 'Default' };
    const presetOptions = { target: presetTarget };
    const read = async () => ({
        characterGet: await ctx.getCharacterState('example'),
        chatGet: await ctx.getChatState('example'),
    });
    const write = document.createElement('button');
    write.type = 'button';
    write.textContent = 'Save reader state';
    write.addEventListener('click', async () => {
        const characterSet = await ctx.setCharacterState('example', { enabled: true });
        const chatSet = await ctx.updateChatState('example', () => ({ cursor: 4 }));
        const overlapSeed = {
            character: await ctx.setCharacterState('overlap', { revision: 'old' }),
            chat: await ctx.updateChatState('overlap', () => ({ revision: 'old' })),
            preset: await ctx.lukerContext.presets.state.update('overlap', () => ({ revision: 'old' }), presetOptions),
            unaffected: await ctx.setCharacterState('unaffected', { retained: true }),
        };
        output.textContent = JSON.stringify({ characterSet, chatSet, overlapSeed, ...await read() });
    });
    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.textContent = 'Read reader state';
    refresh.addEventListener('click', async () => {
        output.textContent = JSON.stringify(await read());
    });
    ctx.container.append(write, refresh, output);
    const readOverlap = async () => {
        const [character, chat, preset] = await Promise.all([
            ctx.getCharacterState('overlap'),
            ctx.getChatState('overlap'),
            ctx.lukerContext.presets.state.get('overlap', presetOptions),
        ]);
        return { character, chat, preset };
    };
    for (const [label, id, action] of [
        ['Start overlapping reads', 'pending', readOverlap],
        ['Read changed state', 'fresh', readOverlap],
        ['Read unaffected state', 'unaffected', () => ctx.getCharacterState('unaffected')],
        ['Mutate overlapping state', 'mutation', async () => ({
            character: await ctx.setCharacterState('OVERLAP', { revision: 'new' }),
            chat: await ctx.deleteChatState('OVERLAP'),
            preset: await ctx.lukerContext.presets.state.deleteAll(presetTarget),
        })],
    ]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        const result = document.createElement('pre');
        result.id = 'resource-state-' + id;
        button.addEventListener('click', async () => {
            const pending = action();
            result.textContent = 'reading';
            result.textContent = JSON.stringify(await pending);
        });
        ctx.container.append(button, result);
    }
}
`;

let server;
let tmpDir;
let pngPath;

test.beforeAll(async () => {
    server = await startServer({
        batchKey: 'server',
        scenarioId: 'resource-state',
        extraConfig: { 'storage.mode': 'fs' },
    });
    tmpDir = mkdtempSync(join(tmpdir(), 'luker-resource-state-'));
    const seed = readFileSync(resolve(REPO_ROOT, 'default/content/default_Seraphina.png'));
    const payload = {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: NAME,
            description: 'Writes state through the public context.',
            first_mes: 'State is ready.',
            extensions: {
                card_app: { enabled: true, entry: 'index.js', files: { 'index.js': CARD_APP_ENTRY } },
            },
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
    await selectCharacterByName(page, NAME);
    await page.waitForFunction(() => window.Luker.getContext().chat.length > 0);

    const output = page.locator('#resource-state-result');
    await page.getByRole('button', { name: 'Read reader state', exact: true }).click();
    await expect(output).not.toBeEmpty();
    await page.getByRole('button', { name: 'Save reader state', exact: true }).click();
    await expect(output).toContainText('characterSet');
    const written = JSON.parse(await output.textContent());
    expect(written.characterSet.ok).toBe(true);
    expect(written.characterGet).toEqual({ ok: true, state: { enabled: true } });
    expect(written.chatSet.ok).toBe(true);
    expect(written.chatGet).toEqual({ ok: true, state: { cursor: 4 } });
    for (const seeded of Object.values(written.overlapSeed)) expect(seeded.ok).toBe(true);
    expect(requests.some(request => request.method === 'GET' && request.path === '/api/characters/state/get')).toBe(true);
    expect(requests.some(request => request.method === 'GET' && request.path === '/api/chats/state/get')).toBe(true);
    expect(requests.some(request => request.method === 'POST' && request.path === '/api/characters/state/get')).toBe(false);
    expect(requests.some(request => request.method === 'POST' && request.path === '/api/chats/state/get')).toBe(false);

    const reloadMarker = network.length;
    const chatId = await page.evaluate(() => window.Luker.getContext().getCurrentChatId());
    await reloadAndAwait(page, server.baseURL);
    await selectCharacterByName(page, NAME);
    await page.waitForFunction(() => window.Luker.getContext().chat.length > 0);
    await page.locator('#card-app-menu-btn').click();
    await page.locator('#option_select_chat').click();
    const savedChat = page.locator('.select_chat_block_wrapper', {
        has: page.locator('.select_chat_block_filename', { hasText: chatId }),
    });
    await expect(savedChat).toHaveCount(1);
    await savedChat.locator('.select_chat_block').click();
    await page.locator('#shadow_select_chat_popup').waitFor({ state: 'hidden' });
    expect(await page.evaluate(() => window.Luker.getContext().getCurrentChatId())).toBe(chatId);
    await page.getByRole('button', { name: 'Read reader state', exact: true }).click();
    await expect(output).not.toBeEmpty();
    const restored = JSON.parse(await output.textContent());
    expect(restored.characterGet).toEqual({ ok: true, state: { enabled: true } });
    expect(restored.chatGet).toEqual({ ok: true, state: { cursor: 4 } });

    const reloadNetwork = network.slice(reloadMarker);
    const stateReads = reloadNetwork.filter(entry => entry.url.includes('/api/characters/state/get?'));
    expect(stateReads.length).toBeGreaterThan(0);
    expect(stateReads.some(entry => {
        const headers = requestHeaders.get(entry.requestId) || {};
        return entry.fromDiskCache || Boolean(headers['If-None-Match']);
    })).toBe(true);

    // Hold genuine old responses, not replacement bodies, across acknowledged writes.
    const held = new Map();
    const interceptionErrors = [];
    let holding = true;
    const onPaused = event => {
        if (holding) {
            held.set(`${new URL(event.request.url).pathname}:${new URL(event.request.url).searchParams.get('namespace')}`, event);
        } else {
            cdp.send('Fetch.continueResponse', { requestId: event.requestId })
                .catch(error => interceptionErrors.push(error.message));
        }
    };
    cdp.on('Fetch.requestPaused', onPaused);
    await cdp.send('Fetch.enable', { patterns: [
        { urlPattern: '*/api/*/state/get?*namespace=overlap', requestStage: 'Response' },
        { urlPattern: '*/api/*/state/get?*namespace=unaffected', requestStage: 'Response' },
    ] });
    try {
        await page.getByRole('button', { name: 'Start overlapping reads', exact: true }).click();
        await page.getByRole('button', { name: 'Read unaffected state', exact: true }).click();
        await expect.poll(() => held.size).toBe(4);
        holding = false;
        for (const event of held.values()) {
            expect(event.responseStatusCode).toBe(200);
            const body = await cdp.send('Fetch.getResponseBody', { requestId: event.requestId });
            const envelope = JSON.parse(body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body);
            expect(envelope).toEqual({ ok: true, data: event.request.url.includes('namespace=unaffected')
                ? { retained: true } : { revision: 'old' } });
        }
        await page.getByRole('button', { name: 'Mutate overlapping state', exact: true }).click();
        const mutation = page.locator('#resource-state-mutation');
        await expect(mutation).toContainText('character');
        for (const result of Object.values(JSON.parse(await mutation.textContent()))) expect(result.ok).toBe(true);
        await expect(page.locator('#resource-state-unaffected')).toHaveText('reading');
        await page.getByRole('button', { name: 'Read changed state', exact: true }).click();
    } finally {
        await cdp.send('Fetch.disable');
        cdp.off('Fetch.requestPaused', onPaused);
        await cdp.detach();
    }
    const fresh = page.locator('#resource-state-fresh');
    await expect(fresh).toContainText('character');
    const changed = {
        character: { ok: true, state: { revision: 'new' } },
        chat: { ok: true, state: null },
        preset: { ok: true, state: null },
    };
    expect(JSON.parse(await fresh.textContent())).toEqual(changed);
    const pending = page.locator('#resource-state-pending');
    await expect(pending).toContainText('character');
    for (const result of Object.values(JSON.parse(await pending.textContent()))) {
        expect(result.ok).toBe(false);
        expect(result.hint).toMatch(/abort/i);
    }
    const unaffected = page.locator('#resource-state-unaffected');
    await expect(unaffected).toContainText('retained');
    expect(JSON.parse(await unaffected.textContent())).toEqual({ ok: true, state: { retained: true } });
    await page.getByRole('button', { name: 'Read changed state', exact: true }).click();
    await expect(fresh).toContainText('character');
    expect(JSON.parse(await fresh.textContent())).toEqual(changed);
    expect(interceptionErrors).toEqual([]);
});
