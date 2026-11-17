// #68 — Prompt preparation error reporting & live generation abort.
//
// Guards the contract when prompt assembly throws (including cross-realm errors
// thrown from an iframe script hook):
//   1. The user sees an accurate toast ("Failed to prepare prompts") displaying
//      the real thrown error rather than a generic token-counting error.
//   2. Live generation aborts before dispatching an empty prompt to the LLM,
//      unlocks the composer UI, and allows subsequent turns to proceed once
//      the failing hook is removed.
//   3. Frontend diagnostics capture the cross-realm error text rather than `{}`.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import {
    bootstrapCustomBackend,
    appendConnectionProfile,
    markOnboarded,
} from '../_lib/fixtures.js';
import {
    awaitMainUI,
    selectCharacterByName,
    closeRightNavDrawer,
    sendMessageAndAwaitReply,
} from '../_lib/page.js';
import { normalizeIterStudioSettings } from './_helpers.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';

const CHAR_NAME = 'Ash the Reef Watcher';
const CHAR_AVATAR = 'ash-the-reef-watcher.png';

let server;
let mock;

test.beforeAll(async () => {
    mock = await startMockLLM({
        scriptedReplies: [
            '*Ash lifts the shuttered lamp toward the seawall.* "Clear water now. Bring the skiff alongside."',
        ],
    });
    server = await startServer({
        batchKey: 'preset',
        scenarioId: 'prompt-prepare-error-reporting',
        extraConfig: { 'storage.mode': 'fs' },
    });

    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL, stream: false });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

    writeEmbeddedCharacter({
        dataRoot: server.dataRoot,
        avatarFile: CHAR_AVATAR,
        overrides: {
            name: CHAR_NAME,
        },
    });

    normalizeIterStudioSettings(server.dataRoot);
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test('surfaces real cross-realm prompt preparation errors, aborts empty dispatch, and recovers cleanly', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);
    await selectCharacterByName(page, CHAR_NAME);
    await closeRightNavDrawer(page);

    const baselineRequestCount = mock.requests.length;

    await page.evaluate(() => {
        const iframe = document.createElement('iframe');
        iframe.style.display = 'none';
        document.body.appendChild(iframe);
        const iframeWin = iframe.contentWindow;

        const pm = window.Luker.getContext().openai.promptManager;
        const originalPreparePrompt = pm.preparePrompt;
        let shouldThrow = true;

        pm.preparePrompt = function (...args) {
            if (shouldThrow) {
                throw new iframeWin.TypeError('sandboxed helper is not a function');
            }
            return originalPreparePrompt.apply(this, args);
        };

        window.__restorePreparePromptHook = () => {
            shouldThrow = false;
            pm.preparePrompt = originalPreparePrompt;
            iframe.remove();
        };
    });

    await page.locator('#send_textarea').fill('*I check the compass housing.* "Is the channel clear?"');
    await page.locator('#send_but').click();

    const errorToast = page.locator('#toast-container .toast-error', {
        has: page.locator('.toast-title', { hasText: 'Failed to prepare prompts' }),
    });
    await expect(errorToast).toBeVisible({ timeout: 10_000 });
    await expect(errorToast.locator('.toast-message')).toContainText('TypeError: sandboxed helper is not a function');
    await expect(page.locator('#toast-container .toast-error', { hasText: 'counting tokens' })).toHaveCount(0);

    // Generation must have aborted without dispatching an empty prompt upstream,
    // and the composer controls must be unlocked again.
    await expect.poll(() => page.evaluate(() => document.body.dataset.generating !== 'true')).toBe(true);
    await expect(page.locator('#send_but')).toBeVisible();
    expect(mock.requests).toHaveLength(baselineRequestCount);

    const logDump = await page.evaluate(async () => {
        const mod = await import('/scripts/frontend-log-manager.js');
        return mod.getFrontendLogsSnapshot();
    });
    const prepLog = logDump.entries.find((e) => e.message.startsWith('Unexpected error while preparing prompts'));
    expect(prepLog).toBeDefined();
    expect(prepLog.message).toContain('TypeError: sandboxed helper is not a function');

    // Restoring the hook allows subsequent generation to proceed normally.
    await page.evaluate(() => window.__restorePreparePromptHook());

    const { text } = await sendMessageAndAwaitReply(
        page,
        '*I coil the bow line.* "Ready to come alongside."',
    );
    expect(text).toContain('Clear water now');
    expect(mock.requests).toHaveLength(baselineRequestCount + 1);
});
