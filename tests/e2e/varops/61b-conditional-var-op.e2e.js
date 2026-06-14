// #61b — Conditional var op (if/case in macro engine) end-to-end through floor commit.
//
// The variable-op-log scanner is NOT condition-aware: it walks the AI reply
// text in source order, recognizes any {{setvar}} / {{incvar}} / etc. token,
// and applies the op immediately. Wrappers like {{if}}…{{else}}…{{/if}} are
// merely passive text from the scanner's perspective — both branches get
// extracted and forward-applied.
//
// That is a design decision (see public/scripts/variable-op-log/scanner.js
// docstring: "no DOM, no globals, no ST deps … must be deterministic and
// idempotent"). It means the only "conditional" var op the system supports
// is one where the AI itself chooses to emit just one branch's macro at
// generation time — i.e. the conditional is in the LLM's hands, not the
// engine's. The macro-engine's {{if}} produces a string at RENDER time
// (after extraction), so it cannot gate extraction even in principle.
//
// We assert this contract two ways:
//
//   (1) An AI reply containing {{if 0}}{{setvar::a::then}}{{else}}{{setvar::a::else}}{{/if}}
//       extracts BOTH set-ops (not just the else-branch's). The materialized
//       state ends at the second op's value (apply order wins) because the
//       scanner has no concept of branches.
//
//   (2) When the conditional decision happens at LLM-emit time — that is,
//       the model picks one of the two macros and emits only it — the
//       extracted op is exactly the one the model picked.
//
// Both behaviors are codified so a future refactor that adds conditional-
// aware extraction is forced to revisit this test and update the contract
// deliberately. Today's behavior: extraction wins over conditional logic.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';

let server, mock;

// Reply (1): both branches contain a setvar; scanner walks them both.
const REPLY_WITH_IF_WRAPPER = [
    '*Seraphina glances at the slate she keeps under the lantern base.* ',
    '"The wind tells me which way to read it." ',
    '{{if 0}}{{setvar::wind::southerly}}{{else}}{{setvar::wind::northerly}}{{/if}} ',
    '*She taps the chart, smoke curling at her wrist.* ',
    '"Either way, the third breaker is restless."',
].join('');

// Reply (2): the model has already decided and emits one branch only.
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

test.describe('#61b — Conditional var op (if-wrapper) end-to-end through floor commit', () => {
    test('extractor is condition-blind: both branches of {{if}} land as ops; LLM-driven branch emits one', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        // ── Turn 1: AI emits a reply wrapped in {{if 0}}…{{else}}…{{/if}} ──
        await sendMessageAndAwaitReply(page, 'Which way is the wind blowing tonight?');

        const turn1 = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            let asstId = -1;
            for (let i = ctx.chat.length - 1; i >= 0; i--) {
                if (!ctx.chat[i]?.is_user) { asstId = i; break; }
            }
            const m = ctx.chat[asstId];
            return {
                ops: m?.extra?.var_ops ?? null,
                wind: ctx.chatMetadata?.variables?.wind ?? null,
                mes: m?.mes ?? '',
            };
        });

        expect(turn1.ops, 'extra.var_ops populated on conditional reply').toBeTruthy();
        // Scanner extracted BOTH setvars — the if wrapper is invisible to it.
        // This is the design contract; if the contract ever changes (conditional-aware
        // extraction), update the assertion deliberately.
        expect(turn1.ops.map(o => o.value)).toEqual(['southerly', 'northerly']);
        // Forward-apply order: 'southerly' first, 'northerly' second → 'northerly' wins.
        expect(turn1.wind, 'apply order means later op wins').toBe('northerly');
        // The {{if}} / {{/if}} / {{else}} wrappers remain in the message text
        // (the macro engine resolves them at render time, but the on-chat .mes
        // here is the post-extract / pre-display form — wrappers still present).
        expect(turn1.mes).toContain('{{if 0}}');
        expect(turn1.mes).toContain('{{/if}}');
        // …but the setvar literals were stripped by the extractor.
        expect(turn1.mes).not.toContain('{{setvar');

        // ── Turn 2: AI itself picks a branch and only emits that op ──
        await sendMessageAndAwaitReply(page, 'And now? Has it shifted?');

        const turn2 = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            let asstId = -1;
            for (let i = ctx.chat.length - 1; i >= 0; i--) {
                if (!ctx.chat[i]?.is_user) { asstId = i; break; }
            }
            const m = ctx.chat[asstId];
            return {
                ops: m?.extra?.var_ops ?? null,
                wind: ctx.chatMetadata?.variables?.wind ?? null,
                mes: m?.mes ?? '',
            };
        });

        expect(turn2.ops).toEqual([{ op: 'setvar', key: 'wind', value: 'northerly' }]);
        expect(turn2.wind).toBe('northerly');
        expect(turn2.mes).not.toContain('{{setvar');
    });
});
