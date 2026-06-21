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
    deleteMessageViaUI,
    openExtensionsDrawer,
    openInlineDrawer,
    closeExtensionsDrawer,
} from '../_lib/page.js';

let server, mock, importPath;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [
        '*Seraphina folds the chart and meets your eyes.* "The lantern will hold."',
        '*She traces a line on the chart with one knuckle.* "Breakers north of the gulls."',
        '*Seraphina exhales slowly.* "The drifters know that channel better than we do."',
        '*She turns to the rail, spyglass raised.* "Hold. Don\'t speak for a moment."',
        '*Seraphina nods once.* "Then it is decided. We wait."',
    ] });
    server = await startServer({ batchKey: 'memorygraph', scenarioId: 'floor-anchor' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

    // Three sentinel nodes. Imported with "Bind Latest Floor" mode, they
    // anchor to the chat's current tail floor — the exact precondition
    // for the floor-anchor regression check.
    const tmpDir = mkdtempSync(resolve(tmpdir(), 'mg-anchor-'));
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
    await tearDownServer(server);
    await mock?.stop();
});

async function enableMgViaCheckboxes(page) {
    await openExtensionsDrawer(page);
    await openInlineDrawer(page, 'memory_graph_settings').catch(() => {});
    await page.evaluate(() => {
        for (const id of ['luker_rpg_memory_enabled', 'luker_rpg_memory_auto_extraction_enabled']) {
            const el = document.getElementById(id);
            if (el && !el.checked) {
                el.checked = true;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }
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
}

test.describe('#53 — session-write floor anchor: delete-floor truncates MG records', () => {
    test('5 turns → import sentinels bound to tail → delete last assistant → sentinels are gone', async ({ page }) => {
        test.setTimeout(180_000);
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await enableMgViaCheckboxes(page);

        // Disable the delete-confirmation popup so deleteMessageViaUI does
        // not need a follow-up OK click.
        await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            if (ctx.powerUserSettings) ctx.powerUserSettings.confirm_message_delete = false;
        });

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

        // Now disable MG auto-extraction: from here on we don't want each
        // delete / import / sentinel-load to fan out another extraction
        // LLM call through the mock (which would queue in-flight requests
        // and cascade into the delete-message emit chain hanging — the
        // exact pattern documented in deleteMessageViaUI's comment block).
        // The extraction we needed for the spec (none in this case; we
        // import sentinels directly) is already done.
        await page.evaluate(() => {
            const el = document.getElementById('luker_rpg_memory_auto_extraction_enabled');
            if (el && el.checked) {
                el.checked = false;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }
        });

        // Seed MG via the real Import button → bind latest floor.
        await importMgGraphBindLatest(page, importPath);
        // Belt-and-suspenders: ensure the popup overlay is fully gone
        // before subsequent gestures.
        await page.locator('.popup:visible').first().waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(500);
        // The Extensions drawer is still open from enableMgViaCheckboxes +
        // importMgGraphBindLatest. It covers the chat area; subsequent
        // .mes locator interactions can't reach the message. Close it.
        await closeExtensionsDrawer(page);

        // Verify the sentinels are visible BEFORE the delete.
        const beforeDelete = await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            const mg = ctx.getExtensionApi?.('memory-graph');
            const session = await mg?.openSession?.(ctx);
            if (!session) return { titles: [], chatLen: ctx.chat.length };
            const titles = session.listVisibleCandidates({})
                .map(n => n.title)
                .filter(t => /TailAnchor/.test(t))
                .sort();
            return { titles, chatLen: ctx.chat.length };
        });
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
        await mes.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
        await mes.hover().catch(() => {});

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

        // Drop the cached store so the next read replays the (truncated)
        // floor-state log from disk.
        await page.evaluate(async () => {
            try {
                const mod = await import('/scripts/extensions/memory-graph/main.js');
                if (mod.invalidateMemoryStoreCache) mod.invalidateMemoryStoreCache();
            } catch { /* best-effort */ }
        });

        const afterDelete = await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            const mg = ctx.getExtensionApi?.('memory-graph');
            const session = await mg?.openSession?.(ctx);
            if (!session) return { titles: [] };
            const titles = session.listVisibleCandidates({})
                .map(n => n.title)
                .filter(t => /TailAnchor/.test(t))
                .sort();
            return { titles };
        });

        expect(
            afterDelete.titles,
            `expected all TailAnchor sentinels to truncate with the deleted floor, but these survived: ${JSON.stringify(afterDelete.titles)}`,
        ).toEqual([]);
    });
});
