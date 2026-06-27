/**
 * Character export with embedded skills, end-to-end.
 *
 * Scope:
 *   - Install a synthetic skill in character scope for the active character.
 *   - Pack character-scope skills via the export helper into an embed payload
 *     (this is the same payload the character-card export attaches under
 *     `extensions.luker.embedded_skills_source`; PNG steganography is out of
 *     scope for Playwright — the payload is what the import path consumes).
 *   - Simulate a "fresh user dir reimport" by extracting the same payload
 *     into a brand-new character scope (using a synthetic avatar string),
 *     after pre-cleaning that scope of any prior fixture residue.
 *   - Assert the skill materializes verbatim — name, description, and body
 *     all round-trip through pack + extract.
 *
 * The end-to-end contract this exercises: a character card carrying
 * `embedded_skills_source` deposits its skills in character scope on
 * reimport — character-scope skills follow the character.
 *
 * The real PNG embedder (script.js's `writePngWithExtras`) is exercised by
 * Luker's existing card-app tests; reusing it from Playwright would require
 * driving a file-download dance plus a hostile-zip-safe re-read, neither of
 * which adds coverage over the payload-level roundtrip below.
 *
 * Prerequisites:
 *   - Luker dev server running.
 *   - An active character loaded — without one, the source-scope can't be
 *     populated and the spec soft-skips.
 *
 * Screenshots: docs/public/_screenshots/skills/character-export-*.png.
 *
 * No LLM. Pure pack/extract roundtrip + UI-state assertions.
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
    getActiveCharacterAvatar,
} from './helpers.js';

const FIXTURE_SKILL_NAME = 'pw-character-export-skill';
const FIXTURE_BODY_ANCHOR = 'Body anchor: character-export-roundtrip v1.';
// A synthetic "fresh-user-dir avatar" — picked so it doesn't collide with
// any real character file. The character-scope skill folder structure on
// disk is keyed on this string; cleanupSkill removes the row idempotently.
const REIMPORT_AVATAR = 'pw-fresh-user-character.png';

test.describe('Skills: character export with embedded skills (round-trip)', () => {
    test.setTimeout(90_000);

    test.beforeAll(async () => {
        await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
    });

    test('Char-scope skill packs into embed and reimports verbatim into a fresh char scope', async ({ page }) => {
        await awaitMainUI(page);
        await ensureSkillsApiAvailable(page);

        const avatar = await getActiveCharacterAvatar(page);
        expect(avatar, 'character export spec needs a character loaded — load one in the running dev server before running this spec').toBeTruthy();

        const sourceScope = { kind: 'character', characterFile: avatar };
        const reimportScope = { kind: 'character', characterFile: REIMPORT_AVATAR };

        // Pre-clean both scopes — keeps subsequent runs deterministic.
        await cleanupSkill(page, sourceScope, FIXTURE_SKILL_NAME);
        await cleanupSkill(page, reimportScope, FIXTURE_SKILL_NAME);

        // ── 1. Install fixture skill in source character scope ──────────
        const payload = buildSyntheticEmbed({
            name: FIXTURE_SKILL_NAME,
            description: 'Round-trip fixture verifying character export preserves skill content.',
            bodyTail: FIXTURE_BODY_ANCHOR,
        });
        await page.evaluate(async ({ scope, payload }) => {
            const ctx = window.Luker.getContext();
            await ctx.skills.executeExtractEmbed({ payload, targetScope: scope, conflictStrategies: {} });
        }, { scope: sourceScope, payload });

        // Screenshot 1: the manager panel showing the fixture row at character scope.
        const panel = await openSkillManagerPanel(page);
        await page.screenshot({
            path: screenshotPath('character-export', '1-source-installed'),
            fullPage: false,
        });
        await page.keyboard.press('Escape');
        await panel.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => {});

        // ── 2. Pack character-scope skills via the export helper ────────
        // Mirrors what the character-export hook does pre-PNG-embed.
        const exportedPayload = await page.evaluate(async (scope) => {
            const ctx = window.Luker.getContext();
            const mod = await import('/scripts/skills/embed-export-helper.js');
            return await mod.packSkillsForExport({ context: ctx, targetScope: scope });
        }, sourceScope);
        expect(exportedPayload, 'export helper returns a payload').toBeTruthy();
        expect(exportedPayload.version, 'payload version is 1').toBe(1);
        expect(Array.isArray(exportedPayload.items), 'payload.items is an array').toBe(true);
        // Filter for the fixture entry — the source scope may have other
        // pre-existing character-scope skills that the export packed alongside.
        const fixtureEntry = (exportedPayload.items || []).find(it => it && it.name === FIXTURE_SKILL_NAME);
        expect(fixtureEntry, 'packed payload contains the fixture skill').toBeTruthy();

        // ── 3. Simulate fresh-user-dir reimport. Target a synthetic avatar
        //      that no real character owns; preview should classify the
        //      fixture as 'new' (no prior install in that scope). ────────
        const preview = await page.evaluate(async ({ payload, scope }) => {
            const ctx = window.Luker.getContext();
            return await ctx.skills.previewExtractEmbed({ payload, targetScope: scope });
        }, { payload: exportedPayload, scope: reimportScope });
        const fixturePreview = (preview?.items || []).find(it => it && it.name === FIXTURE_SKILL_NAME);
        expect(fixturePreview, 'preview lists the fixture row').toBeTruthy();
        expect(fixturePreview.conflict, 'fixture is new in the reimport scope').toBe('new');

        // ── 4. Execute the extract (the affirmative path of the import dialog) ─
        const extractResult = await page.evaluate(async ({ payload, scope }) => {
            const ctx = window.Luker.getContext();
            return await ctx.skills.executeExtractEmbed({
                payload, targetScope: scope, conflictStrategies: {},
            });
        }, { payload: exportedPayload, scope: reimportScope });
        expect(extractResult, 'extract returns a result').toBeTruthy();

        // ── 5. Verify the round-tripped skill body matches verbatim ─────
        const roundTripped = await page.evaluate(async ({ scope, name }) => {
            const ctx = window.Luker.getContext();
            const all = await ctx.skills.list({ scope });
            const entry = (all || []).find(s => s.name === name);
            if (!entry) return null;
            const file = await ctx.skills.readFile({ scope, name, path: 'SKILL.md' });
            return { entry, file };
        }, { scope: reimportScope, name: FIXTURE_SKILL_NAME });

        expect(roundTripped, 'fixture present in reimport scope after extract').toBeTruthy();
        expect(roundTripped.entry.scope.kind, 'reimport landed in character scope').toBe('character');
        expect(roundTripped.entry.scope.characterFile, 'reimport scoped to the synthetic avatar').toBe(REIMPORT_AVATAR);
        expect(roundTripped.file.content, 'SKILL.md body survives the roundtrip')
            .toContain(FIXTURE_BODY_ANCHOR);

        // Screenshot 2: the manager panel re-opened to show the reimported
        // row alongside the source. The panel groups by scope, so both
        // character rows surface in the character section.
        const panel2 = await openSkillManagerPanel(page);
        await page.screenshot({
            path: screenshotPath('character-export', '2-reimported'),
            fullPage: false,
        });
        await page.keyboard.press('Escape');
        await panel2.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => {});

        // ── 6. Teardown — remove fixture from both scopes ───────────────
        await cleanupSkill(page, sourceScope, FIXTURE_SKILL_NAME);
        await cleanupSkill(page, reimportScope, FIXTURE_SKILL_NAME);
    });
});
