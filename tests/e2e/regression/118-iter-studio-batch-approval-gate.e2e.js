// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups
//
// #118 — iter-studio batch gate: approving one card of a multi-card
// batch must NOT fire the next LLM round while siblings from the same
// assistant turn are still pending. The click-once "Approve all pending"
// affordance must commit every card AND fire only one follow-up round.
//
// Regression shape: pre-fix, ProposalBus.approve() enqueued an outcome
// + fired onChange. The studio's render-scheduler coalesced to next
// rAF, and its handler unconditionally awaited drainBusOutcomes() at
// the tail. drainBusOutcomes only gated on drainScheduled (re-entry)
// and state.isBusy (in-flight LLM). It had NO check that other pending
// cards from the SAME assistant turn were still awaiting a decision —
// so the first approve in a batch of N immediately pushed a synthetic
// "[User reviewed 1 proposal(s): Committed (1): ...]" user message and
// re-fired the completion request.
//
// Two user-visible symptoms of this single bug:
//   (A) Per-card approve: clicking one Approve on a multi-card turn
//       immediately talks to the model even though N-1 cards remain.
//   (B) "Approve all pending" bulk click: the bus for-await-approves
//       every entry in the turn, but the rAF-coalesced drain fires
//       mid-loop and the synthetic message only accounts for the
//       outcomes queued at that instant (typically the first one),
//       so the LLM's next round only sees "reviewed 1 proposal(s)"
//       while cards 2..N commit to disk behind its back.
//
// Fix: outcomes carry `sourceCallId` back to each studio's drain, which
// resolves the owning assistant message via `state.session.messages` and
// holds when any pending entry on the SAME message remains. The bus's
// `listPending()` exposes {id, sourceCallId} for the join. Stashed
// outcomes replay on the last decision, which drains all of them at
// once → the synthetic message accurately reports "reviewed N
// proposal(s)" and only one follow-up round fires.
//
// Target the orchestrator iter-studio here because it is the only
// only studio where the AI can genuinely emit N tool_calls that each
// produce their own proposal card (skill-author / lorebook-write /
// custom-tool-author paths — MG and CEA character/lorebook edits
// coalesce into a single per-target profile-edit card per turn, so
// they cannot exercise the multi-card branch of the gate). custom-tool
// authoring has the smallest fixture footprint: no external skill
// registry or bound lorebook required.

// eslint-disable playwright/no-wait-for-timeout — negative-control
// asserts REQUIRE settle windows: to prove the gate did NOT fire a
// stray request during the rAF drain cycle, we need to wait past that
// window before counting requests. There is no runtime signal to poll
// for "we can now assert nothing happened".
// eslint-disable playwright/no-conditional-in-test — sanity-check
// disk-state harvester walks a heterogeneous customTools shape that
// can live in one of several settings slots depending on Apply scope;
// the conditional is inside a pure-function collector, not a test
// branch that hides an assertion.
/* eslint-disable playwright/no-wait-for-timeout, playwright/no-conditional-in-test */

import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';
import { openIterStudio, closeIterStudio } from '../_lib/ui-iter-studio.js';
import { normalizeIterStudioSettings } from '../preset/_helpers.js';

let server, mock;

function settingsPath(dataRoot) {
    return resolve(dataRoot, 'default-user', 'settings.json');
}

function normalizeSettings(dataRoot) {
    normalizeIterStudioSettings(dataRoot);
    const sp = settingsPath(dataRoot);
    const s = JSON.parse(readFileSync(sp, 'utf8'));
    s.extension_settings = s.extension_settings || {};
    s.extension_settings.orchestrator = s.extension_settings.orchestrator || {};
    s.extension_settings.orchestrator.enabled = true;
    // Loop mode is the lightest orchestrator mode — no director/sub-agent
    // stack needed to open the iter-studio popup.
    s.extension_settings.orchestrator.executionMode = 'loop';
    writeFileSync(sp, JSON.stringify(s, null, 4));
}

const CUSTOM_TOOLS = [
    {
        name: 'ash_reef_survey_tool',
        displayName: 'Reef Survey',
        description: 'Compute the next reef-survey bearing from the lantern position.',
        mode: 'read',
        parameters: { type: 'object', properties: {} },
        body: 'return { ok: true, bearing: 217 };',
        simulateBody: '',
    },
    {
        name: 'ash_lantern_watch_tool',
        displayName: 'Lantern Watch',
        description: 'Return the current lantern-watch bell count.',
        mode: 'read',
        parameters: { type: 'object', properties: {} },
        body: 'return { ok: true, bell: 3 };',
        simulateBody: '',
    },
    {
        name: 'ash_tide_window_tool',
        displayName: 'Tide Window',
        description: 'Predict the next safe tide window in minutes.',
        mode: 'read',
        parameters: { type: 'object', properties: {} },
        body: 'return { ok: true, minutes_until: 42 };',
        simulateBody: '',
    },
];

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({
        batchKey: 'regression',
        scenarioId: '118-iter-studio-batch-gate',
        extraConfig: { 'storage.mode': 'fs' },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    normalizeSettings(server.dataRoot);
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#118 — iter-studio batch approval gate (orchestrator custom-tool authoring)', () => {
    test('per-card: approving cards 1..N-1 must NOT fire the next LLM round; the last approve fires exactly one round', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Script the completion route: turn 0 returns 3 parallel
        // tool_calls, each staging a distinct custom tool. Turn 1 (the
        // follow-up round that should fire only after the LAST card is
        // approved) returns plain text so the iteration terminates.
        mock.scriptCompletion((req) => {
            if (req.turn === 0) {
                return {
                    toolCalls: CUSTOM_TOOLS.map((t) => ({
                        name: 'luker_orch_set_custom_tool',
                        arguments: t,
                    })),
                };
            }
            return { text: 'All three custom tools staged.' };
        });

        await openIterStudio(page, 'orch');
        const popup = page.locator('.popup:visible').last();

        const chatReqCount = () => mock.requests
            .filter((r) => String(r.url || '').includes('chat/completions'))
            .length;
        const beforeSend = chatReqCount();

        // Send the prompt via a real gesture. We do NOT use the shared
        // sendIterPrompt helper — its wait-for-Approve step assumes the
        // first pending card renders on Send, which is fine for us, but
        // its selector picks the first Approve globally; we want the
        // popup-scoped selector so this file is self-contained.
        const composer = popup.locator('textarea[data-orch-it-input]').first();
        await composer.waitFor({ state: 'visible', timeout: 10_000 });
        await composer.fill('Add three custom tools for Ash: reef survey, lantern watch, tide window.');
        await popup.locator('[data-orch-it-action="send"]').first().click();

        // Three pending cards should render from the single LLM round.
        // Poll until N cards are visible before proceeding.
        await expect.poll(async () => {
            return await popup.locator('[data-proposal-action="approve"]').count();
        }, {
            message: 'three pending Approve buttons should render from one LLM round',
            timeout: 30_000,
        }).toBe(3);

        // The initial send round has landed. Record its request delta
        // so subsequent asserts can measure "did the gate hold".
        const afterSend = chatReqCount();
        expect(afterSend - beforeSend,
            'initial Send should have issued at least one chat completion',
        ).toBeGreaterThanOrEqual(1);

        const approveButtons = () => popup.locator('[data-proposal-action="approve"]');

        // --- Approve card 1 ---
        await approveButtons().first().click();
        await expect.poll(async () => {
            return await approveButtons().count();
        }, {
            message: 'after approving card 1, exactly 2 Approve buttons should remain',
            timeout: 5000,
        }).toBe(2);
        // Give any rAF-coalesced drain a comfortable window to fire a
        // stray request if the gate is broken. 500ms is >> one frame.
        await page.waitForTimeout(500);
        expect(chatReqCount() - afterSend,
            'no follow-up chat request should fire while 2 sibling pending cards remain',
        ).toBe(0);

        // --- Approve card 2 ---
        await approveButtons().first().click();
        await expect.poll(async () => {
            return await approveButtons().count();
        }, {
            message: 'after approving card 2, exactly 1 Approve button should remain',
            timeout: 5000,
        }).toBe(1);
        await page.waitForTimeout(500);
        expect(chatReqCount() - afterSend,
            'no follow-up chat request should fire while 1 sibling pending card remains',
        ).toBe(0);

        // --- Approve card 3 (last in batch) — gate opens ---
        await approveButtons().first().click();
        await expect.poll(() => chatReqCount() - afterSend, {
            message: 'approving the last card in the batch must fire exactly one follow-up LLM round',
            timeout: 20_000,
        }).toBeGreaterThanOrEqual(1);

        // Settle window: assert we fired EXACTLY one round, not more
        // (a double-trigger from the stash-replay path would show up
        // here as delta === 2).
        await page.waitForTimeout(1500);
        expect(chatReqCount() - afterSend,
            'exactly one follow-up round should fire after the last approve — a value > 1 means the stash-replay is double-triggering',
        ).toBe(1);

        // Sanity: all three custom tools ended up committed to the
        // active loop preset's customTools array (or the profile-scope
        // list — pick whichever the runtime commits to).
        const stagedNames = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            const orch = ctx.extensionSettings?.orchestrator || {};
            const names = new Set();
            const collectFrom = (obj) => {
                if (!obj) return;
                const arr = Array.isArray(obj.customTools) ? obj.customTools : [];
                for (const t of arr) if (t && t.name) names.add(String(t.name));
            };
            const lib = orch.presetLibraries || {};
            for (const mode of Object.keys(lib)) {
                const modeLib = lib[mode] || {};
                for (const pid of Object.keys(modeLib)) collectFrom(modeLib[pid]);
            }
            // Also inspect the working / spec surface in case the write
            // landed there before an Apply-to-global step.
            collectFrom(orch);
            collectFrom(orch.spec);
            return Array.from(names);
        });
        for (const t of CUSTOM_TOOLS) {
            expect(stagedNames).toContain(t.name);
        }

        await closeIterStudio(page);
    });

    test('bulk: clicking "Approve all pending" once must commit every card AND fire exactly one follow-up round', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Fresh scripting for this test — same shape, distinct names so
        // it doesn't collide with the per-card test's registrations.
        const BULK_TOOLS = CUSTOM_TOOLS.map((t) => ({ ...t, name: `${t.name}_bulk` }));
        mock.scriptCompletion((req) => {
            if (req.turn === 0) {
                return {
                    toolCalls: BULK_TOOLS.map((t) => ({
                        name: 'luker_orch_set_custom_tool',
                        arguments: t,
                    })),
                };
            }
            return { text: 'Bulk-approved: all three custom tools staged.' };
        });

        await openIterStudio(page, 'orch');
        const popup = page.locator('.popup:visible').last();

        const chatReqCount = () => mock.requests
            .filter((r) => String(r.url || '').includes('chat/completions'))
            .length;
        // Baseline is measured just before the LLM turn is issued —
        // any request already logged by the fixture bootstrap (mock
        // /models probes etc.) sits below this line and is factored
        // out of the delta assertions below.
        void chatReqCount();

        const composer = popup.locator('textarea[data-orch-it-input]').first();
        await composer.waitFor({ state: 'visible', timeout: 10_000 });
        await composer.fill('Add three more custom tools for the bulk-approve variant.');
        await popup.locator('[data-orch-it-action="send"]').first().click();

        // Wait for the three cards to render.
        await expect.poll(async () => {
            return await popup.locator('[data-proposal-action="approve"]').count();
        }, {
            message: 'three pending Approve buttons should render from one LLM round (bulk variant)',
            timeout: 30_000,
        }).toBe(3);

        // Also wait for the turn-level "Approve all pending" affordance
        // to render (it only appears when a message holds 2+ pending
        // entries — see renderTurnActions).
        const approveAll = popup.locator('[data-proposal-action="approve-all-pending"]').first();
        await approveAll.waitFor({ state: 'visible', timeout: 10_000 });

        const afterSend = chatReqCount();

        // --- Single click, batch approve ---
        await approveAll.click();

        // All three pending cards should be committed.
        await expect.poll(async () => {
            return await popup.locator('[data-proposal-action="approve"]').count();
        }, {
            message: 'after a single "Approve all pending" click, every per-card Approve button should be gone',
            timeout: 15_000,
        }).toBe(0);

        // Exactly one follow-up round fires. Pre-fix, the rAF-coalesced
        // drain fires mid-loop and the synthetic message only reports the
        // outcomes queued at that instant — a partial batch. Post-fix,
        // the gate holds until the for-await-approve loop finishes; the
        // final onChange drains all three outcomes together.
        await expect.poll(() => chatReqCount() - afterSend, {
            message: 'the bulk approve must fire exactly one follow-up LLM round',
            timeout: 20_000,
        }).toBeGreaterThanOrEqual(1);
        await page.waitForTimeout(1500);
        expect(chatReqCount() - afterSend,
            'exactly one follow-up round should fire after "Approve all pending" — >1 means the drain fired mid-batch',
        ).toBe(1);

        // The follow-up request must carry three `role:'tool'`
        // messages whose payloads report `status:'committed'` — one per
        // approved card. This is the post-refactor channel: instead of
        // pushing a synthetic "[User reviewed 3 proposal(s): …]" user
        // message, `drainBusOutcomes` updates the pending tool_result
        // envelopes in place. If fewer than 3 committed tool_results
        // appear, the drain fired mid-batch (the exact pre-fix symptom
        // of the rAF-mid-loop drain).
        const followupReq = mock.requests
            .slice()
            .reverse()
            .find((r) => String(r.url || '').includes('chat/completions'));
        expect(followupReq, 'must have captured the follow-up chat request body').toBeTruthy();
        const followupBody = followupReq?.body || {};
        const toolMessages = (followupBody.messages || []).filter((m) => m && m.role === 'tool');
        const committedToolResults = toolMessages.filter((m) => {
            const raw = typeof m.content === 'string' ? m.content : '';
            try {
                const parsed = JSON.parse(raw);
                return parsed && parsed.status === 'committed';
            } catch {
                return false;
            }
        });
        expect(committedToolResults.length,
            'the follow-up round must contain three role:\'tool\' messages with status:\'committed\' — a smaller count means the drain fired before the bulk-approve loop finished',
        ).toBe(3);

        // Also assert every bulk tool made it to disk.
        const stagedNames = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            const orch = ctx.extensionSettings?.orchestrator || {};
            const names = new Set();
            const collectFrom = (obj) => {
                if (!obj) return;
                const arr = Array.isArray(obj.customTools) ? obj.customTools : [];
                for (const t of arr) if (t && t.name) names.add(String(t.name));
            };
            const lib = orch.presetLibraries || {};
            for (const mode of Object.keys(lib)) {
                const modeLib = lib[mode] || {};
                for (const pid of Object.keys(modeLib)) collectFrom(modeLib[pid]);
            }
            collectFrom(orch);
            collectFrom(orch.spec);
            return Array.from(names);
        });
        for (const t of BULK_TOOLS) {
            expect(stagedNames).toContain(t.name);
        }

        await closeIterStudio(page);
    });
});
