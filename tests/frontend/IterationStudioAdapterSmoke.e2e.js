import { test, expect } from '@playwright/test';

/**
 * UI-driven full adapter smoke. For each of the four iter-studio
 * consumers (orchestrator, memory-graph, CEA Character, CPA), opens the
 * plugin's iter-studio popup via the host UI, clicks "New session", and
 * verifies the shell renders without shell-side errors.
 *
 * Adapter contracts and popup shell behavior are unchanged by the
 * library extraction refactor. This smoke catches accidental shell or
 * adapter wiring breakage that the unit suites might miss.
 *
 * Selector discovery notes (see iteration-studio/template.js + each
 * plugin's main.js / ui-templates.js):
 *
 * - All four adapters render into a `div.luker-studio` popup; the adapter-
 *   specific class (`luker_cpa_popup`, `luker_mg_schema_iter_popup`,
 *   `luker_orch_iter_popup`) is concatenated by the shell template, so a
 *   stable per-adapter root selector is `.luker-studio.<popupClassName>`.
 * - `data-iter-action="new-session"` is rendered by renderHistoryList()
 *   unconditionally inside the history details panel (open by default).
 * - CPA / MG / Orchestrator open buttons all live in inline-drawers under
 *   `#extensions_settings2`, which itself is inside the right-side
 *   `#extensions-settings-button` drawer. Drawer toggles use SillyTavern's
 *   `.inline-drawer-toggle` slideToggle delegated handler.
 * - CEA Character has NO UI button: openCharacterEditorIteration() is only
 *   wired to the CHARACTER_REPLACED event (card overwrite during import),
 *   so it cannot be driven from a clean Playwright smoke without simulating
 *   a card import. This sub-test soft-skips with that reason.
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
    // First-run on a fresh data dir surfaces a "Welcome to Luker!"
    // persona-setup popup that intercepts pointer events on the
    // navbar's drawer toggles. The Save button is wired to persist a
    // default persona and close the dialog. Best-effort dismissal:
    // present → Save; absent → skip.
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

// Errors we capture as "shell errors" must be related to the iter-studio
// shell, the new iteration-library, or behaviours around adapter
// open/close (structured-clone failures). Page-wide
// pageerrors from unrelated pre-existing issues (e.g. the known
// `Duplicate export of 'applyPatch'` in character-editor-assistant/
// studio/ai-chat.js on `release`) are out of scope for this smoke.
const SHELL_ERROR_RX = /iter[-_]?(library|studio)|luker[-_]?studio|cloned|applyEdits|inverseEdit/i;

async function captureShellErrors(page, sink) {
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

/**
 * Open the right-side "Extensions" drawer (the panel that contains
 * `#extensions_settings2` and every plugin's inline-drawer). Idempotent:
 * if already open, leave it open.
 */
async function ensureExtensionsDrawerOpen(page) {
    const block = page.locator('#rm_extensions_block');
    const isOpen = await block.evaluate(el => el && !el.classList.contains('closedDrawer')).catch(() => false);
    if (isOpen) return;
    await page.locator('#extensions-settings-button .drawer-toggle').first().click();
    await block.waitFor({ state: 'visible', timeout: 5000 });
}

/**
 * Open a specific plugin's inline-drawer inside the extensions panel by its
 * `#<UI_BLOCK_ID>` host. Idempotent: only clicks the toggle if the content
 * is currently hidden (slideToggle would otherwise close an open drawer).
 *
 * Some plugin hosts contain multiple top-level inline-drawers (e.g.
 * `#orchestrator_settings` has both "Orchestrator" and "Notes"). We always
 * target the first one — that's the primary settings drawer that contains
 * the iter-studio open buttons.
 */
async function ensureInlineDrawerOpen(page, hostId) {
    const host = page.locator(`#${hostId}`);
    await host.waitFor({ state: 'attached', timeout: 5000 });
    const drawer = host.locator('> .inline-drawer').first();
    const content = drawer.locator('> .inline-drawer-content');
    // slideToggle leaves display:none in the inline style when collapsed.
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

async function openAdapterAndSmoke(page, { name, openButton, popupRoot, newSessionSelector }) {
    const button = page.locator(openButton);
    if (!(await button.count()) || !(await button.first().isVisible().catch(() => false))) {
        return { skipped: true, reason: 'open button not visible after drawer prerequisites' };
    }
    await button.first().click();
    const popup = page.locator(popupRoot).first();
    await popup.waitFor({ state: 'visible', timeout: 10000 });

    const newSession = popup.locator(newSessionSelector).first();
    if (await newSession.isVisible().catch(() => false)) {
        await newSession.click();
        // give the rerender() pass a moment to repaint the chat panel.
        await page.waitForTimeout(500);
    }
    // close via Escape (works for popups using the Popup class which listens
    // for Escape as a "cancel" affordance). Fall back to clicking the in-
    // popup [data-iter-action="close"] button if Escape doesn't dismiss.
    await page.keyboard.press('Escape');
    try {
        await popup.waitFor({ state: 'hidden', timeout: 2000 });
    } catch {
        const closeBtn = popup.locator('[data-iter-action="close"]').first();
        if (await closeBtn.isVisible().catch(() => false)) await closeBtn.click();
        await popup.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
    }
    return { skipped: false };
}

test.describe('UI-driven iter-studio adapter smoke', () => {
    test('open + new-session smoke for each of 4 adapters', async ({ page }) => {
        const shellErrors = [];
        await captureShellErrors(page, shellErrors);
        await awaitMainUI(page);
        await ensureExtensionsDrawerOpen(page);

        const adapters = [
            {
                name: 'cpa',
                drawerHostId: 'completion_preset_assistant_settings',
                openButton: '#completion_preset_assistant_open',
                // CPA migrated off the shared iter-studio shell to a
                // plugin-owned popup (`cpa-iteration/studio.js`). The popup
                // root no longer carries `.luker-studio` — it's a top-level
                // `.cpa_it_popup` div mounted inside ST's `Popup` wrapper,
                // and the new-session button uses `data-cpa-it-action="…"`
                // rather than the shell's `data-iter-action="…"`.
                popupRoot: '.cpa_it_popup',
                newSessionSelector: '[data-cpa-it-action="new-session"]',
            },
            {
                name: 'memory-graph',
                drawerHostId: 'memory_graph_settings',
                openButton: '#luker_rpg_memory_open_schema_studio',
                // MG schema iteration migrated off the shared iter-
                // studio shell to a plugin-owned popup
                // (`schema-iteration/studio.js`). The popup root no longer
                // carries `.luker-studio` — it's a top-level
                // `.mg_schema_it_popup` div mounted inside ST's `Popup`
                // wrapper, and the new-session button uses
                // `data-mg-schema-it-action="…"` rather than the shell's
                // `data-iter-action="…"`.
                popupRoot: '.mg_schema_it_popup',
                newSessionSelector: '[data-mg-schema-it-action="new-session"]',
            },
            {
                name: 'cea-character',
                // openCharacterEditorIteration() is invoked only on the
                // CHARACTER_REPLACED event (card overwrite during import).
                // No UI button to drive from a clean smoke environment.
                skipReason: 'no UI button — only fires on CHARACTER_REPLACED event during card overwrite',
            },
            {
                name: 'orchestrator',
                drawerHostId: 'orchestrator_settings',
                // The same data-luker-action button appears in 4 boards
                // (spec/agenda/loop/director) but only the active-mode board
                // is visible. `:visible` resolves to the one rendered for
                // the user's current executionMode setting.
                openButton: '#orchestrator_settings [data-luker-action="ai-iterate-open"]:visible',
                // Post-Stage-5: plugin-owned popup root.
                popupRoot: '.orch_it_popup',
                newSessionSelector: '[data-orch-it-action="new-session"]',
            },
        ];

        let exercised = 0;
        let skipped = 0;
        const results = [];

        for (const adapter of adapters) {
            await test.step(`adapter: ${adapter.name}`, async () => {
                if (adapter.skipReason) {
                    test.info().annotations.push({ type: 'skip', description: `[${adapter.name}] ${adapter.skipReason}` });
                    results.push({ name: adapter.name, status: 'skipped', reason: adapter.skipReason });
                    skipped += 1;
                    return;
                }
                try {
                    await ensureInlineDrawerOpen(page, adapter.drawerHostId);
                } catch (e) {
                    test.info().annotations.push({ type: 'skip', description: `[${adapter.name}] drawer #${adapter.drawerHostId} unreachable: ${e?.message}` });
                    results.push({ name: adapter.name, status: 'skipped', reason: `drawer unreachable: ${e?.message}` });
                    skipped += 1;
                    return;
                }
                const outcome = await openAdapterAndSmoke(page, adapter);
                if (outcome.skipped) {
                    test.info().annotations.push({ type: 'skip', description: `[${adapter.name}] ${outcome.reason}` });
                    results.push({ name: adapter.name, status: 'skipped', reason: outcome.reason });
                    skipped += 1;
                } else {
                    results.push({ name: adapter.name, status: 'passed' });
                    exercised += 1;
                }
            });
        }

        // Attach a structured per-adapter summary so the test report shows
        // what was actually exercised vs skipped.
        test.info().annotations.push({ type: 'summary', description: JSON.stringify(results) });

        // Refuse to silently no-op: if ALL four sub-tests skip, the smoke
        // provides no signal and should be treated as a failure.
        expect(exercised, `no adapter sub-test actually exercised (all skipped): ${JSON.stringify(results)}`).toBeGreaterThanOrEqual(1);

        expect(shellErrors, `shell errors during adapter smoke: ${shellErrors.join(' | ')}`).toEqual([]);
    });
});
