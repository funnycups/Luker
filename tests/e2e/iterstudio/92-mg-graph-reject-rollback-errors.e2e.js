// tests/e2e/iterstudio/92-mg-graph-reject-rollback-errors.e2e.js
//
// #92 — MG graph studio negative paths in Workbench, all through real gestures:
//   A. Discard: the staged edit is discarded and the live store is untouched.
//   B. Tool failure: a bad node id returns an error envelope, renders a
//      failed tool entry inside `.wb-tool-trace`, and stages no `.wb-chg`.
//   C. Undo: an applied change can be undone and the store reverts.

import { test, expect } from '../../harness/playwright.js';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    createNewChatViaUI,
    reloadAndAwait,
    selectCharacterByName,
    sendMessageAndAwaitReply,
} from '../_lib/page.js';
import { openIterStudio, sendIterPrompt, applyIterBatch, discardIterBatch, rollbackIterBatch, closeIterStudio } from '../_lib/ui-iter-studio.js';
import { applyWorkbenchChanges, sendIteratePrompt, sendWorkbenchIterationPrompt, stopWorkbenchIteration, workbenchWindow } from '../_lib/ui-workbench.js';
import { importMgGraph, setMgSettings } from '../_lib/ui-mg-varops.js';
import { normalizeIterStudioSettings } from '../preset/_helpers.js';
import { openChatByName } from '../_lib/sync.js';

async function holdWorkbenchSnapshotHttp(page) {
    let signalRequested;
    let signalRelease;
    const requestedPromise = new Promise(resolve => { signalRequested = resolve; });
    const releasePromise = new Promise(resolve => { signalRelease = resolve; });
    const inFlight = new Set();
    let captured = false;
    let released = false;
    const handler = async (route) => {
        const url = new URL(route.request().url());
        if (!released && url.searchParams.get('namespace') === 'sd_character_profiles') {
            let done;
            const pending = new Promise(resolve => { done = resolve; });
            inFlight.add(pending);
            try {
                if (!captured) {
                    captured = true;
                    signalRequested();
                }
                await releasePromise;
                await route.continue();
            } finally {
                inFlight.delete(pending);
                done();
            }
            return;
        }
        await route.continue();
    };
    await page.route('**/api/state/get*', handler);
    return {
        requested: () => requestedPromise,
        async release() {
            if (released) return;
            released = true;
            signalRelease();
            await Promise.all([...inFlight]);
            await page.unroute('**/api/state/get*', handler);
        },
    };
}

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

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({
        scriptedReplies: [
            '*Seraphina folds the chart and meets your eyes.* "The lantern will hold another hour."',
            '*She traces a line on the chart with one knuckle.* "Three breakers north of the gull rocks."',
            '*Seraphina exhales slowly.* "The drifters know that channel better than we do."',
            '*She turns to the rail, spyglass raised.* "Hold. Don\'t speak for a moment."',
            '*Seraphina nods once.* "Then it is decided. We wait."',
        ],
    });
    server = await startServer({ scope, batchKey: 'iterstudio', scenarioId: '92-mg-graph-negative' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    normalizeIterStudioSettings(server.dataRoot);

    const tmpDir = (await scope.directory('mg-graph-import')).path;
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
    await importMgGraph(page, importPath, { mode: 'bind-latest', closeAfter: true });
    await setMgSettings(page, { autoExtractionEnabled: false }, { closeAfter: true });
}

async function verifyAbandonedTurn(page, action) {
    await seedChatAndGraph(page);
    await openIterStudio(page, 'mg-graph', { autoApply: false });
    mock.scriptToolCall({
        name: 'mg_graph_edit_node',
        arguments: { node_id: 'n_3', set_fields: { state: EDITED_STATE } },
    });
    await sendIterPrompt(page, 'mg-graph', 'Retouch the watchpost state, leaving it pending.');
    const win = workbenchWindow(page);
    const replacementIdentity = 'Bryn 断崖的海图官，负责晚间巡查。';
    let rewoundIds = [];

    if (action === 'stop') {
        let routed = false;
        mock.scriptCompletion(() => {
            if (routed) return null;
            routed = true;
            return {
                tool: 'mg_graph_edit_node',
                arguments: { node_id: 'n_3', set_fields: { state: 'This interrupted note must not survive.' } },
            };
        });
        const held = mock.holdNextQueuedRequest();
        try {
            await sendWorkbenchIterationPrompt(page, 'Draft an interrupted watchpost note.', { waitForSettle: false });
            await held.requested;
            await stopWorkbenchIteration(page);
        } finally {
            held.release();
            mock.scriptCompletion(null);
        }
        await expect(win.locator('.wb-msg-error')).toBeVisible();
    } else {
        mock.scriptToolCall({
            name: 'mg_graph_edit_node',
            arguments: action === 'applied'
                ? { node_id: 'n_2', set_fields: { identity: 'This applied note must not survive.' } }
                : { node_id: 'n_3', set_fields: { state: 'This replaced note must not survive.' } },
        });
        await sendIterPrompt(page, 'mg-graph', 'Draft a watchpost note that will be replaced.');
        if (action === 'applied') {
            rewoundIds = await page.evaluate(async () => {
                const ctx = window.Luker.getContext();
                const { sessionBodyNamespace } = await import('/scripts/workbench/model/sessions.js');
                const result = await ctx.getChatState('workbench_sessions');
                if (result.ok !== true) throw new Error(JSON.stringify(result));
                const summary = result.state.sessions.find(item => item.kind === 'iterate' && item.ws === 'memory_graph');
                const bodyRes = await ctx.getChatState(sessionBodyNamespace(summary.id));
                if (bodyRes.ok !== true) throw new Error(JSON.stringify(bodyRes));
                return bodyRes.state.turns.at(-1).proposalIds;
            });
            expect(rewoundIds).toHaveLength(1);
            await applyWorkbenchChanges(page, { index: 1 });
            await expect.poll(async () => (await readNodeFields(page, 'n_2'))?.identity).toBe('This applied note must not survive.');
            expect((await readNodeFields(page, 'n_3'))?.state).toBe(BASELINE_STATE);
        }
    }

    mock.scriptToolCall({
        name: 'mg_graph_edit_node',
        arguments: { node_id: 'n_2', set_fields: { identity: replacementIdentity } },
    });
    if (action === 'stop') {
        await sendIterPrompt(page, 'mg-graph', 'Record the map officer identity without changing the watchpost.');
    } else {
        await win.getByRole('button', { name: /^(Answer again|重新回答|再次回答)$/ }).last().click();
    }
    await expect(win.locator('.wb-chg.is-pending').last()).toContainText(replacementIdentity);
    await expect(win.locator('.wb-reads.is-live')).toHaveCount(0);
    await expect(win.locator('.wb-chg.is-pending')).toHaveCount(2);
    const busState = await page.evaluate(async () => {
        const ctx = window.Luker.getContext();
        const { sessionBodyNamespace } = await import('/scripts/workbench/model/sessions.js');
        const result = await ctx.getChatState('workbench_sessions');
        if (result.ok !== true) throw new Error(JSON.stringify(result));
        const summary = result.state.sessions.find(item => item.kind === 'iterate' && item.ws === 'memory_graph');
        const bodyRes = await ctx.getChatState(sessionBodyNamespace(summary.id));
        if (bodyRes.ok !== true) throw new Error(JSON.stringify(bodyRes));
        const turn = bodyRes.state.turns.findLast(item => item.state === 'pending');
        return turn.draft.busState;
    });
    const pending = busState.entries.filter(entry => entry.status === 'pending');
    expect(pending).toHaveLength(2);
    expect(JSON.stringify(pending)).not.toContain('note must not survive');
    for (const id of rewoundIds) {
        expect(busState.entries.find(entry => entry.id === id)).toMatchObject({ status: 'rolledBack' });
    }
    expect(busState.outcomeQueue.filter(entry => rewoundIds.includes(entry.id))).toEqual([]);
    await applyIterBatch(page, 'mg-graph');
    await expect.poll(async () => (await readNodeFields(page, 'n_3'))?.state).toBe(EDITED_STATE);
    await expect.poll(async () => (await readNodeFields(page, 'n_2'))?.identity).toBe(replacementIdentity);
}

test.describe('#92 — MG graph studio negative paths', () => {
    test.setTimeout(240_000);

    test('a delayed presentation snapshot cannot assign a new graph conversation to the previous chat', async ({ page }) => {
        await seedChatAndGraph(page);
        const original = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return { id: ctx.getCurrentChatId(), target: ctx.resolveChatStateTarget() };
        });
        const otherId = await createNewChatViaUI(page);
        await sendMessageAndAwaitReply(page, CHAT_TURNS[0]);
        await importMgGraph(page, importPath, { mode: 'bind-latest', closeAfter: true });
        const other = await page.evaluate(() => window.Luker.getContext().resolveChatStateTarget());
        await openChatByName(page, original.id);
        await openIterStudio(page, 'mg-graph');
        await closeIterStudio(page);
        const held = await holdWorkbenchSnapshotHttp(page);
        const prompt = 'Inspect the current chat watchpost without editing it.';
        const readOwnership = () => page.evaluate(async ({ before, after, prompt }) => {
            const ctx = window.Luker.getContext();
            const { sessionBodyNamespace } = await import('/scripts/workbench/model/sessions.js');
            const read = async target => {
                const result = await ctx.getChatState('workbench_sessions', { target });
                if (!result.ok) throw new Error(JSON.stringify(result));
                const matched = [];
                for (const session of (result.state?.sessions || [])) {
                    const bodyRes = await ctx.getChatState(sessionBodyNamespace(session.id), { target });
                    if (!bodyRes.ok) throw new Error(JSON.stringify(bodyRes));
                    if ((bodyRes.state?.turns || []).some(turn => turn.role === 'user' && turn.text === prompt)) {
                        matched.push(session);
                    }
                }
                return matched;
            };
            return { before: await read(before), after: await read(after) };
        }, { before: original.target, after: other, prompt });
        let sessionId;
        try {
            await openChatByName(page, otherId);
            await openIterStudio(page, 'mg-graph', { newSession: true });
            await held.requested();
            mock.scriptReply('The current chat watchpost has been inspected.');
            await sendIterPrompt(page, 'mg-graph', prompt);
            const ownership = await readOwnership();
            expect(ownership.before).toEqual([]);
            expect(ownership.after).toHaveLength(1);
            sessionId = ownership.after[0].id;
        } finally {
            await held.release();
        }
        await closeIterStudio(page);
        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        const persisted = await readOwnership();
        expect(persisted.before).toEqual([]);
        expect(persisted.after.map(session => session.id)).toEqual([sessionId]);
    });

    test('automatic graph editing never retargets a delayed request to another chat', async ({ page }) => {
        await seedChatAndGraph(page);
        const original = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return { id: ctx.getCurrentChatId(), target: ctx.resolveChatStateTarget() };
        });
        const otherId = await createNewChatViaUI(page);
        await sendMessageAndAwaitReply(page, CHAT_TURNS[0]);
        await importMgGraph(page, importPath, { mode: 'bind-latest', closeAfter: true });
        expect((await readNodeFields(page, 'n_3')).state).toBe(BASELINE_STATE);
        await openChatByName(page, original.id);
        await openIterStudio(page, 'mg-graph', { autoApply: true });
        let step = 0;
        mock.scriptCompletion(() => {
            step += 1;
            if (step === 1) return { tool: 'mg_graph_list_nodes', arguments: {} };
            if (step === 2) return { tool: 'mg_graph_edit_node', arguments: { node_id: 'n_3', set_fields: { state: EDITED_STATE } } };
            return null;
        });
        const held = mock.holdNextQueuedRequest();
        try {
            await sendIterPrompt(page, 'mg-graph', 'Record the retrimmed lantern in this watchpost log.', { waitForSettle: false });
            await held.requested;
            await closeIterStudio(page);
            // Switching chats while a chat-scoped Workbench AI iteration is active
            // triggers the Activity Guard confirmation; confirming "Switch anyway"
            // aborts the held turn so it can never retarget the newly opened chat.
            await page.locator('#options_button').click();
            await page.locator('#option_select_chat').click();
            const targetChatId = otherId.replace(/\.jsonl$/i, '');
            const escapedChatId = targetChatId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const exactChat = new RegExp(`^\\s*${escapedChatId}(\\.jsonl)?\\s*$`);
            const chatRow = page.locator('.select_chat_block_wrapper', {
                has: page.locator('.select_chat_block_filename', { hasText: exactChat }),
            }).first();
            await chatRow.locator('.select_chat_block_filename').click();
            const guardPopup = page.locator('dialog.popup[open]').last();
            await expect(guardPopup).toBeVisible();
            await guardPopup.locator('.popup-button-ok').click();
            await page.waitForFunction(wanted => window.Luker.getContext().getCurrentChatId() === wanted, targetChatId, { timeout: 30_000 });
            await page.locator('#shadow_select_chat_popup').waitFor({ state: 'hidden', timeout: 30_000 });
        } finally {
            held.release();
            mock.clearScriptedCompletion();
        }
        const readOriginalTurn = () => page.evaluate(async (target) => {
            const ctx = window.Luker.getContext();
            const { sessionBodyNamespace } = await import('/scripts/workbench/model/sessions.js');
            const result = await ctx.getChatState('workbench_sessions', { target });
            if (!result.ok) throw new Error(JSON.stringify(result));
            const summary = result.state.sessions.find(item => item.ws === 'memory_graph');
            const bodyRes = await ctx.getChatState(sessionBodyNamespace(summary.id), { target });
            if (!bodyRes.ok) throw new Error(JSON.stringify(bodyRes));
            return bodyRes.state.turns.at(-1);
        }, original.target);
        await expect.poll(async () => {
            const turn = await readOriginalTurn();
            return turn?.role === 'ai' && turn.state !== 'pending';
        }).toBe(true);
        expect((await readNodeFields(page, 'n_3')).state).toBe(BASELINE_STATE);
        const settledTurn = await readOriginalTurn();
        expect(settledTurn.changes ?? []).toEqual([]);
        expect(settledTurn.error).toBeTruthy();

        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        expect((await readNodeFields(page, 'n_3')).state).toBe(BASELINE_STATE);
        await openChatByName(page, original.id);
        expect((await readNodeFields(page, 'n_3')).state).toBe(BASELINE_STATE);
        await openIterStudio(page, 'mg-graph', { autoApply: false });
        await closeIterStudio(page);
    });

    test('stopping a chained turn discards only its proposals', async ({ page }) => {
        await verifyAbandonedTurn(page, 'stop');
        await expect(workbenchWindow(page).locator('.wb-chg.is-applied')).toHaveCount(2);
    });

    test('answering a chained turn again discards only the replaced proposals', async ({ page }) => {
        await verifyAbandonedTurn(page, 'regenerate');
        await expect(workbenchWindow(page).locator('.wb-chg.is-applied')).toHaveCount(2);
    });

    test('answering an applied chained turn again preserves earlier pending proposals', async ({ page }) => {
        await verifyAbandonedTurn(page, 'applied');
        await expect(workbenchWindow(page).locator('.wb-chg.is-applied')).toHaveCount(2);
    });

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
        await openIterStudio(page, 'mg-graph', { autoApply: false });
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
        await openIterStudio(page, 'mg-graph', { autoApply: false });
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
