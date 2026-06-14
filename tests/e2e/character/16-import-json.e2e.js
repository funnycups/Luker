// #16 — Import a JSON character card (v2) via /api/characters/import,
// confirm character appears + a /get fetch reveals all fields, then
// restart and re-verify.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded, listCharacters } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';

let server, mock;

const CARD = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    name: 'Mira of the Salt Causeway',
    description: 'A causeway watcher who has counted every plank between the village and the inland road for nine winters.',
    personality: 'Reserved, precise, methodical. Believes the causeway speaks to those who listen.',
    scenario: 'A storm is pushing through and you have come to relieve Mira at the midpoint hut.',
    first_mes: '*Mira lowers the wind-flag and meets your eyes.* "Plank 47 is loose again. Step over it, not on it. The water is loud tonight."',
    mes_example: '',
    creator_notes: 'e2e fixture — import-json',
    system_prompt: 'You are Mira. Stay in scene. Reply with one or two paragraphs.',
    post_history_instructions: '',
    alternate_greetings: ['*Mira is already counting planks under her breath when you arrive.*'],
    tags: ['rp', 'fixture'],
    creator: 'luker-e2e',
    character_version: '1.0',
    data: {
        name: 'Mira of the Salt Causeway',
        description: 'A causeway watcher who has counted every plank between the village and the inland road for nine winters.',
        personality: 'Reserved, precise, methodical. Believes the causeway speaks to those who listen.',
        scenario: 'A storm is pushing through and you have come to relieve Mira at the midpoint hut.',
        first_mes: '*Mira lowers the wind-flag and meets your eyes.* "Plank 47 is loose again. Step over it, not on it. The water is loud tonight."',
        mes_example: '',
        creator_notes: 'e2e fixture — import-json',
        system_prompt: 'You are Mira. Stay in scene. Reply with one or two paragraphs.',
        post_history_instructions: '',
        alternate_greetings: ['*Mira is already counting planks under her breath when you arrive.*'],
        tags: ['rp', 'fixture'],
        creator: 'luker-e2e',
        character_version: '1.0',
        extensions: {
            depth_prompt: { prompt: '', depth: 4, role: 'system' },
        },
    },
};

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({ batchKey: 'character', scenarioId: 'import-json' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#16 — Import JSON character card', () => {
    test('v2 JSON card imports, full record round-trips, survives restart', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        const importResult = await page.evaluate(async ({ json, name }) => {
            const ctx = window.Luker.getContext();
            const file = new File([json], `${name}.json`, { type: 'application/json' });
            const form = new FormData();
            form.append('avatar', file);
            form.append('file_type', 'json');
            const headers = ctx.getRequestHeaders({ omitContentType: true });
            const res = await fetch('/api/characters/import', { method: 'POST', body: form, headers, cache: 'no-cache' });
            const text = await res.text();
            let data; try { data = JSON.parse(text); } catch { data = { rawText: text }; }
            return { ok: res.ok, status: res.status, data };
        }, { json: JSON.stringify(CARD), name: 'Mira' });

        expect(importResult.ok, `import failed: ${JSON.stringify(importResult.data)}`).toBe(true);
        expect(importResult.data?.error).toBeFalsy();
        expect(importResult.data?.file_name).toBeTruthy();

        // File on disk.
        const onDisk = listCharacters({ dataRoot: server.dataRoot });
        expect(onDisk.some(f => f.startsWith('Mira'))).toBe(true);

        await page.evaluate(async () => {
            const mod = await import('/script.js');
            await mod.getCharacters();
        });
        await page.waitForFunction((name) => {
            const ctx = window.Luker?.getContext?.();
            return !!ctx?.characters?.find?.(c => c?.name === name);
        }, CARD.name, { timeout: 15_000 });

        const full = await page.evaluate(async (name) => {
            const ctx = window.Luker.getContext();
            const shallow = ctx.characters.find(c => c?.name === name);
            const res = await fetch('/api/characters/get', {
                method: 'POST',
                headers: ctx.getRequestHeaders(),
                body: JSON.stringify({ avatar_url: shallow.avatar }),
                cache: 'no-cache',
            });
            const body = await res.json();
            return {
                avatar: shallow.avatar,
                description: body.description || body.data?.description || '',
                first_mes: body.first_mes || body.data?.first_mes || '',
                greetings: (body.alternate_greetings ?? body.data?.alternate_greetings) || [],
                personality: body.personality || body.data?.personality || '',
            };
        }, CARD.name);

        expect(full.description).toContain('plank between the village');
        expect(full.first_mes).toContain('Plank 47');
        expect(full.greetings.length).toBe(1);
        expect(full.greetings[0]).toContain('counting planks');
        expect(full.personality).toContain('methodical');

        await server.restart();
        await reloadAndAwait(page, server.baseURL);

        const afterRestart = await page.evaluate(async (name) => {
            const ctx = window.Luker.getContext();
            const shallow = ctx.characters.find(c => c?.name === name);
            if (!shallow) return null;
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
        }, CARD.name);
        expect(afterRestart, 'Mira survived restart').toBeTruthy();
        expect(afterRestart.description).toContain('plank between the village');
        expect(afterRestart.first_mes).toContain('Plank 47');
    });
});
