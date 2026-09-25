// Tool-invocation records cascade out of the prompt when their owner
// message is hidden. Storage keeps each round's tool calls as a compact
// `is_system` message with `extra.tool_invocations`; at prompt-build time
// they are merged back into the owning assistant turn so the wire shape
// is `assistant(tool_calls) → role:tool`. None of the hiding channels —
// `/hide` (is_system), the ignore symbol, or a regex script blanking the
// message text — used to stop that merge, so "hidden" tool history kept
// flowing to the provider. This suite locks the cascade for all three
// channels plus the reasoning-round guard that must NOT drop.

import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';

// Distinctive text so request-body greps can tell turns apart.
const T1_USER = 'Turn one: read the barometer before we talk about the crossing.';
const T1_FINAL = '*Ash taps the gauge glass.* "Pressure falling — the storm will reach us by the second watch."';
const T2_USER = 'Turn two: secure the lantern oil against the tide.';
const T2_FINAL = '*Ash lashes the oil drum to the mast step.* "Double hitch holds through a full gale."';
const T3_USER = 'Turn three: what does the sounding lead show?';
const T3_FINAL = '*Ash pays out the line.* "Six fathoms over sand — we keep the reef on our left."';
const T4_USER = 'Turn four: mark the tide rack before dark.';
const T4_FINAL = '*Ash notches the rack with a chisel.* "Two above the last spring mark."';

function lastChatRequest(mock, { afterIdx = 0 } = {}) {
    const reqs = mock.requests
        .filter((r, i) => i >= afterIdx && /\/chat\/completions$/.test(r.url))
        .filter(r => {
            // Chat generation requests may carry the registered tool; the
            // mock's scripted-toolCall queue only serves the main turn
            // (tool invocations run in-page). Pick requests that contain
            // the current user turn instead of fingerprinting tools.
            const msgs = Array.isArray(r.body?.messages) ? r.body.messages : [];
            return msgs.some(m => m?.role === 'user' && typeof m.content === 'string');
        });
    return reqs[reqs.length - 1] || null;
}

async function wireToolCalls(body) {
    const msgs = Array.isArray(body?.messages) ? body.messages : [];
    return msgs.filter(m => Array.isArray(m.tool_calls));
}

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [] });
    server = await startServer({ batchKey: 'chat', scenarioId: 'tool-invocation-hide-cascade' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    // Keep background extraction (memory-graph) from consuming scripted
    // replies against its own /chat/completions calls.
    const sp = resolve(server.dataRoot, 'default-user', 'settings.json');
    const s = JSON.parse(readFileSync(sp, 'utf8'));
    s.extension_settings = s.extension_settings || {};
    s.extension_settings.memory_graph = { ...(s.extension_settings.memory_graph || {}), enabled: false };
    // The reasoning-round guard case exercises the reasoning pipeline:
    // extraction (and thus extra.reasoning on the empty intermediary
    // assistant turn) only runs with the "Show thoughts" toggle on.
    s.oai_settings = s.oai_settings || {};
    s.oai_settings.show_thoughts = true;
    writeFileSync(sp, JSON.stringify(s, null, 4));
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe.configure({ mode: 'serial' });

test.describe('tool-invocation hide cascade', () => {
    let page;

    test.beforeAll(async ({ browser }) => {
        page = await browser.newPage();
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        // Native tool calling on, non-streamed (deterministic shapes).
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
        // Register one tool the model can call.
        await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            try { ctx.unregisterFunctionTool('sound_lead'); } catch {}
            ctx.registerFunctionTool({
                name: 'sound_lead',
                displayName: 'Sound the lead',
                description: 'Drops the sounding lead and returns the depth reading.',
                parameters: {
                    type: 'object',
                    properties: { spot: { type: 'string', description: 'Where to sound.' } },
                    required: ['spot'],
                    additionalProperties: false,
                },
                action: async ({ spot }) => `depth reading at ${spot}: four fathoms over shell`,
                formatMessage: ({ spot }) => `Sounding the lead at ${spot}...`,
                shouldRegister: () => true,
                stealth: false,
            });
        });

        // Turn 1: plain round-trip, no tools — baseline content.
        mock.scriptReply(T1_FINAL);
        await sendMessageAndAwaitReply(page, T1_USER);

        // Turn 2: tool round → final. The invocation record lands as a
        // compact system message between them.
        mock.scriptToolCall({ name: 'sound_lead', arguments: { spot: 'the narrows' } });
        mock.scriptReply(T2_FINAL);
        await sendMessageAndAwaitReply(page, T2_USER);

        // Turn 3: tool round → final. This turn's owner will be /hide'd.
        mock.scriptToolCall({ name: 'sound_lead', arguments: { spot: 'the shallows' } });
        mock.scriptReply(T3_FINAL);
        await sendMessageAndAwaitReply(page, T3_USER);

        // Turn 4: plain reply so a later turn exists to carry the prompt.
        mock.scriptReply(T4_FINAL);
        await sendMessageAndAwaitReply(page, T4_USER);
    });

    test.afterAll(async () => {
        await page?.close();
    });

    test('baseline — tool records persist as compact system messages', async () => {
        const shape = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return ctx.chat.map(m => ({
                mes: String(m.mes || '').slice(0, 60),
                isUser: !!m.is_user,
                isSystem: !!m.is_system,
                isSmallSys: !!m?.extra?.isSmallSys,
                hasInvocations: Array.isArray(m?.extra?.tool_invocations) && m.extra.tool_invocations.length > 0,
            }));
        });
        expect(shape.some(m => m.isUser && m.mes.includes('Turn two'))).toBe(true);
        expect(shape.some(m => m.isSmallSys && m.hasInvocations)).toBe(true);
    });

    test('/hide on the tool-owning assistant reply drops its tool records from the wire', async () => {
        // DOM-first: locate the T3 reply in the rendered chat; its text
        // must be present before we hide it.
        const ownerIdx = await page.locator('#chat .mes .mes_text', { hasText: 'Six fathoms' }).allInnerTexts();
        expect(ownerIdx.length).toBeGreaterThanOrEqual(1);

        // /hide by index of the assistant reply that owns turn 3's
        // invocation record (T3_FINAL is the merged final reply).
        const mesId = await page.evaluate((needle) => {
            const ctx = window.Luker.getContext();
            const reply = ctx.chat.find(m => !m.is_user && !m.is_system && String(m.mes).includes(needle));
            return reply ? ctx.chat.indexOf(reply) : -1;
        }, 'Six fathoms');
        expect(mesId).toBeGreaterThanOrEqual(0);

        const textarea = page.locator('#send_textarea');
        await textarea.fill(`/hide ${mesId}`);
        await page.locator('#send_but:not(.displayNone)').waitFor({ state: 'visible', timeout: 10_000 });
        await page.evaluate(() => document.querySelector('#send_but').click());
        await page.waitForTimeout(400);

        // Storage untouched: the hidden reply is still in chat[] with
        // is_system=true (the tool record keeps its own flags).
        const hiddenFlags = await page.evaluate((needle) => {
            const ctx = window.Luker.getContext();
            const reply = ctx.chat.find(m => String(m.mes).includes(needle));
            return reply ? { isSystem: !!reply.is_system } : null;
        }, 'Six fathoms');
        expect(hiddenFlags, 'the hidden reply must still be stored').toBeTruthy();
        expect(hiddenFlags.isSystem).toBe(true);

        // Wire: next generation must carry T1+T2 tool calls but NOT T3's.
        const reqStart = mock.requests.length;
        mock.scriptReply('*Ash rolls the sounding line away.* "Enough for tonight."');
        await sendMessageAndAwaitReply(page, 'Turn five: stow the lead line for the night.');

        const req = lastChatRequest(mock, { afterIdx: reqStart });
        expect(req, 'a generation request fired after /hide').toBeTruthy();
        const toolCallMsgs = await wireToolCalls(req.body);
        const flat = JSON.stringify(toolCallMsgs);
        expect(flat, 'turn-two tool calls survive the hide of turn three').toContain('sound_lead');
        // The turn-3 invocation's distinctive argument must be gone.
        const allMsgs = JSON.stringify(req.body.messages);
        expect(allMsgs.includes('the shallows'), 'hidden turn tool invocation argument leaked to the wire').toBe(false);
        // The hidden reply text itself must be gone too.
        expect(allMsgs.includes('Six fathoms'), 'hidden reply text leaked to the wire').toBe(false);

        // Restore for subsequent tests.
        await textarea.fill(`/unhide ${mesId}`);
        await page.evaluate(() => document.querySelector('#send_but').click());
        await page.waitForTimeout(400);
    });

    test('ignore symbol on the owner behaves like /hide', async () => {
        const mesId = await page.evaluate((needle) => {
            const ctx = window.Luker.getContext();
            const reply = ctx.chat.find(m => !m.is_user && !m.is_system && String(m.mes).includes(needle));
            return reply ? ctx.chat.indexOf(reply) : -1;
        }, 'Double hitch');
        expect(mesId).toBeGreaterThanOrEqual(0);

        await page.evaluate((id) => {
            const ctx = window.Luker.getContext();
            const msg = ctx.chat[id];
            if (msg) {
                msg.extra = msg.extra || {};
                msg.extra[ctx.symbols.ignore] = true;
            }
        }, mesId);

        const reqStart = mock.requests.length;
        mock.scriptReply('*Ash checks the lashings.* "Still tight."');
        await sendMessageAndAwaitReply(page, 'Turn six: check the lashings once more.');

        const req = lastChatRequest(mock, { afterIdx: reqStart });
        expect(req).toBeTruthy();
        const allMsgs = JSON.stringify(req.body.messages);
        // Turn 2's distinctive tool argument must be gone (its owner carries
        // the ignore symbol). Turn 3 was un-hidden at the end of the previous
        // test, so 'the shallows' is legitimately back — do not grep the
        // tool name, only this owner's invocation fingerprint.
        expect(allMsgs.includes('the narrows'), 'ignore-symbol owner still sent its tool calls').toBe(false);
        expect(allMsgs.includes('Double hitch'), 'ignore-symbol owner text leaked').toBe(false);
    });

    test('blanking the owner via a prompt-lane regex script drops its tool records too', async () => {
        // Register an AI-output regex that erases exactly the T3 reply (a
        // distinctive phrase in it) on the prompt lane only.
        await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            const scripts = ctx.extensionSettings.regex || (ctx.extensionSettings.regex = []);
            scripts.push({
                id: 'e2e-blank-t3-owner',
                scriptName: 'Blank T3 owner (prompt lane)',
                findRegex: '/^[\\s\\S]*Six fathoms over sand[\\s\\S]*/g',
                replaceString: '',
                placement: [2],
                disabled: false,
                markdownOnly: false,
                promptOnly: true,
                minDepth: null,
                maxDepth: null,
            });
            ctx.saveSettingsDebounced?.();
        });

        const reqStart = mock.requests.length;
        mock.scriptReply('*Ash caps the oil.* "Done for the evening."');
        await sendMessageAndAwaitReply(page, 'Turn seven: cap the oil cask for the evening.');

        const req = lastChatRequest(mock, { afterIdx: reqStart });
        expect(req).toBeTruthy();
        const allMsgs = JSON.stringify(req.body.messages);
        expect(allMsgs.includes('Six fathoms'), 'regex-blanked owner text still on the wire').toBe(false);
        // Turn 2 is still visible from test 3's perspective, so its tool
        // records legitimately remain — fingerprint ONLY the blanked turn.
        expect(allMsgs.includes('the shallows'), 'regex-blanked owner kept its tool records on the wire').toBe(false);
    });

    test('reasoning round guard — an empty-text tool round with reasoning keeps its tool records', async () => {
        // A tool round where the model returns reasoning + tool_calls and
        // no text produces (after merge) an assistant message with empty
        // mes but extra.reasoning present. The blank-owner drop must NOT
        // fire on that shape — it is the canonical wire shape for
        // reasoning models.
        mock.scriptCompletion(() => ({ reasoning: 'need to check the glass', tool: 'sound_lead', arguments: { spot: 'the glass' } }));
        mock.scriptReply('*Ash reads the barometer.* "Falling fast — we anchor at the river mouth."');
        await sendMessageAndAwaitReply(page, 'Turn eight: what does the barometer say?');

        // The reasoning round's invocation record must be on the wire.
        const reqStart = mock.requests.length;
        mock.scriptReply('*Ash nods.* "Then we ride it out."');
        await sendMessageAndAwaitReply(page, 'Turn nine: we ride it out then.');

        const req = lastChatRequest(mock, { afterIdx: reqStart });
        expect(req).toBeTruthy();
        const allMsgs = JSON.stringify(req.body.messages);
        expect(allMsgs.includes('sound_lead'), 'reasoning-round tool records were dropped by the blank-owner rule').toBe(true);
        expect(allMsgs.includes('the glass'), 'reasoning-round tool result missing').toBe(true);
    });
});
