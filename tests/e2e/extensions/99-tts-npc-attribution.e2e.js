// Case #99 — TTS NPC attribution: inline quote play → parse → cache → NPC voice
//
// Spec:
//   1. Register a Stub TTS provider (94 pattern) that records every
//      generateTts(text, voiceId, voiceMapKey) call.
//   2. Enable TTS + NPC attribution via the REAL checkboxes
//      (#tts_enabled, #tts_npc_attribution_enabled), select the Stub
//      provider via the REAL #tts_provider dropdown, zero the retry
//      count via the REAL #tts_npc_attribution_retry_max input.
//   3. Real send; the mock replies with straight-quoted dialogue from
//      the card character (Seraphina) AND a distinct NPC
//      (Bryn the Harbourmaster).
//   4. Push the attribution tool call to the mock AT TEST TIME (after
//      the reply landed), then really click the NPC quote's inline
//      .tts_q_play button — unlike .mes_narrate (display:none, needs a
//      JS dispatch — see 94) the inline button is visible DOM.
//   5. The click's lazy parse consumes the tool call, commits the
//      segments to the tts floor-state sidecar, auto-adds the NPC key
//      to the provider voiceMap, and only then enqueues the segment.
//      Assert: stub saw voiceMapKey === 'Bryn the Harbourmaster'
//      (multi_voice stays OFF, so the segment path uses the bare
//      speaker name), the voiceMap gained the NPC key with the
//      [Default Voice] marker value, and the sidecar on disk carries a
//      commit patching /<reply mesid>.

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
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let server, mock;

const NPC_NAME = 'Bryn the Harbourmaster';
const NPC_QUOTE_TEXT = 'Tie up the lantern lines before the tide turns';

const REPLY_TEXT = `*Seraphina leans on the rail.*
"We will reach the port by dawn," Seraphina says.
${NPC_NAME} calls from the pier, "Tie up the lantern lines before the tide turns."`;

test.beforeAll(async () => {
    // ONLY the reply is scripted up front — the tool queue starts
    // EMPTY. mockLLM serves scripted tool calls BEFORE scripted replies
    // (a real model returns either content or tool_calls per turn), so
    // a tool call seeded here would be shifted out to the main Generate
    // request and the reply would never pop. The attribution tool call
    // is pushed later, at test time, once the reply has landed (see the
    // comment next to mock.scriptToolCall).
    mock = await startMockLLM({
        scriptedReplies: [REPLY_TEXT],
        scriptedToolCalls: [],
    });
    server = await startServer({ batchKey: 'extensions', scenarioId: '99-tts-npc' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#99 — TTS NPC attribution end-to-end', () => {
    test.describe.configure({ timeout: 240_000 });
    test('inline play click on NPC quote → parse → cache → NPC voiceMapKey playback', async ({ page }) => {
        test.setTimeout(240_000);
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        // Stub provider (94 pattern): records every generateTts call as
        // {text, voiceId, voiceMapKey} so we can assert the playback path
        // resolved the NPC speaker, not the message author.
        await page.evaluate(async () => {
            const mod = await import('/scripts/extensions/tts/index.js');
            window.__ttsStub = { generateTtsCalls: [], getVoiceCalls: [] };
            const fakeAudio = new Blob([new Uint8Array([82, 73, 70, 70])], { type: 'audio/wav' });
            class StubTts {
                settings = {};
                async loadSettings() {}
                async onApplyClick() {}
                async checkReady() { return true; }
                async onRefreshClick() {}
                async fetchTtsVoiceObjects() { return [{ name: 'StubVoice', voice_id: 'stub-1' }]; }
                async getVoice(name) {
                    window.__ttsStub.getVoiceCalls.push(name);
                    return { name: name || 'StubVoice', voice_id: 'stub-1' };
                }
                async generateTts(text, voiceId, voiceMapKey) {
                    window.__ttsStub.generateTtsCalls.push({ text, voiceId, voiceMapKey });
                    return new Response(fakeAudio, { headers: { 'content-type': 'audio/wav' } });
                }
            }
            mod.registerTtsProvider('Stub', StubTts);
        });

        // Open Extensions → TTS settings.
        await openExtensionsDrawer(page);
        await openInlineDrawer(page, 'tts_settings');

        // Switch to Stub provider via the REAL dropdown. The change
        // handler calls loadTtsProvider('Stub').
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

        // Isolate the manual play path from auto-narration. With
        // auto_generation on (the default), the assistant reply itself
        // is queued for whole-message TTS the moment it renders, and
        // that job would occupy generateTtsCalls[0] with the author's
        // voiceMapKey ('Seraphina'). The act under test is the inline
        // button click, so turn the whole-message auto path off via the
        // REAL #tts_auto_generation checkbox.
        const autoGenCb = page.locator('#tts_auto_generation');
        await autoGenCb.scrollIntoViewIfNeeded().catch(() => {});
        if (await autoGenCb.isChecked()) {
            await autoGenCb.uncheck();
        }

        // Seed the provider-scoped voiceMap. 94 precedent: the act
        // under test is the parse/cache/playback chain, not the
        // voice-mapping UI (#tts_voicemap_block selects are impractical
        // to drive headlessly; initVoiceMapInternal reads
        // extension_settings.tts[providerName].voiceMap, not the
        // top-level tts.voiceMap). Two deviations from 94's
        // 'Seraphina:StubVoice' string seed, both load-bearing for the
        // NPC path:
        //   - OBJECT form: when the attribution parse discovers the NPC
        //     it tops the map up via ensureNpcVoiceMapEntries, which
        //     preserves object maps but REPLACES a string map with {} —
        //     a string seed would be wiped exactly when the feature
        //     under test runs.
        //   - '[Default Voice]' seeded to a real voice: NPC names are
        //     auto-added with '[Default Voice]' as their value, and the
        //     queue resolves that marker through the '[Default Voice]'
        //     slot — if that slot is unset it falls back to 'disabled'
        //     and the job is dropped before generateTts is ever called.
        await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            ctx.extensionSettings.tts = ctx.extensionSettings.tts || {};
            ctx.extensionSettings.tts.Stub = ctx.extensionSettings.tts.Stub || {};
            ctx.extensionSettings.tts.Stub.voiceMap = {
                'Seraphina': 'StubVoice',
                '[Default Voice]': 'StubVoice',
            };
            ctx.saveSettingsDebounced();
            const mod = await import('/scripts/extensions/tts/index.js');
            if (typeof mod.initVoiceMap === 'function') {
                await mod.initVoiceMap(true);
            }
        });

        // Enable NPC attribution via the REAL checkbox.
        const attrCb = page.locator('#tts_npc_attribution_enabled');
        await attrCb.scrollIntoViewIfNeeded().catch(() => {});
        await attrCb.check();

        // Pre-configure the NPC via the REAL voice-map popup: open it
        // through the Manage voices button, add the name through the
        // popup's REAL Add input, and close with Done. The name must
        // land in the provider voiceMap before any AI pass runs, and
        // buildRoster must hand it to the attribution model as a
        // candidate speaker (asserted on the request body below).
        const manageBtn = page.locator('#tts_voicemap_manage');
        await manageBtn.scrollIntoViewIfNeeded().catch(() => {});
        await manageBtn.click();
        const popupInput = page.locator('#tts_voicemap_popup #tts_voicemap_add_name');
        await popupInput.waitFor({ state: 'visible', timeout: 10_000 });
        await popupInput.fill(NPC_NAME);
        await page.locator('#tts_voicemap_popup #tts_voicemap_add').click();
        await page.waitForFunction((npc) => {
            const map = window.Luker.getContext().extensionSettings.tts?.Stub?.voiceMap;
            return !!map && Object.prototype.hasOwnProperty.call(map, npc);
        }, NPC_NAME, { timeout: 10_000 });
        // The popup re-renders with the new NPC row (NPC-tagged, with a
        // remove button) after the Add-triggered reopen (popup animation
        // is 'none', so the old dialog is removed immediately).
        const npcRow = page.locator('#tts_voicemap_popup .tts_voicemap_block_char', { hasText: NPC_NAME }).last();
        await expect(npcRow.locator('.tts_voicemap_npc_tag')).toBeVisible();
        // Close via the REAL Done button (topmost open popup).
        await page.locator('dialog[open].popup .popup-button-ok').last().click();
        // Popup closes without animation, so the dialog is removed at once.
        await expect(page.locator('dialog[open] #tts_voicemap_popup')).toHaveCount(0);

        // Zero the attribution retry count via the REAL input. The
        // render-triggered background parse fires the moment the reply
        // lands; with an empty tool queue the mock answers it with a
        // plain echo, the parse fails, and (harmlessly) the click below
        // re-parses lazily. What zero buys is a deterministic settle
        // point: exactly one request, no retry tail that could still be
        // in flight when we click (the parse's in-flight guard would
        // then null the click's own parse and enqueue the author's name
        // instead of the NPC's).
        const retryInput = page.locator('#tts_npc_attribution_retry_max');
        await retryInput.scrollIntoViewIfNeeded().catch(() => {});
        await retryInput.fill('0');

        // multi_voice stays OFF (default, untouched): the segment path
        // must use the bare speaker name as voiceMapKey — proven by the
        // exact-equality assertion on the stub record below.
        const multiVoice = await page.evaluate(() =>
            window.Luker.getContext().extensionSettings.tts.multi_voice_enabled === true);
        expect(multiVoice).toBe(false);

        // Real send + reply with quotes from the author AND the NPC.
        const { replyId, text: replyText } = await sendMessageAndAwaitReply(page, 'When do we reach the port?');
        expect(replyText).toContain(NPC_QUOTE_TEXT);

        // Dynamic mesid (no hardcoded floor — greeting/user/reply counts
        // vary by dataRoot state): read it from the rendered DOM and
        // cross-check against the id sendMessageAndAwaitReply resolved.
        // A mismatch means DOM/chat drift and fails loud.
        const lastMesId = Number(await page.locator('#chat .mes:last-child').getAttribute('mesid'));
        expect(lastMesId).toBe(replyId);

        // The render-triggered decorate pass must have attached one
        // play button per <q> in the reply (two quotes → two buttons).
        const buttons = page.locator(`.mes[mesid="${lastMesId}"] .mes_text q .tts_q_play`);
        await buttons.first().waitFor({ state: 'visible', timeout: 15_000 });
        expect(await buttons.count()).toBe(2);

        // Settle the background parse BEFORE pushing the tool call. The
        // parse's generateTask request is the only chat-completions
        // request whose tools include report_dialogue_attribution; wait
        // until the mock has seen it and the count has stopped moving
        // (two samples 1.5s apart agree), so the push below cannot be
        // consumed by a half-finished background attempt.
        const attributionReqCount = () => mock.requests.filter(r =>
            Array.isArray(r.body?.tools)
            && r.body.tools.some(t => t?.function?.name === 'report_dialogue_attribution')).length;
        await expect.poll(attributionReqCount, {
            message: 'render-triggered attribution parse should hit the LLM after the reply lands',
            timeout: 20_000,
        }).toBeGreaterThanOrEqual(1);
        let prevCount = -1;
        for (let i = 0; i < 20; i++) {
            const n = attributionReqCount();
            if (n > 0 && n === prevCount) break;
            prevCount = n;
            await page.waitForTimeout(1_500);
        }
        expect(attributionReqCount()).toBeGreaterThanOrEqual(1);

        // The pre-configured NPC name must ride along in the attribution
        // request (buildRoster merges voiceMap keys into the roster), so
        // the model can attribute known NPCs instead of inventing
        // spellings.
        const attributionRequest = mock.requests.find(r =>
            Array.isArray(r.body?.tools)
            && r.body.tools.some(t => t?.function?.name === 'report_dialogue_attribution'));
        expect(JSON.stringify(attributionRequest.body)).toContain(NPC_NAME);

        // NOW push the attribution tool call — after the main Generate
        // already consumed the scripted reply (queue order: tools shift
        // before replies, so pushing any earlier would have diverted
        // the main chat's request into a tool-call response).
        mock.scriptToolCall({
            name: 'report_dialogue_attribution',
            arguments: {
                segments: [
                    { quote_text: 'We will reach the port by dawn', speaker: 'Seraphina' },
                    { quote_text: NPC_QUOTE_TEXT, speaker: NPC_NAME },
                ],
            },
        });

        // Real click on the NPC quote's play button — the second <q> in
        // the reply (qIndex 1: the Seraphina line is q0, the NPC line is
        // q1). The button is visible inside .mes_text, so a real
        // Playwright click lands (no JS dispatch needed, unlike 94's
        // .mes_narrate).
        const npcPlayButton = page.locator(`.mes[mesid="${lastMesId}"] .mes_text q .tts_q_play`).nth(1);
        await npcPlayButton.scrollIntoViewIfNeeded().catch(() => {});
        await npcPlayButton.click();

        // The click's lazy parse consumes the pushed tool call, commits
        // to the floor-state cache, auto-adds the NPC voiceMap key, and
        // enqueues the segment. moduleWorker drains the queue on its
        // 1s interval, so give it a beat.
        await page.waitForFunction(() => (window.__ttsStub?.generateTtsCalls?.length || 0) > 0, { timeout: 30_000 });
        const firstCall = await page.evaluate(() => window.__ttsStub.generateTtsCalls[0]);
        expect(firstCall.voiceMapKey).toBe(NPC_NAME);
        expect(firstCall.text).toContain('Tie up the lantern lines');

        // The parse must have auto-added the NPC to the provider
        // voiceMap with the [Default Voice] marker value (multi_voice
        // OFF adds just the bare-name key, no ("Quotes") suffix).
        await page.waitForFunction((npc) => {
            const map = window.Luker.getContext().extensionSettings.tts?.Stub?.voiceMap;
            return !!map && Object.prototype.hasOwnProperty.call(map, npc);
        }, NPC_NAME, { timeout: 10_000 });
        const npcVoiceValue = await page.evaluate((npc) =>
            window.Luker.getContext().extensionSettings.tts.Stub.voiceMap[npc], NPC_NAME);
        expect(npcVoiceValue).toBe('[Default Voice]');

        // Disk evidence: the parse committed the attribution to the tts
        // floor-state sidecar next to the chat file. Same path pattern
        // as 22-merge-state-isolation (avatar folder from the selected
        // character + getCurrentChatId).
        const avatarFolder = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return ctx.characters[ctx.characterId].avatar.replace(/\.png$/, '');
        });
        const chatId = await page.evaluate(() => window.Luker.getContext().getCurrentChatId());
        const sidecarPath = resolve(server.dataRoot, 'default-user', 'chats', avatarFolder, `${chatId}.luker-state.tts__floor_log.json`);
        expect(existsSync(sidecarPath), `expected TTS floor-state sidecar at ${sidecarPath}`).toBe(true);
        const log = JSON.parse(readFileSync(sidecarPath, 'utf8'));
        expect(Array.isArray(log.commits) && log.commits.length > 0).toBe(true);
        expect(
            log.commits.some(c => Array.isArray(c.patches)
                && c.patches.some(p => p.op === 'add' && p.path === `/${lastMesId}`)),
            `expected a commit patching /${lastMesId}; log was ${JSON.stringify(log).slice(0, 400)}`,
        ).toBe(true);
    });
});
