import { test, expect } from '../../harness/playwright.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import {
    bootstrapCustomBackend, appendConnectionProfile, markOnboarded,
} from '../_lib/fixtures.js';
import { launchLukerDesktop } from '../_lib/desktop.js';
import {
    awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply, getRenderedChatTexts,
} from '../_lib/page.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';
import { existsSync, readdirSync } from 'node:fs';

// 这个文件的三条用例共用一个 app 实例且互相依赖（发消息 → 重启后仍在 →
// 退出后端口释放）。`playwright.config.js` 开着 fullyParallel，不声明 serial
// 的话每条用例会各起一个 worker、各跑一遍 beforeAll。
test.describe.configure({ mode: 'serial' });

let desktop, mock;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({ scriptedReplies: [
        '*Ash sets the spyglass down and taps the chart twice.* "Three breakers north of the gull rocks. Nothing on the moon\'s account. Something is moving out there, and it is not the tide."',
    ] });
    desktop = await launchLukerDesktop({ scope, scenarioId: 'boot-and-first-turn' });
    markOnboarded({ dataRoot: desktop.dataRoot });
    bootstrapCustomBackend({ dataRoot: desktop.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: desktop.dataRoot, baseURL: mock.baseURL });
    writeEmbeddedCharacter({ dataRoot: desktop.dataRoot, overrides: { chat: 'ash-e2e-resume' } });
});

test.afterAll(async () => {
    await desktop?.close();
    await mock?.stop();
});

test('the shell opens its own window on the local backend and completes a turn', async () => {
    expect(new URL(desktop.page.url()).origin).toBe(desktop.baseURL);
    await awaitMainUI(desktop.page, desktop.baseURL);
    await selectCharacterByName(desktop.page, 'Ash the Cartographer');
    const { text } = await sendMessageAndAwaitReply(
        desktop.page, 'What do you read in the reef tonight?');
    expect(text).toMatch(/gull rocks|breakers/);
});

test('chat data lands under the scratch userData and survives a relaunch', async () => {
    const chatDir = `${desktop.userData}/data/default-user/chats`;
    expect(existsSync(chatDir)).toBe(true);
    expect(readdirSync(chatDir).length).toBeGreaterThan(0);
    await desktop.relaunch();
    await awaitMainUI(desktop.page, desktop.baseURL);
    await selectCharacterByName(desktop.page, 'Ash the Cartographer');
    await desktop.page.waitForFunction(
        () => document.querySelectorAll('#chat .mes').length >= 2, { timeout: 15_000 });
    const rendered = await getRenderedChatTexts(desktop.page);
    expect(rendered.some(t => /gull rocks|breakers/.test(t))).toBe(true);
});

test('quitting the app releases the port', async () => {
    const { port } = desktop;
    // Playwright's close asks the app to quit, which is the same path the tray
    // menu and the platform's quit shortcut take.
    await desktop.close();
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
});
