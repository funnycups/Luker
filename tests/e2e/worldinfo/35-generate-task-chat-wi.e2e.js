// #35 — generateTask worldInfoSource:'chat' activates from live chat history
//
// Regression for the chat-shaped message normalization bug: real chat
// messages carry `{ mes, is_user, is_system }` and no `role` field. The
// resolver defaulted the missing role to 'system', filtered every message
// out, and returned an empty World Info snapshot — so a plugin request made
// with worldInfoSource:'chat' never saw any lorebook entries, even though
// the main chat did. The fix must not require the main chat to have
// generated first.

import { test, expect } from '../../harness/playwright.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { markOnboarded, bootstrapCustomBackend, appendConnectionProfile, writeWorldBook } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';
import { startServer } from '../../harness/server.js';
import { writeCharacterWithBinding } from './_helpers.js';

test.describe.configure({ mode: 'serial' });

const CONSTANT_LORE = 'PROBE_CONSTANT_LORE: the beacon never goes dark.';
const REEF_LORE = 'PROBE_REEF_LORE: the reef shifts on a 19-day cycle.';

let server, mock;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({ scriptedReplies: ['*Ash nods.* "Acknowledged."'] });
    server = await startServer({ scope, batchKey: 'worldinfo', scenarioId: 'generate-task-chat-wi' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    writeWorldBook({
        dataRoot: server.dataRoot,
        name: 'probe-book',
        entries: [
            { key: [], constant: true, comment: 'always-on', content: CONSTANT_LORE },
            { key: ['reef'], constant: false, comment: 'reef', content: REEF_LORE },
        ],
    });
    writeCharacterWithBinding({
        dataRoot: server.dataRoot,
        avatarFile: 'probe-wi.png',
        name: 'ProbeWI',
        worldBook: 'probe-book',
    });
});

test.afterAll(async () => {

    await mock?.stop?.();
});

test('generateTask worldInfoSource:chat resolves the live chat before any main generation', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);
    await selectCharacterByName(page, 'ProbeWI');

    // No main-chat generation has run yet: the snapshot cache is empty, so
    // this proves the plugin path rescans the chat instead of reusing it.
    const before = await page.evaluate(async () => {
        const ctx = window.Luker.getContext();
        const snap = await ctx.resolveWorldInfoForMessages([], { type: 'quiet', fallbackToCurrentChat: true });
        return {
            chatLength: ctx.chat.length,
            beforeEntries: snap.worldInfoBeforeEntries,
            activated: (snap.activatedEntries || []).map(entry => `${entry.world}/${entry.comment}`),
        };
    });
    expect(before.chatLength).toBeGreaterThan(0);
    expect(before.beforeEntries).toContain(CONSTANT_LORE);
    expect(before.activated).toContain('probe-book/always-on');

    await page.evaluate(async () => {
        const ctx = window.Luker.getContext();
        await ctx.generateTask({
            taskMessages: [
                { role: 'system', content: 'Probe.' },
                { role: 'user', content: 'Just answer ok.' },
            ],
            worldInfoSource: 'chat',
        });
    });

    const pluginRequest = mock.requests.filter(request => (request.url || '').includes('/chat/completions')).at(-1);
    expect(pluginRequest).toBeTruthy();
    const serialized = JSON.stringify(pluginRequest.body);
    expect(serialized).toContain(CONSTANT_LORE);
    expect(serialized).not.toContain(REEF_LORE);
});
