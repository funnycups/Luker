// #65 — MG extraction payloads must keep OLD floor text even while the
// "Visible Message Window" runtime regex is active.
//
// Regression lock for a real-user bug report: with the WuWa Solaris-3 MVU
// card + a long imported chat, every memory-graph extraction request arrived
// at the LLM with NO actual chat floor text — only prompts/worldbook — so the
// graph wrote nonsense memories. Root cause: memory-graph registers a
// main-generation-only runtime regex (`/[\\s\\S]*/g` → '', minDepth =
// llmVisibleRecentMessages) to hide old raw floors from the MAIN prompt, and
// the shared plugin lane (`cookPluginFloorText`) applied it too. Every
// extracted floor is old by definition → every floor cooked to '' →
// normalizePromptMessages silently dropped them all.
//
// What this test pins (all through real user gestures):
//   1. Enable MG via the real checkboxes; send 8 RP turns via the composer.
//   2. Click the real Fill Graph button (Graph tab of the MG panel).
//   3. The mock LLM must see extraction requests whose assistant messages
//      carry REAL floor text for floors older than the visible window
//      (default llmVisibleRecentMessages = 5), and user text too.
//   4. Before the fix every assistant content was just its `<seq>n</seq>`
//      marker; this test fails if that regresses.

import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { disableTagImportPopup, writeEmbeddedCharacter } from '../character/_helpers.js';
import {
    awaitMainUI,
    selectCharacterByName,
    sendMessageAndAwaitReply,
    openExtensionsDrawer,
    openInlineDrawer,
} from '../_lib/page.js';

const TURNS = [
    'The tide chart shows a false bottom past the third buoy tonight.',
    'I marked the reef line where the drifters cached their lantern oil.',
    'Salt crust is creeping up the hinge of the storage locker again.',
    'A gull dropped a broken compass on the walkway — brass, salt-worn.',
    'The eastern light flickered twice during my watch, then steadied.',
    'I counted seven sails holding position beyond the fog bank.',
    'The spare wick box is water-stained but the coils inside are dry.',
    'Low tide exposed the old mooring rings under the pier at dusk.',
];

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [...TURNS] });
    server = await startServer({ batchKey: 'memorygraph', scenarioId: 'extract-old-floors' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    disableTagImportPopup({ dataRoot: server.dataRoot });
    // Fixture character for the 8-turn RP chat (embedded PNG so the name
    // shows up in the real character list).
    writeEmbeddedCharacter({ dataRoot: server.dataRoot });
    // Start with MG fully OFF so no auto-extraction pass nibbles at the
    // chat while it is still young (shallow depths never trip the visible-
    // window wipe). MG gets enabled through the real UI only after the
    // full-depth chat exists.
    const mgSettingsPath = resolve(server.dataRoot, 'default-user', 'settings.json');
    const mgSettings = JSON.parse(readFileSync(mgSettingsPath, 'utf8'));
    mgSettings.extension_settings = mgSettings.extension_settings || {};
    mgSettings.extension_settings.memory_graph = {
        ...(mgSettings.extension_settings.memory_graph || {}),
        enabled: false,
        auto_extraction_enabled: false,
    };
    writeFileSync(mgSettingsPath, JSON.stringify(mgSettings, null, 4));
    // Extraction requires tool calls (exactly one final `*_done`); without
    // routing, the mock's plain-text fallback would stall every batch.
    mock.scriptCompletion((req) => {
        const names = req.toolNames || [];
        if (names.includes('luker_rpg_extract_event_create')) {
            return {
                toolCalls: [
                    { name: 'luker_rpg_extract_event_create', arguments: { summary: '时间：测试；Mocked extraction event.', links: [], no_link_reason: 'mock' } },
                    { name: 'luker_rpg_extract_done', arguments: {} },
                ],
            };
        }
        return null;
    });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

async function fillGraphViaUi(page) {
    await openExtensionsDrawer(page);
    await openInlineDrawer(page, 'memory_graph_settings');
    // Fill Graph lives in the Graph tab pane of the MG tab strip.
    await page.locator('#luker_rpg_memory_tabs .luker-tabs-tab[data-luker-tab-key="graph"]').click();
    await page.locator('#luker_rpg_memory_fill').click();
}

function collectRoleContents(body, asstContents, userContents) {
    for (const m of body?.messages ?? []) {
        const content = String(m.content ?? '');
        if (m.role === 'assistant') {
            asstContents.push(content);
        } else if (m.role === 'user') {
            userContents.push(content);
        }
    }
}

test.describe('#65 — extraction payload keeps old floors despite visible-window wipe', () => {
    test.setTimeout(240_000);

    test('Fill Graph sends real floor text older than the visible window', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Ash the Cartographer');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, null, { timeout: 30_000 });

        // 8 real RP turns FIRST, while MG is still disabled — this mirrors
        // the reported scenario where a long chat predates memory-graph
        // extraction, so the first extraction pass sees floors whose depth
        // is far beyond the visible window.
        for (const t of TURNS) {
            await sendMessageAndAwaitReply(page, t);
        }

        // Enable MG via the real checkboxes only AFTER the chat exists.
        await openExtensionsDrawer(page);
        await openInlineDrawer(page, 'memory_graph_settings').catch(() => {});
        await page.evaluate(() => {
            for (const id of ['luker_rpg_memory_enabled', 'luker_rpg_memory_auto_extraction_enabled']) {
                const el = document.getElementById(id);
                if (!el) continue;
                if (!el.checked) {
                    el.checked = true;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }
        });

        // Auto-extraction may already cover every floor during the turns;
        // Fill Graph is still driven through the real UI, but the payload
        // assertions accept extraction requests from either path. Wait
        // until the pass reaches the NEWEST floor so late batches aren't
        // missed by the assertions below.
        await fillGraphViaUi(page);
        await expect.poll(() => {
            const bodies = mock.requests
                .map(r => r.body)
                .filter(b => Array.isArray(b?.tools) && b.tools.some(t => t?.function?.name === 'luker_rpg_extract_event_create'));
            return bodies.some(b => JSON.stringify(b.messages).includes(TURNS[7]));
        }, { timeout: 120_000 }).toBe(true);

        const extractionBodies = mock.requests
            .map(r => r.body)
            .filter(b => Array.isArray(b?.tools) && b.tools.some(t => t?.function?.name === 'luker_rpg_extract_event_create'));
        expect(extractionBodies.length, 'Fill Graph must fire at least one extraction request').toBeGreaterThanOrEqual(1);

        const asstContents = [];
        const userContents = [];
        for (const body of extractionBodies) {
            collectRoleContents(body, asstContents, userContents);
        }
        const asstBlob = asstContents.join('\n');
        const userBlob = userContents.join('\n');

        // Old floors (depth > 5) must arrive with REAL text, not bare seq markers.
        expect(asstBlob).toContain(TURNS[1]);   // depth ≈ 13 — was blanked before the fix
        expect(asstBlob).toContain(TURNS[4]);   // around the window edge
        // User text must survive too.
        expect(userBlob).toContain(TURNS[0]);
        expect(userBlob).toContain(TURNS[6]);

        // And the marker-only shape must be gone entirely: no assistant
        // extraction message may consist solely of its <seq> wrapper.
        const markerOnly = asstContents.filter(c => /^<seq>\d+<\/seq>$/.test(c.trim()));
        expect(markerOnly, 'assistant floors must not collapse to bare <seq> markers').toHaveLength(0);
    });
});
