// Doc screenshot capture: TTS voice-map management popup with an NPC row
// + the manual Add entry. Boots a real server + mock LLM, registers the
// same Stub TTS provider as the e2e suite, drives the REAL UI, and saves
// screenshots to docs/public/screenshots/tts-npc-attribution/.
//
// Run: cd tests && npx playwright test tts-voice-map-screens --project=e2e

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    openExtensionsDrawer,
    openInlineDrawer,
} from '../_lib/page.js';
import { resolve } from 'node:path';

let server;

const DOC_SHOTS = resolve(import.meta.dirname, '../../../docs/public/screenshots/tts-npc-attribution');

test.beforeAll(async () => {
    server = await startServer({ batchKey: 'extensions', scenarioId: 'tts-doc-shots' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: 'http://127.0.0.1:9' });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: 'http://127.0.0.1:9' });
});

test.afterAll(async () => {
    await tearDownServer(server);
});

test('capture voice map doc screenshots', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);

    await page.evaluate(async () => {
        const mod = await import('/scripts/extensions/tts/index.js');
        class StubTts {
            settings = {};
            async loadSettings() {}
            async onApplyClick() {}
            async checkReady() { return true; }
            async onRefreshClick() {}
            async fetchTtsVoiceObjects() {
                return [
                    { name: 'Ting-Ting', voice_id: 'v1' },
                    { name: 'Alex', voice_id: 'v2' },
                ];
            }
            async getVoice(name) { return { name, voice_id: 'v1' }; }
            async generateTts() { return new Response(new Blob([]), { headers: { 'content-type': 'audio/wav' } }); }
        }
        mod.registerTtsProvider('Stub', StubTts);
    });

    await openExtensionsDrawer(page);
    await openInlineDrawer(page, 'tts_settings');

    const providerSel = page.locator('#tts_provider');
    await providerSel.waitFor({ state: 'attached', timeout: 10_000 });
    await providerSel.selectOption('Stub');
    await page.waitForTimeout(500);

    const enableCb = page.locator('#tts_enabled');
    await enableCb.scrollIntoViewIfNeeded().catch(() => {});
    await enableCb.check();

    // Open the voice-map management popup and seed a pre-configured NPC
    // through its REAL Add entry so the shot shows a tagged NPC row.
    const manageBtn = page.locator('#tts_voicemap_manage');
    await manageBtn.scrollIntoViewIfNeeded().catch(() => {});
    await manageBtn.click();
    const popupInput = page.locator('#tts_voicemap_popup #tts_voicemap_add_name');
    await popupInput.waitFor({ state: 'visible', timeout: 10_000 });
    await popupInput.fill('Bryn the Harbourmaster');
    await page.locator('#tts_voicemap_popup #tts_voicemap_add').click();
    await page.waitForFunction(() => {
        const map = window.Luker.getContext().extensionSettings.tts?.Stub?.voiceMap;
        return !!map && Object.prototype.hasOwnProperty.call(map, 'Bryn the Harbourmaster');
    }, { timeout: 10_000 });
    await popupInput.fill('');

    const voiceMapBlock = page.locator('#tts_voicemap_block');
    await voiceMapBlock.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(400);

    // First shot: the popup with the NPC row (tag + remove button).
    await page.locator('.popup').screenshot({ path: resolve(DOC_SHOTS, '04-voice-map.png') });

    // Second shot: a name typed into the popup's Add input.
    await popupInput.fill('Old Mare the baker');
    await page.waitForTimeout(200);
    await page.locator('.popup').screenshot({ path: resolve(DOC_SHOTS, '05-voice-map-add.png') });

    expect(await voiceMapBlock.locator('.tts_voicemap_npc_tag').count()).toBeGreaterThanOrEqual(1);

    // Close the popup via the REAL Done button so the session ends clean.
    await page.locator('.popup .popup-button-ok').click();
    await expect(page.locator('#tts_voicemap_popup')).toHaveCount(0);
});
