// tests/e2e/iterstudio/91-mg-graph-apply-persist.e2e.js
//
// #91 — MG graph-revision studio inside Workbench through real user gestures:
//   1. Seed a chat + import a graph via Memory Lens Settings.
//   2. Ask Workbench AI iteration (`Graph` target) to edit a node → Apply selected
//      → the live store changes and the store-commit listener fires.
//   3. Restart the server → the change survives.
//   4. A pending edit survives tab switches & folding Workbench, still approves
//      when reopened from the session list; after a page reload, the session
//      remains readable in the session list.
//   5. Memory Lens Settings "AI Edit Graph" button also opens Workbench on Graph.

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
} from '../_lib/page.js';
import { openIterStudio, sendIterPrompt, applyIterBatch, closeIterStudio } from '../_lib/ui-iter-studio.js';
import { switchWorkbenchTab, workbenchWindow } from '../_lib/ui-workbench.js';
import { importMgGraph, openMemoryWorkspace, setMgSettings } from '../_lib/ui-mg-varops.js';
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
    mock = await startMockLLM({
        scriptedReplies: [
            '*Seraphina folds the chart and meets your eyes.* "The lantern will hold another hour."',
            '*She traces a line on the chart with one knuckle.* "Three breakers north of the gull rocks."',
            '*Seraphina exhales slowly.* "The drifters know that channel better than we do."',
            '*She turns to the rail, spyglass raised.* "Hold. Don\'t speak for a moment."',
            '*Seraphina nods once.* "Then it is decided. We wait."',
        ],
    });
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
        await setMgSettings(page, { enabled: true }, { closeAfter: true });

        const persisted = await readNodeFields(page, 'n_3');
        expect(persisted?.state).toBe(EDITED_STATE);
    });

    test('a pending draft survives folding Workbench and session reopen, and session persists across reload', async ({ page }) => {
        await seedChatAndGraph(page);

        await openIterStudio(page, 'mg-graph');
        mock.scriptToolCall({
            name: 'mg_graph_edit_node',
            arguments: { node_id: 'n_2', set_fields: { identity: EDITED_IDENTITY } },
        });
        await sendIterPrompt(page, 'mg-graph', 'Add to the chart officer\'s identity that she recently resupplied the post.');

        // Fold Workbench, switch tabs, and start a fresh chat view, then reopen the session.
        await closeIterStudio(page);
        await switchWorkbenchTab(page, 'home');
        await switchWorkbenchTab(page, 'ai');
        const win = workbenchWindow(page);
        await win.locator('.wb-sess-list .wb-sess-item').first().click();
        await win.locator('.wb-chg.is-pending .wb-chg-foot button.is-primary').first().waitFor({ state: 'visible', timeout: 10_000 });
        await applyIterBatch(page, 'mg-graph');

        await expect.poll(async () => (await readNodeFields(page, 'n_2'))?.identity, { timeout: 15_000 })
            .toBe(EDITED_IDENTITY);
        await closeIterStudio(page);

        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await openIterStudio(page, 'mg-graph');
        await expect(workbenchWindow(page).locator('.wb-sess-list')).toContainText('Add to the chart officer', { timeout: 10_000 });
        await workbenchWindow(page).locator('.wb-sess-list .wb-sess-item').first().click();
        await expect(workbenchWindow(page).locator('.wb-chat')).toContainText('resupplied', { timeout: 10_000 });
        await closeIterStudio(page);
    });

    test('Memory Lens Settings AI Edit Graph button opens Workbench on Graph target', async ({ page }) => {
        await seedChatAndGraph(page);
        const lens = await openMemoryWorkspace(page, { subview: 'settings' });
        await lens.locator('[data-settings-section="operations"] button').filter({ hasText: /^(AI Edit Graph|AI 编辑图谱|AI 編輯圖譜)$/ }).first().click();

        const win = workbenchWindow(page);
        await expect(win.locator('.wb-ws-seg .lw-seg-btn[aria-pressed="true"]')).toHaveText(/^(Graph|图谱|圖譜)$/, { timeout: 15_000 });
        await expect(win.locator('.wb-chat .wb-input')).toBeVisible({ timeout: 15_000 });
        await closeIterStudio(page);
    });
});
