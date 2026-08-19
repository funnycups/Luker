// #63 — Drag a prompt into an existing group via real UI gesture.
//
// Verifies the fix for: "in the preset editor drawer, items cannot be
// dragged INTO existing groups."
//
// Pre-fix behavior: jQuery UI sortable reordered the flat <li> list and
// only rebuilt `prompt_order` from the visual sequence. Group membership
// (`prompt_groups[i].identifiers`) was never re-derived from the DOM
// walk, so on the next re-render the dropped prompt snapped back OUT of
// the group.
//
// The test performs a REAL drag gesture (page.mouse.down + move + up,
// which is what jQuery UI sortable listens for — Playwright's dragTo
// can fall back to HTML5 dragstart/dragend depending on element
// attributes, so we drive the mouse explicitly for determinism) and
// asserts:
//   1. The dropped prompt's identifier is added to the group's
//      `identifiers` list in extension_settings-backed state.
//   2. The DOM re-render places the prompt inside the group's visual
//      span with `data-pm-group-id` matching the target group.
//   3. Membership survives a full page reload.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';
import { normalizeIterStudioSettings, ensureOaiDrawerOpen } from './_helpers.js';

// Force a tall viewport so the entire prompt list (~20 rows) fits on
// screen without scrolling — drag gestures need both source and target
// within the visible area for jQuery UI to hit-test correctly. Also
// force full-length video capture so the drag gesture itself is
// reviewable as a webm artifact (post-run ffmpeg can convert to gif
// for review — see tests/artifacts/63-drag-into-group*.gif).
test.use({
    viewport: { width: 1280, height: 1600 },
    video: { mode: 'on', size: { width: 1280, height: 1600 } },
});

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [
        '*Seraphina studies the tide chart, tracing the reef edge with a slow finger.* We have until dusk, no later.',
    ] });
    server = await startServer({
        batchKey: 'preset',
        scenarioId: 'prompt-group-drag-into',
        extraConfig: { 'storage.mode': 'fs' },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    normalizeIterStudioSettings(server.dataRoot);
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

/**
 * Seed a prompt group whose members are two contiguous prompts near the
 * top of the current prompt_order. This is setup — the *tested* action
 * is the subsequent drag gesture. Uses the PromptManager's own group
 * creation API (same one the "create group from selection" toolbar
 * button calls), which enforces contiguity for a valid initial state.
 */
async function seedGroupWithContiguousPair(page) {
    return page.evaluate(() => {
        const pm = window.SillyTavern?.getContext?.().openai?.promptManager;
        if (!pm) throw new Error('promptManager not reachable via SillyTavern.getContext().openai.promptManager');
        const order = pm.getPromptOrderForCharacter(pm.activeCharacter);
        if (!order || order.length < 3) throw new Error(`unexpected prompt_order length ${order?.length}`);
        // Pick two contiguous middle prompts to group so there is at
        // least one ungrouped prompt both before and after the group in
        // the visual list (needed to have a drag source).
        const midIdx = Math.floor(order.length / 2);
        const identifiers = [order[midIdx].identifier, order[midIdx + 1].identifier];
        const group = pm.createPromptGroup('Persona Tone', identifiers);
        if (!group) throw new Error('createPromptGroup returned null');
        // Force-expand the seeded group so its body is visible before
        // drag starts (auto-expand-on-drag is what the fix adds; the
        // seed itself should not depend on that behavior).
        group.collapsed = false;
        pm.saveServiceSettings();
        // Trigger a full re-render so the group header + child rows
        // appear in the DOM, then re-bind the Sortable to the new <li>
        // nodes (renderPromptManagerListItems wipes innerHTML but does
        // not reattach jQuery UI Sortable on its own — the containing
        // render() path does that; from evaluate we call it directly).
        return pm.renderPromptManagerListItems().then(() => {
            pm.makeDraggable();
            return {
                groupId: group.id,
                memberIds: identifiers,
                allOrder: order.map(e => e.identifier),
            };
        });
    });
}

/**
 * Return the identifier of the first ungrouped prompt in visual order.
 * We'll drag this one into the seeded group.
 */
async function pickUngroupedSource(page, seededMemberIds) {
    return page.evaluate((memberIds) => {
        const pm = window.SillyTavern?.getContext?.().openai?.promptManager;
        const order = pm.getPromptOrderForCharacter(pm.activeCharacter);
        const memberSet = new Set(memberIds);
        for (const entry of order) {
            if (memberSet.has(entry.identifier)) continue;
            // Skip system-only prompts that don't render a draggable row
            // (marker prompts). The DOM is the source of truth.
            const li = document.querySelector(`#completion_prompt_manager_list li[data-pm-identifier="${entry.identifier}"]`);
            if (!li) continue;
            if (!li.classList.contains('completion_prompt_manager_prompt_draggable')) continue;
            return entry.identifier;
        }
        throw new Error('no ungrouped draggable source prompt found');
    }, seededMemberIds);
}

test.describe('#63 — drag a prompt INTO an existing group (real gesture)', () => {
    test('dropped prompt joins the group and persists across reload', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await ensureOaiDrawerOpen(page);

        // Wait for the prompt manager list to be populated.
        await page.waitForFunction(() => {
            const list = document.getElementById('completion_prompt_manager_list');
            return list && list.querySelectorAll('li.completion_prompt_manager_prompt_draggable').length >= 3;
        }, null, { timeout: 15_000 });

        // Seed the target group.
        const seeded = await seedGroupWithContiguousPair(page);
        const sourceId = await pickUngroupedSource(page, seeded.memberIds);

        // Confirm precondition: sourceId is NOT yet in the group.
        const before = await page.evaluate((gid) => {
            const pm = window.SillyTavern?.getContext?.().openai?.promptManager;
            const g = pm?.getPromptGroups().find(x => x.id === gid);
            return g ? [...g.identifiers] : null;
        }, seeded.groupId);
        expect(before).not.toContain(sourceId);
        expect(before?.length).toBe(2);

        // Locate the drag handle for the source prompt.
        const sourceHandle = page.locator(
            `#completion_prompt_manager_list li[data-pm-identifier="${sourceId}"] .prompt-manager-marker-handle`,
        ).first();
        await expect(sourceHandle).toBeVisible();

        // Target: the LAST member row of the seeded group. Dropping
        // just after the last member places the dragged prompt at the
        // end of the group's visual span → walk assigns it to the group.
        const lastMemberId = seeded.memberIds[seeded.memberIds.length - 1];
        const targetRow = page.locator(
            `#completion_prompt_manager_list li[data-pm-identifier="${lastMemberId}"]`,
        ).first();
        await expect(targetRow).toBeVisible();

        // Perform the real drag with explicit mouse events so jQuery UI
        // sortable (which listens for mousedown/mousemove/mouseup on the
        // handle) sees a natural drag gesture. Playwright's dragTo can
        // fall back to HTML5 dragstart/dragend depending on element
        // attributes; explicit mouse steps sidestep that ambiguity.

        // Ensure the source handle is visible in the viewport. The
        // prompt-manager list lives inside a scrollable popup pane;
        // Playwright's own scrollIntoViewIfNeeded/hover don't reliably
        // bubble scrolling all the way up to the viewport for this
        // nested layout, so scroll both container and window manually.
        await sourceHandle.evaluate((el) => {
            el.scrollIntoView({ block: 'center', inline: 'nearest' });
        });
        await page.waitForTimeout(50);
        await sourceHandle.hover();
        await page.waitForTimeout(30);

        // Re-measure after scroll — bounding boxes shift.
        const sourceBox = await sourceHandle.boundingBox();
        const targetBox = await targetRow.boundingBox();
        if (!sourceBox || !targetBox) throw new Error('missing bounding box for drag source/target');

        const startX = sourceBox.x + sourceBox.width / 2;
        const startY = sourceBox.y + sourceBox.height / 2;
        const endX = targetBox.x + targetBox.width / 2;
        const endY = targetBox.y + targetBox.height - 3;

        await page.mouse.move(startX, startY);
        await page.mouse.down();
        // Sortable's `delay` option (getSortableDelay() → 50ms desktop)
        // requires a dwell before drag is recognized; over-shoot so the
        // timer definitely elapses under Playwright timing jitter.
        await page.waitForTimeout(200);
        // Nudge to satisfy the `distance` threshold before the main move.
        await page.mouse.move(startX + 3, startY + 3);
        await page.waitForTimeout(20);
        await page.mouse.move(startX + 8, startY + 4);
        await page.waitForTimeout(20);
        // Multi-step move so jQuery UI's mousemove threshold triggers
        // and intermediate over/change callbacks have a chance to fire.
        const steps = 25;
        for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            await page.mouse.move(startX + (endX - startX) * t, startY + (endY - startY) * t, { steps: 1 });
            await page.waitForTimeout(10);
        }
        await page.waitForTimeout(100);
        await page.mouse.up();
        await page.waitForTimeout(200);

        // Assert: source is now a member of the group.
        await expect.poll(async () => {
            return page.evaluate((gid) => {
                const pm = window.SillyTavern?.getContext?.().openai?.promptManager;
                const g = pm?.getPromptGroups().find(x => x.id === gid);
                return g ? [...g.identifiers] : null;
            }, seeded.groupId);
        }, { timeout: 10_000 }).toEqual(expect.arrayContaining([...seeded.memberIds, sourceId]));

        // Assert: DOM re-render places the source row inside the
        // group's visual span (data-pm-group-id matches).
        await expect.poll(async () => {
            return page.evaluate((sid) => {
                const li = document.querySelector(`#completion_prompt_manager_list li[data-pm-identifier="${sid}"]`);
                return li ? li.getAttribute('data-pm-group-id') : null;
            }, sourceId);
        }, { timeout: 5_000 }).toBe(seeded.groupId);

        // Flush the debounced saveSettings pipeline so the drag-updated
        // group membership actually hits disk before we reload. The
        // canonical trigger is a manual saveSettings() call; wait for
        // the SETTINGS_UPDATED event to confirm the write completed.
        await page.evaluate(() => new Promise((resolve, reject) => {
            const ctx = window.SillyTavern?.getContext?.();
            if (!ctx) return reject(new Error('no ST context'));
            const timer = setTimeout(() => reject(new Error('SETTINGS_UPDATED timeout')), 10_000);
            ctx.eventSource.once(ctx.eventTypes.SETTINGS_UPDATED, () => { clearTimeout(timer); resolve(); });
            ctx.saveSettings();
        }));

        // Persistence: reload the page, ensure membership stays.
        await reloadAndAwait(page, server.baseURL);
        await ensureOaiDrawerOpen(page);
        await page.waitForFunction(() => {
            const list = document.getElementById('completion_prompt_manager_list');
            return list && list.querySelectorAll('li.completion_prompt_manager_prompt_draggable').length >= 3;
        }, null, { timeout: 15_000 });

        const after = await page.evaluate((gid) => {
            const pm = window.SillyTavern?.getContext?.().openai?.promptManager;
            const g = pm?.getPromptGroups?.().find(x => x.id === gid);
            return g ? [...g.identifiers] : null;
        }, seeded.groupId);
        expect(after).toContain(sourceId);
        expect(after?.length).toBe(3);
    });
});
