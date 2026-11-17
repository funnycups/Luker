/**
 * Workbench AI (`ws: orch`) uses `skill_edit_content` to change ONE line
 * of a skill; verify byte-equality of surrounding content.
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
    setWorkbenchOrchMode,
    openWorkbenchIterateTarget,
    startNewWorkbenchIterateSession,
    sendWorkbenchIteratePrompt,
    applyPendingWorkbenchChanges,
    closeWorkbenchWindow,
    takeDocScreenshot,
} from './helpers.js';

const FIXTURE_SKILL_NAME = 'pw-llm-edit-content-fixture';
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

        const llmReady = await page.evaluate(() => {
            try {
                const v = (typeof window !== 'undefined') ? window.online_status : null;
                return Boolean(v) && String(v) !== 'no_connection';
            } catch {
                return false;
            }
        });
        expect(llmReady, 'LLM API must be configured (online_status != "no_connection")').toBe(true);

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

        const seedFile = await page.evaluate(async (name) => {
            const ctx = window.Luker.getContext();
            const file = await ctx.skills.readFile({ scope: { kind: 'global' }, name, path: 'SKILL.md' });
            return file?.content || '';
        }, FIXTURE_SKILL_NAME);
        expect(seedFile, 'seed file readable').toBeTruthy();
        expect(seedFile.includes(ANCHOR_BEFORE), 'seed has before-anchor').toBe(true);
        expect(seedFile.includes(TARGET_LINE_ORIGINAL), 'seed has original target line').toBe(true);
        expect(seedFile.includes(ANCHOR_AFTER), 'seed has after-anchor').toBe(true);

        // Switch to Director mode in Workbench Orchestration, then open `wb-t-orch` AI Iteration.
        await setWorkbenchOrchMode(page, /Director|导演|導演/i);
        const win = await openWorkbenchIterateTarget(page, 'wb-t-orch');
        await startNewWorkbenchIterateSession(page);

        await takeDocScreenshot(page, screenshotPath('skill-edit-content-diff', '1-popup-open'), { fullPage: false });

        const newLineText = 'Step 2: After greeting, ask the user about their favorite season.';
        const userPrompt = [
            `In the skill named "${FIXTURE_SKILL_NAME}" (global scope), change ONLY the line that says "${TARGET_LINE_ORIGINAL}" to instead read "${newLineText}". `,
            'Leave every other line in the file byte-for-byte identical. This is a surgical one-line edit — please use whichever tool best supports a surgical change (not a full rewrite). After you\'re done, do not call any further tools.',
        ].join('');

        await sendWorkbenchIteratePrompt(page, userPrompt);

        // Wait for live turn indicator to finish and assistant response / pending change list to settle.
        await expect.poll(async () => {
            const liveBusy = await win.locator('.wb-reads.is-live').isVisible().catch(() => false);
            if (liveBusy) return false;
            const hasAiMsg = await win.locator('.wb-msg-ai').count();
            const hasPending = await win.locator('.wb-chg.is-pending').count();
            return hasAiMsg > 0 || hasPending > 0;
        }, { timeout: 110_000, intervals: [500, 1000] }).toBe(true);

        await takeDocScreenshot(page, screenshotPath('skill-edit-content-diff', '2-after-turn'), { fullPage: false });

        // Read persisted Workbench session store (read-only) to verify `skill_edit_content` op before applying.
        const persistedToolNames = await page.evaluate(async () => {
            const ctx = window.Luker?.getContext?.();
            const raw = await ctx?.getHostState?.('luker_workbench_sessions');
            const list = Array.isArray(raw?.sessions) ? raw.sessions : Object.values(raw?.sessions || {});
            list.sort((a, b) => (b?.updatedAt || 0) - (a?.updatedAt || 0));
            const newest = list[0];
            const names = new Set();
            for (const turn of newest?.turns || []) {
                for (const entry of turn?.busState?.entries || []) {
                    const opName = entry?.target?._op?.name || entry?.op?.name || '';
                    if (opName) names.add(String(opName));
                }
            }
            return Array.from(names);
        });
        // eslint-disable-next-line no-console
        console.log(`[skill-edit-content-diff] persisted op names: ${JSON.stringify(persistedToolNames)}`);
        expect(persistedToolNames.includes('skill_edit_content'),
            'AI proposed surgical skill_edit_content op (not full rewrite)').toBe(true);

        // Apply the proposed pending change card so the surgical patch lands on disk.
        await applyPendingWorkbenchChanges(page);

        const editedFile = await page.evaluate(async (name) => {
            const ctx = window.Luker.getContext();
            const file = await ctx.skills.readFile({ scope: { kind: 'global' }, name, path: 'SKILL.md' });
            return file?.content || '';
        }, FIXTURE_SKILL_NAME);

        expect(editedFile.includes(TARGET_LINE_ORIGINAL),
            `original target line "${TARGET_LINE_ORIGINAL.slice(0, 40)}…" was removed`).toBe(false);
        expect(editedFile.includes(ANCHOR_BEFORE),
            `before-anchor "${ANCHOR_BEFORE.slice(0, 40)}…" remained byte-identical`).toBe(true);
        expect(editedFile.includes(ANCHOR_AFTER),
            `after-anchor "${ANCHOR_AFTER.slice(0, 40)}…" remained byte-identical`).toBe(true);

        const seedNeighborhood = sliceNeighborhood(seedFile, ANCHOR_BEFORE, ANCHOR_AFTER);
        const editedNeighborhood = sliceNeighborhood(editedFile, ANCHOR_BEFORE, ANCHOR_AFTER);
        expect(seedNeighborhood, 'seed neighborhood extractable').toBeTruthy();
        expect(editedNeighborhood, 'edited neighborhood extractable').toBeTruthy();

        const beforeAnchorEndInSeed = seedFile.indexOf(ANCHOR_BEFORE) + ANCHOR_BEFORE.length;
        const beforeAnchorEndInEdited = editedFile.indexOf(ANCHOR_BEFORE) + ANCHOR_BEFORE.length;
        expect(editedFile.slice(0, beforeAnchorEndInEdited), 'everything up to + including before-anchor is byte-identical')
            .toBe(seedFile.slice(0, beforeAnchorEndInSeed));

        const afterAnchorStartInSeed = seedFile.indexOf(ANCHOR_AFTER);
        const afterAnchorStartInEdited = editedFile.indexOf(ANCHOR_AFTER);
        expect(editedFile.slice(afterAnchorStartInEdited), 'everything from after-anchor onward is byte-identical')
            .toBe(seedFile.slice(afterAnchorStartInSeed));

        await takeDocScreenshot(page, screenshotPath('skill-edit-content-diff', '3-verified'), { fullPage: false });

        await closeWorkbenchWindow(page);
        await cleanupSkill(page, targetScope, FIXTURE_SKILL_NAME);
    });
});

function sliceNeighborhood(text, anchorStart, anchorEnd) {
    if (typeof text !== 'string') return null;
    const startIdx = text.indexOf(anchorStart);
    if (startIdx < 0) return null;
    const endIdx = text.indexOf(anchorEnd, startIdx);
    if (endIdx < 0) return null;
    return text.slice(startIdx, endIdx + anchorEnd.length);
}
