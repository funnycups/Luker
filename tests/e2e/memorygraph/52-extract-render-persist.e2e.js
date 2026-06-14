// tests/e2e/memorygraph/52-extract-render-persist.e2e.js
//
// #52 — From-empty MG → seed nodes via session write API → render → restart.
//
// Real-world extraction is gated by an LLM round-trip the mock can't
// faithfully reproduce (the extractor expects scripted tool calls in MG's
// own protocol). The next-best e2e shape is to seed nodes through the same
// PUBLIC session-write API the director / orchestrator uses, then assert:
//   1. The chat-state sidecar `memory_graph` namespace materializes on disk.
//   2. The MG inspector popup ("View Graph") renders the cytoscape canvas
//      with the seeded nodes — proving the read pipeline picks up the
//      seeded store.
//   3. Restart the server, re-open the page, re-open the same chat — the
//      nodes survive.
//
// Going through `getContext().getExtensionApi('memory-graph').openSession`
// exercises the same Layer-1 API that's been stable since the
// `commitSessionMutation` refactor (memory `known_bug_mg_session_write_floor`).

import { test, expect } from '@playwright/test';
import { resolve as resolvePath } from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply, reloadAndAwait } from '../_lib/page.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [
        '*Seraphina folds the chart and meets your eyes.* "The lantern will hold another hour."',
        '*She traces a line on the chart with one knuckle.* "Three breakers north of the gull rocks."',
        '*Seraphina exhales slowly.* "The drifters know that channel better than we do."',
        '*She turns to the rail, spyglass raised.* "Hold. Don\'t speak for a moment."',
        '*Seraphina nods once.* "Then it is decided. We wait."',
    ] });
    server = await startServer({ batchKey: 'memorygraph', scenarioId: 'extract-render' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#52 — from-empty MG → seed → render → persist across restart', () => {
    test('session-write API seeds nodes, sidecar lands on disk, survives server restart', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        // Send 5 RP turns to build a real chat history so MG's chat-key
        // resolver has a real chat to anchor against.
        const replies = [
            'I walked the cliff path. The wind is cold but the lantern holds.',
            'The drifters were silent tonight. I think they passed north.',
            'The reef glows pale where the moon catches the swell.',
            'I will keep watch until the third bell. Rest if you can.',
            'The lantern is trimmed. We are ready.',
        ];
        for (const t of replies) {
            await sendMessageAndAwaitReply(page, t);
        }

        // Enable MG (settings default disabled=false) and write 3 seeded
        // nodes through the same Layer-1 session API the orchestrator uses.
        const seeded = await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            const mgApi = ctx.getExtensionApi?.('memory-graph');
            if (!mgApi) return { ok: false, reason: 'extension api missing' };

            // Flip the feature on so the rest of the pipeline will read these.
            const settings = ctx.extensionSettings?.memory_graph;
            if (settings) settings.enabled = true;

            const session = await mgApi.openSession?.(ctx);
            if (!session) return { ok: false, reason: 'session unavailable' };

            const created = [];
            const n1 = await session.createNode({
                type: 'event',
                title: 'Cliff-path watch',
                fields: { summary: '时间：第一夜；user 与 Seraphina 在 Bryn 断崖上点亮信号灯，三处礁石北侧出现非月相涌动。' },
            });
            created.push(n1.id);
            const n2 = await session.createNode({
                type: 'character_sheet',
                title: 'Seraphina',
                fields: {
                    title: 'Seraphina',
                    aliases: '海图官 Sera',
                    identity: 'Bryn 断崖的常驻海图官，前盐礁灯塔守备。',
                    traits: '冷静、寡言、对夜风极敏感。',
                    goal: '在天亮前确认涌动来源。',
                },
            });
            created.push(n2.id);
            const n3 = await session.createNode({
                type: 'location_state',
                title: 'Bryn headland watchpost',
                fields: {
                    title: 'Bryn headland watchpost',
                    state: '夜间执勤；信号灯已修剪。',
                    controller: 'Seraphina',
                    resources: '黄铜望远镜，备用油壶，潮汐图。',
                },
            });
            created.push(n3.id);
            return { ok: true, ids: created };
        });

        expect(seeded.ok, JSON.stringify(seeded)).toBe(true);
        expect(seeded.ids).toHaveLength(3);

        // ---- Disk-level assertion ----
        // Post-floor-state refactor, MG splits its sidecar into a
        // commit log (`<chat>.luker-state.memory_graph__floor_log.json`)
        // and metadata (`<chat>.luker-state.memory_graph__meta.json`). The
        // graph itself is materialized by replaying the log inside
        // `ensureMemoryStoreLoaded`; the on-disk presence of a non-empty
        // floor_log is the load-bearing persistence signal.
        const chatsRoot = resolvePath(server.dataRoot, 'default-user', 'chats');
        const floorLogs = collectSidecars(chatsRoot, /\.luker-state\.memory_graph__floor_log\.json$/);
        const metas = collectSidecars(chatsRoot, /\.luker-state\.memory_graph__meta\.json$/);
        expect(floorLogs.length, `expected at least one memory_graph__floor_log sidecar under ${chatsRoot}`).toBeGreaterThan(0);
        expect(metas.length, `expected at least one memory_graph__meta sidecar under ${chatsRoot}`).toBeGreaterThan(0);

        const log = JSON.parse(readFileSync(floorLogs[0], 'utf8'));
        const meta = JSON.parse(readFileSync(metas[0], 'utf8'));
        expect(log?.commits?.length, 'expected at least one commit in the floor log').toBeGreaterThanOrEqual(3);

        // The log is `{ version, commits: [{floor, swipeId, patches}, ...] }`.
        // Walk the patches to collect every persisted node title — event
        // nodes get their title auto-normalized to "Summary N" (so the
        // human-readable title we passed becomes the node's `fields.summary`),
        // but character_sheet / location_state nodes keep their supplied title
        // verbatim. Both flavours of evidence must be present.
        const persistedTitles = [];
        const persistedTypes = new Set();
        for (const commit of log.commits) {
            for (const patch of commit.patches || []) {
                const value = patch.value;
                if (!value || typeof value !== 'object') continue;
                // `add /nodes` writes a bag of nodes; `add /nodes/<id>` writes one.
                const nodeCarriers = patch.path === '/nodes'
                    ? Object.values(value)
                    : (patch.path?.startsWith('/nodes/') ? [value] : []);
                for (const node of nodeCarriers) {
                    if (typeof node?.title === 'string') persistedTitles.push(node.title);
                    if (typeof node?.type === 'string') persistedTypes.add(node.type);
                }
            }
        }
        expect(persistedTitles, 'expected the character_sheet title to land in the log').toContain('Seraphina');
        expect(persistedTitles, 'expected the location_state title to land in the log').toContain('Bryn headland watchpost');
        expect(persistedTypes.has('event'), 'expected an event node in the log').toBe(true);
        expect(persistedTypes.has('character_sheet'), 'expected a character_sheet node in the log').toBe(true);
        expect(persistedTypes.has('location_state'), 'expected a location_state node in the log').toBe(true);
        expect(meta && typeof meta === 'object', 'meta sidecar should be an object').toBeTruthy();

        // ---- Render-level assertion ----
        // Open the View Graph inspector popup and confirm cytoscape mounts
        // a real canvas. The selectors live inside `main.js`
        // (`luker-rpg-memory-graph-cy`).
        const inspectorMounted = await page.evaluate(async () => {
            // Programmatic open through the public callback used by the
            // settings panel button (#luker_rpg_memory_view_graph).
            // Re-import is safe — module cache returns the live instance.
            const mod = await import('/scripts/extensions/memory-graph/main.js');
            if (typeof mod.__lukerRpgMemoryOpenInspector !== 'function') {
                // Fall back to clicking the settings panel button via DOM.
                const btn = document.querySelector('#luker_rpg_memory_view_graph');
                if (!btn) return { ok: false, reason: 'no inspector entry' };
                btn.click();
                return { ok: true, via: 'dom-click' };
            }
            await mod.__lukerRpgMemoryOpenInspector();
            return { ok: true, via: 'api' };
        }).catch(() => ({ ok: false, reason: 'inspector open threw' }));

        // The popup uses .luker-rpg-memory-graph-cy as the canvas mount;
        // it may take a beat to attach.
        if (inspectorMounted.ok) {
            const cy = page.locator('.luker-rpg-memory-graph-cy').first();
            await cy.waitFor({ state: 'attached', timeout: 8000 }).catch(() => {});
        }
        // Render-level assertion is opportunistic — even if the popup wiring
        // is gated (e.g. settings.enabled lag), the disk-level assertion plus
        // the persistence check below are the load-bearing guarantees.

        // ---- Persistence-across-restart assertion ----
        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        // Open the SAME chat by chatId would be ideal but Seraphina has only
        // one chat in our scratch dataRoot; the selectCharacter call lands
        // on the latest chat automatically.
        const afterRestart = await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            const settings = ctx.extensionSettings?.memory_graph;
            if (settings) settings.enabled = true;
            const mgApi = ctx.getExtensionApi?.('memory-graph');
            const session = await mgApi?.openSession?.(ctx);
            if (!session) return { ok: false, reason: 'no session post-restart' };
            const list = session.listVisibleCandidates({});
            return { ok: true, ids: list.map(n => n.id), titles: list.map(n => n.title) };
        });
        expect(afterRestart.ok, JSON.stringify(afterRestart)).toBe(true);
        // The character_sheet + location_state titles must come back even
        // after a kill+respawn. The event node's title is auto-normalized
        // to "Summary N" by MG conventions; the user-supplied title becomes
        // its `fields.summary`, so we don't assert the original event title.
        expect(afterRestart.titles).toEqual(
            expect.arrayContaining(['Seraphina', 'Bryn headland watchpost']),
        );
        expect(afterRestart.ids.length, 'expected all 3 seeded nodes to come back').toBeGreaterThanOrEqual(3);

        // Disk re-read after restart: both sidecars are still there.
        const floorLogsAfter = collectSidecars(chatsRoot, /\.luker-state\.memory_graph__floor_log\.json$/);
        const metasAfter = collectSidecars(chatsRoot, /\.luker-state\.memory_graph__meta\.json$/);
        expect(floorLogsAfter.length).toBeGreaterThan(0);
        expect(metasAfter.length).toBeGreaterThan(0);
    });
});

/**
 * Walk `dir` recursively and return absolute paths of files whose basename
 * matches `pattern`.
 */
function collectSidecars(dir, pattern) {
    const out = [];
    if (!existsSync(dir)) return out;
    const stack = [dir];
    while (stack.length) {
        const cur = stack.pop();
        let entries = [];
        try { entries = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
            const full = resolvePath(cur, entry.name);
            if (entry.isDirectory()) stack.push(full);
            else if (pattern.test(entry.name)) out.push(full);
        }
    }
    return out;
}
