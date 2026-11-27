import { test, expect } from '../harness/frontend.js';

/**
 * iteration-library exposure smoke. Independent of plugin state.
 *
 * Verifies:
 *   1. getContext().iterationLibrary is exposed with the expected keys.
 *   2. No iter-library errors during boot.
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
}

test.describe('iteration-library exposure', () => {
    test('getContext().iterationLibrary exposes the expected namespace keys', async ({ page }) => {
        const consoleErrors = [];
        page.on('console', (msg) => {
            const text = msg.text();
            if (msg.type() === 'error' && /iter[-_]?library/i.test(text)) consoleErrors.push(text);
        });

        await awaitMainUI(page);

        const exposed = await page.evaluate(() => {
            const ctx = window.Luker?.getContext?.();
            if (!ctx) return { error: 'getContext unavailable' };
            const lib = ctx.iterationLibrary;
            if (!lib) return { error: 'iterationLibrary missing' };
            return {
                keys: Object.keys(lib).sort(),
                applyEditsIsFunction: typeof lib.applyEdits === 'function',
                renderIsNamespace: typeof lib.render === 'object' && typeof lib.render.renderMessageMarkdown === 'function',
                runnerIsNamespace: typeof lib.runner === 'object',
                textDiffIsNamespace: typeof lib.textDiff === 'object' && typeof lib.textDiff.renderInlineTextDiffHtml === 'function',
                zoomOverlayIsNamespace: typeof lib.zoomOverlay === 'object' && typeof lib.zoomOverlay.attachZoomOverlay === 'function',
            };
        });

        expect(exposed.error).toBeUndefined();
        expect(exposed.keys).toEqual(['BUILT_IN_OPS', 'applyEdits', 'bindIterWorkspaceResizer', 'inverseEdit', 'proposalBus', 'registerOp', 'render', 'runner', 'showConflictResolution', 'textDiff', 'tools', 'ui', 'zoomOverlay']);
        expect(exposed.applyEditsIsFunction).toBe(true);
        expect(exposed.renderIsNamespace).toBe(true);
        expect(exposed.runnerIsNamespace).toBe(true);
        expect(exposed.textDiffIsNamespace).toBe(true);
        expect(exposed.zoomOverlayIsNamespace).toBe(true);

        expect(consoleErrors, `unexpected iter-library errors: ${consoleErrors.join(' | ')}`).toEqual([]);
    });
});
