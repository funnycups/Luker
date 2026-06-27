/**
 * Director-defaults refresh e2e.
 *
 * Scope:
 *   - Wipe the director profile's mode-level + main + sub-agent `skills.visible`
 *     fields to confirm the test starts dirty.
 *   - Invoke `createDefaultDirectorProfile()` (the function that backs the
 *     "Refresh director defaults from bundled" UX) and apply the result over
 *     the live extension settings.
 *   - Verify the rebuilt profile carries the canonical default shape:
 *       mode-level visible[] holds the 5 baseline scaffolds,
 *       mainAgent.skills.visible holds the inherit sentinel + workflow + dispatch,
 *       every sub-agent.skills.visible holds the inherit sentinel + a method skill.
 *
 * The default is wired into the profile loader; the test is
 * the regression contract that says "a future scaffold rename / addition
 * surfaces here, not in user-visible silent breakage". Screenshot the
 * orchestrator board at the after state so the docs reviewer can eyeball
 * the recovered chips.
 *
 * Prerequisites:
 *   - Luker dev server running.
 *   - `extension_settings.luker_orchestrator.directorProfile` exists. The
 *     test populates it from scratch if missing (the same path the loader
 *     takes on fresh install), so a freshly-spun user dir is acceptable.
 *
 * Screenshots: docs/public/_screenshots/skills/refresh-defaults-*.png.
 *
 * No LLM. Purely deterministic state-machine assertions.
 */

import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import {
    SCREENSHOTS_DIR,
    screenshotPath,
    awaitMainUI,
    ensureExtensionsDrawerOpen,
    ensureInlineDrawerOpen,
    ensureSkillsApiAvailable,
    ensureDirectorProfileInitialized,
} from './helpers.js';

// Mode-level baseline expected by the default profile.
// Names are pinned: any rename of these scaffolds should surface as a
// failure here so the doc + assertion tables stay in sync.
const EXPECTED_MODE_VISIBLE = [
    'director-anti-cliche-zh',
    'director-character-voice-zh',
    'director-no-meta-zh',
    'director-output-discipline-zh',
    'director-zh-style-baseline',
];

const EXPECTED_MAIN_VISIBLE = [
    '+', // inherit mode baseline
    'director-turn-workflow-zh',
    'director-dispatch-protocol-zh',
    'draft-writer-style-zh',
];

test.describe('Skills: director-defaults refresh', () => {
    test.setTimeout(60_000);

    test.beforeAll(async () => {
        await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
    });

    test('Default profile rebuild restores mode-level + main + sub-agent skills.visible', async ({ page }) => {
        await awaitMainUI(page);
        await ensureSkillsApiAvailable(page);
        await ensureDirectorProfileInitialized(page);

        // ── 1. Snapshot the current profile so we can restore later ──────
        const snapshot = await page.evaluate(() => {
            const settings = window.extension_settings?.luker_orchestrator;
            if (!settings || !settings.directorProfile) return null;
            // structuredClone keeps nested arrays / objects detached so a
            // mutation in step 2 can't leak into the snapshot.
            return structuredClone(settings.directorProfile);
        });
        expect(snapshot, 'refresh-defaults spec needs the orchestrator extension to have initialized a director profile in settings').toBeTruthy();

        // ── 2. Wipe the skills.visible fields to prove the refresh is what
        //      restores them (not a residual default already on disk). ────
        await page.evaluate(() => {
            const settings = window.extension_settings.luker_orchestrator;
            const dir = settings.directorProfile;
            if (dir?.skills) dir.skills.visible = [];
            if (dir?.mainAgent?.skills) dir.mainAgent.skills.visible = [];
            if (Array.isArray(dir?.subAgents)) {
                for (const agent of dir.subAgents) {
                    if (agent?.skills) agent.skills.visible = [];
                }
            }
            if (typeof window.saveSettingsDebounced === 'function') {
                window.saveSettingsDebounced();
            }
        });

        const dirtied = await readDirectorVisibleShape(page);
        expect(dirtied.modeVisible, 'mode visible is empty after wipe').toEqual([]);
        expect(dirtied.mainVisible, 'main visible is empty after wipe').toEqual([]);
        for (const s of dirtied.subVisible) {
            expect(s.visible, `sub-agent ${s.id} visible is empty after wipe`).toEqual([]);
        }

        // Open the orchestrator drawer + screenshot the empty-chips state so
        // docs can show "before refresh". Note: the chips block hydrates from
        // working-profile state when the editor popup opens, so we don't need
        // to drive the editor here — the screenshot serves as visual proof
        // the wipe took effect at the settings layer.
        await ensureExtensionsDrawerOpen(page);
        await ensureInlineDrawerOpen(page, 'orchestrator_settings');
        await page.screenshot({
            path: screenshotPath('refresh-defaults', '1-wiped'),
            fullPage: false,
        });

        // ── 3. Run the refresh. Import the director-defaults module from
        //      inside the page, build the canonical default profile, then
        //      merge the skills.visible fields back onto the live settings. ─
        const refreshResult = await page.evaluate(async () => {
            const mod = await import('/scripts/extensions/orchestrator/director-defaults.js');
            const fresh = mod.createDefaultDirectorProfile();
            const settings = window.extension_settings.luker_orchestrator;
            const dir = settings.directorProfile;

            // Apply only the skill blocks — leave the rest of the user's
            // profile untouched (system prompt, sub-agent ids, limits). This
            // mirrors what a "Refresh director defaults from bundled" button
            // would do: rebuild the skill-shape, preserve user authoring.
            if (!dir.skills) dir.skills = { visible: [], deny: [] };
            dir.skills.visible = [...(fresh.skills?.visible || [])];
            dir.skills.deny = [...(fresh.skills?.deny || [])];

            if (!dir.mainAgent) dir.mainAgent = {};
            if (!dir.mainAgent.skills) dir.mainAgent.skills = { visible: [] };
            dir.mainAgent.skills.visible = [...(fresh.mainAgent?.skills?.visible || [])];

            // Sub-agents: zip by id so user-renamed agents still get a
            // visible-list refresh if the id matches; agents the user added
            // (no match in default) are left alone.
            const freshById = new Map();
            for (const a of (fresh.subAgents || [])) {
                if (a && a.id) freshById.set(String(a.id), a);
            }
            if (Array.isArray(dir.subAgents)) {
                for (const agent of dir.subAgents) {
                    if (!agent?.id) continue;
                    const counterpart = freshById.get(String(agent.id));
                    if (counterpart && counterpart.skills?.visible) {
                        if (!agent.skills) agent.skills = { visible: [] };
                        agent.skills.visible = [...counterpart.skills.visible];
                    }
                }
            }

            if (typeof window.saveSettingsDebounced === 'function') {
                window.saveSettingsDebounced();
            }
            return {
                modeVisibleCount: fresh.skills?.visible?.length || 0,
                mainVisibleCount: fresh.mainAgent?.skills?.visible?.length || 0,
                subAgentCount: (fresh.subAgents || []).length,
            };
        });
        // eslint-disable-next-line no-console
        console.log('[refresh-defaults] freshly-built profile shape:', refreshResult);

        // ── 4. Assert the refreshed shape matches the documented contract ─
        const refreshed = await readDirectorVisibleShape(page);

        expect(refreshed.modeVisible, 'mode visible matches the 5-name baseline')
            .toEqual(EXPECTED_MODE_VISIBLE);
        expect(refreshed.mainVisible, 'main visible carries inherit + workflow + dispatch')
            .toEqual(EXPECTED_MAIN_VISIBLE);
        // Every sub-agent that had its visible list refreshed must start
        // with the `+` inherit sentinel and carry at least one method skill
        // name. We allow user-added sub-agents (id not in default) to remain
        // empty — they were preserved per the merge policy in step 3.
        for (const s of refreshed.subVisible) {
            if (s.visible.length === 0) continue; // user-added agent
            expect(s.visible[0], `sub-agent ${s.id} starts with inherit sentinel`).toBe('+');
            expect(s.visible.length, `sub-agent ${s.id} has at least inherit + 1 skill`).toBeGreaterThanOrEqual(2);
        }

        await page.screenshot({
            path: screenshotPath('refresh-defaults', '2-refreshed'),
            fullPage: false,
        });

        // ── 5. Restore the original profile so the spec leaves no diff. ──
        await page.evaluate((original) => {
            const settings = window.extension_settings.luker_orchestrator;
            settings.directorProfile = structuredClone(original);
            if (typeof window.saveSettingsDebounced === 'function') {
                window.saveSettingsDebounced();
            }
        }, snapshot);
    });
});

/**
 * Read mode-level + main + per-sub-agent `skills.visible` arrays from the
 * live director profile. Used in both wipe and post-refresh assertions.
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<{modeVisible: string[], mainVisible: string[], subVisible: Array<{id: string, visible: string[]}>}>}
 */
async function readDirectorVisibleShape(page) {
    return await page.evaluate(() => {
        const settings = window.extension_settings?.luker_orchestrator;
        const dir = settings?.directorProfile || {};
        const modeVisible = Array.isArray(dir?.skills?.visible) ? [...dir.skills.visible] : [];
        const mainVisible = Array.isArray(dir?.mainAgent?.skills?.visible)
            ? [...dir.mainAgent.skills.visible]
            : [];
        const subVisible = [];
        if (Array.isArray(dir?.subAgents)) {
            for (const agent of dir.subAgents) {
                if (!agent?.id) continue;
                subVisible.push({
                    id: String(agent.id),
                    visible: Array.isArray(agent?.skills?.visible) ? [...agent.skills.visible] : [],
                });
            }
        }
        return { modeVisible, mainVisible, subVisible };
    });
}
