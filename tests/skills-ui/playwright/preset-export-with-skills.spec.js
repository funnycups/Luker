/**
 * Preset export with embedded skills, end-to-end.
 *
 * Scope:
 *   - Install a synthetic skill into a synthetic preset scope.
 *   - Pack preset-scope skills via the export helper (the same code path
 *     `maybeAttachSkillsToPresetExport` calls inside the OAI_PRESET_EXPORT_READY
 *     hook).
 *   - Reimport into a different synthetic preset scope (simulating a user
 *     who downloads a preset.json and imports it under a fresh name) and
 *     confirm the skill materializes verbatim.
 *   - Confirm preset-scope skills survive the round-trip without bleeding
 *     into character / global scope (the apiId+name pair is the scope key).
 *
 * The preset-export hook fires `OAI_PRESET_EXPORT_READY` and mutates the
 * preset JSON in place; we don't drive the full Export-to-file UI because
 * Playwright file-downloads against the live dev server are flaky and the
 * payload shape is what the import path consumes. The hook itself is
 * covered by Luker's jest suite (`tests/skills-ui/embed-export-helper.test.js`);
 * this spec adds the end-to-end roundtrip assertion.
 *
 * Prerequisites:
 *   - Luker dev server running.
 *
 * Screenshots: docs/public/_screenshots/skills/preset-export-*.png.
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
    openSkillManagerPanel,
    buildSyntheticEmbed,
    cleanupSkill,
} from './helpers.js';

const FIXTURE_SKILL_NAME = 'pw-preset-export-skill';
const FIXTURE_BODY_ANCHOR = 'Body anchor: preset-export-roundtrip v1.';

const SOURCE_PRESET = { kind: 'preset', apiId: 'openai', name: 'pw-preset-export-source' };
const REIMPORT_PRESET = { kind: 'preset', apiId: 'openai', name: 'pw-preset-export-reimport' };

test.describe('Skills: preset export with embedded skills (round-trip)', () => {
    test.setTimeout(90_000);

    test.beforeAll(async () => {
        await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
    });

    test('Preset-scope skill round-trips through pack + extract into a fresh preset scope', async ({ page }) => {
        await awaitMainUI(page);
        await ensureSkillsApiAvailable(page);

        // Pre-clean both scopes so the test starts from a defined ground.
        await cleanupSkill(page, SOURCE_PRESET, FIXTURE_SKILL_NAME);
        await cleanupSkill(page, REIMPORT_PRESET, FIXTURE_SKILL_NAME);

        // ── 1. Install fixture skill in source preset scope ─────────────
        const payload = buildSyntheticEmbed({
            name: FIXTURE_SKILL_NAME,
            description: 'Round-trip fixture verifying preset export preserves skill content.',
            bodyTail: FIXTURE_BODY_ANCHOR,
        });
        await page.evaluate(async ({ scope, payload }) => {
            const ctx = window.Luker.getContext();
            await ctx.skills.executeExtractEmbed({
                payload, targetScope: scope, conflictStrategies: {},
            });
        }, { scope: SOURCE_PRESET, payload });

        // Screenshot 1: manager panel showing the fixture in source preset scope.
        const panel = await openSkillManagerPanel(page);
        await page.screenshot({
            path: screenshotPath('preset-export', '1-source-installed'),
            fullPage: false,
        });
        await page.keyboard.press('Escape');
        await panel.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => {});

        // ── 2. Pack via the export helper ───────────────────────────────
        const exportedPayload = await page.evaluate(async (scope) => {
            const ctx = window.Luker.getContext();
            const mod = await import('/scripts/skills/embed-export-helper.js');
            return await mod.packSkillsForExport({ context: ctx, targetScope: scope });
        }, SOURCE_PRESET);
        expect(exportedPayload, 'export helper returns a payload').toBeTruthy();
        expect(exportedPayload.version, 'payload version is 1').toBe(1);
        const fixtureEntry = (exportedPayload.items || []).find(it => it && it.name === FIXTURE_SKILL_NAME);
        expect(fixtureEntry, 'packed payload contains the fixture skill').toBeTruthy();

        // ── 3. Verify the attachToPreset helper also wires it onto a preset body ─
        // Bonus assertion: prove the attach side of the export hook deposits
        // the payload at the canonical extensions.luker.embedded_skills_source.
        const attachedShape = await page.evaluate(async ({ scope }) => {
            const ctx = window.Luker.getContext();
            const mod = await import('/scripts/skills/embed-export-helper.js');
            const fakePresetBody = { name: 'pw-export-target', some_field: 42 };
            const payload = await mod.packAndAttachSkillsForExport({
                context: ctx, targetScope: scope, attachTo: fakePresetBody,
            });
            return {
                hasPayload: !!payload,
                attachedPath: fakePresetBody.extensions?.luker?.embedded_skills_source || null,
                otherFieldsPreserved: fakePresetBody.some_field === 42 && fakePresetBody.name === 'pw-export-target',
            };
        }, { scope: SOURCE_PRESET });
        expect(attachedShape.hasPayload, 'attach helper returns the payload it attached').toBe(true);
        expect(attachedShape.attachedPath, 'payload lives at extensions.luker.embedded_skills_source').toBeTruthy();
        expect(attachedShape.otherFieldsPreserved, 'attach helper preserves caller fields').toBe(true);

        // ── 4. Preview against the reimport scope — must classify as new ─
        const preview = await page.evaluate(async ({ payload, scope }) => {
            const ctx = window.Luker.getContext();
            return await ctx.skills.previewExtractEmbed({ payload, targetScope: scope });
        }, { payload: exportedPayload, scope: REIMPORT_PRESET });
        const fixturePreview = (preview?.items || []).find(it => it && it.name === FIXTURE_SKILL_NAME);
        expect(fixturePreview, 'fixture appears in reimport preview').toBeTruthy();
        expect(fixturePreview.conflict, 'fixture is new in the reimport preset scope').toBe('new');

        // ── 5. Execute the extract ──────────────────────────────────────
        await page.evaluate(async ({ payload, scope }) => {
            const ctx = window.Luker.getContext();
            return await ctx.skills.executeExtractEmbed({
                payload, targetScope: scope, conflictStrategies: {},
            });
        }, { payload: exportedPayload, scope: REIMPORT_PRESET });

        // ── 6. Verify body round-trip + scope isolation ────────────────
        const roundTripped = await page.evaluate(async ({ scope, name }) => {
            const ctx = window.Luker.getContext();
            const all = await ctx.skills.list({ scope });
            const entry = (all || []).find(s => s.name === name);
            if (!entry) return null;
            const file = await ctx.skills.readFile({ scope, name, path: 'SKILL.md' });
            return { entry, file };
        }, { scope: REIMPORT_PRESET, name: FIXTURE_SKILL_NAME });

        expect(roundTripped, 'fixture present in reimport scope').toBeTruthy();
        expect(roundTripped.entry.scope.kind, 'reimport landed in preset scope').toBe('preset');
        expect(roundTripped.entry.scope.apiId, 'reimport preserved apiId').toBe(REIMPORT_PRESET.apiId);
        expect(roundTripped.entry.scope.name, 'reimport preserved preset name').toBe(REIMPORT_PRESET.name);
        expect(roundTripped.file.content, 'SKILL.md body survives roundtrip')
            .toContain(FIXTURE_BODY_ANCHOR);

        // Bonus assertion: fixture must NOT have leaked into global or any
        // unrelated character scope. The list at 'all' scope reports every
        // installation; we expect exactly two rows (source preset + reimport
        // preset), both preset-kind.
        const fixtureInstances = await page.evaluate(async (name) => {
            const ctx = window.Luker.getContext();
            const all = await ctx.skills.list({ scope: 'all' });
            return (all || []).filter(s => s.name === name).map(s => s.scope);
        }, FIXTURE_SKILL_NAME);
        expect(fixtureInstances, 'fixture has exactly 2 installations').toHaveLength(2);
        for (const scope of fixtureInstances) {
            expect(scope.kind, 'each installation is preset-kind').toBe('preset');
        }

        // Screenshot 2: manager panel showing both preset rows.
        const panel2 = await openSkillManagerPanel(page);
        await page.screenshot({
            path: screenshotPath('preset-export', '2-reimported'),
            fullPage: false,
        });
        await page.keyboard.press('Escape');
        await panel2.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => {});

        // ── 7. Teardown ─────────────────────────────────────────────────
        await cleanupSkill(page, SOURCE_PRESET, FIXTURE_SKILL_NAME);
        await cleanupSkill(page, REIMPORT_PRESET, FIXTURE_SKILL_NAME);
    });
});
