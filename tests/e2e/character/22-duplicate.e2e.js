// #22 — Duplicate character via the real #dupe_button.
//
// Seed Ash, click into her, click the duplicate icon, verify a new
// "Ash_1" (or whatever the suffix) card appears. Edit Ash's
// description via the UI; verify the dup's description is unchanged.
// Restart; both persist independently.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded, listCharacters } from '../_lib/fixtures.js';
import { disableTagImportPopup, dismissAnyPopup, openCharacterEditPanel, clickCharacterCard, writeEmbeddedCharacter } from './_helpers.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';

let server, mock, avatar;

const ASH_NAME = 'Ash the Cartographer';
const MODIFIED_DESC = 'EDITED IN ASH ONLY: a brass spyglass and a second smaller scope for the inland reefs.';

/**
 * Duplicate the currently-selected character via the visible
 * #dupe_button. Handles the confirm popup explicitly (the bundled
 * helper in _lib/ui-character.js waits only 1.5s for the popup, which
 * is sometimes too short on cold-start). Returns the new card's avatar
 * filename — display names duplicate-as-is because the server only
 * appends `_<n>` to the file path (server-side characters.js#duplicate),
 * not to the card's `name` field.
 */
async function duplicateSelectedViaUI(page, { timeoutMs = 20_000 } = {}) {
    const beforeAvatars = await page.evaluate(() => {
        const ctx = window.Luker.getContext();
        return (ctx.characters || []).map(c => c?.avatar).filter(Boolean);
    });
    await page.locator('#dupe_button').click();
    const popup = page.locator('dialog.popup[open]').last();
    await popup.waitFor({ state: 'visible', timeout: 8000 });
    await popup.locator('.popup-button-ok').first().click();
    await popup.waitFor({ state: 'detached', timeout: 8000 }).catch(() => {});
    // Wait for the new avatar to land in ctx.characters.
    await page.waitForFunction((before) => {
        const ctx = window.Luker?.getContext?.();
        if (!ctx?.characters) return false;
        const all = ctx.characters.map(c => c?.avatar).filter(Boolean);
        return all.length > before.length;
    }, beforeAvatars, { timeout: timeoutMs });
    const afterAvatars = await page.evaluate(() => {
        const ctx = window.Luker.getContext();
        return (ctx.characters || []).map(c => c?.avatar).filter(Boolean);
    });
    return afterAvatars.find(a => !beforeAvatars.includes(a));
}

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({ batchKey: 'character', scenarioId: 'duplicate' });
    markOnboarded({ dataRoot: server.dataRoot });
    disableTagImportPopup({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    avatar = writeEmbeddedCharacter({ dataRoot: server.dataRoot });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#22 — Duplicate character via UI — no cross-pollution', () => {
    test('duplicate icon spawns a copy; editing source does not touch dup; both persist across restart', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        await clickCharacterCard(page, ASH_NAME);
        await dismissAnyPopup(page);
        await openCharacterEditPanel(page);

        const beforeCount = await page.locator('#rm_print_characters_block .character_select').count();

        // Click duplicate (#dupe_button) + accept confirm popup.
        const dupAvatar = await duplicateSelectedViaUI(page);
        expect(dupAvatar, 'duplicate produced a new avatar').toBeTruthy();
        await dismissAnyPopup(page);

        const afterCount = await page.locator('#rm_print_characters_block .character_select').count();
        expect(afterCount).toBe(beforeCount + 1);

        // Both files exist on disk.
        const onDisk = listCharacters({ dataRoot: server.dataRoot });
        expect(onDisk).toContain(avatar);
        // Dup file lives under a name like "ash-the-cartographer_1.png".
        expect(onDisk).toContain(dupAvatar);

        // Now edit Ash's description via UI. Click Ash (by avatar so we
        // don't accidentally grab the duplicate), edit, blur, save.
        // Wait for the CHARACTER_EDITED event so we know the debounced
        // /api/characters/edit round-trip has completed before assertion.
        await clickCharacterCard(page, { avatar });
        await dismissAnyPopup(page);
        await openCharacterEditPanel(page);
        const editedPromise = page.evaluate(() => new Promise((resolve, reject) => {
            const ctx = window.Luker.getContext();
            const t = setTimeout(() => reject(new Error('character edit timeout')), 30_000);
            const off = ctx.eventSource.on(ctx.eventTypes.CHARACTER_EDITED, () => {
                clearTimeout(t);
                try { ctx.eventSource.removeListener(ctx.eventTypes.CHARACTER_EDITED, off); } catch {}
                resolve(true);
            });
        }));
        await page.locator('#description_textarea').fill(MODIFIED_DESC);
        await page.locator('#description_textarea').blur();
        await editedPromise;

        // Re-read Ash's description from UI — should be MODIFIED_DESC.
        expect(await page.locator('#description_textarea').inputValue()).toBe(MODIFIED_DESC);

        // Click into the duplicate — its description should still be
        // the original Ash text.
        await clickCharacterCard(page, { avatar: dupAvatar });
        await dismissAnyPopup(page);
        await openCharacterEditPanel(page);
        const dupDesc = await page.locator('#description_textarea').inputValue();
        expect(dupDesc).toContain('wiry coastal cartographer'); // original
        expect(dupDesc).not.toBe(MODIFIED_DESC);

        // ── Persistence ─────────────────────────────────────────────────
        await server.restart();
        await reloadAndAwait(page, server.baseURL);

        await clickCharacterCard(page, { avatar });
        await dismissAnyPopup(page);
        await openCharacterEditPanel(page);
        expect(await page.locator('#description_textarea').inputValue()).toBe(MODIFIED_DESC);

        await clickCharacterCard(page, { avatar: dupAvatar });
        await dismissAnyPopup(page);
        await openCharacterEditPanel(page);
        expect(await page.locator('#description_textarea').inputValue()).toContain('wiry coastal cartographer');
    });
});
