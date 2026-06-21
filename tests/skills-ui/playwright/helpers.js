/**
 * Shared helpers for the skills-UI Playwright smoke specs.
 *
 * Mirrors the inline-helper pattern used by other Luker e2e suites
 * (`tests/frontend/IterWorkspaceSplit.e2e.js`, etc.) but lifts the
 * three load-bearing helpers into a module: the smoke suite has
 * three spec files and each needs `awaitMainUI`, the extensions
 * drawer open routine, and the orchestrator inline-drawer routine.
 *
 * Suite-wide conventions:
 *   - Tests rely on a running Luker dev server. The Playwright config
 *     resolves `PLAYWRIGHT_BASE_URL` (defaulting to 127.0.0.1:8000); if
 *     no server responds, Playwright surfaces a connection error
 *     immediately rather than masking the failure. The smoke spec must
 *     never silently pass when the server is unreachable.
 *   - All screenshots are saved under `docs/public/_screenshots/skills/`
 *     (created on demand) so Plan 3 docs can reference them by stable
 *     paths (`/_screenshots/skills/<name>.png`). The `public/`
 *     subdirectory is Vitepress's static-asset root, so the same files
 *     also resolve under `npm run docs:dev` and the production build.
 *     Use `screenshotPath(scenario, step)` to generate filenames.
 *   - We never invoke real LLMs from these specs — they are pure
 *     UI-state assertions plus screenshot collection. Plan 3 adds the
 *     LLM-driven end-to-end coverage.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve the repo's docs/public/_screenshots/skills/ directory once.
// The path is rooted relative to this file so the screenshots land in a
// stable location regardless of where `playwright test` is launched
// from. Playwright runs tests with cwd = the playwright.config.js
// directory by default, but we want absolute paths to be unambiguous
// across worktree boundaries (Luker tests live in `tests/`, the docs
// folder is at repo root). We write under `docs/public/_screenshots/`
// (not bare `docs/_screenshots/`) so Vitepress's static-asset pipeline
// serves them at /_screenshots/... — both `npm run dev` and the
// production build pick them up automatically. The convention matches
// how `images/...` references work elsewhere in the doc tree.
//
// __dirname is .../tests/skills-ui/playwright; go up three to repo root.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
export const SCREENSHOTS_DIR = path.join(REPO_ROOT, 'docs', 'public', '_screenshots', 'skills');

/**
 * Compose a stable screenshot path under docs/public/_screenshots/skills/.
 * Example: screenshotPath('manager', 'initial-view') →
 *   <repo>/docs/public/_screenshots/skills/manager-initial-view.png
 *
 * @param {string} scenario - prefix for grouping (e.g. 'manager', 'chips', 'import')
 * @param {string} step - sub-identifier for the screenshot
 * @returns {string} absolute path
 */
export function screenshotPath(scenario, step) {
    const safeScenario = String(scenario).replace(/[^A-Za-z0-9_-]+/g, '-');
    const safeStep = String(step).replace(/[^A-Za-z0-9_-]+/g, '-');
    return path.join(SCREENSHOTS_DIR, `${safeScenario}-${safeStep}.png`);
}

/**
 * Wait for the main Luker UI to be interactive. Mirrors the pattern
 * used by every Luker e2e file: hit "/", possibly click a userSelect
 * tile, then wait for the preloader element to be removed.
 *
 * @param {import('@playwright/test').Page} page
 */
export async function awaitMainUI(page) {
    await page.goto('/');
    const gate = page.locator('#userList .userSelect:last-child');
    try {
        await gate.waitFor({ state: 'visible', timeout: 2000 });
        await gate.click();
    } catch {
        // auto-login or no userList — skip the click and rely on the
        // preloader check below to gate readiness.
    }
    await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 0 });
}

/**
 * Open the right-side extensions drawer if it isn't already open.
 * Necessary because the orchestrator settings live inside that drawer.
 *
 * @param {import('@playwright/test').Page} page
 */
export async function ensureExtensionsDrawerOpen(page) {
    const block = page.locator('#rm_extensions_block');
    const isOpen = await block.evaluate(el => el && !el.classList.contains('closedDrawer')).catch(() => false);
    if (isOpen) return;
    // SillyTavern binds drawer toggle handlers on .drawer-toggle with jQuery's
    // .on('click', doNavbarIconClick). Other open drawers (e.g. right-nav)
    // can z-index overlap the navbar icons, which makes a real mouse click
    // miss the toggle. dispatchEvent fires the click directly on the toggle
    // element, the same path the SillyTavern handler ultimately consumes.
    const toggle = page.locator('#extensions-settings-button .drawer-toggle').first();
    await toggle.waitFor({ state: 'attached', timeout: 5000 });
    await toggle.dispatchEvent('click');
    await block.waitFor({ state: 'visible', timeout: 5000 });
}

/**
 * Expand the orchestrator's `<details>`-like inline drawer if its
 * content is currently hidden. Idempotent.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} hostId - container id (e.g. 'orchestrator_settings')
 */
export async function ensureInlineDrawerOpen(page, hostId) {
    const host = page.locator(`#${hostId}`);
    await host.waitFor({ state: 'attached', timeout: 5000 });
    const drawer = host.locator('> .inline-drawer').first();
    const content = drawer.locator('> .inline-drawer-content');
    const isHidden = await content.evaluate(el => {
        if (!el) return true;
        const style = el.style.display;
        if (style === 'none') return true;
        if (style === 'block' || style === '') {
            const computed = window.getComputedStyle(el);
            return computed.display === 'none';
        }
        return false;
    }).catch(() => true);
    if (!isHidden) return;
    await drawer.locator('> .inline-drawer-toggle').first().click();
    await content.waitFor({ state: 'visible', timeout: 5000 });
}

/**
 * Open the orchestrator drawer + Manage skills panel in one shot.
 * The Manage skills button surfaces inside whichever board is
 * currently visible (spec / loop / director / agenda / single), so we
 * click the first `:visible` instance to stay agnostic about the active
 * execution mode.
 *
 * @param {import('@playwright/test').Page} page
 */
export async function openSkillManagerPanel(page) {
    await awaitMainUI(page);
    await ensureExtensionsDrawerOpen(page);
    await ensureInlineDrawerOpen(page, 'orchestrator_settings');

    const openBtn = page.locator('#orchestrator_settings [data-luker-action="manage-skills"]:visible').first();
    await openBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await openBtn.click();

    const popup = page.locator('.popup .luker_skill_manager').first();
    await popup.waitFor({ state: 'visible', timeout: 10_000 });
    return popup;
}

/**
 * Soft-skip the test if the dev server doesn't expose the JS skills
 * API on the context. This shields the smoke suite from environments
 * where the bundled skill installation hook hasn't completed (e.g.
 * upgrade-from-pre-skills user dir without the migration ran).
 *
 * @param {import('@playwright/test').Page} page
 */
export async function ensureSkillsApiAvailable(page) {
    const hasApi = await page.evaluate(() => {
        const ctx = window.Luker?.getContext?.();
        return Boolean(ctx?.skills && typeof ctx.skills.list === 'function');
    });
    test.skip(!hasApi, 'context.skills API not exposed — skill UI features disabled in this build');
}

/**
 * Activate a real connection profile if one is configured. Returns the
 * profile name on success or '' when none usable.
 *
 * The picker honors `LUKER_PLAYWRIGHT_PROFILE` (case-insensitive name
 * match) before falling back to a /claude|openai|gpt|gemini|anthropic/i
 * heuristic and finally the first profile in the list. Activation goes
 * through the documented `/profile <name>` slash command path — the
 * same path the Connection Manager dropdown wires through — and the
 * function returns the activated name only when `ctx.onlineStatus`
 * settles off `no_connection` within the 1s grace.
 *
 * Mirrors the inline helper used by critic-regex-search.spec.js (and
 * the now-deleted _local-orch-presets.spec.js); promoted here so live
 * specs can share it instead of each copying the 30-line block.
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<string>} profile name on success, '' on failure
 */
export async function activateConnectionProfile(page) {
    // Short-circuit: if there are no connection-manager profiles in
    // settings at all, the dropdown waitForFunction below burns 30s for
    // nothing. Probe the settings shape first (no DOM access).
    const hasAnyProfile = await page.evaluate(() => {
        const ctx = window.Luker?.getContext?.();
        const profiles = ctx?.extensionSettings?.connectionManager?.profiles;
        return Array.isArray(profiles) && profiles.length > 0;
    }).catch(() => false);
    if (!hasAnyProfile) return '';

    // The connection-manager extension initializes asynchronously after
    // awaitMainUI returns. Without this wait, /profile activation would
    // operate on an empty dropdown and never trigger the load.
    try {
        await page.waitForFunction(
            () => Boolean(document.getElementById('connection_profiles')?.options?.length),
            { timeout: 30000 },
        );
    } catch {
        // Extension didn't initialize — fall through; the next probe
        // returns '' which the caller treats as "skip".
    }
    return await page.evaluate(async () => {
        const ctx = window.Luker?.getContext?.();
        if (!ctx) return '';
        const profiles = ctx.extensionSettings?.connectionManager?.profiles;
        if (!Array.isArray(profiles) || !profiles.length) return '';
        const pinned = (
            (typeof process !== 'undefined' && process.env?.LUKER_PLAYWRIGHT_PROFILE)
            || ''
        ).toLowerCase();
        const pick = profiles.find(p => pinned && String(p.name || '').toLowerCase() === pinned)
            || profiles.find(p => /claude|openai|gpt|gemini|anthropic/i.test(String(p.name || '')))
            || profiles[0];
        if (!pick?.name) return '';
        try {
            await ctx.SlashCommandParser.commands.profile?.callback?.({}, pick.name);
        } catch {
            await ctx.executeSlashCommandsWithOptions?.(`/profile ${pick.name}`).catch(() => null);
        }
        await new Promise(r => setTimeout(r, 1000));
        const ok = String(ctx.onlineStatus || '').toLowerCase();
        return (ok && ok !== 'no_connection') ? pick.name : '';
    });
}

/**
 * Ensure a character card is loaded. If one is already selected we
 * return its avatar; otherwise we activate the first available
 * character via the `/char <name>` slash command (the DOM-click path
 * is unreliable in headless Chromium since the tiles wire jQuery
 * handlers that don't always fire from a synthetic `.click()`).
 *
 * Returns the avatar id on success, '' if no character could be loaded.
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<string>} avatar id, or '' when none
 */
export async function ensureCharacterLoaded(page) {
    return await page.evaluate(async () => {
        const ctx = window.Luker?.getContext?.();
        if (!ctx) return '';
        const cur = ctx.characters?.[ctx.characterId];
        if (cur?.avatar) return String(cur.avatar);
        const list = Array.isArray(ctx.characters) ? ctx.characters : [];
        if (!list.length) return '';
        const first = list.find(c => c?.name && c?.avatar) || list.find(c => c?.avatar) || list[0];
        if (!first?.name) return '';
        try {
            await ctx.executeSlashCommandsWithOptions(`/char ${first.name}`);
            await new Promise(r => setTimeout(r, 500));
        } catch {
            const tile = document.querySelector(`#rm_print_characters_block [chid][bogus_folder='false']`)
                || document.querySelector(`#rm_print_characters_block [chid]`);
            if (tile && typeof tile.click === 'function') {
                tile.click();
                await new Promise(r => setTimeout(r, 250));
            }
        }
        const reload = ctx.characters?.[ctx.characterId];
        return String(reload?.avatar || first.avatar || '');
    });
}

/**
 * Read the avatar id of the currently-loaded character. Returns '' when no
 * character is loaded (caller should treat that as fatal — assert on it).
 *
 * Kept separate from ensureCharacterLoaded because some specs only want to
 * snapshot whatever the spec runner left selected, without trying to fall
 * back to "any character with an avatar".
 */
export async function getActiveCharacterAvatar(page) {
    return await page.evaluate(() => {
        const ctx = window.Luker?.getContext?.();
        const cur = ctx?.characters?.[ctx?.characterId];
        return String(cur?.avatar || '');
    });
}

/**
 * Ensure the orchestrator extension's director profile is initialized.
 * Waits for `extension_settings.orchestrator` to exist (the extension's
 * bootstrap creates it on init), then forces the lazy initialization
 * of `directorProfile` by reading the orchestrator status from the
 * context (any path that calls `getDirectorProfileFromSettings`
 * populates the default profile).
 *
 * The active extension namespace is `extension_settings.orchestrator`
 * (MODULE_NAME = 'orchestrator' in main.js). The unrelated
 * `extension_settings.luker_orchestrator` is the iter-studio session
 * store bucket; specs should not write director state there.
 *
 * @param {import('@playwright/test').Page} page
 */
export async function ensureDirectorProfileInitialized(page) {
    // Step 1: wait for the orchestrator settings bucket to exist.
    await page.waitForFunction(() => {
        const ctx = window.Luker?.getContext?.();
        const settings = ctx?.extensionSettings?.orchestrator;
        return Boolean(settings && typeof settings === 'object');
    }, null, { timeout: 30000 });
    // Step 2: force the lazy default to materialize. The director
    // profile is created on first access via createDefaultDirectorProfile;
    // setting it inline (idempotently — only when absent) is faster
    // and less brittle than driving a UI path that triggers the lazy.
    await page.evaluate(async () => {
        const ctx = window.Luker?.getContext?.();
        const settings = ctx.extensionSettings.orchestrator;
        if (settings.directorProfile && typeof settings.directorProfile === 'object') return;
        try {
            const mod = await import('/scripts/extensions/orchestrator/director-defaults.js');
            settings.directorProfile = mod.createDefaultDirectorProfile();
            if (typeof ctx?.saveSettingsDebounced === 'function') {
                ctx.saveSettingsDebounced();
            }
        } catch (e) {
            // If the defaults module can't be loaded the spec has a
            // bigger problem; surface it as a thrown error.
            throw new Error(`ensureDirectorProfileInitialized: failed to load director-defaults (${e.message})`);
        }
    });
}

/**
 * Build a synthetic inline-files-v1 embed payload for a single SKILL.md.
 * Shape mirrors `tests/skills-ui/playwright/fixtures/embed-payload.json`
 * but parameterized by name / description / body so each spec can plant
 * its own marker phrases without disturbing the shared fixture file.
 *
 * @param {object} args
 * @param {string} args.name           — skill name (becomes `name:` in frontmatter)
 * @param {string} args.description    — skill description (becomes `description:` in frontmatter)
 * @param {string} [args.bodyTail='']  — markdown body appended after frontmatter
 * @returns {object} embed payload ready for ctx.skills.executeExtractEmbed
 */
export function buildSyntheticEmbed({ name, description, bodyTail = '' }) {
    if (!name) throw new Error('buildSyntheticEmbed: name is required');
    if (!description) throw new Error('buildSyntheticEmbed: description is required');
    // YAML quoting: any colon/dash/hash in the value confuses the
    // bare-scalar parser; wrap the string and escape internal double
    // quotes. The name is a kebab/underscore identifier so it's safe
    // bare; the description is free-form prose.
    const yamlString = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    const content = [
        '---',
        `name: ${name}`,
        `description: ${yamlString(description)}`,
        '---',
        '',
        String(bodyTail || ''),
    ].join('\n');
    return {
        version: 1,
        items: [
            {
                bundleFormat: 'inline-files-v1',
                name,
                files: [
                    { path: 'SKILL.md', encoding: 'utf8', content },
                ],
            },
        ],
    };
}

/**
 * Delete a skill by name from a given scope, swallowing failures
 * (e.g. when the skill never existed). Used as both pre-test
 * cleanup (so a leftover fixture from a crashed run can't poison
 * the install path) and post-test teardown.
 *
 * Scope shape mirrors the public skills API: `{ kind: 'global' }` /
 * `{ kind: 'character', avatar }` / `{ kind: 'preset', name }`.
 *
 * @param {import('@playwright/test').Page} page
 * @param {object} scope
 * @param {string} name
 */
export async function cleanupSkill(page, scope, name) {
    await page.evaluate(async ({ scope, name }) => {
        try {
            const ctx = window.Luker?.getContext?.();
            const api = ctx?.skills;
            if (!api || typeof api.delete !== 'function') return;
            await api.delete(scope, name);
        } catch {
            // best-effort cleanup
        }
    }, { scope, name }).catch(() => null);
}
