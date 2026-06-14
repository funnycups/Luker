// #19 — Create a fresh blank character + fill every field + save.
// Exercises POST /api/characters/create (no avatar file → uses the
// DEFAULT_AVATAR_PATH). Then persist + restart + re-read via /get.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded, listCharacters } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';

let server, mock;

const NAME = 'Saoirse the Beacon-Sworn';
const DESCRIPTION = 'Sixth in a line of beacon-keepers sworn to the inland reef. Carries the silver bell that signals safe passage.';
const PERSONALITY = 'Direct, ceremonial, slow to anger and slower to forgive.';
const SCENARIO = 'A merchant skiff is rounding the headland and you wait with Saoirse at the bell-tower for the all-clear signal.';
const SYSTEM_PROMPT = 'You are Saoirse. Stay in scene. Reply with one or two paragraphs.';
const FIRST_MES = '*Saoirse rests one hand on the bell rope and watches the headland.* "Not yet. Wait for the third lantern. The mate at the bow is reading our flags."';
const ALT_GREETING_1 = '*Saoirse is already turning the bell mallet over in her hands when you arrive.* "You are early. Good. The mate is new."';
const ALT_GREETING_2 = '*Saoirse glances up from the bell-rope ledger.* "Sit. Tell me what you know of the skiff before I ring."';

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({ batchKey: 'character', scenarioId: 'create-blank' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#19 — Create blank character + fill all fields + save', () => {
    test('all fields land on disk and survive restart', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // POST /api/characters/create with a multipart form, no avatar.
        const createResult = await page.evaluate(async (payload) => {
            const ctx = window.Luker.getContext();
            const form = new FormData();
            form.append('ch_name', payload.name);
            form.append('description', payload.description);
            form.append('personality', payload.personality);
            form.append('scenario', payload.scenario);
            form.append('first_mes', payload.first_mes);
            form.append('mes_example', '');
            form.append('creator_notes', 'e2e — fresh-blank fixture');
            form.append('system_prompt', payload.system_prompt);
            form.append('post_history_instructions', '');
            form.append('tags', 'rp,fixture');
            form.append('creator', 'luker-e2e');
            form.append('character_version', '1.0');
            form.append('talkativeness', '0.5');
            for (const greet of payload.greetings) form.append('alternate_greetings', greet);
            form.append('extensions', JSON.stringify({}));
            form.append('depth_prompt_depth', '4');
            form.append('depth_prompt_role', 'system');
            form.append('depth_prompt_prompt', '');
            form.append('world', '');
            form.append('fav', 'false');
            form.append('json_data', '');
            const headers = ctx.getRequestHeaders({ omitContentType: true });
            const res = await fetch('/api/characters/create', { method: 'POST', body: form, headers, cache: 'no-cache' });
            const text = await res.text();
            return { ok: res.ok, status: res.status, body: text };
        }, { name: NAME, description: DESCRIPTION, personality: PERSONALITY, scenario: SCENARIO, system_prompt: SYSTEM_PROMPT, first_mes: FIRST_MES, greetings: [ALT_GREETING_1, ALT_GREETING_2] });

        expect(createResult.ok, `create failed: ${createResult.body}`).toBe(true);
        expect(createResult.body).toMatch(/\.png$/);
        const avatar = createResult.body.trim();

        const onDisk = listCharacters({ dataRoot: server.dataRoot });
        expect(onDisk).toContain(avatar);

        await page.evaluate(async () => {
            const mod = await import('/script.js');
            await mod.getCharacters();
        });
        await page.waitForFunction((name) => {
            const ctx = window.Luker?.getContext?.();
            return !!ctx?.characters?.find?.(c => c?.name === name);
        }, NAME, { timeout: 15_000 });

        const full = await page.evaluate(async (avatar) => {
            const ctx = window.Luker.getContext();
            const res = await fetch('/api/characters/get', {
                method: 'POST',
                headers: ctx.getRequestHeaders(),
                body: JSON.stringify({ avatar_url: avatar }),
                cache: 'no-cache',
            });
            const body = await res.json();
            return {
                name: body.name || body.data?.name || '',
                description: body.description || body.data?.description || '',
                personality: body.personality || body.data?.personality || '',
                scenario: body.scenario || body.data?.scenario || '',
                system_prompt: body.system_prompt || body.data?.system_prompt || '',
                first_mes: body.first_mes || body.data?.first_mes || '',
                greetings: (body.alternate_greetings ?? body.data?.alternate_greetings) || [],
                tags: body.tags || body.data?.tags || [],
            };
        }, avatar);

        expect(full.name).toBe(NAME);
        expect(full.description).toBe(DESCRIPTION);
        expect(full.personality).toBe(PERSONALITY);
        expect(full.scenario).toBe(SCENARIO);
        expect(full.system_prompt).toBe(SYSTEM_PROMPT);
        expect(full.first_mes).toBe(FIRST_MES);
        expect(full.greetings.length).toBe(2);
        expect(full.greetings).toContain(ALT_GREETING_1);
        expect(full.greetings).toContain(ALT_GREETING_2);
        expect(full.tags).toEqual(expect.arrayContaining(['rp', 'fixture']));

        // ── Persistence across server restart ──────────────────────────
        await server.restart();
        await reloadAndAwait(page, server.baseURL);

        const after = await page.evaluate(async (avatar) => {
            const ctx = window.Luker.getContext();
            const res = await fetch('/api/characters/get', {
                method: 'POST',
                headers: ctx.getRequestHeaders(),
                body: JSON.stringify({ avatar_url: avatar }),
                cache: 'no-cache',
            });
            const body = await res.json();
            return {
                description: body.description || body.data?.description || '',
                system_prompt: body.system_prompt || body.data?.system_prompt || '',
                greetings: (body.alternate_greetings ?? body.data?.alternate_greetings) || [],
            };
        }, avatar);
        expect(after.description).toBe(DESCRIPTION);
        expect(after.system_prompt).toBe(SYSTEM_PROMPT);
        expect(after.greetings.length).toBe(2);
        expect(after.greetings).toContain(ALT_GREETING_2);
    });
});
