/**
 * Plan 3 Unit 8 — iter-studio AI extracts content from long systemPrompt
 * into a new skill via skill_propose_extraction → skill_extract_from_text →
 * skill_replace_in_systemprompt (#7).
 *
 * LLM cost: ~$1-2 per run (multi-round tool-calling conversation).
 * Requires: dev server running + LLM API configured (online_status !=
 *           'no_connection').
 *
 * Scope:
 *   - Seed the director profile's mainAgent.systemPrompt with a long,
 *     paragraph-segmented text that contains a distinctive, verbatim
 *     "rule paragraph" (the slice we expect the AI to extract).
 *   - Open the AI Iteration Studio for director mode programmatically.
 *   - Send a user message that asks the AI to extract the rule paragraph
 *     into a new skill, leaving a reference in its place.
 *   - Wait for the multi-round turn to settle (the AI is expected to call
 *     skill_propose_extraction → skill_extract_from_text →
 *     skill_replace_in_systemprompt in some order over 1–4 LLM rounds).
 *   - Verify three outcomes:
 *       (1) A new skill exists on disk under the suggestedName the AI
 *           chose, AND its body is byte-equal to the rule paragraph
 *           (verbatim — the contract for skill_extract_from_text is "do
 *           NOT paraphrase").
 *       (2) The session's persistedToolCalls include each of the 3 tool
 *           names at least once (extraction sequence ran end-to-end).
 *       (3) The pending edit in state.pendingEdits has newValue with a
 *           shorter mainAgent.systemPrompt than the seed — replace stage
 *           successfully shrank the prompt.
 *
 * Why a real LLM:
 *   These 3 tools are the agentic core of Plan 3's "long prompt → skill"
 *   migration UX. The contract is "the model uses these tools in sequence
 *   on its own initiative when asked to migrate". Stubbing the LLM would
 *   reduce the test to invoking the tools by hand, which proves the tool
 *   handlers work (already covered by jest) but not the prompt-to-action
 *   pipeline.
 *
 * Test resilience:
 *   - Two retries to absorb LLM nondeterminism.
 *   - 120s timeout — multi-round tool turns commonly take 30-90s.
 *
 * Screenshots: docs/public/_screenshots/skills/iter-studio-extraction-*.png.
 */

import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import {
    SCREENSHOTS_DIR,
    screenshotPath,
    awaitMainUI,
    ensureSkillsApiAvailable,
    cleanupSkill,
} from './helpers.js';

// The rule paragraph the model is expected to extract verbatim. Anchored
// by a unique tag at the start so we can find it in the seed prompt and
// assert byte-equal extraction.
const EXTRACT_TAG = 'ZORTH-RULE-9X8K';
const RULE_PARAGRAPH = [
    `[${EXTRACT_TAG}] CORE RULE: The director must always begin each scene with a sensory hook (sight, sound, scent) and must never open with character introspection. This rule applies to every scene, no exceptions. The director should also vary the opening hook across consecutive scenes — repeating the same modality (e.g. three "smell" hooks in a row) breaks the established discipline. When in doubt, default to a visual hook because visual hooks render most reliably in the player's mind.`,
].join('\n');

// Surrounding context to make the seed prompt long enough that
// skill_propose_extraction's default 1000-char threshold triggers and the
// AI has clear extraction candidates to pick from.
const SURROUNDING_FILLER = [
    'You are the director of a roleplay scene. Your job is to advance the narrative one beat at a time, threading character motivations through environmental detail.',
    '',
    'You may use tools to look up character information, set the scene, or read previously-stored notes. Use them sparingly — most beats should flow from your own model of the situation.',
    '',
    'Output format: always produce 2-4 short paragraphs per turn, no chapter headings or out-of-character commentary.',
].join('\n');

// Compose the full seed systemPrompt. Order: filler → blank line → rule
// paragraph → blank line → filler. Blank-line separation matches the
// paragraph-aware extraction heuristic in skill-iter-studio-tools.js.
const SEED_SYSTEM_PROMPT = `${SURROUNDING_FILLER}\n\n${RULE_PARAGRAPH}\n\n${SURROUNDING_FILLER}`;

test.describe.configure({ retries: 2 });

test.describe('Skills LLM: iter-studio extracts long-systemPrompt content into a skill', () => {
    test.setTimeout(120_000);

    test.beforeAll(async () => {
        await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
    });

    test('AI calls propose → extract → replace; new skill body matches verbatim; systemPrompt shrinks', async ({ page }) => {
        await awaitMainUI(page);
        await ensureSkillsApiAvailable(page);

        // ── 1. LLM connection gate ──────────────────────────────────────
        const llmReady = await page.evaluate(() => {
            try {
                const v = (typeof window !== 'undefined') ? window.online_status : null;
                return Boolean(v) && String(v) !== 'no_connection';
            } catch {
                return false;
            }
        });
        expect(llmReady, 'LLM API must be configured (online_status != "no_connection") — this spec is real-LLM-only and will not silently skip').toBe(true);

        // ── 2. Seed the director profile with the long systemPrompt + ─
        //      snapshot the previous shape for teardown. ───────────────
        const profileSnapshot = await page.evaluate((seed) => {
            const settings = window.extension_settings?.luker_orchestrator;
            if (!settings || !settings.directorProfile) return null;
            // structuredClone keeps the snapshot detached so our mutation
            // below doesn't leak into the rollback.
            const before = structuredClone(settings.directorProfile);
            settings.directorProfile.mainAgent = settings.directorProfile.mainAgent || {};
            settings.directorProfile.mainAgent.systemPrompt = seed;
            // Make sure the working profile shape carries the field as well —
            // iter-studio reads from extension_settings on open.
            if (typeof window.saveSettingsDebounced === 'function') {
                window.saveSettingsDebounced();
            }
            return before;
        }, SEED_SYSTEM_PROMPT);
        expect(profileSnapshot, 'iter-studio extraction spec needs the orchestrator extension to have initialized a director profile in settings').toBeTruthy();

        // Switch execution mode to director and persist.
        await page.evaluate(() => {
            const settings = window.extension_settings.luker_orchestrator;
            settings.executionMode = 'director';
            if (typeof window.saveSettingsDebounced === 'function') {
                window.saveSettingsDebounced();
            }
        });

        // Pre-clean any prior fixture skill the model might pick (we don't
        // know the exact name in advance because the AI chooses
        // suggestedName, but we DO clean up after — see step 6). Cleanup
        // here is best-effort for the most likely names.
        await cleanupSkill(page, { kind: 'global' }, 'director-zorth-rule');
        await cleanupSkill(page, { kind: 'global' }, 'zorth-rule');

        // Capture the pre-test inventory so step 6 can identify which
        // skill the AI created.
        const skillsBefore = await listGlobalSkills(page);

        // ── 3. Open the iter-studio popup programmatically ─────────────
        // Click the orchestrator drawer → mode-specific board → "Open AI
        // Iteration Studio" button. Each mode-specific board renders its
        // own copy of the button (data-luker-action="ai-iterate-open"),
        // so we click the first :visible instance.
        await page.evaluate(() => {
            // Ensure the orchestrator inline-drawer is open so the button
            // becomes visible.
            const block = document.getElementById('rm_extensions_block');
            if (block && block.classList.contains('closedDrawer')) {
                const btn = document.querySelector('#extensions-settings-button .drawer-toggle');
                if (btn) btn.click();
            }
            // Open the orchestrator's inline-drawer.
            const host = document.getElementById('orchestrator_settings');
            if (!host) return;
            const drawer = host.querySelector(':scope > .inline-drawer');
            const content = drawer?.querySelector(':scope > .inline-drawer-content');
            if (content) {
                const style = window.getComputedStyle(content);
                if (style.display === 'none') {
                    drawer.querySelector(':scope > .inline-drawer-toggle')?.click();
                }
            }
        });

        const openIterBtn = page.locator('#orchestrator_settings [data-luker-action="ai-iterate-open"]:visible').first();
        await openIterBtn.waitFor({ state: 'visible', timeout: 10_000 });
        await openIterBtn.click();

        // Wait for the iter-studio popup to mount. The popup carries the
        // `.orch_it_messages` container which is the load-bearing root for
        // the conversation view.
        const studioPopup = page.locator('.popup:has(.orch_it_messages)').last();
        await studioPopup.waitFor({ state: 'visible', timeout: 10_000 });

        await page.screenshot({
            path: screenshotPath('iter-studio-extraction', '1-popup-open'),
            fullPage: false,
        });

        // ── 4. Send a user message asking for the extraction. ───────────
        // The prompt names the EXTRACT_TAG so the model has an unambiguous
        // anchor for "which paragraph to extract". We don't tell it the
        // exact tool sequence — that would defeat the point of the spec.
        // Instead we describe the user intent + reference the migration
        // pattern.
        const userPrompt = [
            `The mainAgent's systemPrompt has a CORE RULE paragraph tagged "[${EXTRACT_TAG}]" that's long enough to live as a standalone skill. Please migrate it: extract that paragraph verbatim into a new global-scope skill, then update the systemPrompt to reference the skill instead of containing the rule inline. The skill name should be short and descriptive — `,
            'something like "director-zorth-rule" works. After you finish, do not call any further tools.',
        ].join('');

        await page.evaluate(async (prompt) => {
            const ta = document.querySelector('.popup [data-orch-it-input]');
            if (!ta) throw new Error('iter-studio composer not found');
            ta.value = prompt;
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            ta.dispatchEvent(new Event('change', { bubbles: true }));
            const send = document.querySelector('.popup [data-orch-it-action="send"]');
            if (!send) throw new Error('iter-studio send button not found');
            send.click();
        }, userPrompt);

        // ── 5. Wait for the AI to settle. The "settled" condition is:
        //      - the Send button text is back to "Send" (busy=false) AND
        //      - at least one assistant message has tool_calls AND
        //      - >=1 second has elapsed since the last messages mutation
        //      (the runner's between-round persist).
        //      We poll the popup's state by reading the DOM messages list.
        const settleResult = await page.evaluate(async () => {
            // The studio exposes its message timeline through DOM
            // `.orch_it_messages` children. We don't have a direct
            // observable for state.isBusy from the outside, but the Send
            // button's text flips between "Send" and "Stop" — that's the
            // signal.
            const sendSel = '.popup [data-orch-it-action="send"]';
            const deadline = 110_000;
            const start = Date.now();
            let lastMsgCount = 0;
            let stableSince = Date.now();
            while (Date.now() - start < deadline) {
                const send = document.querySelector(sendSel);
                const label = (send?.textContent || '').trim();
                const msgs = document.querySelectorAll('.popup .orch_it_messages > *');
                if (msgs.length !== lastMsgCount) {
                    lastMsgCount = msgs.length;
                    stableSince = Date.now();
                }
                // Settled = button reads "Send" + message count stable >=2s.
                if (label === 'Send' && Date.now() - stableSince >= 2000) {
                    return { settled: true, messageCount: lastMsgCount };
                }
                await new Promise(r => setTimeout(r, 500));
            }
            return { settled: false, messageCount: lastMsgCount };
        });
        // eslint-disable-next-line no-console
        console.log(`[iter-studio-extraction] settle result: ${JSON.stringify(settleResult)}`);
        expect(settleResult.settled, 'iter-studio turn reached a non-busy state').toBe(true);

        await page.screenshot({
            path: screenshotPath('iter-studio-extraction', '2-after-turn'),
            fullPage: false,
        });

        // ── 6. Verify the 3 outcomes. ───────────────────────────────────
        // (Outcome 1) A new skill appeared in global scope.
        const skillsAfter = await listGlobalSkills(page);
        const beforeNames = new Set(skillsBefore.map(s => s.name));
        const newSkills = skillsAfter.filter(s => !beforeNames.has(s.name));
        // eslint-disable-next-line no-console
        console.log(`[iter-studio-extraction] new skills created: ${JSON.stringify(newSkills.map(s => s.name))}`);
        expect(newSkills.length, 'AI created at least one new skill').toBeGreaterThan(0);

        // (Outcome 1, cont.) The created skill's body must contain the
        // verbatim rule paragraph. We check `includes` (not strict equality)
        // because the AI may have included additional context around the
        // rule, but the verbatim core must be present.
        const newSkillBodies = [];
        for (const s of newSkills) {
            const body = await readSkillBody(page, { kind: 'global' }, s.name);
            newSkillBodies.push({ name: s.name, body });
        }
        const matchingSkill = newSkillBodies.find(s => s.body.includes(RULE_PARAGRAPH));
        // eslint-disable-next-line no-console
        if (!matchingSkill) {
            console.log('[iter-studio-extraction] new skill bodies sampled:', newSkillBodies.map(s => `${s.name}: ${s.body.slice(0, 120)}…`));
        }
        expect(matchingSkill, 'a newly-created skill carries the verbatim rule paragraph (extraction was lossless)').toBeTruthy();

        // (Outcome 2) The session's persistedToolCalls include all 3 tool names.
        const observedToolNames = await page.evaluate(() => {
            // The studio renders a `.luker_lib_toolcall` chip per call
            // inside each assistant message card. The chip's data
            // attribute carries the tool name.
            const chips = document.querySelectorAll('.popup [data-luker-lib-toolname]');
            const names = new Set();
            for (const chip of chips) names.add(chip.getAttribute('data-luker-lib-toolname'));
            // Also scan the in-memory session in case DOM chips weren't
            // rendered for every call (e.g. inline-executed reads might
            // be folded into the assistant chip layout differently
            // depending on UI version).
            return Array.from(names);
        });
        // eslint-disable-next-line no-console
        console.log(`[iter-studio-extraction] observed tool chips: ${JSON.stringify(observedToolNames)}`);

        // Check the persisted-session messages directly — more reliable
        // than DOM scraping for asserting on tool_calls.
        const persistedToolNames = await page.evaluate(() => {
            // The active session is held on extension_settings under a
            // session key; the iter-studio module persists pendingEdits
            // and messages there. Find the most recently-touched session
            // and read tool_calls off assistant messages.
            const settings = window.extension_settings?.luker_orchestrator;
            const all = settings?.iterStudioSessions || {};
            // Sessions are keyed by mode → { sessionId: session }. Iterate
            // all and find the newest by updatedAt.
            let newest = null;
            for (const modeBucket of Object.values(all)) {
                if (!modeBucket || typeof modeBucket !== 'object') continue;
                for (const session of Object.values(modeBucket)) {
                    if (!session || typeof session !== 'object') continue;
                    if (!newest || (session.updatedAt || 0) > (newest.updatedAt || 0)) {
                        newest = session;
                    }
                }
            }
            const names = new Set();
            const msgs = Array.isArray(newest?.messages) ? newest.messages : [];
            for (const msg of msgs) {
                const tcs = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
                for (const tc of tcs) {
                    const n = tc?.function?.name || tc?.name || '';
                    if (n) names.add(String(n));
                }
            }
            return { names: Array.from(names), messageCount: msgs.length };
        });
        // eslint-disable-next-line no-console
        console.log(`[iter-studio-extraction] persisted tool names: ${JSON.stringify(persistedToolNames)}`);

        const unionToolNames = new Set([...observedToolNames, ...persistedToolNames.names]);
        // We require the 3 migration tools. Some runs may also call
        // skill_list_visible or skill_inspect before extracting — fine.
        const requiredTools = ['skill_propose_extraction', 'skill_extract_from_text', 'skill_replace_in_systemprompt'];
        for (const t of requiredTools) {
            expect(unionToolNames.has(t), `AI called ${t} at least once`).toBe(true);
        }

        // (Outcome 3) The pending edit's newValue carries a shorter
        // mainAgent.systemPrompt than the seed. The replace stage emits
        // exactly this shape (see skill-iter-studio-tools.js's
        // skill_replace_in_systemprompt handler).
        const pendingEditCheck = await page.evaluate(() => {
            const settings = window.extension_settings?.luker_orchestrator;
            const all = settings?.iterStudioSessions || {};
            let newest = null;
            for (const modeBucket of Object.values(all)) {
                if (!modeBucket || typeof modeBucket !== 'object') continue;
                for (const session of Object.values(modeBucket)) {
                    if (!session || typeof session !== 'object') continue;
                    if (!newest || (session.updatedAt || 0) > (newest.updatedAt || 0)) {
                        newest = session;
                    }
                }
            }
            const edits = Array.isArray(newest?.pendingEdits) ? newest.pendingEdits : [];
            const result = { count: edits.length, beforeLen: 0, afterLen: 0 };
            for (const edit of edits) {
                const newSP = edit?.newValue?.mainAgent?.systemPrompt;
                const oldSP = edit?.oldValue?.mainAgent?.systemPrompt;
                if (typeof newSP === 'string' && typeof oldSP === 'string') {
                    if (newSP.length < oldSP.length && (result.afterLen === 0 || newSP.length < result.afterLen)) {
                        result.beforeLen = oldSP.length;
                        result.afterLen = newSP.length;
                    }
                }
            }
            return result;
        });
        // eslint-disable-next-line no-console
        console.log(`[iter-studio-extraction] pendingEdit check: ${JSON.stringify(pendingEditCheck)}`);
        expect(pendingEditCheck.count, 'pending edits captured').toBeGreaterThan(0);
        expect(pendingEditCheck.afterLen, 'mainAgent.systemPrompt shrank in the resulting working profile').toBeLessThan(pendingEditCheck.beforeLen);

        await page.screenshot({
            path: screenshotPath('iter-studio-extraction', '3-verified'),
            fullPage: false,
        });

        // ── 7. Teardown ─────────────────────────────────────────────────
        // Close the popup.
        await page.keyboard.press('Escape');
        await studioPopup.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => {});

        // Restore the original profile.
        await page.evaluate((before) => {
            const settings = window.extension_settings.luker_orchestrator;
            settings.directorProfile = structuredClone(before);
            if (typeof window.saveSettingsDebounced === 'function') {
                window.saveSettingsDebounced();
            }
        }, profileSnapshot);

        // Delete the AI-created skills we identified.
        for (const s of newSkills) {
            await cleanupSkill(page, { kind: 'global' }, s.name);
        }
    });
});

/**
 * List skills in the global scope. Returns an array of
 * `{ name, description, scope }`. Used to diff before/after to identify
 * what the AI created.
 *
 * @param {import('@playwright/test').Page} page
 */
async function listGlobalSkills(page) {
    return await page.evaluate(async () => {
        const ctx = window.SillyTavern.getContext();
        const all = await ctx.skills.list({ scope: 'all' });
        return (Array.isArray(all) ? all : []).filter(s => {
            const k = s?.scope?.kind || s?.scope || '';
            return k === 'global' || k === 'shared';
        });
    });
}

/**
 * Read the SKILL.md body for a named skill. Returns '' on error so the
 * caller can safely substring-check.
 */
async function readSkillBody(page, scope, name) {
    return await page.evaluate(async ({ scope, name }) => {
        try {
            const ctx = window.SillyTavern.getContext();
            const file = await ctx.skills.readFile({ scope, name, path: 'SKILL.md' });
            return file?.content || '';
        } catch {
            return '';
        }
    }, { scope, name });
}
