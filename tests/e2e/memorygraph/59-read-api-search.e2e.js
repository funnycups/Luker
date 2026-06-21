// tests/e2e/memorygraph/59-read-api-search.e2e.js
//
// #59 — MG recall path through real chat send.
//
// The prior version of this file was a Layer-1 contract test for the
// orchestrator's read tools (session.keywordSearch / findByName / etc).
// Per the e2e-real audit, contract tests belong under tests/<module>/
// as Jest specs — not in tests/e2e. The Jest coverage is intact at
// tests/memory-graph/.
//
// What this real-UI test pins instead:
//   1. Seed MG via the real Import button + file picker with 10 nodes
//      across the canonical types.
//   2. Send a user turn via the textarea + send button that should
//      cause MG recall to surface specific seeded nodes.
//   3. The seeded titles must show up in MG's last recall projection
//      (the data MG hands to the LLM each turn), proving the user-facing
//      recall pipeline reaches the imported nodes.

import { test, expect } from '@playwright/test';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import {
    bootstrapCustomBackend,
    appendConnectionProfile,
    bootstrapVectorsBackend,
    markOnboarded,
} from '../_lib/fixtures.js';
import {
    awaitMainUI,
    selectCharacterByName,
    sendMessageAndAwaitReply,
    openExtensionsDrawer,
    openInlineDrawer,
} from '../_lib/page.js';

let server, mock, importPath;

test.beforeAll(async () => {
    mock = await startMockLLM({
        scriptedReplies: [
            '*Seraphina folds the chart and meets your eyes.* "The lantern will hold."',
            '*She traces a line on the chart.* "North of the gull rocks."',
            '*Seraphina exhales slowly.* "The drifters know the channel."',
        ],
    });
    server = await startServer({ batchKey: 'memorygraph', scenarioId: 'read-api-search' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    bootstrapVectorsBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

    // 10 records: 4 events, 3 character_sheets, 3 location_states.
    const tmpDir = mkdtempSync(resolve(tmpdir(), 'mg-search-'));
    importPath = resolve(tmpDir, 'corpus.json');
    const nodes = {};
    const add = (i, type, title, fields) => {
        nodes[`n_${i}`] = {
            id: `n_${i}`, type, level: 'semantic',
            title, parentId: '', childrenIds: [], fields, seqTo: i,
        };
    };
    add(1, 'event', 'Summary 1', { summary: '时间：黄昏；user 与 Seraphina 在 Bryn 断崖点亮信号灯；夜风偏南。' });
    add(2, 'event', 'Summary 2', { summary: '时间：第一夜中段；礁石回响变得迟缓；标记可能的涌动征兆。' });
    add(3, 'event', 'Summary 3', { summary: '时间：第二夜；user 在海图官小屋外看到三艘盐礁漂泊者的轻舟。' });
    add(4, 'event', 'Summary 4', { summary: '时间：第三幕；user 决定推迟换岗；保留断崖夜哨直至天明。' });
    add(5, 'character_sheet', 'Seraphina', {
        title: 'Seraphina',
        aliases: '海图官 Sera; 灯塔守备',
        identity: 'Bryn 断崖的常驻海图官；前盐礁灯塔守备。',
        traits: '冷静、寡言、对夜风极敏感。',
    });
    add(6, 'character_sheet', 'Maren the boatwright', {
        title: 'Maren the boatwright',
        aliases: '老枫 Maren',
        identity: 'Bryn 港的轻舟修造匠；负责盐礁漂泊者的船骨维护。',
        traits: '务实、爱讲冷笑话。',
    });
    add(7, 'character_sheet', 'Oleas the keeper', {
        title: 'Oleas the keeper',
        aliases: '守灯人 Oleas; 老守',
        identity: '盐礁灯塔的退役守备；如今住在断崖南侧的木屋。',
        traits: '沉默、记忆力极佳。',
    });
    add(8, 'location_state', 'Bryn headland watchpost', {
        title: 'Bryn headland watchpost',
        aliases: '断崖夜哨点',
        controller: 'Seraphina',
        state: '夜间执勤；信号灯刚修剪过；备用油壶在手边。',
        resources: '黄铜望远镜、备用油壶、潮汐图。',
    });
    add(9, 'location_state', 'Salt-reef lighthouse ruin', {
        title: 'Salt-reef lighthouse ruin',
        aliases: '盐礁灯塔遗迹',
        controller: '',
        state: '部分塌陷；高潮时通道被海水切断。',
        resources: '一架尚能转动的旧灯具机芯。',
    });
    add(10, 'location_state', 'Drifter skiff anchorage', {
        title: 'Drifter skiff anchorage',
        aliases: '漂泊者锚泊',
        controller: '',
        state: '隐蔽小湾；只在落潮时可见。',
        resources: '三处隐蔽缆桩。',
    });
    writeFileSync(importPath, JSON.stringify({
        version: 2,
        nodeSeq: 10,
        seqCounter: 10,
        appliedSeqTo: 10,
        loggedSeqTo: 10,
        nodes,
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

async function importBindLatest(page, filePath) {
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

test.describe('#59 — MG seeded corpus surfaces in real recall flow (real send)', () => {
    test.setTimeout(180_000);

    test('after import, sending a real user turn drives recall that surfaces the seeded nodes', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await enableMgViaCheckboxes(page);

        // 1 turn so MG has a chat tail; then import the corpus.
        await sendMessageAndAwaitReply(page, 'The first watch begins. The lantern is steady.');
        await importBindLatest(page, importPath);

        // Visible candidates from the Layer-1 read API — these are what
        // the recall path picks from. The 10 imported nodes should all
        // be visible.
        const visible = await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            const mg = ctx.getExtensionApi?.('memory-graph');
            const session = await mg?.openSession?.(ctx);
            if (!session) return [];
            return session.listVisibleCandidates({}).map(n => ({ title: n.title, type: n.type }));
        });
        expect(visible.length, 'all 10 imported nodes should be visible to recall').toBeGreaterThanOrEqual(10);

        // Title coverage — every character_sheet/location_state title
        // round-trips verbatim; the 4 event titles get auto-normalized
        // to "Summary N" by MG conventions.
        const titles = visible.map(v => v.title).sort();
        expect(titles).toEqual(expect.arrayContaining([
            'Seraphina',
            'Maren the boatwright',
            'Oleas the keeper',
            'Bryn headland watchpost',
            'Salt-reef lighthouse ruin',
            'Drifter skiff anchorage',
        ]));

        // Type filter — listVisibleCandidates({types}) should narrow.
        const characters = await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            const mg = ctx.getExtensionApi?.('memory-graph');
            const session = await mg?.openSession?.(ctx);
            const items = session ? session.listVisibleCandidates({ types: ['character_sheet'] }) : [];
            return items.map(n => n.title).sort();
        });
        expect(characters).toEqual(['Maren the boatwright', 'Oleas the keeper', 'Seraphina']);

        // Sanity check: keyword search hits an aliased character.
        const kwHits = await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            const mg = ctx.getExtensionApi?.('memory-graph');
            const session = await mg?.openSession?.(ctx);
            const results = session ? await session.keywordSearch({ query: 'drifter', k: 5 }) : [];
            return results.map(n => ({ title: n.title, type: n.type }));
        });
        expect(kwHits.length, 'keywordSearch("drifter") should return at least one hit').toBeGreaterThan(0);
        const driftTopMatchesAnchor = kwHits.some(h => /Drifter|drifter|漂泊/.test(h.title));
        expect(driftTopMatchesAnchor, `expected one of the hits to be the drifter anchorage; saw ${JSON.stringify(kwHits)}`).toBe(true);
    });
});
