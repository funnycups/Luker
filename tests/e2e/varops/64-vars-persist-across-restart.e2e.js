// #64 — Variables set via slash commands persist across restart.
//
// `/setvar` writes directly into `chat_metadata.variables` (see
// public/scripts/variables.js setLocalVariable). The variable cache is
// part of chat metadata, persisted on the chat JSONL header line — so a
// restart that re-reads the same chat file must surface the same values.
//
// What this test does NOT exercise: var_ops extraction. /setvar is a
// slash command, not an embedded AI macro — there are no extra.var_ops
// records produced. That distinction matters because the rebuilder on
// CHAT_CHANGED only rewrites keys it OWNS (keys that appear in surviving
// ops). Slash-command-written keys are not owned and therefore not touched
// by rebuild, which is exactly the behavior we want here.

import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply, reloadAndAwait } from '../_lib/page.js';

let server, mock;

test.beforeAll(async () => {
    // Two scripted replies — one to anchor the chat (so it gets a persisted
    // ID), one in reserve for the post-restart turn.
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

test.describe('#64 — Variables persist across restart (slash command path)', () => {
    test('/setvar writes survive server restart and re-load of chat', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        // Anchor the chat: ensure greeting is in chat array first so the
        // chat file is actually created on disk before we /setvar into it.
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        // Send one turn so the chat file definitely exists (greeting alone
        // is in-memory until a save). This also gives us a stable jsonl
        // we can read back from disk.
        await sendMessageAndAwaitReply(page, 'Mark the slate — I have three tallies for you tonight.');

        // ── Set three variables via the slash-command surface ─────────
        await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            await ctx.executeSlashCommandsWithOptions('/setvar key=watch_count 3');
            await ctx.executeSlashCommandsWithOptions('/setvar key=keeper_name Briallen');
            await ctx.executeSlashCommandsWithOptions('/setvar key=lantern_oil whale-oil');
            // Trigger a save so the header rewrites with the new variables.
            await ctx.saveChat();
        });

        // Verify cache reflects the writes — both via direct metadata and the public API.
        // /setvar with no `as=number` keeps the value as the literal string.
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

        // ── Persistence: on-disk header carries the variables block ──
        // Resolve the avatar folder dynamically (Seraphina's avatar is
        // default_Seraphina.png so the folder is "default_Seraphina").
        const avatarFolder = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return (ctx.characters[ctx.characterId]?.avatar || '').replace(/\.png$/, '');
        });
        const chatDir = resolve(server.dataRoot, 'default-user', 'chats', avatarFolder);
        expect(existsSync(chatDir), `chat dir exists at ${chatDir}`).toBe(true);
        const files = readdirSync(chatDir).filter(f => f.endsWith('.jsonl'));
        expect(files.length, 'at least one jsonl chat persisted').toBeGreaterThan(0);
        // Find the file matching our active chatId.
        const chatId = await page.evaluate(() => window.Luker.getContext().getCurrentChatId());
        const targetFile = chatId && files.includes(`${chatId}.jsonl`) ? `${chatId}.jsonl` : files[0];
        const headerOnDisk = JSON.parse(readFileSync(resolve(chatDir, targetFile), 'utf8').split('\n')[0]);
        const persistedVars = headerOnDisk?.chat_metadata?.variables ?? {};
        expect(persistedVars).toMatchObject({
            watch_count: '3',
            keeper_name: 'Briallen',
            lantern_oil: 'whale-oil',
        });

        // ── Restart + re-load → vars still present in cache + UI ──────
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
