// Regression: the Manage voices popup (voice-map row management) while TTS
// is off, and row removal generally.
//
//   1. With the Enabled checkbox unchecked the popup must still list the
//      chat participants and any pre-added names, and a name added through
//      the REAL Add input must show up as a row. Before the fix the popup
//      rendered zero rows with TTS off, so added names persisted while
//      being invisible, and re-adding them toasted "already in the voice
//      map".
//   2. The ✕ remove button must actually remove: it used to delete only
//      the provider key, then the close-time sync (or row re-render) put
//      it back. Covered for both plain names and multi-voice rows whose
//      labels carry a segment suffix.
//
// Run: cd tests && npx playwright test tts-voice-map-disabled --project=e2e

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    selectCharacterByName,
    openExtensionsDrawer,
    openInlineDrawer,
} from '../_lib/page.js';

let server;

const NPC_NAME = 'Bryn the Harbourmaster';

test.beforeAll(async () => {
    server = await startServer({ batchKey: 'extensions', scenarioId: 'tts-voice-map-disabled' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: 'http://127.0.0.1:9' });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: 'http://127.0.0.1:9' });
});

test.afterAll(async () => {
    await tearDownServer(server);
});

test.describe('TTS voice map popup with TTS disabled', () => {
    test.describe.configure({ timeout: 240_000 });
    test('Manage voices lists participants and keeps added names with TTS off', async ({ page }) => {
        test.setTimeout(240_000);
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        // Register the Stub provider the TTS specs use (no real
        // synthesizer exists headlessly; the act under test is the
        // popup rendering, not synthesis).
        await page.evaluate(async () => {
            const mod = await import('/scripts/extensions/tts/index.js');
            class StubTts {
                settings = {};
                async loadSettings() {}
                async onApplyClick() {}
                async checkReady() { return true; }
                async onRefreshClick() {}
                async fetchTtsVoiceObjects() { return [{ name: 'StubVoice', voice_id: 'stub-1' }]; }
                async getVoice(name) { return { name, voice_id: 'stub-1' }; }
                async generateTts() { return new Response(new Blob([]), { headers: { 'content-type': 'audio/wav' } }); }
            }
            mod.registerTtsProvider('Stub', StubTts);
        });

        await openExtensionsDrawer(page);
        await openInlineDrawer(page, 'tts_settings');

        const providerSel = page.locator('#tts_provider');
        await providerSel.waitFor({ state: 'attached', timeout: 10_000 });
        await providerSel.selectOption('Stub');
        await page.waitForTimeout(800);

        // Precondition: TTS stays OFF for the whole test.
        const enableCb = page.locator('#tts_enabled');
        await enableCb.scrollIntoViewIfNeeded().catch(() => {});
        if (await enableCb.isChecked()) {
            await enableCb.uncheck();
        }
        await expect(enableCb).not.toBeChecked();

        // Open Manage voices through the REAL button.
        const manageBtn = page.locator('#tts_voicemap_manage');
        await manageBtn.scrollIntoViewIfNeeded().catch(() => {});
        await manageBtn.click();
        const popupInput = page.locator('#tts_voicemap_popup #tts_voicemap_add_name');
        await popupInput.waitFor({ state: 'visible', timeout: 10_000 });

        // Chat participants must have rows even with TTS off. Before the
        // fix the popup rendered zero rows here.
        const participantRow = page.locator('#tts_voicemap_popup .tts_voicemap_block_char', { hasText: 'Seraphina' });
        await expect(participantRow.first()).toBeVisible({ timeout: 10_000 });

        // Add an NPC name through the REAL Add entry.
        await popupInput.fill(NPC_NAME);
        await page.locator('#tts_voicemap_popup #tts_voicemap_add').click();

        // The name must land in the provider voiceMap...
        await page.waitForFunction((npc) => {
            const map = window.Luker.getContext().extensionSettings.tts?.Stub?.voiceMap;
            return !!map && Object.prototype.hasOwnProperty.call(map, npc);
        }, NPC_NAME, { timeout: 10_000 });

        // ...and its row must render (NPC-tagged) without TTS being on.
        const npcRow = page.locator('#tts_voicemap_popup .tts_voicemap_block_char', { hasText: NPC_NAME }).last();
        await expect(npcRow.locator('.tts_voicemap_npc_tag')).toBeVisible({ timeout: 10_000 });

        // The ✕ remove button must actually remove: click it, then the
        // row and the provider key must both be gone.
        await npcRow.locator('.tts_voicemap_remove').click();
        await page.waitForFunction((npc) => {
            const map = window.Luker.getContext().extensionSettings.tts?.Stub?.voiceMap;
            return !!map && !Object.prototype.hasOwnProperty.call(map, npc);
        }, NPC_NAME, { timeout: 10_000 });
        await expect(page.locator('#tts_voicemap_popup .tts_voicemap_block_char', { hasText: NPC_NAME })).toHaveCount(0);

        // Close via the REAL Done button.
        await page.locator('dialog[open].popup .popup-button-ok').last().click();
        await expect(page.locator('dialog[open] #tts_voicemap_popup')).toHaveCount(0);

        // Multi-voice: speaker rows carry segment suffixes, and the map
        // holds one key per slot. Removal from a suffixed row must drop
        // every slot, not silently no-op or resurrect at close.
        const multiVoiceCb = page.locator('#tts_multi_voice_enabled');
        await multiVoiceCb.scrollIntoViewIfNeeded().catch(() => {});
        await multiVoiceCb.check();

        await manageBtn.click();
        await popupInput.waitFor({ state: 'visible', timeout: 10_000 });
        await popupInput.fill(NPC_NAME);
        await page.locator('#tts_voicemap_popup #tts_voicemap_add').click();

        const slotKeys = (npc) => [npc, `${npc} ("Quotes")`, `${npc} (*Text inside asterisks*)`, `${npc} (Other text)`];
        await page.waitForFunction((keys) => {
            const map = window.Luker.getContext().extensionSettings.tts?.Stub?.voiceMap;
            return !!map && keys.every(k => Object.prototype.hasOwnProperty.call(map, k));
        }, slotKeys(NPC_NAME), { timeout: 10_000 });

        const quotesRow = page.locator('#tts_voicemap_popup .tts_voicemap_block_char', { hasText: `${NPC_NAME} ("Quotes")` }).last();
        await expect(quotesRow.locator('.tts_voicemap_npc_tag')).toBeVisible({ timeout: 10_000 });
        await quotesRow.locator('.tts_voicemap_remove').click();

        await page.waitForFunction((npc) => {
            const map = window.Luker.getContext().extensionSettings.tts?.Stub?.voiceMap;
            return !!map && !Object.keys(map).some(k => k === npc || k.startsWith(`${npc} (`));
        }, NPC_NAME, { timeout: 10_000 });
        await expect(page.locator('#tts_voicemap_popup .tts_voicemap_block_char', { hasText: NPC_NAME })).toHaveCount(0);

        // Close via the REAL Done button; the close-time sync must not
        // resurrect any slot.
        await page.locator('dialog[open].popup .popup-button-ok').last().click();
        await expect(page.locator('dialog[open] #tts_voicemap_popup')).toHaveCount(0);
        await page.waitForFunction((npc) => {
            const map = window.Luker.getContext().extensionSettings.tts?.Stub?.voiceMap;
            return !!map && !Object.keys(map).some(k => k === npc || k.startsWith(`${npc} (`));
        }, NPC_NAME, { timeout: 10_000 });
    });
});
