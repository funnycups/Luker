// #22b — Character attribute merge (the existing jest spec
// `tests/characters-merge-attributes.test.js` covers the helper
// validation in unit form; this is the live e2e flow).
//
// Sequence:
//   1. Create a v1-style character (just data.* fields, no extension keys).
//   2. POST /api/characters/merge-attributes with a v2-shaped update that
//      adds extension fields under `data.extensions.luker.my_plugin`.
//   3. Restart.
//   4. Re-read via /get; the extension keys must land in canonical path.
//   5. POST a second merge using the UNSET sentinel; verify deletion.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';
import { writeEmbeddedCharacter } from './_helpers.js';

let server, mock, avatar;

const UNSET = '__@@UNSET@@__';

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({ batchKey: 'character', scenarioId: 'merge-attrs' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    avatar = writeEmbeddedCharacter({ dataRoot: server.dataRoot });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#22b — Character attribute merge (V2 canonical path)', () => {
    test('merge-attributes lifts arbitrary extension keys into data.extensions.* and UNSET deletes them', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await page.evaluate(async () => {
            const mod = await import('/script.js');
            await mod.getCharacters();
        });
        await page.waitForFunction(() => {
            const ctx = window.SillyTavern?.getContext?.();
            return !!ctx?.characters?.find?.(c => c?.name === 'Ash the Cartographer');
        }, { timeout: 15_000 });

        // Step 1: merge a fresh extension key.
        const mergeResult = await page.evaluate(async (avatar) => {
            const ctx = window.SillyTavern.getContext();
            const body = {
                avatar,
                data: {
                    extensions: {
                        bryn_test_plugin: {
                            wick_inventory: 14,
                            last_trim: '2026-06-12T03:00:00Z',
                            notes: 'A test plugin slot to verify merge-attributes lifts it.',
                        },
                    },
                },
                // Use replacePaths so the entire bryn_test_plugin object
                // is treated as a wholesale replace (any prior siblings
                // would be dropped) — the canonical v2 lift contract.
                replacePaths: ['data.extensions.bryn_test_plugin'],
            };
            const res = await fetch('/api/characters/merge-attributes', {
                method: 'POST',
                headers: ctx.getRequestHeaders(),
                body: JSON.stringify(body),
                cache: 'no-cache',
            });
            return { ok: res.ok, status: res.status, body: await res.text() };
        }, avatar);
        expect(mergeResult.ok, `merge failed: ${mergeResult.status} ${mergeResult.body}`).toBe(true);

        // Re-read; the key lives at data.extensions.bryn_test_plugin.
        const afterMerge = await page.evaluate(async (avatar) => {
            const ctx = window.SillyTavern.getContext();
            const res = await fetch('/api/characters/get', {
                method: 'POST', headers: ctx.getRequestHeaders(),
                body: JSON.stringify({ avatar_url: avatar }), cache: 'no-cache',
            });
            const body = await res.json();
            return body.data?.extensions?.bryn_test_plugin;
        }, avatar);
        expect(afterMerge, 'merged extension key landed at canonical V2 path').toBeTruthy();
        expect(afterMerge.wick_inventory).toBe(14);
        expect(afterMerge.notes).toContain('A test plugin slot');

        // Restart; should persist.
        await server.restart();
        await reloadAndAwait(page, server.baseURL);

        const persisted = await page.evaluate(async (avatar) => {
            const ctx = window.SillyTavern.getContext();
            const res = await fetch('/api/characters/get', {
                method: 'POST', headers: ctx.getRequestHeaders(),
                body: JSON.stringify({ avatar_url: avatar }), cache: 'no-cache',
            });
            const body = await res.json();
            return body.data?.extensions?.bryn_test_plugin;
        }, avatar);
        expect(persisted, 'extension survives restart').toBeTruthy();
        expect(persisted.wick_inventory).toBe(14);

        // Step 2: UNSET sentinel — delete the key.
        const unsetResult = await page.evaluate(async ({ avatar, UNSET }) => {
            const ctx = window.SillyTavern.getContext();
            const body = {
                avatar,
                data: {
                    extensions: {
                        bryn_test_plugin: UNSET,
                    },
                },
                replacePaths: ['data.extensions.bryn_test_plugin'],
            };
            const res = await fetch('/api/characters/merge-attributes', {
                method: 'POST', headers: ctx.getRequestHeaders(),
                body: JSON.stringify(body), cache: 'no-cache',
            });
            return { ok: res.ok, status: res.status, body: await res.text() };
        }, { avatar, UNSET });
        expect(unsetResult.ok, `unset merge failed: ${unsetResult.status} ${unsetResult.body}`).toBe(true);

        const afterUnset = await page.evaluate(async (avatar) => {
            const ctx = window.SillyTavern.getContext();
            const res = await fetch('/api/characters/get', {
                method: 'POST', headers: ctx.getRequestHeaders(),
                body: JSON.stringify({ avatar_url: avatar }), cache: 'no-cache',
            });
            const body = await res.json();
            return {
                hasKey: !!body.data?.extensions?.bryn_test_plugin,
                hasSiblings: !!body.data?.extensions,
                otherExts: Object.keys(body.data?.extensions || {}).filter(k => k !== 'bryn_test_plugin'),
            };
        }, avatar);
        expect(afterUnset.hasKey, 'UNSET removed the key').toBe(false);
    });
});
