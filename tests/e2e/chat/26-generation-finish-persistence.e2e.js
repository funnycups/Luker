/* eslint playwright/expect-expect: ["warn", { "assertFunctionNames": ["expect", "finishAfterPersistence"] }] */
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { markOnboarded, bootstrapCustomBackend, appendConnectionProfile } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';

const USER_MESSAGE = 'Keep the lantern steady until the watch has been recorded.';
const REPLY = '*Seraphina lowers the brass lantern.* "The acknowledged reef reply belongs in our watch journal."';

async function finishAfterPersistence({ resources, page }, stream) {
    const mock = await startMockLLM({ scriptedReplies: [REPLY] });
    const failures = [], handlers = [];
    let release, entered, sending;
    const held = new Promise(resolve => { entered = resolve; });
    const released = new Promise(resolve => { release = resolve; });
    const pattern = '**/api/chats/append';
    const intercept = route => {
        const operation = (async () => {
            const request = route.request();
            const body = request.postDataJSON();
            if (body.messages.some(message => !message.is_user && message.mes === REPLY)) {
                entered(request);
                await released;
            }
            await route.continue();
        })();
        handlers.push(operation);
        return operation;
    };
    try {
        const server = await startServer({ scope: resources, batchKey: 'chat', scenarioId: stream ? 'finish-stream' : 'finish-nonstream' });
        markOnboarded({ dataRoot: server.dataRoot });
        bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL, stream });
        appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        const target = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return { avatar: ctx.characters[ctx.characterId].avatar, chat: ctx.getCurrentChatId() };
        });
        const filename = path.join(server.dataRoot, 'default-user', 'chats', target.avatar.replace(/\.png$/, ''), `${target.chat}.jsonl`);
        const read = () => fs.readFileSync(filename, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        await page.route(pattern, intercept);
        sending = sendMessageAndAwaitReply(page, USER_MESSAGE).then(value => ({ value }), error => ({ error }));
        const request = await held;
        const before = read();
        expect(before).toHaveLength(3);
        expect(before[2].mes).toBe(USER_MESSAGE);
        await expect(page.locator('#mes_stop'), 'The completed reply must not release generation before its write is acknowledged').toBeVisible();
        if (stream) {
            await expect(page.locator('#chat .last_mes .swipes-counter'), 'The streaming swipe counter must remain hidden until persistence and generation completion finish').toHaveJSProperty('hidden', true);
        }
        const saved = page.waitForResponse(response => response.request() === request);
        release();
        const response = await saved;
        expect(response.status()).toBe(200);
        await response.finished();
        const result = await sending;
        if ('error' in result) throw result.error;
        expect(result.value.text).toContain('acknowledged reef reply');
        await expect(page.locator('#mes_stop')).toBeHidden();
        await expect(page.locator('#chat .last_mes .swipes-counter')).toHaveJSProperty('hidden', false);
        const after = read();
        expect(after).toHaveLength(4);
        expect(after[2].mes).toBe(USER_MESSAGE);
        expect(after[3].mes).toBe(REPLY);
        expect(after[3].is_user).toBe(false);
    } catch (error) {
        failures.push(error);
    } finally {
        release();
        if (sending) {
            const result = await sending;
            if ('error' in result && !failures.includes(result.error)) failures.push(result.error);
        }
        for (const result of await Promise.allSettled(handlers)) if (result.status === 'rejected') failures.push(result.reason);
        for (const result of await Promise.allSettled([page.unroute(pattern, intercept), mock.stop()])) if (result.status === 'rejected') failures.push(result.reason);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Generation persistence observation and cleanup failed');
}

test('streaming completion waits for the acknowledged final message', async ({ resources, page }) => {
    await finishAfterPersistence({ resources, page }, true);
});

test('non-streaming completion waits for the acknowledged final message', async ({ resources, page }) => {
    await finishAfterPersistence({ resources, page }, false);
});
