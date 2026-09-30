// tests/e2e/iterstudio/92-mg-graph-reject-rollback-errors.e2e.js
//
// #92 — MG graph studio negative paths, all through real gestures:
//   A. Reject: the staged edit is discarded and the live store is untouched.
//   B. Tool failure: a bad node id returns an error envelope, renders a
//      failed tool chip, and produces no proposal card.
//   C. Rollback: an approved change can be rolled back and the store reverts.
//
// Seeding helpers mirror #91 / memorygraph #52 (kept local to this file,
// matching the existing e2e style).

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
import { openIterStudio, sendIterPrompt, applyIterBatch, discardIterBatch, rollbackIterBatch, closeIterStudio } from '../_lib/ui-iter-studio.js';
import { normalizeIterStudioSettings } from '../preset/_helpers.js';

let server, mock, importPath;

const CHAT_TURNS = [
    'I walked the cliff path. The wind is cold but the lantern holds.',
    'The drifters were silent tonight. I think they passed north.',
    'The reef glows pale where the moon catches the swell.',
    'I will keep watch until the third bell. Rest if you can.',
    'The lantern is trimmed. We are ready.',
];

const BASELINE_STATE = '夜间执勤；信号灯已修剪。';
const EDITED_STATE = '夜间执勤；信号灯已重新修剪。';

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [
        '*Seraphina folds the chart and meets your eyes.* "The lantern will hold another hour."',
        '*She traces a line on the chart with one knuckle.* "Three breakers north of the gull rocks."',
        '*Seraphina exhales slowly.* "The drifters know that channel better than we do."',
        '*She turns to the rail, spyglass raised.* "Hold. Don\'t speak for a moment."',
        '*Seraphina nods once.* "Then it is decided. We wait."',
    ] });
    server = await startServer({ batchKey: 'iterstudio', scenarioId: '92-mg-graph-negative' });
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
                fields: { title: 'Bryn headland watchpost', controller: 'Seraphina', state: BASELINE_STATE },
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

test.describe('#92 — MG graph studio negative paths', () => {
    test.setTimeout(240_000);

    test('reject leaves the store untouched', async ({ page }) => {
        await seedChatAndGraph(page);
        // Instrument before the reject: a reject must not emit a store
        // commit. The counter is asserted after the batch is discarded.
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
        await sendIterPrompt(page, 'mg-graph', 'Update the watchpost state to say the lantern was retrimmed.');
        await discardIterBatch(page, 'mg-graph');

        const fields = await readNodeFields(page, 'n_3');
        expect(fields?.state).toBe(BASELINE_STATE);
        // A reject must never emit a store commit.
        expect(await page.evaluate(() => window.__mgStoreCommits.length)).toBe(0);
        await closeIterStudio(page);
    });

    test('a failing tool call returns an error envelope and stages nothing', async ({ page }) => {
        await seedChatAndGraph(page);
        await openIterStudio(page, 'mg-graph');
        mock.scriptToolCall({
            name: 'mg_graph_edit_node',
            arguments: { node_id: 'n_999', set_fields: { state: 'nowhere' } },
        });

        // No proposal is expected, so the shared sendIterPrompt helper (which
        // waits for an Approve button) would hang — drive the composer
        // directly and wait for the failed tool chip to render.
        const popup = page.locator('.popup:visible').last();
        const input = popup.locator('[data-mg-graph-it-input]').first();
        await input.fill('Update the state of the node named n_999.');
        await popup.locator('[data-mg-graph-it-action="send"]').first().click();
        const failedChip = popup.locator('.luker_lib_toolcall').first();
        await failedChip.waitFor({ state: 'visible', timeout: 60_000 });

        // Let the follow-up (retry / wrap-up) round settle, then assert.
        await page.waitForTimeout(2000);
        await expect(popup.locator('[data-proposal-action="approve"]')).toHaveCount(0);

        // The chip must carry the failed-state marker and, expanded, the
        // structured error envelope for the bad node id.
        await expect(failedChip.locator('.luker_lib_toolcall_status')).toHaveText('❌');
        await failedChip.locator('details.luker_lib_toolcall_result summary').first().click();
        const envelope = failedChip.locator('.luker_lib_toolcall_result_pre').first();
        await expect(envelope).toContainText('not_found');
        await expect(envelope).toContainText('n_999');

        const fields = await readNodeFields(page, 'n_3');
        expect(fields?.state).toBe(BASELINE_STATE);
        await closeIterStudio(page);
    });

    test('rollback reverts an approved change', async ({ page }) => {
        await seedChatAndGraph(page);
        await openIterStudio(page, 'mg-graph');
        mock.scriptToolCall({
            name: 'mg_graph_edit_node',
            arguments: { node_id: 'n_3', set_fields: { state: EDITED_STATE } },
        });
        await sendIterPrompt(page, 'mg-graph', 'Update the watchpost state to say the lantern was retrimmed.');
        await applyIterBatch(page, 'mg-graph');

        await expect.poll(async () => (await readNodeFields(page, 'n_3'))?.state, { timeout: 15_000 })
            .toBe(EDITED_STATE);

        await rollbackIterBatch(page, 'mg-graph');
        await expect.poll(async () => (await readNodeFields(page, 'n_3'))?.state, { timeout: 15_000 })
            .toBe(BASELINE_STATE);
        await closeIterStudio(page);
    });
});
