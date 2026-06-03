/**
 * Plan 3 Unit 7 — card-bound preset embedded skills + cleanup (#11).
 *
 * Scope:
 *   - Simulate a character card whose `extensions.luker.bound_preset` block
 *     carries an `embedded_skills_source` payload. Per spec §3.3, that
 *     payload's skills materialize into the CHARACTER's scope (not preset
 *     scope), because the bound-preset's lifecycle is tied to the character.
 *   - Verify the cascadeDeleteSkillsInScope helper cleans the character
 *     scope when the character is deleted — proving the cleanup hook runs
 *     end to end for card-bound preset skills.
 *
 * The full character-load → CHAT_CHANGED → import-dialog path is exercised
 * by jest (`tests/skills-ui/embed-lifecycle.test.js`). This spec adds the
 * server-truth assertion that the materialization actually hits character
 * scope on disk, plus the delete-cascade contract.
 *
 * Prerequisites:
 *   - Luker dev server running.
 *
 * Screenshots: docs/public/_screenshots/skills/card-bound-cleanup-*.png.
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

const FIXTURE_OWN_SKILL = 'pw-card-bound-own-skill';
const FIXTURE_PRESET_SKILL = 'pw-card-bound-preset-skill';
const FIXTURE_AVATAR = 'pw-card-bound-character.png';

test.describe('Skills: card-bound preset materializes to character scope + cleanup cascade', () => {
    test.setTimeout(90_000);

    test.beforeAll(async () => {
        await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
    });

    test('Bound-preset payload lands in character scope; cascade deletes both', async ({ page }) => {
        await awaitMainUI(page);
        await ensureSkillsApiAvailable(page);

        const characterScope = { kind: 'character', characterFile: FIXTURE_AVATAR };
        // The card-bound preset's "preset name" — we assert it does NOT
        // produce a preset-scope skill row (per spec §3.3 those land in
        // character scope), so this scope only exists to negative-assert.
        const negativePresetScope = { kind: 'preset', apiId: 'openai', name: 'pw-card-bound-preset' };

        // Pre-clean both scopes for determinism.
        await cleanupSkill(page, characterScope, FIXTURE_OWN_SKILL);
        await cleanupSkill(page, characterScope, FIXTURE_PRESET_SKILL);
        await cleanupSkill(page, negativePresetScope, FIXTURE_PRESET_SKILL);

        // ── 1. Build a synthetic character object with both payloads ────
        // Mirrors the real card-spec shape: `character.data.extensions.luker.{
        //   embedded_skills_source, bound_preset
        // }` — both contribute to extractCharacterPayloads() which then
        // mergePayloads()'s them into a single character-scope install batch.
        const ownPayload = buildSyntheticEmbed({
            name: FIXTURE_OWN_SKILL,
            description: 'Card-bound test: character\'s own embedded skill (lands in char scope).',
            bodyTail: 'Body anchor: card-bound-own v1.',
        });
        const presetPayload = buildSyntheticEmbed({
            name: FIXTURE_PRESET_SKILL,
            description: 'Card-bound test: skill embedded in the bound-preset block (lands in char scope per spec §3.3).',
            bodyTail: 'Body anchor: card-bound-preset v1.',
        });

        // ── 2. Drive extractCharacterPayloads + mergePayloads + execute ─
        // This is exactly what the CHAT_CHANGED lifecycle handler does, just
        // sourced from a synthetic character object instead of the live
        // character index. The end-state on disk is the contract we care about.
        const installResult = await page.evaluate(async ({ ownPayload, presetPayload, avatar }) => {
            const mod = await import('/scripts/skills/embed-lifecycle.js');
            const ctx = window.SillyTavern.getContext();

            // Build the synthetic character — schema mirrors the real entry
            // in ctx.characters[chid].
            const character = {
                avatar,
                data: {
                    extensions: {
                        luker: {
                            embedded_skills_source: ownPayload,
                            bound_preset: {
                                extensions: {
                                    luker: {
                                        embedded_skills_source: presetPayload,
                                    },
                                },
                            },
                        },
                    },
                },
            };

            const payloads = mod.extractCharacterPayloads(character);
            const merged = mod.mergePayloads(payloads);
            const targetScope = { kind: 'character', characterFile: avatar };
            const out = await ctx.skills.executeExtractEmbed({
                payload: merged, targetScope, conflictStrategies: {},
            });
            return { payloadsLength: payloads.length, mergedItemCount: merged?.items?.length || 0, executeResult: out };
        }, { ownPayload, presetPayload, avatar: FIXTURE_AVATAR });

        expect(installResult.payloadsLength, 'extractCharacterPayloads found both payloads').toBe(2);
        expect(installResult.mergedItemCount, 'mergePayloads concatenated to 2 items').toBe(2);
        expect(installResult.executeResult, 'execute returned a result').toBeTruthy();

        // ── 3. Both skills must live in character scope. The bound-preset
        //      skill MUST NOT have landed in preset scope (spec §3.3 contract). ─
        const charSkills = await page.evaluate(async (scope) => {
            const ctx = window.SillyTavern.getContext();
            return await ctx.skills.list({ scope });
        }, characterScope);
        const charNames = (charSkills || []).map(s => s.name).sort();
        expect(charNames, 'character scope contains both fixture skills').toEqual(
            expect.arrayContaining([FIXTURE_OWN_SKILL, FIXTURE_PRESET_SKILL]),
        );

        const negativeScopeContents = await page.evaluate(async (scope) => {
            const ctx = window.SillyTavern.getContext();
            return await ctx.skills.list({ scope });
        }, negativePresetScope);
        const negativeNames = (negativeScopeContents || []).map(s => s.name);
        expect(
            negativeNames.includes(FIXTURE_PRESET_SKILL),
            'card-bound preset skill did NOT leak into preset scope (§3.3)',
        ).toBe(false);

        // Screenshot 1: manager panel showing both rows under the character section.
        const panel = await openSkillManagerPanel(page);
        await page.screenshot({
            path: screenshotPath('card-bound-cleanup', '1-character-scope-installed'),
            fullPage: false,
        });
        await page.keyboard.press('Escape');
        await panel.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => {});

        // ── 4. Trigger the cascade-delete pathway (the CHARACTER_DELETED
        //      handler's body), then verify both rows are gone. ──────────
        const cascadeResult = await page.evaluate(async (avatar) => {
            const mod = await import('/scripts/skills/embed-lifecycle.js');
            const ctx = window.SillyTavern.getContext();
            return await mod.cascadeDeleteSkillsInScope({
                context: ctx,
                scope: { kind: 'character', characterFile: avatar },
            });
        }, FIXTURE_AVATAR);
        expect(cascadeResult.deleted, 'cascade deleted both fixture skills').toBeGreaterThanOrEqual(2);
        expect(cascadeResult.failed, 'cascade had no failures').toBe(0);

        const charSkillsAfter = await page.evaluate(async (scope) => {
            const ctx = window.SillyTavern.getContext();
            return await ctx.skills.list({ scope });
        }, characterScope);
        const namesAfter = (charSkillsAfter || []).map(s => s.name);
        expect(namesAfter, 'cascade removed own skill').not.toContain(FIXTURE_OWN_SKILL);
        expect(namesAfter, 'cascade removed bound-preset skill').not.toContain(FIXTURE_PRESET_SKILL);

        // Screenshot 2: manager panel post-cascade — character section empty
        // of fixture rows.
        const panel2 = await openSkillManagerPanel(page);
        await page.screenshot({
            path: screenshotPath('card-bound-cleanup', '2-cascade-cleaned'),
            fullPage: false,
        });
        await page.keyboard.press('Escape');
        await panel2.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => {});

        // ── 5. Teardown — clean negative scope and any leftover residue ─
        await cleanupSkill(page, characterScope, FIXTURE_OWN_SKILL);
        await cleanupSkill(page, characterScope, FIXTURE_PRESET_SKILL);
        await cleanupSkill(page, negativePresetScope, FIXTURE_PRESET_SKILL);
    });
});
