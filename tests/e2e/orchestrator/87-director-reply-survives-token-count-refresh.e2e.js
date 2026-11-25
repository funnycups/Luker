// Case #87 — a prompt-manager token-count refresh during a director run
// must not drop the committed reply.
//
// Toggling a prompt in the Prompt Manager schedules a dry-run Generate
// that recounts prompt tokens. The test holds the director's finalize
// call in the mock LLM, toggles a prompt through the real UI, waits for
// that dry run to start, then releases finalize. The committed reply
// must be persisted: after a server restart and reload it is still the
// last assistant message.

import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import {
    bootstrapCustomBackend,
    appendConnectionProfile,
    markOnboarded,
} from '../_lib/fixtures.js';
import {
    awaitMainUI,
    selectCharacterByName,
    sendMessageViaUI,
    closeAnyOpenTopSettingsDrawer,
    reloadAndAwait,
    getChatSnapshot,
} from '../_lib/page.js';
import { installMinimalDirectorProfile } from '../_lib/ui-orchestrator.js';

const FINAL_REPLY =
    '*Ash folds the chart along its old creases and tucks it inside her coat.*\n\n'
    + '"The channel opens at the turn of the tide. Keep the lantern low until we clear the rocks."';

let server, mock;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({});
    server = await startServer({ scope, batchKey: 'orchestrator', scenarioId: '87-token-refresh' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {

    await mock?.stop();
});

test.describe('#87 — director reply survives a token-count refresh mid-run', () => {
    test('reply committed after a prompt toggle dry run is persisted across restart', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await installMinimalDirectorProfile(page);

        let markFinalizeRequested;
        const finalizeRequested = new Promise((resolve) => { markFinalizeRequested = resolve; });
        let releaseFinalize;
        const finalizeReleased = new Promise((resolve) => { releaseFinalize = resolve; });
        mock.scriptDirectorRun({
            route: ({ role, turn }) => {
                if (role === 'director-main' && turn === 0) {
                    return { tool: 'write_message', arguments: { text: FINAL_REPLY, mode: 'replace' } };
                }
                if (role === 'director-main' && turn === 1) {
                    markFinalizeRequested();
                    return finalizeReleased.then(() => ({ tool: 'finalize', arguments: {} }));
                }
                return null;
            },
        });

        // Probe: count dry-run Generates past their abort-controller setup
        // (token-count refreshes).
        await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            window.__e2eDryRunStarts = 0;
            ctx.eventSource.on(ctx.eventTypes.GENERATION_AFTER_COMMANDS, (_type, _params, dryRun) => {
                if (dryRun) window.__e2eDryRunStarts += 1;
            });
        });

        await sendMessageViaUI(page, '*I unroll the chart beside the lantern.* "Where does the channel open?"');
        await finalizeRequested;

        // The director run is in flight. Toggle a prompt in the Prompt
        // Manager, which schedules a token-count dry run.
        await page.evaluate(() => { window.__e2eDryRunStarts = 0; });
        await closeAnyOpenTopSettingsDrawer(page);
        await page.locator('#ai-config-button > .drawer-toggle').click();
        await expect(page.locator('#left-nav-panel')).toHaveClass(/\bopenDrawer\b/, { timeout: 5000 });
        const toggle = page.locator('#completion_prompt_manager_list li[data-pm-identifier="nsfw"] .prompt-manager-toggle-action');
        await toggle.scrollIntoViewIfNeeded();
        await toggle.click();
        await page.waitForFunction(() => window.__e2eDryRunStarts > 0, null, { timeout: 30_000 });

        await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            window.__e2eGenerationEnded = false;
            const onEnded = () => {
                ctx.eventSource.removeListener(ctx.eventTypes.GENERATION_ENDED, onEnded);
                window.__e2eGenerationEnded = true;
            };
            ctx.eventSource.on(ctx.eventTypes.GENERATION_ENDED, onEnded);
        });
        releaseFinalize();
        await page.waitForFunction(() => window.__e2eGenerationEnded === true, null, { timeout: 30_000 });

        const before = await getChatSnapshot(page);
        const lastBefore = before.messages[before.messages.length - 1];
        expect(lastBefore.is_user).toBe(false);
        expect(lastBefore.mes.trim()).toBe(FINAL_REPLY.trim());

        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction((chatId) => {
            const ctx = window.Luker?.getContext?.();
            return ctx?.getCurrentChatId?.() === chatId && Array.isArray(ctx.chat) && ctx.chat.length > 0;
        }, before.chatId, { timeout: 30_000 });

        const after = await getChatSnapshot(page);
        const lastAfter = after.messages[after.messages.length - 1];
        expect(after.messages).toHaveLength(before.length);
        expect(lastAfter.is_user).toBe(false);
        expect(lastAfter.mes.trim()).toBe(FINAL_REPLY.trim());
    });
});
