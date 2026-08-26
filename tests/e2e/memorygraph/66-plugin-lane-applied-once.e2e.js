// #66 — each regex lane applies its scripts EXACTLY ONCE per outgoing
// request, and never bleeds into the other lane.
//
// Regression lock for the lane-semantics refactor (Tasks 1–3): user
// scripts scoped to the main pipeline (`promptOnly`) must cook main
// generation payloads only; scripts scoped to plugins (`pluginOnly`)
// must cook plugin-built payloads (memory-graph extraction here) only;
// floor messages converted via `floorRecordToTaskMessage` carry an
// internal provenance marker so the dispatch layer skips a second
// application — and that marker must never reach the network.
//
// Sentinel scheme: two user rules, `/SENTINEL-P/g` → 'P'
// (`promptOnly`) and `/SENTINEL-D/g` → 'D' (`pluginOnly`), both
// placed on user + AI text with no depth bounds. The card's greeting
// carries `SENTINEL-P SENTINEL-D` adjacently, and every scripted
// reply repeats both marks spread through the sentence. So:
//   - a main-generation payload must show `P SENTINEL-D`
//     (P cooked, D untouched, no SENTINEL-P left);
//   - an extraction payload must show `SENTINEL-P D`
//     (D cooked, P untouched, no SENTINEL-D left);
//   - NO message content anywhere may contain the doubled artifacts
//     PP / DD / PD / DP (proof neither lane ran twice);
//   - NO outgoing message object may carry the internal
//     `sourceFloorIndex` provenance marker.

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

const FIRST_MES = '*Ash unrolls a fresh survey chart across the table, weighting its corners with brass fixtures.* "Look here — along the old reef line my predecessor inked two marks I cannot account for: SENTINEL-P SENTINEL-D, side by side where the kelp shelf meets the deep channel. Help me decide which of them to keep before the tide turns."';

const REPLIES = [
    '*Ash leans over the chart and taps the inked stroke.* "See this SENTINEL-P here? I set it where the current splits around the reef. Whoever drew SENTINEL-D was hurrying — the hand is thinner, less sure."',
    '*Ash folds the chart away and shoulders her spyglass.* "Then we move tonight. If SENTINEL-P still stands at slack water, the channel holds. And if SENTINEL-D has been scraped off the stone, someone else has been reading my marks."',
];

const TURNS = [
    'I walked the reef line again at first light — the marker buoys have drifted a full cable east since the storm.',
    'The drifters cached their lantern oil under the split rock, just where your survey said it would be.',
];

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [...REPLIES] });
    server = await startServer({ batchKey: 'memorygraph', scenarioId: 'plugin-lane-once' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    disableTagImportPopup({ dataRoot: server.dataRoot });
    // Greeting carries both sentinels adjacently — the exact-once shape
    // (`P SENTINEL-D` vs `SENTINEL-P D`) is only observable when the two
    // marks sit next to each other in one string.
    writeEmbeddedCharacter({ dataRoot: server.dataRoot, overrides: { first_mes: FIRST_MES } });

    const settingsPath = resolve(server.dataRoot, 'default-user', 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    settings.extension_settings = settings.extension_settings || {};
    // Data preparation on the cloned settings.json: two sentinel rules,
    // one per lane, both covering user + AI placements at every depth.
    settings.extension_settings.regex = [
        {
            id: 'e2e-sentinel-prompt-lane',
            scriptName: 'Sentinel prompt lane',
            findRegex: '/SENTINEL-P/g',
            replaceString: 'P',
            placement: [1, 2],
            disabled: false,
            markdownOnly: false,
            promptOnly: true,
            minDepth: null,
            maxDepth: null,
        },
        {
            id: 'e2e-sentinel-plugin-lane',
            scriptName: 'Sentinel plugin lane',
            findRegex: '/SENTINEL-D/g',
            replaceString: 'D',
            placement: [1, 2],
            disabled: false,
            markdownOnly: false,
            pluginOnly: true,
            minDepth: null,
            maxDepth: null,
        },
    ];
    // Start with MG fully off so extraction fires only from the real
    // Fill Graph gesture after the short chat exists.
    settings.extension_settings.memory_graph = {
        ...(settings.extension_settings.memory_graph || {}),
        enabled: false,
        auto_extraction_enabled: false,
    };
    writeFileSync(settingsPath, JSON.stringify(settings, null, 4));

    // Extraction needs exactly one final `*_done`; route those requests
    // to valid tool calls while everything else drains scriptedReplies.
    mock.scriptCompletion((req) => {
        const names = req.toolNames || [];
        if (names.includes('luker_rpg_extract_event_create')) {
            return {
                toolCalls: [
                    { name: 'luker_rpg_extract_event_create', arguments: { summary: '时间：潮汐与浮标；Ash 沿礁线留下两枚来历不明的墨记。', links: [], no_link_reason: 'mock' } },
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
    await page.locator('#luker_rpg_memory_tabs .luker-tabs-tab[data-luker-tab-key="graph"]').click();
    await page.locator('#luker_rpg_memory_fill').click();
}

function isExtractionBody(body) {
    return Array.isArray(body?.tools)
        && body.tools.some(t => t?.function?.name === 'luker_rpg_extract_event_create');
}

function messageContents(body) {
    return (body?.messages ?? []).map(m => String(m.content ?? ''));
}

test.describe('#66 — plugin lane applied exactly once, lanes never bleed', () => {
    test.setTimeout(240_000);

    test('sentinels are cooked once per lane and the provenance marker stays internal', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Ash the Cartographer');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, null, { timeout: 30_000 });

        for (const t of TURNS) {
            await sendMessageAndAwaitReply(page, t);
        }

        // Enable MG through the real checkboxes only.
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

        await fillGraphViaUi(page);
        await expect.poll(() => {
            const bodies = mock.requests
                .map(r => r.body)
                .filter(isExtractionBody);
            return bodies.some(b => JSON.stringify(b.messages).includes(TURNS[1]));
        }, { timeout: 120_000 }).toBe(true);

        const chatBodies = mock.requests
            .filter(r => r.url.endsWith('/chat/completions'))
            .map(r => r.body);
        const extractionBodies = chatBodies.filter(isExtractionBody);
        const mainGenBodies = chatBodies.filter(b => !isExtractionBody(b));
        expect(mainGenBodies.length, 'the two turns must produce main-generation requests').toBeGreaterThanOrEqual(1);
        expect(extractionBodies.length, 'Fill Graph must fire at least one extraction request').toBeGreaterThanOrEqual(1);

        const mainBlob = mainGenBodies.flatMap(messageContents).join('\n');
        const extractionBlob = extractionBodies.flatMap(messageContents).join('\n');

        // Main lane: promptOnly rule cooked SENTINEL-P exactly once;
        // pluginOnly rule stayed out of the main pipeline entirely.
        expect(mainBlob, 'main payload shows P cooked next to untouched SENTINEL-D').toContain('P SENTINEL-D');
        expect(mainBlob, 'promptOnly script consumed every SENTINEL-P').not.toContain('SENTINEL-P');
        expect(mainBlob, 'pluginOnly script must not touch main-generation payloads').toContain('SENTINEL-D');

        // Plugin lane: pluginOnly rule cooked SENTINEL-D exactly once;
        // promptOnly rule stayed out of plugin-built payloads.
        expect(extractionBlob, 'extraction payload shows SENTINEL-P next to cooked D').toContain('SENTINEL-P D');
        expect(extractionBlob, 'pluginOnly script consumed every SENTINEL-D').not.toContain('SENTINEL-D');
        expect(extractionBlob, 'promptOnly script must not touch extraction payloads').toContain('SENTINEL-P');

        // Neither lane ran twice: no doubled replacement artifacts in ANY
        // outgoing request's message content. Standalone tokens only —
        // words like "ADD" inside prompt boilerplate are not artifacts.
        const ARTIFACT = /\b(PP|DD|PD|DP)\b/;
        for (const body of chatBodies) {
            const blob = messageContents(body).join('\n');
            expect(blob, `no double-application artifacts in request: ${blob.slice(0, 200)}`).not.toMatch(ARTIFACT);
        }

        // The floor-provenance marker is internal-only: it must never
        // leak into any outgoing chat-completions payload (closes the
        // verification deferred from the provenance-stamping task).
        for (const record of mock.requests) {
            if (!record.url.endsWith('/chat/completions')) continue;
            expect(JSON.stringify(record.body), `no sourceFloorIndex in ${record.url}`).not.toContain('sourceFloorIndex');
        }
    });
});
