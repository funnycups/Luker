// #23b — Bulk edit characters.
//
// Seed 3 characters. Use the bulk-edit endpoints:
//   - POST /api/characters/delete twice (drive via the deleteCharacter
//     client helper if available, else direct HTTP) to delete 2 of 3.
//     Verify only 1 remains.
//   - Restart.
//   - POST /api/characters/merge-attributes with the `avatars` array to
//     apply a tag to the remaining character (the bulk-mode path).
//     Verify the tag landed.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded, listCharacters } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';
import { writeEmbeddedCharacter } from './_helpers.js';

let server, mock;
let av1, av2, av3;

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({ batchKey: 'character', scenarioId: 'bulk-edit' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    av1 = writeEmbeddedCharacter({ dataRoot: server.dataRoot, avatarFile: 'ash.png', overrides: { name: 'Ash the Cartographer' } });
    av2 = writeEmbeddedCharacter({ dataRoot: server.dataRoot, avatarFile: 'bryn.png', overrides: { name: 'Bryn the Reefwarden' } });
    av3 = writeEmbeddedCharacter({ dataRoot: server.dataRoot, avatarFile: 'cael.png', overrides: { name: 'Cael of the Causeway' } });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#23b — Bulk edit (delete two, tag the survivor)', () => {
    test('delete 2 of 3, restart, bulk-apply tag to the survivor', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await page.evaluate(async () => {
            const mod = await import('/script.js');
            await mod.getCharacters();
        });
        await page.waitForFunction(() => {
            const ctx = window.Luker?.getContext?.();
            const names = (ctx?.characters || []).map(c => c?.name).filter(Boolean);
            return ['Ash the Cartographer', 'Bryn the Reefwarden', 'Cael of the Causeway'].every(n => names.includes(n));
        }, { timeout: 20_000 });

        // ── Step 1: delete Bryn and Cael (keep Ash) ───────────────────
        for (const avatar of [av2, av3]) {
            const r = await page.evaluate(async (avatar) => {
                const ctx = window.Luker.getContext();
                const res = await fetch('/api/characters/delete', {
                    method: 'POST',
                    headers: ctx.getRequestHeaders(),
                    body: JSON.stringify({ avatar_url: avatar, delete_chats: true }),
                });
                return { ok: res.ok, status: res.status };
            }, avatar);
            expect(r.ok, `delete ${avatar} failed: ${r.status}`).toBe(true);
        }

        const afterDelete = listCharacters({ dataRoot: server.dataRoot });
        expect(afterDelete).toContain(av1);
        expect(afterDelete).not.toContain(av2);
        expect(afterDelete).not.toContain(av3);

        // Restart; verify only Ash remains.
        await server.restart();
        await reloadAndAwait(page, server.baseURL);

        await page.evaluate(async () => {
            const mod = await import('/script.js');
            await mod.getCharacters();
        });
        const namesAfterRestart = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return (ctx.characters || []).map(c => c?.name);
        });
        expect(namesAfterRestart).toContain('Ash the Cartographer');
        expect(namesAfterRestart).not.toContain('Bryn the Reefwarden');
        expect(namesAfterRestart).not.toContain('Cael of the Causeway');

        // ── Step 2: bulk merge-attributes — apply a custom extension tag
        //   on the survivor (mode: avatars[] array). ────────────────────
        const bulkMerge = await page.evaluate(async (avatar) => {
            const ctx = window.Luker.getContext();
            const body = {
                avatars: [avatar],
                data: {
                    extensions: {
                        bulk_test_marker: { applied_at: '2026-06-13', from: 'bulk-edit-e2e' },
                    },
                },
                replacePaths: ['data.extensions.bulk_test_marker'],
            };
            const res = await fetch('/api/characters/merge-attributes', {
                method: 'POST', headers: ctx.getRequestHeaders(),
                body: JSON.stringify(body), cache: 'no-cache',
            });
            const text = await res.text();
            let parsed; try { parsed = JSON.parse(text); } catch { parsed = { rawText: text }; }
            return { ok: res.ok, status: res.status, body: parsed };
        }, av1);

        expect(bulkMerge.ok, `bulk merge failed: ${bulkMerge.status} ${JSON.stringify(bulkMerge.body)}`).toBe(true);
        expect(bulkMerge.body?.updated).toContain(av1);

        // Verify the marker is on Ash; survives a second restart.
        await server.restart();
        await reloadAndAwait(page, server.baseURL);

        const marker = await page.evaluate(async (avatar) => {
            const ctx = window.Luker.getContext();
            const res = await fetch('/api/characters/get', {
                method: 'POST', headers: ctx.getRequestHeaders(),
                body: JSON.stringify({ avatar_url: avatar }), cache: 'no-cache',
            });
            const body = await res.json();
            return body.data?.extensions?.bulk_test_marker;
        }, av1);
        expect(marker, 'bulk marker landed and survives restart').toBeTruthy();
        expect(marker.from).toBe('bulk-edit-e2e');
    });
});
