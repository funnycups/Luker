// #20 — Edit existing character fields via /api/characters/edit. Seed
// Ash with the bundled fixture, change description + first_mes + add an
// alternate_greeting, restart, re-read, diff matches.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';
import { writeEmbeddedCharacter } from './_helpers.js';

let server, mock, avatar;

const NEW_DESC = 'Updated: Ash now carries a second brass spyglass calibrated to the shifting reef. Her sleeves are still ink-stained.';
const NEW_FIRST_MES = '*Ash looks up from the new chart, ink on her thumb.* "The reef changed again last night. Sit. Tell me what you saw."';
const NEW_ALT_GREETING = '*Ash is already at the second spyglass when you arrive.* "Hold. There is a light beyond the gull rocks that is not the moon."';

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({ batchKey: 'character', scenarioId: 'edit-fields' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    avatar = writeEmbeddedCharacter({ dataRoot: server.dataRoot });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#20 — Edit existing character fields', () => {
    test('description + first_mes + added greeting persist across restart', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Wait for Ash to appear in the in-memory list.
        await page.evaluate(async () => {
            const mod = await import('/script.js');
            await mod.getCharacters();
        });
        await page.waitForFunction(() => {
            const ctx = window.SillyTavern?.getContext?.();
            return !!ctx?.characters?.find?.(c => c?.name === 'Ash the Cartographer');
        }, { timeout: 15_000 });

        // Pull current full record to use as baseline (alternate_greetings,
        // tags etc. must be preserved on the edit).
        const baseline = await page.evaluate(async (avatar) => {
            const ctx = window.SillyTavern.getContext();
            const res = await fetch('/api/characters/get', {
                method: 'POST',
                headers: ctx.getRequestHeaders(),
                body: JSON.stringify({ avatar_url: avatar }),
                cache: 'no-cache',
            });
            return await res.json();
        }, avatar);

        const greetings = Array.isArray(baseline.alternate_greetings) ? baseline.alternate_greetings.slice() : (baseline.data?.alternate_greetings ?? []);
        const newGreetings = [...greetings, NEW_ALT_GREETING];

        // POST /api/characters/edit with the updated fields. Multipart
        // form, no avatar file (only fields changed).
        const editResult = await page.evaluate(async ({ avatar, baseline, newDesc, newFirstMes, newGreetings }) => {
            const ctx = window.SillyTavern.getContext();
            const form = new FormData();
            form.append('avatar_url', avatar);
            form.append('ch_name', baseline.name || baseline.data?.name || 'Ash the Cartographer');
            form.append('description', newDesc);
            form.append('personality', baseline.personality || baseline.data?.personality || '');
            form.append('scenario', baseline.scenario || baseline.data?.scenario || '');
            form.append('first_mes', newFirstMes);
            form.append('mes_example', baseline.mes_example || baseline.data?.mes_example || '');
            form.append('creator_notes', baseline.creator_notes || baseline.data?.creator_notes || '');
            form.append('system_prompt', baseline.system_prompt || baseline.data?.system_prompt || '');
            form.append('post_history_instructions', baseline.post_history_instructions || baseline.data?.post_history_instructions || '');
            const tags = baseline.tags || baseline.data?.tags || [];
            form.append('tags', Array.isArray(tags) ? tags.join(',') : '');
            form.append('creator', baseline.creator || baseline.data?.creator || '');
            form.append('character_version', baseline.character_version || baseline.data?.character_version || '');
            form.append('talkativeness', String(baseline.data?.extensions?.talkativeness ?? '0.5'));
            for (const greet of newGreetings) form.append('alternate_greetings', greet);
            form.append('extensions', JSON.stringify(baseline.data?.extensions || {}));
            form.append('depth_prompt_depth', String(baseline.data?.extensions?.depth_prompt?.depth ?? 4));
            form.append('depth_prompt_role', baseline.data?.extensions?.depth_prompt?.role || 'system');
            form.append('depth_prompt_prompt', baseline.data?.extensions?.depth_prompt?.prompt || '');
            form.append('world', baseline.data?.extensions?.world || '');
            form.append('fav', String(!!baseline.data?.extensions?.fav));
            form.append('json_data', '');
            form.append('chat', baseline.chat || `${baseline.name || 'Ash'} chat`);
            form.append('create_date', baseline.create_date || new Date().toISOString());
            const headers = ctx.getRequestHeaders({ omitContentType: true });
            const res = await fetch('/api/characters/edit', { method: 'POST', body: form, headers, cache: 'no-cache' });
            return { ok: res.ok, status: res.status, body: await res.text() };
        }, { avatar, baseline, newDesc: NEW_DESC, newFirstMes: NEW_FIRST_MES, newGreetings });

        expect(editResult.ok, `edit failed: ${editResult.status} ${editResult.body}`).toBe(true);

        // Verify in-memory + on-disk match.
        const reread = await page.evaluate(async (avatar) => {
            const ctx = window.SillyTavern.getContext();
            const res = await fetch('/api/characters/get', {
                method: 'POST',
                headers: ctx.getRequestHeaders(),
                body: JSON.stringify({ avatar_url: avatar }),
                cache: 'no-cache',
            });
            const body = await res.json();
            return {
                description: body.description || body.data?.description || '',
                first_mes: body.first_mes || body.data?.first_mes || '',
                greetings: (body.alternate_greetings ?? body.data?.alternate_greetings) || [],
            };
        }, avatar);

        expect(reread.description).toBe(NEW_DESC);
        expect(reread.first_mes).toBe(NEW_FIRST_MES);
        expect(reread.greetings).toContain(NEW_ALT_GREETING);
        // Original Ash greeting preserved.
        expect(reread.greetings.some(g => /spyglass to her eye/.test(g))).toBe(true);

        // Restart + re-verify.
        await server.restart();
        await reloadAndAwait(page, server.baseURL);

        const persisted = await page.evaluate(async (avatar) => {
            const ctx = window.SillyTavern.getContext();
            const res = await fetch('/api/characters/get', {
                method: 'POST',
                headers: ctx.getRequestHeaders(),
                body: JSON.stringify({ avatar_url: avatar }),
                cache: 'no-cache',
            });
            const body = await res.json();
            return {
                description: body.description || body.data?.description || '',
                first_mes: body.first_mes || body.data?.first_mes || '',
                greetings: (body.alternate_greetings ?? body.data?.alternate_greetings) || [],
            };
        }, avatar);
        expect(persisted.description).toBe(NEW_DESC);
        expect(persisted.first_mes).toBe(NEW_FIRST_MES);
        expect(persisted.greetings).toContain(NEW_ALT_GREETING);
    });
});
