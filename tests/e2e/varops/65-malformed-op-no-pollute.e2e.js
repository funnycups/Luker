// #65 — var_ops failure does NOT pollute next turn.
//
// The variable-op-log apply layer (`applyPathOp`) defensively rejects
// forbidden path segments (`__proto__`, `constructor`, `prototype`) to
// block prototype-pollution writes from AI-generated paths. A rejected
// path is a no-op — it warns to the console but does NOT throw, and the
// op record IS still appended to extra.var_ops (extractor unconditionally
// pushes recognized matches; apply.js handles validity).
//
// The contract this test pins down:
//
//   (1) A turn whose AI reply mixes one VALID op with one MALFORMED op
//       still applies the valid op and surfaces the structured record for
//       the malformed one. The malformed op's apply is a no-op, so no
//       prototype pollution lands.
//
//   (2) The NEXT turn starts with the previous valid op's value still on
//       the baseline — the failure did not corrupt the variable cache or
//       leak prototype properties into subsequent state.
//
//   (3) A new write in the next turn lands cleanly. No phantom keys
//       inherited from the malformed op survive.
//
// Why this matters: production AI replies sometimes generate path syntax
// they shouldn't, and a non-defensive apply would either crash extraction
// (taking down ALL ops in that turn) or pollute Object.prototype for the
// rest of the page session.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';

let server, mock;

// Turn 1: a VALID setvar followed by a MALFORMED setvar with a forbidden path.
// Apply order in extractor.js is strict source-order; the malformed op comes
// SECOND, so we can verify the first valid op's value persists.
const REPLY_TURN_1 = [
    '*Seraphina leans over the chart, marking the slate.* ',
    '{{setvar::wind::northerly}}',
    ' "Tonight the wind is northerly." ',
    // Forbidden segment — parsePathSegments returns [] → applyPathOp logs a
    // warn and returns without touching state.
    '{{setvar::roster.__proto__.polluted::yes}}',
    ' *She frowns at the smoke.* "And the lantern is restless."',
].join('');

// Turn 2: a fresh valid op — should land normally on top of the unpolluted state.
const REPLY_TURN_2 = [
    '*Seraphina sets the spyglass aside.* ',
    '{{setvar::watch_state::trimmed}}',
    ' "Lantern is trimmed; the wick will hold the next bell."',
].join('');

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [REPLY_TURN_1, REPLY_TURN_2] });
    server = await startServer({ batchKey: 'varops', scenarioId: 'failure-no-pollute' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#65 — var_ops failure does NOT pollute next turn', () => {
    test('malformed forbidden-path op is no-op; valid sibling lands; next turn starts clean', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        await page.waitForFunction(() => {
            const ctx = window.SillyTavern.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        // Capture all console messages. The malformed op should surface a
        // console.warn matching "[variable-op-log] setvar path rejected".
        // Note: page.on('console') captures the message text but Playwright's
        // event delivery is async. We check via consoleEvents after the turn.
        const consoleEvents = [];
        page.on('console', msg => {
            consoleEvents.push({ type: msg.type(), text: msg.text() });
        });
        // Also patch the window console to capture warns at the JS layer, as a
        // belt-and-suspenders in case Playwright drops some.
        await page.evaluate(() => {
            window.__capturedWarns = window.__capturedWarns || [];
            const origWarn = console.warn.bind(console);
            console.warn = (...args) => {
                try {
                    const text = args.map(a => typeof a === 'string' ? a : (() => {
                        try { return JSON.stringify(a); } catch { return String(a); }
                    })()).join(' ');
                    window.__capturedWarns.push(text);
                } catch { /* ignore */ }
                return origWarn(...args);
            };
        });

        // ── Turn 1: valid + malformed ops ─────────────────────────────
        await sendMessageAndAwaitReply(page, 'Read me the wind tonight.');

        const turn1 = await page.evaluate(() => {
            const ctx = window.SillyTavern.getContext();
            let asstId = -1;
            for (let i = ctx.chat.length - 1; i >= 0; i--) {
                if (!ctx.chat[i]?.is_user) { asstId = i; break; }
            }
            const m = ctx.chat[asstId];
            return {
                ops: m?.extra?.var_ops ?? null,
                variables: ctx.chatMetadata?.variables ?? null,
                // Prove no prototype pollution leaked out of the path-op.
                pollutedProto: ({}).polluted ?? null,
                pollutedRoster: (ctx.chatMetadata?.variables?.roster ?? null),
            };
        });

        // Both ops are recorded — extractor is order-blind to apply success.
        expect(turn1.ops, 'extractor records both ops, valid and malformed').toEqual([
            { op: 'setvar', key: 'wind', value: 'northerly' },
            { op: 'setvar', key: 'roster', path: '__proto__.polluted', value: 'yes' },
        ]);

        // Valid op's value landed.
        expect(turn1.variables.wind).toBe('northerly');

        // Forbidden path: no roster key created (the rejection path warns and
        // returns without writing state[op.key] for path-only writes since
        // segs.length === 0 after parsePathSegments rejects every segment).
        expect(turn1.pollutedRoster, 'no roster key conjured by forbidden-path op').toBeFalsy();
        expect(turn1.pollutedProto, 'Object.prototype is not polluted').toBeNull();

        // The warn surfaced — proving the malformed op was caught at the
        // apply layer, not silently absorbed. Check both the Playwright
        // console-event stream and our in-page capture.
        const matchingFromPlaywright = consoleEvents.filter(e => e.text.includes('[variable-op-log] setvar path rejected'));
        const capturedInPage = await page.evaluate(() => Array.isArray(window.__capturedWarns) ? window.__capturedWarns.slice() : []);
        const matchingInPage = capturedInPage.filter(t => t.includes('[variable-op-log] setvar path rejected'));
        expect(
            matchingFromPlaywright.length + matchingInPage.length > 0,
            `expected forbidden-path warn; playwright saw ${consoleEvents.length} console events,` +
                ` in-page captured ${capturedInPage.length} warns.\n` +
                `last playwright events:\n  ` + consoleEvents.slice(-10).map(e => `[${e.type}] ${e.text.slice(0, 200)}`).join('\n  ') +
                `\nlast in-page warns:\n  ` + capturedInPage.slice(-10).map(t => t.slice(0, 200)).join('\n  '),
        ).toBe(true);

        // ── Turn 2: a fresh valid op on a CLEAN baseline ──────────────
        await sendMessageAndAwaitReply(page, 'Trim the wick, then tell me how it sits.');

        const turn2 = await page.evaluate(() => {
            const ctx = window.SillyTavern.getContext();
            let asstId = -1;
            for (let i = ctx.chat.length - 1; i >= 0; i--) {
                if (!ctx.chat[i]?.is_user) { asstId = i; break; }
            }
            const m = ctx.chat[asstId];
            return {
                ops: m?.extra?.var_ops ?? null,
                variables: ctx.chatMetadata?.variables ?? null,
            };
        });

        expect(turn2.ops).toEqual([{ op: 'setvar', key: 'watch_state', value: 'trimmed' }]);
        // wind is still northerly from turn 1; watch_state is new.
        expect(turn2.variables.wind).toBe('northerly');
        expect(turn2.variables.watch_state).toBe('trimmed');
        // Still no roster, still no prototype pollution.
        expect(turn2.variables.roster).toBeUndefined();
        // Defensive: brand-new objects in this page session do not inherit `polluted`.
        const cleanProtoAfterTurn2 = await page.evaluate(() => ({}).polluted ?? null);
        expect(cleanProtoAfterTurn2).toBeNull();
    });
});
