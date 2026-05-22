import { test, expect } from '@playwright/test';

/**
 * Stage 0 boot-only smoke: loading SillyTavern + clearing the preloader
 * must not emit the structured-clone error the Stage 0 fix targets.
 *
 * Full reproduction (character-bound preset + live LLM iteration commit) is
 * a manual smoke documented in the Stage 0 plan, not automated here — no
 * stable test fixtures for a character with a bound preset exist yet.
 *
 * Note: we don't use testSetup.awaitST from frontent-test-utils because that
 * harness assumes the user-select gate (#userList .userSelect) is always
 * rendered. In single-default-user / passwordless setups, /login auto-issues
 * a session cookie and redirects straight to /, so the gate is never served.
 * This boot smoke handles both paths.
 */

test.describe('Stage 0 — CPA Promise clone regression', () => {
    test('app load + idle does not log structured-clone failure', async ({ page }) => {
        const cloneErrors = [];
        page.on('console', (msg) => {
            const text = msg.text();
            if (/could not be cloned/i.test(text)) {
                cloneErrors.push(`[${msg.type()}] ${text}`);
            }
        });
        page.on('pageerror', (err) => {
            if (/could not be cloned/i.test(err.message)) {
                cloneErrors.push(`[pageerror] ${err.message}`);
            }
        });

        await page.goto('/');

        // If a user-select gate is rendered, click through it. Otherwise the
        // server has auto-logged us in and we're already on the main UI.
        const gate = page.locator('#userList .userSelect:last-child');
        try {
            await gate.waitFor({ state: 'visible', timeout: 2000 });
            await gate.click();
            await page.waitForURL('http://127.0.0.1:8000');
        } catch {
            // No gate — single-user auto-login path.
        }

        await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 0 });
        await page.waitForTimeout(750);

        expect(cloneErrors, `unexpected clone error(s): ${cloneErrors.join(' | ')}`).toEqual([]);
    });
});
