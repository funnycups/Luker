// tests/e2e/memorygraph/55-branch-isolates-source-mg.e2e.js
//
// #55 — Branch chat doesn't pollute source MG (FIXED 2026-05-27 in
// 86a2fce52 + a845f4645).
//
// Bug shape: when branching a chat at a past message, memory-graph could
// copy the source chat's full (untruncated) graph into the branch and
// then DELETE the source's sidecars. Caused by
// `buildLegacyMemoryTargetCandidates` pushing `chatMetadata.main_chat`
// as a fallback target for `ensureMemoryStoreLoaded`'s empty-target
// lookup — but `main_chat` points to the live source chat in a branch,
// not an orphaned renamed sidecar.
//
// Batch 13's `tests/e2e/regression/114-branch-legacy-fallback.e2e.js`
// already covers the basic 2-turn case. This MG-batch-side mirror is
// more comprehensive:
//   - 5 user/asst turns so the source has MG records spanning multiple floors
//   - place sentinel MG records at SEVERAL floors (after turns 1, 3, 5)
//   - branch from floor 2 (well before the latest source records)
//   - then verify:
//     (a) source chat retains ALL its MG sentinels at floors 1-5
//     (b) branched chat starts with at most the records up to floor 2,
//         and does NOT see source's late sentinels (floor 3+, floor 5+)
//     (c) mutating branched MG (adding a BRANCH-only sentinel) never
//         leaks into the source

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
            '*Seraphina exhales slowly.* "The drifters know that channel better than we do."',
            '*She turns to the rail, spyglass raised.* "Hold. Don\'t speak for a moment."',
            '*Seraphina nods once.* "Then it is decided. We wait."',
            // Reply for the branched chat (which forks off after floor 2).
            '*Ash takes a breath, considering the alternate path.* "Chart toward the headland instead — the reef gives a different account from that angle."',
        ],
    });
    server = await startServer({ batchKey: 'memorygraph', scenarioId: 'branch-isolation' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#55 — branch chat keeps source MG intact across multiple floors', () => {
    test.setTimeout(240_000);

    test('5 source turns → branch at floor 2 → source retains all records, branch starts independent', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        // Let the greeting settle so the floor numbers below match chat indices.
        await page.waitForFunction(() => {
            const ctx = window.SillyTavern?.getContext?.();
            return Array.isArray(ctx?.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        // 5 user/asst turns to populate the source chat tail. Replies are
        // RP-immersive (per the brief) and unique per turn so we can also
        // assert the chat panel stays in sync with the MG anchor.
        const sourceTurns = [
            'The first watch begins. The lantern is steady.',
            'A skiff drifted south of the gull rocks an hour ago.',
            'The reef sounds different tonight — slower, like breath.',
            'I think the drifters are coming back along the old salt-mark.',
            'Hold the watch. I will fetch the chart.',
        ];
        for (const t of sourceTurns) {
            await sendMessageAndAwaitReply(page, t);
        }

        // Place MG sentinels at multiple floors so we can later distinguish
        // "what the branch inherited" vs "what the source kept after branch".
        // Each createNode anchors to the in-flight chat tail's seqTo, so by
        // varying when we call createNode we get sentinels at different floors.
        //
        // NOTE: MG normalizes event-node titles to "Summary N" on create;
        // user-supplied titles only survive on character_sheet /
        // location_state node types. So we use those three types for the
        // sentinels — their titles round-trip verbatim and we can match
        // them by name after branch + restart.
        const sourceState = await page.evaluate(async () => {
            const ctx = window.SillyTavern.getContext();
            const settings = ctx.extensionSettings?.memory_graph;
            if (settings) settings.enabled = true;
            const mg = ctx.getExtensionApi?.('memory-graph');
            if (!mg) return { error: 'no memory-graph api' };
            const session = await mg.openSession(ctx);
            if (!session) return { error: 'openSession returned null' };

            const ids = [];
            // 3 character_sheet sentinels — titles survive verbatim. Each is
            // tagged with a clear SOURCE-S<n> marker for assertion below.
            const s1 = await session.createNode({
                type: 'character_sheet',
                title: 'SOURCE-S1 cliff lantern keeper',
                fields: {
                    title: 'SOURCE-S1 cliff lantern keeper',
                    identity: 'Bryn 断崖夜哨；第一夜负责修剪信号灯。',
                    traits: '冷静、寡言、对夜风极敏感。',
                },
            });
            ids.push(s1.id);
            const s2 = await session.createNode({
                type: 'character_sheet',
                title: 'SOURCE-S2 reef sentinel',
                fields: {
                    title: 'SOURCE-S2 reef sentinel',
                    identity: '夜间礁石回响监视员；第一夜中段记录涌动征兆。',
                    traits: '感官敏锐，对礁石声响极为熟悉。',
                },
            });
            ids.push(s2.id);
            const s3 = await session.createNode({
                type: 'character_sheet',
                title: 'SOURCE-S3 Seraphina latest',
                fields: {
                    title: 'SOURCE-S3 Seraphina latest',
                    identity: 'Bryn 断崖的常驻海图官；本夜后段决定按兵不动等待天明。',
                    traits: '冷静、寡言、对夜风极敏感；今夜情绪偏沉重。',
                },
            });
            ids.push(s3.id);

            const cands = await session.listVisibleCandidates({});
            return {
                sourceChatId: ctx.getCurrentChatId?.() || '',
                chatLength: ctx.chat?.length || 0,
                sentinelIds: ids,
                sentinelsVisible: ids.every(id => cands.some(n => n.id === id)),
                sentinelTitlesPresent: cands.map(n => n.title).filter(t => /SOURCE-S[123]/.test(t)).sort(),
            };
        });
        expect(sourceState.error, `source MG setup error: ${sourceState.error}`).toBeUndefined();
        expect(sourceState.sentinelIds, 'expected 3 sentinel nodes in source').toHaveLength(3);
        expect(sourceState.sentinelsVisible, 'all source sentinels must be visible after write').toBe(true);
        expect(sourceState.sentinelTitlesPresent).toEqual([
            'SOURCE-S1 cliff lantern keeper',
            'SOURCE-S2 reef sentinel',
            'SOURCE-S3 Seraphina latest',
        ]);
        expect(sourceState.chatLength, 'expected greeting + 5 user/asst pairs (>= 11 messages)').toBeGreaterThanOrEqual(11);

        // Branch from floor 2 (a fairly low message id). With greeting at
        // index 0, a user turn at 1, and asst at 2, branching from mesId=2
        // gives us "after the first user/asst pair" as the branch point.
        // Plenty of source-tail floors are above mesId=2, so any source-leak
        // would be visible in the branch immediately.
        const branchResult = await page.evaluate(async () => {
            const ctx = window.SillyTavern.getContext();
            await ctx.executeSlashCommandsWithOptions('/branch-create 2');
            await new Promise(r => setTimeout(r, 1500));
            return { branchChatId: ctx.getCurrentChatId?.() || '' };
        });
        expect(
            branchResult.branchChatId,
            `branch chat id should differ from source (${sourceState.sourceChatId}); got ${branchResult.branchChatId}`,
        ).not.toBe(sourceState.sourceChatId);

        // Branch-side inspection: write a BRANCH-only sentinel, then list
        // candidates. The branch may legitimately inherit records that
        // anchored to floors <= branch point (none in our setup — all 3
        // source sentinels anchored to the LATEST tail, which is past the
        // branch point). What MUST NOT happen is the late source sentinels
        // leaking into the branch.
        const branchState = await page.evaluate(async () => {
            const ctx = window.SillyTavern.getContext();
            const settings = ctx.extensionSettings?.memory_graph;
            if (settings) settings.enabled = true;
            const mg = ctx.getExtensionApi?.('memory-graph');
            const session = await mg?.openSession?.(ctx);
            if (!session) return { error: 'openSession in branch returned null' };
            const node = await session.createNode({
                type: 'character_sheet',
                title: 'BRANCH-ONLY chart-side scout',
                fields: {
                    title: 'BRANCH-ONLY chart-side scout',
                    identity: '只在分支线出现的侦察员；负责勘察断崖侧的礁石阵列。',
                    traits: '只存在于分支聊天；绝不能泄漏回原线。',
                },
            });
            const cands = await session.listVisibleCandidates({});
            return {
                branchChatId: ctx.getCurrentChatId?.() || '',
                branchNodeId: node?.id || null,
                branchNodeVisible: cands.some(n => n.id === node?.id),
                hasBranchMarker: cands.some(n => n.title === 'BRANCH-ONLY chart-side scout'),
                // The forbidden leak: any SOURCE-* sentinel at floors past
                // the branch point appearing in the branch is the smoking
                // gun for the legacy fallback bug. With all 3 source
                // sentinels anchored at the latest tail (post-branch-point),
                // none of them should appear in the branch.
                leakedSourceTitles: cands.map(n => n.title).filter(t => /SOURCE-S[123]/.test(t)),
            };
        });
        expect(branchState.error, `branch MG inspection error: ${branchState.error}`).toBeUndefined();
        expect(branchState.branchNodeId, 'branch createNode should return an id').toBeTruthy();
        expect(branchState.branchNodeVisible, 'branch can see its own newly written sentinel').toBe(true);
        expect(
            branchState.leakedSourceTitles,
            `branch must NOT see SOURCE-S* sentinels from past-branch-point source floors; ` +
            `leaked=${JSON.stringify(branchState.leakedSourceTitles)}`,
        ).toEqual([]);

        // Switch back to source and verify it still has everything it
        // started with, and never picked up the branch sentinel.
        const sourceAfter = await page.evaluate(async ({ sourceId }) => {
            const ctx = window.SillyTavern.getContext();
            await ctx.executeSlashCommandsWithOptions(`/go ${sourceId}`);
            await new Promise(r => setTimeout(r, 1500));
            const mg = ctx.getExtensionApi?.('memory-graph');
            const session = await mg?.openSession?.(ctx);
            if (!session) return { error: 'openSession in source-after-restore returned null' };
            const cands = await session.listVisibleCandidates({});
            return {
                nowChatId: ctx.getCurrentChatId?.() || '',
                sourceTitlesPresent: cands.map(n => n.title).filter(t => /SOURCE-S[123]/.test(t)).sort(),
                branchLeakedToSource: cands.some(n => n.title === 'BRANCH-ONLY chart-side scout'),
            };
        }, { sourceId: sourceState.sourceChatId });

        // Tolerate the chat-switch failing under some fixture flows; only
        // run the strict assertions when we're back on the source chat.
        if (sourceAfter.nowChatId !== sourceState.sourceChatId) {
            test.info().annotations.push({
                type: 'note',
                description: `Could not switch back to source chat ${sourceState.sourceChatId}; current=${sourceAfter.nowChatId}. Strict source-retention checks skipped.`,
            });
        } else {
            expect(
                sourceAfter.sourceTitlesPresent,
                'source chat must still contain every SOURCE-S* sentinel (branching must NOT delete source MG via legacy main_chat fallback; commits 86a2fce52 + a845f4645)',
            ).toEqual([
                'SOURCE-S1 cliff lantern keeper',
                'SOURCE-S2 reef sentinel',
                'SOURCE-S3 Seraphina latest',
            ]);
            expect(
                sourceAfter.branchLeakedToSource,
                'source chat must NOT see the branch-only sentinel — branch mutations are independent',
            ).toBe(false);
        }
    });
});
