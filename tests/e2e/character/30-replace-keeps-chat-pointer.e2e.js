// #30 — Replace / Update must keep the active chat pointer.
//
// The #118 / #128 / #129 fix family made every character *load and refresh*
// path preserve the live `.chat` pointer: the server stopped minting
// stamps, getOneCharacter keeps a non-empty existing pointer,
// getCharacters snapshots liveChats across rebuilds, and the unshallow /
// createOrEdit / slash-command / world-info callers pass
// `preserveChat: true`. The replace flow adds its own ways to retarget the
// pointer:
//
//   1. The server import overwrites the whole card, so the PNG's persisted
//      `chat` becomes the replacement card's own value — a V1 import mints
//      "<name> - <time>" (importFromPng, characters.js), a V2 import is
//      stripped by unsetPrivateFields. The previous pointer only survives
//      because postReplace() -> openCharacterChat() ->
//      updateRemoteChatName() writes it back; that chain is best-effort and
//      silently loses the write on any transport failure.
//   2. emitCharacterReplacedEvent() falls back to
//      getOneCharacter(previousAvatar) WITHOUT { preserveChat: true } —
//      the only one of the five getOneCharacter call sites still missing
//      it. When its refresh succeeds while the direct fetch failed, the
//      server value overwrites the live in-memory pointer.
//
// This test drives the real dropdown -> popup -> file picker replace path
// and asserts the pointer survives in memory, on disk, and across reload.
//
// The failure variants inject the two dropped requests the tunnel class
// produces (same observable failure as #29): a dropped pointer persist
// write (merge-attributes) and a failed post-replace refresh whose
// fallback refresh still succeeds.

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { disableTagImportPopup, dismissAnyPopup, clickCharacterCard, openCharacterEditPanel, writeEmbeddedCharacter } from './_helpers.js';
import { awaitMainUI, reloadAndAwait, selectCharacterByName, sendMessageAndAwaitReply, getChatSnapshot, getRenderedChatTexts } from '../_lib/page.js';
import { importCharacterFile } from '../_lib/ui-character.js';
import { write as writePngCard, read as readPngCard } from '../../../src/character-card-parser.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

const ASH_NAME = 'Ash the Cartographer';

const BRIALLEN_NAME = 'Briallen the Lighthouse Keeper';
const BRIALLEN_DESCRIPTION = 'A weathered keeper of the eastern light, raised on the rocks beyond the reef. She knows every tide and every name carved into the lantern base.';

// Note: character-card-parser.write() always injects a ccv3 chunk with
// spec=chara_card_v3, so even a spec-less payload is stored through the
// V2/V3 path and unsetPrivateFields strips its chat. The persisted-chat
// gap needs a format whose import mints a non-empty stamp (V1 PNG, YAML,
// BYAF) — the clobber test below uses a YAML replacement for that reason.
function buildBriallenPng(seedPng) {
    const payload = {
        name: BRIALLEN_NAME,
        description: BRIALLEN_DESCRIPTION,
        personality: 'Patient. Sees patterns. Suspicious of unfamiliar lights at sea.',
        scenario: 'You climb the spiral stair as Briallen trims the wick.',
        first_mes: '*Briallen does not turn from the lantern.* "Close the hatch."',
        mes_example: '',
        creator_notes: 'e2e fixture — replace-chat-pointer',
        system_prompt: 'You are Briallen. Stay in scene.',
        post_history_instructions: '',
        alternate_greetings: [],
        tags: ['rp', 'fixture'],
        creator: 'luker-e2e',
        character_version: '1.0',
    };
    return writePngCard(seedPng, JSON.stringify(payload));
}

function readCardDataFromDisk(charsDir, expectedName) {
    const pngs = readdirSync(charsDir).filter(f => f.endsWith('.png'));
    for (const png of pngs) {
        try {
            const meta = JSON.parse(readPngCard(readFileSync(resolve(charsDir, png))));
            const name = meta?.data?.name || meta?.name || '';
            if (name === expectedName) return { filename: png, meta };
        } catch { /* skip non-card PNGs */ }
    }
    return null;
}

function listJsonlFiles(root) {
    const found = [];
    if (!existsSync(root)) return found;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        const full = resolve(root, entry.name);
        if (entry.isDirectory()) found.push(...listJsonlFiles(full));
        else if (entry.name.endsWith('.jsonl')) found.push(full);
    }
    return found;
}

async function openReplaceWithFile(page, pngPath) {
    // Open the More dropdown, fire 'replace_update'. The change handler
    // pops a confirm popup with two custom buttons (URL / File).
    await page.evaluate(() => {
        const sel = document.querySelector('#char-management-dropdown');
        if (!sel) throw new Error('#char-management-dropdown not found');
        const opt = sel.querySelector('#replace_update');
        if (!opt) throw new Error('#replace_update option not found');
        opt.selected = true;
        if (window.jQuery) window.jQuery(sel).trigger('change');
        else sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    // First popup: choose "Replace with File".
    const firstPopup = page.locator('dialog.popup[open]').last();
    await firstPopup.waitFor({ state: 'visible', timeout: 5000 });
    const fileBtn = firstPopup.locator('.popup-button-custom', { hasText: /Replace with File/i }).first();
    await fileBtn.click();
    await firstPopup.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    // The hidden input drives the real change handler.
    await page.locator('#character_replace_file').setInputFiles(pngPath);
}

async function waitForReplaceChoicePopup(page) {
    const popup = page.locator('dialog.popup[open]', {
        hasText: /Replace:|替换角色卡|替換角色卡/,
    }).last();
    await popup.waitFor({ state: 'visible', timeout: 20_000 });
    return popup;
}

async function cancelReplaceChoicePopup(page) {
    const popup = await waitForReplaceChoicePopup(page);
    const cancelBtn = popup.locator('.popup-button-cancel').first();
    await cancelBtn.click({ timeout: 5000 }).catch(() => {});
    await popup.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});
}

let mock, tmpDir, briallenPngPath, briallenYamlPath;

test.describe('#30 — replace keeps the active chat pointer', () => {
    test.beforeAll(async () => {
        mock = await startMockLLM({
            scriptedReplies: [
                '*Ash taps the chart with a knuckle.* "Then we wait for the tide to turn."',
            ],
        });
        tmpDir = mkdtempSync(resolve(tmpdir(), 'luker-e2e-replace-chat-pointer-'));
        const seed = readFileSync(resolve(REPO_ROOT, 'default/content/default_Seraphina.png'));
        briallenPngPath = resolve(tmpDir, 'briallen-replace.png');
        writeFileSync(briallenPngPath, buildBriallenPng(seed));
        // YAML import mints "<name> - <time>" into the stored card's chat
        // field (importFromYaml), so after a replace the PNG carries a
        // non-empty stamp the way V1 / BYAF imports do.
        briallenYamlPath = resolve(tmpDir, 'briallen-replace.yaml');
        writeFileSync(briallenYamlPath, [
            `name: ${BRIALLEN_NAME}`,
            `context: ${BRIALLEN_DESCRIPTION}`,
            'greeting: \'*Briallen does not turn from the lantern.* "Close the hatch."\'',
            'creator: luker-e2e',
            'tags:',
            '  - rp',
        ].join('\n'));
    });

    test.afterAll(async () => {
        await mock?.stop();
        if (tmpDir && existsSync(tmpDir)) {
            try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
        }
    });

    test('pointer survives the replace in memory, on disk, and across reload', async ({ page }) => {
        test.setTimeout(120_000);
        const server = await startServer({
            batchKey: 'character',
            scenarioId: 'replace-chat-pointer',
            extraConfig: { 'performance.lazyLoadCharacters': true },
        });
        try {
            markOnboarded({ dataRoot: server.dataRoot });
            disableTagImportPopup({ dataRoot: server.dataRoot });
            bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            writeEmbeddedCharacter({ dataRoot: server.dataRoot });

            await awaitMainUI(page, server.baseURL);
            await clickCharacterCard(page, ASH_NAME);
            await dismissAnyPopup(page);
            await openCharacterEditPanel(page);

            const userLine = 'The reef is quiet tonight — no drifters near the western marker.';
            await sendMessageAndAwaitReply(page, userLine);

            const before = await getChatSnapshot(page);
            expect(before.chatId, 'chat file name is set before replace').toBeTruthy();
            expect(before.messages?.length, 'chat has first_mes + user + reply').toBeGreaterThanOrEqual(3);

            const mergePointerWrites = [];
            page.on('request', req => {
                if (!req.url().includes('/api/characters/merge-attributes')) return;
                try {
                    const body = req.postDataJSON();
                    if (body?.chat != null) mergePointerWrites.push(String(body.chat));
                } catch { /* non-JSON body */ }
            });

            await openReplaceWithFile(page, briallenPngPath);
            await expect(page.locator('.toast.toast-success', { hasText: 'Character Replaced' }).first())
                .toBeVisible({ timeout: 20_000 });
            await cancelReplaceChoicePopup(page);

            // ── Durable pointer: the PNG on disk must name the chat that
            // was open before the replace, not the V1 import's minted stamp.
            const charsDir = resolve(server.dataRoot, 'default-user', 'characters');
            await expect.poll(() => {
                const onDisk = readCardDataFromDisk(charsDir, BRIALLEN_NAME);
                return onDisk?.meta?.chat || '';
            }, { timeout: 10_000 }).toBe(before.chatId);

            // ── In-memory pointer must match too.
            const afterReplace = await page.evaluate(() => {
                const ctx = window.Luker.getContext();
                return {
                    chatId: ctx.getCurrentChatId?.(),
                    pole: document.querySelector('#selected_chat_pole')?.value || '',
                };
            });
            expect(afterReplace.chatId, 'in-memory pointer after replace').toBe(before.chatId);
            expect(afterReplace.pole, 'selected-chat pole after replace').toBe(before.chatId);

            // ── Next open (reload + click) must land on the same chat and
            // render the conversation it had, not a fresh first_mes chat.
            await reloadAndAwait(page, server.baseURL);
            await selectCharacterByName(page, BRIALLEN_NAME);
            await dismissAnyPopup(page);

            const afterReload = await getChatSnapshot(page);
            expect(afterReload.chatId, 'pointer after reload').toBe(before.chatId);
            const rendered = await getRenderedChatTexts(page);
            expect(rendered.join('\n'), 'conversation still rendered after reload').toContain(userLine);
        } finally {
            await tearDownServer(server);
        }
    });

    test('a dropped pointer persist write must not cost the open chat on next open', async ({ page }) => {
        test.setTimeout(120_000);
        const server = await startServer({
            batchKey: 'character',
            scenarioId: 'replace-chat-pointer-drop-persist',
            extraConfig: { 'performance.lazyLoadCharacters': true },
        });
        try {
            markOnboarded({ dataRoot: server.dataRoot });
            disableTagImportPopup({ dataRoot: server.dataRoot });
            bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            writeEmbeddedCharacter({ dataRoot: server.dataRoot });

            await awaitMainUI(page, server.baseURL);
            await clickCharacterCard(page, ASH_NAME);
            await dismissAnyPopup(page);
            await openCharacterEditPanel(page);

            const userLine = 'The gulls went inland an hour before the light failed.';
            await sendMessageAndAwaitReply(page, userLine);
            const before = await getChatSnapshot(page);
            expect(before.chatId, 'chat file name is set before replace').toBeTruthy();

            // Drop exactly one pointer persist write — the observable
            // failure of a congested tunnel during the post-import window.
            let droppedPointerWrites = 0;
            await page.route('**/api/characters/merge-attributes', async route => {
                let body = null;
                try { body = route.request().postDataJSON(); } catch { /* non-JSON body */ }
                if (body?.chat != null && droppedPointerWrites === 0) {
                    droppedPointerWrites++;
                    await route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"injected pointer-write drop"}' });
                    return;
                }
                await route.continue();
            });

            await openReplaceWithFile(page, briallenPngPath);
            await expect(page.locator('.toast.toast-success', { hasText: 'Character Replaced' }).first())
                .toBeVisible({ timeout: 20_000 });
            await cancelReplaceChoicePopup(page);
            expect(droppedPointerWrites, 'the pointer persist write was actually dropped once').toBe(1);

            // The popup promises "All chats ... will be preserved". The
            // next open must land on the same chat even though the one
            // persist write was lost.
            await reloadAndAwait(page, server.baseURL);
            await selectCharacterByName(page, BRIALLEN_NAME);
            await dismissAnyPopup(page);

            const afterReload = await getChatSnapshot(page);
            expect(afterReload.chatId, 'chat reopened after a dropped pointer write').toBe(before.chatId);
            const rendered = await getRenderedChatTexts(page);
            expect(rendered.join('\n'), 'conversation still rendered after reload').toContain(userLine);
        } finally {
            await tearDownServer(server);
        }
    });

    test('the post-replace event refresh must not clobber the live pointer when its direct fetch fails', async ({ page }) => {
        test.setTimeout(120_000);
        const server = await startServer({
            batchKey: 'character',
            scenarioId: 'replace-chat-pointer-emit-fallback',
            extraConfig: { 'performance.lazyLoadCharacters': true },
        });
        try {
            markOnboarded({ dataRoot: server.dataRoot });
            disableTagImportPopup({ dataRoot: server.dataRoot });
            bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            writeEmbeddedCharacter({ dataRoot: server.dataRoot });

            await awaitMainUI(page, server.baseURL);
            await clickCharacterCard(page, ASH_NAME);
            await dismissAnyPopup(page);
            await openCharacterEditPanel(page);

            const userLine = 'The drifters took the eastern channel. We should move the light.';
            await sendMessageAndAwaitReply(page, userLine);
            const before = await getChatSnapshot(page);
            expect(before.chatId, 'chat file name is set before replace').toBeTruthy();

            // Compound failure for the emit fallback: the pointer persist
            // write is dropped (PNG keeps the V1 import's minted stamp,
            // which is non-empty) and the emit() direct refresh dies
            // mid-body while the getOneCharacter fallback refresh is
            // allowed through. The fallback must not hand the persisted
            // stamp back as the live pointer.
            let droppedPointerWrites = 0;
            const pointerWrites = [];
            await page.route('**/api/characters/merge-attributes', async route => {
                let body = null;
                try { body = route.request().postDataJSON(); } catch { /* non-JSON body */ }
                if (body?.chat != null) {
                    pointerWrites.push(String(body.chat));
                    if (droppedPointerWrites === 0) {
                        droppedPointerWrites++;
                        await route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"injected pointer-write drop"}' });
                        return;
                    }
                }
                await route.continue();
            });
            let refreshRequests = 0;
            await page.route('**/api/characters/get', async route => {
                refreshRequests++;
                if (refreshRequests === 2) {
                    await route.fulfill({
                        status: 200,
                        contentType: 'application/json',
                        body: '{"spec":"chara_card_v2","spec_version":"2.0","data":{"name":"Bri',
                    });
                    return;
                }
                await route.continue();
            });

            await openReplaceWithFile(page, briallenYamlPath);
            await expect(page.locator('.toast.toast-success', { hasText: 'Character Replaced' }).first())
                .toBeVisible({ timeout: 20_000 });
            await cancelReplaceChoicePopup(page);
            expect(droppedPointerWrites, 'the pointer persist write was actually dropped once').toBe(1);
            expect(refreshRequests, 'the refresh sequence ran unshallow -> emit -> fallback').toBeGreaterThanOrEqual(2);

            const afterReplace = await page.evaluate(() => {
                const ctx = window.Luker.getContext();
                return {
                    chatId: ctx.getCurrentChatId?.(),
                    pole: document.querySelector('#selected_chat_pole')?.value || '',
                };
            });
            expect(afterReplace.chatId, 'in-memory pointer survives the emit fallback refresh').toBe(before.chatId);
            expect(afterReplace.pole, 'selected-chat pole survives the emit fallback refresh').toBe(before.chatId);
        } finally {
            await tearDownServer(server);
        }
    });

    test('a fresh import without a chat still starts its first chat on open', async ({ page }) => {
        test.setTimeout(120_000);
        const server = await startServer({
            batchKey: 'character',
            scenarioId: 'replace-chat-pointer-fresh-import',
            extraConfig: { 'performance.lazyLoadCharacters': true },
        });
        try {
            markOnboarded({ dataRoot: server.dataRoot });
            disableTagImportPopup({ dataRoot: server.dataRoot });
            bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

            await awaitMainUI(page, server.baseURL);
            await importCharacterFile(page, { filePath: briallenPngPath, expectedName: BRIALLEN_NAME });
            await dismissAnyPopup(page);

            await clickCharacterCard(page, BRIALLEN_NAME);
            await dismissAnyPopup(page);

            const chatsDir = resolve(server.dataRoot, 'default-user', 'chats');
            await expect.poll(() => listJsonlFiles(chatsDir).length, { timeout: 20_000 })
                .toBeGreaterThanOrEqual(1);

            const snapshot = await getChatSnapshot(page);
            expect(snapshot.chatId, 'opening a fresh import starts a chat').toBeTruthy();
            await expect.poll(async () => (await getRenderedChatTexts(page)).join('\n'), { timeout: 20_000 })
                .toContain('Close the hatch');
        } finally {
            await tearDownServer(server);
        }
    });
});
