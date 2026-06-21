// #100 — Bind persona A to Char1 and persona B to Char2 via the real
// UI: click avatar cards in the persona panel and the lock-to-character
// pencil. Switching the active character must auto-switch the persona.
// Bindings must survive a server restart.
//
// Driving notes:
//
//  * Characters need PNG-chunked card data; the shared writeCharacter
//    fixture writes only sidecar JSON which the server ignores.
//
//  * `createDummyPersona` invokes Jimp/squoosh WASM via file:// URL which
//    is blocked by fetch-patch in this symlinked-node_modules worktree.
//    We pre-seed the personas on disk (raw PNG copy, no re-encode) and
//    drive the rest of the flow via real UI clicks.
//
//  * Character switching uses the real `.character_select` card click —
//    after binding a persona, the right-nav drawer is left on the
//    character editor panel, so a local helper clicks `#rm_button_back`
//    to navigate back to the character list before each card click.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';
import { selectPersonaByName } from '../_lib/ui-persona-preset.js';
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
    writeCharacterWithChunks({ dataRoot: server.dataRoot, avatarFile: 'char-ash.png', overrides: { name: 'Char1Ash' } });
    writeCharacterWithChunks({ dataRoot: server.dataRoot, avatarFile: 'char-bryn.png', overrides: { name: 'Char2Bryn' } });
    preseedPersona({ dataRoot: server.dataRoot, avatarId: PERSONA_A_ID, name: 'PersonaA', description: 'A quiet north-coast surveyor.' });
    preseedPersona({ dataRoot: server.dataRoot, avatarId: PERSONA_B_ID, name: 'PersonaB', description: 'A southern-reef pilot, slow and patient.' });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

/**
 * Open the persona-management drawer if closed. The persona button can be
 * overlaid by character-editor panels after a character is selected — we
 * dispatch the click via JS so the bound jQuery handler runs even when
 * the button isn't strictly the topmost element under the pointer.
 */
async function openPersonaPanelViaJsClick(page) {
    await page.waitForFunction(() => !!document.querySelector('#persona-management-button .drawer-toggle'), { timeout: 5000 });
    const isOpen = await page.evaluate(() => {
        const icon = document.querySelector('#persona-management-button .drawer-icon');
        return icon && icon.classList.contains('openIcon');
    });
    if (!isOpen) {
        await page.evaluate(() => {
            const toggle = document.querySelector('#persona-management-button .drawer-toggle');
            toggle?.click();
        });
    }
    await page.locator('#persona-management-block').waitFor({ state: 'visible', timeout: 5000 });
}

/**
 * Open the right-nav drawer (if closed), navigate back to the character
 * list if the drawer is on the character editor, then click the named
 * `.character_select` card. Returns once `ctx.characterId` reflects the
 * new selection.
 *
 * Implemented locally (not via `selectCharacterByName` from `_lib/page.js`)
 * because that helper does not handle the "drawer is open but stuck on
 * the editor panel" state — which is exactly the state we leave the UI
 * in after `#lock_persona_to_char`.
 */
async function selectCharacterCard(page, name) {
    // Dismiss any leftover persona-binding popup that may have survived
    // (e.g. clicking "Keep Global" triggered an animated transition that
    // the previous bindPersonaToCurrentCharacter didn't fully wait out).
    const bindingPopup = page.locator('.popup .persona-binding-popup-button', { hasText: /Keep Global|Character Only|Cancel/i }).first();
    if (await bindingPopup.isVisible({ timeout: 200 }).catch(() => false)) {
        // Click "Keep Global" if still up — same intent as the original
        // bind. If the popup is for a different operation, the cancel
        // fallback dismisses it without committing anything.
        const keep = page.locator('.popup .persona-binding-popup-button', { hasText: /Keep Global/i }).first();
        if (await keep.isVisible({ timeout: 200 }).catch(() => false)) {
            await keep.click().catch(() => {});
        } else {
            const cancel = page.locator('.popup .persona-binding-popup-button', { hasText: /Cancel/i }).first();
            if (await cancel.isVisible({ timeout: 200 }).catch(() => false)) {
                await cancel.click().catch(() => {});
            }
        }
        await bindingPopup.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    }

    // Close persona drawer if open (via JS click — handles overlay cases).
    const personaOpen = await page.evaluate(() => {
        const icon = document.querySelector('#persona-management-button .drawer-icon');
        return icon && icon.classList.contains('openIcon');
    });
    if (personaOpen) {
        await page.evaluate(() => {
            const toggle = document.querySelector('#persona-management-button .drawer-toggle');
            toggle?.click();
        });
        await page.waitForFunction(() => {
            const icon = document.querySelector('#persona-management-button .drawer-icon');
            return icon && icon.classList.contains('closedIcon');
        }, { timeout: 3000 }).catch(() => {});
    }

    // Dismiss any onboarding modal that might flash on first load.
    const onboardingHeader = page.locator('.popup', { hasText: /Welcome to Luker|歡迎使用|欢迎使用/ }).first();
    if (await onboardingHeader.isVisible().catch(() => false)) {
        await page.locator('.popup .popup-button-cancel, .popup .popup-button-ok').first().click().catch(() => {});
    }

    // Open the right-nav drawer.
    const drawerClosed = await page.locator('#rightNavDrawerIcon.closedIcon').count() > 0;
    if (drawerClosed) {
        await page.evaluate(() => {
            const i = document.querySelector('#rightNavDrawerIcon');
            const toggle = i?.closest('.drawer-toggle') || i;
            toggle?.click();
        });
        await page.waitForFunction(() => {
            const i = document.querySelector('#rightNavDrawerIcon');
            return i && i.classList.contains('openIcon');
        }, { timeout: 3000 }).catch(() => {});
    }

    // If on the editor panel, click the "Characters" button to return
    // to the character list. `#rm_button_back` is only visible in
    // create-new-character mode; editing an existing character hides
    // it (display:none). `#rm_button_characters` (the list icon in the
    // drawer's top bar) is always visible while the drawer is open and
    // navigates back to the list.
    const editorVisible = await page.evaluate(() => {
        const root = document.querySelector('#right-nav-panel');
        return root?.dataset?.menuType && root.dataset.menuType !== 'characters';
    });
    if (editorVisible) {
        // Dispatch the click via JS so overlays/animations don't block.
        // jQuery's delegated handler on #rm_button_characters is what
        // toggles the menu, and it responds to a synthetic .click().
        await page.evaluate(() => {
            const btn = document.querySelector('#rm_button_characters');
            btn?.click();
        });
        // Wait until the menu type flips to 'characters'.
        await page.waitForFunction(() => {
            const root = document.querySelector('#right-nav-panel');
            return root?.dataset?.menuType === 'characters';
        }, { timeout: 5000 }).catch(() => {});
    }

    const charBlock = page.locator('#rm_print_characters_block');
    await charBlock.waitFor({ state: 'visible', timeout: 10_000 });

    const card = charBlock.locator('.character_select', { hasText: name }).first();
    await card.waitFor({ state: 'visible', timeout: 10_000 });
    await card.click();

    // Wait for ctx.characterId to point at the new selection.
    await page.waitForFunction((wantName) => {
        const ctx = window.Luker.getContext();
        const cid = Number(ctx.characterId);
        return Number.isFinite(cid) && ctx.characters[cid]?.name === wantName;
    }, name, { timeout: 10_000 });
}

/**
 * Activate the persona by clicking its avatar card, then click the
 * lock-to-character pencil. The Keep Global vs Character Only confirm
 * popup appears — accept "Keep Global" via a real popup-button click so
 * the persona stays in the global store but with an added character
 * binding.
 */
async function bindPersonaToCurrentCharacter(page, personaName) {
    await openPersonaPanelViaJsClick(page);
    await selectPersonaByName(page, personaName);
    // Click the real lock-to-character button. togglePersonaLock('character')
    // surfaces a confirm popup for personas in the global persona store
    // ("Keep Global Persona?") — click that via the real
    // .persona-binding-popup-button.
    await page.locator('#lock_persona_to_char').click({ force: true });
    const keepGlobalBtn = page.locator('.popup .persona-binding-popup-button', { hasText: /Keep Global/i }).first();
    if (await keepGlobalBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await keepGlobalBtn.click();
        // Wait for the popup to actually close. Without this, the next
        // navigation gesture (selectCharacterCard) can race the popup's
        // dialog overlay and bail with "element not visible".
        await page.locator('.popup .persona-binding-popup-button', { hasText: /Keep Global/i }).first()
            .waitFor({ state: 'detached', timeout: 8_000 }).catch(() => {});
    }
    // Tiny settle for save debounce.
    await page.waitForTimeout(400);
}

test.describe('#100 — persona auto-switches with character + bindings persist', () => {
    test.describe.configure({ timeout: 300_000 });
    test('bind A->Char1, B->Char2 via real UI; switching character flips persona; survives restart', async ({ page }) => {
        test.setTimeout(300_000);
        await awaitMainUI(page, server.baseURL);

        // ── Bind PersonaA to Char1Ash via real card clicks ──
        await selectCharacterCard(page, 'Char1Ash');
        await bindPersonaToCurrentCharacter(page, 'PersonaA');

        // ── Bind PersonaB to Char2Bryn via real card clicks ──
        await selectCharacterCard(page, 'Char2Bryn');
        await bindPersonaToCurrentCharacter(page, 'PersonaB');

        // ── Sanity: switch back to Char1 — persona auto-flips to A ──
        await selectCharacterCard(page, 'Char1Ash');
        await page.waitForFunction(() => window.Luker.getContext().name1 === 'PersonaA', { timeout: 10_000 });
        expect(await page.evaluate(() => window.Luker.getContext().name1)).toBe('PersonaA');

        // ── Switch to Char2 → auto-flip to B ──
        await selectCharacterCard(page, 'Char2Bryn');
        await page.waitForFunction(() => window.Luker.getContext().name1 === 'PersonaB', { timeout: 10_000 });
        expect(await page.evaluate(() => window.Luker.getContext().name1)).toBe('PersonaB');

        // ── Restart + reload — bindings persist ──
        await server.restart();
        await reloadAndAwait(page, server.baseURL);

        await selectCharacterCard(page, 'Char1Ash');
        await page.waitForFunction(() => window.Luker.getContext().name1 === 'PersonaA', { timeout: 15_000 });
        expect(await page.evaluate(() => window.Luker.getContext().name1)).toBe('PersonaA');

        await selectCharacterCard(page, 'Char2Bryn');
        await page.waitForFunction(() => window.Luker.getContext().name1 === 'PersonaB', { timeout: 15_000 });
        expect(await page.evaluate(() => window.Luker.getContext().name1)).toBe('PersonaB');
    });
});
