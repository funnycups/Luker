// #90 — Orchestrator iter-studio: anchor-drift diagnosis.
//
// The seeded sub-agent systemPrompt is indented 4 spaces per line.
// The LLM's first patch attempt uses a DEDENTED oldString → the executor
// wraps the failure with `match_diagnosis.kind === 'whitespace_drift'`
// and a `next_step` naming the per-mode read tool. The LLM's second
// attempt uses the correct indented oldString → the patch lands as a
// pending proposal.
//
// REAL USER-GESTURE flow:
//   1. Seed the director preset with 4-space-indented systemPrompt on subAgent[0].
//   2. Open orchestrator iter-studio; script mockLLM for 3 turns:
//        Turn 0: patch with DEDENTED oldString (miss)
//        Turn 1: patch with correctly indented oldString
//        Turn 2: plain text "done"
//   3. Send → wait for Approve → assert diagnostic payload was returned
//      in Turn 1's tool message context → Approve → verify final disk state.

import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';
import { openIterStudio, sendIterPrompt, applyIterBatch, closeIterStudio } from '../_lib/ui-iter-studio.js';
import { normalizeIterStudioSettings as baseNormalize } from '../preset/_helpers.js';

let server, mock;

const SEED_SUBAGENT_ID = 'analyst_b';
// Multi-line systemPrompt with 4-space indented body — the "live" text.
// Line 1 must be non-whitespace-prefixed so `sanitize*Profile`'s trim on
// systemPrompt doesn't strip the intended leading indent of the body.
const SEED_SUBAGENT_PROMPT = 'header line\n    line one\n    line two\n    line three';
// LLM's stale mental model (dedented). Must miss on the first attempt.
const DEDENTED_OLD = 'line one\nline two\nline three';
const CORRECT_OLD = '    line one\n    line two\n    line three';
const PATCH_NEW = '    line one\n    line two updated\n    line three';
const EXPECTED_AFTER = SEED_SUBAGENT_PROMPT.replace(CORRECT_OLD, PATCH_NEW);

function settingsJsonPath(dataRoot) {
    return resolve(dataRoot, 'default-user', 'settings.json');
}

function normalizeSettings(dataRoot) {
    baseNormalize(dataRoot);
    const sp = settingsJsonPath(dataRoot);
    const s = JSON.parse(readFileSync(sp, 'utf8'));
    s.extension_settings = s.extension_settings || {};
    s.extension_settings.orchestrator = s.extension_settings.orchestrator || {};
    s.extension_settings.orchestrator.enabled = true;
    s.extension_settings.orchestrator.executionMode = 'director';
    writeFileSync(sp, JSON.stringify(s, null, 4));
}

function readActiveDirectorPreset(dataRoot) {
    const s = JSON.parse(readFileSync(settingsJsonPath(dataRoot), 'utf8'));
    const ext = s?.extension_settings?.orchestrator;
    if (!ext) return null;
    const activeId = ext.activePresetIds?.director || '';
    const lib = ext.presetLibraries?.director || {};
    return activeId ? (lib[activeId] || null) : null;
}

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({
        batchKey: 'iterstudio',
        scenarioId: '90-orch-anchor-drift-diagnosis',
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

test.describe('#90 — Orchestrator iter-studio: anchor drift → whitespace_drift diagnosis → self-heal', () => {
    test('first attempt misses, diagnosis reaches LLM, second attempt lands', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        mock.scriptCompletion((req) => {
            if (req.turn === 0) {
                // Turn 0 creates the sub-agent with the indented prompt.
                return {
                    toolCalls: [{
                        name: 'luker_orch_set_director_subagent',
                        arguments: {
                            id: SEED_SUBAGENT_ID,
                            description: 'Analyst with indented systemPrompt.',
                            systemPrompt: SEED_SUBAGENT_PROMPT,
                        },
                    }],
                };
            }
            if (req.turn === 1) {
                return {
                    toolCalls: [{
                        name: 'luker_orch_patch_director_subagent_system_prompt',
                        arguments: {
                            id: SEED_SUBAGENT_ID,
                            oldString: DEDENTED_OLD,
                            newString: 'wont apply',
                        },
                    }],
                };
            }
            if (req.turn === 2) {
                // Turn 2 sees Turn 1's tool_result carrying the diagnosis
                // envelope. This test's contract is structural, not
                // wording — the mock doesn't inspect what the AI saw; it
                // just emits the corrected patch.
                return {
                    toolCalls: [{
                        name: 'luker_orch_patch_director_subagent_system_prompt',
                        arguments: {
                            id: SEED_SUBAGENT_ID,
                            oldString: CORRECT_OLD,
                            newString: PATCH_NEW,
                        },
                    }],
                };
            }
            return { text: 'done' };
        });

        await openIterStudio(page, 'orch');

        // Send the prompt. sendIterPrompt returns when the first Approve
        // appears (Turn 0's create-subagent). Then applyIterBatch loops:
        // Turn 0 approved → drain → Turn 1 (patch with dedented anchor
        // — fails → tool_result with match_diagnosis → NO proposal) →
        // drain continues → Turn 2 (correct patch → proposal → Approve
        // clicked) → drain → Turn 3 emits no tool call → loop exits.
        await sendIterPrompt(page, 'orch', 'Update analyst_b line two.');
        // Approve loop covers ALL pending proposals across the multi-round
        // drain: Turn 0 (create-subagent) approve → drain fires Turn 1
        // (patch with dedented anchor, fails → tool_result with
        // match_diagnosis, no proposal) → Turn 2 (patch with correct
        // anchor, succeeds → proposal → approve) → drain → Turn 3 (text)
        // exits. Between-pass poll catches late-arriving Approves after
        // a drain settles.
        for (let pass = 0; pass < 3; pass++) {
            await applyIterBatch(page, 'orch');
            const popup2 = page.locator('.popup:visible').last();
            const next = popup2.locator('[data-proposal-action="approve"]').first();
            if (!(await next.isVisible({ timeout: 5000 }).catch(() => false))) break;
        }

        // Assertion 1 — inspect the request bodies. The Turn-2 request
        // should carry a tool message with
        // `match_diagnosis.kind === 'whitespace_drift'` in its content
        // (from Turn 1's failure envelope).
        const sawDiagnosis = mock.requests.some((r) => {
            if (!String(r.url || '').includes('chat/completions')) return false;
            const parsed = r.body || {};
            const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
            for (const m of messages) {
                if (m?.role !== 'tool') continue;
                const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
                if (!content) continue;
                try {
                    const inner = JSON.parse(content);
                    if (inner?.match_diagnosis?.kind === 'whitespace_drift') return true;
                } catch { /* not JSON — skip */ }
            }
            return false;
        });
        expect(sawDiagnosis).toBe(true);

        // Assertion 2 — final disk state carries the corrected patch.
        await expect.poll(() => {
            const preset = readActiveDirectorPreset(server.dataRoot);
            const sa = (preset?.subAgents || []).find((x) => x?.id === SEED_SUBAGENT_ID);
            return sa?.systemPrompt || '';
        }, { timeout: 10_000 }).toBe(EXPECTED_AFTER);

        await closeIterStudio(page);
    });
});
