// tests/frontend/IterWorkspaceSplit.e2e.js
import { test, expect } from '@playwright/test';

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
            return window.getComputedStyle(el).display === 'none';
        }
        return false;
    }).catch(() => true);
    if (!isHidden) return;
    await drawer.locator('> .inline-drawer-toggle').first().click();
    await content.waitFor({ state: 'visible', timeout: 5000 });
}

async function closeWorkbenchIfOpen(page) {
    const win = page.locator('.wbench .wb-win').first();
    if (await win.isVisible().catch(() => false)) {
        const closeBtn = win.locator('.wb-titlebar .is-close').first();
        if (await closeBtn.isVisible().catch(() => false)) {
            await closeBtn.click();
        } else {
            await page.keyboard.press('Alt+w');
        }
        await expect(win).toBeHidden({ timeout: 10_000 });
    }
}

async function ensureAnyCharacterSelected(page) {
    const hasChar = await page.evaluate(() => {
        const ctx = window.Luker?.getContext?.();
        return Boolean(ctx?.characters?.[ctx?.characterId]?.avatar);
    });
    if (hasChar) return;
    const drawer = page.locator('#rightNavDrawerIcon');
    if (await drawer.evaluate(el => el.classList.contains('closedIcon')).catch(() => true)) {
        await drawer.click();
    }
    const listVisible = await page.locator('#rm_print_characters_block:visible').count().catch(() => 0);
    if (!listVisible) {
        await page.locator('#rm_button_characters').click();
    }
    const firstCard = page.locator('#rm_print_characters_block .character_select').first();
    await firstCard.waitFor({ state: 'visible', timeout: 10_000 });
    await firstCard.click();
    await page.waitForFunction(() => {
        const ctx = window.Luker?.getContext?.();
        return Boolean(ctx?.characters?.[ctx?.characterId]?.avatar);
    }, { timeout: 10_000 });
    await page.evaluate(() => document.querySelector('#rightNavHolder > .drawer-toggle')?.click());
}

async function openWorkbenchIterate(page, targetDotClass) {
    const pill = page.locator('.wbench > button.wb-pill').first();
    const win = page.locator('.wbench .wb-win').first();
    if (!(await win.isVisible().catch(() => false))) {
        await expect(pill).toBeVisible({ timeout: 15_000 });
        await pill.click();
        await expect(win).toBeVisible({ timeout: 15_000 });
    }

    const aiTab = win.locator('.wb-rail button.wb-tab').filter({ hasText: /AI iteration|AI 迭代/i }).first();
    await expect(aiTab).toBeVisible({ timeout: 10_000 });
    await aiTab.click();

    const TARGET_RX = {
        preset: /^(Preset|预设|預設)$/i,
        'wb-t-preset': /^(Preset|预设|預設)$/i,
        memory: /^(Memory graph|记忆图|記憶圖)$/i,
        'wb-t-memory': /^(Memory graph|记忆图|記憶圖)$/i,
        orch: /^(Orchestration|编排|編排)$/i,
        'wb-t-orch': /^(Orchestration|编排|編排)$/i,
        card: /^(Character card|角色卡)$/i,
        'wb-t-card': /^(Character card|角色卡)$/i,
    };
    if (targetDotClass) {
        const targetBtn = win.locator('.wb-ws-seg button.lw-seg-btn').filter({
            hasText: TARGET_RX[targetDotClass],
        }).first();
        await expect(targetBtn).toBeVisible({ timeout: 10_000 });
        await targetBtn.click();
        await expect(targetBtn).toHaveAttribute('aria-pressed', 'true', { timeout: 5000 });
    }
    return win;
}

async function ensureConnectionProfileConfiguredInSettings(page) {
    const win = await openWorkbenchIterate(page);
    const settingsTab = win.locator('.wb-rail button.wb-tab').filter({ hasText: /^Settings$|^设置$/i }).first();
    await expect(settingsTab).toBeVisible({ timeout: 10_000 });
    await settingsTab.click();

    const apiSelect = win.locator('table.wb-api tbody tr').first().locator('select').first();
    await expect(apiSelect).toBeVisible({ timeout: 10_000 });
    const optCount = await apiSelect.locator('option').count();
    expect(optCount, 'PW_INCLUDE_INTEGRATION run requires at least one connection profile in the integration data dir').toBeGreaterThan(1);
}

test.describe('Unified Workbench split workspace — CPA (preset target)', () => {
    test.setTimeout(90000);

    test('CPA: bridge button opens Workbench preset workspace with split layout + composer + suggestions', async ({ page }) => {
        await awaitMainUI(page);
        await ensureExtensionsDrawerOpen(page);
        await ensureInlineDrawerOpen(page, 'completion_preset_assistant_settings');

        const openBtn = page.locator('#completion_preset_assistant_open');
        await expect(openBtn).toBeVisible({ timeout: 10000 });
        await openBtn.click();

        const win = page.locator('.wbench .wb-win').first();
        await expect(win).toBeVisible({ timeout: 10000 });

        await expect(win.locator('.wb-page.is-split')).toBeVisible();
        await expect(win.locator('aside.wb-sess')).toBeVisible();
        await expect(win.locator('section.wb-chat')).toBeVisible();
        await expect(win.locator('.wb-ws-seg .lw-seg-btn[aria-pressed="true"]').filter({ hasText: /^(Preset|预设|預設)$/i })).toBeVisible();
        await expect(win.locator('.wb-scope-seg')).toBeVisible();

        const chatText = await win.locator('.wb-chat-body').textContent();
        expect(chatText || '').toMatch(/Preset|预设|Edit|修改|No edit target|Open a preset/i);

        await closeWorkbenchIfOpen(page);
    });

    test('CPA: send a turn in preset target surfaces assistant reply or pending change list', async ({ page }) => {
        await awaitMainUI(page);
        await ensureConnectionProfileConfiguredInSettings(page);

        const win = await openWorkbenchIterate(page, 'wb-t-preset');
        const input = win.locator('.wb-composer textarea.wb-input').first();
        await expect(input).toBeVisible({ timeout: 10000 });
        await input.fill('Set temperature to 0.85');
        await win.locator('.wb-composer button.wb-send').first().click();

        await expect(win.locator('.wb-chg.is-pending, .wb-msg-ai').first()).toBeVisible({ timeout: 60000 });
        await closeWorkbenchIfOpen(page);
    });
});

test.describe('Unified Workbench split workspace — MG Schema (memory target)', () => {
    test.setTimeout(90000);

    test('MG Schema: Workbench memory target mounts split layout + scope selector + composer', async ({ page }) => {
        await awaitMainUI(page);
        const win = await openWorkbenchIterate(page, 'wb-t-memory');

        await expect(win.locator('.wb-page.is-split')).toBeVisible();
        await expect(win.locator('aside.wb-sess')).toBeVisible();
        await expect(win.locator('section.wb-chat')).toBeVisible();
        await expect(win.locator('.wb-scope-seg')).toBeVisible();

        const chatText = await win.locator('.wb-chat-body').textContent();
        expect(chatText || '').toMatch(/Memory graph|记忆图|記憶圖/i);

        await closeWorkbenchIfOpen(page);
    });

    test('MG Schema: send a turn in memory target surfaces assistant reply or pending change list', async ({ page }) => {
        await awaitMainUI(page);
        await ensureConnectionProfileConfiguredInSettings(page);

        const win = await openWorkbenchIterate(page, 'wb-t-memory');
        const input = win.locator('.wb-composer textarea.wb-input').first();
        await expect(input).toBeVisible({ timeout: 10000 });
        await input.fill('Add a new column called "mood" of type string to the character category');
        await win.locator('.wb-composer button.wb-send').first().click();

        await expect(win.locator('.wb-chg.is-pending, .wb-msg-ai').first()).toBeVisible({ timeout: 60000 });
        await closeWorkbenchIfOpen(page);
    });
});

test.describe('Unified Workbench split workspace — Orchestrator (orch target)', () => {
    test.setTimeout(90000);

    test('Orch: Orchestra Lens AI button opens Workbench orch target with split layout', async ({ page }) => {
        await awaitMainUI(page);
        const win = await openWorkbenchIterate(page);

        const orchTab = win.locator('.wb-rail button.wb-tab').filter({ hasText: /Orchestration|编排/i }).first();
        await expect(orchTab).toBeVisible({ timeout: 10000 });
        await orchTab.click();

        const lens = win.locator('.olens.ol-lens').first();
        await expect(lens).toBeVisible({ timeout: 10000 });
        const setupBtn = lens.locator('.ol-viewswitch .lw-seg-btn').filter({ hasText: /^(Setup|准备阶段|準備階段|配置)$/i }).first();
        await setupBtn.click();

        const openAiBtn = lens.locator('.ol-setup-bar button').filter({ hasText: /Open AI Iteration Studio|打开 AI 迭代/i }).first();
        await expect(openAiBtn).toBeVisible({ timeout: 10000 });
        await openAiBtn.click();

        await expect(win.locator('.wb-page.is-split')).toBeVisible();
        await expect(win.locator('.wb-ws-seg .lw-seg-btn[aria-pressed="true"]').filter({ hasText: /^(Orchestration|编排|編排)$/i })).toBeVisible({ timeout: 10000 });

        await closeWorkbenchIfOpen(page);
    });

    test('Orch: send a turn in orch target surfaces assistant reply or pending change list', async ({ page }) => {
        await awaitMainUI(page);
        await ensureConnectionProfileConfiguredInSettings(page);

        const win = await openWorkbenchIterate(page, 'wb-t-orch');
        const input = win.locator('.wb-composer textarea.wb-input').first();
        await expect(input).toBeVisible({ timeout: 10000 });
        await input.fill('Add a new stage named "review" to the pipeline');
        await win.locator('.wb-composer button.wb-send').first().click();

        await expect(win.locator('.wb-chg.is-pending, .wb-msg-ai').first()).toBeVisible({ timeout: 60000 });
        await closeWorkbenchIfOpen(page);
    });
});

test.describe('Unified Workbench split workspace — CEA Card (card target)', () => {
    test.setTimeout(90000);

    test('CEA Card: bridge button opens Workbench card target and handles character state', async ({ page }) => {
        await awaitMainUI(page);
        await ensureAnyCharacterSelected(page);
        await ensureExtensionsDrawerOpen(page);
        await ensureInlineDrawerOpen(page, 'character_editor_assistant_settings');

        const openBtn = page.locator('#cea_open_editor_popup');
        await expect(openBtn).toBeVisible({ timeout: 10000 });
        await openBtn.click();

        const win = page.locator('.wbench .wb-win').first();
        await expect(win).toBeVisible({ timeout: 10000 });
        await expect(win.locator('.wb-page.is-split')).toBeVisible();
        await expect(win.locator('.wb-ws-seg .lw-seg-btn[aria-pressed="true"]').filter({ hasText: /^(Character card|角色卡)$/i })).toBeVisible({ timeout: 10000 });
        await expect(win.locator('.wb-composer textarea.wb-input')).toBeVisible();
        await expect(win.locator('.wb-composer button.wb-send')).toBeVisible();

        await closeWorkbenchIfOpen(page);
    });
});

test.describe('Unified Workbench — mobile compact layout', () => {
    test('at 360px viewport: .is-compact applies, session drawer toggles over split chat', async ({ page }) => {
        await page.setViewportSize({ width: 360, height: 740 });
        await awaitMainUI(page);

        await ensureExtensionsDrawerOpen(page);
        await ensureInlineDrawerOpen(page, 'completion_preset_assistant_settings');

        const openBtn = page.locator('#completion_preset_assistant_open');
        await expect(openBtn).toBeVisible({ timeout: 10000 });
        await openBtn.click();

        const root = page.locator('.wbench').first();
        await expect(root).toHaveClass(/\bis-compact\b/, { timeout: 10000 });

        const win = root.locator('.wb-win').first();
        await expect(win).toBeVisible();

        // Session list drawer is collapsed on mobile by default; toggle button opens it.
        const sessDrawer = win.locator('aside.wb-sess');
        await expect(sessDrawer).toBeHidden();

        const sessToggle = win.locator('.wb-chat-head button.wb-src-toggle').first();
        await expect(sessToggle).toBeVisible();
        await sessToggle.click();
        await expect(sessDrawer).toHaveClass(/\bis-open\b/);
        await expect(sessDrawer).toBeVisible();

        // Close session drawer overlay and verify main chat body + composer stay usable.
        await sessDrawer.locator('.wb-sess-head button[aria-label="Off"], .wb-sess-head button[title="Off"], .wb-sess-head button').last().click();
        await expect(sessDrawer).toBeHidden();
        await expect(win.locator('.wb-chat-body')).toBeVisible();

        await closeWorkbenchIfOpen(page);
    });
});
