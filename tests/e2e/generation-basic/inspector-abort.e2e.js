// generation-basic — abort an in-flight generation from the Request Inspector.
//
// The inspector abort must behave like a user stop:
//   - the upstream stream stops;
//   - the send button re-enables and the stop button hides;
//   - the HTTP retry layer does NOT fire a second upstream request;
//   - the inspector row flips to `aborted`;
//   - no error toast is shown.
//
// The test drives the real UI: click #request_inspector_button, then the
// row's abort button. It does not call internal abort helpers directly.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';

const CHUNKS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
const REPLY_TEXT = CHUNKS.join(' ');
const CHUNK_DELAY_MS = 400;

test.describe('request-inspector: abort in-flight generation', () => {
    let server, mock;

    test.beforeAll(async () => {
        mock = await startMockLLM({
            scriptedReplies: [REPLY_TEXT],
            streamChunkDelayMs: CHUNK_DELAY_MS,
        });
        server = await startServer({ batchKey: 'generation', scenarioId: 'inspector-abort' });
        markOnboarded({ dataRoot: server.dataRoot });
        bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
        appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    });

    test.afterAll(async () => {
        await tearDownServer(server);
        await mock?.stop();
    });

    test('abort button stops the stream, marks the row aborted, and does not retry', async ({ page }) => {
        const abortRequests = [];
        page.on('request', (req) => {
            const url = req.url();
            if (url.includes('/api/generation/') && url.endsWith('/abort') && req.method() === 'POST') {
                abortRequests.push(url);
            }
        });

        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 }).catch(() => {});

        await page.locator('#send_textarea').fill('Please stream the reply slowly for me.');
        await page.locator('#send_but:not(.displayNone)').waitFor({ state: 'visible', timeout: 30_000 });
        await page.evaluate(() => document.querySelector('#send_but').click());

        // Wait until the first chunk is rendered so the inspector entry exists
        // and the stream is genuinely in flight.
        await page.waitForFunction(() => {
            const bubbles = document.querySelectorAll('#chat .mes:not([is_user="true"])');
            for (const b of bubbles) {
                if ((b.querySelector('.mes_text')?.innerText || '').includes('first')) return true;
            }
            return false;
        }, { timeout: 20_000 });

        // Real user path: open the user-settings drawer, then the inspector,
        // then the running row's abort button.
        await page.locator('#user-settings-button .drawer-toggle').click();
        await page.waitForFunction(() => {
            const el = document.getElementById('user-settings-block');
            return el && !el.classList.contains('closedDrawer');
        }, { timeout: 5000 });
        await page.locator('#request_inspector_button').click();
        const abortButton = page.locator('.ri-container .ri-abort-btn').first();
        await abortButton.waitFor({ state: 'visible', timeout: 10_000 });
        await abortButton.click();

        // The generation must stop and the UI must unlock.
        await page.waitForFunction(() => {
            const stop = document.querySelector('#mes_stop');
            return !stop || getComputedStyle(stop).display === 'none';
        }, { timeout: 10_000 });
        const sendReenabled = await page.evaluate(() => {
            const el = document.querySelector('#send_but');
            return !!el && !el.classList.contains('displayNone');
        });
        expect(sendReenabled, '#send_but should be re-enabled after inspector abort').toBe(true);

        // The inspector row flips to aborted after the refresh.
        await expect(page.locator('.ri-container .ri-row').first().locator('.ri-aborted')).toBeVisible({ timeout: 10_000 });

        // No retry: the mock saw exactly one chat-completion request. The
        // model-list probe from profile bootstrap is not a generation call.
        const chatRequests = mock.requests.filter(r => (r.url || '').includes('/chat/completions'));
        expect(chatRequests).toHaveLength(1);

        // The abort endpoint fired and was accepted.
        expect(abortRequests.length, 'expected POST /api/generation/:id/abort').toBeGreaterThanOrEqual(1);

        // A user-style stop does not surface an error toast.
        const errorToasts = await page.evaluate(() => {
            const container = document.querySelector('#toast-container');
            if (!container) return [];
            return Array.from(container.querySelectorAll('.toast-error')).map(el => el.innerText.slice(0, 200));
        });
        expect(errorToasts, `expected no error toast after inspector abort; got: ${JSON.stringify(errorToasts)}`).toEqual([]);
    });
});
