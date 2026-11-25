// #23 — Delete character via the real UI delete flow + verify the
// embedded skill cascade fires and the bound WI book persists on disk.
//
// Real flow:
//   1. seed Ash with a bound WI book via fs fixture
//   2. install a character-scope skill via ctx.skills.executeExtractEmbed
//      (the card import dialog path is covered by #38)
//   3. click into Ash → click #delete_button → tick confirm checkbox
//      → click popup OK
//   4. assert: card gone from list; WI book file still on disk
//   5. cascade: character-scope skills list is empty (or skill missing)

import { test, expect } from '../../harness/playwright.js';
import { resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded, writeWorldBook, BRYN_ENTRIES, listCharacters } from '../_lib/fixtures.js';
import { disableTagImportPopup, dismissAnyPopup, openCharacterEditPanel, clickCharacterCard, writeEmbeddedCharacter } from './_helpers.js';
import { awaitMainUI } from '../_lib/page.js';
import { deleteSelectedCharacter } from '../_lib/ui-character.js';

let server, mock, avatar, bookName, galleryDir, spritesDir;

const ASH_NAME = 'Ash the Cartographer';

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({});
    server = await startServer({ scope, batchKey: 'character', scenarioId: 'delete-cascade' });
    markOnboarded({ dataRoot: server.dataRoot });
    disableTagImportPopup({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    bookName = writeWorldBook({ dataRoot: server.dataRoot, name: 'bryn-headland', entries: BRYN_ENTRIES });
    avatar = writeEmbeddedCharacter({
        dataRoot: server.dataRoot,
        overrides: { extensions: { world: bookName } },
    });

    // Character-owned assets: chat image uploads land under
    // user/images/<name>/, expression sprites under characters/<name>/.
    // Both must go away with the card.
    galleryDir = resolve(server.dataRoot, 'default-user', 'user/images', ASH_NAME);
    spritesDir = resolve(server.dataRoot, 'default-user', 'characters', ASH_NAME);
    mkdirSync(galleryDir, { recursive: true });
    mkdirSync(spritesDir, { recursive: true });
    writeFileSync(resolve(galleryDir, 'ash-portrait.png'), Buffer.alloc(4_096));
    writeFileSync(resolve(spritesDir, 'happy.png'), Buffer.alloc(2_048));
});

test.afterAll(async () => {

    await mock?.stop();
});

test.describe('#23 — Delete character via UI — embedded skill cascade + WI book persists', () => {
    test('delete via #delete_button: character-scope skill is cascaded, bound WI book stays on disk', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Click into Ash via the card.
        await clickCharacterCard(page, ASH_NAME);
        await dismissAnyPopup(page);
        await openCharacterEditPanel(page);

        const charScope = { kind: 'character', characterFile: avatar };

        // Install a character-scope skill via the public skills API
        // (there's no user-facing UI for "install a skill from arbitrary
        // payload" — the card import dialog path is covered by #38).
        const installSummary = await page.evaluate(async ({ scope }) => {
            const ctx = window.Luker.getContext();
            if (!ctx.skills?.executeExtractEmbed) return { ok: false, reason: 'skills API not exposed' };
            const payload = {
                version: 1,
                items: [{
                    bundleFormat: 'inline-files-v1',
                    name: 'cartographer-protocol',
                    files: [{
                        path: 'SKILL.md',
                        encoding: 'utf8',
                        content: [
                            '---',
                            'name: cartographer-protocol',
                            'description: "Protocol for reading the reef chart"',
                            '---',
                            '',
                            'Body anchor: delete-cascade fixture v1.',
                        ].join('\n'),
                    }],
                }],
            };
            const result = await ctx.skills.executeExtractEmbed({ payload, targetScope: scope, conflictStrategies: {} });
            return { ok: true, result };
        }, { scope: charScope });

        // Install must succeed; the skills API is part of the public
        // ctx surface that this test depends on. If install fails, that's
        // a real product/setup bug — fail loud instead of skipping.
        expect(installSummary.ok, `skills install failed: ${installSummary.reason}`).toBe(true);

        // Confirm skill is present pre-delete.
        const beforeSkills = await page.evaluate(async (scope) => {
            const ctx = window.Luker.getContext();
            const list = await ctx.skills.list({ scope });
            return (list || []).map(s => s.name);
        }, charScope);
        expect(beforeSkills, 'character-scope skill installed').toContain('cartographer-protocol');
        const skillDir = resolve(server.dataRoot, 'default-user', 'skills', 'character', avatar, 'cartographer-protocol');
        expect(existsSync(skillDir), 'character-scope skill directory on disk before delete').toBe(true);

        // Confirm WI book on disk pre-delete.
        const bookPath = resolve(server.dataRoot, 'default-user', 'worlds', `${bookName}.json`);
        expect(existsSync(bookPath), 'WI book on disk before delete').toBe(true);
        const bookBefore = JSON.parse(readFileSync(bookPath, 'utf8'));

        // ── DELETE VIA UI: click trash icon → tick "Also delete the
        //    chat files" checkbox → click OK. ────────────────────────
        await deleteSelectedCharacter(page);
        // The media preview dialog opens after the confirm popup; both
        // planted assets are pre-selected, confirm them.
        await page.locator('.mediaDeletionConfirm').click();
        await expect(page.locator('.mediaDeletionDialog')).toBeHidden();
        // The shared helper handles the checkbox + OK click. Wait for
        // CHARACTER_DELETED to propagate.
        await page.waitForFunction((wantAvatar) => {
            const ctx = window.Luker?.getContext?.();
            return !(ctx?.characters || []).some(c => c?.avatar === wantAvatar);
        }, avatar, { timeout: 15_000 });

        // ── DOM assertion: card gone from list. ─────────────────────
        const remainingCards = await page.evaluate((wantAvatar) => {
            const ctx = window.Luker.getContext();
            return (ctx.characters || []).filter(c => c?.avatar === wantAvatar).length;
        }, avatar);
        expect(remainingCards, 'Ash gone from ctx.characters').toBe(0);

        const serverDeleted = !listCharacters({ dataRoot: server.dataRoot }).includes(avatar);
        expect(serverDeleted, 'avatar file gone from disk after delete').toBe(true);

        // Character-owned asset files (chat images + expression sprites)
        // go with the card. The media delete request runs after the card
        // leaves the list, so wait for the files to disappear.
        await expect.poll(() => existsSync(resolve(galleryDir, 'ash-portrait.png')), { message: 'gallery file removed with character', timeout: 10_000 }).toBe(false);
        await expect.poll(() => existsSync(resolve(spritesDir, 'happy.png')), { message: 'sprite file removed with character', timeout: 10_000 }).toBe(false);

        // CHARACTER_DELETED fires once the undo-toast window (default
        // 5000ms) expires and commitDeletedCharacterUndoSnapshot runs; the
        // cascade then deletes the character-scope skill directory.
        await expect.poll(() => existsSync(skillDir), { timeout: 20_000 }).toBe(false);
        const afterSkills = await page.evaluate(async (scope) => {
            const ctx = window.Luker.getContext();
            const list = await ctx.skills.list({ scope });
            return list.map(s => s.name);
        }, charScope);
        expect(afterSkills, 'cascade removed character-scope skill').not.toContain('cartographer-protocol');

        // WI book is preserved on disk — only the binding is gone.
        expect(existsSync(bookPath), 'bound WI book is preserved after delete').toBe(true);
        const bookAfter = JSON.parse(readFileSync(bookPath, 'utf8'));
        expect(Object.keys(bookAfter.entries)).toHaveLength(Object.keys(bookBefore.entries).length);
    });
});
