// tests/frontend/CeaCharacterIterationSmoke.e2e.js
import { test, expect } from '@playwright/test';

test.describe('Stage 2 — CEA Character iteration module smoke', () => {
    test('ST boot does not emit pageerror or known regression strings', async ({ page }) => {
        const pageErrors = [];
        const consoleErrors = [];

        page.on('pageerror', (err) => pageErrors.push(String(err?.message || err)));
        page.on('console', (msg) => {
            if (msg.type() === 'error') consoleErrors.push(msg.text());
        });

        await page.goto('/', { waitUntil: 'domcontentloaded' });

        // Wait for ST's main script init signal. Passwordless default-user
        // setup auto-bypasses the user-select gate.
        await page.waitForFunction(() => {
            return Boolean(window.Luker?.getContext);
        }, { timeout: 30000 });

        await page.waitForTimeout(1000);

        const ceaPageErrors = pageErrors.filter(e => /character[-_ ]editor|applyPatch|could not be cloned/i.test(e));
        const ceaConsoleErrors = consoleErrors.filter(e => /character[-_ ]editor|applyPatch|duplicate export/i.test(e));

        expect(ceaPageErrors, `unexpected CEA-related pageerror(s): ${ceaPageErrors.join(' | ')}`).toEqual([]);
        expect(ceaConsoleErrors, `unexpected CEA-related console.error(s): ${ceaConsoleErrors.join(' | ')}`).toEqual([]);
    });

    test('iterationLibrary still exposes the Stage 1 surface', async ({ page }) => {
        await page.goto('/', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => Boolean(window.Luker?.getContext), { timeout: 30000 });

        const exposed = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            const lib = ctx?.iterationLibrary;
            return {
                hasApplyEdits: typeof lib?.applyEdits === 'function',
                hasInverseEdit: typeof lib?.inverseEdit === 'function',
                hasRegisterOp: typeof lib?.registerOp === 'function',
                hasRender: lib?.render && typeof lib.render.renderMessageMarkdown === 'function',
                hasRunner: lib?.runner && typeof lib.runner.requestToolCallsWithRetry === 'function',
                hasStorage: lib?.storage && typeof lib.storage.createExtensionSettingsSessionStorage === 'function',
            };
        });

        expect(exposed).toEqual({
            hasApplyEdits: true,
            hasInverseEdit: true,
            hasRegisterOp: true,
            hasRender: true,
            hasRunner: true,
            hasStorage: true,
        });
    });
});
