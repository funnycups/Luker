// #13b — Chat backups.
//
// After saving a few turns, a backup file should appear under
// dataRoot/default-user/backups/ with the prefix `chat_<cardname>_`.
// Backup throttle is 10s (config.yaml), but throttle is { leading: true }
// so the FIRST save fires the backup immediately.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';
import { readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [
        '*Seraphina nods.* "Backup A reply: yes, the chart is fresh."',
        '*Seraphina taps the rim.* "Backup B reply: the lantern wick is new this morning."',
        '*Seraphina exhales.* "Backup C reply: we are ahead of the slow swallow tonight."',
    ] });
    server = await startServer({ batchKey: 'chat', scenarioId: 'backups' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#13b — chat backups land in backups/', () => {
    test('chat_<card>_*.jsonl backup file exists after first save', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => {
            const ctx = window.SillyTavern.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        await sendMessageAndAwaitReply(page, 'Backup test turn A — anything new on the watch?');
        await sendMessageAndAwaitReply(page, 'Backup test turn B — and on the lantern?');
        await sendMessageAndAwaitReply(page, 'Backup test turn C — closing thought.');

        // Hit /api/chats/save directly with force=true so the server runs
        // trySaveChat → getBackupFunction (the throttle has leading: true,
        // so the first call writes the backup synchronously). The default
        // saveChat() debounce prefers /patch which DOES NOT back up.
        const saveResp = await page.evaluate(async () => {
            const ctx = window.SillyTavern.getContext();
            const headers = ctx.getRequestHeaders?.() || { 'Content-Type': 'application/json' };
            const fileName = ctx.getCurrentChatId?.();
            const character = ctx.characters[ctx.characterId];
            const chatHeader = { chat_metadata: ctx.chatMetadata, user_name: 'unused', character_name: 'unused' };
            const body = {
                ch_name: character?.name,
                file_name: fileName,
                chat: [chatHeader, ...ctx.chat],
                avatar_url: character?.avatar,
                force: true,
            };
            const res = await fetch('/api/chats/save', {
                method: 'POST',
                cache: 'no-cache',
                headers,
                body: JSON.stringify(body),
            });
            const json = await res.json().catch(() => null);
            return { ok: res.ok, status: res.status, json };
        });
        expect(saveResp.ok, `direct /api/chats/save failed: ${JSON.stringify(saveResp)}`).toBe(true);
        // Let the throttle leading-edge backup write to disk.
        await page.waitForTimeout(1500);

        const backupsDir = resolve(server.dataRoot, 'default-user', 'backups');
        expect(existsSync(backupsDir), `backups dir should exist; checked ${backupsDir}`).toBe(true);

        // The card name is the avatar minus .png, sanitized to lowercase
        // alphanumeric + underscores by backupChat.
        const avatarFolder = await page.evaluate(() => {
            const ctx = window.SillyTavern.getContext();
            return (ctx.characters[ctx.characterId]?.avatar || '').replace(/\.png$/, '');
        });
        const sanitized = avatarFolder.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        const matchPrefix = `chat_${sanitized}_`;

        const files = readdirSync(backupsDir);
        const matchingBackups = files.filter(f => f.startsWith(matchPrefix) && f.endsWith('.jsonl'));
        expect(matchingBackups.length,
            `expected a backup file with prefix '${matchPrefix}'; got files=${JSON.stringify(files)}`)
            .toBeGreaterThanOrEqual(1);
    });
});
