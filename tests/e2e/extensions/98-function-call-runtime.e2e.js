// Case #98 — Function-call runtime: register custom tool, mock invokes it,
//             result loops back into next turn's prompt, final bubble has
//             "sunny" + "21°C".
//
// Round-trip flow:
//   1. Test registers `get_weather({city})` via
//        ctx.registerFunctionTool({ name, action: () => "sunny, 21°C", ... })
//      Action returns a hardcoded string so the assertion is deterministic.
//   2. Test enables oai_settings.function_calling = true and forces a NONE
//      custom_prompt_post_processing (the empty string, NOT 'none' — the
//      latter silently disables tool calling per the briefing).
//   3. Test scripts a tool_calls response into the mock LLM (first call),
//      then a plain-text reply for the second call.
//   4. Test sends a user turn. /trigger generates → mock returns tool_calls
//      → Luker invokes the tool → saveFunctionToolInvocations appends a
//      system message with the invocation record → Generate recurses →
//      mock pops the second reply → that text lands in chat.
//   5. Test asserts the final assistant bubble (NOT the tool-call system
//        message) contains "sunny" and "21°C".

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';

let server, mock;

const TOOL_RESULT = 'sunny, 21°C';

test.beforeAll(async () => {
    // No scripted replies up front — we push them inside the test in
    // the right order so the mock's tool/reply FIFO matches Luker's
    // expected request sequence (tool_calls → recurse → text).
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

test.describe('#98 — Function call runtime round-trip', () => {
    test('registered get_weather tool is invoked, result fed back, final reply contains "sunny" + "21°C"', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        // Enable native function calling. NONE is the empty string —
        // setting 'none' would silently disable tool calling per the
        // briefing note. Stream off so chunk/queue races don't blur the
        // assertion (the mock supports both, and the streaming path is
        // exercised in other batches).
        await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            // Reach into oai_settings via the openai.js module.
            return import('/scripts/openai.js').then(mod => {
                mod.oai_settings.function_calling = true;
                mod.oai_settings.custom_prompt_post_processing = '';
                // Disable streaming for this test only — it's the simpler
                // path through ToolManager and lets us await the recurse.
                mod.oai_settings.stream_openai = false;
                mod.oai_settings.tool_call_recurse_limit = 5;
                ctx.ToolManager.RECURSE_LIMIT = 5;
            });
        });

        // Register the get_weather tool. Action returns the hardcoded
        // string the mock will echo back into the prompt.
        await page.evaluate((toolResult) => {
            const ctx = window.Luker.getContext();
            // Defensive: drop any prior registration so re-runs don't double up.
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

        // Confirm the tool registry sees it.
        const registeredNames = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            // ToolDefinition keeps `name` as a private field; project it
            // via the public toFunctionOpenAI() shape instead.
            return ctx.ToolManager.tools.map(t => t.toFunctionOpenAI?.().function?.name);
        });
        expect(registeredNames).toContain('get_weather');

        // Script the LLM responses: 1st call = tool_call, 2nd call = text.
        // The mockLLM is currently queue-empty; push in order.
        // (page-side push because mock.requests is server-side state but
        //  scriptReply/scriptToolCall are server-side APIs we have direct
        //  Node access to — we don't need page.evaluate for these.)
        const finalText = '*Ash glances at the lantern and answers without looking up.* "It will be sunny tomorrow — 21°C at midday by the chart\'s reckoning."';
        mock.scriptToolCall({ name: 'get_weather', arguments: { city: 'Bryn-on-Sea' } });
        mock.scriptReply(finalText);

        // Send a turn that motivates the tool call.
        const chatLenBefore = await page.evaluate(() => window.Luker.getContext().chat.length);
        await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            await ctx.executeSlashCommandsWithOptions('/send What will the weather be tomorrow in Bryn-on-Sea? | /trigger await=true');
        });

        // Wait until two new things land: the tool-call system message
        // (from saveFunctionToolInvocations) AND the final assistant
        // message. With both, chat.length should be at least +3 from
        // before (user + tool-call sysmsg + assistant text). Be generous
        // about the exact count — Luker may also append other internal
        // markers depending on settings.
        await page.waitForFunction((targetLen) => {
            const ctx = window.Luker.getContext();
            // Look for an assistant message that's not the tool-invocation
            // record (which is is_system) after the user's turn.
            return ctx.chat.some((m, i) => i > targetLen && !m.is_user && !m.is_system && typeof m.mes === 'string' && m.mes.includes('sunny'));
        }, chatLenBefore, { timeout: 60_000 });

        // ===== Assert the mock saw two chat completion requests. =====
        // First with our tool advertised; second with the tool's result
        // present somewhere in the messages array (role=tool, content=TOOL_RESULT).
        const chatReqs = mock.requests.filter(r => r.url.includes('chat/completions'));
        expect(chatReqs.length).toBeGreaterThanOrEqual(2);

        const firstReq = chatReqs[chatReqs.length - 2];
        const secondReq = chatReqs[chatReqs.length - 1];
        // First request must advertise the tool.
        expect(Array.isArray(firstReq.body.tools)).toBe(true);
        const toolNames = firstReq.body.tools.map(t => t?.function?.name);
        expect(toolNames).toContain('get_weather');
        // Second request must carry the tool result back as a tool message.
        const secondMsgs = secondReq.body.messages || [];
        const toolMsg = secondMsgs.find(m => m.role === 'tool');
        expect(toolMsg, 'tool result must be appended to the next turn as a role=tool message').toBeTruthy();
        const toolContent = typeof toolMsg.content === 'string'
            ? toolMsg.content
            : JSON.stringify(toolMsg.content);
        expect(toolContent).toContain('sunny');
        expect(toolContent).toContain('21°C');

        // ===== Assert the final assistant bubble has both tokens. =====
        const finalBubble = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            for (let i = ctx.chat.length - 1; i >= 0; i--) {
                const m = ctx.chat[i];
                if (!m.is_user && !m.is_system && typeof m.mes === 'string') {
                    return m.mes;
                }
            }
            return null;
        });
        expect(finalBubble, 'final assistant message must exist').toBeTruthy();
        // Per feedback_no_silent_truncation, the bubble is 1:1 with model
        // output. Both tokens must be present.
        expect(finalBubble).toContain('sunny');
        expect(finalBubble).toContain('21°C');

        // ===== Sanity: the registered tool was actually invoked. =====
        // saveFunctionToolInvocations pushes a system message with
        // extra.tool_invocations[] — find it and check its `result`.
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
