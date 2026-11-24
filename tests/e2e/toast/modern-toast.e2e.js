// Real-browser end-to-end verification for Luker's modern toast engine:
// 1. Card-deck stacking, badge expand/collapse, front-click dismissal, and /echo color override.
// 2. Per-toast independent pointer dragging without accidental tap-to-dismiss or onclick.
// 3. Ongoing-task persistent toast: no close button, minimize to non-overlapping corner capsule,
//    live .toast-message text sync, capsule dragging, expand with live Stop button, and clear().
// 4. Sticky error persistent toast: both minimize and close controls work cleanly.
// 5. Top-layer <dialog> interop across both <dialog class="popup"> and Account Window (dialog.dw-layer),
//    including rescuing active persistent toasts when dialog.dw-layer closes.
// 6. Narrow mobile viewport (390x844) bounds, deck badge toggle, drag, and capsule containment.

import { test, expect } from '@playwright/test';

import { startServer, tearDownServer } from '../_lib/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';
import { accountWindow, openAccountWindow } from '../_lib/account-window.js';

async function sendSlashCommand(page, commandText) {
    const input = page.locator('#send_textarea');
    await input.waitFor({ state: 'visible', timeout: 10_000 });
    await input.fill(commandText);
    await page.locator('#send_but').click();
}

async function dragElementBy(page, locator, dx, dy) {
    const box = await locator.boundingBox();
    expect(box).toBeTruthy();
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + dx, startY + dy, { steps: 12 });
    await page.mouse.up();
}

test.describe('modern toast system', () => {
    let server;

    test.beforeAll(async () => {
        server = await startServer({ batchKey: 'regression', scenarioId: 'modern-toast' });
        markOnboarded({ dataRoot: server.dataRoot });
    });

    test.afterAll(async () => {
        if (server) {
            await tearDownServer(server);
            server = null;
        }
    });

    test('stacks multiple docked toasts into a compact deck, honors /echo color, and dismisses front toast on click', async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 800 });
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        // Trigger 4 real toasts via /echo slash command (including custom color on the newest).
        await sendSlashCommand(page, '/echo timeout=60000 Reef lantern fuel checked');
        await sendSlashCommand(page, '/echo timeout=60000 Tidal chart synced');
        await sendSlashCommand(page, '/echo timeout=60000 Spyglass lens wiped');
        await sendSlashCommand(page, '/echo timeout=60000 color=rebeccapurple Signal flare ready');

        const container = page.locator('#toast-container');
        const toasts = container.locator('.toast');
        await expect(toasts).toHaveCount(4, { timeout: 10_000 });
        await expect(container).toHaveAttribute('data-deck-expanded', 'false');

        const badge = container.locator('.luker-toast-stack-badge');
        await expect(badge).toBeVisible();
        await expect(badge).toHaveText('+3');

        // Custom inline background-color from /echo color=... must remain visible on the front card.
        const frontToast = container.locator('.toast[data-stack-index="0"]');
        await expect(frontToast).toContainText('Signal flare ready');
        const frontBg = await frontToast.evaluate(el => ({
            toastBg: getComputedStyle(el).backgroundColor,
            surfaceBgImg: getComputedStyle(el.querySelector('.luker-toast-surface')).backgroundImage,
        }));
        expect(frontBg.toastBg).toBe('rgb(102, 51, 153)');
        expect(frontBg.surfaceBgImg).toBe('none');

        // Collapsed deck vertical span must stay compact (< 2x front card height).
        const collapsedMetrics = await page.evaluate(() => {
            const cards = Array.from(document.querySelectorAll('#toast-container .toast[data-toast-state="docked"]'));
            const rects = cards.map(c => c.getBoundingClientRect());
            const frontHeight = rects[0].height;
            const visibleRects = rects.filter((_, i) => i < 3);
            const minTop = Math.min(...visibleRects.map(r => r.top));
            const maxBottom = Math.max(...visibleRects.map(r => r.bottom));
            return { frontHeight, collapsedSpan: maxBottom - minTop };
        });
        expect(collapsedMetrics.collapsedSpan).toBeLessThan(collapsedMetrics.frontHeight * 2);

        // Clicking badge pins expanded mode and separates all 4 cards vertically without overlap.
        await badge.click();
        await expect(container).toHaveAttribute('data-deck-expanded', 'true');
        await expect.poll(async () => {
            const expandedTops = await page.evaluate(() => {
                const cards = Array.from(document.querySelectorAll('#toast-container .toast[data-toast-state="docked"]'))
                    .sort((a, b) => Number(a.dataset.stackIndex) - Number(b.dataset.stackIndex));
                return cards.map(c => {
                    const r = c.getBoundingClientRect();
                    return { top: r.top, bottom: r.bottom };
                });
            });
            for (let i = 1; i < expandedTops.length; i++) {
                if (expandedTops[i].top < expandedTops[i - 1].bottom - 1) return false;
            }
            return expandedTops.length === 4;
        }, { timeout: 5_000 }).toBe(true);

        // Collapse via badge, move mouse away so hover doesn't keep it open, then click front card directly.
        await badge.click();
        await page.mouse.move(10, 750);
        await expect(container).toHaveAttribute('data-deck-expanded', 'false', { timeout: 5_000 });
        await frontToast.click();
        await expect(toasts).toHaveCount(3, { timeout: 5_000 });
        // Move mouse off the deck so hover-expand collapses back to compact badge count.
        await page.mouse.move(10, 750);
        await expect(container).toHaveAttribute('data-deck-expanded', 'false', { timeout: 5_000 });
        await expect(badge).toHaveText('+2');
    });

    test('drags an individual toast freely without triggering tapToDismiss or onclick', async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 800 });
        await awaitMainUI(page, server.baseURL);

        await page.evaluate(() => {
            window.__toastClicks = 0;
            window.toastr.info('Background dock notice', 'Watchpost', { timeOut: 60000 });
            window.toastr.info('Drag me out of the way', 'Watchpost', {
                timeOut: 60000,
                tapToDismiss: true,
                onclick: () => { window.__toastClicks += 1; },
            });
        });

        const dragToast = page.locator('#toast-container .toast', { hasText: 'Drag me out of the way' });
        const stayToast = page.locator('#toast-container .toast', { hasText: 'Background dock notice' });
        await expect(dragToast).toBeVisible();

        const beforeBox = await dragToast.boundingBox();
        await dragElementBy(page, dragToast, -260, 220);

        await expect(dragToast).toHaveAttribute('data-toast-state', 'detached');
        await expect(dragToast).toBeVisible();
        await expect(stayToast).toHaveAttribute('data-toast-state', 'docked');

        const afterBox = await dragToast.boundingBox();
        expect(Math.abs((afterBox.x - beforeBox.x) - (-260))).toBeLessThan(20);
        expect(Math.abs((afterBox.y - beforeBox.y) - 220)).toBeLessThan(20);
        expect(afterBox.x).toBeGreaterThanOrEqual(8);
        expect(afterBox.y + afterBox.height).toBeLessThanOrEqual(800 - 8);

        // Dragging must NOT have triggered onclick or dismissed the toast.
        const clickCount = await page.evaluate(() => window.__toastClicks);
        expect(clickCount).toBe(0);

        // Now a normal click without dragging fires onclick and dismisses.
        await dragToast.click();
        await expect(dragToast).toHaveCount(0, { timeout: 5_000 });
        expect(await page.evaluate(() => window.__toastClicks)).toBe(1);
    });

    test('supports ongoing-task persistent toast capsule minimize, live text sync, drag, expand with live Stop button, and clear()', async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 800 });
        await awaitMainUI(page, server.baseURL);

        await page.evaluate(() => {
            window.__stopClicked = 0;
            const $t = window.toastr.info(' ', '', {
                timeOut: 0,
                extendedTimeOut: 0,
                tapToDismiss: false,
                closeButton: false,
                closable: false,
            });
            const body = $t.find('.toast-message');
            body.empty();
            const text = window.$('<div class="luker-rpg-memory-toast-text">Extracting memories 1/3</div>');
            const stop = window.$('<button type="button" class="menu_button menu_button_small luker-toast-stop-button">Stop</button>');
            stop.on('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                window.__stopClicked += 1;
            });
            body.append(text, stop);
            window.__activeTaskToast = $t;
        });

        const taskToast = page.locator('#toast-container .toast').first();
        await expect(taskToast).toBeVisible();
        await expect(taskToast.locator('.toast-close-button')).toHaveCount(0);
        await expect(taskToast.locator('.luker-toast-minimize-button')).toHaveCount(1);

        // Clicking body must NOT dismiss an ongoing task toast.
        await taskToast.locator('.luker-rpg-memory-toast-text').click();
        await expect(taskToast).toBeVisible();

        // Minimize -> shrinks into compact capsule parked in top-right corner clear of center dock.
        await taskToast.locator('.luker-toast-minimize-button').click();
        await expect(taskToast).toHaveAttribute('data-toast-state', 'minimized');
        await expect(taskToast).toHaveClass(/luker-toast-minimized/);

        const capsule = taskToast.locator('.luker-toast-capsule');
        await expect(capsule).toBeVisible();
        await expect(capsule.locator('.luker-toast-capsule-label')).toHaveText('Extracting memories 1/3');
        const parkedBox = await capsule.boundingBox();
        expect(parkedBox.x + parkedBox.width).toBeGreaterThan(1200);
        expect(parkedBox.height).toBeLessThanOrEqual(36);

        // Live DOM mutation inside .toast-message updates the capsule label without including "Stop".
        await page.evaluate(() => {
            window.__activeTaskToast.find('.luker-rpg-memory-toast-text').text('Extracting memories 2/3');
        });
        await expect(capsule.locator('.luker-toast-capsule-label')).toHaveText('Extracting memories 2/3');

        // Drag capsule to custom coordinates -> stays minimized, does not expand on drop.
        await dragElementBy(page, capsule, -500, 260);
        await expect(taskToast).toHaveAttribute('data-toast-state', 'minimized');
        const draggedCapBox = await capsule.boundingBox();
        expect(draggedCapBox.x).toBeLessThan(parkedBox.x - 400);

        // Clicking dragged capsule expands in place as detached, preserving Stop button handler.
        await capsule.click();
        await expect(taskToast).toHaveAttribute('data-toast-state', 'detached');
        await expect(taskToast.locator('.luker-toast-stop-button')).toBeVisible();
        await taskToast.locator('.luker-toast-stop-button').click();
        expect(await page.evaluate(() => window.__stopClicked)).toBe(1);

        // Re-minimize and confirm programmatic toastr.clear() removes the minimized capsule cleanly.
        await taskToast.locator('.luker-toast-minimize-button').click();
        await expect(taskToast).toHaveAttribute('data-toast-state', 'minimized');
        await page.evaluate(() => window.toastr.clear(window.__activeTaskToast));
        await expect(taskToast).toHaveCount(0, { timeout: 5_000 });
    });

    test('sticky error persistent toast exposes both minimize and close controls', async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 800 });
        await awaitMainUI(page, server.baseURL);

        await page.evaluate(() => {
            window.toastr.error('Upstream chart endpoint returned 503', 'Image Generation', {
                timeOut: 0,
                extendedTimeOut: 0,
                tapToDismiss: true,
                closeButton: true,
            });
        });

        const errToast = page.locator('#toast-container .toast-error').first();
        await expect(errToast).toBeVisible();
        await expect(errToast.locator('.luker-toast-minimize-button')).toHaveCount(1);
        await expect(errToast.locator('.toast-close-button')).toHaveCount(1);

        // Minimize -> expand round-trip
        await errToast.locator('.luker-toast-minimize-button').click();
        await expect(errToast).toHaveAttribute('data-toast-state', 'minimized');
        await errToast.locator('.luker-toast-capsule').click();
        await expect(errToast).toHaveAttribute('data-toast-state', 'docked');

        // Close button removes sticky error cleanly
        await errToast.locator('.toast-close-button').click();
        await expect(errToast).toHaveCount(0, { timeout: 5_000 });
    });

    test('keeps detached cards and minimized capsules above <dialog class="popup"> and Account Window (dialog.dw-layer), rescuing them on close', async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 800 });
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        // Create one detached persistent toast on the left and one minimized capsule parked on the right.
        await page.evaluate(() => {
            window.toastr.info('Detached compass monitor', 'Compass', { timeOut: 0, tapToDismiss: false });
            window.toastr.info('Minimized beacon task', 'Beacon', { timeOut: 0, tapToDismiss: false });
        });

        const detachedCard = page.locator('#toast-container .toast', { hasText: 'Detached compass monitor' });
        const capsuleToast = page.locator('#toast-container .toast', { hasText: 'Minimized beacon task' });
        // Minimize the frontmost toast first (newestOnTop), then drag the newly promoted front card.
        await capsuleToast.locator('.luker-toast-minimize-button').click();
        await expect(capsuleToast).toHaveAttribute('data-toast-state', 'minimized');
        await dragElementBy(page, detachedCard, -320, 220);
        await expect(detachedCard).toHaveAttribute('data-toast-state', 'detached');

        // 1. Open a real <dialog class="popup"> via /popup slash command and wait for opening animation to finish.
        await sendSlashCommand(page, '/popup Tide watch briefing ready.');
        const popup = page.locator('dialog.popup[open]:not([opening])');
        await expect(popup).toBeVisible({ timeout: 10_000 });

        const hitsAbovePopup = await page.evaluate(() => {
            const det = document.querySelector('#toast-container .toast[data-toast-state="detached"]');
            const cap = document.querySelector('#toast-container .toast[data-toast-state="minimized"] .luker-toast-capsule');
            const dr = det.getBoundingClientRect();
            const cr = cap.getBoundingClientRect();
            const hitDet = document.elementFromPoint(dr.left + dr.width / 2, dr.top + dr.height / 2);
            const hitCap = document.elementFromPoint(cr.left + cr.width / 2, cr.top + cr.height / 2);
            return {
                hitsDetached: Boolean(hitDet && hitDet.closest('#toast-container')),
                hitsCapsule: Boolean(hitCap && hitCap.closest('#toast-container')),
            };
        });
        expect(hitsAbovePopup).toEqual({ hitsDetached: true, hitsCapsule: true });
        await popup.locator('.popup-button-ok').click();
        await expect(popup).toHaveCount(0, { timeout: 5_000 });

        // 2. Open the real Account Window (<dialog class="dw-layer">).
        await openAccountWindow(page);
        await expect(accountWindow(page)).toBeVisible();

        const hitsAboveAccount = await page.evaluate(() => {
            const dlg = document.querySelector('dialog.dw-layer[open]');
            const tc = document.getElementById('toast-container');
            const det = tc.querySelector('.toast[data-toast-state="detached"]');
            const cap = tc.querySelector('.toast[data-toast-state="minimized"] .luker-toast-capsule');
            const dr = det.getBoundingClientRect();
            const cr = cap.getBoundingClientRect();
            const hitDet = document.elementFromPoint(dr.left + dr.width / 2, dr.top + dr.height / 2);
            const hitCap = document.elementFromPoint(cr.left + cr.width / 2, cr.top + cr.height / 2);
            return {
                insideDialog: Boolean(dlg && dlg.contains(tc)),
                hitsDetached: Boolean(hitDet && hitDet.closest('#toast-container')),
                hitsCapsule: Boolean(hitCap && hitCap.closest('#toast-container')),
            };
        });
        expect(hitsAboveAccount).toEqual({
            insideDialog: true,
            hitsDetached: true,
            hitsCapsule: true,
        });

        // Clicking capsule while Account Window is open expands it cleanly.
        await capsuleToast.locator('.luker-toast-capsule').click();
        await expect(capsuleToast).toHaveAttribute('data-toast-state', 'docked');
        await capsuleToast.locator('.luker-toast-minimize-button').click();
        await expect(capsuleToast).toHaveAttribute('data-toast-state', 'minimized');

        // Close Account Window via its real close button -> must rescue #toast-container back to document.body.
        await accountWindow(page).locator('[data-act="close"]').click();
        await expect(accountWindow(page)).toHaveCount(0, { timeout: 5_000 });

        await expect(detachedCard).toBeVisible();
        await expect(capsuleToast.locator('.luker-toast-capsule')).toBeVisible();
        const rescuedToBody = await page.evaluate(() => document.getElementById('toast-container')?.parentElement === document.body);
        expect(rescuedToBody).toBe(true);
    });

    test('stays within narrow mobile viewport (390x844) across stacking, badge expand, drag, and capsule minimize', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await awaitMainUI(page, server.baseURL);

        await page.evaluate(() => {
            window.toastr.info('First narrow mobile update', '', { timeOut: 60000 });
            window.toastr.info('Second narrow mobile update', '', { timeOut: 60000 });
            window.toastr.info('Persistent mobile job running', '', { timeOut: 0, tapToDismiss: false });
        });

        const container = page.locator('#toast-container');
        const badge = container.locator('.luker-toast-stack-badge');
        await expect(badge).toBeVisible();
        await expect(badge).toHaveText('+2');

        const front = container.locator('.toast[data-stack-index="0"]');
        const frontBox = await front.boundingBox();
        expect(frontBox.x).toBeGreaterThanOrEqual(0);
        expect(frontBox.x + frontBox.width).toBeLessThanOrEqual(390);

        // Expand & collapse via badge tap
        await badge.click();
        await expect(container).toHaveAttribute('data-deck-expanded', 'true');
        await badge.click();
        await expect(container).toHaveAttribute('data-deck-expanded', 'false');

        // Minimize persistent task and verify capsule stays strictly within 390x844
        const mobileTask = container.locator('.toast', { hasText: 'Persistent mobile job running' });
        await mobileTask.locator('.luker-toast-minimize-button').click();
        await expect(mobileTask).toHaveAttribute('data-toast-state', 'minimized');
        const capBox = await mobileTask.locator('.luker-toast-capsule').boundingBox();
        expect(capBox.x).toBeGreaterThanOrEqual(8);
        expect(capBox.x + capBox.width).toBeLessThanOrEqual(390 - 8);
        expect(capBox.y).toBeGreaterThanOrEqual(8);
        expect(capBox.y + capBox.height).toBeLessThanOrEqual(844 - 8);

        // Drag capsule far off-screen to test viewport clamping
        await dragElementBy(page, mobileTask.locator('.luker-toast-capsule'), -800, 1200);
        const clampedBox = await mobileTask.locator('.luker-toast-capsule').boundingBox();
        expect(clampedBox.x).toBeGreaterThanOrEqual(8);
        expect(clampedBox.x + clampedBox.width).toBeLessThanOrEqual(390 - 8);
        expect(clampedBox.y + clampedBox.height).toBeLessThanOrEqual(844 - 8);
    });

    test('scrolls expanded burst of tall mixed-height toasts inside viewport while keeping detached cards unclipped and activity-pill clearance single-offset', async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 640 });
        await awaitMainUI(page, server.baseURL);

        // 1. Trigger a detached persistent card on the left + 10 mixed-height toasts (including multi-line behind cards)
        await page.evaluate(() => {
            window.toastr.info('Detached side monitor', 'Side', { timeOut: 0, tapToDismiss: false });
        });
        const sideCard = page.locator('#toast-container .toast', { hasText: 'Detached side monitor' });
        await dragElementBy(page, sideCard, -400, 200);
        await expect(sideCard).toHaveAttribute('data-toast-state', 'detached');

        await page.evaluate(() => {
            for (let i = 1; i <= 10; i++) {
                const msg = i % 2 === 0
                    ? `Entry #${i}: multi-line tall notification detailing background reef survey progress across eastern buoys and night watch relay checks.`
                    : `Entry #${i}: short notice`;
                window.toastr.info(msg, `Alert ${i}`, { timeOut: 60000 });
            }
        });

        const container = page.locator('#toast-container');
        const badge = container.locator('.luker-toast-stack-badge');
        await expect(badge).toHaveText('+9');

        // Expand burst -> verify container is viewport-bounded and scrollable, zero overlap between tall cards,
        // and the detached side card remains visible & hit-testable outside the 340px column.
        await badge.click();
        await expect(container).toHaveAttribute('data-deck-expanded', 'true');

        const burstMetrics = await page.evaluate(() => {
            const tc = document.getElementById('toast-container');
            const cs = getComputedStyle(tc);
            const tcRect = tc.getBoundingClientRect();
            const cards = Array.from(tc.querySelectorAll('.toast[data-toast-state="docked"]'))
                .sort((a, b) => Number(a.dataset.stackIndex) - Number(b.dataset.stackIndex));
            let anyOverlap = false;
            for (let i = 1; i < cards.length; i++) {
                if (cards[i].getBoundingClientRect().top < cards[i - 1].getBoundingClientRect().bottom - 1) {
                    anyOverlap = true;
                }
            }
            const det = tc.querySelector('.toast[data-toast-state="detached"]');
            const dr = det.getBoundingClientRect();
            const hitDet = document.elementFromPoint(dr.left + dr.width / 2, dr.top + dr.height / 2);
            return {
                overflowY: cs.overflowY,
                containerHeight: tcRect.height,
                scrollHeight: tc.scrollHeight,
                clientHeight: tc.clientHeight,
                anyOverlap,
                hitsDetached: Boolean(hitDet && hitDet.closest('.toast[data-toast-state="detached"]')),
            };
        });
        expect(burstMetrics.overflowY).toBe('auto');
        expect(burstMetrics.containerHeight).toBeLessThanOrEqual(640);
        expect(burstMetrics.scrollHeight).toBeGreaterThan(burstMetrics.clientHeight);
        expect(burstMetrics.anyOverlap).toBe(false);
        expect(burstMetrics.hitsDetached).toBe(true);

        // 2. Verify activity-pill clearance does not double-offset #toast-container with margin-top
        const pillOffset = await page.evaluate(async () => {
            const { createActivityPill } = await import('/scripts/activity-pill.js');
            const pill = createActivityPill({ id: 'test-toast-clearance-pill', onOpen: () => {}, onError: () => {} });
            pill.update({ visible: true, text: 'Sync active', tone: 'done', loading: false });
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            const tc = document.getElementById('toast-container');
            const cs = getComputedStyle(tc);
            const pillRect = document.querySelector('.activity-pill-host').getBoundingClientRect();
            const tcRect = tc.getBoundingClientRect();
            pill.destroy();
            return {
                marginTop: cs.marginTop,
                gapBelowPill: tcRect.top - pillRect.bottom,
            };
        });
        expect(pillOffset.marginTop).toBe('0px');
        expect(pillOffset.gapBelowPill).toBeGreaterThanOrEqual(6);
        expect(pillOffset.gapBelowPill).toBeLessThanOrEqual(24);
    });
});
