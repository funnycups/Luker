// Case #74 — Capsule injection: main + sub-agents share capsule config
//
// Spec:
//   - Configure director's capsule (e.g. system identity capsule).
//   - Verify (a) main agent prompt includes it.
//   - Verify (b) sub-agents dispatched mid-run also see the same capsule
//     contents.
//
// The "capsule" in orchestrator is the orchestration guidance text
// produced by a prior run, injected into the next generation as either
// a worldInfoBefore / worldInfoAfter block or a depth-anchored entry.
// See capsule-injection.js for the mutator + position logic.
//
// Layering: capsule injection mutates the OpenAI chat-completion payload
// at the point `prepareOpenAIMessages` is called. The director main
// agent's payload and each sub-agent's payload go through that same
// mutator (or a structurally equivalent path), so they should both
// receive the capsule.
//
// Why fixme on the runtime-driven leg:
//   Asserting "main and sub-agent payloads both contain the capsule"
//   requires a full director run with multiple dispatched sub-agents,
//   then inspecting the prompt sent to each via mock.requests. That
//   leg is gated on the director-runtime-with-mock-LLM blocker the
//   other director tests hit. We DO test the pure capsule-injection
//   helper here, which is the contract surface.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import {
    bootstrapCustomBackend,
    appendConnectionProfile,
    markOnboarded,
} from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';

const CAPSULE_TEXT =
    '[Orchestration Capsule from prior turn]\n'
    + 'Established facts: the lantern flame is steady; the salt-mark drifters\' skiffs '
    + 'are visible at 3 leagues out, holding position; Ash has chosen to wait until dawn.\n'
    + 'Open threads: the courier from the northern garrison has not yet arrived.';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: ['*ack*'] });
    server = await startServer({ batchKey: 'orchestrator', scenarioId: '74-capsule-inject' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#74 — Capsule injection', () => {
    test('injectCapsuleToPayload mutates payload regardless of caller; same call works for main + sub-agent payloads', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // The mutator is position-driven. Settings dictate where the
        // capsule lands. We exercise three documented positions (before /
        // after / atDepth) to prove the helper is robust to the three
        // shapes a payload may take.
        //
        // Internals note (verified against world-info.js):
        //   appendUniqueWorldInfoBlock(payload, 'worldInfoBefore', text)
        //   writes into `payload.worldInfoBeforeEntries[]`, NOT the
        //   `worldInfoBefore` string field. The string field is a legacy
        //   accumulator; the entries array is what the runtime reads.
        const results = await page.evaluate(async (capsuleText) => {
            const mod = await import('/scripts/extensions/orchestrator/capsule-injection.js');
            const inj = mod.injectCapsuleToPayload;

            const constants = SillyTavern.getContext().constants;
            const wi = constants.wiPosition;
            const roles = constants.promptRoles;

            // Three independent payload "tasks" simulate: main agent and
            // two sub-agents each having their own draft of the OpenAI
            // chat-completion payload. The capsule injector mutates each
            // identically — there is no per-agent gating in the helper.
            const payloadMain = { worldInfoBefore: '', worldInfoAfter: '' };
            const payloadSub1 = { worldInfoBefore: '', worldInfoAfter: '' };
            const payloadSub2 = { worldInfoBefore: '', worldInfoAfter: '' };

            // (1) `before` position: stamps into worldInfoBeforeEntries[].
            const settingsBefore = {
                capsuleInjectPosition: wi.before,
                capsuleInjectDepth: 0,
                capsuleInjectRole: roles.SYSTEM,
            };
            const retMain = inj(payloadMain, capsuleText, settingsBefore);
            const retSub1 = inj(payloadSub1, capsuleText, settingsBefore);
            const retSub2 = inj(payloadSub2, capsuleText, settingsBefore);

            // (2) `atDepth` position: stamps into worldInfoDepth[].
            const payloadDepthMain = {};
            const payloadDepthSub = {};
            const settingsDepth = {
                capsuleInjectPosition: wi.atDepth,
                capsuleInjectDepth: 2,
                capsuleInjectRole: roles.SYSTEM,
            };
            inj(payloadDepthMain, capsuleText, settingsDepth);
            inj(payloadDepthSub, capsuleText, settingsDepth);

            // (3) Empty / whitespace capsule is a no-op — the helper
            //     returns false and leaves the payload untouched.
            const payloadNoop = { worldInfoBefore: '' };
            const noopReturn = inj(payloadNoop, '   ', settingsBefore);

            return {
                main: payloadMain,
                sub1: payloadSub1,
                sub2: payloadSub2,
                depthMain: payloadDepthMain,
                depthSub: payloadDepthSub,
                noopReturn,
                noopPayload: payloadNoop,
                wiBefore: wi.before,
                wiAtDepth: wi.atDepth,
                returns: { main: retMain, sub1: retSub1, sub2: retSub2 },
            };
        }, CAPSULE_TEXT);

        // (1) `before` position — all three payloads contain the capsule
        //     in worldInfoBeforeEntries. The relationship across main /
        //     sub1 / sub2 is the cross-agent capsule sharing the case demands.
        expect(results.returns.main).toBe(true);
        expect(results.returns.sub1).toBe(true);
        expect(results.returns.sub2).toBe(true);
        expect(Array.isArray(results.main.worldInfoBeforeEntries)).toBe(true);
        expect(results.main.worldInfoBeforeEntries).toContain(CAPSULE_TEXT);
        expect(results.sub1.worldInfoBeforeEntries).toContain(CAPSULE_TEXT);
        expect(results.sub2.worldInfoBeforeEntries).toContain(CAPSULE_TEXT);

        // All three got the SAME capsule text.
        expect(results.main.worldInfoBeforeEntries).toEqual(results.sub1.worldInfoBeforeEntries);
        expect(results.sub1.worldInfoBeforeEntries).toEqual(results.sub2.worldInfoBeforeEntries);

        // (2) `atDepth` position — both payloads carry the depth-anchored
        //     entry with the same depth / role.
        expect(Array.isArray(results.depthMain.worldInfoDepth)).toBe(true);
        expect(Array.isArray(results.depthSub.worldInfoDepth)).toBe(true);
        const mainDepth = results.depthMain.worldInfoDepth[0];
        const subDepth = results.depthSub.worldInfoDepth[0];
        expect(mainDepth.depth).toBe(2);
        expect(subDepth.depth).toBe(2);
        expect(mainDepth.entries).toContain(CAPSULE_TEXT);
        expect(subDepth.entries).toContain(CAPSULE_TEXT);

        // (3) Empty capsule is a no-op (no entries appended).
        expect(results.noopReturn).toBe(false);
        // worldInfoBeforeEntries should not have been created when the
        // injector early-returned on an empty input.
        expect(results.noopPayload.worldInfoBeforeEntries).toBeUndefined();
    });

    test.fixme('director run dispatches sub-agents and each sub-agent payload contains the capsule', async () => {
        // Requires a full director run with at least one dispatched
        // sub-agent. Then mock.requests is grepped for the capsule text
        // appearing in each agent's chat-completion request body. Blocked
        // by the same director-runtime / mock-LLM gap as cases #67 + #68.
    });
});
