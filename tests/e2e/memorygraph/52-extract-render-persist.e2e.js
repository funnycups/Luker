// tests/e2e/memorygraph/52-extract-render-persist.e2e.js
//
// #52 — Seed an MG graph through the real Import button → render via the
// real "View Graph" inspector → persist across a server restart.
//
// What this case pins (entirely through real-user gestures):
//   1. Enable MG via the real `#luker_rpg_memory_enabled` checkbox + the
//      real `#luker_rpg_memory_auto_extraction_enabled` checkbox in the
//      MG settings panel.
//   2. Send 5 user turns via the textarea + send button so there's a real
//      chat tail for MG to anchor against.
//   3. Click the real Import button + select a pre-built store JSON via
//      the hidden file input. Accept the import-mode popup ("Bind Latest
//      Floor") so the imported nodes anchor at the chat tail.
//   4. Click the real "View Graph" inspector button → assert the
//      cytoscape canvas mounts with at least one rendered node.
//   5. Restart the server, reload, re-enable MG, re-open View Graph and
//      assert the nodes survived (the floor_log + meta sidecars are the
//      durable record).

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
    reloadAndAwait,
    openExtensionsDrawer,
    openInlineDrawer,
} from '../_lib/page.js';
import { openMgGraphView } from '../_lib/ui-mg-varops.js';

let server, mock, importPath;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [
        '*Seraphina folds the chart and meets your eyes.* "The lantern will hold another hour."',
        '*She traces a line on the chart with one knuckle.* "Three breakers north of the gull rocks."',
        '*Seraphina exhales slowly.* "The drifters know that channel better than we do."',
        '*She turns to the rail, spyglass raised.* "Hold. Don\'t speak for a moment."',
        '*Seraphina nods once.* "Then it is decided. We wait."',
    ] });
    server = await startServer({ batchKey: 'memorygraph', scenarioId: 'extract-render' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

    // Build a pre-seeded MG store payload — three nodes across the
    // canonical types (event/character_sheet/location_state). This is the
    // raw export shape `importMemoryGraphStore` accepts.
    const tmpDir = mkdtempSync(resolve(tmpdir(), 'mg-import-'));
    importPath = resolve(tmpDir, 'seed-store.json');
    writeFileSync(importPath, JSON.stringify({
        version: 2,
        nodeSeq: 3,
        seqCounter: 3,
        appliedSeqTo: 3,
        loggedSeqTo: 3,
        nodes: {
            n_1: {
                id: 'n_1', type: 'event', level: 'semantic',
                title: 'Summary 1', parentId: '', childrenIds: [],
                fields: { summary: '时间：第一夜；user 与 Seraphina 在 Bryn 断崖点亮信号灯并完成初次巡视。' },
                seqTo: 1,
            },
            n_2: {
                id: 'n_2', type: 'character_sheet', level: 'semantic',
                title: 'Seraphina', parentId: '', childrenIds: [],
                fields: {
                    title: 'Seraphina',
                    aliases: '海图官 Sera',
                    identity: 'Bryn 断崖的常驻海图官，前盐礁灯塔守备。',
                    traits: '冷静、寡言、对夜风极敏感。',
                },
                seqTo: 2,
            },
            n_3: {
                id: 'n_3', type: 'location_state', level: 'semantic',
                title: 'Bryn headland watchpost', parentId: '', childrenIds: [],
                fields: {
                    title: 'Bryn headland watchpost',
                    controller: 'Seraphina',
                    state: '夜间执勤；信号灯已修剪。',
                    resources: '黄铜望远镜，备用油壶，潮汐图。',
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

/**
 * Flip both MG enable checkboxes on via real DOM. The MG settings panel
 * lives inside an inline-drawer whose host id is `memory_graph_settings`
 * (per the extension's `UI_BLOCK_ID` constant). We dispatch `input` and
 * `change` events the same way jQuery wires them so the underlying
 * settings.enabled handler runs.
 */
async function enableMgViaCheckboxes(page) {
    await openExtensionsDrawer(page);
    await openInlineDrawer(page, 'memory_graph_settings').catch(() => {});
    await page.evaluate(() => {
        for (const id of ['luker_rpg_memory_enabled', 'luker_rpg_memory_auto_extraction_enabled']) {
            const el = document.getElementById(id);
            if (!el) continue;
            if (!el.checked) {
                el.checked = true;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }
    });
}

/**
 * Drive the Import button + hidden file input, then accept the import-
 * mode popup by clicking the "Bind Latest Floor" custom button.
 */
async function importMgGraphBindLatest(page, filePath) {
    await openExtensionsDrawer(page);
    await openInlineDrawer(page, 'memory_graph_settings').catch(() => {});
    await page.locator('#luker_rpg_memory_import').click();
    await page.locator('#luker_rpg_memory_import_file').setInputFiles(filePath);
    // promptMemoryGraphImportMode uses custom buttons (no OK/Cancel).
    const popup = page.locator('.popup:visible').last();
    await popup.waitFor({ state: 'visible', timeout: 10_000 });
    await popup.locator('.popup-button-custom', { hasText: /Bind Latest|绑定最新/ }).first().click();
    await popup.waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {});
}

async function closeAnyVisiblePopup(page) {
    await page.locator('.popup:visible .popup-button-ok, .popup:visible .popup-button-close, .popup:visible .popup-button-cancel').first().click().catch(() => {});
    await page.waitForTimeout(300);
}

test.describe('#52 — Seed via real Import button → View Graph renders cytoscape → persist across restart', () => {
    test.setTimeout(180_000);

    test('import store, View Graph renders nodes, kill+restart keeps them', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await enableMgViaCheckboxes(page);

        // 5 RP turns so MG's chat-key resolver has a real chat to anchor.
        for (const t of [
            'I walked the cliff path. The wind is cold but the lantern holds.',
            'The drifters were silent tonight. I think they passed north.',
            'The reef glows pale where the moon catches the swell.',
            'I will keep watch until the third bell. Rest if you can.',
            'The lantern is trimmed. We are ready.',
        ]) {
            await sendMessageAndAwaitReply(page, t);
        }

        await importMgGraphBindLatest(page, importPath);

        // ── Render assertion: View Graph → cytoscape mounts with nodes ─
        await openMgGraphView(page);
        await page.waitForFunction(() => {
            const cy = document.querySelector('.luker-rpg-memory-graph-cy');
            if (!cy) return false;
            const inst = window.cy || cy.__cytoscape__ || null;
            if (inst && typeof inst.nodes === 'function') return inst.nodes().length > 0;
            return !!cy.querySelector('canvas');
        }, null, { timeout: 15_000 });
        await closeAnyVisiblePopup(page);

        // Cross-check via Layer-1 read API: 3 nodes seeded → visible.
        const preRestartNodes = await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            const mg = ctx.getExtensionApi?.('memory-graph');
            const session = await mg?.openSession?.(ctx);
            return session ? session.listVisibleCandidates({}).map(n => ({ id: n.id, title: n.title })) : [];
        });
        expect(preRestartNodes.length, 'imported nodes should be visible').toBeGreaterThanOrEqual(3);
        const titles = preRestartNodes.map(n => n.title);
        expect(titles).toEqual(expect.arrayContaining(['Seraphina', 'Bryn headland watchpost']));

        // ── Persistence-across-restart assertion ────────────────────────
        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await enableMgViaCheckboxes(page);

        await openMgGraphView(page);
        await page.waitForFunction(() => {
            const cy = document.querySelector('.luker-rpg-memory-graph-cy');
            if (!cy) return false;
            const inst = window.cy || cy.__cytoscape__ || null;
            if (inst && typeof inst.nodes === 'function') return inst.nodes().length > 0;
            return !!cy.querySelector('canvas');
        }, null, { timeout: 15_000 });
        await closeAnyVisiblePopup(page);

        const postRestartNodes = await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            const mg = ctx.getExtensionApi?.('memory-graph');
            const session = await mg?.openSession?.(ctx);
            return session ? session.listVisibleCandidates({}).map(n => ({ id: n.id, title: n.title })) : [];
        });
        expect(
            postRestartNodes.length,
            'MG nodes must survive server restart (floor_log + meta sidecars are the durable record)',
        ).toBeGreaterThanOrEqual(3);
        expect(postRestartNodes.map(n => n.title)).toEqual(expect.arrayContaining(['Seraphina', 'Bryn headland watchpost']));
    });
});
