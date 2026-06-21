// #61b — Conditional var op (if/case in macro engine) end-to-end through the flask panel.
//
// The variable-op-log scanner is NOT condition-aware: it walks the AI reply
// text in source order, recognizes any {{setvar}} / {{incvar}} / etc. token,
// and records the op immediately. Wrappers like {{if}}…{{else}}…{{/if}} are
// merely passive text from the scanner's perspective — both branches get
// extracted into ops.
//
// We assert this contract two ways through the real flask-icon panel:
//
//   (1) An AI reply containing {{if 0}}{{setvar::wind::southerly}}{{else}}
//       {{setvar::wind::northerly}}{{/if}} renders BOTH set-ops as panel
//       rows (not just the else-branch's), and the wind variable lands at
//       the value of the second op (apply order: later wins) because the
//       scanner has no concept of branches.
//
//   (2) When the AI itself chooses one branch and emits only that macro,
//       the panel shows exactly one row.
//
// Both behaviors are codified here so a future refactor that adds
// conditional-aware extraction must update this test deliberately.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';
import { openVarOpsPanel, getRenderedVarOpsRows } from '../_lib/ui-mg-varops.js';

let server, mock;

const REPLY_WITH_IF_WRAPPER = [
    '*Seraphina glances at the slate she keeps under the lantern base.* ',
    '"The wind tells me which way to read it." ',
    '{{if 0}}{{setvar::wind::southerly}}{{else}}{{setvar::wind::northerly}}{{/if}} ',
    '*She taps the chart, smoke curling at her wrist.* ',
    '"Either way, the third breaker is restless."',
].join('');

const REPLY_LLM_CHOSE_BRANCH = [
    '*Seraphina settles onto the bench, fingers spread on the chart.* ',
    '"Tonight it is northerly — I can smell the kelp burn." ',
    '{{setvar::wind::northerly}}',
    ' "Bank the lantern accordingly."',
].join('');

test.beforeAll(async () => {
    mock = await startMockLLM({
        scriptedReplies: [REPLY_WITH_IF_WRAPPER, REPLY_LLM_CHOSE_BRANCH],
    });
    server = await startServer({ batchKey: 'varops', scenarioId: 'conditional-op' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#61b — Conditional var op (if-wrapper) end-to-end through the flask panel', () => {
    test('extractor is condition-blind: both branches of {{if}} render as panel rows; LLM-driven branch shows one row', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        // ── Turn 1: AI emits a reply wrapped in {{if 0}}…{{else}}…{{/if}} ──
        const { replyId: id1 } = await sendMessageAndAwaitReply(
            page,
            'Which way is the wind blowing tonight?',
        );

        await page.waitForFunction((id) => {
            const ctx = window.Luker.getContext();
            const m = ctx.chat?.[id];
            return Boolean(m && Array.isArray(m?.extra?.var_ops) && m.extra.var_ops.length >= 2);
        }, id1, { timeout: 15_000 });

        // Real-UI assertion: open the flask icon, read rendered rows.
        await openVarOpsPanel(page, id1);
        const turn1Rows = await getRenderedVarOpsRows(page);
        expect(turn1Rows.map(r => r.value)).toEqual(['southerly', 'northerly']);
        expect(turn1Rows.map(r => r.key)).toEqual(['wind', 'wind']);
        await page.locator('.popup-button-cancel').first().click().catch(() => {});

        const windAfterTurn1 = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return ctx.chatMetadata?.variables?.wind ?? null;
        });
        expect(windAfterTurn1, 'apply order means later op wins').toBe('northerly');

        const mesAfterTurn1 = await page.evaluate((id) => {
            const ctx = window.Luker.getContext();
            return ctx.chat?.[id]?.mes ?? '';
        }, id1);
        expect(mesAfterTurn1).toContain('{{if 0}}');
        expect(mesAfterTurn1).toContain('{{/if}}');
        expect(mesAfterTurn1).not.toContain('{{setvar');

        // ── Turn 2: AI itself picks a branch and only emits that op ──
        const { replyId: id2 } = await sendMessageAndAwaitReply(page, 'And now? Has it shifted?');

        await page.waitForFunction((id) => {
            const ctx = window.Luker.getContext();
            const m = ctx.chat?.[id];
            return Boolean(m && Array.isArray(m?.extra?.var_ops) && m.extra.var_ops.length >= 1);
        }, id2, { timeout: 15_000 });

        await openVarOpsPanel(page, id2);
        const turn2Rows = await getRenderedVarOpsRows(page);
        expect(turn2Rows).toEqual([
            { op: 'setvar', key: 'wind', value: 'northerly', path: '' },
        ]);
        await page.locator('.popup-button-cancel').first().click().catch(() => {});

        const windAfterTurn2 = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return ctx.chatMetadata?.variables?.wind ?? null;
        });
        expect(windAfterTurn2).toBe('northerly');
    });
});
