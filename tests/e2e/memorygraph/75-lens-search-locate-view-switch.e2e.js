// tests/e2e/memorygraph/75-lens-search-locate-view-switch.e2e.js
//
// Real-browser verification for Workbench Memory Lens search & locate view
// switching:
//   1. On the Timeline tab, searching and clicking a character node switches
//      to the Graph tab, renders the Cytoscape canvas, and opens its inspector.
//   2. On the Timeline tab, clicking an event card and then clicking the
//      inspector's "Locate in graph" button switches to the Graph tab.
//   3. On the Settings full-view tab, searching and clicking a location node
//      exits full-view mode, switches to the Graph tab, and displays details.

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
} from '../_lib/page.js';
import { workbenchWindow } from '../_lib/ui-workbench.js';
import { importMgGraph, openMgGraphView, setMgSettings } from '../_lib/ui-mg-varops.js';

let server, mock, importPath;

test.beforeAll(async () => {
    mock = await startMockLLM({
        scriptedReplies: ['*Seraphina folds the chart and meets your eyes.* "The lantern will hold."'],
    });
    server = await startServer({ batchKey: 'memorygraph', scenarioId: 'lens-search-locate-switch' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

    const tmpDir = mkdtempSync(resolve(tmpdir(), 'mg-lens-locate-'));
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
                title: 'First lantern watch', parentId: '', childrenIds: [],
                fields: { summary: 'Time: First night\nPlace: Bryn watchpost\n\nSeraphina trimmed the signal lantern above the cliff.' },
                seqTo: 1,
            },
            n_2: {
                id: 'n_2', type: 'character_sheet', level: 'semantic',
                title: 'Seraphina', parentId: '', childrenIds: [],
                fields: {
                    title: 'Seraphina',
                    aliases: 'Sera',
                    identity: 'Headland chart keeper at Bryn watchpost.',
                    traits: 'Calm and observant.',
                },
                seqTo: 2,
            },
            n_3: {
                id: 'n_3', type: 'location_state', level: 'semantic',
                title: 'Bryn watchpost', parentId: '', childrenIds: [],
                fields: {
                    title: 'Bryn watchpost',
                    controller: 'Seraphina',
                    state: 'Lantern lit and steady.',
                },
                seqTo: 3,
            },
        },
        edges: [
            { from: 'n_1', to: 'n_2', type: 'involved_in' },
            { from: 'n_1', to: 'n_3', type: 'occurred_at' },
        ],
    }, null, 2));
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#75 — Memory Lens search and locate switches to Graph tab when needed', () => {
    test.setTimeout(120_000);

    test('timeline character search, inspector locate-in-graph, and settings search all switch to Graph tab', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await setMgSettings(page, { enabled: true, autoExtractionEnabled: false }, { closeAfter: true });
        await sendMessageAndAwaitReply(page, 'I reached the headland watchpost before dusk.');
        await importMgGraph(page, importPath, { mode: 'bind-latest', closeAfter: true });

        await openMgGraphView(page);
        const win = workbenchWindow(page);
        const lens = win.locator('.mlens');
        await expect(lens).toBeVisible();

        const graphView = lens.locator('.ml-view[data-view="graph"]');
        const timelineView = lens.locator('.ml-view[data-view="timeline"]');
        const settingsView = lens.locator('.ml-view[data-view="settings"]');

        const graphTab = lens.locator('.ml-viewswitch .lw-seg-btn').nth(0);
        const timelineTab = lens.locator('.ml-viewswitch .lw-seg-btn').nth(1);
        const settingsTab = lens.locator('.ml-viewswitch .lw-seg-btn').nth(4);
        const bottomSearchBtn = lens.locator('.ml-bottomnav .ml-bn-btn').nth(1);
        const bottomDetailsBtn = lens.locator('.ml-bottomnav .ml-bn-btn').nth(2);
        const paletteInput = lens.locator('.ml-palette-input');
        const locateInGraphBtn = lens.locator('.ml-inspector button[aria-label="Locate in graph"], .ml-inspector button[aria-label="在图谱中定位"], .ml-inspector button[aria-label="在圖譜中定位"]');

        // 1. Default Workbench window (compact Memory Lens): switch to Timeline tab,
        //    search for character Seraphina via bottom-nav Search, and click result.
        await timelineTab.click();
        await expect(timelineView).toBeVisible();
        await expect(graphView).toBeHidden();
        await expect(timelineView.locator('.ml-tl-card[data-id="n_1"]')).toBeVisible();

        await bottomSearchBtn.click();
        await expect(paletteInput).toBeVisible();
        await paletteInput.fill('Seraphina');
        await lens.locator('.ml-palette-item[role="option"]').filter({ hasText: 'Seraphina' }).first().click();

        await expect(graphView).toBeVisible();
        await expect(timelineView).toBeHidden();
        await expect(graphTab).toHaveAttribute('aria-pressed', 'true');
        await expect(lens.locator('.ml-graph-canvas canvas').first()).toBeVisible();
        await bottomDetailsBtn.click();
        await expect(lens.locator('.ml-inspector .ml-insp-title')).toHaveText('Seraphina');

        // 2. Still in default Workbench window: switch to Settings full-view tab,
        //    search for location Bryn watchpost, and click result -> switches to Graph.
        await settingsTab.click();
        await expect(settingsView).toBeVisible();
        await expect(lens).toHaveClass(/\bis-full-view\b/);

        await bottomSearchBtn.click();
        await expect(paletteInput).toBeVisible();
        await paletteInput.fill('Bryn watchpost');
        await lens.locator('.ml-palette-item[role="option"]').filter({ hasText: 'Bryn watchpost' }).first().click();

        await expect(graphView).toBeVisible();
        await expect(settingsView).toBeHidden();
        await expect(lens).not.toHaveClass(/\bis-full-view\b/);
        await bottomDetailsBtn.click();
        await expect(lens.locator('.ml-inspector .ml-insp-title')).toHaveText('Bryn watchpost');

        // 3. Maximize Workbench to desktop wide layout, switch to Timeline,
        //    click event card, then click "Locate in graph" in inspector -> switches to Graph.
        const maxBtn = win.locator('button[aria-label="Maximize"], button[aria-label="最大化"]').first();
        await maxBtn.click();
        await expect(lens.locator('.ml-searchbtn')).toBeVisible();

        await timelineTab.click();
        await expect(timelineView).toBeVisible();
        await timelineView.locator('.ml-tl-card[data-id="n_1"]').click();
        await expect(lens.locator('.ml-inspector .ml-insp-title')).toHaveText('First lantern watch');

        await locateInGraphBtn.click();

        await expect(graphView).toBeVisible();
        await expect(timelineView).toBeHidden();
        await expect(graphTab).toHaveAttribute('aria-pressed', 'true');

        // 4. Wide desktop layout (1280px maximized -> mid width tier): verify topbar sections
        //    do not overlap, Settings tab is unobstructed, and topbar Search from Settings &
        //    Timeline switches cleanly to Graph.
        const topbarGeom1280 = await lens.evaluate((el) => {
            const bar = el.querySelector('.ml-topbar').getBoundingClientRect();
            const left = el.querySelector('.ml-topbar-left').getBoundingClientRect();
            const mid = el.querySelector('.ml-viewswitch').getBoundingClientRect();
            const right = el.querySelector('.ml-topbar-right').getBoundingClientRect();
            const tabs = [...el.querySelectorAll('.ml-viewswitch .lw-seg-btn')].map(b => b.getBoundingClientRect());
            return {
                tier: el.dataset.widthTier,
                leftClear: left.right <= mid.left + 1,
                rightClear: mid.right <= right.left + 1,
                tabsInsideBar: tabs.every(t => t.left >= bar.left - 1 && t.right <= right.left + 1),
            };
        });
        expect(topbarGeom1280.leftClear).toBe(true);
        expect(topbarGeom1280.rightClear).toBe(true);
        expect(topbarGeom1280.tabsInsideBar).toBe(true);

        await settingsTab.click();
        await expect(settingsView).toBeVisible();
        await lens.locator('.ml-searchbtn').click();
        await expect(paletteInput).toBeVisible();
        await paletteInput.fill('Bryn watchpost');
        await lens.locator('.ml-palette-item[role="option"]').filter({ hasText: 'Bryn watchpost' }).first().click();
        await expect(graphView).toBeVisible();
        await expect(lens.locator('.ml-inspector .ml-insp-title')).toHaveText('Bryn watchpost');

        await timelineTab.click();
        await expect(timelineView).toBeVisible();
        await lens.locator('.ml-searchbtn').click();
        await expect(paletteInput).toBeVisible();
        await paletteInput.fill('Seraphina');
        await lens.locator('.ml-palette-item[role="option"]').filter({ hasText: 'Seraphina' }).first().click();

        await expect(graphView).toBeVisible();
        await expect(timelineView).toBeHidden();
        await expect(graphTab).toHaveAttribute('aria-pressed', 'true');
        await expect(lens.locator('.ml-inspector .ml-insp-title')).toHaveText('Seraphina');

        // 5. Narrow desktop layout (1120px maximized -> .mlens ~940px narrow tier): topbar
        //    still stays non-overlapping and Settings + icon-only Search remain clickable.
        await page.setViewportSize({ width: 1120, height: 720 });
        await expect(lens).toHaveAttribute('data-width-tier', 'narrow');
        const topbarGeomNarrow = await lens.evaluate((el) => {
            const left = el.querySelector('.ml-topbar-left').getBoundingClientRect();
            const mid = el.querySelector('.ml-viewswitch').getBoundingClientRect();
            const right = el.querySelector('.ml-topbar-right').getBoundingClientRect();
            return {
                leftClear: left.right <= mid.left + 1,
                rightClear: mid.right <= right.left + 1,
            };
        });
        expect(topbarGeomNarrow).toEqual({ leftClear: true, rightClear: true });
        await settingsTab.click();
        await expect(settingsView).toBeVisible();
    });
});
