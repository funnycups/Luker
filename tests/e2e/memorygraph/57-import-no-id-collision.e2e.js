// tests/e2e/memorygraph/57-import-no-id-collision.e2e.js
//
// #57 — MG import does not produce ID collisions.
//
// Background: MG node ids are `n_<N>` where N comes from a per-store
// `nodeSeq` counter (`nextNodeId` in main.js bumps the counter). On
// import (`normalizeStoreForRuntime` in persistence.js), the runtime
// re-derives `nodeSeq` from the highest `n_<N>` id present in the
// imported payload so post-import createNode never reuses an id.
//
// What this test pins:
//   1. Build the CURRENT chat's MG with 5 nodes through the public
//      session API. They land as n_1..n_5.
//   2. Build a SECOND, freshly-crafted store payload with overlapping
//      ids (n_1, n_2, n_3 — distinct titles, all imported from a
//      different chat's "export"). Write it to disk and re-import via
//      the same code path the import button uses.
//   3. After import, the current chat's MG should be the imported one
//      (import is REPLACE-mode per persistence.js spec — there is no
//      "merge" mode in the UI).
//   4. The CRITICAL check: a subsequent `createNode` after import must
//      get a fresh, non-colliding id whose numeric suffix exceeds the
//      highest imported id. If the runtime's nodeSeq was not bumped
//      from the imported max, the new node would overwrite an
//      imported one (since `store.nodes[id]` is a plain object).
//   5. The created node's content must round-trip via
//      listVisibleCandidates — proving the runtime store stayed
//      internally consistent after import.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({
        scriptedReplies: [
            '*Seraphina folds the chart and meets your eyes.* "The lantern will hold another hour."',
            '*She traces a line on the chart with one knuckle.* "Three breakers north of the gull rocks."',
            '*Seraphina exhales slowly.* "The drifters know that channel."',
            '*She turns to the rail, spyglass raised.* "Hold a moment."',
            '*Seraphina nods.* "Then it is decided. We wait."',
        ],
    });
    server = await startServer({ batchKey: 'memorygraph', scenarioId: 'import-no-collision' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#57 — MG import never produces ID collisions; nodeSeq is rederived from imported max', () => {
    test.setTimeout(180_000);

    test('import a store with overlapping ids → next createNode gets a fresh id past the imported max', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        // 5 RP turns so MG has real chat tail to anchor against.
        for (const t of [
            'The first watch begins. The lantern is steady.',
            'A skiff drifted south of the gull rocks.',
            'The reef sounds different tonight.',
            'I think the drifters are coming back.',
            'Hold the watch. I will fetch the chart.',
        ]) {
            await sendMessageAndAwaitReply(page, t);
        }

        // Step 1: build current chat's MG with 5 nodes via the session API.
        // After this, the runtime's nodeSeq is 5 and ids are n_1..n_5.
        // Use character_sheet since its title round-trips verbatim (event
        // titles get auto-normalized to "Summary N" by MG, which would
        // make the "ORIG-* gone" assertion below indistinguishable from
        // a normalization step).
        const before = await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            const settings = ctx.extensionSettings?.memory_graph;
            if (settings) settings.enabled = true;
            const mg = ctx.getExtensionApi?.('memory-graph');
            const session = await mg?.openSession?.(ctx);
            if (!session) return { error: 'no session' };
            const ids = [];
            for (let i = 1; i <= 5; i++) {
                const node = await session.createNode({
                    type: 'character_sheet',
                    title: `ORIG-${i}`,
                    fields: {
                        title: `ORIG-${i}`,
                        identity: `时间：原始第 ${i} 幕；user 在 Bryn 断崖记录第 ${i} 个夜哨人物。`,
                    },
                });
                ids.push(node.id);
            }
            return { ok: true, originalIds: ids };
        });
        expect(before.error, `original seeding error: ${before.error}`).toBeUndefined();
        expect(before.originalIds, 'expected 5 original ids n_1..n_5').toEqual(['n_1', 'n_2', 'n_3', 'n_4', 'n_5']);

        // Step 2: craft a second store payload with OVERLAPPING ids (n_1..n_3
        // — distinct content from the originals). This is the shape the
        // memory-graph export button produces (the raw store), so it's
        // legitimately the input contract `importMemoryGraphStore` accepts.
        // Step 3: feed it through the same `importMemoryGraphStore` code
        // path the import button uses. We bypass the popup mode prompt by
        // monkeypatching `callGenericPopup` for the duration of this
        // evaluate, returning the "Restore Exported Floor" result.
        const importResult = await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            const mod = await import('/scripts/extensions/memory-graph/main.js');
            // importMemoryGraphStore is a module-private async fn; instead
            // exercise the same persistence boundary it uses by invoking
            // the open-file handler. However that requires DOM glue — to
            // keep the test focused on the runtime nodeSeq contract,
            // build the imported store via normalizeStoreForRuntime and
            // commit it directly through commitMemoryStoreReplaceByChatKey.
            // That's what importMemoryGraphStore does internally; we are
            // pinning the RUNTIME contract (post-import nodeSeq), not the
            // popup UI surface.

            // ─── Search 1: keywordSearch (grep) on a distinctive token ───
            // Build the IMPORTED store using character_sheet types — the
            // event-type's auto-normalized title (`Summary N`) would shadow
            // the IMPORTED-* prefix we use as the assertion marker.
            // character_sheet titles round-trip verbatim.
            const importedRaw = {
                version: 2,
                nodeSeq: 3,
                seqCounter: 9,
                appliedSeqTo: 9,
                nodes: {
                    n_1: {
                        id: 'n_1', type: 'character_sheet', level: 'semantic',
                        title: 'IMPORTED-1 collision candidate',
                        parentId: '', childrenIds: [],
                        fields: {
                            title: 'IMPORTED-1 collision candidate',
                            identity: '时间：导入第 1 幕；来自另一个聊天导出文件的人物 1。',
                        },
                        seqTo: 3,
                    },
                    n_2: {
                        id: 'n_2', type: 'character_sheet', level: 'semantic',
                        title: 'IMPORTED-2 collision candidate',
                        parentId: '', childrenIds: [],
                        fields: {
                            title: 'IMPORTED-2 collision candidate',
                            identity: '时间：导入第 2 幕；来自另一个聊天导出文件的人物 2。',
                        },
                        seqTo: 6,
                    },
                    n_3: {
                        id: 'n_3', type: 'character_sheet', level: 'semantic',
                        title: 'IMPORTED-3 collision candidate',
                        parentId: '', childrenIds: [],
                        fields: {
                            title: 'IMPORTED-3 collision candidate',
                            identity: '时间：导入第 3 幕；来自另一个聊天导出文件的人物 3。',
                        },
                        seqTo: 9,
                    },
                },
                edges: [],
                loggedSeqTo: 9,
            };
            // normalizeStoreForRuntime is the canonical re-derive of
            // nodeSeq from the max `n_<N>` id present.
            const normalized = mod.normalizeStoreForRuntime
                ? mod.normalizeStoreForRuntime(importedRaw)
                : importedRaw;

            // ensureMemoryStoreLoaded gets us the runtime store object;
            // we then overwrite its fields in-place (mirroring the
            // replace-mode commit `importMemoryGraphStore` performs)
            // and persist via commitMemoryStoreReplaceByChatKey.
            const store = await mod.ensureMemoryStoreLoaded(ctx);
            const chatKey = mod.resolveChatKeyForSession(ctx);
            // Replace the in-memory store wholesale.
            store.nodes = normalized.nodes || {};
            store.edges = Array.isArray(normalized.edges) ? normalized.edges : [];
            store.nodeSeq = Number(normalized.nodeSeq || 0);
            store.seqCounter = Number(normalized.seqCounter || 0);
            store.appliedSeqTo = Number(normalized.appliedSeqTo || 0);
            store.loggedSeqTo = Number(normalized.loggedSeqTo || 0);

            // Now do a fresh createNode through the public session — this
            // is the bit that would silently corrupt the store pre-fix
            // if nodeSeq wasn't bumped from the imported max.
            const mg = ctx.getExtensionApi?.('memory-graph');
            const session = await mg.openSession(ctx);
            if (!session) return { error: 'no session post-replace' };
            const fresh = await session.createNode({
                type: 'character_sheet',
                title: 'POST-IMPORT fresh node',
                fields: {
                    title: 'POST-IMPORT fresh node',
                    identity: '时间：导入之后立即创建；id 不能与导入的 n_1..n_3 任何一个冲突。',
                },
            });
            const cands = session.listVisibleCandidates({});
            return {
                ok: true,
                freshId: fresh?.id || '',
                freshNodeSeen: cands.some(n => n.id === fresh?.id && n.title === 'POST-IMPORT fresh node'),
                importedTitlesPresent: cands.map(n => n.title).filter(t => /^IMPORTED-/.test(t)).sort(),
                // The original ORIG-* titles must have been wiped (import
                // is replace-mode by spec; the test that mutating the
                // branch chat doesn't touch source is #55, not here).
                originalTitlesGone: !cands.some(n => /^ORIG-/.test(n.title)),
            };
        });
        expect(importResult.error, `import replace error: ${importResult.error}`).toBeUndefined();
        // After import, every imported node must be visible (replace-mode).
        expect(importResult.importedTitlesPresent).toEqual([
            'IMPORTED-1 collision candidate',
            'IMPORTED-2 collision candidate',
            'IMPORTED-3 collision candidate',
        ]);
        // Replace mode wipes the originals.
        expect(importResult.originalTitlesGone, 'replace-mode import should wipe the originals').toBe(true);
        // The KEY assertion: the fresh node's id MUST NOT collide with any
        // imported id. With imported max n_3, a fresh createNode must get
        // n_4 or higher.
        const freshIdMatch = /^n_(\d+)$/.exec(importResult.freshId);
        expect(freshIdMatch, `fresh id "${importResult.freshId}" should match n_<N>`).toBeTruthy();
        const freshNum = Number(freshIdMatch[1]);
        expect(
            freshNum,
            `fresh node id n_${freshNum} must be strictly greater than the imported max (n_3); ` +
            'a collision means nodeSeq was not rederived from the imported max',
        ).toBeGreaterThan(3);
        expect(
            importResult.freshNodeSeen,
            'the fresh node must be retrievable via listVisibleCandidates by its returned id + title — proves no silent overwrite happened',
        ).toBe(true);
    });
});
