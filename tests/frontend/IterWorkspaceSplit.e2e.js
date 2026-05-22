// tests/frontend/IterWorkspaceSplit.e2e.js
import { test, expect } from '@playwright/test';

// Each existing Iter*.e2e.js redefines `awaitMainUI` inline — there's no
// shared helper module. Follow that pattern. Selector pattern below
// mirrors tests/frontend/IterationStudioAdapterSmoke.e2e.js so a future
// regression in either file is easy to spot.

async function awaitMainUI(page) {
    await page.goto('/');
    const gate = page.locator('#userList .userSelect:last-child');
    try {
        await gate.waitFor({ state: 'visible', timeout: 2000 });
        await gate.click();
    } catch { /* auto-login path */ }
    await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 0 });
}

async function ensureExtensionsDrawerOpen(page) {
    const block = page.locator('#rm_extensions_block');
    const isOpen = await block.evaluate(el => el && !el.classList.contains('closedDrawer')).catch(() => false);
    if (isOpen) return;
    await page.locator('#extensions-settings-button .drawer-toggle').first().click();
    await block.waitFor({ state: 'visible', timeout: 5000 });
}

async function ensureInlineDrawerOpen(page, hostId) {
    const host = page.locator(`#${hostId}`);
    await host.waitFor({ state: 'attached', timeout: 5000 });
    const drawer = host.locator('> .inline-drawer').first();
    const content = drawer.locator('> .inline-drawer-content');
    const isHidden = await content.evaluate(el => {
        if (!el) return true;
        const style = el.style.display;
        if (style === 'none') return true;
        if (style === 'block' || style === '') {
            const computed = window.getComputedStyle(el);
            return computed.display === 'none';
        }
        return false;
    }).catch(() => true);
    if (!isHidden) return;
    await drawer.locator('> .inline-drawer-toggle').first().click();
    await content.waitFor({ state: 'visible', timeout: 5000 });
}

// Soft-skip when the test environment has no configured connection profile —
// the iteration popup needs one to send a turn, and the smoke profile won't
// always have one. The structural assertions (split mounted, preview rendered,
// auto-apply checkbox present) run unconditionally.
async function ensureConnectionProfile(page) {
    const hasProfile = await page.evaluate(() => {
        const ctx = window.SillyTavern?.getContext?.();
        const profiles = ctx?.extensionSettings?.connectionManager?.profiles || [];
        return Array.isArray(profiles) && profiles.length > 0;
    });
    test.skip(!hasProfile, 'no connection profile configured');
}

test.describe('Iter-studio workspace split — CPA', () => {
    test.setTimeout(90000);

    test('CPA: workspace mounts with split layout + preview + auto-apply control', async ({ page }) => {
        await awaitMainUI(page);
        await ensureExtensionsDrawerOpen(page);
        await ensureInlineDrawerOpen(page, 'completion_preset_assistant_settings');

        const openBtn = page.locator('#completion_preset_assistant_open');
        await expect(openBtn).toBeVisible({ timeout: 10000 });
        await openBtn.click();

        const popup = page.locator('.cpa_it_popup.luker-iter-workspace').first();
        await expect(popup).toBeVisible({ timeout: 10000 });

        // Structural assertions: split grid + chat pane + preview pane + resizer.
        await expect(popup.locator('.luker-iter-workspace-grid')).toBeVisible();
        await expect(popup.locator('.luker-iter-workspace-chat')).toBeVisible();
        await expect(popup.locator('[data-iter-preview-pane]')).toBeVisible();
        await expect(popup.locator('.luker-iter-workspace-resizer')).toHaveCount(1);

        // Auto-apply control is mounted in the composer row, unchecked by default.
        const autoApply = popup.locator('[data-cpa-it-action="toggle-auto-apply"]');
        await expect(autoApply).toHaveCount(1);
        await expect(autoApply).not.toBeChecked();

        // Tab bar exists (display: none on desktop, but the elements are mounted).
        await expect(popup.locator('[data-iter-action="switch-tab"][data-iter-tab="chat"]')).toHaveCount(1);
        await expect(popup.locator('[data-iter-action="switch-tab"][data-iter-tab="preview"]')).toHaveCount(1);

        // Preview pane has content — at minimum the Prompts heading (or the
        // 'No preset loaded' fallback). The active locale may be en/zh-cn/zh-tw.
        const previewText = await popup.locator('[data-iter-preview-pane]').textContent();
        expect(previewText || '').toMatch(/Prompts|提示词|提示|No preset loaded|未加载|未載入/);

        // Toggle auto-apply, confirm the checkbox tracks state.
        await autoApply.check();
        await expect(autoApply).toBeChecked();
        await autoApply.uncheck();
        await expect(autoApply).not.toBeChecked();

        await page.keyboard.press('Escape');
    });

    test('CPA: send a turn, preview reflects pending change (requires connection profile)', async ({ page }) => {
        await awaitMainUI(page);
        await ensureConnectionProfile(page);

        await ensureExtensionsDrawerOpen(page);
        await ensureInlineDrawerOpen(page, 'completion_preset_assistant_settings');

        const openBtn = page.locator('#completion_preset_assistant_open');
        await openBtn.click();

        const popup = page.locator('.cpa_it_popup.luker-iter-workspace').first();
        await expect(popup).toBeVisible({ timeout: 10000 });

        await popup.locator('[data-cpa-it-input]').fill('Set temperature to 0.85');
        await popup.locator('[data-cpa-it-action="send"]').click();

        // Wait for either pending edits to surface OR the assistant to push a
        // text-only reply. Either way the preview should refresh and show some
        // signal — pending-change row, or at least the updated rendering.
        await expect(popup.locator('.cpa_it_pending')).toBeVisible({ timeout: 60000 });
        await expect(popup.locator('[data-iter-preview-pane] .pending-change')).toBeVisible({ timeout: 5000 });

        await page.keyboard.press('Escape');
    });
});
