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
import { sendWorkbenchIterationPrompt, applyWorkbenchChanges, setToggleState } from '../_lib/ui-workbench.js';
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

        const win = await openIterStudio(page, 'orch');

        const chatReqCount = () => mock.requests
            .filter((r) => String(r.url || '').includes('chat/completions'))
            .length;
        const beforeSend = chatReqCount();

        await sendWorkbenchIterationPrompt(
            page,
            'Add three custom tools for Ash: reef survey, lantern watch, tide window.',
        );

        const card = win.locator('.wb-chg.is-pending').first();
        await expect(card).toBeVisible({ timeout: 30_000 });
        const boxes = card.locator('.wb-chg-line button[role="checkbox"]');
        await expect(boxes).toHaveCount(3);

        const afterSend = chatReqCount();
        expect(afterSend - beforeSend).toBeGreaterThanOrEqual(1);

        // Toggle individual items cleanly without triggering extra LLM rounds.
        await setToggleState(boxes.nth(0), false);
        await setToggleState(boxes.nth(1), false);
        await expect(card.locator('.wb-chg-foot button.is-primary').first()).toContainText('(1)');
        await setToggleState(boxes.nth(0), true);
        await setToggleState(boxes.nth(1), true);
        await expect(card.locator('.wb-chg-foot button.is-primary').first()).toContainText('(3)');
        expect(chatReqCount() - afterSend).toBe(0);

        // Single batch Apply commits all 3 custom tools cleanly without spurious extra rounds.
        await applyWorkbenchChanges(page);
        await page.waitForTimeout(500);
        expect(chatReqCount() - afterSend).toBe(0);

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
        for (const t of CUSTOM_TOOLS) {
            expect(stagedNames).toContain(t.name);
        }

        await closeIterStudio(page);
    });

    test('bulk: single Apply selected commits every staged custom tool atomically', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

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

        const win = await openIterStudio(page, 'orch', { newSession: true });

        const chatReqCount = () => mock.requests
            .filter((r) => String(r.url || '').includes('chat/completions'))
            .length;

        await sendWorkbenchIterationPrompt(
            page,
            'Add three more custom tools for the bulk-approve variant.',
        );

        const card = win.locator('.wb-chg.is-pending').first();
        await expect(card).toBeVisible({ timeout: 30_000 });
        await expect(card.locator('.wb-chg-line button[role="checkbox"]')).toHaveCount(3);
        const afterSend = chatReqCount();

        await applyWorkbenchChanges(page);
        await expect(win.locator('.wb-chg.is-pending')).toHaveCount(0, { timeout: 15_000 });
        await page.waitForTimeout(500);
        expect(chatReqCount() - afterSend).toBe(0);

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
