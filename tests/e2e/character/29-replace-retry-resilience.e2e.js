// #29 — Replace flow resilience when the post-import character refresh
// fails, and retrying the same file afterwards.
//
// Two user-visible regressions in the "Replace / Update → Replace with
// File" flow:
//
//   1. After a successful import, the flow refreshes the active
//      character via POST /api/characters/get (unshallow). When that
//      response dies mid-body (200 received, truncated payload — e.g. a
//      flaky reverse-proxy tunnel carrying a multi-MB card),
//      `response.json()` rejects. The rejection used to propagate up
//      through `getCharacters → selectCharacterById → unshallowCharacter`
//      into `uploadReplacementCard`'s catch, surfacing a misleading
//      "Failed to replace the character card." error toast even though
//      the import itself had succeeded. The fix makes `getOneCharacter`
//      treat transport/parse failures as best-effort: warn and keep the
//      current data, so the replace flow (chat reload, post-replace
//      popup) continues.
//
//   2. The hidden `#character_replace_file` input kept its value after
//      the first replace. A browser fires no `change` event when the
//      user re-selects the exact same file, so the retry died silently.
//      The fix clears the input value up front.
//
// The transport failure is injected with a page route returning a 200
// whose JSON body is cut off — the same observable failure the user's
// tunnel produced. Everything else runs against a real server and a
// real browser, driving the real dropdown → popup → file-input path.
//
// The server is spawned with `lazyLoadCharacters: true` so characters
// arrive shallow and the replace flow actually issues the
// /api/characters/get refresh (as on the reported deployment).

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { disableTagImportPopup, dismissAnyPopup, clickCharacterCard, openCharacterEditPanel, writeEmbeddedCharacter } from './_helpers.js';
import { awaitMainUI } from '../_lib/page.js';
import { write as writePngCard } from '../../../src/character-card-parser.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

const ASH_NAME = 'Ash the Cartographer';
const ASH_AVATAR = 'ash-the-cartographer.png';

const BRIALLEN_NAME = 'Briallen the Lighthouse Keeper';
const BRIALLEN_DESCRIPTION = 'A weathered keeper of the eastern light, raised on the rocks beyond the reef. She knows every tide and every name carved into the lantern base.';

function buildBriallenPng(seedPng) {
    const data = {
        name: BRIALLEN_NAME,
        description: BRIALLEN_DESCRIPTION,
        personality: 'Patient. Sees patterns. Suspicious of unfamiliar lights at sea.',
        scenario: 'You climb the spiral stair as Briallen trims the wick.',
        first_mes: '*Briallen does not turn from the lantern.* "Close the hatch."',
        mes_example: '',
        creator_notes: 'e2e fixture — replace-refresh-resilience',
        system_prompt: 'You are Briallen. Stay in scene.',
        post_history_instructions: '',
        alternate_greetings: [],
        tags: ['rp', 'fixture'],
        creator: 'luker-e2e',
        character_version: '1.0',
        extensions: {},
    };
    const payload = {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        ...data,
        data,
    };
    return writePngCard(seedPng, JSON.stringify(payload));
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

let mock, tmpDir, briallenPngPath;

test.describe('#29 — replace flow failure resilience', () => {
    test.beforeAll(async () => {
        mock = await startMockLLM({});
        tmpDir = mkdtempSync(resolve(tmpdir(), 'luker-e2e-replace-resilience-'));
        const seed = readFileSync(resolve(REPO_ROOT, 'default/content/default_Seraphina.png'));
        briallenPngPath = resolve(tmpdir(), 'briallen-replace.png');
        writeFileSync(briallenPngPath, buildBriallenPng(seed));
    });

    test.afterAll(async () => {
        await mock?.stop();
        if (tmpDir && existsSync(tmpDir)) {
            try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
        }
    });

    test('post-import character refresh failing mid-body does not abort the replace flow with an error toast', async ({ page }) => {
        const server = await startServer({
            batchKey: 'character',
            scenarioId: 'replace-refresh-fault',
            extraConfig: { lazyLoadCharacters: true },
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

            // Inject the transport failure only now — after boot and the
            // initial character load — so the interception engages during
            // the replace flow instead of breaking the page boot.
            let refreshRequests = 0;
            await page.route('**/api/characters/get', async route => {
                refreshRequests++;
                const body = '{"spec":"chara_card_v2","spec_version":"2.0","data":{"name":"Bri';
                await route.fulfill({ status: 200, contentType: 'application/json', body });
            });

            let importRequests = 0;
            let chatGetRequests = 0;
            page.on('request', req => {
                const url = req.url();
                if (url.includes('/api/characters/import')) importRequests++;
                if (url.includes('/api/chats/get')) chatGetRequests++;
            });
            const pageErrors = [];
            page.on('pageerror', err => pageErrors.push(String(err)));

            const chatGetsBefore = chatGetRequests;
            await openReplaceWithFile(page, briallenPngPath);

            // The import itself succeeded: server 200 + the success toast.
            await expect(page.locator('.toast.toast-success', { hasText: 'Character Replaced' }).first())
                .toBeVisible({ timeout: 20_000 });

            // The fault fired: the unshallow refresh was actually attempted
            // against the truncated response. (The fix's diagnostic is a
            // console.warn, which the frontend log manager hides from the
            // devtools console unless debug logging is enabled — so the
            // behavioral assertions below are the real discriminators.)
            await expect.poll(() => refreshRequests, { timeout: 20_000 }).toBeGreaterThan(0);

            // The flow kept going: the previous chat is reloaded after the
            // replace, and the post-replace popup appears.
            await expect.poll(() => chatGetRequests, { timeout: 20_000 }).toBeGreaterThan(chatGetsBefore);
            const popup = await waitForReplaceChoicePopup(page);
            const cancelBtn = popup.locator('.popup-button-cancel').first();
            await cancelBtn.click({ timeout: 5000 }).catch(() => {});
            await popup.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});

            // No misleading failure toast, and nothing escaped as an
            // uncaught exception.
            await expect(page.locator('.toast.toast-error', { hasText: 'Failed to replace the character card' }))
                .toHaveCount(0);
            expect(pageErrors, `uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([]);

            // The import ran exactly once for this replace.
            expect(importRequests).toBe(1);

            // The replaced card is live: same avatar slot, new identity.
            await page.waitForFunction(({ avatar, want }) => {
                const ctx = window.Luker?.getContext?.();
                const idx = ctx?.characters?.findIndex?.(c => c?.avatar === avatar) ?? -1;
                const name = idx >= 0 ? ctx.characters[idx]?.data?.name : '';
                return String(name || '') === want;
            }, { avatar: ASH_AVATAR, want: BRIALLEN_NAME }, { timeout: 10_000 });
        } finally {
            await tearDownServer(server);
        }
    });

    test('retrying the exact same file after a successful replace issues a second import', async ({ page }) => {
        const server = await startServer({
            batchKey: 'character',
            scenarioId: 'replace-same-file-retry',
            extraConfig: { lazyLoadCharacters: true },
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

            let importRequests = 0;
            page.on('request', req => {
                if (req.url().includes('/api/characters/import')) importRequests++;
            });

            await openReplaceWithFile(page, briallenPngPath);
            const popup = await waitForReplaceChoicePopup(page);
            const cancelBtn = popup.locator('.popup-button-cancel').first();
            await cancelBtn.click({ timeout: 5000 }).catch(() => {});
            await popup.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});
            await expect.poll(() => importRequests, { timeout: 10_000 }).toBe(1);

            // The input must be empty now; a browser fires no change event
            // when the same file is re-selected into a non-empty input.
            expect(await page.locator('#character_replace_file').inputValue()).toBe('');

            // Re-select the exact same file through the same input — the
            // real retry gesture. setInputFiles with an unchanged value
            // fires no change event, so this only imports when the input
            // was cleared.
            await page.locator('#character_replace_file').setInputFiles(briallenPngPath);
            await expect.poll(() => importRequests, { timeout: 20_000 }).toBe(2);
        } finally {
            await tearDownServer(server);
        }
    });
});
