/**
 * Plan 3 Unit 8 — iter-studio AI uses skill_edit_content to change ONE line
 * of a skill; verify byte-equality of surrounding content (#8).
 *
 * LLM cost: ~$0.5 per run.
 * Requires: dev server running + LLM API configured (online_status !=
 *           'no_connection').
 *
 * Scope:
 *   - Install a fixture skill with a multi-line SKILL.md body containing
 *     a clearly-marked TARGET line surrounded by lines that act as
 *     before/after anchors.
 *   - Open the AI Iteration Studio, ask the AI to change ONLY the target
 *     line via skill_edit_content (which calls editFile under the hood,
 *     a string-replace operation).
 *   - After the turn settles, read the skill body back from disk and
 *     verify:
 *       (1) the TARGET line was changed (assertion: original target line
 *           is GONE)
 *       (2) the lines immediately before + after the target are
 *           byte-identical to the seed (no collateral edits)
 *       (3) the AI called skill_edit_content at least once
 *
 * Why a real LLM:
 *   The skill_edit_content tool delegates to repository.editFile, which is
 *   covered by jest. What's NOT covered is "the AI uses this tool
 *   correctly when given a single-line change instruction" — the
 *   oldString/newString surgical-replace pattern is one the model has to
 *   intuit. This spec is the contract that the tool description + system
 *   prompt augmentation steer the model toward surgical edits, not full-
 *   file rewrites.
 *
 * Failure-mode policy (per Plan 3 Unit 8 directive):
 *   - If the AI calls skill_update_content (full rewrite) instead of
 *     skill_edit_content, the spec fails — that's a real symptom that the
 *     tool descriptions don't sufficiently distinguish surgical from
 *     bulk edits, and would need investigation.
 *   - If byte-equality fails on the surrounding lines, the spec fails —
 *     editFile's string-replace contract is broken or the model is
 *     producing oversized oldString matches.
 *
 * Test resilience:
 *   - Two retries.
 *   - 120s timeout.
 *
 * Screenshots: docs/public/_screenshots/skills/skill-edit-content-diff-*.png.
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
} from './helpers.js';

const FIXTURE_SKILL_NAME = 'pw-llm-edit-content-fixture';
// Lines have distinctive content so a substring/byte-equality assertion
// is unambiguous. ANCHOR_BEFORE and ANCHOR_AFTER are the lines we expect
// to remain byte-identical post-edit.
const ANCHOR_BEFORE = 'Step 1: Greet the user warmly before any roleplay begins.';
const TARGET_LINE_ORIGINAL = 'Step 2: After greeting, ask the user about their favorite color.';
const ANCHOR_AFTER = 'Step 3: Use the color in the opening sentence of the scene.';
const FIXTURE_BODY = [
    'This skill defines the opening-greeting micro-procedure for first-turn responses.',
    '',
    ANCHOR_BEFORE,
    TARGET_LINE_ORIGINAL,
    ANCHOR_AFTER,
    '',
    'When this procedure runs, the director MUST follow steps 1-3 in order without skipping.',
].join('\n');

test.describe.configure({ retries: 2 });

test.describe('Skills LLM: skill_edit_content changes one line; surrounding content stays byte-equal', () => {
    test.setTimeout(120_000);

    test.beforeAll(async () => {
        await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
    });

    test('AI surgical-edits a single line via skill_edit_content; anchors preserved', async ({ page }) => {
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

        // ── 2. Install fixture skill in global scope ────────────────────
        const targetScope = { kind: 'global' };
        await cleanupSkill(page, targetScope, FIXTURE_SKILL_NAME);

        const payload = buildSyntheticEmbed({
            name: FIXTURE_SKILL_NAME,
            description: 'Edit-content diff spec fixture: multi-line body with anchored target line.',
            bodyTail: FIXTURE_BODY,
        });
        await page.evaluate(async ({ payload, scope }) => {
            const ctx = window.Luker.getContext();
            await ctx.skills.executeExtractEmbed({
                payload, targetScope: scope, conflictStrategies: {},
            });
        }, { payload, scope: targetScope });

        // Capture the seed body exactly as on disk — frontmatter is
        // prepended by the SKILL.md writer, so the body lines live inside
        // a known position relative to the `---` fence.
        const seedFile = await page.evaluate(async (name) => {
            const ctx = window.Luker.getContext();
            const file = await ctx.skills.readFile({ scope: { kind: 'global' }, name, path: 'SKILL.md' });
            return file?.content || '';
        }, FIXTURE_SKILL_NAME);
        expect(seedFile, 'seed file readable').toBeTruthy();
        expect(seedFile.includes(ANCHOR_BEFORE), 'seed has before-anchor').toBe(true);
        expect(seedFile.includes(TARGET_LINE_ORIGINAL), 'seed has original target line').toBe(true);
        expect(seedFile.includes(ANCHOR_AFTER), 'seed has after-anchor').toBe(true);

        // ── 3. Switch to director mode + open iter-studio. ──────────────
        await page.evaluate(() => {
            const settings = window.extension_settings.luker_orchestrator;
            settings.executionMode = 'director';
            if (typeof window.saveSettingsDebounced === 'function') {
                window.saveSettingsDebounced();
            }
            // Open the extensions drawer + orchestrator inline drawer so
            // the iter-studio button becomes visible.
            const block = document.getElementById('rm_extensions_block');
            if (block && block.classList.contains('closedDrawer')) {
                document.querySelector('#extensions-settings-button .drawer-toggle')?.click();
            }
            const host = document.getElementById('orchestrator_settings');
            const drawer = host?.querySelector(':scope > .inline-drawer');
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

        const studioPopup = page.locator('.popup:has(.orch_it_messages)').last();
        await studioPopup.waitFor({ state: 'visible', timeout: 10_000 });

        await page.screenshot({
            path: screenshotPath('skill-edit-content-diff', '1-popup-open'),
            fullPage: false,
        });

        // ── 4. Send the edit instruction. ───────────────────────────────
        // The prompt asks for a SPECIFIC line change, names the skill, and
        // mentions that the change should be a surgical edit (avoiding
        // full-file overwrite). We do not name the tool — letting the
        // model choose between skill_edit_content (surgical) and
        // skill_update_content (full rewrite) tests the steering.
        const newLineText = 'Step 2: After greeting, ask the user about their favorite season.';
        const userPrompt = [
            `In the skill named "${FIXTURE_SKILL_NAME}" (global scope), change ONLY the line that says "${TARGET_LINE_ORIGINAL}" to instead read "${newLineText}". `,
            'Leave every other line in the file byte-for-byte identical. This is a surgical one-line edit — please use whichever tool best supports a surgical change (not a full rewrite). After you\'re done, do not call any further tools.',
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

        // ── 5. Wait for the turn to settle. Same pattern as Spec 7. ──
        const settleResult = await page.evaluate(async () => {
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
                if (label === 'Send' && Date.now() - stableSince >= 2000) {
                    return { settled: true, messageCount: lastMsgCount };
                }
                await new Promise(r => setTimeout(r, 500));
            }
            return { settled: false, messageCount: lastMsgCount };
        });
        // eslint-disable-next-line no-console
        console.log(`[skill-edit-content-diff] settle result: ${JSON.stringify(settleResult)}`);
        expect(settleResult.settled, 'iter-studio turn reached a non-busy state').toBe(true);

        await page.screenshot({
            path: screenshotPath('skill-edit-content-diff', '2-after-turn'),
            fullPage: false,
        });

        // ── 6. Verify outcomes. ─────────────────────────────────────────
        // (Outcome 3 first — easier to fail fast): the tool was called.
        const persistedToolNames = await page.evaluate(() => {
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
            const names = new Set();
            const msgs = Array.isArray(newest?.messages) ? newest.messages : [];
            for (const msg of msgs) {
                const tcs = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
                for (const tc of tcs) {
                    const n = tc?.function?.name || tc?.name || '';
                    if (n) names.add(String(n));
                }
            }
            return Array.from(names);
        });
        // eslint-disable-next-line no-console
        console.log(`[skill-edit-content-diff] persisted tool names: ${JSON.stringify(persistedToolNames)}`);
        expect(persistedToolNames.includes('skill_edit_content'),
            'AI invoked skill_edit_content (surgical edit, not full rewrite)').toBe(true);

        // Read the post-edit file body. The server may persist the write
        // asynchronously through the editFile path, so we re-fetch from disk.
        const editedFile = await page.evaluate(async (name) => {
            const ctx = window.Luker.getContext();
            const file = await ctx.skills.readFile({ scope: { kind: 'global' }, name, path: 'SKILL.md' });
            return file?.content || '';
        }, FIXTURE_SKILL_NAME);

        // (Outcome 1) The original target line is gone.
        expect(editedFile.includes(TARGET_LINE_ORIGINAL),
            `original target line "${TARGET_LINE_ORIGINAL.slice(0, 40)}…" was removed`).toBe(false);

        // (Outcome 2) The before/after anchor lines are byte-identical.
        // We do this by extracting the lines from both seed and edited
        // bodies and comparing. Lines are matched by index in the body
        // post-frontmatter — but since the frontmatter is identical,
        // substring presence is sufficient.
        expect(editedFile.includes(ANCHOR_BEFORE),
            `before-anchor "${ANCHOR_BEFORE.slice(0, 40)}…" remained byte-identical`).toBe(true);
        expect(editedFile.includes(ANCHOR_AFTER),
            `after-anchor "${ANCHOR_AFTER.slice(0, 40)}…" remained byte-identical`).toBe(true);

        // Stronger guarantee: byte-equality of the contextual neighbourhood.
        // We compute the substring [start-of-anchor-before … end-of-anchor-after]
        // from BOTH files. The "middle" of seed contains TARGET_LINE_ORIGINAL;
        // the "middle" of edited contains something else (the new line). The
        // prefix + suffix must match.
        const seedNeighborhood = sliceNeighborhood(seedFile, ANCHOR_BEFORE, ANCHOR_AFTER);
        const editedNeighborhood = sliceNeighborhood(editedFile, ANCHOR_BEFORE, ANCHOR_AFTER);
        expect(seedNeighborhood, 'seed neighborhood extractable').toBeTruthy();
        expect(editedNeighborhood, 'edited neighborhood extractable').toBeTruthy();

        // The neighborhoods START identically (everything up to and
        // INCLUDING the before-anchor) and END identically (everything
        // from the after-anchor onward). The middle differs.
        const beforeAnchorEndInSeed = seedFile.indexOf(ANCHOR_BEFORE) + ANCHOR_BEFORE.length;
        const beforeAnchorEndInEdited = editedFile.indexOf(ANCHOR_BEFORE) + ANCHOR_BEFORE.length;
        const seedHeader = seedFile.slice(0, beforeAnchorEndInSeed);
        const editedHeader = editedFile.slice(0, beforeAnchorEndInEdited);
        expect(editedHeader, 'everything up to + including before-anchor is byte-identical').toBe(seedHeader);

        const afterAnchorStartInSeed = seedFile.indexOf(ANCHOR_AFTER);
        const afterAnchorStartInEdited = editedFile.indexOf(ANCHOR_AFTER);
        const seedTail = seedFile.slice(afterAnchorStartInSeed);
        const editedTail = editedFile.slice(afterAnchorStartInEdited);
        expect(editedTail, 'everything from after-anchor onward is byte-identical').toBe(seedTail);

        await page.screenshot({
            path: screenshotPath('skill-edit-content-diff', '3-verified'),
            fullPage: false,
        });

        // ── 7. Teardown ─────────────────────────────────────────────────
        await page.keyboard.press('Escape');
        await studioPopup.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => {});
        await cleanupSkill(page, targetScope, FIXTURE_SKILL_NAME);
    });
});

/**
 * Slice a string from the start of `anchorStart` through the end of
 * `anchorEnd`. Returns null when either anchor is missing — caller
 * surfaces the failure with a descriptive expect message.
 */
function sliceNeighborhood(text, anchorStart, anchorEnd) {
    if (typeof text !== 'string') return null;
    const startIdx = text.indexOf(anchorStart);
    if (startIdx < 0) return null;
    const endIdx = text.indexOf(anchorEnd, startIdx);
    if (endIdx < 0) return null;
    return text.slice(startIdx, endIdx + anchorEnd.length);
}
