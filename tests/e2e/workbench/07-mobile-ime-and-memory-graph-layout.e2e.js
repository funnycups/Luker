// tests/e2e/workbench/07-mobile-ime-and-memory-graph-layout.e2e.js
//
// Real-browser regression coverage for:
//   1. Mobile Memory Graph full-height flex layout (Timeline, Search -> Details
//      inspector, Create modal containment, and Settings Enabled switch visible
//      and interactive without sticky-bar occlusion).
//   2. Mobile AI Iteration under IME viewport shrinkage (412x915 -> 412x360 -> 412x915)
//      and mid-width split window (680x380): zero pane/text overlap, composer
//      input + send stay visible and usable, and preferred mobile window height
//      restores when the keyboard closes.

import { test, expect } from '../../harness/playwright.js';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';
import { writeEmbeddedCharacter, disableTagImportPopup } from '../character/_helpers.js';
import { openWorkbench, switchWorkbenchTab } from '../_lib/ui-workbench.js';
import { importMgGraph, setMgSettings } from '../_lib/ui-mg-varops.js';

let server, mock, importPath;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({
        scriptedReplies: ['*Ash sketches the lighthouse bearing onto the vellum.* "Safe harbor lies north."'],
    });
    server = await startServer({
        scope,
        batchKey: 'workbench',
        scenarioId: '07-mobile-ime-mg-layout',
        extraConfig: { storage: { mode: 'fs' } },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    disableTagImportPopup({ dataRoot: server.dataRoot });
    writeEmbeddedCharacter({
        dataRoot: server.dataRoot,
        avatarFile: 'ash-mobile-layout.png',
    });

    const tmpDir = (await scope.directory('wb-mobile-mg')).path;
    importPath = resolve(tmpDir, 'seed-graph.json');
    writeFileSync(importPath, JSON.stringify({
        version: 2,
        nodeSeq: 3,
        seqCounter: 3,
        appliedSeqTo: 3,
        loggedSeqTo: 3,
        nodes: {
            n_1: {
                id: 'n_1', type: 'event', level: 'semantic',
                title: 'Harbor lantern signal spotted', parentId: '', childrenIds: [],
                fields: { summary: 'Time: Dusk\nPlace: North Pier\n\nAsh recorded the harbor beacon bearing.' },
                seqTo: 1,
            },
            n_2: {
                id: 'n_2', type: 'character_sheet', level: 'semantic',
                title: 'Ash the Cartographer', parentId: '', childrenIds: [],
                fields: { title: 'Ash the Cartographer', identity: 'Surveyor of northern coastal routes.' },
                seqTo: 2,
            },
            n_3: {
                id: 'n_3', type: 'location_state', level: 'semantic',
                title: 'North Pier', parentId: '', childrenIds: [],
                fields: { title: 'North Pier', state: 'Beacon lit and fog clearing.' },
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
    await mock?.stop();
});

test.describe('Mobile Workbench IME & Memory Graph layout', () => {
    test.setTimeout(180_000);

    test('Memory Graph maintains full flex height on mobile across Timeline, Search/Details, Create modal, and Settings', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Ash the Cartographer');
        await setMgSettings(page, { enabled: true, autoExtractionEnabled: false }, { closeAfter: true });
        await sendMessageAndAwaitReply(page, 'Mark the northern harbor light on the chart.');
        await importMgGraph(page, importPath, { mode: 'bind-latest', closeAfter: true });

        await page.setViewportSize({ width: 412, height: 915 });
        const win = await openWorkbench(page, { via: 'wand' });
        await switchWorkbenchTab(page, 'ws:memory');

        const lens = win.locator('.mlens');
        await expect(lens).toBeVisible();
        await expect(lens).toHaveClass(/\bis-compact\b/);

        // Switch to Timeline tab and verify the flex height chain is definite without relying on display:block height:100%
        const timelineTab = lens.locator('.ml-viewswitch .lw-seg-btn').nth(1);
        await timelineTab.click();
        await expect(lens.locator('.ml-tl-card[data-id="n_1"]')).toBeVisible();

        const heightChain = await page.evaluate(() => {
            const main = document.querySelector('.wbench .wb-main.is-flush');
            const host = document.querySelector('.wbench .wb-ws-host');
            const mlens = document.querySelector('.wbench .mlens');
            const body = document.querySelector('.wbench .ml-body');
            const stage = document.querySelector('.wbench .ml-stage');
            const view = document.querySelector('.wbench .ml-view[data-view="timeline"]');
            // Verify flex fills even if percentage height on host/mlens were ignored (older WebView behavior)
            const prevHostH = host.style.height;
            const prevMlensH = mlens.style.height;
            host.style.height = 'auto';
            mlens.style.height = 'auto';
            const withoutPct = {
                hostH: Math.round(host.getBoundingClientRect().height),
                mlensH: Math.round(mlens.getBoundingClientRect().height),
                bodyH: Math.round(body.getBoundingClientRect().height),
                viewH: Math.round(view.getBoundingClientRect().height),
            };
            host.style.height = prevHostH;
            mlens.style.height = prevMlensH;
            return {
                mainDisplay: getComputedStyle(main).display,
                stageDisplay: getComputedStyle(stage).display,
                viewPosition: getComputedStyle(view).position,
                bodyH: Math.round(body.getBoundingClientRect().height),
                viewH: Math.round(view.getBoundingClientRect().height),
                withoutPct,
            };
        });
        expect(heightChain.mainDisplay).toBe('flex');
        expect(heightChain.stageDisplay).toBe('flex');
        expect(heightChain.viewPosition).toBe('static');
        expect(heightChain.bodyH).toBeGreaterThan(220);
        expect(heightChain.viewH).toBeGreaterThan(220);
        expect(heightChain.withoutPct.bodyH).toBeGreaterThan(220);
        expect(heightChain.withoutPct.viewH).toBeGreaterThan(220);

        // Search -> pick node -> open Details inspector: must render with real height, not blank
        await lens.locator('.ml-bottomnav .ml-bn-btn').nth(1).click();
        const paletteInput = lens.locator('.ml-palette-input');
        await expect(paletteInput).toBeVisible();
        await paletteInput.fill('Harbor');
        await lens.locator('.ml-palette-item[role="option"]').filter({ hasText: 'Harbor lantern signal spotted' }).first().click();

        await lens.locator('.ml-bottomnav .ml-bn-btn').nth(2).click();
        const inspector = lens.locator('.ml-inspector');
        await expect(inspector).toBeVisible();
        await expect(inspector.locator('.ml-insp-title')).toHaveText('Harbor lantern signal spotted');
        const inspH = await inspector.evaluate(el => Math.round(el.getBoundingClientRect().height));
        expect(inspH).toBeGreaterThan(150);
        // Close inspector drawer via scrim
        await lens.locator('.ml-scrim').click({ position: { x: 10, y: 10 } });
        await expect(inspector).toBeHidden();

        // Tap "+" (New memory): modal must stay fully inside .mlens (not clipped at the top)
        await lens.locator('.ml-topbar-right button[aria-label="New memory"], .ml-topbar-right button[aria-label="新建记忆"], .ml-topbar-right button[aria-label="新增記憶"]').click();
        const modal = lens.locator('.ml-schema-modal');
        await expect(modal).toBeVisible();
        const modalBounds = await lens.evaluate((el) => {
            const lr = el.getBoundingClientRect();
            const dialog = el.querySelector('.ml-schema-modal');
            const dr = dialog.getBoundingClientRect();
            const head = dialog.querySelector('.ml-dialog-head').getBoundingClientRect();
            return {
                topInside: dr.top >= lr.top - 1,
                bottomInside: dr.bottom <= lr.bottom + 1,
                headVisible: head.height > 20 && head.top >= lr.top - 1,
            };
        });
        expect(modalBounds).toEqual({ topInside: true, bottomInside: true, headVisible: true });
        await modal.locator('.ml-schema-modal-foot button').first().click();
        await expect(modal).toBeHidden();

        // Switch to Settings tab: Enabled switch must be visible, unobstructed by sticky bar, and toggleable
        const settingsTab = lens.locator('.ml-viewswitch .lw-seg-btn').nth(4);
        await settingsTab.click();
        const settingsView = lens.locator('.ml-settings');
        await expect(settingsView).toBeVisible();
        const enabledSwitch = settingsView.locator('[data-field-key="enabled"]').first();
        await enabledSwitch.scrollIntoViewIfNeeded();
        await expect(enabledSwitch).toBeVisible();

        const settingsGeom = await settingsView.evaluate((el) => {
            const sr = el.getBoundingClientRect();
            const sw = el.querySelector('[data-field-key="enabled"]').getBoundingClientRect();
            const sticky = el.querySelector('.ml-settings-sticky');
            const stickyPos = sticky ? getComputedStyle(sticky).position : '';
            const stickyRect = sticky ? sticky.getBoundingClientRect() : null;
            return {
                settingsH: Math.round(sr.height),
                switchInside: sw.top >= sr.top - 1 && sw.bottom <= sr.bottom + 1,
                stickyPos,
                stickyCoversSwitch: Boolean(stickyRect && stickyRect.top < sw.bottom && stickyRect.bottom > sw.top),
            };
        });
        expect(settingsGeom.settingsH).toBeGreaterThan(220);
        expect(settingsGeom.switchInside).toBe(true);
        expect(settingsGeom.stickyPos).toBe('static');
        expect(settingsGeom.stickyCoversSwitch).toBe(false);

        // Toggle Memory Graph off and back on cleanly
        await expect(enabledSwitch).toHaveAttribute('aria-checked', 'true');
        await enabledSwitch.click();
        await expect(enabledSwitch).toHaveAttribute('aria-checked', 'false');
        await enabledSwitch.click();
        await expect(enabledSwitch).toHaveAttribute('aria-checked', 'true');
    });

    test('AI Iteration stays non-overlapping and keeps composer usable on mobile IME shrink and mid-width screens', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Ash the Cartographer');

        await page.setViewportSize({ width: 412, height: 915 });
        const win = await openWorkbench(page, { via: 'wand' });
        await switchWorkbenchTab(page, 'ai');
        const input = win.locator('.wb-chat .wb-input');
        await expect(input).toBeVisible();

        // 1. Normal mobile height (412x915): target selector is single horizontal strip, preview hidden, no overlap
        const beforeIme = await page.evaluate(() => {
            const winR = document.querySelector('.wbench .wb-win').getBoundingClientRect();
            const seg = document.querySelector('.wbench .wb-ws-seg');
            const segR = seg.getBoundingClientRect();
            const preview = document.querySelector('.wbench .wb-iter-preview');
            return {
                winH: Math.round(winR.height),
                segH: Math.round(segR.height),
                segWrap: getComputedStyle(seg).flexWrap,
                previewHidden: Boolean(preview?.hidden),
                previewDisplay: preview ? getComputedStyle(preview).display : 'none',
            };
        });
        expect(beforeIme.winH).toBeGreaterThanOrEqual(500);
        expect(beforeIme.segWrap).toBe('nowrap');
        expect(beforeIme.segH).toBeLessThanOrEqual(46);
        expect(beforeIme.previewHidden).toBe(true);
        expect(beforeIme.previewDisplay).toBe('none');

        // 2. Simulate Android IME opening: focus input and shrink viewport height to 360px
        await input.click();
        await page.setViewportSize({ width: 412, height: 360 });
        await expect(page.locator('.wbench')).toHaveClass(/\bis-compact\b/);
        await expect(page.locator('.wbench')).toHaveClass(/\bis-short\b/);

        const imeGeom = await page.evaluate(() => {
            const winR = document.querySelector('.wbench .wb-win').getBoundingClientRect();
            const mainR = document.querySelector('.wbench .wb-main').getBoundingClientRect();
            const headR = document.querySelector('.wbench .wb-chat-head').getBoundingClientRect();
            const bodyR = document.querySelector('.wbench .wb-chat-body').getBoundingClientRect();
            const compR = document.querySelector('.wbench .wb-composer').getBoundingClientRect();
            const inpR = document.querySelector('.wbench .wb-input').getBoundingClientRect();
            const sendR = document.querySelector('.wbench .wb-send').getBoundingClientRect();
            const preview = document.querySelector('.wbench .wb-iter-preview');
            return {
                winH: Math.round(winR.height),
                headBottom: Math.round(headR.bottom),
                bodyTop: Math.round(bodyR.top),
                bodyBottom: Math.round(bodyR.bottom),
                bodyH: Math.round(bodyR.height),
                compTop: Math.round(compR.top),
                compBottom: Math.round(compR.bottom),
                mainBottom: Math.round(mainR.bottom),
                inputVisible: inpR.height >= 30 && inpR.top >= mainR.top - 1 && inpR.bottom <= Math.min(mainR.bottom, window.innerHeight) + 1,
                sendVisible: sendR.height >= 30 && sendR.right <= mainR.right + 1 && sendR.bottom <= Math.min(mainR.bottom, window.innerHeight) + 1,
                previewDisplay: preview ? getComputedStyle(preview).display : 'none',
            };
        });
        expect(imeGeom.previewDisplay).toBe('none');
        expect(imeGeom.headBottom).toBeLessThanOrEqual(imeGeom.bodyTop + 1);
        expect(imeGeom.bodyBottom).toBeLessThanOrEqual(imeGeom.compTop + 1);
        expect(imeGeom.bodyH).toBeGreaterThanOrEqual(24);
        expect(imeGeom.inputVisible).toBe(true);
        expect(imeGeom.sendVisible).toBe(true);

        // Typing while IME viewport is shrunk still works
        await input.fill('Keep events concise');
        await expect(input).toHaveValue('Keep events concise');

        // 3. Simulate IME closing (412x915): window restores its preferred height instead of staying stuck at 360px
        await page.setViewportSize({ width: 412, height: 915 });
        await expect(page.locator('.wbench')).not.toHaveClass(/\bis-short\b/);
        const afterImeWinH = await win.evaluate(el => Math.round(el.getBoundingClientRect().height));
        expect(afterImeWinH).toBeGreaterThanOrEqual(beforeIme.winH - 2);

        // 4. Mid-width non-compact screen (680x380): chat must NOT be crushed to 0px or overlap preview pane
        await page.setViewportSize({ width: 680, height: 380 });
        await expect(page.locator('.wbench')).toHaveClass(/\bis-narrow-main\b/);
        await expect(page.locator('.wbench')).toHaveClass(/\bis-drawer-side\b/);
        const midGeom = await page.evaluate(() => {
            const mainR = document.querySelector('.wbench .wb-main').getBoundingClientRect();
            const chatR = document.querySelector('.wbench .wb-chat').getBoundingClientRect();
            const inpR = document.querySelector('.wbench .wb-input').getBoundingClientRect();
            const preview = document.querySelector('.wbench .wb-iter-preview');
            const sess = document.querySelector('.wbench .wb-sess');
            return {
                chatW: Math.round(chatR.width),
                mainW: Math.round(mainR.width),
                inputVisible: inpR.width > 120 && inpR.bottom <= mainR.bottom + 1,
                previewDisplay: preview ? getComputedStyle(preview).display : 'none',
                sessDisplay: sess ? getComputedStyle(sess).display : 'none',
            };
        });
        expect(midGeom.previewDisplay).toBe('none');
        expect(midGeom.sessDisplay).toBe('none');
        expect(midGeom.chatW).toBeGreaterThan(350);
        expect(midGeom.inputVisible).toBe(true);
    });
});
