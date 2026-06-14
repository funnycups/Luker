// #22 — Duplicate character; no cross-pollution.
//
// Seed Ash, POST /api/characters/duplicate, verify "Ash_1.png" (or
// equivalent numeric suffix) lands. Edit Ash's description; verify the
// duplicate's description is unchanged. Restart; both persist
// independently.

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded, listCharacters } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';
import { writeEmbeddedCharacter } from './_helpers.js';

let server, mock, avatar;

const MODIFIED_DESC = 'EDITED IN ASH ONLY: a brass spyglass and a second smaller scope for the inland reefs.';

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({ batchKey: 'character', scenarioId: 'duplicate' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    avatar = writeEmbeddedCharacter({ dataRoot: server.dataRoot });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#22 — Duplicate character — no cross-pollution', () => {
    test('duplicate exists; editing source does not touch dup; both persist across restart', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await page.evaluate(async () => {
            const mod = await import('/script.js');
            await mod.getCharacters();
        });
        await page.waitForFunction(() => {
            const ctx = window.Luker?.getContext?.();
            return !!ctx?.characters?.find?.(c => c?.name === 'Ash the Cartographer');
        }, { timeout: 15_000 });

        // Duplicate.
        const dupResult = await page.evaluate(async (avatar) => {
            const ctx = window.Luker.getContext();
            const res = await fetch('/api/characters/duplicate', {
                method: 'POST',
                headers: ctx.getRequestHeaders(),
                body: JSON.stringify({ avatar_url: avatar }),
                cache: 'no-cache',
            });
            return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
        }, avatar);
        expect(dupResult.ok, `duplicate failed: ${dupResult.status}`).toBe(true);
        expect(dupResult.body?.path).toMatch(/\.png$/);
        const dupAvatar = dupResult.body.path;
        expect(dupAvatar).not.toBe(avatar);

        const onDisk = listCharacters({ dataRoot: server.dataRoot });
        expect(onDisk).toContain(avatar);
        expect(onDisk).toContain(dupAvatar);

        // Refresh in-memory list.
        await page.evaluate(async () => {
            const mod = await import('/script.js');
            await mod.getCharacters();
        });

        // Edit Ash's description (source only).
        const baseline = await page.evaluate(async (avatar) => {
            const ctx = window.Luker.getContext();
            const res = await fetch('/api/characters/get', {
                method: 'POST',
                headers: ctx.getRequestHeaders(),
                body: JSON.stringify({ avatar_url: avatar }),
                cache: 'no-cache',
            });
            return await res.json();
        }, avatar);

        const editResult = await page.evaluate(async ({ avatar, baseline, newDesc }) => {
            const ctx = window.Luker.getContext();
            const form = new FormData();
            form.append('avatar_url', avatar);
            form.append('ch_name', baseline.name || baseline.data?.name || 'Ash the Cartographer');
            form.append('description', newDesc);
            form.append('personality', baseline.personality || baseline.data?.personality || '');
            form.append('scenario', baseline.scenario || baseline.data?.scenario || '');
            form.append('first_mes', baseline.first_mes || baseline.data?.first_mes || '');
            form.append('mes_example', baseline.mes_example || baseline.data?.mes_example || '');
            form.append('creator_notes', baseline.creator_notes || baseline.data?.creator_notes || '');
            form.append('system_prompt', baseline.system_prompt || baseline.data?.system_prompt || '');
            form.append('post_history_instructions', baseline.post_history_instructions || baseline.data?.post_history_instructions || '');
            const tags = baseline.tags || baseline.data?.tags || [];
            form.append('tags', Array.isArray(tags) ? tags.join(',') : '');
            form.append('creator', baseline.creator || baseline.data?.creator || '');
            form.append('character_version', baseline.character_version || baseline.data?.character_version || '');
            form.append('talkativeness', String(baseline.data?.extensions?.talkativeness ?? '0.5'));
            const greets = baseline.alternate_greetings || baseline.data?.alternate_greetings || [];
            for (const greet of greets) form.append('alternate_greetings', greet);
            form.append('extensions', JSON.stringify(baseline.data?.extensions || {}));
            form.append('depth_prompt_depth', String(baseline.data?.extensions?.depth_prompt?.depth ?? 4));
            form.append('depth_prompt_role', baseline.data?.extensions?.depth_prompt?.role || 'system');
            form.append('depth_prompt_prompt', baseline.data?.extensions?.depth_prompt?.prompt || '');
            form.append('world', baseline.data?.extensions?.world || '');
            form.append('fav', String(!!baseline.data?.extensions?.fav));
            form.append('json_data', '');
            form.append('chat', baseline.chat || 'Ash chat');
            form.append('create_date', baseline.create_date || new Date().toISOString());
            const headers = ctx.getRequestHeaders({ omitContentType: true });
            const res = await fetch('/api/characters/edit', { method: 'POST', body: form, headers, cache: 'no-cache' });
            return { ok: res.ok, status: res.status, body: await res.text() };
        }, { avatar, baseline, newDesc: MODIFIED_DESC });
        expect(editResult.ok, `edit failed: ${editResult.status} ${editResult.body}`).toBe(true);

        // Verify Ash's description changed AND duplicate's description is unchanged.
        const sourceDesc = await page.evaluate(async (avatar) => {
            const ctx = window.Luker.getContext();
            const res = await fetch('/api/characters/get', { method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar }), cache: 'no-cache' });
            const body = await res.json();
            return body.description || body.data?.description || '';
        }, avatar);
        const dupDesc = await page.evaluate(async (avatar) => {
            const ctx = window.Luker.getContext();
            const res = await fetch('/api/characters/get', { method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar }), cache: 'no-cache' });
            const body = await res.json();
            return body.description || body.data?.description || '';
        }, dupAvatar);
        expect(sourceDesc).toBe(MODIFIED_DESC);
        expect(dupDesc).toContain('wiry coastal cartographer'); // unchanged
        expect(dupDesc).not.toBe(MODIFIED_DESC);

        // Restart + re-verify.
        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        // Make sure ST has loaded the post-restart character list before
        // we /get either avatar.
        await page.evaluate(async () => {
            const mod = await import('/script.js');
            await mod.getCharacters();
        });

        const sourceAfter = await page.evaluate(async (avatar) => {
            const ctx = window.Luker.getContext();
            const res = await fetch('/api/characters/get', { method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar }), cache: 'no-cache' });
            const body = await res.json();
            return body.description || body.data?.description || '';
        }, avatar);
        const dupAfter = await page.evaluate(async (avatar) => {
            const ctx = window.Luker.getContext();
            const res = await fetch('/api/characters/get', { method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar }), cache: 'no-cache' });
            const body = await res.json();
            return body.description || body.data?.description || '';
        }, dupAvatar);
        expect(sourceAfter).toBe(MODIFIED_DESC);
        expect(dupAfter).toContain('wiry coastal cartographer');
    });
});
