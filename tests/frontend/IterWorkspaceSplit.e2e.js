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

test.describe('Iter-studio workspace split — MG Schema', () => {
    test.setTimeout(90000);

    test('MG Schema: workspace mounts with split layout + preview + auto-apply control', async ({ page }) => {
        await awaitMainUI(page);
        await ensureExtensionsDrawerOpen(page);
        await ensureInlineDrawerOpen(page, 'memory_graph_settings');

        const openBtn = page.locator('#luker_rpg_memory_open_schema_studio');
        await expect(openBtn).toBeVisible({ timeout: 10000 });
        await openBtn.click();

        const popup = page.locator('.mg_schema_it_popup.luker-iter-workspace').first();
        await expect(popup).toBeVisible({ timeout: 10000 });

        // Structural assertions: split grid + chat pane + preview pane + resizer.
        await expect(popup.locator('.luker-iter-workspace-grid')).toBeVisible();
        await expect(popup.locator('.luker-iter-workspace-chat')).toBeVisible();
        await expect(popup.locator('[data-iter-preview-pane]')).toBeVisible();
        await expect(popup.locator('.luker-iter-workspace-resizer')).toHaveCount(1);

        // Auto-apply control is mounted in the composer row, unchecked by default.
        const autoApply = popup.locator('[data-mg-schema-it-action="toggle-auto-apply"]');
        await expect(autoApply).toHaveCount(1);
        await expect(autoApply).not.toBeChecked();

        // Tab bar exists (display: none on desktop, but the elements are mounted).
        await expect(popup.locator('[data-iter-action="switch-tab"][data-iter-tab="chat"]')).toHaveCount(1);
        await expect(popup.locator('[data-iter-action="switch-tab"][data-iter-tab="preview"]')).toHaveCount(1);

        // Preview pane has content — at minimum the Schema heading (or the
        // 'No schema loaded' fallback). The active locale may be en/zh-cn/zh-tw.
        const previewText = await popup.locator('[data-iter-preview-pane]').textContent();
        expect(previewText || '').toMatch(/Schema|分类|分類|No schema loaded|未加载|未載入/);

        // Toggle auto-apply, confirm the checkbox tracks state.
        await autoApply.check();
        await expect(autoApply).toBeChecked();
        await autoApply.uncheck();
        await expect(autoApply).not.toBeChecked();

        await page.keyboard.press('Escape');
    });

    test('MG Schema: send a turn, preview reflects pending change (requires connection profile)', async ({ page }) => {
        await awaitMainUI(page);
        await ensureConnectionProfile(page);

        await ensureExtensionsDrawerOpen(page);
        await ensureInlineDrawerOpen(page, 'memory_graph_settings');

        const openBtn = page.locator('#luker_rpg_memory_open_schema_studio');
        await openBtn.click();

        const popup = page.locator('.mg_schema_it_popup.luker-iter-workspace').first();
        await expect(popup).toBeVisible({ timeout: 10000 });

        await popup.locator('[data-mg-schema-it-input]').fill('Add a new column called "mood" of type string to the character category');
        await popup.locator('[data-mg-schema-it-action="send"]').click();

        // Wait for pending edits to surface. The MG sandbox-diff emits a single
        // coarse set('', newSchema) so the preview's per-category change
        // detection runs against the JSON-equality fallback path.
        await expect(popup.locator('.mg_schema_it_pending')).toBeVisible({ timeout: 60000 });
        await expect(popup.locator('[data-iter-preview-pane] .pending-change')).toBeVisible({ timeout: 5000 });

        await page.keyboard.press('Escape');
    });
});

test.describe('Iter-studio workspace split — Orchestrator', () => {
    test.setTimeout(90000);

    test('Orch: workspace mounts with split layout + composer-row auto-apply (orch_it_toolbar removed)', async ({ page }) => {
        await awaitMainUI(page);
        await ensureExtensionsDrawerOpen(page);
        await ensureInlineDrawerOpen(page, 'orchestrator_settings');

        // The orchestrator surfaces 4 mode-specific boards; whichever is
        // visible owns the working "Open AI Iteration Studio" button. Use the
        // first visible one to stay agnostic about the current execution mode.
        const openBtn = page.locator('#orchestrator_settings [data-luker-action="ai-iterate-open"]:visible').first();
        await expect(openBtn).toBeVisible({ timeout: 10000 });
        await openBtn.click();

        const popup = page.locator('.orch_it_popup.luker-iter-workspace').first();
        await expect(popup).toBeVisible({ timeout: 10000 });

        // Structural assertions: split grid + chat pane + preview pane + resizer.
        await expect(popup.locator('.luker-iter-workspace-grid')).toBeVisible();
        await expect(popup.locator('.luker-iter-workspace-chat')).toBeVisible();
        await expect(popup.locator('[data-iter-preview-pane]')).toBeVisible();
        await expect(popup.locator('.luker-iter-workspace-resizer')).toHaveCount(1);

        // The legacy `orch_it_toolbar` block (which housed the auto-apply
        // checkbox in its own row) is gone — replaced by the composer-row
        // auto-apply label.
        await expect(popup.locator('.orch_it_toolbar')).toHaveCount(0);

        // Auto-apply control is mounted in the composer row, unchecked by default.
        const autoApply = popup.locator('.orch_it_composer [data-orch-it-action="toggle-auto-apply"]');
        await expect(autoApply).toHaveCount(1);
        await expect(autoApply).not.toBeChecked();

        // Tab bar exists (display: none on desktop, but the elements are mounted).
        await expect(popup.locator('[data-iter-action="switch-tab"][data-iter-tab="chat"]')).toHaveCount(1);
        await expect(popup.locator('[data-iter-action="switch-tab"][data-iter-tab="preview"]')).toHaveCount(1);

        // Preview pane has content — at minimum a Pipeline / Loop / Agents
        // section title (depending on the active execution mode) or the
        // 'No profile loaded' fallback. The active locale may be en/zh-cn/zh-tw.
        const previewText = await popup.locator('[data-iter-preview-pane]').textContent();
        expect(previewText || '').toMatch(/Pipeline|Loop|Agents|Main|流水线|流水線|循环|循環|代理|主代理|No profile loaded|未加载|未載入/);

        // Toggle auto-apply, confirm the checkbox tracks state.
        await autoApply.check();
        await expect(autoApply).toBeChecked();
        await autoApply.uncheck();
        await expect(autoApply).not.toBeChecked();

        await page.keyboard.press('Escape');
    });

    test('Orch: send a turn, pending block surfaces (requires connection profile)', async ({ page }) => {
        await awaitMainUI(page);
        await ensureConnectionProfile(page);
        await ensureExtensionsDrawerOpen(page);
        await ensureInlineDrawerOpen(page, 'orchestrator_settings');

        const openBtn = page.locator('#orchestrator_settings [data-luker-action="ai-iterate-open"]:visible').first();
        await openBtn.click();

        const popup = page.locator('.orch_it_popup.luker-iter-workspace').first();
        await expect(popup).toBeVisible({ timeout: 10000 });

        await popup.locator('[data-orch-it-input]').fill('Add a new stage named "review" to the pipeline');
        await popup.locator('[data-orch-it-action="send"]').click();

        await expect(popup.locator('.orch_it_pending')).toBeVisible({ timeout: 60000 });

        await page.keyboard.press('Escape');
    });
});

test.describe('Iter-studio workspace split — CEA Character Iteration', () => {
    test.setTimeout(90000);

    // The CEA character iteration popup opens via the `CHARACTER_REPLACED`
    // event handler in main.js — gated on `settings.replaceLorebookSyncEnabled`
    // and the active character's avatar. There is no direct "open studio"
    // button to click, so this test synthesizes the event with the currently
    // selected character. Soft-skips if no character is loaded.
    async function ensureActiveCharacter(page) {
        const avatar = await page.evaluate(() => {
            const ctx = window.SillyTavern?.getContext?.();
            return String(ctx?.characters?.[ctx?.characterId]?.avatar || '').trim();
        });
        test.skip(!avatar, 'no active character — cannot trigger CEA char iteration popup');
        return avatar;
    }

    test('CEA Char: workspace mounts with split layout + preview + auto-apply control', async ({ page }) => {
        await awaitMainUI(page);
        const avatar = await ensureActiveCharacter(page);

        // Force-enable the setting + emit the CHARACTER_REPLACED event with
        // the current character's detail shape (matching main.js's reader:
        // `event.detail.character.avatar`).
        await page.evaluate(async (avatarId) => {
            const ctx = window.SillyTavern?.getContext?.();
            const settings = ctx?.extensionSettings?.['character-editor-assistant'];
            if (settings && typeof settings === 'object') {
                settings.replaceLorebookSyncEnabled = true;
            }
            const eventTypes = ctx?.event_types || {};
            const evtName = eventTypes.CHARACTER_REPLACED || 'character_replaced';
            const character = ctx?.characters?.find(c => String(c?.avatar) === avatarId) || { avatar: avatarId };
            // SillyTavern's eventSource.emit forwards a plain object that the
            // handler reads via event.detail.character — the CustomEvent shape
            // is the canonical wire format used by ST internals.
            const evt = new CustomEvent(evtName, { detail: { character } });
            await ctx?.eventSource?.emit?.(evtName, evt);
        }, avatar);

        const popup = page.locator('.cea_charit_popup.luker-iter-workspace').first();
        await expect(popup).toBeVisible({ timeout: 15000 });

        // Structural assertions: split grid + chat pane + preview pane + resizer.
        await expect(popup.locator('.luker-iter-workspace-grid')).toBeVisible();
        await expect(popup.locator('.luker-iter-workspace-chat')).toBeVisible();
        await expect(popup.locator('[data-iter-preview-pane]')).toBeVisible();
        await expect(popup.locator('.luker-iter-workspace-resizer')).toHaveCount(1);

        // Auto-apply control is mounted in the composer row, unchecked by default.
        const autoApply = popup.locator('[data-cea-charit-action="toggle-auto-apply"]');
        await expect(autoApply).toHaveCount(1);
        await expect(autoApply).not.toBeChecked();

        // Tab bar exists (display: none on desktop, but the elements are mounted).
        await expect(popup.locator('[data-iter-action="switch-tab"][data-iter-tab="chat"]')).toHaveCount(1);
        await expect(popup.locator('[data-iter-action="switch-tab"][data-iter-tab="preview"]')).toHaveCount(1);

        // Preview pane has content — at minimum the Character fields heading
        // (or the 'No character loaded' fallback). Active locale may be en/zh-cn/zh-tw.
        const previewText = await popup.locator('[data-iter-preview-pane]').textContent();
        expect(previewText || '').toMatch(/Character fields|角色字段|角色欄位|No character loaded|未加载|未載入/);

        // Toggle auto-apply, confirm the checkbox tracks state.
        await autoApply.check();
        await expect(autoApply).toBeChecked();
        await autoApply.uncheck();
        await expect(autoApply).not.toBeChecked();

        await page.keyboard.press('Escape');
    });

    test('CEA Char: send a turn, preview reflects pending change (requires connection profile)', async ({ page }) => {
        await awaitMainUI(page);
        await ensureConnectionProfile(page);
        const avatar = await ensureActiveCharacter(page);

        await page.evaluate(async (avatarId) => {
            const ctx = window.SillyTavern?.getContext?.();
            const settings = ctx?.extensionSettings?.['character-editor-assistant'];
            if (settings && typeof settings === 'object') {
                settings.replaceLorebookSyncEnabled = true;
            }
            const eventTypes = ctx?.event_types || {};
            const evtName = eventTypes.CHARACTER_REPLACED || 'character_replaced';
            const character = ctx?.characters?.find(c => String(c?.avatar) === avatarId) || { avatar: avatarId };
            const evt = new CustomEvent(evtName, { detail: { character } });
            await ctx?.eventSource?.emit?.(evtName, evt);
        }, avatar);

        const popup = page.locator('.cea_charit_popup.luker-iter-workspace').first();
        await expect(popup).toBeVisible({ timeout: 15000 });

        await popup.locator('[data-cea-charit-input]').fill('Add to the character description that she has bright green eyes.');
        await popup.locator('[data-cea-charit-action="send"]').click();

        // Wait for pending edits to surface — CEA char emits fine-grained
        // `card.<field>` edits, so the preview's per-field change detection
        // runs against applyEdits directly (no empty-path fallback needed).
        await expect(popup.locator('.cea_charit_pending')).toBeVisible({ timeout: 60000 });
        await expect(popup.locator('[data-iter-preview-pane] .pending-change')).toBeVisible({ timeout: 5000 });

        await page.keyboard.press('Escape');
    });
});

test.describe('Iter-studio workspace split — CEA Editor', () => {
    test.setTimeout(90000);

    test('CEA Editor: workspace mounts with split layout + world book viewer + composer-row auto-apply', async ({ page }) => {
        await awaitMainUI(page);
        await ensureExtensionsDrawerOpen(page);
        await ensureInlineDrawerOpen(page, 'character_editor_assistant_settings');

        const openBtn = page.locator('#cea_open_editor_popup');
        await expect(openBtn).toBeVisible({ timeout: 10000 });
        await openBtn.click();

        const popup = page.locator('.cea_sync_popup.luker-iter-workspace').first();
        await expect(popup).toBeVisible({ timeout: 15000 });

        // Structural assertions: split grid + chat pane + preview pane + resizer.
        await expect(popup.locator('.luker-iter-workspace-grid')).toBeVisible();
        await expect(popup.locator('.luker-iter-workspace-chat')).toBeVisible();
        await expect(popup.locator('[data-iter-preview-pane]')).toBeVisible();
        await expect(popup.locator('.luker-iter-workspace-resizer')).toHaveCount(1);

        // Auto-apply control is mounted in the composer row, unchecked by default.
        // The CEA editor uses its own naming convention (`-auto-approve` instead
        // of `-action="toggle-auto-apply"`) because the underlying flow approves
        // a *batch* of operations, not edits.
        const autoApply = popup.locator('[data-cea-editor-auto-approve]');
        await expect(autoApply).toHaveCount(1);

        // Tab bar exists (display: none on desktop, but the elements are mounted).
        await expect(popup.locator('[data-iter-action="switch-tab"][data-iter-tab="chat"]')).toHaveCount(1);
        await expect(popup.locator('[data-iter-action="switch-tab"][data-iter-tab="preview"]')).toHaveCount(1);

        // Preview pane content — either the World book section header (if the
        // active character has a bound lorebook) or the unbound fallback.
        // Active locale may be en/zh-cn/zh-tw.
        const previewText = await popup.locator('[data-iter-preview-pane]').textContent();
        expect(previewText || '').toMatch(/World book|世界书|世界書|No world book|未绑定|未綁定/);

        // Toggle auto-apply, confirm the checkbox tracks state.
        await autoApply.check();
        await expect(autoApply).toBeChecked();
        await autoApply.uncheck();
        await expect(autoApply).not.toBeChecked();

        await page.keyboard.press('Escape');
    });

    test('CEA Editor: send a turn, pending block surfaces (requires connection profile)', async ({ page }) => {
        await awaitMainUI(page);
        await ensureConnectionProfile(page);
        await ensureExtensionsDrawerOpen(page);
        await ensureInlineDrawerOpen(page, 'character_editor_assistant_settings');

        const openBtn = page.locator('#cea_open_editor_popup');
        await openBtn.click();

        const popup = page.locator('.cea_sync_popup.luker-iter-workspace').first();
        await expect(popup).toBeVisible({ timeout: 15000 });

        await popup.locator('[data-cea-editor-input]').fill('Add a brief lorebook entry about a forest.');
        await popup.locator('[data-cea-editor-send]').click();

        // The pending block appears when the LLM responds with operations
        // ready for approval. Use a wide timeout because the editor calls
        // tools sequentially per round.
        await expect(popup.locator('[data-cea-editor-pending]')).not.toBeEmpty({ timeout: 60000 });

        await page.keyboard.press('Escape');
    });
});

test.describe('Iter-studio workspace — mobile tab layout', () => {
    // Pure layout test — uses CPA because it always mounts the workspace
    // shell and the only dependency is opening the popup. No LLM, no
    // connection profile, no character — runs on any env with Playwright.
    test('CPA at 360px viewport: tab bar visible, Chat default, switch to Preview works', async ({ page }) => {
        await page.setViewportSize({ width: 360, height: 740 });
        await awaitMainUI(page);

        await ensureExtensionsDrawerOpen(page);
        await ensureInlineDrawerOpen(page, 'completion_preset_assistant_settings');

        const openBtn = page.locator('#completion_preset_assistant_open');
        await expect(openBtn).toBeVisible({ timeout: 10000 });
        await openBtn.click();

        const popup = page.locator('.cpa_it_popup.luker-iter-workspace').first();
        await expect(popup).toBeVisible({ timeout: 10000 });

        // Tab bar surfaces only on viewports < 900px.
        const tabBar = popup.locator('.luker-iter-workspace-tabs');
        await expect(tabBar).toBeVisible();

        // Initial state: data-iter-active-tab="chat", chat tab marked active.
        await expect(popup).toHaveAttribute('data-iter-active-tab', 'chat');
        const chatTab = popup.locator('[data-iter-action="switch-tab"][data-iter-tab="chat"]');
        const previewTab = popup.locator('[data-iter-action="switch-tab"][data-iter-tab="preview"]');
        await expect(chatTab).toHaveClass(/active/);
        await expect(previewTab).not.toHaveClass(/active/);

        await expect(popup.locator('[data-iter-pane="chat"]')).toBeVisible();
        await expect(popup.locator('[data-iter-pane="preview"]')).toBeHidden();

        // Resizer is desktop-only — hidden on mobile via @media (max-width: 900px).
        await expect(popup.locator('.luker-iter-workspace-resizer')).toBeHidden();

        // Touch target for the auto-apply label must be at least 44x44 px
        // (the CSS in section 24 enforces min-height: 44px on the label).
        const autoApply = popup.locator('[data-cpa-it-action="toggle-auto-apply"]');
        await expect(autoApply).toBeVisible();
        const autoApplyLabel = popup.locator('.cpa_it_composer_auto_apply');
        const labelBox = await autoApplyLabel.boundingBox();
        expect(labelBox).not.toBeNull();
        expect(labelBox.height).toBeGreaterThanOrEqual(44);

        // Switch to Preview: dataset attr updates, classes flip, panes swap.
        await previewTab.click();
        await expect(popup).toHaveAttribute('data-iter-active-tab', 'preview');
        await expect(previewTab).toHaveClass(/active/);
        await expect(chatTab).not.toHaveClass(/active/);
        await expect(popup.locator('[data-iter-pane="preview"]')).toBeVisible();
        await expect(popup.locator('[data-iter-pane="chat"]')).toBeHidden();

        // Switch back.
        await chatTab.click();
        await expect(popup.locator('[data-iter-pane="chat"]')).toBeVisible();

        await page.keyboard.press('Escape');
    });
});
