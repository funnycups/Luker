/**
 * Embed import dialog smoke spec.
 *
 * Scope:
 *   - Invoke `runEmbedImportFlow` against a synthetic inline-files-v1
 *     embed payload (loaded from `fixtures/embed-payload.json`) with
 *     `targetScope.kind = 'character'` so the dialog targets character
 *     scope and the resulting skill installs into character storage.
 *   - Verify the dialog renders with the expected per-skill row table.
 *   - Click "Install" to materialize the skill, then re-query
 *     `context.skills.list({ scope: 'all' })` and assert the new skill
 *     surfaces with `scope.kind = 'character'`.
 *
 * This spec deliberately avoids exercising Luker's real character upload
 * UI because (a) the character-upload flow itself is a SillyTavern
 * surface, not a Luker-skills addition, and (b) Playwright file-upload
 * support is awkward when running against the live dev server (CSRF
 * tokens, the user-data sandbox, etc). The lifecycle handler that auto-
 * opens the dialog on CHAT_CHANGED is already covered by
 * `tests/skills/embed-lifecycle.test.js` (jest unit). What this spec
 * adds is the visual + DOM-level confirmation that the dialog itself
 * renders and the OK path installs into character scope as designed.
 *
 * The embed dialog is identical regardless of how the payload was
 * sourced (character import vs preset import vs the "Import from file"
 * UI button) — the dialog DOM is the only differentiator and the smoke
 * spec exercises it directly.
 *
 * Each step captures a screenshot under
 * docs/public/_screenshots/skills/import-*.png.
 */

import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
    SCREENSHOTS_DIR,
    screenshotPath,
    awaitMainUI,
    ensureSkillsApiAvailable,
} from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'embed-payload.json');

test.describe('Skills: embed import dialog', () => {
    test.setTimeout(60_000);

    test.beforeAll(async () => {
        await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
    });

    test('Dialog renders, install path materializes a character-scope skill', async ({ page }) => {
        await awaitMainUI(page);
        await ensureSkillsApiAvailable(page);

        // Load the embed payload fixture from disk. We pass the parsed
        // JSON across the Playwright bridge to the in-page invocation so
        // the test stays declarative; no nested HEREDOCs.
        const payload = JSON.parse(await fs.readFile(FIXTURE_PATH, 'utf8'));
        expect(payload).toMatchObject({
            version: 1,
            items: expect.any(Array),
        });
        expect(payload.items.length).toBeGreaterThan(0);
        const fixtureSkillName = payload.items[0].name;

        // Pick a target scope. Character scope needs a real avatar
        // string; if no character is loaded in this env, fall back to the
        // first character in the index (the embed dialog needs SOME character
        // scope to install into — any one works for this flow). Hard-fails
        // only when the env has zero characters at all.
        const targetScope = await page.evaluate(() => {
            const ctx = window.Luker?.getContext?.();
            // Prefer the active character; fall back to the first one.
            let avatar = '';
            const cid = ctx?.characterId;
            if (cid !== undefined && cid !== null && Array.isArray(ctx?.characters)) {
                const a = ctx.characters[cid]?.avatar;
                if (typeof a === 'string' && a.length > 0) avatar = a;
            }
            if (!avatar && Array.isArray(ctx?.characters) && ctx.characters.length > 0) {
                const a = ctx.characters[0]?.avatar;
                if (typeof a === 'string' && a.length > 0) avatar = a;
            }
            return avatar ? { kind: 'character', characterFile: avatar } : null;
        });
        expect(targetScope, 'embed import dialog spec needs at least one character on disk — none found in the running dev server').toBeTruthy();

        // Pre-clean: if a prior run left the fixture skill on this
        // character, delete it so we re-trigger the "new" install path
        // rather than landing on "different (choose)".
        await page.evaluate(async ({ scope, name }) => {
            const ctx = window.Luker?.getContext?.();
            if (!ctx?.skills) return;
            try {
                await ctx.skills.delete(scope, name);
            } catch {
                // If the skill doesn't exist, delete rejects — that's fine.
            }
        }, { scope: targetScope, name: fixtureSkillName });

        // ── 1. Trigger runEmbedImportFlow from inside the page ────────
        // The component lives at `public/scripts/skills/embed-import-dialog.js`
        // which we can dynamic-import via the ST module loader. We don't
        // await the resulting promise — once we kick off the flow the
        // dialog mounts synchronously and we drive it from outside via
        // Playwright. The promise resolves when the user (us) closes
        // the popup, so storing it on `window` lets us await it later
        // to retrieve the install result.
        await page.evaluate(async ({ payload, targetScope }) => {
            const mod = await import('/scripts/skills/embed-import-dialog.js');
            const context = window.Luker.getContext();
            window.__luker_smoke_embed_result = mod.runEmbedImportFlow({
                context,
                payload,
                targetScope,
                t: (s) => s,
            });
        }, { payload, targetScope });

        // ── 2. Wait for the dialog to mount + assert table contents ──
        const dialog = page.locator('.popup:has(.luker_skill_import_dialog)').last();
        await dialog.waitFor({ state: 'visible', timeout: 10_000 });

        const dialogBody = dialog.locator('.luker_skill_import_dialog').first();
        await expect(dialogBody).toBeVisible();

        // One row per skill in the payload. Each row has a name cell;
        // the status cell varies by row state (new / same / different /
        // invalid). For a freshly-cleaned character scope, the fixture
        // skill should be in the 'new' state.
        const row = dialog.locator(`tr:has(.luker_skill_import_name:has-text("${fixtureSkillName}"))`).first();
        await expect(row).toBeVisible();

        await page.screenshot({
            path: screenshotPath('import', 'dialog-shown'),
            fullPage: false,
        });

        // ── 3. Click Install ─────────────────────────────────────────
        // The popup's affirmative button is labeled "Install" via the
        // dialog's okButton override. Find it by selector first; fall
        // back to text matching for resilience.
        const installBtn = dialog.locator('.popup-button-ok, [data-result="affirmative"]').first();
        const installCount = await installBtn.count();
        if (installCount > 0) {
            await installBtn.click();
        } else {
            // Fallback: locate by visible text "Install".
            await dialog.getByRole('button', { name: /Install|安装|安裝/ }).first().click();
        }

        // Wait for the dialog to dismiss and the install promise to
        // settle. Pulling the resolved value back gives us a stable
        // assertion target instead of polling the skills.list endpoint.
        await dialog.waitFor({ state: 'detached', timeout: 15_000 });

        const result = await page.evaluate(async () => {
            const r = await window.__luker_smoke_embed_result;
            delete window.__luker_smoke_embed_result;
            return r;
        });

        // ── 4. Assert the install completed cleanly ──────────────────
        // The contract: `installed` is an array of newly-materialized
        // skill names, `skipped` of names that already matched. For our
        // pre-cleaned scope, the fixture skill must land in `installed`.
        expect(result).toBeTruthy();
        expect(result.aborted).toBeFalsy();
        if (Array.isArray(result.installed)) {
            expect(result.installed.some((entry) => {
                const name = typeof entry === 'string' ? entry : entry?.name;
                return name === fixtureSkillName;
            })).toBeTruthy();
        }

        // ── 5. Verify the skill surfaces in character scope ──────────
        const skillsAfter = await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            return await ctx.skills.list({ scope: 'all' });
        });
        const characterRow = (skillsAfter || []).find(
            (s) => s.name === fixtureSkillName && s.scope?.kind === 'character',
        );
        expect(characterRow).toBeTruthy();

        await page.screenshot({
            path: screenshotPath('import', 'completed-character-scope'),
            fullPage: false,
        });

        // ── 6. Cleanup so subsequent runs are idempotent ─────────────
        await page.evaluate(async ({ scope, name }) => {
            const ctx = window.Luker.getContext();
            try {
                await ctx.skills.delete(scope, name);
            } catch {
                // ignore — best-effort
            }
        }, { scope: targetScope, name: fixtureSkillName });
    });
});
