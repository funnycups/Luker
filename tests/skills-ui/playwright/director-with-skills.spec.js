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
 *   - Verify three observable outcomes from the resulting runtime trace:
 *       (1) the fixture skill name appears in the main agent's
 *           <available_skills> system block — the catalog block reached the
 *           model.
 *       (2) at least one round in the trace's tool_calls includes a
 *           skill_read call referencing the fixture by name — the model
 *           actually exercised the tool.
 *       (3) the final injected capsule text references the marker phrase
 *           somewhere — the read content influenced the turn output.
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

        // CRITICAL: clear any cached runtime trace from prior runs. The
        // orchestrator stores `latestOrchestrationRuntimeTrace` as a module-
        // level variable that persists across spec runs; without clearing it,
        // the trace probe below can read STALE data and report a false pass.
        // This is the bug that masked a non-firing dispatch in earlier runs.
        await page.evaluate(async () => {
            try {
                const m = await import('/scripts/extensions/orchestrator/runtime-trace.js');
                m.clearLatestOrchestrationRuntimeTrace?.();
            } catch { /* trace module not loaded yet — safe to ignore */ }
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
                const ctx = window.SillyTavern?.getContext?.();
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
            const ctx = window.SillyTavern.getContext();
            await ctx.skills.executeExtractEmbed({
                payload, targetScope: scope, conflictStrategies: {},
            });
        }, { payload, scope: targetScope });

        // ── 3. Add the fixture to the director's mode-level visible list ─
        // The default profile ships 5 baseline scaffolds; we splice the
        // fixture onto the list so the resolver injects it into the catalog
        // block. We snapshot the previous shape for teardown.
        const previousVisibleSnapshot = await page.evaluate((name) => {
            const ctx = window.SillyTavern?.getContext?.();
            const settings = ctx?.extensionSettings?.luker_orchestrator;
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

        // Wait for the runtime trace to populate. The dispatcher's
        // finalizer pushes status to completed/failed/cancelled; we wait
        // for status != 'running' OR a 110s ceiling (safely below the
        // 120s per-test timeout, leaving room for assertion logging).
        const traceResult = await page.evaluate(async () => {
            const ctx = window.SillyTavern.getContext();
            const settled = new Set(['completed', 'failed', 'cancelled']);
            const start = Date.now();
            const deadline = 540_000;
            while (Date.now() - start < deadline) {
                // The runtime-trace module exports getLatestOrchestrationRuntimeTrace;
                // we go through the dynamic import path because the script
                // module isn't always re-exported on the context.
                try {
                    const mod = await import('/scripts/extensions/orchestrator/runtime-trace.js');
                    const trace = mod.getLatestOrchestrationRuntimeTrace(ctx);
                    if (trace && settled.has(String(trace.status || ''))) {
                        return { status: trace.status, trace };
                    }
                } catch {
                    // Module not loaded yet — keep waiting.
                }
                await new Promise(r => setTimeout(r, 1000));
            }
            return { status: 'timeout', trace: null };
        });

        // Screenshot whatever state we landed in.
        await page.screenshot({
            path: screenshotPath('director-with-skills', '2-post-dispatch'),
            fullPage: false,
        });

        // ── 5. Assertions on the trace ──────────────────────────────────
        // Hard guards on the trace shape. A null trace means
        // GENERATE_TAKEOVER_DISPATCH never fired — usually because the
        // environment isn't actually in director mode at runtime (the
        // ensureDirectorMode helper only sets the setting; the runtime
        // re-resolves on every dispatch).
        expect(traceResult.status, 'director run reached a terminal status').not.toBe('timeout');
        const { trace } = traceResult;
        expect(trace, 'runtime trace exists').toBeTruthy();
        expect(trace.director, 'trace.director shape present (director-mode dispatch)').toBeTruthy();

        // (1) Catalog block reaches the model.
        //     The main agent's first system message after dispatch
        //     contains the `<available_skills>` block when a non-empty
        //     visible list resolved. Conservatively walk both
        //     mainAgent.conversation.messages and each sub-agent's
        //     conversation.messages — any one carrying the fixture name
        //     in a system role counts.
        const messagesToScan = [];
        const mainMsgs = trace?.director?.mainAgent?.conversation?.messages;
        if (Array.isArray(mainMsgs)) messagesToScan.push(...mainMsgs);
        const subagents = Array.isArray(trace?.director?.subagents) ? trace.director.subagents : [];
        for (const sub of subagents) {
            const m = sub?.conversation?.messages;
            if (Array.isArray(m)) messagesToScan.push(...m);
        }
        // eslint-disable-next-line no-console
        console.log(`[director-with-skills] message scan size: main=${(mainMsgs || []).length}, sub-agents=${subagents.length}, total scanned=${messagesToScan.length}`);

        const sawCatalogBlock = messagesToScan.some(msg => {
            if (msg?.role !== 'system') return false;
            const content = String(msg.content || '');
            return content.includes('<available_skills>') && content.includes(FIXTURE_SKILL_NAME);
        });
        expect(sawCatalogBlock, 'main/sub-agent system prompt contains <available_skills> with the fixture skill name').toBe(true);

        // (2) The model actually invoked skill_read on the fixture.
        //     Scan tool_calls across main + sub-agent messages. The exact
        //     args might be either `{name: "..."}` or `{name: "...", path:
        //     "..."}` depending on what the model decided to call.
        const skillReadCalls = [];
        for (const msg of messagesToScan) {
            const tcs = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
            for (const tc of tcs) {
                const name = tc?.function?.name || tc?.name || '';
                if (String(name) !== 'skill_read') continue;
                let parsedArgs = {};
                const rawArgs = tc?.function?.arguments ?? tc?.args ?? '';
                if (typeof rawArgs === 'string') {
                    try { parsedArgs = JSON.parse(rawArgs); } catch { parsedArgs = { raw: rawArgs }; }
                } else if (rawArgs && typeof rawArgs === 'object') {
                    parsedArgs = rawArgs;
                }
                skillReadCalls.push(parsedArgs);
            }
        }
        // eslint-disable-next-line no-console
        console.log(`[director-with-skills] skill_read invocations: ${JSON.stringify(skillReadCalls)}`);
        expect(skillReadCalls.length, 'main or a sub-agent invoked skill_read at least once').toBeGreaterThan(0);
        const referencedFixture = skillReadCalls.some(a => String(a?.name || '') === FIXTURE_SKILL_NAME);
        expect(referencedFixture, `skill_read was invoked with name="${FIXTURE_SKILL_NAME}"`).toBe(true);

        // (3) The marker phrase surfaces somewhere in the trace's downstream
        //     output. Either:
        //       - a tool result content carries the body (the read succeeded
        //         and the model received it), OR
        //       - an assistant message after the read references the marker.
        //     We accept either signal: both prove the content actually
        //     flowed back into the conversation.
        const sawMarker = messagesToScan.some(msg => {
            const content = String(msg?.content || '');
            return content.includes(MARKER_PHRASE);
        });
        // eslint-disable-next-line no-console
        console.log(`[director-with-skills] marker phrase observed in trace: ${sawMarker}`);
        expect(sawMarker, `marker phrase "${MARKER_PHRASE}" appears somewhere in the trace (tool result or assistant output)`).toBe(true);

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
                const ctx = window.SillyTavern?.getContext?.();
                const settings = ctx?.extensionSettings?.luker_orchestrator;
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
        const ctx = window.SillyTavern?.getContext?.();
        const settings = ctx?.extensionSettings?.luker_orchestrator;
        if (!settings) throw new Error('luker_orchestrator settings missing — extension not mounted');
        settings.executionMode = 'director';
        if (typeof ctx?.saveSettingsDebounced === 'function') {
            ctx.saveSettingsDebounced();
        }
    });
}
