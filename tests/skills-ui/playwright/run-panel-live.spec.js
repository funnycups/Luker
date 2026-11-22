/**
 * End-to-end live Playwright verification for the shared floating Run Dock (`.rpdock.rp-dock`).
 */

import { test, expect } from '@playwright/test';
import path from 'node:path';
import {
    awaitMainUI,
    activateConnectionProfile,
    ensureCharacterLoaded,
    setWorkbenchOrchMode,
    setWorkbenchOrchEnabled,
    closeWorkbenchWindow,
    takeDocScreenshot,
    SCREENSHOTS_DIR,
} from './helpers.js';

const RUN_PANEL_SCREENSHOTS = path.join(SCREENSHOTS_DIR, 'run-panel');

const RP_PROMPT =
    'Please inspect what you know about the character first, then write a quiet '
    + '2-paragraph scene where she sets a chipped porcelain cup on the counter. '
    + 'Keep it atmospheric and grounded.';

test.describe('shared floating run dock live E2E', () => {
    test.setTimeout(600_000);

    test('dock streams live trace, settles cleanly, and matches chat bubble', async ({ page }) => {
        await awaitMainUI(page);
        await dismissWelcomeDialogIfPresent(page);

        const profile = await activateConnectionProfile(page);
        expect(profile, 'no usable connection profile (setup integration env with >= 1 profile first)').toBeTruthy();

        const llmReady = await page.evaluate(() => {
            const ctx = window.Luker?.getContext?.();
            const v = ctx?.onlineStatus ?? null;
            return Boolean(v) && String(v).toLowerCase() !== 'no_connection';
        });
        expect(llmReady, `connection profile "${profile}" activated but online_status is still no_connection`).toBe(true);

        const avatar = await ensureCharacterLoaded(page);
        expect(avatar, 'no loadable character in this data dir (need at least one card)').toBeTruthy();

        // Enable orchestrator in Director mode via Workbench Orchestration workspace.
        await setWorkbenchOrchMode(page, /Director|导演|導演/i);
        await setWorkbenchOrchEnabled(page, true);
        await closeWorkbenchWindow(page);

        await page.evaluate(async () => {
            const m = await import('/scripts/extensions/orchestrator/run-state/store.js');
            m.clearCurrentRun?.();
        });

        await page.evaluate(async (prompt) => {
            const ta = document.getElementById('send_textarea');
            if (!ta) throw new Error('send_textarea not present in DOM');
            ta.value = prompt;
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            ta.dispatchEvent(new Event('change', { bubbles: true }));
            const btn = document.getElementById('send_but');
            if (!btn) throw new Error('send_but not present in DOM');
            btn.click();
        }, RP_PROMPT);

        // Shared Run Dock auto-opens on RUN_STARTED.
        const dock = page.locator('.rpdock.rp-dock').first();
        await expect(dock).toHaveAttribute('data-state', 'open', { timeout: 30_000 });
        await clearToasts(page);
        await takeDocScreenshot(page, path.join(RUN_PANEL_SCREENSHOTS, '01-panel-initial.png'), { fullPage: false });

        // Dock streaming: wait for streamed content inside `.rp-dock-body` and assert monotonic growth.
        const totalDockBytes = async () => {
            const lens = await dock.locator('.rp-dock-body .rp-dock-lines, .rp-dock-body .rp-textblock, .rp-dock-body .rp-step').evaluateAll(
                els => els.map(e => (e.textContent || '').length),
            );
            return lens.reduce((s, n) => s + n, 0);
        };
        await expect.poll(
            totalDockBytes,
            { timeout: 60_000, message: 'run dock never displayed streamed trace content' },
        ).toBeGreaterThan(0);
        const len1 = await totalDockBytes();
        await page.waitForTimeout(2_500);
        const len2 = await totalDockBytes();
        expect(len2, 'dock content length must not shrink mid-run').toBeGreaterThanOrEqual(len1);
        await clearToasts(page);
        await takeDocScreenshot(page, path.join(RUN_PANEL_SCREENSHOTS, '02-panel-streaming.png'), { fullPage: false });

        const finalState = await page.evaluate(async () => {
            const m = await import('/scripts/extensions/orchestrator/run-state/store.js');
            const settled = new Set(['committed', 'aborted', 'error']);
            const start = Date.now();
            const deadline = 540_000;
            while (Date.now() - start < deadline) {
                const s = m.getCurrentRun();
                if (s && settled.has(String(s.status || ''))) {
                    return JSON.parse(JSON.stringify(s, (k, v) => (k === 'abortFn' ? undefined : v)));
                }
                await new Promise(r => setTimeout(r, 1000));
            }
            return null;
        });

        expect(finalState, 'run never reached a terminal status before deadline').toBeTruthy();
        expect(finalState.status, 'run committed (no abort, no error)').toBe('committed');
        expect(typeof finalState.finalText === 'string' && finalState.finalText.length > 0, 'committed run wrote a non-empty finalText').toBe(true);

        // If collapsed to pill after idle shrink, re-open via pill for final assertions.
        if ((await dock.getAttribute('data-state')) !== 'open') {
            const pillMain = page.locator('.rpdock.rp-dock-pill .rp-dock-pill-main').first();
            if (await pillMain.isVisible().catch(() => false)) {
                await pillMain.click();
            }
        }
        await expect(dock).toHaveAttribute('data-state', 'open', { timeout: 10_000 });

        // Expanded agent details should remain collapsed when untouched.
        await expect(dock.locator('.rp-dock-detail')).toHaveCount(0);

        const lastBubble = page.locator('#chat .mes').last();
        const bubbleText = (await lastBubble.locator('.mes_text').innerText()).trim();
        expect(
            bubbleText,
            'last chat bubble text must equal state.finalText (1:1)',
        ).toBe(String(finalState.finalText).trim());

        const reasoningLeakCount = lastBubble.locator('text=/### \\[main-/');
        await expect(reasoningLeakCount, 'no `### [main-N]` reasoning-fold heading in the chat bubble').toHaveCount(0);

        // Expand an agent detail row if present to inspect steps / tool calls.
        const agentHead = dock.locator('.rp-dock-agent-head:not(:disabled)').first();
        if (await agentHead.isVisible().catch(() => false)) {
            await agentHead.click();
            await agentHead.scrollIntoViewIfNeeded();
            await page.waitForTimeout(150);
            await clearToasts(page);
            await takeDocScreenshot(page, path.join(RUN_PANEL_SCREENSHOTS, '03-panel-tool-expanded.png'), { fullPage: false });
        }

        await dock.locator('.rp-dock-body').evaluate(el => { el.scrollTop = el.scrollHeight; });
        await page.waitForTimeout(150);
        await clearToasts(page);
        await takeDocScreenshot(page, path.join(RUN_PANEL_SCREENSHOTS, '04-panel-final.png'), { fullPage: false });
    });

    test('compact floating layout on narrow viewport', async ({ browser }) => {
        const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
        const page = await context.newPage();
        try {
            await awaitMainUI(page);
            await dismissWelcomeDialogIfPresent(page);

            const profile = await activateConnectionProfile(page);
            expect(profile, 'no usable connection profile (setup integration env first)').toBeTruthy();
            const llmReady = await page.evaluate(() => {
                const ctx = window.Luker?.getContext?.();
                const v = ctx?.onlineStatus ?? null;
                return Boolean(v) && String(v).toLowerCase() !== 'no_connection';
            });
            expect(llmReady, 'connection profile activated but online_status no_connection').toBe(true);
            const avatar = await ensureCharacterLoaded(page);
            expect(avatar, 'no character available').toBeTruthy();

            await setWorkbenchOrchMode(page, /Director|导演|導演/i);
            await setWorkbenchOrchEnabled(page, true);
            await closeWorkbenchWindow(page);

            await page.evaluate(async () => {
                const m = await import('/scripts/extensions/orchestrator/run-state/store.js');
                m.clearCurrentRun?.();
            });
            await page.evaluate(async (prompt) => {
                const ta = document.getElementById('send_textarea');
                if (!ta) throw new Error('send_textarea not present in DOM');
                ta.value = prompt;
                ta.dispatchEvent(new Event('input', { bubbles: true }));
                ta.dispatchEvent(new Event('change', { bubbles: true }));
                const btn = document.getElementById('send_but');
                if (!btn) throw new Error('send_but not present in DOM');
                btn.click();
            }, RP_PROMPT);

            const dock = page.locator('.rpdock.rp-dock').first();
            await expect(dock).toHaveAttribute('data-state', 'open', { timeout: 30_000 });
            await expect(dock).toHaveClass(/\bis-compact\b/);

            await expect.poll(async () => {
                const lens = await dock.locator('.rp-dock-body .rp-dock-lines, .rp-dock-body .rp-textblock, .rp-dock-body .rp-step').evaluateAll(
                    els => els.map(e => (e.textContent || '').length),
                );
                return lens.reduce((s, n) => s + n, 0);
            }, { timeout: 60_000, message: 'compact dock never received streamed bytes' }).toBeGreaterThan(0);
            await clearToasts(page);
            await takeDocScreenshot(page, path.join(RUN_PANEL_SCREENSHOTS, '05-panel-mobile.png'), { fullPage: false });
        } finally {
            await context.close();
        }
    });
});

async function clearToasts(page) {
    await page.evaluate(() => {
        try { window.toastr?.clear?.(); } catch { /* ignore */ }
        document.querySelectorAll('#toast-container .toast').forEach(el => el.remove());
    }).catch(() => null);
}

async function dismissWelcomeDialogIfPresent(page) {
    const welcomeSave = page.locator('dialog:has(h3:has-text("Welcome to Luker!")) button:has-text("Save"), dialog:has(h3:has-text("Welcome to SillyTavern!")) button:has-text("Save")');
    try {
        await welcomeSave.first().waitFor({ state: 'visible', timeout: 2000 });
    } catch {
        return;
    }
    await welcomeSave.first().click({ force: true }).catch(() => null);
    await page.waitForFunction(
        () => !document.querySelector('dialog:has(h3) [class*="popup-button"]')
            || !document.querySelector('dialog:has(h3:has-text("Welcome"))'),
        null,
        { timeout: 5000 },
    ).catch(() => null);
}
