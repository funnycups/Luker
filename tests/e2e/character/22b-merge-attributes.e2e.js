// #22b — Character `/api/characters/merge-attributes` server-API
// integration test (renamed from e2e — there is no user-facing UI for
// this endpoint; it is called by sister tools like the orchestrator
// "imported card custom tools review" flow). The test still exercises
// the in-browser ctx path (getRequestHeaders + cookie session) so the
// CSRF / handle resolution stays accurate, but the assertion is on the
// server's response shape and the on-disk character file, not on any
// user-visible DOM element.
//
// Kept under tests/e2e/character/ because it shares the
// writeEmbeddedCharacter + dataRoot fixture infrastructure with the
// other character/* tests. If extracted into a unit test suite, the
// supertest harness would be appropriate.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { disableTagImportPopup, writeEmbeddedCharacter } from './_helpers.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';

let server, mock, avatar;

const UNSET = '__@@UNSET@@__';

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({ batchKey: 'character', scenarioId: 'merge-attrs' });
    markOnboarded({ dataRoot: server.dataRoot });
    disableTagImportPopup({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    avatar = writeEmbeddedCharacter({ dataRoot: server.dataRoot });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#22b — /api/characters/merge-attributes API integration (no user-facing UI)', () => {
    test('merge lifts an arbitrary extension key into data.extensions.* and UNSET deletes it', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await page.waitForFunction(() => {
            const ctx = window.Luker?.getContext?.();
            return !!ctx?.characters?.find?.(c => c?.name === 'Ash the Cartographer');
        }, { timeout: 15_000 });

        // Step 1: merge a fresh extension key. The merge-attributes
        // endpoint has no UI affordance; it is invoked by the
        // orchestrator's imported-card customTools review and similar
        // sister flows. Drive it via fetch from the page session so
        // cookies + CSRF + handle resolution stay accurate.
        const mergeResult = await page.evaluate(async (avatar) => {
            const ctx = window.Luker.getContext();
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

        const afterMerge = await page.evaluate(async (avatar) => {
            const ctx = window.Luker.getContext();
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

        // Persistence across restart.
        await server.restart();
        await reloadAndAwait(page, server.baseURL);

        const persisted = await page.evaluate(async (avatar) => {
            const ctx = window.Luker.getContext();
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
            const ctx = window.Luker.getContext();
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
            const ctx = window.Luker.getContext();
            const res = await fetch('/api/characters/get', {
                method: 'POST', headers: ctx.getRequestHeaders(),
                body: JSON.stringify({ avatar_url: avatar }), cache: 'no-cache',
            });
            const body = await res.json();
            return {
                hasKey: !!body.data?.extensions?.bryn_test_plugin,
                otherExts: Object.keys(body.data?.extensions || {}).filter(k => k !== 'bryn_test_plugin'),
            };
        }, avatar);
        expect(afterUnset.hasKey, 'UNSET removed the key').toBe(false);
    });
});
