// #14 — Export chat as JSONL via /api/chats/export → import into a
// different character via /api/chats/import (multipart). Roundtrip the
// chat content and assert all turns are equal. Restart and re-assert.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait, selectCharacterByName, sendMessageAndAwaitReply, getChatSnapshot } from '../_lib/page.js';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const REPLIES = [
    '*Seraphina answers with the brisk patience of a watchwoman.* "Roundtrip reply A."',
    '*Seraphina half-smiles.* "Roundtrip reply B."',
    '*Seraphina folds her arms.* "Roundtrip reply C."',
];

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: REPLIES });
    server = await startServer({ batchKey: 'chat', scenarioId: 'export-import' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#14 — export/import roundtrip', () => {
    test('jsonl roundtrip into a different character preserves all turns across restart', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        // Create the destination character via the live API so the
        // PNG-embedded chara is properly written (the bundled fixtures
        // copyFileSync trick keeps the Seraphina chara chunk).
        const newCharAvatar = await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            const headers = ctx.getRequestHeaders?.() || { 'Content-Type': 'application/json' };
            const res = await fetch('/api/characters/create', {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    ch_name: 'Iyana the Watchwoman',
                    description: 'A second watchwoman who walks the eastern stretch of the Bryn headland. Quiet, careful, used to keeping silent vigils.',
                    personality: 'Reserved and steady; keeps her hands in her sleeves.',
                    scenario: 'You are sharing the eastern watch with Iyana.',
                    first_mes: '*Iyana lifts a hand in greeting and does not speak first.*',
                    mes_example: '',
                    creator_notes: 'e2e fixture',
                    system_prompt: '',
                    post_history_instructions: '',
                    talkativeness: '0.5',
                    fav: false,
                    file_name: 'iyana-the-watchwoman',
                    create_date: new Date().toISOString(),
                }),
            });
            return res.ok ? await res.text() : '';
        });
        expect(newCharAvatar, 'character /create should return the new avatar filename').toBe('iyana-the-watchwoman.png');

        await sendMessageAndAwaitReply(page, 'Roundtrip turn A.');
        await sendMessageAndAwaitReply(page, 'Roundtrip turn B.');
        await sendMessageAndAwaitReply(page, 'Roundtrip turn C.');

        const before = await getChatSnapshot(page);
        const chatId = before.chatId;
        const seraphinaAvatar = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return ctx.characters[ctx.characterId]?.avatar;
        });
        expect(seraphinaAvatar).toBeTruthy();

        // Export — POST /api/chats/export, format=jsonl.
        const exportResult = await page.evaluate(async ({ avatar, chatId }) => {
            const ctx = window.Luker.getContext();
            const headers = ctx.getRequestHeaders?.() || { 'Content-Type': 'application/json' };
            const res = await fetch('/api/chats/export', {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    is_group: false,
                    avatar_url: avatar,
                    file: `${chatId}.jsonl`,
                    exportfilename: `${chatId}.jsonl`,
                    format: 'jsonl',
                }),
            });
            const json = await res.json();
            return { ok: res.ok, json };
        }, { avatar: seraphinaAvatar, chatId });
        expect(exportResult.ok, `export failed: ${JSON.stringify(exportResult.json)}`).toBe(true);
        expect(typeof exportResult.json.result).toBe('string');
        const exportedJsonl = exportResult.json.result;
        expect(exportedJsonl.split('\n').length).toBeGreaterThan(3);
        expect(exportedJsonl).toContain('Roundtrip turn A');
        expect(exportedJsonl).toContain('Roundtrip reply A');

        // Reload character list so Iyana shows up in window.characters.
        await page.evaluate(async () => {
            await window.Luker.getContext().getCharacters?.();
        });
        await page.waitForFunction((wantName) => {
            const ctx = window.Luker.getContext();
            return ctx.characters.some(c => c?.name === wantName);
        }, 'Iyana the Watchwoman', { timeout: 10_000 });

        // Import — POST /api/chats/import (multipart) on the second character.
        const importResult = await page.evaluate(async ({ avatar, jsonl, charName }) => {
            const ctx = window.Luker.getContext();
            const headers = ctx.getRequestHeaders?.({ omitContentType: true }) || {};
            const form = new FormData();
            form.append('avatar_url', avatar);
            form.append('character_name', charName);
            form.append('user_name', 'User');
            form.append('file_type', 'jsonl');
            form.append('avatar', new Blob([jsonl], { type: 'application/octet-stream' }), 'roundtrip.jsonl');
            const res = await fetch('/api/chats/import', {
                method: 'POST',
                headers,
                body: form,
                cache: 'no-cache',
            });
            const json = await res.json();
            return { ok: res.ok, status: res.status, json };
        }, { avatar: 'iyana-the-watchwoman.png', jsonl: exportedJsonl, charName: 'Iyana the Watchwoman' });

        expect(importResult.ok, `import failed: ${JSON.stringify(importResult)}`).toBe(true);
        expect(importResult.json.res, `import returned ${JSON.stringify(importResult.json)}`).toBe(true);
        const importedFile = importResult.json.fileNames?.[0];
        expect(importedFile).toBeTruthy();

        // The imported chat must now live in iyana's chats dir.
        const iyanaChatsDir = resolve(server.dataRoot, 'default-user', 'chats', 'iyana-the-watchwoman');
        expect(existsSync(iyanaChatsDir)).toBe(true);
        const filesInIyana = readdirSync(iyanaChatsDir).filter(f => f.endsWith('.jsonl'));
        expect(filesInIyana).toContain(importedFile);

        // Read the imported jsonl and confirm it has the same user/asst turns.
        const importedContent = readFileSync(resolve(iyanaChatsDir, importedFile), 'utf8');
        for (const tag of ['Roundtrip turn A', 'Roundtrip turn B', 'Roundtrip turn C', 'Roundtrip reply A', 'Roundtrip reply B', 'Roundtrip reply C']) {
            expect(importedContent, `${tag} should appear in imported chat`).toContain(tag);
        }

        // Restart and verify the imported file survives.
        await server.restart();
        const stillThere = readdirSync(iyanaChatsDir).filter(f => f.endsWith('.jsonl'));
        expect(stillThere).toContain(importedFile);
        const reloadedContent = readFileSync(resolve(iyanaChatsDir, importedFile), 'utf8');
        for (const tag of ['Roundtrip turn A', 'Roundtrip reply C']) {
            expect(reloadedContent).toContain(tag);
        }

        // And visiting Iyana in the UI now loads that imported chat.
        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, 'Iyana the Watchwoman');
        // We need to open the specific imported chat (Luker may start a new one).
        await page.evaluate(async (chatFile) => {
            const ctx = window.Luker.getContext();
            const fn = ctx.openCharacterChat || (await import('/script.js')).openCharacterChat;
            await fn(chatFile.replace(/\.jsonl$/, ''));
        }, importedFile);
        await page.waitForFunction((wantId) => {
            const ctx = window.Luker.getContext();
            return ctx.getCurrentChatId?.() === wantId;
        }, importedFile.replace(/\.jsonl$/, ''), { timeout: 15_000 });
        const finalSnap = await getChatSnapshot(page);
        expect(finalSnap.messages.some(m => /Roundtrip turn A/.test(m.mes || ''))).toBe(true);
        expect(finalSnap.messages.some(m => /Roundtrip reply C/.test(m.mes || ''))).toBe(true);
    });
});
