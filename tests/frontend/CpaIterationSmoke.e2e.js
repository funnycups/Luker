// tests/frontend/CpaIterationSmoke.e2e.js
import { test, expect } from '@playwright/test';

test.describe('Stage 3 — CPA iteration module smoke', () => {
    test('ST boot does not emit pageerror or known regression strings', async ({ page }) => {
        const pageErrors = [];
        const consoleErrors = [];

        page.on('pageerror', (err) => pageErrors.push(String(err?.message || err)));
        page.on('console', (msg) => {
            if (msg.type() === 'error') consoleErrors.push(msg.text());
        });

        await page.goto('/', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => Boolean(window.SillyTavern?.getContext), { timeout: 30000 });
        await page.waitForTimeout(1000);

        const cpaPageErrors = pageErrors.filter(e => /completion[-_ ]preset|cpa[-_ ]iteration|could not be cloned/i.test(e));
        const cpaConsoleErrors = consoleErrors.filter(e => /completion[-_ ]preset|cpa[-_ ]iteration|duplicate export/i.test(e));

        expect(cpaPageErrors, `unexpected CPA-related pageerror(s): ${cpaPageErrors.join(' | ')}`).toEqual([]);
        expect(cpaConsoleErrors, `unexpected CPA-related console.error(s): ${cpaConsoleErrors.join(' | ')}`).toEqual([]);
    });

    test('iterationLibrary surface still intact post-Stage 3', async ({ page }) => {
        await page.goto('/', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => Boolean(window.SillyTavern?.getContext), { timeout: 30000 });

        const exposed = await page.evaluate(() => {
            const ctx = window.SillyTavern.getContext();
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
