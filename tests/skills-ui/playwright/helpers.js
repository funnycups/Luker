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
        const ctx = window.SillyTavern?.getContext?.();
        return Boolean(ctx?.skills && typeof ctx.skills.list === 'function');
    });
    test.skip(!hasApi, 'context.skills API not exposed — skill UI features disabled in this build');
}
