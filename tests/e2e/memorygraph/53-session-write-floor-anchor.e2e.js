// tests/e2e/memorygraph/53-session-write-floor-anchor.e2e.js
//
// #53 — Regression lock for `known_bug_mg_session_write_floor` (fixed
// 2026-05-28 in 9663b9ce7).
//
// Pre-fix, MG state commits stamped the floor-state commit at a lagged
// seq. Deleting the floor where those records landed left them as
// orphans. The fix anchors writes at the chat tail's in-flight floor so
// deleting that floor truncates the records with it.
//
// What this test pins through real-user gestures:
//   1. Enable MG via the real checkbox + auto-extraction checkbox.
//   2. Send 5 user turns via the textarea + send button.
//   3. Import a small graph store via the real Import button + file
//      picker, accepting "Bind Latest Floor" — this writes the imported
//      nodes anchored to the chat tail (mesId = chat.length - 1).
//   4. Confirm via Layer-1 read API that the 3 sentinels are visible.
//   5. Delete the LATEST assistant message via the REAL trash icon
//      (deleteMessageViaUI — pencil → delete).
//   6. The CORE assertion: the 3 sentinels (anchored to the deleted
//      floor) must NOT survive — they truncate alongside the deleted
//      assistant turn.

import { test, expect } from '../../harness/playwright.js';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    selectCharacterByName,
    sendMessageAndAwaitReply,
    deleteMessageViaUI,
    reloadAndAwait,
} from '../_lib/page.js';
import { importMgGraph, setMgSettings } from '../_lib/ui-mg-varops.js';

let server, mock, importPath;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({ scriptedReplies: [
        '*Seraphina folds the chart and meets your eyes.* "The lantern will hold."',
        '*She traces a line on the chart with one knuckle.* "Breakers north of the gulls."',
        '*Seraphina exhales slowly.* "The drifters know that channel better than we do."',
        '*She turns to the rail, spyglass raised.* "Hold. Don\'t speak for a moment."',
        '*Seraphina nods once.* "Then it is decided. We wait."',
    ] });
    server = await startServer({ scope, batchKey: 'memorygraph', scenarioId: 'floor-anchor' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

    // Three sentinel nodes. Imported with "Bind Latest Floor" mode, they
    // anchor to the chat's current tail floor — the exact precondition
    // for the floor-anchor regression check.
    const tmpDir = (await scope.directory('mg-anchor')).path;
    importPath = resolve(tmpDir, 'sentinels.json');
    writeFileSync(importPath, JSON.stringify({
        version: 2,
        nodeSeq: 3,
        seqCounter: 5,
        appliedSeqTo: 5,
        loggedSeqTo: 5,
        nodes: {
            n_1: {
                id: 'n_1', type: 'character_sheet', level: 'semantic',
                title: 'TailAnchorChar-A', parentId: '', childrenIds: [],
                fields: {
                    title: 'TailAnchorChar-A',
                    identity: '时间：第五幕末段；user 临时召唤的盐礁夜哨。',
                    traits: '冷静、寡言、对夜风极敏感。',
                },
                seqTo: 5,
            },
            n_2: {
                id: 'n_2', type: 'character_sheet', level: 'semantic',
                title: 'TailAnchorChar-B', parentId: '', childrenIds: [],
                fields: {
                    title: 'TailAnchorChar-B',
                    identity: '时间：第五幕末段；与 TailAnchorChar-A 同行的轻舟匠。',
                    traits: '务实、爱讲冷笑话。',
                },
                seqTo: 5,
            },
            n_3: {
                id: 'n_3', type: 'location_state', level: 'semantic',
                title: 'TailAnchorPost', parentId: '', childrenIds: [],
                fields: {
                    title: 'TailAnchorPost',
                    state: '夜风骤起；信号灯被风吹斜。',
                    controller: 'Seraphina',
                },
                seqTo: 5,
            },
        },
        edges: [],
    }, null, 2));
});

test.afterAll(async () => {

    await mock?.stop();
});

/**
 * Read the TailAnchor sentinel titles through the memory-graph session of
 * the current chat, together with whether the session opened and the chat
 * length.
 */
async function readTailAnchors(page) {
    return page.evaluate(async () => {
        const ctx = window.Luker.getContext();
        const mg = ctx.getExtensionApi?.('memory-graph');
        const session = await mg?.openSession?.(ctx);
        const titles = session
            ? session.listVisibleCandidates({}).map(n => n.title).filter(t => /TailAnchor/.test(t)).sort()
            : [];
        return { sessionOk: Boolean(session), chatLen: ctx.chat.length, titles };
    });
}

test.describe('#53 — session-write floor anchor: delete-floor truncates MG records', () => {
    test('5 turns → import sentinels bound to tail → delete last assistant → sentinels are gone', async ({ page }) => {
        test.setTimeout(180_000);
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await setMgSettings(page, { enabled: true, autoExtractionEnabled: true }, { closeAfter: true });

        // 5 RP turns so the chat tail anchor is non-trivial.
        for (const t of [
            'The first watch begins. The lantern is steady.',
            'A skiff drifted south of the gull rocks an hour ago.',
            'The reef sounds different tonight — slower, like breath.',
            'I think the drifters are coming back along the old salt-mark.',
            'Hold the watch. I will fetch the chart.',
        ]) {
            await sendMessageAndAwaitReply(page, t);
        }

        await setMgSettings(page, { autoExtractionEnabled: false });
        await importMgGraph(page, importPath, { mode: 'bind-latest', closeAfter: true });
        await page.waitForTimeout(500);

        // Positive control: after a reload the sentinels must come back
        // through the same disk-replay read used after the delete, so their
        // later absence can only mean truncation.
        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        const beforeDelete = await readTailAnchors(page);
        expect(beforeDelete.sessionOk, 'memory-graph session must open after reload').toBe(true);
        expect(beforeDelete.titles).toEqual([
            'TailAnchorChar-A',
            'TailAnchorChar-B',
            'TailAnchorPost',
        ]);

        // Delete the LAST assistant message via the real trash icon.
        const lastAssistantId = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            for (let i = ctx.chat.length - 1; i >= 0; i--) {
                if (!ctx.chat[i]?.is_user) return i;
            }
            return -1;
        });
        expect(lastAssistantId, 'expected an assistant message at the tail').toBeGreaterThanOrEqual(0);

        // Hover + scroll the target message so its .extraMesButtons row
        // renders and the .mes_edit pencil is reachable.
        const mes = page.locator(`.mes[mesid="${lastAssistantId}"]`);
        await mes.scrollIntoViewIfNeeded({ timeout: 5000 });
        await mes.hover();

        await deleteMessageViaUI(page, lastAssistantId);

        // Wait for the deletion to settle and the rebuild listener to
        // sweep the surviving graph state. deleteMessageViaUI returns as
        // soon as `chat.splice` lands, but memory-graph's async listener
        // (`applyMutationInvalidation` → floor-state refresh + meta save)
        // can take several seconds and is what actually truncates the
        // sentinels on disk. Give it time before invalidating the cache
        // and reading fresh.
        await page.waitForFunction((prevLen) => {
            const ctx = window.Luker.getContext();
            return ctx.chat.length === prevLen - 1;
        }, beforeDelete.chatLen, { timeout: 15_000 });
        // Yield generously so the MG MESSAGE_DELETED listener can complete
        // its async chain (refreshMemoryStoreCacheFromFloorState →
        // persistMetaForChatKey → sync*LorebookProjection). 5s is empiric
        // — most of these chains settle in 1-2s on a small store; the
        // extra slack covers slow CI.
        await page.waitForTimeout(5000);

        // Reload so the next read replays the (truncated) floor-state log
        // from disk instead of the in-memory store.
        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        const afterDelete = await readTailAnchors(page);
        expect(afterDelete.sessionOk, 'memory-graph session must open after reload').toBe(true);
        expect(afterDelete.chatLen, 'the reloaded chat must have one message fewer').toBe(beforeDelete.chatLen - 1);
        expect(
            afterDelete.titles,
            `expected all TailAnchor sentinels to truncate with the deleted floor, but these survived: ${JSON.stringify(afterDelete.titles)}`,
        ).toEqual([]);
    });
});
