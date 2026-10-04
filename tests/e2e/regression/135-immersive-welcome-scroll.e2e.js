import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';

let server, mock;

const AVATAR_FILE = 'ash-the-cartographer.png';
const CHAR_DIR = 'ash-the-cartographer';

/**
 * Seed a chat file on disk for the embedded character so the welcome
 * screen's recent-chats list has enough entries to overflow #chat.
 */
function seedChat(dataRoot, index) {
    const dir = resolve(dataRoot, 'default-user', 'chats', CHAR_DIR);
    mkdirSync(dir, { recursive: true });
    const header = { chat_metadata: {}, user_name: 'unused', character_name: 'unused' };
    const messages = [
        {
            name: 'Ash the Cartographer',
            is_user: false,
            is_system: false,
            send_date: new Date(Date.UTC(2026, 5, 8, 9, 38, 12, index)).toISOString(),
            mes: `The ink on chart ${index} has barely dried.`,
            extra: {},
        },
        {
            name: 'User',
            is_user: true,
            is_system: false,
            send_date: new Date(Date.UTC(2026, 5, 8, 9, 39, 12, index)).toISOString(),
            mes: `Compare chart ${index} against the western marker.`,
            extra: {},
        },
    ];
    const lines = [JSON.stringify(header), ...messages.map(message => JSON.stringify(message))];
    writeFileSync(resolve(dir, `Ash - ${String(index).padStart(2, '0')}.jsonl`), `${lines.join('\n')}\n`);
}

test.beforeAll(async () => {
    mock = await startMockLLM({
        scriptedReplies: [
            '*Ash studies the inked coastline.* "The western marker is still where we left it."',
            '*Ash lowers the spyglass.* "The northern buoy still burns beyond the fog."',
        ],
    });
    server = await startServer({
        batchKey: 'regression',
        scenarioId: 'immersive-welcome-scroll',
        extraConfig: { 'performance.lazyLoadCharacters': true },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    writeEmbeddedCharacter({ dataRoot: server.dataRoot, avatarFile: AVATAR_FILE });
    for (let index = 1; index <= 12; index++) {
        seedChat(server.dataRoot, index);
    }
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.use({ viewport: { width: 400, height: 640 } });

test.describe('#135 - exiting immersive mode keeps the welcome screen scroll position', () => {
    test('the welcome screen does not scroll when immersive mode is entered and exited', async ({ page }) => {
        test.setTimeout(120_000);

        await awaitMainUI(page, server.baseURL);
        await page.locator('.welcomePanel').waitFor({ state: 'visible', timeout: 15_000 });

        const showMore = page.locator('.welcomePanel .showMoreChats');
        if (await showMore.count()) {
            await showMore.first().click();
        }

        const chat = page.locator('#chat');
        await page.waitForFunction(() => {
            const element = document.getElementById('chat');
            return element.scrollHeight > element.clientHeight + 100;
        }, { timeout: 15_000 });

        expect(await chat.evaluate(element => element.scrollTop)).toBe(0);

        await page.locator('#user-settings-button .drawer-toggle').click();
        await page.waitForFunction(() => {
            const block = document.getElementById('user-settings-block');
            return block && !block.classList.contains('closedDrawer');
        }, { timeout: 10_000 });

        await page.locator('#immersive_mode_toggle').click();
        await page.waitForFunction(() => document.body.classList.contains('luker-immersive-mode'), { timeout: 10_000 });

        await page.locator('#immersiveExitButton').click();
        await page.waitForFunction(() => !document.body.classList.contains('luker-immersive-mode'), { timeout: 10_000 });

        await expect.poll(() => chat.evaluate(element => element.scrollTop), {
            message: 'exiting immersive mode must not scroll the welcome screen',
            timeout: 5_000,
        }).toBe(0);
    });

    test('composer autofit still keeps the chat viewport bottom anchored while typing', async ({ page }) => {
        test.setTimeout(120_000);

        await awaitMainUI(page, server.baseURL);
        await page.locator('.welcomePanel').waitFor({ state: 'visible', timeout: 15_000 });

        await selectCharacterByName(page, 'Ash the Cartographer');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 15_000 });
        await sendMessageAndAwaitReply(page, 'Check the western marker against the chart.');
        await sendMessageAndAwaitReply(page, 'Can you still see the northern buoy?');

        const chat = page.locator('#chat');
        await page.waitForFunction(() => {
            const element = document.getElementById('chat');
            return element.scrollHeight > element.clientHeight + 100;
        }, { timeout: 15_000 });
        await chat.evaluate(element => { element.scrollTop = 100; });

        const bottomEdge = () => chat.evaluate(element => element.scrollTop + element.offsetHeight);
        const before = await bottomEdge();

        const textarea = page.locator('#send_textarea');
        const heightBefore = await textarea.evaluate(element => element.offsetHeight);
        await textarea.fill(Array.from({ length: 12 }, (_, index) => `Draft line ${index + 1}`).join('\n'));
        await expect.poll(() => textarea.evaluate(element => element.offsetHeight), {
            message: 'the composer should grow with its content',
            timeout: 5_000,
        }).toBeGreaterThan(heightBefore);

        await expect.poll(async () => Math.abs((await bottomEdge()) - before), {
            message: 'the chat viewport bottom must stay anchored when the composer grows',
            timeout: 5_000,
        }).toBeLessThanOrEqual(2);
    });
});
