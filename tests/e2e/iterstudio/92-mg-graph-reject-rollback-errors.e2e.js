// tests/e2e/iterstudio/92-mg-graph-reject-rollback-errors.e2e.js
//
// #92 — MG graph studio negative paths in Workbench, all through real gestures:
//   A. Discard: the staged edit is discarded and the live store is untouched.
//   B. Tool failure: a bad node id returns an error envelope, renders a
//      failed tool entry inside `.wb-tool-trace`, and stages no `.wb-chg`.
//   C. Undo: an applied change can be undone and the store reverts.

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
} from '../_lib/page.js';
import { openIterStudio, sendIterPrompt, applyIterBatch, discardIterBatch, rollbackIterBatch, closeIterStudio } from '../_lib/ui-iter-studio.js';
import { sendIteratePrompt, workbenchWindow } from '../_lib/ui-workbench.js';
import { importMgGraph, setMgSettings } from '../_lib/ui-mg-varops.js';
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
    mock = await startMockLLM({
        scriptedReplies: [
            '*Seraphina folds the chart and meets your eyes.* "The lantern will hold another hour."',
            '*She traces a line on the chart with one knuckle.* "Three breakers north of the gull rocks."',
            '*Seraphina exhales slowly.* "The drifters know that channel better than we do."',
            '*She turns to the rail, spyglass raised.* "Hold. Don\'t speak for a moment."',
            '*Seraphina nods once.* "Then it is decided. We wait."',
        ],
    });
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
    await setMgSettings(page, { enabled: true, autoExtractionEnabled: true }, { closeAfter: true });
    for (const turn of CHAT_TURNS) {
        await sendMessageAndAwaitReply(page, turn);
    }
    await importMgGraph(page, importPath, { mode: 'bind-latest' });
    await setMgSettings(page, { autoExtractionEnabled: false }, { closeAfter: true });
}

test.describe('#92 — MG graph studio negative paths', () => {
    test.setTimeout(240_000);

    test('discard leaves the store untouched', async ({ page }) => {
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
        await sendIterPrompt(page, 'mg-graph', 'Update the watchpost state to say the lantern was retrimmed.');
        await discardIterBatch(page, 'mg-graph');

        const fields = await readNodeFields(page, 'n_3');
        expect(fields?.state).toBe(BASELINE_STATE);
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

        await sendIteratePrompt(page, 'Update the state of the node named n_999.', { waitFor: 'settled' });
        const win = workbenchWindow(page);
        await expect(win.locator('.wb-chg.is-pending')).toHaveCount(0);

        const trace = win.locator('details.wb-tool-trace').last();
        await trace.waitFor({ state: 'visible', timeout: 15_000 });
        await trace.locator('summary').first().click();

        const errorPre = trace.locator('.wb-tool-entry pre.is-error').first();
        await expect(errorPre).toContainText('not_found');
        await expect(errorPre).toContainText('n_999');

        const fields = await readNodeFields(page, 'n_3');
        expect(fields?.state).toBe(BASELINE_STATE);
        await closeIterStudio(page);
    });

    test('undo reverts an applied change', async ({ page }) => {
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
