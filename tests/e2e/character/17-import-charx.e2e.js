// #17 — Import a charx character card (ZIP with card.json) via
// /api/characters/import. CharX is the CCv3-flavor format; we only need
// `card.json` at the root + an icon asset to exercise the import path.

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import AdmZip from 'adm-zip';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded, listCharacters } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';

let server, mock;

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

const CARD = {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
        name: 'Riven of the Inland Marsh',
        description: 'A reedmaster who maps tide channels by their voice. Carries a brass tuning fork tied to a string at her belt.',
        personality: 'Curious. Methodical. Will out-wait a heron if it helps her hear the marsh better.',
        scenario: 'You find Riven crouched at the edge of the salt-marsh, listening for the spring tide.',
        first_mes: '*Riven holds up a finger without looking at you.* "Wait. The reeds are about to tell me something."',
        mes_example: '',
        creator_notes: 'e2e fixture — import-charx',
        system_prompt: 'You are Riven. Stay in scene. Reply with one or two paragraphs.',
        post_history_instructions: '',
        alternate_greetings: [],
        tags: ['rp', 'fixture'],
        creator: 'luker-e2e',
        character_version: '1.0',
        extensions: {},
        assets: [
            { type: 'icon', name: 'main', uri: 'embeded://main.png', ext: 'png' },
        ],
    },
};

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({ batchKey: 'character', scenarioId: 'import-charx' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#17 — Import charx character card', () => {
    test('charx ZIP with card.json + icon asset imports and persists', async ({ page }) => {
        // Build a tiny charx zip in memory.
        const iconPng = readFileSync(resolve(REPO_ROOT, 'default/content/default_Seraphina.png'));
        const zip = new AdmZip();
        zip.addFile('card.json', Buffer.from(JSON.stringify(CARD), 'utf8'));
        zip.addFile('main.png', iconPng);
        const charxBuf = zip.toBuffer();

        await awaitMainUI(page, server.baseURL);

        const importResult = await page.evaluate(async ({ b64, name }) => {
            const ctx = window.SillyTavern.getContext();
            const binary = atob(b64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            const file = new File([bytes], `${name}.charx`, { type: 'application/zip' });
            const form = new FormData();
            form.append('avatar', file);
            form.append('file_type', 'charx');
            const headers = ctx.getRequestHeaders({ omitContentType: true });
            const res = await fetch('/api/characters/import', { method: 'POST', body: form, headers, cache: 'no-cache' });
            const text = await res.text();
            let data; try { data = JSON.parse(text); } catch { data = { rawText: text }; }
            return { ok: res.ok, status: res.status, data };
        }, { b64: charxBuf.toString('base64'), name: 'Riven' });

        expect(importResult.ok, `charx import failed: ${JSON.stringify(importResult.data)}`).toBe(true);
        expect(importResult.data?.error).toBeFalsy();
        expect(importResult.data?.file_name).toBeTruthy();

        const onDisk = listCharacters({ dataRoot: server.dataRoot });
        const expectedAvatar = `${importResult.data.file_name}.png`;
        expect(onDisk).toContain(expectedAvatar);

        await page.evaluate(async () => {
            const mod = await import('/script.js');
            await mod.getCharacters();
        });
        await page.waitForFunction((name) => {
            const ctx = window.SillyTavern?.getContext?.();
            return !!ctx?.characters?.find?.(c => c?.name === name);
        }, CARD.data.name, { timeout: 15_000 });

        const full = await page.evaluate(async (name) => {
            const ctx = window.SillyTavern.getContext();
            const shallow = ctx.characters.find(c => c?.name === name);
            const res = await fetch('/api/characters/get', {
                method: 'POST',
                headers: ctx.getRequestHeaders(),
                body: JSON.stringify({ avatar_url: shallow.avatar }),
                cache: 'no-cache',
            });
            const body = await res.json();
            return {
                description: body.description || body.data?.description || '',
                first_mes: body.first_mes || body.data?.first_mes || '',
            };
        }, CARD.data.name);
        expect(full.description).toContain('reedmaster');
        expect(full.first_mes).toContain('reeds are about to tell me');

        await server.restart();
        await reloadAndAwait(page, server.baseURL);

        const persisted = await page.evaluate(async (name) => {
            const ctx = window.SillyTavern.getContext();
            const shallow = ctx.characters.find(c => c?.name === name);
            if (!shallow) return null;
            const res = await fetch('/api/characters/get', {
                method: 'POST',
                headers: ctx.getRequestHeaders(),
                body: JSON.stringify({ avatar_url: shallow.avatar }),
                cache: 'no-cache',
            });
            const body = await res.json();
            return { description: body.description || body.data?.description || '' };
        }, CARD.data.name);
        expect(persisted, 'Riven survived restart').toBeTruthy();
        expect(persisted.description).toContain('reedmaster');
    });
});
