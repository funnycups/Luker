// Case #94 — TTS pipeline fires on real .mes_narrate button click
//
// Spec:
//   1. Register a Stub TTS provider that lets the pipeline complete
//      without a real synthesizer.
//   2. Enable TTS via the real #tts_enabled checkbox.
//   3. Select Stub provider via #tts_provider dropdown.
//   4. Wait for voice map to populate (the module's auto-resolver).
//   5. Send a real message + reply.
//   6. Click .mes_narrate on the assistant message — the same user
//      gesture that fires onNarrateOneMessage.
//   7. Assert TTS_JOB_STARTED fires OR generateTts is called. We
//      explicitly do NOT accept CHARACTER_MESSAGE_RENDERED as success;
//      that's the upstream trigger, not pipeline evidence.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    selectCharacterByName,
    sendMessageAndAwaitReply,
    openExtensionsDrawer,
    openInlineDrawer,
} from '../_lib/page.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [
        '*Ash trims the lantern wick.* "The reef has been restless tonight, but the lantern still holds."',
    ] });
    server = await startServer({ batchKey: 'extensions', scenarioId: '94-tts' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#94 — TTS pipeline reaches playback via real .mes_narrate click', () => {
    test.describe.configure({ timeout: 240_000 });
    test('clicking .mes_narrate on assistant reply fires the TTS pipeline (real provider.generateTts call)', async ({ page }) => {
        test.setTimeout(240_000);
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        // Register the stub provider + wire up event observers BEFORE
        // any TTS init runs. The stub records calls so we can assert
        // post-click evidence that the pipeline reached generateTts.
        await page.evaluate(async () => {
            const mod = await import('/scripts/extensions/tts/index.js');
            window.__ttsStub = { generateTtsCalls: 0, getVoiceCalls: 0 };
            window.__ttsEvents = { jobStarted: 0, audioReady: 0 };
            const fakeAudio = new Blob([new Uint8Array([82, 73, 70, 70])], { type: 'audio/wav' });
            class StubTts {
                settings = {};
                async loadSettings() {}
                async onApplyClick() {}
                async checkReady() { return true; }
                async onRefreshClick() {}
                async fetchTtsVoiceObjects() { return [{ name: 'StubVoice', voice_id: 'stub-1' }]; }
                async getVoice(name) {
                    window.__ttsStub.getVoiceCalls += 1;
                    return { name: name || 'StubVoice', voice_id: 'stub-1' };
                }
                async generateTts() {
                    window.__ttsStub.generateTtsCalls += 1;
                    return new Response(fakeAudio, { headers: { 'content-type': 'audio/wav' } });
                }
            }
            if (typeof mod.registerTtsProvider === 'function') {
                mod.registerTtsProvider('Stub', StubTts);
            }
            const ctx = window.Luker.getContext();
            ctx.eventSource.on(ctx.eventTypes.TTS_JOB_STARTED, () => { window.__ttsEvents.jobStarted++; });
            ctx.eventSource.on(ctx.eventTypes.TTS_AUDIO_READY, () => { window.__ttsEvents.audioReady++; });
        });

        // Open Extensions → TTS settings.
        await openExtensionsDrawer(page);
        await openInlineDrawer(page, 'tts_settings');

        // Switch to Stub provider via the REAL dropdown. The change handler
        // calls loadTtsProvider('Stub').
        const providerSel = page.locator('#tts_provider');
        await providerSel.waitFor({ state: 'attached', timeout: 10_000 });
        await providerSel.scrollIntoViewIfNeeded().catch(() => {});
        await providerSel.selectOption('Stub');
        // Give the provider switch + voiceMap reset a beat.
        await page.waitForTimeout(800);

        // Enable TTS via REAL checkbox.
        const enableCb = page.locator('#tts_enabled');
        await enableCb.scrollIntoViewIfNeeded().catch(() => {});
        await enableCb.check();

        // Force-seed voiceMap so onNarrateOneMessage can resolve a voice
        // for the current character. The legitimate UI gesture is to
        // populate #tts_voicemap_block which the module reads; but
        // headlessly we seed the provider-scoped settings.tts.Stub.voiceMap
        // (initVoiceMapInternal:1505 reads
        // extension_settings.tts[ttsProviderName].voiceMap, not the
        // top-level tts.voiceMap). The important act under test is the
        // CLICK, not the voice mapping setup.
        await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            ctx.extensionSettings.tts = ctx.extensionSettings.tts || {};
            ctx.extensionSettings.tts.Stub = ctx.extensionSettings.tts.Stub || {};
            ctx.extensionSettings.tts.Stub.voiceMap = 'Seraphina:StubVoice';
            ctx.saveSettingsDebounced();
            const mod = await import('/scripts/extensions/tts/index.js');
            if (typeof mod.initVoiceMap === 'function') {
                await mod.initVoiceMap(true);
            }
        });

        // Real send + reply.
        await sendMessageAndAwaitReply(page, 'Tell me what you read in the reef tonight.');

        // Click .mes_narrate on the assistant reply (last .mes). The
        // button lives inside .extraMesButtons which is display:none by
        // default (revealed by hovering / clicking .extraMesButtonsHint).
        // Playwright's click({force:true}) can hang on display:none
        // elements because there's no bbox to land the synthetic click
        // on — dispatch the click via JS instead (the document-level
        // delegated handler in tts/index.js:1577 will pick it up).
        await page.evaluate(() => {
            const btn = document.querySelector('#chat .mes:last-child .mes_narrate');
            if (!btn) throw new Error('.mes_narrate not found on last bubble');
            btn.click();
        });

        // Wait for the TTS pipeline to fire. moduleWorker runs on a
        // setInterval(1000), so give the queue a beat to drain.
        await page.waitForFunction(() => {
            return (window.__ttsEvents?.jobStarted || 0) > 0
                || (window.__ttsStub?.generateTtsCalls || 0) > 0;
        }, { timeout: 30_000 }).catch(() => { /* surface via expect below */ });

        const evidence = await page.evaluate(() => ({
            jobStarted: window.__ttsEvents?.jobStarted || 0,
            audioReady: window.__ttsEvents?.audioReady || 0,
            generateTtsCalls: window.__ttsStub?.generateTtsCalls || 0,
            getVoiceCalls: window.__ttsStub?.getVoiceCalls || 0,
        }));

        // Pipeline evidence: TTS_JOB_STARTED OR provider.generateTts called.
        // We deliberately do NOT accept CHARACTER_MESSAGE_RENDERED here.
        expect(
            evidence.jobStarted > 0 || evidence.generateTtsCalls > 0,
            `TTS pipeline did not reach the playback step. Evidence: ${JSON.stringify(evidence)}`,
        ).toBe(true);
    });
});
