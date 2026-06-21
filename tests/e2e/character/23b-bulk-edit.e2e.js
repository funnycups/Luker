// #23b — Bulk edit characters via the real bulk-edit UI.
//
// Real flow:
//   1. seed 3 characters via fs fixture (writeEmbeddedCharacter)
//   2. click #bulkEditButton to enable bulk-select mode
//   3. tick the .bulk_select_checkbox on the two we want to delete
//   4. click #bulkDeleteButton → tick "Also delete chat files" → OK
//   5. only the survivor remains on disk
//   6. restart, confirm survivor still there
//
// Bulk-tag is a context-menu flow (right-click on a selected card)
// that ST's headless browser cannot easily exercise without keyboard
// modifiers + popup state — covered by other tests; this spec focuses
// on the load-bearing bulk-delete path.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded, listCharacters } from '../_lib/fixtures.js';
import { disableTagImportPopup, dismissAnyPopup, clickCharacterCard, writeEmbeddedCharacter } from './_helpers.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';

let server, mock;
let av1, av2, av3;

const ASH_NAME = 'Ash the Cartographer';
const BRYN_NAME = 'Bryn the Reefwarden';
const CAEL_NAME = 'Cael of the Causeway';

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({ batchKey: 'character', scenarioId: 'bulk-edit' });
    markOnboarded({ dataRoot: server.dataRoot });
    disableTagImportPopup({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    av1 = writeEmbeddedCharacter({ dataRoot: server.dataRoot, avatarFile: 'ash.png', overrides: { name: ASH_NAME } });
    av2 = writeEmbeddedCharacter({ dataRoot: server.dataRoot, avatarFile: 'bryn.png', overrides: { name: BRYN_NAME } });
    av3 = writeEmbeddedCharacter({ dataRoot: server.dataRoot, avatarFile: 'cael.png', overrides: { name: CAEL_NAME } });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#23b — Bulk delete via UI', () => {
    test('bulk-edit toggle + tick checkboxes + bulk-delete keeps only the un-ticked card', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        // Wait for all three seeded characters to appear in the list.
        await page.waitForFunction(() => {
            const ctx = window.Luker?.getContext?.();
            const names = (ctx?.characters || []).map(c => c?.name).filter(Boolean);
            return ['Ash the Cartographer', 'Bryn the Reefwarden', 'Cael of the Causeway'].every(n => names.includes(n));
        }, { timeout: 20_000 });

        // Click the card-list panel first to make sure the bulk button
        // is visible. clickCharacterCard puts us in edit mode; instead
        // we just need the list to be visible. Click any card to
        // populate the right drawer panel, then go back to list.
        await clickCharacterCard(page, ASH_NAME);
        await dismissAnyPopup(page);
        // Navigate back to the characters list view so #bulkEditButton
        // is visible.
        await page.evaluate(async () => {
            const mod = await import('/script.js');
            if (typeof mod.printCharacters === 'function') {
                document.querySelector('#rm_button_characters')?.click();
                await mod.printCharacters(true);
            }
        });
        await page.waitForFunction(() => {
            const parent = document.querySelector('#rm_characters_block');
            if (!parent) return false;
            return window.getComputedStyle(parent).display !== 'none';
        }, { timeout: 10_000 });
        await page.waitForTimeout(300);

        // Enable bulk-edit mode via #bulkEditButton.
        await page.locator('#bulkEditButton').click();
        // Bulk-select checkboxes appear on each card. Wait for them.
        await page.waitForFunction(() => {
            return document.querySelectorAll('#rm_print_characters_block .bulk_select_checkbox').length > 0;
        }, { timeout: 5000 });

        // Tick Bryn and Cael (delete them, keep Ash).
        // Cards are keyed by chid or data-chid attribute on the
        // .character_select element. Resolve each card by walking the
        // DOM in the page context and click its bulk_select_checkbox.
        const tickResult = await page.evaluate((avatars) => {
            const ctx = window.Luker.getContext();
            const cards = Array.from(document.querySelectorAll('#rm_print_characters_block .character_select'));
            const out = [];
            for (const wantAvatar of avatars) {
                const chid = ctx.characters.findIndex(c => c?.avatar === wantAvatar);
                // The card's `chid` may live as a plain attribute OR a
                // jQuery .data() value (not reflected to DOM). Try the
                // attribute path first, fall back to scanning by
                // .ch_name's data-grid / title.
                let target = cards.find(card =>
                    card.getAttribute('chid') === String(chid) ||
                    card.getAttribute('data-chid') === String(chid));
                if (!target) {
                    // Some builds keep chid via jQuery data and stamp
                    // the avatar on the inner thumbnail. Match by
                    // ctx.characters[chid].name displayed in .ch_name.
                    const ch = ctx.characters[chid];
                    if (ch?.name) {
                        target = cards.find(card => {
                            const name = card.querySelector('.ch_name')?.textContent?.trim();
                            return name === ch.name;
                        });
                    }
                }
                if (!target) {
                    out.push({ avatar: wantAvatar, ok: false, reason: 'no matching card' });
                    continue;
                }
                const cb = target.querySelector('.bulk_select_checkbox');
                if (!cb) {
                    out.push({ avatar: wantAvatar, ok: false, reason: 'no checkbox' });
                    continue;
                }
                cb.click();
                out.push({ avatar: wantAvatar, ok: true, checked: cb.checked });
            }
            return out;
        }, [av2, av3]);
        for (const r of tickResult) {
            expect(r.ok, `tick ${r.avatar}: ${r.reason || ''}`).toBe(true);
        }

        // Click #bulkDeleteButton → handle the confirm popup (which
        // includes a "Also delete chat files" checkbox + OK).
        await page.locator('#bulkDeleteButton').click();
        const popup = page.locator('dialog.popup[open]').last();
        await popup.waitFor({ state: 'visible', timeout: 5000 });
        const delChats = popup.locator('#del_char_checkbox');
        if (await delChats.isVisible({ timeout: 500 }).catch(() => false)) {
            await delChats.check().catch(() => {});
        }
        await popup.locator('.popup-button-ok').first().click();
        await popup.waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {});

        // Wait for both Bryn and Cael to be gone from ctx.
        await page.waitForFunction(({ avatars }) => {
            const ctx = window.Luker?.getContext?.();
            const all = (ctx?.characters || []).map(c => c?.avatar);
            return !avatars.some(a => all.includes(a));
        }, { avatars: [av2, av3] }, { timeout: 20_000 });

        // Verify on disk.
        const afterDelete = listCharacters({ dataRoot: server.dataRoot });
        expect(afterDelete).toContain(av1);
        expect(afterDelete).not.toContain(av2);
        expect(afterDelete).not.toContain(av3);

        // Restart + verify Ash is the only survivor.
        await server.restart();
        await reloadAndAwait(page, server.baseURL);

        const namesAfterRestart = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return (ctx.characters || []).map(c => c?.name);
        });
        expect(namesAfterRestart).toContain(ASH_NAME);
        expect(namesAfterRestart).not.toContain(BRYN_NAME);
        expect(namesAfterRestart).not.toContain(CAEL_NAME);
    });
});
