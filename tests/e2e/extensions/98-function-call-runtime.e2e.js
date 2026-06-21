// Case #98 — Function-call runtime via REAL send (not slash exec)
//
// Round-trip flow:
//   1. Test registers `get_weather({city})` via the production
//      ctx.registerFunctionTool API (the same surface extensions use).
//   2. Test enables oai_settings.function_calling = true.
//   3. Test scripts the mock LLM responses: first call returns a
//      tool_call for get_weather, second call returns plain text that
//      mentions sunny + 21°C.
//   4. Test types a user question into #send_textarea + clicks #send_but
//      (real user gesture). Luker invokes the tool, recurses into the
//      LLM with the tool result, the second reply lands in chat.
//   5. Test asserts the final assistant bubble (rendered DOM text on
//      .mes_text) contains "sunny" and "21°C". Also asserts the
//      side effect — invocations record — landed in the chat.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';

let server, mock;

const TOOL_RESULT = 'sunny, 21°C';

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [], scriptedToolCalls: [] });
    server = await startServer({ batchKey: 'extensions', scenarioId: '98-tool-call' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#98 — function-call runtime tool round-trip via real send', () => {
    test('mock returns tool_call → registered tool runs → final bubble has "sunny" + "21°C"', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        // Enable native function calling. Setting custom_prompt_post_processing
        // to '' (empty NONE, not 'none') keeps tool calling active.
        await page.evaluate(() => {
            return import('/scripts/openai.js').then(mod => {
                mod.oai_settings.function_calling = true;
                mod.oai_settings.custom_prompt_post_processing = '';
                mod.oai_settings.stream_openai = false;
                mod.oai_settings.tool_call_recurse_limit = 5;
                const ctx = window.Luker.getContext();
                ctx.ToolManager.RECURSE_LIMIT = 5;
            });
        });

        // Register the tool via the same registerFunctionTool API
        // extensions use — this is production-equivalent setup, not a
        // test-only hook.
        await page.evaluate((toolResult) => {
            const ctx = window.Luker.getContext();
            try { ctx.unregisterFunctionTool('get_weather'); } catch {}
            ctx.registerFunctionTool({
                name: 'get_weather',
                displayName: 'Get Weather',
                description: 'Returns the current weather for the named city. Use when the user asks about weather.',
                parameters: {
                    type: 'object',
                    properties: {
                        city: { type: 'string', description: 'City name, e.g. "Bryn-on-Sea".' },
                    },
                    required: ['city'],
                    additionalProperties: false,
                },
                action: async ({ city }) => toolResult,
                formatMessage: ({ city }) => `Checking weather for ${city}...`,
                shouldRegister: () => true,
                stealth: false,
            });
        }, TOOL_RESULT);

        // Sanity: the registry sees the tool.
        const registeredNames = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return ctx.ToolManager.tools.map(t => t.toFunctionOpenAI?.().function?.name);
        });
        expect(registeredNames).toContain('get_weather');

        // Script the LLM responses: 1st call = tool_call, 2nd call = text.
        const finalText = '*Ash glances at the lantern and answers without looking up.* "It will be sunny tomorrow — 21°C at midday by the chart\'s reckoning."';
        mock.scriptToolCall({ name: 'get_weather', arguments: { city: 'Bryn-on-Sea' } });
        mock.scriptReply(finalText);

        // REAL send: type into the textarea, click send.
        const chatLenBefore = await page.evaluate(() => window.Luker.getContext().chat.length);
        await sendMessageAndAwaitReply(page, 'What will the weather be tomorrow in Bryn-on-Sea?');

        // After the user turn lands and the tool result loops back through
        // Generate(), the final assistant bubble must contain both tokens.
        await page.waitForFunction((targetLen) => {
            const ctx = window.Luker.getContext();
            return ctx.chat.some((m, i) => i > targetLen && !m.is_user && !m.is_system && typeof m.mes === 'string' && m.mes.includes('sunny'));
        }, chatLenBefore, { timeout: 60_000 });

        // ===== Assert the mock saw two chat completion requests. =====
        const chatReqs = mock.requests.filter(r => r.url.includes('chat/completions'));
        expect(chatReqs.length).toBeGreaterThanOrEqual(2);
        const firstReq = chatReqs[chatReqs.length - 2];
        const secondReq = chatReqs[chatReqs.length - 1];
        expect(Array.isArray(firstReq.body.tools)).toBe(true);
        const toolNames = firstReq.body.tools.map(t => t?.function?.name);
        expect(toolNames).toContain('get_weather');
        const secondMsgs = secondReq.body.messages || [];
        const toolMsg = secondMsgs.find(m => m.role === 'tool');
        expect(toolMsg, 'tool result must be appended to the next turn as a role=tool message').toBeTruthy();
        const toolContent = typeof toolMsg.content === 'string' ? toolMsg.content : JSON.stringify(toolMsg.content);
        expect(toolContent).toContain('sunny');
        expect(toolContent).toContain('21°C');

        // ===== Assert the final assistant bubble in DOM has both tokens. =====
        // Read .mes_text directly from the rendered chat — proves the user
        // actually sees the answer, not just that ctx.chat has it.
        const renderedTexts = await page.locator('#chat .mes .mes_text').allInnerTexts();
        const finalBubble = [...renderedTexts].reverse().find(t => /sunny/.test(t) && /21/.test(t));
        expect(finalBubble, `expected DOM .mes_text containing sunny + 21°C; saw ${JSON.stringify(renderedTexts.slice(-3))}`).toBeTruthy();
        expect(finalBubble).toContain('sunny');
        expect(finalBubble).toContain('21°C');

        // ===== Sanity: the tool was actually invoked. =====
        // saveFunctionToolInvocations writes a system message with
        // extra.tool_invocations[] — find it and confirm the result.
        const invocationRecord = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            for (let i = ctx.chat.length - 1; i >= 0; i--) {
                const m = ctx.chat[i];
                const inv = Array.isArray(m?.extra?.tool_invocations) ? m.extra.tool_invocations : null;
                if (inv && inv.length > 0) return inv[0];
            }
            return null;
        });
        expect(invocationRecord, 'a tool_invocations sysmsg should be in chat').toBeTruthy();
        expect(invocationRecord.name).toBe('get_weather');
        expect(String(invocationRecord.result)).toContain('sunny');
        expect(String(invocationRecord.result)).toContain('21°C');
    });
});
