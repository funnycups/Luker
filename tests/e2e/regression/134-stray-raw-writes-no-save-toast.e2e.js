// Regression: a third-party extension that calls the deprecated raw
// chat-write APIs while no chat is loaded (welcome screen) must not raise the
// "Chat save aborted" data-loss alert. There is no active chat target to
// overwrite, so the write is a no-op; alerting the user is a false alarm.
//
// Real user flow: a stray extension write fires during extension activation
// (batch 2 of startup, right after the welcome screen opens) with integrity
// missing and no character selected. Pre-fix, the write guard toasted on top
// of the welcome screen. Post-fix, it is dropped silently.

import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';

let server;

const EXTENSION_DIR = 'startup-raw-writer';

/**
 * Install a third-party extension into the scratch dataRoot. It calls the
 * deprecated raw chat-write APIs at activation time, while the welcome screen
 * is up and no chat target exists.
 */
function installRawWriterExtension(dataRoot) {
    const dir = resolve(dataRoot, 'default-user', 'extensions', EXTENSION_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'manifest.json'), JSON.stringify({
        display_name: 'Startup Raw Writer',
        loading_order: 100,
        requires: [],
        optional: [],
        js: 'index.js',
        author: 'e2e',
        version: '1.0.0',
    }, null, 4));
    writeFileSync(resolve(dir, 'index.js'), `
import { getContext } from '../../../extensions.js';

const ctx = getContext();
window.__rawWriterRan = false;
if (ctx) {
    const writes = [
        ctx.appendChatMessages([{ name: 'Stray', is_user: false, is_system: false, mes: 'stray append', send_date: Date.now() }]),
        ctx.patchChatMessages([{ op: 'replace', path: '/0/mes', value: 'stray patch' }]),
        ctx.saveChatMetadata({ stray: true }),
    ];
    Promise.allSettled(writes).then(results => {
        window.__rawWriterResults = results.map(r => r.value ?? null);
        window.__rawWriterRan = true;
    });
}
`);
}

test.beforeAll(async () => {
    server = await startServer({ batchKey: 'regression', scenarioId: 'startup-raw-writer-no-toast' });
    markOnboarded({ dataRoot: server.dataRoot });
    installRawWriterExtension(server.dataRoot);
});

test.afterAll(async () => {
    await tearDownServer(server);
});

test.describe('stray raw chat writes on the welcome screen drop silently', () => {
    test('no save-aborted toast and no chat target is created', async ({ page }) => {
        test.setTimeout(120_000);

        const toasts = [];
        await page.exposeFunction('__recordToast', (entry) => toasts.push(entry));
        await page.addInitScript(() => {
            const iv = setInterval(() => {
                if (window.toastr && !window.__toastHooked) {
                    window.__toastHooked = true;
                    for (const level of ['error', 'info', 'warning', 'success']) {
                        const orig = window.toastr[level].bind(window.toastr);
                        window.toastr[level] = (...args) => {
                            window.__recordToast?.([level, ...args.map(String)]);
                            return orig(...args);
                        };
                    }
                    clearInterval(iv);
                }
            }, 10);
        });

        await awaitMainUI(page, server.baseURL);

        // Wait for the extension's writes to complete (proves the test
        // exercised the guard path instead of passing vacuously).
        await page.waitForFunction(() => window.__rawWriterRan === true, { timeout: 30_000 });

        // The writes must have been dropped by the guard (false), not saved.
        const results = await page.evaluate(() => window.__rawWriterResults);
        expect(results).toEqual([false, false, false]);

        // Give any late toast a moment to surface.
        await page.waitForTimeout(2000);
        const abortToasts = toasts.filter(t => t.includes('Chat save aborted'));
        expect(abortToasts, `unexpected save-aborted toasts: ${JSON.stringify(abortToasts)}`).toEqual([]);

        // The welcome screen must still be intact: no chat id, no integrity.
        const state = await page.evaluate(() => ({
            chatId: window.Luker.getContext().getCurrentChatId() ?? null,
            integrity: window.Luker.getContext().chatMetadata?.integrity ? 'present' : 'MISSING',
        }));
        expect(state.chatId).toBeNull();
        expect(state.integrity).toBe('MISSING');
    });
});
