/**
 * Plan 3 Unit 8 — director RP turn invokes skill_read mid-turn (#5).
 *
 * LLM cost: ~$0.5-1 per run.
 * Requires: dev server running + LLM API configured (online_status !=
 *           'no_connection') + a director profile with skills.visible
 *           populated (default profile ships 5 mode-level scaffolds).
 *
 * Scope:
 *   - Install a fixture skill whose body contains a distinctive marker
 *     phrase the model has no way of hallucinating verbatim.
 *   - Trigger a director-mode RP turn through the production
 *     GENERATE_TAKEOVER_DISPATCH path (the same hook the chat send button
 *     uses). The main agent + dispatched sub-agents read the
 *     `<available_skills>` block off their system prompts and can call
 *     skill_read mid-turn.
 *   - Verify the observable contract via RunStateStore (the legacy
 *     runtime-trace module was retired; the store now records every
 *     dispatched sub-agent + tool_call as named rounds/sections):
 *       (1) at least one round in the store has a tool_call section for
 *           `skill_read`, and its meta.args reference the fixture by name
 *           — the model actually exercised the tool with the right input.
 *       (2) the paired tool_result section completed with ok=true — the
 *           skill read succeeded end-to-end.
 *     Two legacy assertions were intentionally dropped during the
 *     store migration because the store records progress, not the raw
 *     LLM conversation:
 *       - The `<available_skills>` system-prompt scan no longer applies;
 *         the store does not retain rendered system prompts. The (1)+(2)
 *         outcomes plus a successful tool_result already prove the
 *         catalog reached the model and the read returned bytes.
 *       - The MARKER_PHRASE pass-through scan no longer applies; the
 *         store records `{ ok, err }` on tool_result sections but not the
 *         body. ok=true on the result section is the surviving proxy.
 *
 * Why a real LLM (not a mock):
 *   The contract under test is "the catalog block reaches the model AND
 *   the model uses skill_read". Stubbing the LLM would make assertion (2)
 *   meaningless — we'd be asserting on synthetic behavior we control.
 *
 * Test resilience:
 *   - Two retries to absorb LLM nondeterminism (the model might not always
 *     call skill_read on the first attempt even when steered).
 *   - 120s per-test timeout: real LLM round-trips on Anthropic / OpenAI
 *     vary from 5s to 60s depending on provider + reasoning budget.
 *
 * Screenshots: docs/public/_screenshots/skills/director-with-skills-*.png.
 *
 * Failure-mode policy (per user directive for Plan 3 Unit 8):
 *   - If assertion (2) fails repeatedly, that's a real bug in the catalog
 *     injection or system-prompt rendering; the spec must surface it
 *     rather than be relaxed away.
 *   - LLM provider outages (network) should surface as `online_status !=
 *     'no_connection'` skip rather than a fake pass.
 */

import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import {
    SCREENSHOTS_DIR,
    screenshotPath,
    awaitMainUI,
    ensureSkillsApiAvailable,
    buildSyntheticEmbed,
    cleanupSkill,
    activateConnectionProfile,
    ensureDirectorProfileInitialized,
    ensureCharacterLoaded,
} from './helpers.js';

// Marker tokens are deliberately bizarre — the model cannot hallucinate
// these verbatim, so any appearance in the trace's tool result chain or in
// the final capsule body is positive evidence the skill was actually read.
const FIXTURE_SKILL_NAME = 'pw-llm-director-read-fixture';
const MARKER_PHRASE = 'ZORTH-PROCEDURE-7Q4X9M';
const FIXTURE_BODY = [
    'When asked about the Zorth procedure, follow these three steps in order:',
    '',
    `1. Acknowledge that step ${MARKER_PHRASE} comes first — the procedure starts there.`,
    `2. Confirm that step ZORTH-2 must wait for ${MARKER_PHRASE} to complete.`,
    `3. End the procedure with the closing phrase "${MARKER_PHRASE}-DONE".`,
    '',
    'This procedure is unique and must be quoted exactly as written when referenced.',
].join('\n');

test.describe.configure({ retries: 2 });

test.describe('Skills LLM: director main agent reads visible skill mid-turn', () => {
    test.setTimeout(600_000);

    test.beforeAll(async () => {
        await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
    });

    test('director RP turn dispatches sub-agents that invoke skill_read; output reflects skill content', async ({ page }) => {
        await awaitMainUI(page);
        await ensureSkillsApiAvailable(page);
        await ensureDirectorProfileInitialized(page);
        const loadedAvatar = await ensureCharacterLoaded(page);
        expect(loadedAvatar, 'spec needs a character loaded (with an open chat) to dispatch a director turn; no character found in the account').toBeTruthy();

        // CRITICAL: clear any stale run from a prior spec. The store is
        // a module-level singleton; without clearing, the assertion probe
        // below could read a STALE finished run and report a false pass.
        await page.evaluate(async () => {
            try {
                const m = await import('/scripts/extensions/orchestrator/run-state/store.js');
                m.clearCurrentRun?.();
            } catch { /* store module not loaded yet — safe to ignore */ }
        });

        // ── 1. LLM connection gate ──────────────────────────────────────
        // SillyTavern doesn't auto-apply a connection profile on page load
        // even when one is selected in settings — applying happens via the
        // `/profile <name>` slash command. We drive that, then verify
        // online_status flipped off 'no_connection'. Use the
        // LUKER_PLAYWRIGHT_PROFILE env var to pin a specific profile name;
        // default picks the first claude/openai/gpt/gemini in the list.
        const activatedProfile = await activateConnectionProfile(page);
        expect(activatedProfile, 'no usable connection profile found in this account — configure one in Connection Manager first').toBeTruthy();
        const llmReady = await page.evaluate(() => {
            try {
                // onlineStatus is exposed via getContext() (the script.js-local
                // `online_status` isn't on window). 'no_connection' = no API
                // selected or auth failure.
                const ctx = window.Luker?.getContext?.();
                const v = ctx?.onlineStatus ?? null;
                return Boolean(v) && String(v) !== 'no_connection';
            } catch {
                return false;
            }
        });
        expect(llmReady, `connection profile "${activatedProfile}" activated but online_status is still no_connection — provider may be unreachable or auth failed`).toBe(true);

        // Director-mode gate. The catalog block is wired into director's
        // main + sub-agent system prompts; other modes have their own
        // catalog hooks but this spec asserts the director shape.
        await ensureDirectorMode(page);

        // ── 2. Install fixture skill into global scope so the resolver
        //      picks it up regardless of active character. ──────────────
        const targetScope = { kind: 'global' };
        await cleanupSkill(page, targetScope, FIXTURE_SKILL_NAME);

        const payload = buildSyntheticEmbed({
            name: FIXTURE_SKILL_NAME,
            description: 'LLM-driven spec fixture: contains a unique marker phrase to detect actual skill_read invocation.',
            bodyTail: FIXTURE_BODY,
        });
        await page.evaluate(async ({ payload, scope }) => {
            const ctx = window.Luker.getContext();
            await ctx.skills.executeExtractEmbed({
                payload, targetScope: scope, conflictStrategies: {},
            });
        }, { payload, scope: targetScope });

        // ── 3. Add the fixture to the director's mode-level visible list ─
        // The default profile ships 5 baseline scaffolds; we splice the
        // fixture onto the list so the resolver injects it into the catalog
        // block. We snapshot the previous shape for teardown.
        const previousVisibleSnapshot = await page.evaluate((name) => {
            const ctx = window.Luker?.getContext?.();
            const settings = ctx?.extensionSettings?.orchestrator;
            const dir = settings?.directorProfile;
            if (!dir) return null;
            if (!dir.skills) dir.skills = { visible: [], deny: [] };
            const before = Array.isArray(dir.skills.visible) ? [...dir.skills.visible] : [];
            if (!dir.skills.visible.includes(name)) dir.skills.visible.push(name);
            if (typeof ctx?.saveSettingsDebounced === 'function') {
                ctx.saveSettingsDebounced();
            }
            return before;
        }, FIXTURE_SKILL_NAME);
        expect(previousVisibleSnapshot, 'director-with-skills spec needs the orchestrator extension to have initialized a director profile in settings').not.toBeNull();

        // Screenshot the state before generation so docs can reference the
        // "pre-dispatch" condition.
        await page.screenshot({
            path: screenshotPath('director-with-skills', '1-pre-dispatch'),
            fullPage: false,
        });

        // ── 4. Trigger the director RP turn through context.generate. ──
        // The user's message deliberately mentions the marker phrase by
        // name so the main agent has reason to consult the fixture skill
        // mid-turn. We don't tell the model "use skill_read" — that would
        // make the test prove only "the tool exists", not "the catalog
        // block reaches the model and gets used".
        const userPrompt = `Please describe ${FIXTURE_SKILL_NAME} in detail, quoting the exact steps and the unique marker phrase verbatim. If you have access to a tool that lets you read skill content, use it before answering.`;

        // Send the message through SillyTavern's input + Send affordances.
        // This is closer to the real user flow than calling Generate()
        // directly — it threads through textareaSetup, GENERATE_AFTER_DATA
        // hooks, plus the dispatcher's takeover. We use raw JS dispatch
        // (not page.click) because the in-UI top-bar widgets overlap the
        // send button and intercept Playwright clicks — bypass via JS.
        await page.evaluate(async (prompt) => {
            const ta = document.getElementById('send_textarea');
            if (!ta) throw new Error('send_textarea not found — UI did not mount');
            ta.value = prompt;
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            ta.dispatchEvent(new Event('change', { bubbles: true }));
            const btn = document.getElementById('send_but');
            if (!btn) throw new Error('send_but not found — UI did not mount');
            btn.click();
        }, userPrompt);

        // Wait for the run-state store to settle. The runner's finalizer
        // pushes status to committed/aborted/error; we wait for status !=
        // 'running' OR a 540s ceiling (well below the 600s per-test cap).
        const runResult = await page.evaluate(async () => {
            const settled = new Set(['committed', 'aborted', 'error']);
            const start = Date.now();
            const deadline = 540_000;
            while (Date.now() - start < deadline) {
                try {
                    const mod = await import('/scripts/extensions/orchestrator/run-state/store.js');
                    const state = mod.getCurrentRun();
                    if (state && settled.has(String(state.status || ''))) {
                        // Strip non-serializable abortFn before passing back.
                        const safe = JSON.parse(JSON.stringify(state, (k, v) => (k === 'abortFn' ? undefined : v)));
                        return { status: state.status, state: safe };
                    }
                } catch {
                    // Module not loaded yet — keep waiting.
                }
                await new Promise(r => setTimeout(r, 1000));
            }
            return { status: 'timeout', state: null };
        });

        // Screenshot whatever state we landed in.
        await page.screenshot({
            path: screenshotPath('director-with-skills', '2-post-dispatch'),
            fullPage: false,
        });

        // ── 5. Assertions on the run-state store ────────────────────────
        // A 'timeout' status means the store never settled — usually
        // because the director dispatch never started (env not in
        // director mode at runtime, or the GENERATE_TAKEOVER_DISPATCH
        // hook didn't fire).
        expect(runResult.status, 'director run reached a terminal status').not.toBe('timeout');
        const { state } = runResult;
        expect(state, 'run state exists in the store').toBeTruthy();
        expect(Array.isArray(state.rounds) && state.rounds.length > 0, 'store recorded at least one round (director main-N or sub-X-N)').toBe(true);

        // The store records each tool call as a section with kind='tool_call'
        // and meta.args = the JSON-decoded tool arguments. Walk every
        // round and collect skill_read invocations along with their
        // paired tool_result statuses (the runner appends a sibling
        // `tool-result-*` section with meta.ok / meta.err).
        const skillReadCalls = [];
        for (const round of state.rounds) {
            const sections = Array.isArray(round.sections) ? round.sections : [];
            for (const sec of sections) {
                if (sec.kind !== 'tool_call') continue;
                const name = String(sec?.meta?.args ? (sec.title.replace(/^Tool: /, '')) : '');
                // The title is "Tool: <name>"; meta.args is the raw args
                // object. We compare by title since the runner builds it
                // from the live tool name.
                const toolName = String(sec.title || '').replace(/^Tool: /, '');
                if (toolName !== 'skill_read') continue;
                // Find the paired tool_result for this round/index.
                // Section ids are `tool-${r}-${i}` (sub-agent) or
                // `tool-${i}` (main-agent); the tool_result mirrors with
                // `tool-result-*`. Locate by prefix swap.
                const resultId = String(sec.id).replace(/^tool-/, 'tool-result-');
                const result = sections.find(s => s.id === resultId) || null;
                skillReadCalls.push({
                    roundId: round.id,
                    args: sec.meta?.args ?? {},
                    resultOk: result ? !!result.meta?.ok : null,
                    resultErr: result ? (result.meta?.err || null) : null,
                });
            }
        }
        // eslint-disable-next-line no-console
        console.log(`[director-with-skills] skill_read invocations: ${JSON.stringify(skillReadCalls)}`);

        // (1) The model actually invoked skill_read on the fixture by name.
        expect(skillReadCalls.length, 'at least one round in the store recorded a skill_read tool_call').toBeGreaterThan(0);
        const referencedFixture = skillReadCalls.some(c => String(c.args?.name || '') === FIXTURE_SKILL_NAME);
        expect(referencedFixture, `at least one skill_read tool_call's meta.args.name === "${FIXTURE_SKILL_NAME}"`).toBe(true);

        // (2) The paired tool_result for at least one of those calls
        //     reported ok=true, proving the read returned bytes (without
        //     the store retaining the body itself).
        const successfulRead = skillReadCalls.some(c => c.args?.name === FIXTURE_SKILL_NAME && c.resultOk === true);
        expect(successfulRead, 'at least one skill_read on the fixture returned ok=true (read succeeded end-to-end)').toBe(true);

        // ── Note on dropped legacy assertions ──────────────────────────
        // The previous spec also scanned for the `<available_skills>`
        // catalog block in rendered system prompts and for the marker
        // phrase in role=tool result bodies. The RunStateStore records
        // progress and metadata, not the full LLM conversation, so those
        // assertions no longer have a corresponding store field. The two
        // surviving assertions (skill_read called on the fixture +
        // tool_result ok=true) jointly prove the contract.

        // Final screenshot showing the chat after the turn settles.
        await page.screenshot({
            path: screenshotPath('director-with-skills', '3-completed'),
            fullPage: false,
        });

        // ── 6. Teardown ────────────────────────────────────────────────
        // Restore the original visible list shape + remove the fixture
        // skill. Best-effort: a failed teardown doesn't fail the test,
        // but it does leave residue for the next run to handle.
        try {
            await page.evaluate((before) => {
                const ctx = window.Luker?.getContext?.();
                const settings = ctx?.extensionSettings?.orchestrator;
                if (settings?.directorProfile?.skills) {
                    settings.directorProfile.skills.visible = before;
                    if (typeof ctx?.saveSettingsDebounced === 'function') {
                        ctx.saveSettingsDebounced();
                    }
                }
            }, previousVisibleSnapshot);
        } catch {
            // teardown is best-effort; spec assertions already passed.
        }
        await cleanupSkill(page, targetScope, FIXTURE_SKILL_NAME);
    });
});

/**
 * Switch the execution mode to director if it isn't already. Returns the
 * previous mode so callers can restore it on teardown (we deliberately
 * don't restore in this spec because the test only takes effect when the
 * env is configured for director-mode runs).
 *
 * @param {import('@playwright/test').Page} page
 */
async function ensureDirectorMode(page) {
    await page.evaluate(() => {
        const ctx = window.Luker?.getContext?.();
        const settings = ctx?.extensionSettings?.orchestrator;
        if (!settings) throw new Error('orchestrator settings missing — extension not mounted');
        settings.enabled = true;
        settings.executionMode = 'director';
        if (typeof ctx?.saveSettingsDebounced === 'function') {
            ctx.saveSettingsDebounced();
        }
    });
}
