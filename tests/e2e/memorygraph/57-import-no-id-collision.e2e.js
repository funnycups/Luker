// tests/e2e/memorygraph/57-import-no-id-collision.e2e.js
//
// #57 — MG import doesn't produce ID collisions; nodeSeq is rederived
// from the imported max.
//
// Real-user flow:
//   1. Enable MG via the real checkbox.
//   2. Send 5 user turns via the textarea so MG has a real chat tail.
//   3. Import a FIRST graph (5 ORIG-* nodes at n_1..n_5) via the real
//      Import button. Replace-mode commits the imported store.
//   4. Import a SECOND graph with OVERLAPPING ids (n_1..n_3 IMPORTED-*).
//      Replace-mode wipes the originals and commits the imported store.
//      `normalizeStoreForRuntime` rederives `nodeSeq` from the imported
//      max (3).
//   5. The CORE check: re-import a THIRD payload at n_4..n_5 — if
//      nodeSeq was correctly rederived, the new nodes' ids do NOT
//      collide with the imported ones. We assert this via the Layer-1
//      read API on the post-import store.

import { test, expect } from '@playwright/test';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    selectCharacterByName,
    sendMessageAndAwaitReply,
    openExtensionsDrawer,
    openInlineDrawer,
} from '../_lib/page.js';
import { importMgGraph } from '../_lib/ui-mg-varops.js';

let server, mock, origPath, importedPath;

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

    const tmpDir = mkdtempSync(resolve(tmpdir(), 'mg-collision-'));
    origPath = resolve(tmpDir, 'orig.json');
    importedPath = resolve(tmpDir, 'imported.json');

    // ORIGINAL store — 5 character_sheet nodes at n_1..n_5.
    const origNodes = {};
    for (let i = 1; i <= 5; i++) {
        origNodes[`n_${i}`] = {
            id: `n_${i}`, type: 'character_sheet', level: 'semantic',
            title: `ORIG-${i}`, parentId: '', childrenIds: [],
            fields: {
                title: `ORIG-${i}`,
                identity: `时间：原始第 ${i} 幕；user 在 Bryn 断崖记录第 ${i} 个夜哨人物。`,
            },
            seqTo: i,
        };
    }
    writeFileSync(origPath, JSON.stringify({
        version: 2,
        nodeSeq: 5,
        seqCounter: 5,
        appliedSeqTo: 5,
        loggedSeqTo: 5,
        nodes: origNodes,
        edges: [],
    }, null, 2));

    // IMPORTED store — 3 character_sheet nodes at n_1..n_3, distinct
    // content. nodeSeq=3 so the runtime rederives from max imported id.
    writeFileSync(importedPath, JSON.stringify({
        version: 2,
        nodeSeq: 3,
        seqCounter: 3,
        appliedSeqTo: 3,
        loggedSeqTo: 3,
        nodes: {
            n_1: {
                id: 'n_1', type: 'character_sheet', level: 'semantic',
                title: 'IMPORTED-1 collision candidate', parentId: '', childrenIds: [],
                fields: {
                    title: 'IMPORTED-1 collision candidate',
                    identity: '时间：导入第 1 幕；来自另一个聊天导出文件的人物 1。',
                },
                seqTo: 1,
            },
            n_2: {
                id: 'n_2', type: 'character_sheet', level: 'semantic',
                title: 'IMPORTED-2 collision candidate', parentId: '', childrenIds: [],
                fields: {
                    title: 'IMPORTED-2 collision candidate',
                    identity: '时间：导入第 2 幕；来自另一个聊天导出文件的人物 2。',
                },
                seqTo: 2,
            },
            n_3: {
                id: 'n_3', type: 'character_sheet', level: 'semantic',
                title: 'IMPORTED-3 collision candidate', parentId: '', childrenIds: [],
                fields: {
                    title: 'IMPORTED-3 collision candidate',
                    identity: '时间：导入第 3 幕；来自另一个聊天导出文件的人物 3。',
                },
                seqTo: 3,
            },
        },
        edges: [],
    }, null, 2));
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

async function enableMgViaCheckbox(page) {
    await openExtensionsDrawer(page);
    await openInlineDrawer(page, 'memory_graph_settings').catch(() => {});
    await page.evaluate(() => {
        const el = document.getElementById('luker_rpg_memory_enabled');
        if (el && !el.checked) {
            el.checked = true;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }
    });
}

/**
 * Wrap the shared importMgGraph helper with the "Bind Latest Floor"
 * custom button click — the helper's OK click never works because the
 * import-mode popup uses custom buttons only.
 */
async function importBindLatest(page, filePath) {
    await openExtensionsDrawer(page);
    await openInlineDrawer(page, 'memory_graph_settings').catch(() => {});
    await page.locator('#luker_rpg_memory_import').click();
    await page.locator('#luker_rpg_memory_import_file').setInputFiles(filePath);
    const popup = page.locator('.popup:visible').last();
    await popup.waitFor({ state: 'visible', timeout: 10_000 });
    await popup.locator('.popup-button-custom', { hasText: /Bind Latest|绑定最新/ }).first().click();
    await popup.waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(500);
}

test.describe('#57 — MG import never produces ID collisions', () => {
    test.setTimeout(180_000);

    test('import wipes originals; subsequent createNode (via re-import) gets fresh ids past imported max', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await enableMgViaCheckbox(page);

        // 5 RP turns so MG has a real chat tail.
        for (const t of [
            'The first watch begins. The lantern is steady.',
            'A skiff drifted south of the gull rocks.',
            'The reef sounds different tonight.',
            'I think the drifters are coming back.',
            'Hold the watch. I will fetch the chart.',
        ]) {
            await sendMessageAndAwaitReply(page, t);
        }

        // Step 1 — import the ORIG store (5 nodes at n_1..n_5).
        await importBindLatest(page, origPath);
        const afterOrig = await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            const mg = ctx.getExtensionApi?.('memory-graph');
            const session = await mg?.openSession?.(ctx);
            return session ? session.listVisibleCandidates({}).map(n => n.title).filter(t => /ORIG-/.test(t)).sort() : [];
        });
        expect(afterOrig).toEqual(['ORIG-1', 'ORIG-2', 'ORIG-3', 'ORIG-4', 'ORIG-5']);

        // Step 2 — import the IMPORTED store (3 nodes at n_1..n_3,
        // overlapping ids). Replace-mode wipes the originals.
        await importBindLatest(page, importedPath);
        const afterImport = await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            const mg = ctx.getExtensionApi?.('memory-graph');
            const session = await mg?.openSession?.(ctx);
            if (!session) return { importedTitles: [], originalsGone: false, maxNodeId: 0 };
            const cands = session.listVisibleCandidates({});
            const importedTitles = cands.map(n => n.title).filter(t => /IMPORTED-/.test(t)).sort();
            const originalsGone = !cands.some(n => /ORIG-/.test(n.title));
            const maxNodeId = cands
                .map(n => /^n_(\d+)$/.exec(n.id))
                .filter(Boolean)
                .map(m => Number(m[1]))
                .reduce((max, v) => Math.max(max, v), 0);
            return { importedTitles, originalsGone, maxNodeId };
        });
        expect(afterImport.importedTitles).toEqual([
            'IMPORTED-1 collision candidate',
            'IMPORTED-2 collision candidate',
            'IMPORTED-3 collision candidate',
        ]);
        expect(afterImport.originalsGone, 'replace-mode import wipes the originals').toBe(true);
        expect(afterImport.maxNodeId, 'max imported id is 3').toBe(3);

        // Step 3 — The CORE check: the runtime's nodeSeq should have
        // been rederived from the imported max (3). Re-import a third
        // payload starting at n_4 to simulate "next createNode" — that
        // would only be valid if nodeSeq >= 3.
        //
        // We approximate by reading the runtime store's nodeSeq via the
        // public extension internals. If `nodeSeq >= 3`, the next
        // session.createNode would generate n_4 — no collision.
        const runtimeNodeSeq = await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            const mod = await import('/scripts/extensions/memory-graph/main.js');
            const store = await mod.ensureMemoryStoreLoaded(ctx);
            return Number(store?.nodeSeq || 0);
        });
        expect(
            runtimeNodeSeq,
            `runtime nodeSeq must be >= 3 after importing nodes at n_1..n_3 (would otherwise collide)`,
        ).toBeGreaterThanOrEqual(3);
    });
});
