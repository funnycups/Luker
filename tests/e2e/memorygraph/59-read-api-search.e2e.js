// tests/e2e/memorygraph/59-read-api-search.e2e.js
//
// #59 — MG read-api: orchestrator-style search across keywordSearch +
// findByName + listVisibleCandidates locks the contract orchestrator
// tools depend on.
//
// The orchestrator's memory tools (read-only side: memory_search,
// memory_find, memory_list_recent) all proxy to the Layer-1 session
// surface in `api.js`:
//   - `session.keywordSearch({ query, types, k })`  — fuzzy token-overlap
//     ranking over corpus = title + projection columns + spec keywords.
//   - `session.findByName({ query, types })`        — substring match
//     against title + primaryKeyColumns (typically aliases).
//   - `session.listVisibleCandidates({ types, seqWindow })`
//                                                    — the canonical recall
//     pool, used by the orchestrator to enumerate "what's currently in
//     play".
//
// What this case pins:
//   * 10 records seeded across 3 node types so each search has both
//     positive matches AND non-matches to discriminate.
//   * keywordSearch hits the right nodes, types filter is honoured.
//   * findByName substring works for both `title` and a
//     primaryKeyColumns field (aliases).
//   * listVisibleCandidates with a types filter returns only the
//     requested types.
//
// This is a contract test for the orchestrator's read-side tools — if
// any of these queries silently drop matches or return wrong types,
// orchestrator tool dispatch is silently broken.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';

let server, mock;

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
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#59 — MG read-api search surface: orchestrator can grep + find + list', () => {
    test('keywordSearch ranks by token overlap; findByName substring-matches title + aliases; types filter is honoured', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        // Three RP turns so MG has a real chat anchor to bind against.
        for (const t of [
            'The first watch begins. The lantern is steady.',
            'A skiff drifted south of the gull rocks an hour ago.',
            'Hold the watch. I will fetch the chart.',
        ]) {
            await sendMessageAndAwaitReply(page, t);
        }

        const seeded = await page.evaluate(async () => {
            const ctx = window.SillyTavern.getContext();
            const settings = ctx.extensionSettings?.memory_graph;
            if (settings) settings.enabled = true;
            const mg = ctx.getExtensionApi?.('memory-graph');
            const session = await mg?.openSession?.(ctx);
            if (!session) return { error: 'no session' };

            // 10 records: 4 events, 3 character_sheets, 3 location_states.
            // Distinguishable, RP-immersive content so token overlap is
            // semantic (not "say hi" placeholder noise).
            const created = [];

            // EVENTS — token overlap will be assertable
            created.push(await session.createNode({
                type: 'event',
                title: 'Cliff lantern lit',
                fields: { summary: '时间：黄昏；user 与 Seraphina 在 Bryn 断崖点亮信号灯；夜风偏南。' },
            }));
            created.push(await session.createNode({
                type: 'event',
                title: 'Reef shudder noted',
                fields: { summary: '时间：第一夜中段；礁石回响变得迟缓；标记可能的涌动征兆。' },
            }));
            created.push(await session.createNode({
                type: 'event',
                title: 'Drifters spotted south',
                fields: { summary: '时间：第二夜；user 在海图官小屋外看到三艘盐礁漂泊者的轻舟。' },
            }));
            created.push(await session.createNode({
                type: 'event',
                title: 'Watch change deferred',
                fields: { summary: '时间：第三幕；user 决定推迟换岗；保留断崖夜哨直至天明。' },
            }));

            // CHARACTER_SHEETS — findByName should hit on title + aliases
            created.push(await session.createNode({
                type: 'character_sheet',
                title: 'Seraphina',
                fields: {
                    title: 'Seraphina',
                    aliases: '海图官 Sera; 灯塔守备',
                    identity: 'Bryn 断崖的常驻海图官；前盐礁灯塔守备。',
                    traits: '冷静、寡言、对夜风极敏感。',
                },
            }));
            created.push(await session.createNode({
                type: 'character_sheet',
                title: 'Maren the boatwright',
                fields: {
                    title: 'Maren the boatwright',
                    aliases: '"老枫" Maren',
                    identity: 'Bryn 港的轻舟修造匠；负责盐礁漂泊者的船骨维护。',
                    traits: '务实、爱讲冷笑话。',
                },
            }));
            created.push(await session.createNode({
                type: 'character_sheet',
                title: 'Oleas the keeper',
                fields: {
                    title: 'Oleas the keeper',
                    aliases: '守灯人 Oleas; 老守',
                    identity: '盐礁灯塔的退役守备；如今住在断崖南侧的木屋。',
                    traits: '沉默、记忆力极佳。',
                },
            }));

            // LOCATION_STATES
            created.push(await session.createNode({
                type: 'location_state',
                title: 'Bryn headland watchpost',
                fields: {
                    title: 'Bryn headland watchpost',
                    aliases: '断崖夜哨点',
                    controller: 'Seraphina',
                    state: '夜间执勤；信号灯刚修剪过；备用油壶在手边。',
                    resources: '黄铜望远镜、备用油壶、潮汐图。',
                },
            }));
            created.push(await session.createNode({
                type: 'location_state',
                title: 'Salt-reef lighthouse ruin',
                fields: {
                    title: 'Salt-reef lighthouse ruin',
                    aliases: '盐礁灯塔遗迹',
                    controller: '',
                    state: '部分塌陷；高潮时通道被海水切断。',
                    resources: '一架尚能转动的旧灯具机芯。',
                },
            }));
            created.push(await session.createNode({
                type: 'location_state',
                title: 'Drifter skiff anchorage',
                fields: {
                    title: 'Drifter skiff anchorage',
                    aliases: '漂泊者锚泊',
                    controller: '',
                    state: '隐蔽小湾；只在落潮时可见。',
                    resources: '三处隐蔽缆桩。',
                },
            }));

            // ─── Search 1: keywordSearch (grep) on a distinctive token ───
            // "drifter" (singular — the tokenizer is exact-match, no stemming)
            // should hit the "Drifter skiff anchorage" location_state. The
            // event "Drifters spotted south" has its title auto-normalized
            // to "Summary N" by MG (the user-supplied event title doesn't
            // round-trip), so only the location's title is in the corpus
            // for english tokens.
            const kwHitsDrifter = await session.keywordSearch({ query: 'drifter', k: 5 });

            // ─── Search 2: keywordSearch with types filter ───
            // Constrain to character_sheet only — should NOT include the
            // event or the location_state even if they share tokens.
            const kwHitsCharOnly = await session.keywordSearch({ query: 'Bryn', types: ['character_sheet'], k: 5 });

            // ─── Search 3: findByName (substring) on a title fragment ───
            const fnHitsByTitle = await session.findByName({ query: 'Seraphina' });

            // ─── Search 4: findByName on an alias fragment ───
            // `Maren` characters' aliases include '"老枫" Maren'; substring
            // search for the alias-only chunk "老枫" should hit Maren by alias.
            const fnHitsByAlias = await session.findByName({ query: '老枫' });

            // ─── Search 5: listVisibleCandidates types filter ───
            // Asking for `location_state` only should return exactly our 3
            // location nodes (or a subset thereof — recall can dedupe;
            // the assertion below allows the type filter to be the gate).
            const visibleLocations = await session.listVisibleCandidates({ types: ['location_state'] });

            return {
                ok: true,
                createdCount: created.length,
                kwHitsDrifterTopTitle: kwHitsDrifter?.[0]?.title || '',
                kwHitsDrifterTopType: kwHitsDrifter?.[0]?.type || '',
                kwHitsDrifterCount: kwHitsDrifter?.length || 0,
                kwHitsCharOnlyTypes: (kwHitsCharOnly || []).map(n => n.type),
                kwHitsCharOnlyTitles: (kwHitsCharOnly || []).map(n => n.title),
                fnHitsByTitleTitles: (fnHitsByTitle?.matches || []).map(n => n.title),
                fnHitsByAliasTitles: (fnHitsByAlias?.matches || []).map(n => n.title),
                visibleLocationTypes: (visibleLocations || []).map(n => n.type),
                visibleLocationTitles: (visibleLocations || []).map(n => n.title).sort(),
            };
        });

        expect(seeded.error, `setup error: ${seeded.error}`).toBeUndefined();
        expect(seeded.createdCount, 'expected 10 seeded nodes').toBe(10);

        // ── Search 1: keywordSearch general grep ──
        expect(
            seeded.kwHitsDrifterCount,
            'keywordSearch for "drifter" should return at least one hit (the Drifter skiff anchorage location)',
        ).toBeGreaterThanOrEqual(1);
        expect(
            seeded.kwHitsDrifterTopType,
            `keywordSearch for "drifter" top hit should be the location_state; got type "${seeded.kwHitsDrifterTopType}" title "${seeded.kwHitsDrifterTopTitle}"`,
        ).toBe('location_state');
        expect(
            seeded.kwHitsDrifterTopTitle,
            `keywordSearch for "drifter" top hit should be the Drifter skiff anchorage; got "${seeded.kwHitsDrifterTopTitle}"`,
        ).toMatch(/Drifter skiff anchorage/);

        // ── Search 2: keywordSearch types filter ──
        for (const t of seeded.kwHitsCharOnlyTypes) {
            expect(t, `every hit of keywordSearch(types:['character_sheet']) must be character_sheet; got ${seeded.kwHitsCharOnlyTypes.join(', ')}`).toBe('character_sheet');
        }
        // The character_sheets all mention "Bryn" in identity/aliases —
        // expect at least one hit (Seraphina identity "Bryn 断崖的常驻海图官").
        expect(
            seeded.kwHitsCharOnlyTitles.length,
            `keywordSearch("Bryn", types=character_sheet) should hit at least one of Seraphina/Maren/Oleas; got titles=${JSON.stringify(seeded.kwHitsCharOnlyTitles)}`,
        ).toBeGreaterThanOrEqual(1);

        // ── Search 3: findByName by title ──
        expect(
            seeded.fnHitsByTitleTitles,
            'findByName("Seraphina") should return the character_sheet titled Seraphina',
        ).toContain('Seraphina');

        // ── Search 4: findByName by alias ──
        expect(
            seeded.fnHitsByAliasTitles,
            'findByName("老枫") should match Maren via her aliases primary-key column',
        ).toContain('Maren the boatwright');

        // ── Search 5: listVisibleCandidates types filter ──
        // Every returned candidate must be a location_state.
        for (const t of seeded.visibleLocationTypes) {
            expect(t, `every candidate from listVisibleCandidates(types=['location_state']) must be location_state; got ${seeded.visibleLocationTypes.join(', ')}`).toBe('location_state');
        }
        // The 3 location titles should all be present.
        expect(seeded.visibleLocationTitles).toEqual(expect.arrayContaining([
            'Bryn headland watchpost',
            'Drifter skiff anchorage',
            'Salt-reef lighthouse ruin',
        ]));
    });
});
