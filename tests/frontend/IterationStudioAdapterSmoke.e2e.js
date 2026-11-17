import { test, expect } from '@playwright/test';

/**
 * UI-driven full Workbench target smoke. Opens Unified Workbench from its entry
 * surfaces, switches across every registered AI Iteration target (`preset`, `card`,
 * `world`, `memory`, `orch`), starts a new session (`New conversation`), and verifies
 * zero Workbench / Lens / Iteration shell console or uncaught errors.
 */

async function awaitMainUI(page) {
    await page.goto('/');
    const gate = page.locator('#userList .userSelect:last-child');
    try {
        await gate.waitFor({ state: 'visible', timeout: 2000 });
        await gate.click();
        await page.waitForURL('http://127.0.0.1:8000');
    } catch { /* auto-login path */ }
    await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 0 });

    try {
        const welcomeSave = page.locator('dialog.popup .popup-button-ok').first();
        await welcomeSave.waitFor({ state: 'visible', timeout: 1500 });
        await welcomeSave.click();
        await page.waitForFunction(
            () => !document.querySelector('dialog.popup[open]'),
            { timeout: 5000 },
        );
    } catch { /* already configured */ }
}

const SHELL_ERROR_RX = /workbench|iter[-_]?(library|studio)|lens|cloned|applyEdits|inverseEdit/i;

function captureShellErrors(page, sink) {
    page.on('console', (msg) => {
        if (msg.type() !== 'error') return;
        const text = msg.text();
        if (SHELL_ERROR_RX.test(text)) {
            sink.push(`[console:${msg.location().url || '?'}] ${text}`);
        }
    });
    page.on('pageerror', (err) => {
        const text = err?.message || String(err);
        if (SHELL_ERROR_RX.test(text)) {
            sink.push(`[pageerror] ${text}`);
        }
    });
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

async function closeWorkbench(page) {
    const win = page.locator('.wbench .wb-win').first();
    if (!(await win.isVisible().catch(() => false))) return;
    const closeBtn = win.locator('.wb-titlebar .is-close').first();
    if (await closeBtn.isVisible().catch(() => false)) {
        await closeBtn.click();
    } else {
        await page.keyboard.press('Alt+w');
    }
    await expect(win).toBeHidden({ timeout: 5000 });
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

test.describe('UI-driven Workbench iterate-target smoke', () => {
    test('open + switch + new-session smoke across Workbench targets', async ({ page }) => {
        const shellErrors = [];
        captureShellErrors(page, shellErrors);
        await awaitMainUI(page);
        await ensureAnyCharacterSelected(page);

        const win = page.locator('.wbench .wb-win').first();

        // 1. Entry bridge buttons from CPA & CEA drawers open the corresponding target inside Workbench.
        const drawerBridges = [
            {
                name: 'cpa-bridge',
                drawerHostId: 'completion_preset_assistant_settings',
                openButton: '#completion_preset_assistant_open',
                expectedLabel: /^(Preset|预设|預設)$/i,
            },
            {
                name: 'cea-bridge',
                drawerHostId: 'character_editor_assistant_settings',
                openButton: '#cea_open_editor_popup',
                expectedLabel: /^(Character card|角色卡)$/i,
            },
        ];

        for (const bridge of drawerBridges) {
            await test.step(`bridge: ${bridge.name}`, async () => {
                await ensureExtensionsDrawerOpen(page);
                await ensureInlineDrawerOpen(page, bridge.drawerHostId);
                const btn = page.locator(bridge.openButton).first();
                await expect(btn).toBeVisible({ timeout: 10000 });
                await btn.click();
                await expect(win).toBeVisible({ timeout: 10000 });
                await expect(win.locator('.wb-ws-seg .lw-seg-btn[aria-pressed="true"]').filter({ hasText: bridge.expectedLabel })).toBeVisible({ timeout: 5000 });
                await closeWorkbench(page);
            });
        }

        // 2. Open Workbench via floating `.wb-pill`, switch to AI iteration, and exercise all registered `.wb-ws-seg` targets + New conversation.
        const pill = page.locator('.wbench > button.wb-pill').first();
        await expect(pill).toBeVisible({ timeout: 10000 });
        await pill.click();
        await expect(win).toBeVisible({ timeout: 10000 });

        const aiTab = win.locator('.wb-rail button.wb-tab').filter({ hasText: /AI iteration|AI 迭代/i }).first();
        await aiTab.click();

        const targetButtons = win.locator('.wb-ws-seg button.lw-seg-btn');
        const targetCount = await targetButtons.count();
        expect(targetCount, 'Workbench AI Iteration must register multiple workspace targets').toBeGreaterThanOrEqual(3);

        for (let i = 0; i < targetCount; i++) {
            const btn = targetButtons.nth(i);
            const label = ((await btn.textContent()) || `target-${i}`).trim();
            await test.step(`workbench-target: ${label}`, async () => {
                await btn.click();
                await expect(btn).toHaveAttribute('aria-pressed', 'true', { timeout: 5000 });
                const newConv = win.locator('aside.wb-sess .wb-sess-head button').first();
                if (await newConv.isVisible().catch(() => false) && await newConv.isEnabled().catch(() => false)) {
                    await newConv.click();
                }
                await page.waitForTimeout(200);
            });
        }

        // 3. Also verify embedded Memory Graph and Orchestration workspaces mount cleanly without errors.
        for (const tabRx of [/Memory graph|记忆图|記憶圖/i, /Orchestration|编排/i]) {
            const tab = win.locator('.wb-rail button.wb-tab').filter({ hasText: tabRx }).first();
            await expect(tab).toBeVisible({ timeout: 5000 });
            await tab.click();
            await page.waitForTimeout(200);
        }

        await closeWorkbench(page);
        expect(shellErrors, `shell errors during Workbench target smoke: ${shellErrors.join(' | ')}`).toEqual([]);
    });
});
