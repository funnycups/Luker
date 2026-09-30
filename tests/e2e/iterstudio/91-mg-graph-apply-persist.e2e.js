// tests/e2e/iterstudio/91-mg-graph-apply-persist.e2e.js
//
// #91 — MG graph-revision studio through real user gestures:
//   1. Seed a chat + import a graph (same flow as memorygraph #52).
//   2. Ask the studio to edit a node → Approve → the live store changes and
//      the store-commit listener fires.
//   3. Restart the server → the change survives.
//   4. A second edit left pending survives a page reload: reopening the
//      session from history rebuilds the pending chain and the Approve
//      still lands (no conflict).

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
import { openIterStudio, sendIterPrompt, applyIterBatch, closeIterStudio } from '../_lib/ui-iter-studio.js';
import { openMgGraphView } from '../_lib/ui-mg-varops.js';
import { normalizeIterStudioSettings } from '../preset/_helpers.js';

let server, mock, importPath;

const CHAT_TURNS = [
    'I walked the cliff path. The wind is cold but the lantern holds.',
    'The drifters were silent tonight. I think they passed north.',
    'The reef glows pale where the moon catches the swell.',
    'I will keep watch until the third bell. Rest if you can.',
    'The lantern is trimmed. We are ready.',
];

const EDITED_STATE = '夜间执勤；信号灯已重新修剪。';
const EDITED_IDENTITY = 'Bryn 断崖的常驻海图官，前盐礁灯塔守备（近期补充）。';

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [
        '*Seraphina folds the chart and meets your eyes.* "The lantern will hold another hour."',
        '*She traces a line on the chart with one knuckle.* "Three breakers north of the gull rocks."',
        '*Seraphina exhales slowly.* "The drifters know that channel better than we do."',
        '*She turns to the rail, spyglass raised.* "Hold. Don\'t speak for a moment."',
        '*Seraphina nods once.* "Then it is decided. We wait."',
    ] });
    server = await startServer({ batchKey: 'iterstudio', scenarioId: '91-mg-graph-apply' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    normalizeIterStudioSettings(server.dataRoot);

    const tmpDir = mkdtempSync(resolve(tmpdir(), 'mg-graph-import-'));
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
                fields: { summary: '第一夜，user 与 Seraphina 在 Bryn 断崖点亮信号灯。' },
                seqTo: 1,
            },
            n_2: {
                id: 'n_2', type: 'character_sheet', level: 'semantic',
                title: 'Seraphina', parentId: '', childrenIds: [],
                fields: { title: 'Seraphina', aliases: '海图官 Sera', identity: 'Bryn 断崖的常驻海图官。' },
                seqTo: 2,
            },
            n_3: {
                id: 'n_3', type: 'location_state', level: 'semantic',
                title: 'Bryn headland watchpost', parentId: '', childrenIds: [],
                fields: { title: 'Bryn headland watchpost', controller: 'Seraphina', state: '夜间执勤；信号灯已修剪。' },
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

async function disableAutoExtractionViaCheckbox(page) {
    await openExtensionsDrawer(page);
    await openInlineDrawer(page, 'memory_graph_settings').catch(() => {});
    await page.evaluate(() => {
        const el = document.getElementById('luker_rpg_memory_auto_extraction_enabled');
        if (!el || !el.checked) return;
        el.checked = false;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    });
}

async function importMgGraphBindLatest(page, filePath) {
    await openExtensionsDrawer(page);
    await openInlineDrawer(page, 'memory_graph_settings').catch(() => {});
    // The Import button lives in the Graph tab pane; activate it first
    // (inactive panes stay `hidden`).
    await page.locator('#luker_rpg_memory_tabs .luker-tabs-tab[data-luker-tab-key="graph"]').click();
    await page.locator('#luker_rpg_memory_import').click();
    await page.locator('#luker_rpg_memory_import_file').setInputFiles(filePath);
    const popup = page.locator('.popup:visible').last();
    await popup.waitFor({ state: 'visible', timeout: 10_000 });
    await popup.locator('.popup-button-custom', { hasText: /Bind Latest|绑定最新/ }).first().click();
    await popup.waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {});
}

async function readNodeFields(page, nodeId) {
    return await page.evaluate(async (id) => {
        const ctx = window.Luker.getContext();
        const mg = ctx.getExtensionApi('memory-graph');
        const node = await mg.getNodeById(ctx, id);
        return node ? { ...node.fields } : null;
    }, nodeId);
}

async function seedChatAndGraph(page) {
    await awaitMainUI(page, server.baseURL);
    await selectCharacterByName(page, 'Seraphina');
    await enableMgViaCheckboxes(page);
    for (const turn of CHAT_TURNS) {
        await sendMessageAndAwaitReply(page, turn);
    }
    await importMgGraphBindLatest(page, importPath);
    // The studio's mock scripts must be the next requests the mock sees;
    // switch off auto extraction so no background extraction pass can
    // consume a scripted tool call.
    await disableAutoExtractionViaCheckbox(page);
}

test.describe('#91 — MG graph studio apply / persist', () => {
    test.setTimeout(240_000);

    test('approve lands on the live store, fires the commit listener, survives restart', async ({ page }) => {
        await seedChatAndGraph(page);

        await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            const mg = ctx.getExtensionApi('memory-graph');
            window.__mgStoreCommits = [];
            window.__mgUnsubStoreCommit = mg.onStoreCommit((snap) => {
                window.__mgStoreCommits.push(snap);
            });
        });

        await openIterStudio(page, 'mg-graph');
        mock.scriptToolCall({
            name: 'mg_graph_edit_node',
            arguments: { node_id: 'n_3', set_fields: { state: EDITED_STATE } },
        });
        await sendIterPrompt(page, 'mg-graph', 'The lantern was retrimmed tonight — update the watchpost state to say so.');
        await applyIterBatch(page, 'mg-graph');

        await expect.poll(async () => (await readNodeFields(page, 'n_3'))?.state, { timeout: 15_000 })
            .toBe(EDITED_STATE);

        await expect.poll(() => page.evaluate(() => window.__mgStoreCommits.length), { timeout: 10_000 })
            .toBeGreaterThanOrEqual(1);
        const observedChatKey = await page.evaluate(() => window.__mgStoreCommits[0]?.chatKey || '');
        expect(String(observedChatKey)).toMatch(/^(char:|group:)/);

        await closeIterStudio(page);

        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await enableMgViaCheckboxes(page);

        const persisted = await readNodeFields(page, 'n_3');
        expect(persisted?.state).toBe(EDITED_STATE);
    });

    test('a pending proposal survives a page reload and still approves (chain restored)', async ({ page }) => {
        await seedChatAndGraph(page);

        await openIterStudio(page, 'mg-graph');
        mock.scriptToolCall({
            name: 'mg_graph_edit_node',
            arguments: { node_id: 'n_2', set_fields: { identity: EDITED_IDENTITY } },
        });
        await sendIterPrompt(page, 'mg-graph', 'Add to the chart officer\'s identity that she recently resupplied the post.');
        await closeIterStudio(page);

        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await openIterStudio(page, 'mg-graph');

        // Load the persisted session from history — the pending card must
        // come back and stay approvable (the propose-time after-state is
        // rebuilt from the tail snapshot, not silently left undefined).
        const popup = page.locator('.popup:visible').last();
        await popup.locator('details[data-mg-graph-it-history] summary').click();
        await popup.locator('[data-mg-graph-it-action="load-session"]').first().click();
        await popup.locator('[data-proposal-action="approve"]').first().waitFor({ state: 'visible', timeout: 15_000 });
        await applyIterBatch(page, 'mg-graph');

        await expect.poll(async () => (await readNodeFields(page, 'n_2'))?.identity, { timeout: 15_000 })
            .toBe(EDITED_IDENTITY);
        // Conflict would have parked the card instead of committing.
        await expect(popup.locator('[data-proposal-action="force-discard"]')).toHaveCount(0);
    });

    test('the graph inspector toolbar also opens the studio', async ({ page }) => {
        await seedChatAndGraph(page);
        await openMgGraphView(page);
        const inspector = page.locator('.popup:visible').last();
        await inspector.locator('.luker-rpg-memory-graph-ai-edit').click();
        await expect(page.locator('[data-mg-graph-it-action="send"]').last())
            .toBeVisible({ timeout: 15_000 });
        await closeIterStudio(page);
    });
});
