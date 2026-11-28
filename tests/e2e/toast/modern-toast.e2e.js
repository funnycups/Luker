// Real-browser end-to-end verification for Luker's modern toast engine:
// 1. Card-deck stacking, badge expand/collapse, front-click dismissal, and /echo color override.
// 2. Per-toast independent pointer dragging without accidental tap-to-dismiss or /echo onClick.
// 3. Ongoing-task persistent toast via /loader-show: no close button, minimize to non-overlapping
//    corner capsule, capsule dragging, expand with live Stop button, and /loader-hide cleanup.
// 4. Sticky error persistent toast via /echo severity=error timeout=0 extendedTimeout=0:
//    both minimize and close controls work cleanly.
// 5. Top-layer <dialog> interop across both <dialog class="popup"> and Account Window (dialog.dw-layer),
//    including rescuing active persistent toasts when dialog.dw-layer closes.
// 6. Narrow mobile viewport (390x844) bounds, deck badge toggle, drag, and capsule containment.
// 7. Expanded burst scrolling with detached side card remaining unclipped and hit-testable.
// 8. Real theme/custom-CSS controls (#themes, #ui_preset_derive_button, #customCSS, Lens palette strip).

import { test, expect } from '../../harness/playwright.js';

import { startServer } from '../../harness/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';
import { accountWindow, openAccountWindow } from '../_lib/account-window.js';

async function sendSlashCommand(page, commandText) {
    const input = page.locator('#send_textarea');
    await input.waitFor({ state: 'visible', timeout: 10_000 });
    await input.click();
    await input.fill(commandText);
    await input.press('Enter');
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

async function openUserSettingsDrawer(page) {
    const closedIcon = page.locator('#user-settings-button .drawer-icon.closedIcon');
    if (await closedIcon.count()) {
        await page.locator('#user-settings-button .drawer-toggle').click();
    }
    await expect(page.locator('#themes')).toBeVisible();
}

async function closeUserSettingsDrawerIfOpen(page) {
    const openIcon = page.locator('#user-settings-button .drawer-icon.openIcon');
    if (await openIcon.count()) {
        await page.locator('#user-settings-button .drawer-toggle').click();
    }
}

async function openOptionsMenu(page) {
    const options = page.locator('#options');
    if (!(await options.isVisible())) {
        await page.locator('#options_button').click();
    }
    await expect(options).toBeVisible();
}

test.describe('modern toast system', () => {
    let server;

    test.beforeAll(async ({ workerResources }, testInfo) => {
        const scope = await workerResources.scenario(testInfo.file);
        server = await startServer({ scope, batchKey: 'regression', scenarioId: 'modern-toast' });
        markOnboarded({ dataRoot: server.dataRoot });
    });

    test.afterAll(async () => {
        if (server) {
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
        await selectCharacterByName(page, 'Seraphina');

        await sendSlashCommand(page, '/echo timeout=60000 title="Watchpost" Background dock notice');
        await sendSlashCommand(page, '/echo timeout=60000 title="Watchpost" onClick={: /echo timeout=60000 "Watchpost clicked" :} Drag me out of the way');

        const dragToast = page.locator('#toast-container .toast', { hasText: 'Drag me out of the way' });
        const stayToast = page.locator('#toast-container .toast', { hasText: 'Background dock notice' });
        const clickedNotice = page.locator('#toast-container .toast', { hasText: 'Watchpost clicked' });
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

        // Dragging must NOT have triggered onClick or dismissed the toast.
        await expect(clickedNotice).toHaveCount(0);

        // Now a normal click without dragging fires onClick and dismisses.
        await dragToast.click();
        await expect(dragToast).toHaveCount(0, { timeout: 5_000 });
        await expect(clickedNotice).toHaveCount(1, { timeout: 5_000 });
    });

    test('supports ongoing-task persistent toast capsule minimize, drag, expand with live Stop button, and loader-hide cleanup', async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 800 });
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        await sendSlashCommand(
            page,
            '/loader-show blocking=false message="Extracting memories 1/3" onStop={: /echo timeout=60000 "Extraction stopped" :}',
        );

        const taskToast = page.locator('#toast-container .toast', { hasText: 'Extracting memories 1/3' });
        await expect(taskToast).toBeVisible({ timeout: 10_000 });
        await expect(taskToast.locator('.toast-close-button')).toHaveCount(0);
        await expect(taskToast.locator('.luker-toast-minimize-button')).toHaveCount(1);

        // Clicking body must NOT dismiss an ongoing task toast.
        await taskToast.locator('.action-loader-message').click();
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

        // Drag capsule to custom coordinates -> stays minimized, does not expand on drop.
        await dragElementBy(page, capsule, -500, 260);
        await expect(taskToast).toHaveAttribute('data-toast-state', 'minimized');
        const draggedCapBox = await capsule.boundingBox();
        expect(draggedCapBox.x).toBeLessThan(parkedBox.x - 400);

        // Clicking dragged capsule expands in place as detached, preserving Stop button handler.
        await capsule.click();
        await expect(taskToast).toHaveAttribute('data-toast-state', 'detached');
        await expect(taskToast.locator('.action-loader-stop')).toBeVisible();
        await taskToast.locator('.action-loader-stop').click();
        await expect(taskToast).toHaveCount(0, { timeout: 5_000 });
        const stoppedNotice = page.locator('#toast-container .toast', { hasText: 'Extraction stopped' });
        await expect(stoppedNotice).toBeVisible({ timeout: 5_000 });
        await stoppedNotice.click();
        await expect(stoppedNotice).toHaveCount(0, { timeout: 5_000 });

        // Minimize a second ongoing loader and verify /loader-hide removes the minimized capsule cleanly.
        await sendSlashCommand(page, '/loader-show blocking=false message="Night watch sweep"');
        const sweepToast = page.locator('#toast-container .toast', { hasText: 'Night watch sweep' });
        await expect(sweepToast).toBeVisible({ timeout: 10_000 });
        await sweepToast.locator('.luker-toast-minimize-button').click();
        await expect(sweepToast).toHaveAttribute('data-toast-state', 'minimized');
        await sendSlashCommand(page, '/loader-hide');
        await expect(sweepToast).toHaveCount(0, { timeout: 5_000 });
    });

    test('sticky error persistent toast exposes both minimize and close controls', async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 800 });
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        await sendSlashCommand(
            page,
            '/echo severity=error timeout=0 extendedTimeout=0 title="Image Generation" Upstream chart endpoint returned 503',
        );

        const errToast = page.locator('#toast-container .toast-error').first();
        await expect(errToast).toBeVisible({ timeout: 10_000 });
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

        // Create two persistent toasts via /loader-show: detach the first and minimize the second.
        await sendSlashCommand(page, '/loader-show blocking=false title="Compass" message="Detached compass monitor"');
        await sendSlashCommand(page, '/loader-show blocking=false title="Beacon" message="Minimized beacon task"');

        const detachedCard = page.locator('#toast-container .toast', { hasText: 'Detached compass monitor' });
        const capsuleToast = page.locator('#toast-container .toast', { hasText: 'Minimized beacon task' });
        await expect(detachedCard).toBeVisible({ timeout: 10_000 });
        await expect(capsuleToast).toBeVisible({ timeout: 10_000 });

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

        await sendSlashCommand(page, '/loader-hide');
    });

    test('stays within narrow mobile viewport (390x844) across stacking, badge expand, drag, and capsule minimize', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        await sendSlashCommand(page, '/echo timeout=60000 First narrow mobile update');
        await sendSlashCommand(page, '/echo timeout=60000 Second narrow mobile update');
        await sendSlashCommand(page, '/loader-show blocking=false message="Persistent mobile job running"');

        const container = page.locator('#toast-container');
        const badge = container.locator('.luker-toast-stack-badge');
        await expect(badge).toBeVisible({ timeout: 10_000 });
        await expect(badge).toHaveText('+2');

        const front = container.locator('.toast[data-stack-index="0"]');
        const frontBox = await front.boundingBox();
        expect(frontBox.x).toBeGreaterThanOrEqual(0);
        expect(frontBox.x + frontBox.width).toBeLessThanOrEqual(390);

        // Stepped behind cards must also stay inside the narrow 390px viewport.
        const behindBounds = await page.evaluate(() => {
            const cards = Array.from(document.querySelectorAll('#toast-container .toast[data-toast-state="docked"]'));
            return cards.map(c => {
                const r = c.getBoundingClientRect();
                return { index: Number(c.dataset.stackIndex), left: r.left, right: r.right };
            });
        });
        for (const card of behindBounds) {
            expect(card.left).toBeGreaterThanOrEqual(7);
            expect(card.right).toBeLessThanOrEqual(390);
        }

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

        await sendSlashCommand(page, '/loader-hide');
    });

    test('scrolls expanded burst of tall mixed-height toasts inside viewport while keeping detached cards unclipped', async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 640 });
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        // 1. Trigger a detached persistent card on the left + 10 mixed-height toasts via real slash commands.
        await sendSlashCommand(page, '/loader-show blocking=false title="Side" message="Detached side monitor"');
        const sideCard = page.locator('#toast-container .toast', { hasText: 'Detached side monitor' });
        await expect(sideCard).toBeVisible({ timeout: 10_000 });
        await dragElementBy(page, sideCard, -400, 200);
        await expect(sideCard).toHaveAttribute('data-toast-state', 'detached');

        const burstPipeline = Array.from({ length: 10 }, (_, idx) => {
            const i = idx + 1;
            const msg = i % 2 === 0
                ? `Entry #${i}: multi-line tall notification detailing background reef survey progress across eastern buoys and night watch relay checks.`
                : `Entry #${i}: short notice`;
            return `/echo timeout=60000 title="Alert ${i}" ${msg}`;
        }).join(' | ');
        await sendSlashCommand(page, burstPipeline);

        const container = page.locator('#toast-container');
        const badge = container.locator('.luker-toast-stack-badge');
        await expect(badge).toHaveText('+9', { timeout: 10_000 });

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

        await sendSlashCommand(page, '/loader-hide');
    });

    test('renders single surface under third-party !important and plain CSS themes and adapts cleanly to built-in Lens palettes', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        // 1. Derive an editable user theme through real User Settings UI and apply third-party !important CSS via #customCSS.
        await openUserSettingsDrawer(page);
        await expect(page.locator('#ui_preset_derive_button')).toBeVisible({ timeout: 10_000 });
        await page.locator('#ui_preset_derive_button').click();
        await expect(page.locator('#customCSS')).toBeEnabled({ timeout: 10_000 });
        const derivedToast = page.locator('#toast-container .toast', { hasText: /Created editable copy/ });
        await expect(derivedToast).toBeVisible({ timeout: 5_000 });
        await derivedToast.click();
        await expect(derivedToast).toHaveCount(0, { timeout: 5_000 });
        const importantCss = `
            .toast, .toast-container .toast {
                background-color: rgb(250, 246, 232) !important;
                background-image: none !important;
                color: rgb(55, 53, 51) !important;
                border: 1px solid rgb(200, 192, 172) !important;
                border-left: 3px solid rgb(224, 64, 56) !important;
                border-radius: 4px !important;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35) !important;
                text-shadow: none !important;
            }
            .toast-info, .toast-container .toast-info { border-left-color: rgb(224, 64, 56) !important; }
            .toast-info .toast-title { color: rgb(224, 64, 56) !important; }
        `;
        await page.locator('#customCSS').fill(importantCss);
        await closeUserSettingsDrawerIfOpen(page);

        await sendSlashCommand(page, '/echo timeout=60000 title="Please wait" Extension sync in progress.');
        await sendSlashCommand(page, '/loader-show blocking=false message="Extracting memories 1/2"');

        const syncToast = page.locator('#toast-container .toast', { hasText: 'Extension sync in progress.' });
        const taskToast = page.locator('#toast-container .toast', { hasText: 'Extracting memories 1/2' });
        await expect(syncToast).toBeVisible({ timeout: 10_000 });
        await expect(taskToast).toBeVisible({ timeout: 10_000 });
        await taskToast.locator('.luker-toast-minimize-button').click();
        await expect(page.locator('#toast-container .toast[data-toast-state="minimized"]')).toHaveCount(1);

        const themedMetrics = await syncToast.evaluate((card) => {
            const surface = card.querySelector('.luker-toast-surface');
            const title = card.querySelector('.toast-title');
            const icon = card.querySelector('.luker-toast-icon');
            const cap = document.querySelector('#toast-container .toast.luker-toast-minimized');
            const capInner = cap.querySelector('.luker-toast-capsule');
            return {
                cardBg: getComputedStyle(card).backgroundColor,
                cardBgImg: getComputedStyle(card).backgroundImage,
                cardRadius: getComputedStyle(card).borderRadius,
                cardBorderLeft: getComputedStyle(card).borderLeftColor,
                titleColor: getComputedStyle(title).color,
                iconColor: getComputedStyle(icon).color,
                surfaceBg: getComputedStyle(surface).backgroundColor,
                surfaceBorder: getComputedStyle(surface).borderTopWidth,
                surfaceRadius: getComputedStyle(surface).borderRadius,
                surfaceShadow: getComputedStyle(surface).boxShadow,
                capRadius: getComputedStyle(cap).borderRadius,
                capInnerBorder: getComputedStyle(capInner).borderTopWidth,
                capInnerShadow: getComputedStyle(capInner).boxShadow,
            };
        });
        expect(themedMetrics.cardBg).toBe('rgb(250, 246, 232)');
        expect(themedMetrics.cardBgImg).toBe('none');
        expect(themedMetrics.cardRadius).toBe('4px');
        expect(themedMetrics.cardBorderLeft).toBe('rgb(224, 64, 56)');
        expect(themedMetrics.titleColor).toBe('rgb(224, 64, 56)');
        expect(themedMetrics.iconColor).toBe('rgb(55, 53, 51)');
        expect(themedMetrics.surfaceBg).toBe('rgba(0, 0, 0, 0)');
        expect(themedMetrics.surfaceBorder).toBe('0px');
        expect(themedMetrics.surfaceRadius).toBe('0px');
        expect(themedMetrics.surfaceShadow).toBe('none');
        expect(themedMetrics.capRadius).toBe('4px');
        expect(themedMetrics.capInnerBorder).toBe('0px');
        expect(themedMetrics.capInnerShadow).toBe('none');

        await sendSlashCommand(page, '/loader-hide');
        await expect(taskToast).toHaveCount(0, { timeout: 5_000 });
        await syncToast.click();
        await expect(syncToast).toHaveCount(0, { timeout: 5_000 });

        // 2. Plain non-!important classic solid-background theme via #customCSS:
        // @layer luker-toast-skin yields cleanly and text, icon, and close button all inherit white foreground.
        await openUserSettingsDrawer(page);
        await page.locator('#customCSS').fill(`
            .toast { border-radius: 6px; border: none; color: rgb(255, 255, 255); }
            .toast-info { background-color: rgb(47, 150, 180); }
        `);
        await closeUserSettingsDrawerIfOpen(page);

        await sendSlashCommand(page, '/echo timeout=60000 escapeHtml=false title="Classic" Classic solid toast <small>detail</small>');
        const classicToast = page.locator('#toast-container .toast.toast-info', { hasText: 'Classic solid toast' });
        await expect(classicToast).toBeVisible({ timeout: 10_000 });

        const solidMetrics = await classicToast.evaluate((card) => ({
            bg: getComputedStyle(card).backgroundColor,
            radius: getComputedStyle(card).borderRadius,
            titleColor: getComputedStyle(card.querySelector('.toast-title')).color,
            msgColor: getComputedStyle(card.querySelector('.toast-message')).color,
            smallColor: getComputedStyle(card.querySelector('.toast-message small')).color,
            iconColor: getComputedStyle(card.querySelector('.luker-toast-icon')).color,
            closeColor: getComputedStyle(card.querySelector('.toast-close-button')).color,
        }));
        expect(solidMetrics.bg).toBe('rgb(47, 150, 180)');
        expect(solidMetrics.radius).toBe('6px');
        expect(solidMetrics.titleColor).toBe('rgb(255, 255, 255)');
        expect(solidMetrics.msgColor).toBe('rgb(255, 255, 255)');
        expect(solidMetrics.smallColor).toBe('rgb(255, 255, 255)');
        expect(solidMetrics.iconColor).toBe('rgb(255, 255, 255)');
        expect(solidMetrics.closeColor).toBe('rgb(255, 255, 255)');

        await classicToast.click();
        await expect(classicToast).toHaveCount(0, { timeout: 5_000 });

        // 3. Built-in Lens theme + Mist palette via real #themes selector and #theme-palette-strip.
        await openUserSettingsDrawer(page);
        await page.locator('#themes').selectOption('Lens');
        await expect(page.locator('#themes')).toHaveValue('Lens');
        await closeUserSettingsDrawerIfOpen(page);

        await openOptionsMenu(page);
        const strip = page.locator('#theme-palette-strip');
        await expect(strip).toBeVisible();
        await strip.locator('[data-mode="mist"]').click();
        await expect.poll(() => page.evaluate(() => document.documentElement.dataset.themePalette)).toBe('mist');
        await page.locator('#options_button').click();

        await sendSlashCommand(page, '/echo timeout=60000 title="Lens" Lens Mist notice');
        const lensToast = page.locator('#toast-container .toast.toast-info', { hasText: 'Lens Mist notice' });
        await expect(lensToast).toBeVisible({ timeout: 10_000 });

        const lensMetrics = await lensToast.evaluate((card) => ({
            radius: getComputedStyle(card).borderRadius,
            borderLeft: getComputedStyle(card).borderLeftColor,
            iconColor: getComputedStyle(card.querySelector('.luker-toast-icon')).color,
        }));
        expect(lensMetrics.radius).toBe('12px');
        expect(lensMetrics.borderLeft).toBe('rgb(43, 125, 233)');
        expect(lensMetrics.iconColor).toBe('rgb(43, 125, 233)');
    });

    test('fans stepped behind cards visibly, signals behind errors on badge, and pauses occluded error until promoted', async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 800 });
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        // 1. Issue #83 burst: error followed quickly by info.
        await sendSlashCommand(
            page,
            '/echo severity=error timeout=1600 title="Chat Completion API" Upstream request failed with HTTP 500 Internal Server Error. Inspect logs for details. | /delay 150 | /echo severity=info timeout=1600 title="Operation Finished" Parsing completed',
        );

        const container = page.locator('#toast-container');
        const infoToast = container.locator('.toast-info', { hasText: 'Parsing completed' });
        const errorToast = container.locator('.toast-error', { hasText: 'Upstream request failed with HTTP 500' });
        const badge = container.locator('.luker-toast-stack-badge');

        await expect(infoToast).toBeVisible({ timeout: 10_000 });
        await expect(errorToast).toBeVisible({ timeout: 10_000 });
        await expect(infoToast).toHaveAttribute('data-stack-index', '0');
        await expect(errorToast).toHaveAttribute('data-stack-index', '1');
        await expect(badge).toHaveText('+1');
        await expect(badge).toHaveAttribute('data-highest-severity', 'error');
        await expect(badge.locator('.luker-toast-stack-dot[data-toast-type="error"]')).toHaveCount(1);

        // Stepped left fan-out exposes error card's left edge and bottom edge cleanly.
        const fanBoxes = await page.evaluate(() => {
            const front = document.querySelector('#toast-container .toast[data-stack-index="0"]').getBoundingClientRect();
            const behind = document.querySelector('#toast-container .toast[data-stack-index="1"]').getBoundingClientRect();
            return {
                frontLeft: front.left,
                behindLeft: behind.left,
                frontBottom: front.bottom,
                behindBottom: behind.bottom,
            };
        });
        expect(fanBoxes.behindLeft).toBeLessThan(fanBoxes.frontLeft - 3);
        expect(fanBoxes.behindBottom).toBeGreaterThan(fanBoxes.frontBottom + 3);

        // When front info auto-dismisses, occluded error MUST still be alive, promote to index 0 unclipped, and later auto-dismiss.
        await expect(infoToast).toHaveCount(0, { timeout: 6_000 });
        await expect(errorToast).toBeVisible();
        await expect(errorToast).toHaveAttribute('data-stack-index', '0');
        await expect(errorToast).not.toHaveClass(/luker-toast-deck-clipped/);
        const unclipped = await errorToast.evaluate(el => ({
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
        }));
        expect(unclipped.scrollHeight).toBeLessThanOrEqual(unclipped.clientHeight + 2);
        await expect(errorToast).toHaveCount(0, { timeout: 6_000 });

        // 2. 4-toast burst: 4th card (error at index 3) stays visibly fanned out instead of hidden.
        await sendSlashCommand(
            page,
            '/echo severity=error timeout=60000 title="Critical Failure" Request failed with HTTP 500 | /echo severity=info timeout=60000 title="Step 1" Notice one | /echo severity=info timeout=60000 title="Step 2" Notice two | /echo severity=info timeout=60000 title="Step 3" Notice three',
        );

        const fourthError = container.locator('.toast-error', { hasText: 'Request failed with HTTP 500' });
        await expect(fourthError).toHaveAttribute('data-stack-index', '3', { timeout: 10_000 });
        await expect(fourthError).not.toHaveAttribute('data-stack-hidden', 'true');
        const fourthStyle = await fourthError.evaluate(el => ({
            opacity: parseFloat(getComputedStyle(el).opacity),
            visibility: getComputedStyle(el).visibility,
        }));
        expect(fourthStyle.opacity).toBeGreaterThan(0.5);
        expect(fourthStyle.visibility).toBe('visible');
        await expect(badge).toHaveText('+3');
        await expect(badge).toHaveAttribute('data-highest-severity', 'error');
        await expect(badge.locator('.luker-toast-stack-dot[data-toast-type="error"]')).toHaveCount(1);
        await expect(badge.locator('.luker-toast-stack-dot[data-toast-type="info"]')).toHaveCount(1);
    });
});
