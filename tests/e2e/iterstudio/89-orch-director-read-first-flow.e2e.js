// #89 — Orchestrator iter-studio: read-first flow uses `luker_orch_read_director_fields`
// between an anchor patch, and no `## working_profile` YAML dump is
// injected into the user turn. Regression guard for the read-first
// refactor that removed AUTO CONTINUE / working_profile up-front dumps
// in favor of on-demand reads via the per-mode read tool.
//
// REAL USER-GESTURE flow:
//   1. Open the orchestrator iter-studio popup via real clicks.
//   2. Script mockLLM for 4 turns:
//        Turn 0: tool_call `luker_orch_set_director_subagent` (creates seed sub-agent)
//        Turn 1: tool_call `luker_orch_read_director_fields({paths: ['subAgents']})`
//        Turn 2: tool_call `luker_orch_patch_director_subagent_system_prompt`
//                using the exact oldString from the seed prompt.
//        Turn 3: plain text "done" — terminates the loop.
//   3. Send the prompt via sendIterPrompt (waits for Approve after Turn 0).
//   4. Approve all → drain fires Turn 1 → Turn 2 → new Approve → click →
//      Turn 3 exits.
//   5. Assertions (structure, not wording):
//      - The chat/completions requests carry a tool named `luker_orch_read_director_fields`.
//      - No user message in any request contains `## working_profile` /
//        `## global_profile_baseline` blocks (legacy up-front dumps).
//      - The applied director preset carries the patched sub-agent on disk.

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

const SEED_SUBAGENT_ID = 'analyst_a';
const SEED_SUBAGENT_PROMPT = 'You are the reef analyst.\nRead the chart.\nReport tersely.';
const PATCH_OLD = 'Report tersely.';
const PATCH_NEW = 'Report tersely and cite the chart legend.';
const EXPECTED_AFTER = SEED_SUBAGENT_PROMPT.replace(PATCH_OLD, PATCH_NEW);

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
        scenarioId: '89-orch-director-read-first-flow',
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

test.describe('#89 — Orchestrator iter-studio: read-first flow with per-mode read tool', () => {
    test('Turn 0 read → Turn 1 patch → Turn 2 stop; no user:auto filler between rounds', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Script a 4-turn conversation. Turn 0 creates a subAgent with
        // the seed prompt; that pending patch will get Approved before
        // the next Send fires — but sendIterPrompt returns on the FIRST
        // Approve, so we approve after Turn 0's create-subagent proposal
        // by driving Send in two stages. Simpler alternative used here:
        // Turn 0 emits BOTH a set_director_subagent (creates the seed
        // sub-agent) — that becomes a pending proposal — sendIterPrompt
        // returns when the Approve button appears. We then Approve, then
        // manually drive the follow-up messages via a second Send.
        //
        // But the read/patch flow is the whole point. So instead we run
        // the full flow in one send by having Turn 0 do 2 tool calls
        // (create + read) — the create lands as a pending proposal AND
        // the read fires inline. sendIterPrompt returns once the first
        // Approve appears (create). We Approve, then let the loop
        // continue automatically to Turn 1 (patch) → Approve → Turn 2
        // (stop). But sendIterPrompt only returns once; we need explicit
        // driving.
        //
        // The clean path: skip the seed subagent, script Turn 0 =
        // set_director_subagent (creates seed), then approve, and in the
        // resumed drain loop Turn 1 = read, Turn 2 = patch (approve),
        // Turn 3 = stop. The bus drain fires runIterationTurn after each
        // Approve, so this works.

        mock.scriptCompletion((req) => {
            if (req.turn === 0) {
                return {
                    toolCalls: [{
                        name: 'luker_orch_set_director_subagent',
                        arguments: {
                            id: SEED_SUBAGENT_ID,
                            description: 'Analyzes the reef chart.',
                            systemPrompt: SEED_SUBAGENT_PROMPT,
                        },
                    }],
                };
            }
            if (req.turn === 1) {
                return {
                    toolCalls: [{
                        name: 'luker_orch_read_director_fields',
                        arguments: { paths: ['subAgents'] },
                    }],
                };
            }
            if (req.turn === 2) {
                return {
                    toolCalls: [{
                        name: 'luker_orch_patch_director_subagent_system_prompt',
                        arguments: {
                            id: SEED_SUBAGENT_ID,
                            oldString: PATCH_OLD,
                            newString: PATCH_NEW,
                        },
                    }],
                };
            }
            return { text: 'done' };
        });

        await openIterStudio(page, 'orch');

        // Send the prompt. sendIterPrompt returns when the first Approve
        // button appears — that's the pending proposal from Turn 0's
        // create-subagent tool call. The subsequent Approve → drain
        // cycle continues the loop: Turn 1 (read) → Turn 2 (patch) →
        // Turn 3 (done). applyIterBatch loops through every Approve so
        // it drives all of them.
        await sendIterPrompt(page, 'orch', 'Add analyst_a, read its prompt, then update to also cite the chart legend.');

        // Approve loop covers ALL pending proposals across the multi-round
        // drain: Turn 0 (create-subagent) approve → drain fires Turn 1
        // (read, inline) → Turn 2 (patch → proposal) approve → drain →
        // Turn 3 (text) exits. Each drain re-invokes the LLM, so we
        // give ample poll time by re-calling applyIterBatch several times
        // if new Approves surface between passes.
        for (let pass = 0; pass < 3; pass++) {
            await applyIterBatch(page, 'orch');
            // If a new Approve surfaces within 5s (post-drain), catch it.
            const popup = page.locator('.popup:visible').last();
            const next = popup.locator('[data-proposal-action="approve"]').first();
            if (!(await next.isVisible({ timeout: 5000 }).catch(() => false))) break;
        }

        // Assertion 1 — after the full loop, the read tool was actually
        // offered in the tool catalog for at least one chat request.
        // Structural check on tool_call name, not on wording.
        await expect.poll(() => {
            return mock.requests.some((r) => {
                if (!String(r.url || '').includes('chat/completions')) return false;
                const parsed = r.body || {};
                const tools = Array.isArray(parsed?.tools) ? parsed.tools : [];
                return tools.some((t) => String(t?.function?.name || '') === 'luker_orch_read_director_fields');
            });
        }, { timeout: 10_000 }).toBe(true);

        // Assertion 2 — no request's user message contains the legacy
        // `## working_profile` block from the removed
        // `buildAiIterationUserPrompt`. Any request that DOES has
        // regressed the read-first refactor's key win: no more per-round
        // 84KB working_profile dump.
        const sawWorkingProfileDump = mock.requests.some((r) => {
            if (!String(r.url || '').includes('chat/completions')) return false;
            const parsed = r.body || {};
            const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
            for (const m of messages) {
                if (m?.role !== 'user') continue;
                const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
                if (content.includes('## working_profile') || content.includes('## global_profile_baseline')) return true;
            }
            return false;
        });
        expect(sawWorkingProfileDump).toBe(false);

        // Assertion 3 — the applied preset carries the patched prompt on disk.
        await expect.poll(() => {
            const preset = readActiveDirectorPreset(server.dataRoot);
            const sa = (preset?.subAgents || []).find((x) => x?.id === SEED_SUBAGENT_ID);
            return sa?.systemPrompt || '';
        }, { timeout: 10_000 }).toBe(EXPECTED_AFTER);

        await closeIterStudio(page);
    });
});
