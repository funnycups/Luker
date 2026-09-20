// generation-basic #9 — recovery completion must fire the message-completion
// event chain for the recovered reply.
//
// close-tab-ui-recovery.e2e.js (#8) locks the visual recovery flow: the
// reopened tab shows the streaming preview bubble and swaps in the
// server-persisted message when the job lands. But the completion path
// used to end at `reloadCurrentChat()` — plugins listening for the
// normal generation-completion events never heard about the recovered
// message:
//
//   - memory-graph extraction (GENERATION_ENDED → capture latest assistant)
//   - vectors indexing (MESSAGE_RECEIVED → onChatEvent)
//   - var-op-log panel refresh (MESSAGE_RECEIVED)
//   - TTS / audio keep-alive teardown (GENERATION_ENDED)
//   - PromptManager token display (MESSAGE_RECEIVED)
//
// This spec pins the contract that a recovered reply behaves like a // banned-words-allow
// normally-received one:
//
//   1. GENERATION_ENDED fires BEFORE MESSAGE_RECEIVED (ordering contract
//      from the normal path, commit 2edca162d), then CHARACTER_MESSAGE_RENDERED.
//   2. MESSAGE_RECEIVED / CHARACTER_MESSAGE_RENDERED carry the recovered
//      message id + generation type 'normal'.
//   3. Side-effect macros in the recovered reply are extracted (the server
//      persisted the raw text; the client must run the same var-op scan the
//      streaming path does) and the extracted state is persisted before the
//      emits (commit 6c99b32d0 persist-before-emit contract).
//
// The scripted reply carries a trailing {{setvar}} so assertion (3) has a
// positive signal: macro stripped from mes, op recorded in extra.var_ops,
// variable applied to chat_metadata.variables.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';

const CHUNKS = Array.from({ length: 20 }, (_, i) => `chunk${String(i + 1).padStart(2, '0')}`);
const SCRIPTED_REPLY = `${CHUNKS.join(' ')} {{setvar::reef_mood::restless}}`;
const CHUNK_DELAY_MS = 500;

async function startStreamAndCloseTab(browser, server) {
    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    await awaitMainUI(pageA, server.baseURL);
    await selectCharacterByName(pageA, 'Seraphina');
    await pageA.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 }).catch(() => {});

    await pageA.locator('#send_textarea').fill('Please stream slowly.');
    await pageA.locator('#send_but:not(.displayNone)').waitFor({ state: 'visible', timeout: 30_000 });
    await pageA.evaluate(() => document.querySelector('#send_but').click());

    await pageA.waitForFunction(() => {
        const bubbles = document.querySelectorAll('#chat .mes:not([is_user="true"])');
        for (const b of bubbles) {
            if ((b.querySelector('.mes_text')?.innerText || '').includes('chunk01')) return true;
        }
        return false;
    }, { timeout: 20_000 });

    await pageA.close();
    await contextA.close();

    await new Promise(r => setTimeout(r, 3000));
}

test.describe('generation-basic: recovery completion fires event chain', () => {
    let server, mock;

    test.beforeAll(async () => {
        mock = await startMockLLM({
            scriptedReplies: [SCRIPTED_REPLY],
            streamChunkDelayMs: CHUNK_DELAY_MS,
        });
        server = await startServer({ batchKey: 'generation', scenarioId: 'close-tab-events' });
        markOnboarded({ dataRoot: server.dataRoot });
        bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
        appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    });

    test.afterAll(async () => {
        await tearDownServer(server);
        await mock?.stop();
    });

    test('recovered reply fires GENERATION_ENDED → MESSAGE_RECEIVED → CHARACTER_MESSAGE_RENDERED', async ({ browser }) => {
        await startStreamAndCloseTab(browser, server);

        const contextB = await browser.newContext();
        const pageB = await contextB.newPage();
        await awaitMainUI(pageB, server.baseURL);
        await selectCharacterByName(pageB, 'Seraphina');

        await pageB.waitForFunction(() => Boolean(document.querySelector('#luker_generation_recovery_preview')), { timeout: 20_000 });

        // Register the event listeners BEFORE the job can land so no emit
        // can slip past the test.
        await pageB.evaluate(() => {
            const ctx = window.Luker.getContext();
            window.__recoveryEvents = [];
            const record = (name) => (...args) => {
                window.__recoveryEvents.push({ name, args: JSON.parse(JSON.stringify(args)) });
            };
            ctx.eventSource.on(ctx.eventTypes.GENERATION_ENDED, record('generation_ended'));
            ctx.eventSource.on(ctx.eventTypes.MESSAGE_RECEIVED, record('message_received'));
            ctx.eventSource.on(ctx.eventTypes.CHARACTER_MESSAGE_RENDERED, record('character_message_rendered'));
        });

        // The full chain ends with CHARACTER_MESSAGE_RENDERED.
        await pageB.waitForFunction(() => {
            const evts = window.__recoveryEvents || [];
            return evts.some(e => e.name === 'character_message_rendered');
        }, { timeout: 60_000 });

        const state = await pageB.evaluate(() => {
            const ctx = window.Luker.getContext();
            return {
                events: window.__recoveryEvents,
                chatLength: ctx.chat.length,
                chat: ctx.chat.map(m => ({
                    is_user: !!m.is_user,
                    mes: String(m.mes || ''),
                    varOps: Array.isArray(m.extra?.var_ops) ? m.extra.var_ops : null,
                })),
                variables: ctx.chatMetadata?.variables || {},
            };
        });

        const genEnded = state.events.find(e => e.name === 'generation_ended');
        const msgReceived = state.events.find(e => e.name === 'message_received');
        const charRendered = state.events.find(e => e.name === 'character_message_rendered');
        expect(genEnded, 'GENERATION_ENDED must fire for the recovered reply').toBeTruthy();
        expect(msgReceived, 'MESSAGE_RECEIVED must fire for the recovered reply').toBeTruthy();
        expect(charRendered, 'CHARACTER_MESSAGE_RENDERED must fire for the recovered reply').toBeTruthy();

        // Ordering contract: GENERATION_ENDED strictly before MESSAGE_RECEIVED,
        // MESSAGE_RECEIVED strictly before CHARACTER_MESSAGE_RENDERED.
        const idxGen = state.events.indexOf(genEnded);
        const idxMsg = state.events.indexOf(msgReceived);
        const idxChar = state.events.indexOf(charRendered);
        expect(idxGen).toBeLessThan(idxMsg);
        expect(idxMsg).toBeLessThan(idxChar);

        // Payload contract: ids point at the recovered (last) message, type 'normal'.
        const replyId = msgReceived.args[0];
        expect(replyId).toBe(state.chatLength - 1);
        expect(genEnded.args[0]).toBe(state.chatLength);
        expect(msgReceived.args[1]).toBe('normal');
        expect(charRendered.args[0]).toBe(replyId);

        // Extraction ran on the recovered reply: macro stripped from mes,
        // setvar op recorded in extra.var_ops, variable applied to metadata.
        const reply = state.chat[replyId];
        expect(reply.mes).toContain('chunk20');
        expect(reply.mes, 'side-effect macro must be stripped from the recovered reply').not.toContain('{{setvar');
        expect(reply.varOps?.some(op => op.op === 'setvar' && op.key === 'reef_mood' && op.value === 'restless'),
            'extracted var_ops must record the setvar op').toBe(true);
        expect(state.variables.reef_mood).toBe('restless');

        // The rendered bubble shows the stripped text.
        const rendered = await pageB.locator(`.mes[mesid="${replyId}"] .mes_text`).first().innerText({ timeout: 10_000 });
        expect(rendered).toContain('chunk20');
        expect(rendered).not.toContain('{{setvar');

        await contextB.close();
    });
});
