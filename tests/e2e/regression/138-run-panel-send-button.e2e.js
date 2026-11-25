// #138 — The orchestrator run panel leaves the chat Send button clickable.
//
// The run panel opens on every orchestrator run and stays open after it
// finishes. On desktop it docks to the right edge; it must fit the gutter
// beside the chat column so a user can keep sending with the panel open.
//
// REAL USER-GESTURE flow, at each window width:
//   1. Fixtures (before the page loads): main chat connection on the mock.
//   2. In the orchestrator drawer: enable, switch to loop mode.
//   3. Send a turn from the composer. The loop agent finalizes, the run
//      panel opens, the main model replies.
//   4. With the panel still open: its box does not intersect #send_but or
//      the send form, the panel has no horizontal overflow, and a real
//      click on Send (sendMessageAndAwaitReply) sends the next turn.
//   5. Narrow the window to the 1024px sidebar breakpoint: the panel at
//      its minimum width still clears the composer without overflow.
//
// With Chat Width at 70% (set in User Settings) the gutter is too narrow
// for the sidebar: the run does not open the panel, the reopen pill shows
// instead without covering the composer, clicking the pill opens the
// drawer layout, the backdrop dismisses it, and Send works with a real
// click.

import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply, waitForConnected, closeAnyOpenTopSettingsDrawer } from '../_lib/page.js';
import { enableOrchestratorMode } from '../_lib/ui-orchestrator.js';

const REPLIES = [
    '*Seraphina sets the lantern on the sill.* "The tide is turning; we leave at first light."',
    '*Seraphina folds the chart along its old crease.* "Then we follow the reef line north."',
];

let server, mock;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    // One reply pair per test.
    mock = await startMockLLM({ scriptedReplies: [...REPLIES, ...REPLIES, ...REPLIES] });
    server = await startServer({ scope, batchKey: 'regression', scenarioId: '138-run-panel-send-button' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {

    await mock?.stop();
});

function intersects(a, b) {
    return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

async function expectDockClearsComposer(page) {
    const dock = page.locator('.rpdock.rp-dock');
    const state = await dock.getAttribute('data-state');
    if (state === 'pill') {
        await page.locator('.rpdock.rp-dock-pill .rp-dock-pill-main').click();
    }
    await expect(dock).toHaveAttribute('data-state', 'open');
    await expect(dock).toBeVisible();
    const dockBox = await dock.boundingBox();
    const sendBtn = page.locator('#send_but');
    if (await sendBtn.isVisible()) {
        const sendBox = await sendBtn.boundingBox();
        expect(intersects(dockBox, sendBox), `run dock ${JSON.stringify(dockBox)} covers #send_but ${JSON.stringify(sendBox)}`).toBe(false);
    }
    const formBox = await page.locator('#send_form').boundingBox();
    expect(intersects(dockBox, formBox), `run dock ${JSON.stringify(dockBox)} covers #send_form ${JSON.stringify(formBox)}`).toBe(false);
    const overflow = await dock.evaluate((el) => {
        const sections = [el.querySelector('.rp-dock-head'), el.querySelector('.rp-dock-body')].filter(Boolean);
        return sections.map((section) => ({
            cls: section.className,
            scrollWidth: section.scrollWidth,
            clientWidth: section.clientWidth,
        }));
    });
    for (const part of overflow) {
        expect(part.scrollWidth, `run dock ${part.cls} must not overflow horizontally`).toBeLessThanOrEqual(part.clientWidth);
    }
}

for (const width of [1280, 1440]) {
    test.describe(`#138 — run panel at ${width}px`, () => {
        test.use({ viewport: { width, height: 800 } });
        test.setTimeout(180_000);

        test('Send stays clickable while the run panel is open', async ({ page }) => {
            mock.scriptDirectorRun({
                route: ({ role }) => (role === 'director-main'
                    ? { tool: 'finalize', arguments: { capsule_text: 'The tide is turning.' } }
                    : null),
            });

            await awaitMainUI(page, server.baseURL);
            await selectCharacterByName(page, 'Seraphina');
            await enableOrchestratorMode(page, 'loop');

            const first = await sendMessageAndAwaitReply(page, '*I glance at the water.* "Is the tide with us?"');
            expect(first.text).toContain('first light');

            await expectDockClearsComposer(page);

            const second = await sendMessageAndAwaitReply(page, '"Which way do we go once we are out?"');
            expect(second.text).toContain('reef line north');
            await expectDockClearsComposer(page);

            // Narrowing the window to the 1024px desktop breakpoint keeps the
            // floating dock clear of the composer without horizontal overflow.
            await page.setViewportSize({ width: 1024, height: 800 });
            await expectDockClearsComposer(page);
            await page.screenshot({ path: test.info().outputPath(`run-panel-${width}-to-1024.png`) });
        });
    });
}

test.describe('#138 — run panel with Chat Width 70% at 1280px', () => {
    test.use({ viewport: { width: 1280, height: 800 } });
    test.setTimeout(180_000);

    test('the run shows the reopen pill instead of covering Send; the pill opens the drawer', async ({ page }) => {
        mock.scriptDirectorRun({
            route: ({ role }) => (role === 'director-main'
                ? { tool: 'finalize', arguments: { capsule_text: 'The tide is turning.' } }
                : null),
        });

        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await enableOrchestratorMode(page, 'loop');

        await page.locator('#user-settings-button .drawer-toggle').click();
        const chatWidth = page.locator('#chat_width_slider_counter');
        await chatWidth.fill('70');
        await chatWidth.press('Tab');
        await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--sheldWidth').trim()))
            .toBe('70vw');
        await closeAnyOpenTopSettingsDrawer(page);

        // Hold the loop agent's request so the run is still in flight
        // while the dock and collapsed pill are verified.
        mock.setLatencyMs((_req, parsed) => ((parsed?.tools || []).some((tool) => tool?.function?.name === 'finalize') ? 6000 : 0));
        try {
            await waitForConnected(page);
            await page.locator('#send_textarea').fill('*I glance at the water.* "Is the tide with us?"');
            await page.locator('#send_but').click();

            const dock = page.locator('.rpdock.rp-dock');
            await expect(dock).toHaveAttribute('data-state', 'open', { timeout: 15_000 });
            await expectDockClearsComposer(page);

            // Collapse to the pill and verify the pill clears the composer and reopens the dock.
            await dock.locator('button[aria-label*="Collapse"], button[title*="Collapse"], button[aria-label*="收起"], button[title*="收起"]').first().click();
            const pill = page.locator('.rpdock.rp-dock-pill');
            await expect(pill).toBeVisible({ timeout: 10_000 });
            await expect(dock).toHaveAttribute('data-state', 'pill');
            const pillBox = await pill.boundingBox();
            const formBox = await page.locator('#send_form').boundingBox();
            expect(intersects(pillBox, formBox), 'the pill must not cover the composer').toBe(false);

            await pill.locator('.rp-dock-pill-main').click();
            await expect(dock).toHaveAttribute('data-state', 'open');
            // Enlarge to centered modal and dismiss back to floating dock via the scrim.
            await dock.locator('button[aria-label*="Enlarge"], button[title*="Enlarge"], button[aria-label*="放大"], button[title*="放大"]').first().click();
            await expect(dock).toHaveAttribute('data-size', 'large');
            const scrim = page.locator('.rpdock.rp-dock-scrim');
            await expect(scrim).toBeVisible();
            await scrim.click({ position: { x: 20, y: 20 } });
            await expect(dock).toHaveAttribute('data-size', 'small');
            await expectDockClearsComposer(page);

            await expect(page.locator('#chat .mes').last()).toContainText('first light', { timeout: 30_000 });
        } finally {
            mock.setLatencyMs(0);
        }

        const second = await sendMessageAndAwaitReply(page, '"Which way do we go once we are out?"');
        expect(second.text).toContain('reef line north');
        await expectDockClearsComposer(page);
    });
});
