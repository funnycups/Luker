// tests/e2e/memorygraph/55-branch-isolates-source-mg.e2e.js
//
// #55 — Branch chat doesn't pollute source MG (FIXED 2026-05-27 in
// 86a2fce52 + a845f4645).
//
// Bug shape: when branching a chat at a past message, memory-graph could
// copy the source chat's full (untruncated) graph into the branch and
// then DELETE the source's sidecars. The fix scopes MG state per-chat
// and inherits only the records that anchor at floors ≤ branch point.
//
// Real-user flow:
//   1. Enable MG via the real checkbox.
//   2. Send 5 user turns via the textarea + send button.
//   3. Seed source MG with 3 distinctive sentinel nodes via the real
//      Import button (bind latest floor) — they anchor to the source
//      chat's tail.
//   4. Branch from an early message via branchFromMessageViaUI (real
//      message-action button click). ST emits CHAT_CHANGED on the
//      switch.
//   5. In the branch, send one more turn so the branch chat has its
//      own tail. Import a BRANCH-only sentinel.
//   6. Verify: branch's listVisibleCandidates does NOT contain any of
//      the source's late sentinels (the smoking-gun leak). Branch
//      sentinel IS visible.

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
    branchFromMessageViaUI,
    openExtensionsDrawer,
    openInlineDrawer,
    closeExtensionsDrawer,
} from '../_lib/page.js';

let server, mock, sourceImportPath, branchImportPath;

test.beforeAll(async () => {
    mock = await startMockLLM({
        scriptedReplies: [
            '*Seraphina folds the chart and meets your eyes.* "The lantern will hold another hour."',
            '*She traces a line on the chart with one knuckle.* "Three breakers north of the gull rocks."',
            '*Seraphina exhales slowly.* "The drifters know that channel better than we do."',
            '*She turns to the rail, spyglass raised.* "Hold. Don\'t speak for a moment."',
            '*Seraphina nods once.* "Then it is decided. We wait."',
            // Reply for the branched chat (which forks off after an
            // earlier turn).
            '*Ash takes a breath, considering the alternate path.* "Chart toward the headland instead — the reef gives a different account from that angle."',
        ],
    });
    server = await startServer({ batchKey: 'memorygraph', scenarioId: 'branch-isolation' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

    const tmpDir = mkdtempSync(resolve(tmpdir(), 'mg-branch-'));
    sourceImportPath = resolve(tmpDir, 'source-sentinels.json');
    branchImportPath = resolve(tmpDir, 'branch-sentinel.json');

    writeFileSync(sourceImportPath, JSON.stringify({
        version: 2,
        nodeSeq: 3,
        seqCounter: 5,
        appliedSeqTo: 5,
        loggedSeqTo: 5,
        nodes: {
            n_1: {
                id: 'n_1', type: 'character_sheet', level: 'semantic',
                title: 'SOURCE-S1 cliff lantern keeper', parentId: '', childrenIds: [],
                fields: {
                    title: 'SOURCE-S1 cliff lantern keeper',
                    identity: 'Bryn 断崖夜哨；第一夜负责修剪信号灯。',
                    traits: '冷静、寡言、对夜风极敏感。',
                },
                seqTo: 5,
            },
            n_2: {
                id: 'n_2', type: 'character_sheet', level: 'semantic',
                title: 'SOURCE-S2 reef sentinel', parentId: '', childrenIds: [],
                fields: {
                    title: 'SOURCE-S2 reef sentinel',
                    identity: '夜间礁石回响监视员；第一夜中段记录涌动征兆。',
                    traits: '感官敏锐，对礁石声响极为熟悉。',
                },
                seqTo: 5,
            },
            n_3: {
                id: 'n_3', type: 'character_sheet', level: 'semantic',
                title: 'SOURCE-S3 Seraphina latest', parentId: '', childrenIds: [],
                fields: {
                    title: 'SOURCE-S3 Seraphina latest',
                    identity: 'Bryn 断崖的常驻海图官；本夜后段决定按兵不动等待天明。',
                    traits: '冷静、寡言、对夜风极敏感；今夜情绪偏沉重。',
                },
                seqTo: 5,
            },
        },
        edges: [],
    }, null, 2));

    writeFileSync(branchImportPath, JSON.stringify({
        version: 2,
        nodeSeq: 1,
        seqCounter: 3,
        appliedSeqTo: 3,
        loggedSeqTo: 3,
        nodes: {
            n_1: {
                id: 'n_1', type: 'character_sheet', level: 'semantic',
                title: 'BRANCH-ONLY chart-side scout', parentId: '', childrenIds: [],
                fields: {
                    title: 'BRANCH-ONLY chart-side scout',
                    identity: '只在分支线出现的侦察员；负责勘察断崖侧的礁石阵列。',
                    traits: '只存在于分支聊天；绝不能泄漏回原线。',
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

async function importMgGraphBindLatest(page, filePath) {
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

test.describe('#55 — Branch chat keeps source MG intact (real branch UI)', () => {
    test.setTimeout(240_000);

    test('5 turns + sentinels → branch via UI → branch sees its own sentinel, not source late sentinels', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await enableMgViaCheckbox(page);

        await page.waitForFunction(() => {
            const ctx = window.Luker?.getContext?.();
            return Array.isArray(ctx?.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        // 5 user/asst turns populate the source chat tail.
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

        // Seed source MG with sentinels anchored to the source chat tail.
        await importMgGraphBindLatest(page, sourceImportPath);

        const sourceSnapshot = await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            const mg = ctx.getExtensionApi?.('memory-graph');
            const session = await mg?.openSession?.(ctx);
            const titles = session
                ? session.listVisibleCandidates({}).map(n => n.title).filter(t => /SOURCE-S/.test(t)).sort()
                : [];
            return { sourceChatId: ctx.getCurrentChatId?.() || '', sourceTitles: titles };
        });
        expect(sourceSnapshot.sourceTitles).toEqual([
            'SOURCE-S1 cliff lantern keeper',
            'SOURCE-S2 reef sentinel',
            'SOURCE-S3 Seraphina latest',
        ]);

        // The Extensions drawer is still open from enableMgViaCheckbox +
        // importMgGraphBindLatest — it covers the chat area where the
        // .mes_create_branch button lives. Close it before branching.
        await closeExtensionsDrawer(page);

        // Branch from an early message via the real branch button. The
        // greeting is at index 0; the first user turn at 1; the first
        // assistant turn at 2. Branching from mesId=2 forks off "after
        // the first user/asst pair" — all 3 source sentinels were
        // anchored to mesId > 2, so they MUST NOT appear in the branch.
        await branchFromMessageViaUI(page, 2);
        // ST's branch path renames + switches chat; let the listeners
        // settle.
        await page.waitForTimeout(1500);

        const branchChatId = await page.evaluate(() => window.Luker.getContext().getCurrentChatId?.() || '');
        expect(branchChatId, `branch chat id should differ from source (${sourceSnapshot.sourceChatId})`).not.toBe(sourceSnapshot.sourceChatId);

        // Send one turn in the branch so it has its own tail.
        await sendMessageAndAwaitReply(page, 'Chart toward the headland instead — let me see the south reef.');
        // Import the branch-only sentinel.
        await importMgGraphBindLatest(page, branchImportPath);

        const branchSnapshot = await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            const mg = ctx.getExtensionApi?.('memory-graph');
            const session = await mg?.openSession?.(ctx);
            const cands = session ? session.listVisibleCandidates({}) : [];
            return {
                branchChatId: ctx.getCurrentChatId?.() || '',
                branchTitles: cands.map(n => n.title).filter(t => /BRANCH-ONLY/.test(t)),
                leakedSourceTitles: cands.map(n => n.title).filter(t => /SOURCE-S/.test(t)).sort(),
            };
        });
        expect(branchSnapshot.branchTitles, 'branch can see its own sentinel').toContain('BRANCH-ONLY chart-side scout');
        expect(
            branchSnapshot.leakedSourceTitles,
            `branch must NOT see SOURCE-S* sentinels; leaked=${JSON.stringify(branchSnapshot.leakedSourceTitles)}`,
        ).toEqual([]);
    });
});
