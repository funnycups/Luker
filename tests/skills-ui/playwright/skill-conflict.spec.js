/**
 * Skill conflict dialog: Skip vs Replace.
 *
 * Scope:
 *   - Install skill A (initial content) into character scope.
 *   - Run the embed import dialog with a SAME-NAME, DIFFERENT-CONTENT
 *     payload. Preview must classify the row as `different`.
 *   - First pass: pick Skip — verify original content is retained.
 *   - Second pass: pick Replace — verify new content overwrites.
 *
 * The conflict-radio UI is the user's only intra-batch decision lever for
 * `different` rows; auto-skip + auto-replace handle `same` and `new` rows
 * respectively. This spec is the contract test for the manual lever.
 *
 * Prerequisites:
 *   - Luker dev server running.
 *   - Active character (the dialog needs a real character scope to install into).
 *
 * Screenshots: docs/public/_screenshots/skills/skill-conflict-*.png.
 *
 * No LLM.
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
    getActiveCharacterAvatar,
} from './helpers.js';

const FIXTURE_SKILL_NAME = 'pw-skill-conflict-fixture';
const INITIAL_BODY_ANCHOR = 'Body anchor: ORIGINAL content v1.';
const REPLACEMENT_BODY_ANCHOR = 'Body anchor: REPLACEMENT content v2.';

test.describe('Skills: conflict dialog Skip / Replace branches', () => {
    test.setTimeout(120_000);

    test.beforeAll(async () => {
        await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
    });

    test('Same-name different-content: Skip retains original; Replace overwrites', async ({ page }) => {
        await awaitMainUI(page);
        await ensureSkillsApiAvailable(page);

        const avatar = await getActiveCharacterAvatar(page);
        expect(avatar, 'skill conflict spec needs a character loaded — load one in the running dev server before running this spec').toBeTruthy();

        const targetScope = { kind: 'character', characterFile: avatar };

        // Pre-clean fixture residue from prior runs.
        await cleanupSkill(page, targetScope, FIXTURE_SKILL_NAME);

        // ── 1. Install initial version of the fixture skill ─────────────
        const initialPayload = buildSyntheticEmbed({
            name: FIXTURE_SKILL_NAME,
            description: 'Original — should survive Skip; should be overwritten by Replace.',
            bodyTail: INITIAL_BODY_ANCHOR,
        });
        await page.evaluate(async ({ payload, scope }) => {
            const ctx = window.Luker.getContext();
            await ctx.skills.executeExtractEmbed({ payload, targetScope: scope, conflictStrategies: {} });
        }, { payload: initialPayload, scope: targetScope });

        // Sanity: confirm the initial body landed.
        const initialContent = await readFixtureBody(page, targetScope);
        expect(initialContent, 'initial body has the original anchor').toContain(INITIAL_BODY_ANCHOR);

        // Build the same-name, different-content replacement payload.
        const replacementPayload = buildSyntheticEmbed({
            name: FIXTURE_SKILL_NAME,
            description: 'REPLACEMENT description — should only appear after the Replace branch executes.',
            bodyTail: REPLACEMENT_BODY_ANCHOR,
        });

        // ── 2. Preview against the existing install → expect 'different' ─
        const preview = await page.evaluate(async ({ payload, scope }) => {
            const ctx = window.Luker.getContext();
            return await ctx.skills.previewExtractEmbed({ payload, targetScope: scope });
        }, { payload: replacementPayload, scope: targetScope });
        const fixturePreview = (preview?.items || []).find(it => it && it.name === FIXTURE_SKILL_NAME);
        expect(fixturePreview, 'preview lists fixture row').toBeTruthy();
        expect(fixturePreview.conflict, 'preview classifies fixture as different').toBe('different');

        // ── 3. Drive the dialog with Skip — verify original is retained ─
        await driveConflictDialog({
            page,
            payload: replacementPayload,
            targetScope,
            radioChoice: 'skip',
            screenshotKey: 'skip-dialog',
        });
        const afterSkipContent = await readFixtureBody(page, targetScope);
        expect(afterSkipContent, 'Skip branch retained the original body')
            .toContain(INITIAL_BODY_ANCHOR);
        expect(afterSkipContent, 'Skip branch did NOT insert the replacement body')
            .not.toContain(REPLACEMENT_BODY_ANCHOR);

        // ── 4. Drive the dialog with Replace — verify new body overwrites ─
        await driveConflictDialog({
            page,
            payload: replacementPayload,
            targetScope,
            radioChoice: 'replace',
            screenshotKey: 'replace-dialog',
        });
        const afterReplaceContent = await readFixtureBody(page, targetScope);
        expect(afterReplaceContent, 'Replace branch swapped in the new body')
            .toContain(REPLACEMENT_BODY_ANCHOR);
        expect(afterReplaceContent, 'Replace branch dropped the original anchor')
            .not.toContain(INITIAL_BODY_ANCHOR);

        // Visual proof of post-replace state.
        await page.screenshot({
            path: screenshotPath('skill-conflict', '3-post-replace'),
            fullPage: false,
        });

        // ── 5. Teardown ─────────────────────────────────────────────────
        await cleanupSkill(page, targetScope, FIXTURE_SKILL_NAME);
    });
});

/**
 * Run runEmbedImportFlow in-page, then click the matching Skip/Replace
 * radio for the fixture row, then click Install. Awaits the import promise
 * to settle before returning so the caller can read post-state immediately.
 *
 * @param {object} opts
 * @param {import('@playwright/test').Page} opts.page
 * @param {object} opts.payload - the embed payload to import
 * @param {object} opts.targetScope - scope to install into
 * @param {'skip'|'replace'} opts.radioChoice - radio value to select
 * @param {string} opts.screenshotKey - filename slug for the dialog screenshot
 */
async function driveConflictDialog({ page, payload, targetScope, radioChoice, screenshotKey }) {
    // Kick off the import flow inside the page; expose the result promise
    // on window so we can await it from the harness after the dialog closes.
    await page.evaluate(async ({ payload, targetScope }) => {
        const mod = await import('/scripts/skills/embed-import-dialog.js');
        const context = window.Luker.getContext();
        window.__luker_smoke_conflict_result = mod.runEmbedImportFlow({
            context,
            payload,
            targetScope,
            t: (s) => s,
        });
    }, { payload, targetScope });

    // Wait for the dialog to mount, screenshot it, click the radio, click Install.
    const dialog = page.locator('.popup:has(.luker_skill_import_dialog)').last();
    await dialog.waitFor({ state: 'visible', timeout: 10_000 });

    // The radio's name attribute is per-row (built off the row index); the
    // value attribute distinguishes skip vs replace. data-skill-import-radio
    // tags each radio with the skill name → narrow on that for stability.
    const radio = dialog.locator(
        `input[type="radio"][data-skill-import-radio][value="${radioChoice}"]`,
    ).first();
    await radio.waitFor({ state: 'visible', timeout: 5_000 });
    await radio.check();

    // Screenshot the dialog with the radio selected so docs can show both
    // branches.
    await page.screenshot({
        path: screenshotPath('skill-conflict', screenshotKey),
        fullPage: false,
    });

    // Click Install — the affirmative button.
    const installBtn = dialog.locator('.popup-button-ok, [data-result="affirmative"]').first();
    if (await installBtn.count() > 0) {
        await installBtn.click();
    } else {
        await dialog.getByRole('button', { name: /Install|安装|安裝/ }).first().click();
    }

    await dialog.waitFor({ state: 'detached', timeout: 15_000 });

    // Pull the import-flow result back so a downstream assertion can use
    // it if needed; presently the body-content read is the load-bearing
    // verification, so we just consume the promise to keep the page clean.
    const result = await page.evaluate(async () => {
        const r = await window.__luker_smoke_conflict_result;
        delete window.__luker_smoke_conflict_result;
        return r;
    });
    return result;
}

/**
 * Read the SKILL.md body for the fixture skill in a given scope. Returns
 * an empty string if the skill is missing (rather than throwing) so a
 * cascade-cleaned skill produces a graceful empty-string compare.
 *
 * @param {import('@playwright/test').Page} page
 * @param {object} scope
 * @returns {Promise<string>}
 */
async function readFixtureBody(page, scope) {
    return await page.evaluate(async ({ scope, name }) => {
        const ctx = window.Luker.getContext();
        try {
            const file = await ctx.skills.readFile({ scope, name, path: 'SKILL.md' });
            return file?.content || '';
        } catch {
            return '';
        }
    }, { scope, name: FIXTURE_SKILL_NAME });
}
