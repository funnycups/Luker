import { test, expect } from '../../harness/playwright.js';

import { startServer } from '../../harness/server.js';
import { bootstrapCustomBackend, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';
import { ensureOaiDrawerOpen } from './_helpers.js';

test.use({ viewport: { width: 1280, height: 1400 } });

let server;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    server = await startServer({
        scope,
        batchKey: 'preset',
        scenarioId: 'pm-lazy-sortable',
        extraConfig: { storage: { mode: 'fs' } },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: 'http://127.0.0.1:1/v1' });
});

test('skips Sortable setup while drawer is closed and activates automatically on drawer open for real drag', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);

    await page.waitForFunction(() => {
        const list = document.getElementById('completion_prompt_manager_list');
        return Boolean(list && list.querySelectorAll('li.completion_prompt_manager_prompt_draggable').length >= 3);
    }, null, { timeout: 15_000 });

    const closedState = await page.evaluate(() => {
        const list = document.getElementById('completion_prompt_manager_list');
        return {
            isHidden: !list || list.getClientRects().length === 0,
            // @ts-ignore
            hasSortable: Boolean(window.$ && window.$('#completion_prompt_manager_list').sortable('instance') !== undefined),
        };
    });
    expect(closedState).toEqual({ isHidden: true, hasSortable: false });

    await ensureOaiDrawerOpen(page);

    await expect.poll(() => page.evaluate(() =>
        // @ts-ignore
        Boolean(window.$ && window.$('#completion_prompt_manager_list').sortable('instance') !== undefined),
    ), { timeout: 5_000 }).toBe(true);

    // Wait for the left drawer's CSS open transition (`@starting-style` height)
    // to finish before scrolling and measuring drag coordinates; measuring
    // mid-transition leaves the pointer above the handle by the time mouse.down fires.
    await page.evaluate(async () => {
        const panel = document.getElementById('left-nav-panel');
        if (!panel || typeof panel.getAnimations !== 'function') return;
        await Promise.all(panel.getAnimations({ subtree: false }).map(animation => animation.finished.catch(() => {})));
    });

    const initialOrder = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#completion_prompt_manager_list li.completion_prompt_manager_prompt_draggable'))
            .slice(0, 3)
            .map(el => el.getAttribute('data-pm-identifier')),
    );
    expect(initialOrder).toHaveLength(3);
    const [firstId, secondId, thirdId] = initialOrder;

    const sourceHandle = page.locator(
        `#completion_prompt_manager_list li[data-pm-identifier="${firstId}"] .prompt-manager-marker-handle`,
    ).first();
    const targetRow = page.locator(
        `#completion_prompt_manager_list li[data-pm-identifier="${thirdId}"]`,
    ).first();

    await sourceHandle.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'nearest' }));
    await sourceHandle.hover();
    await page.waitForTimeout(30);

    const sourceBox = await sourceHandle.boundingBox();
    const targetBox = await targetRow.boundingBox();
    if (!sourceBox || !targetBox) throw new Error('missing drag bounding boxes');

    // PromptManager shrinks the drag placeholder to 4px + 8px vertical margins (20px),
    // pulling rows below the lifted first row upward; targeting just below the initial
    // top of the third row crosses it without entering the fourth row.
    const startX = sourceBox.x + sourceBox.width / 2;
    const startY = sourceBox.y + sourceBox.height / 2;
    const endX = targetBox.x + targetBox.width / 2;
    const endY = targetBox.y + 4;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.waitForTimeout(200);
    await page.mouse.move(startX + 3, startY + 3);
    await page.waitForTimeout(20);
    await page.mouse.move(startX + 8, startY + 4);
    await page.waitForTimeout(20);
    for (let step = 1; step <= 25; step += 1) {
        const ratio = step / 25;
        await page.mouse.move(
            startX + (endX - startX) * ratio,
            startY + (endY - startY) * ratio,
            { steps: 1 },
        );
        await page.waitForTimeout(10);
    }
    await page.waitForTimeout(100);
    await page.mouse.up();

    await expect.poll(() => page.evaluate(() =>
        Array.from(document.querySelectorAll('#completion_prompt_manager_list li.completion_prompt_manager_prompt_draggable'))
            .slice(0, 3)
            .map(el => el.getAttribute('data-pm-identifier')),
    ), { timeout: 5_000 }).toEqual([secondId, thirdId, firstId]);

    await page.evaluate(() => new Promise((resolve, reject) => {
        const ctx = window.SillyTavern?.getContext?.();
        if (!ctx) return reject(new Error('missing context'));
        const timer = setTimeout(() => reject(new Error('SETTINGS_UPDATED timeout')), 10_000);
        ctx.eventSource.once(ctx.eventTypes.SETTINGS_UPDATED, () => { clearTimeout(timer); resolve(); });
        ctx.saveSettings();
    }));

    await reloadAndAwait(page, server.baseURL);
    await ensureOaiDrawerOpen(page);

    await expect.poll(() => page.evaluate(() =>
        Array.from(document.querySelectorAll('#completion_prompt_manager_list li.completion_prompt_manager_prompt_draggable'))
            .slice(0, 3)
            .map(el => el.getAttribute('data-pm-identifier')),
    ), { timeout: 10_000 }).toEqual([secondId, thirdId, firstId]);
});

test('expands prompt groups without replacing rows or refreshing Sortable', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);
    await ensureOaiDrawerOpen(page);

    const { parentId, childId, parentPromptName } = await page.evaluate(async () => {
        const { promptManager } = await import('/scripts/openai.js');
        const [parent, child] = promptManager.getPromptsForCharacter(promptManager.activeCharacter)
            .filter(prompt => promptManager.isPromptEditAllowed(prompt));
        promptManager.ensurePromptGroups().push(
            { id: 'outer', name: 'Parent group', collapsed: true, identifiers: [parent.identifier] },
            { id: 'inner', name: 'Child group', collapsed: true, identifiers: [child.identifier], parentId: 'outer' },
        );
        await promptManager.renderPromptManagerListItems();
        return { parentId: parent.identifier, childId: child.identifier, parentPromptName: parent.name };
    });

    const list = page.locator('#completion_prompt_manager_list');
    const parent = list.locator('.prompt-manager-group[data-pm-group-id="outer"]');
    const child = list.locator('.prompt-manager-group[data-pm-group-id="inner"]');
    const parentPrompt = list.locator(`li[data-pm-identifier="${parentId}"]`);
    const childPrompt = list.locator(`li[data-pm-identifier="${childId}"]`);
    const childEnd = list.locator('[data-pm-group-end="inner"]');
    const originalRow = await parentPrompt.elementHandle();

    await expect.poll(() => list.evaluate(el => Boolean(window.jQuery(el).sortable('instance')))).toBe(true);
    await list.evaluate(el => {
        const sortable = window.jQuery(el).sortable('instance');
        const refresh = sortable.refresh;
        sortable.refresh = function (...args) {
            el.dataset.testSortableRefreshed = 'true';
            return refresh.apply(this, args);
        };
    });

    await parent.locator('.prompt-manager-group-name').click();
    await expect(parentPrompt).toBeVisible();
    await expect(child).toBeVisible();
    await expect(childPrompt).toBeHidden();
    expect(await originalRow.evaluate(el => el.isConnected)).toBe(true);

    await child.locator('.prompt-manager-group-name').click();
    await expect(childPrompt).toBeVisible();
    await expect(childEnd).not.toHaveClass(/prompt-manager-group-end-hidden/);
    await parent.locator('.prompt-manager-group-name').click();
    await expect(child).toBeHidden();
    await expect(childPrompt).toBeHidden();
    await expect(childEnd).toHaveClass(/prompt-manager-group-end-hidden/);

    await parent.locator('.prompt-manager-group-name').click();
    await expect(childPrompt).toBeVisible();
    await expect(list).not.toHaveAttribute('data-test-sortable-refreshed', 'true');
    await parentPrompt.hover();
    await parentPrompt.locator('.prompt-manager-edit-action').click();
    await expect(page.locator('#completion_prompt_manager_popup_entry_form_name')).toHaveValue(parentPromptName);
});
