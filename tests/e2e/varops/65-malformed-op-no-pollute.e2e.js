// #65 — var_ops failure does NOT pollute next turn (rendered panel).
//
// The variable-op-log apply layer (`applyPathOp`) defensively rejects
// forbidden path segments (`__proto__`, `constructor`, `prototype`) to
// block prototype-pollution writes from AI-generated paths. A rejected
// path is a no-op — it warns to the console but does NOT throw, and the
// op record IS still appended to extra.var_ops (extractor unconditionally
// pushes recognized matches; apply.js handles validity).
//
// The contract this test pins down through the rendered flask panel:
//
//   (1) A turn whose AI reply mixes one VALID op with one MALFORMED op
//       still applies the valid op and surfaces BOTH structured records
//       as rendered rows in the panel. The malformed op's apply is a
//       no-op, so no prototype pollution lands.
//
//   (2) The NEXT turn starts with the previous valid op's value still on
//       the baseline — the failure did not corrupt the variable cache or
//       leak prototype properties into subsequent state.
//
//   (3) A new write in the next turn lands cleanly. No phantom keys
//       inherited from the malformed op survive.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';
import { openVarOpsPanel, getRenderedVarOpsRows } from '../_lib/ui-mg-varops.js';

let server, mock;

// Turn 1: a VALID setvar followed by a MALFORMED setvar with a forbidden path.
const REPLY_TURN_1 = [
    '*Seraphina leans over the chart, marking the slate.* ',
    '{{setvar::wind::northerly}}',
    ' "Tonight the wind is northerly." ',
    // Forbidden segment — parsePathSegments returns [] → applyPathOp logs a
    // warn and returns without touching state.
    '{{setvar::roster.__proto__.polluted::yes}}',
    ' *She frowns at the smoke.* "And the lantern is restless."',
].join('');

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

test.describe('#65 — var_ops failure does NOT pollute next turn (rendered panel)', () => {
    test('malformed forbidden-path op is no-op; valid sibling lands; next turn starts clean', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        // Capture console warns so we can confirm the rejected-path warn
        // surfaced (proof the malformed op was caught at the apply layer,
        // not silently absorbed).
        const consoleEvents = [];
        page.on('console', msg => consoleEvents.push({ type: msg.type(), text: msg.text() }));
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
        const { replyId: id1 } = await sendMessageAndAwaitReply(page, 'Read me the wind tonight.');
        await page.waitForFunction((id) => {
            const ctx = window.Luker.getContext();
            const m = ctx.chat?.[id];
            return Boolean(m && Array.isArray(m?.extra?.var_ops) && m.extra.var_ops.length >= 2);
        }, id1, { timeout: 15_000 });

        // Extractor recorded BOTH ops — confirm via the rendered panel.
        await openVarOpsPanel(page, id1);
        const turn1Rows = await getRenderedVarOpsRows(page);
        expect(turn1Rows).toEqual([
            { op: 'setvar', key: 'wind', value: 'northerly', path: '' },
            { op: 'setvar', key: 'roster', value: 'yes', path: '__proto__.polluted' },
        ]);
        await page.locator('.popup:visible .popup-button-cancel').last().click().catch(() => {});
        await page.locator('.var-ops-panel').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});

        // Valid op landed; malformed op did NOT pollute anything.
        const stateAfter1 = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return {
                wind: ctx.chatMetadata?.variables?.wind ?? null,
                roster: ctx.chatMetadata?.variables?.roster ?? null,
                pollutedProto: ({}).polluted ?? null,
            };
        });
        expect(stateAfter1.wind).toBe('northerly');
        expect(stateAfter1.roster, 'no roster key conjured by forbidden-path op').toBeFalsy();
        expect(stateAfter1.pollutedProto, 'Object.prototype is not polluted').toBeNull();

        // The warn surfaced — proving the malformed op was caught at the
        // apply layer, not silently absorbed.
        const matchingFromPlaywright = consoleEvents.filter(e => e.text.includes('[variable-op-log] setvar path rejected'));
        const capturedInPage = await page.evaluate(() => Array.isArray(window.__capturedWarns) ? window.__capturedWarns.slice() : []);
        const matchingInPage = capturedInPage.filter(t => t.includes('[variable-op-log] setvar path rejected'));
        expect(
            matchingFromPlaywright.length + matchingInPage.length > 0,
            'expected forbidden-path warn',
        ).toBe(true);

        // ── Turn 2: a fresh valid op on a CLEAN baseline ──────────────
        const { replyId: id2 } = await sendMessageAndAwaitReply(page, 'Trim the wick, then tell me how it sits.');
        await page.waitForFunction((id) => {
            const ctx = window.Luker.getContext();
            const m = ctx.chat?.[id];
            return Boolean(m && Array.isArray(m?.extra?.var_ops) && m.extra.var_ops.length >= 1);
        }, id2, { timeout: 15_000 });

        await openVarOpsPanel(page, id2);
        const turn2Rows = await getRenderedVarOpsRows(page);
        expect(turn2Rows).toEqual([
            { op: 'setvar', key: 'watch_state', value: 'trimmed', path: '' },
        ]);
        await page.locator('.popup:visible .popup-button-cancel').last().click().catch(() => {});

        const stateAfter2 = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return ctx.chatMetadata?.variables ?? null;
        });
        expect(stateAfter2.wind).toBe('northerly');
        expect(stateAfter2.watch_state).toBe('trimmed');
        expect(stateAfter2.roster).toBeUndefined();

        const cleanProtoAfterTurn2 = await page.evaluate(() => ({}).polluted ?? null);
        expect(cleanProtoAfterTurn2).toBeNull();
    });
});
