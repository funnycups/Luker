// OpenAI Responses connection type — full-chain e2e.
//
// Seven scenarios sharing one mockLLM (/v1/responses handler) + one Luker
// server instance. Each scenario resets the mock's scripted queues and
// drives the REAL user path: fill #send_textarea, click #send_but, assert
// the rendered bubbles and the wire bodies the mock received.
//
//   1. streamed text lands verbatim in the assistant bubble; request body
//      carries input[] (user turn), instructions (system prompt), store:false
//   2. reasoning summaries render in the reasoning fold while the answer
//      renders as the body; request carries reasoning.summary='auto'
//   3. registered function tool round-trips: scripted function_call → tool
//      executes → second /responses request carries function_call_output
//   4. web-search toggle adds {type:'web_search'} to tools
//   5. image attachment surfaces as an input_image content part
//   6. non-streaming round trip; usage maps into the message token count
//      and scripted reasoning survives the non-streaming pipeline
//   7. upstream 500 surfaces as an error toast and the UI recovers

import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import {
    bootstrapResponsesBackend,
    appendConnectionProfile,
    markOnboarded,
} from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';

const STREAMED_REPLY = '*Seraphina traces the reef line with one finger.* "The slow swallow turns tonight — keep the lantern trimmed and stay off the sandspit."';
const NON_STREAM_REPLY = '*She folds the chart closed.* "Then we walk the headland path and let the tide argue with itself."';

let server;
let mock;

function setStreamFlag(on) {
    const sp = resolve(server.dataRoot, 'default-user', 'settings.json');
    const s = JSON.parse(readFileSync(sp, 'utf8'));
    s.oai_settings = s.oai_settings || {};
    s.oai_settings.stream_openai = !!on;
    writeFileSync(sp, JSON.stringify(s, null, 4));
}

function responsesRequests() {
    return mock.requests.filter(r => r.url.endsWith('/responses'));
}

/**
 * The chat generation request for a given user turn. The mock also serves
 * background LLM callers (extension extraction runs), so "the last request"
 * is not necessarily the chat turn — match on the unique user text instead.
 */
function findGenerationRequest(userText) {
    return [...mock.requests].reverse().find(r =>
        r.url.endsWith('/responses')
        && JSON.stringify(r.body?.input ?? '').includes(userText));
}

/**
 * Open the API connections drawer (#left-nav-panel) so the source-scoped
 * toggles (#openai_function_calling, #openai_enable_web_search) can be
 * clicked through the real pointer path.
 */
async function openApiSettingsDrawer(page) {
    const block = page.locator('#left-nav-panel');
    const isOpen = await block.evaluate(el => el && el.classList.contains('openDrawer')).catch(() => false);
    if (isOpen) return;
    await page.locator('#leftNavDrawerIcon').click();
    await block.waitFor({ state: 'visible', timeout: 5000 });
}

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({ batchKey: 'chat', scenarioId: 'responses-api' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapResponsesBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL, stream: true });
    appendConnectionProfile({
        dataRoot: server.dataRoot,
        name: 'e2e-responses',
        baseURL: mock.baseURL,
        source: 'openai_responses',
    });
    // Keep the memory-graph extractor from firing its own /responses calls
    // against the shared scripted queue — these scenarios cover only the
    // chat generation path.
    const sp = resolve(server.dataRoot, 'default-user', 'settings.json');
    const s = JSON.parse(readFileSync(sp, 'utf8'));
    s.extension_settings = s.extension_settings || {};
    s.extension_settings.memory_graph = { ...(s.extension_settings.memory_graph || {}), enabled: false };
    // Dev settings may ship show_thoughts=false; this suite exercises the
    // reasoning pipeline, so bootstrap it on like a user who enabled the
    // "Show thoughts" toggle would have persisted.
    s.oai_settings = s.oai_settings || {};
    s.oai_settings.show_thoughts = true;
    // Same for inline media: scenario 5 exercises the image-attachment
    // pipeline, which only runs when "Send inline media" is enabled.
    s.oai_settings.media_inlining = true;
    writeFileSync(sp, JSON.stringify(s, null, 4));
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe.serial('OpenAI Responses end-to-end', () => {

    test('scenario 1 — streamed text round trip with Responses-shaped request', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        mock.scriptReply(STREAMED_REPLY);
        const userText = 'The wind is gathering. What should we watch for tonight?';
        const { replyId, text } = await sendMessageAndAwaitReply(page, userText);

        // Bubble shows the scripted text verbatim. The DOM renders
        // markdown, so *emphasis* markers are consumed by italics —
        // compare with the markers stripped on both sides.
        const stripEmphasis = (s) => s.replace(/\*/g, '');
        expect(stripEmphasis(text.trim())).toBe(stripEmphasis(STREAMED_REPLY));

        // Persisted state agrees with the DOM.
        const persistedMes = await page.evaluate((id) => {
            const ctx = window.Luker.getContext();
            return ctx.chat[id]?.mes ?? null;
        }, replyId);
        expect(persistedMes).toBe(STREAMED_REPLY);

        // Wire shape: the /responses request for this turn carries the
        // Responses body.
        const gen = findGenerationRequest(userText);
        expect(gen, 'no /responses request carried the sent user text').toBeTruthy();
        const body = gen.body;

        // User turn landed in input[]. Dev presets can append extra
        // user-role prompt blocks after our message, so match ANY user
        // item carrying the sent text rather than only the last one.
        expect(Array.isArray(body.input)).toBe(true);
        const flattenContent = (content) => typeof content === 'string'
            ? content
            : (Array.isArray(content)
                ? content.filter(p => p?.type === 'input_text').map(p => p.text).join('')
                : '');
        const userWireTexts = body.input
            .filter(item => item?.role === 'user')
            .map(item => flattenContent(item.content));
        expect(userWireTexts.some(t => t.includes(userText)),
            `no user input item carried "${userText}"; got: ${JSON.stringify(userWireTexts).slice(0, 600)}`).toBe(true);

        // System prompts collapsed into instructions (checked against the
        // character card the client actually rendered).
        expect(typeof body.instructions).toBe('string');
        expect(body.instructions.length).toBeGreaterThan(0);
        const cardDescription = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return String(ctx.characters?.[ctx.characterId]?.description || '');
        });
        expect(cardDescription.length).toBeGreaterThanOrEqual(20);
        expect(body.instructions).toContain(cardDescription.slice(0, 20));

        // No upstream training-store usage.
        expect(body.store).toBe(false);
        // Streaming flag propagated from the connection settings.
        expect(body.stream).toBe(true);
        // Model came from the Responses model slot.
        expect(String(body.model)).toBe('mock-gpt-4o');
    });

    test('scenario 2 — reasoning summary renders and requests summary=auto', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        // Read-only sanity: the thoughts toggle ships enabled by default;
        // this is what drives include_reasoning → reasoning.summary='auto'.
        const showThoughts = await page.evaluate(async () => {
            const mod = await import('/scripts/openai.js');
            return mod.oai_settings.show_thoughts;
        });
        expect(showThoughts).toBe(true);

        mock.scriptCompletion(() => ({ reasoning: 'inner thought', text: 'visible answer' }));
        const s2UserText = 'Think through the tide tables quietly, then tell me.';
        await sendMessageAndAwaitReply(page, s2UserText);

        const gen = findGenerationRequest(s2UserText);
        expect(gen, 'no /responses request carried the sent user text').toBeTruthy();
        const body = gen.body;
        expect(body.reasoning?.summary).toBe('auto');

        // Body text renders in the bubble; reasoning renders in the fold.
        const bubbleText = await page.locator('#chat .last_mes .mes_text').innerText();
        expect(bubbleText).toContain('visible answer');
        const reasoningText = await page.evaluate(() => {
            const el = document.querySelector('#chat .last_mes .mes_reasoning_details .mes_reasoning');
            return el ? el.textContent : '';
        });
        expect(reasoningText).toContain('inner thought');

        // Persisted message carries both halves.
        const persisted = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            const m = ctx.chat[ctx.chat.length - 1];
            return { mes: m.mes, reasoning: m.extra?.reasoning ?? '' };
        });
        expect(persisted.mes).toContain('visible answer');
        expect(persisted.reasoning).toContain('inner thought');
        mock.clearScriptedCompletion();
    });

    test('scenario 3 — function tool round trip via function_call / function_call_output', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        // Real user path: open the API settings drawer and toggle native
        // function calling through the visible checkbox; remaining knobs
        // go through the public extension API (same flow as
        // 98-function-call-runtime.e2e).
        await openApiSettingsDrawer(page);
        const functionCallingToggle = page.locator('#openai_function_calling');
        await functionCallingToggle.waitFor({ state: 'visible', timeout: 10_000 });
        await functionCallingToggle.click();
        await expect(functionCallingToggle).toBeChecked();
        await page.evaluate(() => {
            return import('/scripts/openai.js').then(mod => {
                mod.oai_settings.custom_prompt_post_processing = '';
                mod.oai_settings.tool_call_recurse_limit = 5;
                const ctx = window.Luker.getContext();
                ctx.ToolManager.RECURSE_LIMIT = 5;
            });
        });
        await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            try { ctx.unregisterFunctionTool('get_tide'); } catch { /* not yet registered */ }
            ctx.registerFunctionTool({
                name: 'get_tide',
                displayName: 'Get Tide Reading',
                description: 'Returns the current tide reading for the Bryn headland station.',
                parameters: {
                    type: 'object',
                    properties: {
                        station: { type: 'string', description: 'Station name.' },
                    },
                    required: ['station'],
                    additionalProperties: false,
                },
                action: async ({ station }) => `minus seven and falling (${station})`,
                formatMessage: ({ station }) => `Checking the tide gauge at ${station}...`,
                shouldRegister: () => true,
                stealth: false,
            });
        });
        const registeredNames = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return ctx.ToolManager.tools.map(t => t.toFunctionOpenAI?.().function?.name);
        });
        expect(registeredNames).toContain('get_tide');

        mock.scriptToolCall({ name: 'get_tide', arguments: { station: 'Bryn headland' } });
        const FINAL = '*She reads the gauge by lantern light.* "Minus seven and falling — the slow swallow is early."';
        mock.scriptReply(FINAL);

        const s3UserText = 'Check the tide gauge before we commit to the crossing.';
        const chatLenBefore = await page.evaluate(() => window.Luker.getContext().chat.length);
        await sendMessageAndAwaitReply(page, s3UserText);

        // Final bubble is the SECOND scripted reply.
        await page.waitForFunction((targetLen) => {
            const ctx = window.Luker.getContext();
            return ctx.chat.some((m, i) => i > targetLen && !m.is_user && !m.is_system && String(m.mes).includes('slow swallow'));
        }, chatLenBefore, { timeout: 60_000 });

        // The tool really executed (its result string comes from the
        // registered action, not from anything the mock emitted).
        const invocations = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            const msgs = [];
            for (const m of ctx.chat) {
                if (Array.isArray(m.extra?.tool_invocations)) {
                    msgs.push(...m.extra.tool_invocations.map(i => ({ result: i.result, name: i.name })));
                }
            }
            return msgs;
        });
        expect(invocations.some(i => i.name === 'get_tide' && String(i.result).includes('minus seven and falling'))).toBe(true);

        // Second /responses request carries the tool result back upstream
        // as a function_call_output item paired with the original call.
        // Anchor on the FIRST request of the turn: the continuation request
        // replays history and also contains the user text, so a reverse
        // match would land on it and leave nothing after to inspect.
        const firstGen = mock.requests.find(r =>
            r.url.endsWith('/responses')
            && JSON.stringify(r.body?.input ?? '').includes(s3UserText));
        expect(firstGen, 'no /responses request carried the sent user text').toBeTruthy();
        const firstIdx = mock.requests.indexOf(firstGen);
        const secondGen = mock.requests.slice(firstIdx + 1).find(r =>
            r.url.endsWith('/responses')
            && Array.isArray(r.body?.input)
            && r.body.input.some(item => item?.type === 'function_call_output'));
        expect(secondGen, 'no follow-up /responses request carried a function_call_output').toBeTruthy();
        const firstInput = firstGen.body.input;
        const secondInput = secondGen.body.input;
        expect(Array.isArray(firstInput)).toBe(true);
        expect(secondInput.some(item => item?.type === 'function_call' && item.name === 'get_tide')).toBe(true);
        const output = secondInput.find(item => item?.type === 'function_call_output');
        expect(output, `second input items: ${JSON.stringify(secondInput)?.slice(0, 1500)}`).toBeTruthy();
        expect(String(output.output)).toContain('minus seven and falling');
        const pairedCall = secondInput.find(item => item?.type === 'function_call' && item.call_id === output.call_id);
        expect(pairedCall).toBeTruthy();

        // Final bubble text.
        const bubbleText = await page.locator('#chat .last_mes .mes_text').innerText();
        expect(bubbleText.replace(/\*/g, '')).toContain(FINAL.replace(/\*/g, ''));
    });

    test('scenario 4 — web search toggle adds a web_search tool entry', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        // Real pointer path: the web-search toggle is visible for this
        // source once the API settings drawer is open, so click it like a
        // user would.
        await openApiSettingsDrawer(page);
        const webSearchToggle = page.locator('#openai_enable_web_search');
        await webSearchToggle.waitFor({ state: 'visible', timeout: 10_000 });
        await webSearchToggle.click();
        const checked = await page.evaluate(async () => {
            const mod = await import('/scripts/openai.js');
            return mod.oai_settings.enable_web_search;
        });
        expect(checked).toBe(true);

        mock.scriptReply('*She nods toward the horizon.* "Ask the gulls; they fly farther than we do."');
        const s4UserText = 'Could the drifters have sailed around the storm line?';
        await sendMessageAndAwaitReply(page, s4UserText);

        const gen = findGenerationRequest(s4UserText);
        expect(gen, 'no /responses request carried the sent user text').toBeTruthy();
        const body = gen.body;
        expect(Array.isArray(body.tools)).toBe(true);
        expect(body.tools.some(t => t?.type === 'web_search')).toBe(true);

        // Restore the setting so later scenarios don't inherit the tool.
        await openApiSettingsDrawer(page);
        await webSearchToggle.click();
        const restored = await page.evaluate(async () => {
            const mod = await import('/scripts/openai.js');
            return mod.oai_settings.enable_web_search;
        });
        expect(restored).toBe(false);
    });

    test('scenario 5 — image attachment becomes an input_image content part', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        // Real attachment path: wand menu → Attach a File → hidden input.
        await page.locator('#extensionsMenuButton').click();
        const attachItem = page.locator('#attachFile');
        await attachItem.waitFor({ state: 'visible', timeout: 5000 });
        await attachItem.click();

        // One-pixel transparent PNG (same fixture bytes the caption e2e uses).
        const ONE_PX_PNG_BASE64 =
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
        await page.locator('#file_form_input').setInputFiles({
            name: 'reef-sketch.png',
            mimeType: 'image/png',
            buffer: Buffer.from(ONE_PX_PNG_BASE64, 'base64'),
        });
        await page.locator('#file_form:not(.displayNone)').waitFor({ state: 'visible', timeout: 10_000 });

        await sendMessageAndAwaitReply(page, 'Here is the sketch I made of the channel. Does it look passable at dawn?');

        // The attached media landed on the user message (proves the real
        // populateFileAttachment chain ran).
        const media = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            const lastUser = [...ctx.chat].reverse().find(m => m.is_user);
            return lastUser?.extra?.media || null;
        });
        expect(Array.isArray(media) && media.length > 0).toBe(true);
        expect(media[0].type).toBe('image');

        // …and the outgoing /responses request carried it as input_image.
        const gen = findGenerationRequest('Here is the sketch I made of the channel');
        expect(gen, 'no /responses request carried the sent user text').toBeTruthy();
        const body = gen.body;
        const imageParts = [];
        for (const item of Array.isArray(body.input) ? body.input : []) {
            if (Array.isArray(item?.content)) {
                for (const part of item.content) {
                    if (part?.type === 'input_image') imageParts.push(part);
                }
            }
        }
        expect(imageParts.length,
            `expected input_image part; input was: ${JSON.stringify(body.input)?.slice(0, 1200)}`).toBeGreaterThanOrEqual(1);
        expect(String(imageParts[0].image_url)).toMatch(/^data:image\/png;base64,/);
    });

    test('scenario 6 — non-streaming round trip maps usage into token count', async ({ page }) => {
        // Flip the stream flag on disk BEFORE this test's page loads.
        setStreamFlag(false);

        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        mock.scriptReply(NON_STREAM_REPLY);
        const { replyId, text } = await sendMessageAndAwaitReply(page, 'One plain answer, no theatrics — is the path safe?');
        expect(text.replace(/\*/g, '').trim()).toBe(NON_STREAM_REPLY.replace(/\*/g, ''));

        const gen = findGenerationRequest('One plain answer, no theatrics');
        expect(gen, 'no /responses request carried the sent user text').toBeTruthy();
        const body = gen.body;
        expect(body.stream).toBe(false);

        // The mock's non-streaming Responses usage is
        // {input_tokens:3, output_tokens:2, total_tokens:5}. The client
        // normalizes it (prompt_tokens=3 / completion_tokens=2) and the
        // message writer stamps completion_tokens into extra.token_count —
        // the only usage-derived value the chat surface exposes.
        const tokenCount = await page.evaluate((id) => {
            const ctx = window.Luker.getContext();
            return ctx.chat[id]?.extra?.token_count ?? null;
        }, replyId);
        expect(tokenCount).toBe(2);

        // Reasoning must survive the NON-streaming pipeline too: the
        // completed Responses object carries a reasoning output item, and
        // extractReasoningFromData maps message.reasoning_content into the
        // reasoning fold. Regression guard for the source switch missing
        // this chat_completion_source.
        mock.scriptCompletion(() => ({ reasoning: 'quiet chart work', text: 'The path holds until the second bell.' }));
        const s6UserText = 'Weigh the path once more, quietly.';
        await sendMessageAndAwaitReply(page, s6UserText);

        const gen2 = findGenerationRequest(s6UserText);
        expect(gen2, 'no /responses request carried the sent user text').toBeTruthy();
        expect(gen2.body.stream).toBe(false);

        const bubbleText2 = await page.locator('#chat .last_mes .mes_text').innerText();
        expect(bubbleText2).toContain('The path holds until the second bell.');
        const reasoningText2 = await page.evaluate(() => {
            const el = document.querySelector('#chat .last_mes .mes_reasoning_details .mes_reasoning');
            return el ? el.textContent : '';
        });
        expect(reasoningText2).toContain('quiet chart work');

        const persisted2 = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            const m = ctx.chat[ctx.chat.length - 1];
            return { mes: m.mes, reasoning: m.extra?.reasoning ?? '' };
        });
        expect(persisted2.mes).toContain('The path holds until the second bell.');
        expect(persisted2.reasoning).toContain('quiet chart work');
        mock.clearScriptedCompletion();

        // Restore streaming so later scenarios inherit the default.
        setStreamFlag(true);
    });

    test('scenario 7 — upstream 500 surfaces an error toast and the UI recovers', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        // One-shot upstream failure; nothing else queued so there is no
        // fallback reply to mask it. Body mirrors a real provider error
        // envelope — that's the shape the client's error parser surfaces
        // as a toast.
        mock.failNextResponses({
            status: 500,
            body: JSON.stringify({ error: { message: 'upstream exploded' } }),
        });

        const textarea = page.locator('#send_textarea');
        await textarea.fill('Say something to the failing backend.');
        await page.locator('#send_but:not(.displayNone)').waitFor({ state: 'visible', timeout: 30_000 });
        await page.evaluate(() => document.querySelector('#send_but').click());

        // An error toast appears naming the upstream failure.
        const toast = page.locator('.toast-error', { hasText: 'upstream exploded' }).last();
        await toast.waitFor({ state: 'visible', timeout: 30_000 });

        // The UI did not hang: stop button re-hides and send unblocks.
        // NB: #mes_stop hides via an inline display toggle, #send_but via
        // the displayNone class.
        await page.waitForFunction(() => {
            const stop = document.querySelector('#mes_stop');
            const send = document.querySelector('#send_but');
            const stopStyle = stop ? window.getComputedStyle(stop).display : 'none';
            const stopHidden = stopStyle === 'none';
            const sendVisible = send && !send.classList.contains('displayNone');
            return stopHidden && sendVisible;
        }, { timeout: 30_000 });
        const failedReqs = responsesRequests().filter(r => r.body?.input?.length);
        expect(failedReqs.length).toBeGreaterThanOrEqual(1);
    });
});
