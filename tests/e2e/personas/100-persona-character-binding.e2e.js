// #100 — Bind persona A to Char1 and persona B to Char2; switching the
// active character must auto-switch the persona. Bindings must survive a
// server restart.
//
// Driving notes (same constraints as #99):
//
//  * Characters need PNG-chunked card data; the shared writeCharacter
//    fixture writes only sidecar JSON which the server ignores.
//
//  * `/persona-create` cannot run in this worktree because the default-
//    avatar upload path hits squoosh WASM-via-file:// rejected by
//    fetch-patch (node_modules is symlinked outside the worktree).
//    Personas are pre-seeded via `_helpers.js#preseedPersona`.
//
//  * Activation goes through `setUserAvatar()` — the same entry point
//    `/persona-set` funnels into.
//
//  * Character-locking goes through the slash command `/persona-lock
//    type=character on`, which sets `power_user.persona_descriptions[
//    avatar].connections` (no avatar upload). That state is written to
//    settings.json and rehydrated after restart.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait, selectCharacterByName } from '../_lib/page.js';
import { writeCharacterWithChunks, preseedPersona } from './_helpers.js';

let server, mock;
const PERSONA_A_ID = 'persona-a-e2e.png';
const PERSONA_B_ID = 'persona-b-e2e.png';

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [
        '*Ash narrows her eyes at the dark line of breakers.* "The tide is still settling. Stay close."',
        '*Bryn keeps the lantern trim, her hands steady on the brass.* "Speak quietly. The cliff carries voices."',
    ] });
    server = await startServer({ batchKey: 'personas', scenarioId: 'bind-char' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    // Two distinct characters with proper PNG-chunk card data.
    writeCharacterWithChunks({ dataRoot: server.dataRoot, avatarFile: 'char-ash.png', overrides: { name: 'Char1Ash' } });
    writeCharacterWithChunks({ dataRoot: server.dataRoot, avatarFile: 'char-bryn.png', overrides: { name: 'Char2Bryn' } });
    // Two personas pre-stamped into settings.json.
    preseedPersona({ dataRoot: server.dataRoot, avatarId: PERSONA_A_ID, name: 'PersonaA', description: 'A quiet north-coast surveyor.' });
    preseedPersona({ dataRoot: server.dataRoot, avatarId: PERSONA_B_ID, name: 'PersonaB', description: 'A southern-reef pilot, slow and patient.' });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#100 — persona auto-switches with character + bindings persist', () => {
    test('bind A->Char1, B->Char2; switching character flips persona; survives restart', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Bind PersonaA to Char1Ash. The character-lock path pops a
        // confirmation modal ("Keep Global?") for any persona that lives
        // in the global persona store; auto-click "Keep Global" so the
        // slash command can complete.
        await selectCharacterByName(page, 'Char1Ash');
        await page.waitForFunction(() => {
            const ctx = window.SillyTavern.getContext();
            const cid = Number(ctx.characterId);
            return Number.isFinite(cid) && ctx.characters[cid]?.name === 'Char1Ash';
        }, { timeout: 10_000 });
        await page.evaluate(async (avatarId) => {
            const mod = await import('/scripts/personas.js');
            await mod.setUserAvatar(avatarId);
            const ctx = window.SillyTavern.getContext();
            // Auto-click any incoming "Keep Global Persona?" popup.
            const observer = new MutationObserver(() => {
                for (const btn of document.querySelectorAll('.popup .persona-binding-popup-button')) {
                    if (/Keep Global/i.test(btn.textContent || '')) {
                        btn.click();
                        observer.disconnect();
                        break;
                    }
                }
            });
            observer.observe(document.body, { childList: true, subtree: true });
            try {
                await ctx.executeSlashCommandsWithOptions('/persona-lock type=character on');
            } finally {
                observer.disconnect();
            }
        }, PERSONA_A_ID);

        // Bind PersonaB to Char2Bryn. Use selectCharacterById here because
        // after PersonaA was bound the right drawer flipped to the character
        // editor — selectCharacterByName's rm_print_characters_block becomes
        // hidden.
        await page.evaluate(async () => {
            const ctx = window.SillyTavern.getContext();
            const idx = ctx.characters.findIndex(c => c?.name === 'Char2Bryn');
            await ctx.selectCharacterById(idx);
        });
        await page.waitForFunction(() => {
            const ctx = window.SillyTavern.getContext();
            const cid = Number(ctx.characterId);
            return Number.isFinite(cid) && ctx.characters[cid]?.name === 'Char2Bryn';
        }, { timeout: 10_000 });
        await page.evaluate(async (avatarId) => {
            const mod = await import('/scripts/personas.js');
            await mod.setUserAvatar(avatarId);
            const ctx = window.SillyTavern.getContext();
            const observer = new MutationObserver(() => {
                for (const btn of document.querySelectorAll('.popup .persona-binding-popup-button')) {
                    if (/Keep Global/i.test(btn.textContent || '')) {
                        btn.click();
                        observer.disconnect();
                        break;
                    }
                }
            });
            observer.observe(document.body, { childList: true, subtree: true });
            try {
                await ctx.executeSlashCommandsWithOptions('/persona-lock type=character on');
            } finally {
                observer.disconnect();
            }
        }, PERSONA_B_ID);

        // Sanity: switch to Char1 -> persona auto-flips to A. Bypass the
        // DOM-driven selectCharacterByName because after a multi-bind
        // session the right nav drawer ends up on the character editor
        // panel and the .character_select list is hidden.
        await page.evaluate(async () => {
            const ctx = window.SillyTavern.getContext();
            const idx = ctx.characters.findIndex(c => c?.name === 'Char1Ash');
            await ctx.selectCharacterById(idx);
        });
        await page.waitForFunction(() => window.SillyTavern.getContext().name1 === 'PersonaA', { timeout: 10_000 });
        expect(await page.evaluate(() => window.SillyTavern.getContext().name1)).toBe('PersonaA');

        // Switch to Char2 -> auto-flip to B.
        await page.evaluate(async () => {
            const ctx = window.SillyTavern.getContext();
            const idx = ctx.characters.findIndex(c => c?.name === 'Char2Bryn');
            await ctx.selectCharacterById(idx);
        });
        await page.waitForFunction(() => window.SillyTavern.getContext().name1 === 'PersonaB', { timeout: 10_000 });
        expect(await page.evaluate(() => window.SillyTavern.getContext().name1)).toBe('PersonaB');

        // Restart server. Bindings live on the character card extension JSON
        // on disk plus power_user.personas / persona_descriptions[].connections
        // in settings.json — both should survive a kill/respawn.
        await server.restart();
        await reloadAndAwait(page, server.baseURL);

        await page.evaluate(async () => {
            const ctx = window.SillyTavern.getContext();
            const idx = ctx.characters.findIndex(c => c?.name === 'Char1Ash');
            await ctx.selectCharacterById(idx);
        });
        await page.waitForFunction(() => window.SillyTavern.getContext().name1 === 'PersonaA', { timeout: 15_000 });
        expect(await page.evaluate(() => window.SillyTavern.getContext().name1)).toBe('PersonaA');

        await page.evaluate(async () => {
            const ctx = window.SillyTavern.getContext();
            const idx = ctx.characters.findIndex(c => c?.name === 'Char2Bryn');
            await ctx.selectCharacterById(idx);
        });
        await page.waitForFunction(() => window.SillyTavern.getContext().name1 === 'PersonaB', { timeout: 15_000 });
        expect(await page.evaluate(() => window.SillyTavern.getContext().name1)).toBe('PersonaB');
    });
});
