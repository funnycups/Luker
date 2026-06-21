// #64 — Variables set via typed slash commands persist across restart.
//
// `/setvar` is a slash-command that writes directly into
// `chat_metadata.variables`. Typing it into the send textarea + pressing
// the send button is a real user gesture (slash commands are valid user
// input, intercepted by the chat composer before they reach the LLM).
//
// What this test does NOT exercise: var_ops extraction. /setvar is a
// slash command, not an embedded AI macro — there are no extra.var_ops
// records produced. That distinction matters because the rebuilder on
// CHAT_CHANGED only rewrites keys it OWNS (keys that appear in surviving
// ops). Slash-command-written keys are not owned and therefore not
// touched by rebuild, which is exactly the behavior we want here.

import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply, reloadAndAwait } from '../_lib/page.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({
        scriptedReplies: [
            '*Seraphina sets her elbow on the chart, watching you mark the slate.* "The wind tells me you have the tallies right."',
            '*Seraphina glances at the slate again.* "Still three. The numbers stand."',
        ],
    });
    server = await startServer({ batchKey: 'varops', scenarioId: 'setvar-persist' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

/**
 * Type a slash command into the send textarea and click #send_but. Slash
 * commands execute synchronously in the composer's submit handler — no
 * LLM round-trip — so we just await the textarea clearing as the ready
 * signal.
 */
async function sendSlashCommand(page, command) {
    const textarea = page.locator('#send_textarea');
    await textarea.fill(command);
    await page.locator('#send_but:not(.displayNone)').waitFor({ state: 'visible', timeout: 30_000 });
    await page.locator('#send_but').click();
    await page.waitForFunction(() => {
        const ta = document.querySelector('#send_textarea');
        return ta && ta.value === '';
    }, { timeout: 15_000 });
}

test.describe('#64 — Variables persist across restart (typed /setvar in textarea)', () => {
    test('/setvar typed into the textarea + send-button survives server restart', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        // Anchor the chat (so it gets persisted on disk) with one real turn.
        await sendMessageAndAwaitReply(page, 'Mark the slate — I have three tallies for you tonight.');

        // ── Set three variables by TYPING /setvar into the textarea ────
        await sendSlashCommand(page, '/setvar key=watch_count 3');
        await sendSlashCommand(page, '/setvar key=keeper_name Briallen');
        await sendSlashCommand(page, '/setvar key=lantern_oil whale-oil');

        // Let the relaxed chat-save debounce (1000ms) flush to disk
        // before cycling the server. Mirrors a real user pausing briefly.
        await page.waitForTimeout(1200);

        // Verify cache reflects the writes.
        const beforeRestart = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return {
                metadata: ctx.chatMetadata?.variables ?? null,
                viaApi: {
                    watch_count: String(ctx.variables.local.get('watch_count')),
                    keeper_name: String(ctx.variables.local.get('keeper_name')),
                    lantern_oil: String(ctx.variables.local.get('lantern_oil')),
                },
            };
        });
        expect(beforeRestart.metadata).toMatchObject({
            watch_count: '3',
            keeper_name: 'Briallen',
            lantern_oil: 'whale-oil',
        });
        expect(beforeRestart.viaApi.watch_count).toBe('3');
        expect(beforeRestart.viaApi.keeper_name).toBe('Briallen');
        expect(beforeRestart.viaApi.lantern_oil).toBe('whale-oil');

        // ── Persistence: on-disk header carries the variables block ────
        const avatarFolder = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return (ctx.characters[ctx.characterId]?.avatar || '').replace(/\.png$/, '');
        });
        const chatDir = resolve(server.dataRoot, 'default-user', 'chats', avatarFolder);
        expect(existsSync(chatDir), `chat dir exists at ${chatDir}`).toBe(true);
        const files = readdirSync(chatDir).filter(f => f.endsWith('.jsonl'));
        expect(files.length, 'at least one jsonl chat persisted').toBeGreaterThan(0);
        const chatId = await page.evaluate(() => window.Luker.getContext().getCurrentChatId());
        const targetFile = chatId && files.includes(`${chatId}.jsonl`) ? `${chatId}.jsonl` : files[0];
        const headerOnDisk = JSON.parse(readFileSync(resolve(chatDir, targetFile), 'utf8').split('\n')[0]);
        const persistedVars = headerOnDisk?.chat_metadata?.variables ?? {};
        expect(persistedVars).toMatchObject({
            watch_count: '3',
            keeper_name: 'Briallen',
            lantern_oil: 'whale-oil',
        });

        // ── Restart + reload → vars still present in cache + via UI ────
        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        await page.waitForFunction(() => {
            const ctx = window.Luker?.getContext?.();
            return Array.isArray(ctx?.chat) && ctx.chat.length > 0;
        }, { timeout: 15_000 });

        const afterRestart = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return {
                metadata: ctx.chatMetadata?.variables ?? null,
                viaApi: {
                    watch_count: String(ctx.variables.local.get('watch_count')),
                    keeper_name: String(ctx.variables.local.get('keeper_name')),
                    lantern_oil: String(ctx.variables.local.get('lantern_oil')),
                },
            };
        });

        expect(afterRestart.metadata, 'cache hydrated from disk after restart').toMatchObject({
            watch_count: '3',
            keeper_name: 'Briallen',
            lantern_oil: 'whale-oil',
        });
        expect(afterRestart.viaApi.watch_count).toBe('3');
        expect(afterRestart.viaApi.keeper_name).toBe('Briallen');
        expect(afterRestart.viaApi.lantern_oil).toBe('whale-oil');

        // Send one more turn — verify the slash-set keys are NOT pruned by
        // the var-op rebuild that fires on CHAT_CHANGED (the rebuilder
        // intentionally leaves un-owned keys alone).
        await sendMessageAndAwaitReply(page, 'And the tally still stands at three. Confirm.');

        const afterNextTurn = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return ctx.chatMetadata?.variables ?? null;
        });
        expect(afterNextTurn, 'slash-set keys survive the post-turn rebuild').toMatchObject({
            watch_count: '3',
            keeper_name: 'Briallen',
            lantern_oil: 'whale-oil',
        });
    });
});
