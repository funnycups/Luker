/**
 * Shared helpers for the skills-UI Playwright smoke specs.
 *
 * Suite-wide conventions:
 *   - Tests rely on a running Luker dev server. The Playwright config
 *     resolves `PLAYWRIGHT_BASE_URL` (defaulting to 127.0.0.1:8000); if
 *     no server responds, Playwright surfaces a connection error
 *     immediately rather than masking the failure.
 *   - All screenshots are saved under `docs/public/images/skills/`
 *     (created on demand) when `LUKER_UPDATE_DOC_SCREENSHOTS=1`.
 *   - Workbench / Orchestra Lens / CPA / Shared Run Dock interactions drive
 *     real DOM controls (`.wb-pill`, `.wb-win`, `.wb-rail`, `.wb-ws-seg`,
 *     `.olens.ol-lens`, `.rpdock.rp-dock`).
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
export const SCREENSHOTS_DIR = path.join(REPO_ROOT, 'docs', 'public', 'images', 'skills');

/**
 * Compose a stable screenshot path under docs/public/images/skills/.
 *
 * @param {string} scenario
 * @param {string} step
 * @returns {string} absolute path
 */
export function screenshotPath(scenario, step) {
    const safeScenario = String(scenario).replace(/[^A-Za-z0-9_-]+/g, '-');
    const safeStep = String(step).replace(/[^A-Za-z0-9_-]+/g, '-');
    return path.join(SCREENSHOTS_DIR, `${safeScenario}-${safeStep}.png`);
}

export const DOC_SCREENSHOTS_ENABLED = !!process.env.LUKER_UPDATE_DOC_SCREENSHOTS;

/**
 * Screenshot a Playwright Page or Locator into a docs path when explicitly enabled.
 *
 * @param {import('@playwright/test').Page | import('@playwright/test').Locator} target
 * @param {string} filePath
 * @param {object} [options]
 * @returns {Promise<string|null>}
 */
export async function takeDocScreenshot(target, filePath, options = {}) {
    if (!DOC_SCREENSHOTS_ENABLED) return null;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await target.screenshot({ path: filePath, ...options });
    return filePath;
}

/**
 * Wait for the main Luker UI to be interactive.
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
        // auto-login or no userList
    }
    await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 0 });
}

/**
 * Open the right-side extensions drawer if it isn't already open.
 *
 * @param {import('@playwright/test').Page} page
 */
export async function ensureExtensionsDrawerOpen(page) {
    const block = page.locator('#rm_extensions_block');
    const isOpen = await block.evaluate(el => el && !el.classList.contains('closedDrawer')).catch(() => false);
    if (isOpen) return;
    const toggle = page.locator('#extensions-settings-button .drawer-toggle').first();
    await toggle.waitFor({ state: 'attached', timeout: 5000 });
    await toggle.dispatchEvent('click');
    await block.waitFor({ state: 'visible', timeout: 5000 });
}

/**
 * Expand a plugin inline drawer inside extensions settings if hidden.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} hostId
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
            return window.getComputedStyle(el).display === 'none';
        }
        return false;
    }).catch(() => true);
    if (!isHidden) return;
    await drawer.locator('> .inline-drawer-toggle').first().click();
    await content.waitFor({ state: 'visible', timeout: 5000 });
}

/**
 * Open Unified Workbench window via `.wb-pill` (falls back to `Alt+w`).
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<import('@playwright/test').Locator>}
 */
export async function openWorkbenchWindow(page) {
    const win = page.locator('.wbench .wb-win').first();
    if (!(await win.isVisible().catch(() => false))) {
        const pill = page.locator('.wbench > button.wb-pill').first();
        if (await pill.isVisible().catch(() => false)) {
            await pill.click();
        } else {
            await page.keyboard.press('Alt+w');
        }
        await win.waitFor({ state: 'visible', timeout: 15_000 });
    }
    return win;
}

/**
 * Close Unified Workbench window if visible.
 *
 * @param {import('@playwright/test').Page} page
 */
export async function closeWorkbenchWindow(page) {
    const win = page.locator('.wbench .wb-win').first();
    if (!(await win.isVisible().catch(() => false))) return;
    const closeBtn = win.locator('.wb-titlebar .is-close').first();
    if (await closeBtn.isVisible().catch(() => false)) {
        await closeBtn.click();
    } else {
        await page.keyboard.press('Alt+w');
    }
    await win.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
}

/**
 * Switch Unified Workbench rail tab by text matcher.
 *
 * @param {import('@playwright/test').Page} page
 * @param {RegExp} tabMatcher
 * @returns {Promise<import('@playwright/test').Locator>}
 */
export async function openWorkbenchRailTab(page, tabMatcher) {
    const win = await openWorkbenchWindow(page);
    const tab = win.locator('.wb-rail button.wb-tab').filter({ hasText: tabMatcher }).first();
    await expect(tab).toBeVisible({ timeout: 10_000 });
    await tab.click();
    return win;
}

/**
 * Open Workbench -> Orchestration workspace (`.olens.ol-lens`) and optionally switch view.
 *
 * @param {import('@playwright/test').Page} page
 * @param {RegExp} [viewMatcher]
 * @returns {Promise<import('@playwright/test').Locator>}
 */
export async function openWorkbenchOrchView(page, viewMatcher) {
    const win = await openWorkbenchRailTab(page, /Orchestration|编排/i);
    const lens = win.locator('.olens.ol-lens').first();
    await expect(lens).toBeVisible({ timeout: 15_000 });
    if (viewMatcher) {
        const btn = lens.locator('.ol-viewswitch .lw-seg-btn').filter({ hasText: viewMatcher }).first();
        await expect(btn).toBeVisible({ timeout: 10_000 });
        await btn.click();
    }
    return lens;
}

/**
 * Switch orchestrator execution mode inside Workbench Orchestration workspace.
 *
 * @param {import('@playwright/test').Page} page
 * @param {RegExp} modeLabelMatcher
 */
export async function setWorkbenchOrchMode(page, modeLabelMatcher) {
    const lens = await openWorkbenchOrchView(page);
    const modeBtn = lens.locator('.ol-modebtn:visible').first();
    await expect(modeBtn).toBeVisible({ timeout: 10_000 });
    await modeBtn.click();
    const item = lens.locator('.ol-menu:visible [role="menuitemradio"]').filter({ has: page.locator('.ol-menu-title', { hasText: modeLabelMatcher }) }).first();
    await expect(item).toBeVisible({ timeout: 10_000 });
    await item.click();
    return lens;
}

/**
 * Toggle orchestrator enable switch inside Workbench Orchestration workspace.
 *
 * @param {import('@playwright/test').Page} page
 * @param {boolean} desired
 */
export async function setWorkbenchOrchEnabled(page, desired) {
    const lens = await openWorkbenchOrchView(page);
    const sw = lens.locator('.ol-enable button[role="switch"]:visible').first();
    await expect(sw).toBeVisible({ timeout: 10_000 });
    const checked = (await sw.getAttribute('aria-checked')) === 'true';
    if (checked !== Boolean(desired)) {
        await sw.click();
        await expect(sw).toHaveAttribute('aria-checked', String(Boolean(desired)), { timeout: 5000 });
    }
    return sw;
}

/**
 * Save pending changes inside Orchestra Lens `.ol-savebar` if visible.
 *
 * @param {import('@playwright/test').Page} page
 */
export async function saveWorkbenchOrchDraftIfVisible(page) {
    const lens = page.locator('.wbench .olens.ol-lens').first();
    const saveBar = lens.locator('.ol-savebar').first();
    if (await saveBar.isVisible().catch(() => false)) {
        const sheetOpen = await lens.evaluate(el => el.classList.contains('is-compact') && el.classList.contains('sheet-open')).catch(() => false);
        if (sheetOpen) {
            await lens.locator('.ol-scrim').click({ force: true }).catch(() => {});
        }
        const saveBtn = saveBar.locator('button').filter({ hasText: /^(Save|保存)$/i }).first();
        if (await saveBtn.isVisible().catch(() => false)) {
            await saveBtn.click();
            await expect(saveBar).toBeHidden({ timeout: 10_000 });
        }
    }
}

/**
 * Open Workbench AI Iteration page and switch to the given target dot class
 * (`wb-t-preset`, `wb-t-card`, `wb-t-world`, `wb-t-memory`, `wb-t-orch`).
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} [wsDotClass]
 * @returns {Promise<import('@playwright/test').Locator>}
 */
export async function openWorkbenchIterateTarget(page, wsDotClass = '') {
    const win = await openWorkbenchRailTab(page, /AI iteration|AI 迭代/i);
    const TARGET_RX = {
        preset: /^(Preset|预设|預設)$/i,
        'wb-t-preset': /^(Preset|预设|預設)$/i,
        card: /^(Character card|角色卡)$/i,
        'wb-t-card': /^(Character card|角色卡)$/i,
        world: /^(World book|世界书|世界書)$/i,
        'wb-t-world': /^(World book|世界书|世界書)$/i,
        memory: /^(Memory graph|记忆图|記憶圖)$/i,
        'wb-t-memory': /^(Memory graph|记忆图|記憶圖)$/i,
        orch: /^(Orchestration|编排|編排)$/i,
        'wb-t-orch': /^(Orchestration|编排|編排)$/i,
    };
    if (wsDotClass) {
        const btn = win.locator('.wb-ws-seg button.lw-seg-btn').filter({
            hasText: TARGET_RX[wsDotClass],
        }).first();
        await expect(btn).toBeVisible({ timeout: 10_000 });
        await btn.click();
        await expect(btn).toHaveAttribute('aria-pressed', 'true', { timeout: 5000 });
    }
    return win;
}

/**
 * Start a fresh AI Iteration session in Workbench (`New conversation`).
 *
 * @param {import('@playwright/test').Page} page
 */
export async function startNewWorkbenchIterateSession(page) {
    const win = page.locator('.wbench .wb-win').first();
    const sess = win.locator('aside.wb-sess').first();
    if (!(await sess.isVisible().catch(() => false))) {
        const toggle = win.locator('.wb-chat-head button.wb-src-toggle').first();
        if (await toggle.isVisible().catch(() => false)) {
            await toggle.click();
        }
    }
    const newBtn = sess.locator('.wb-sess-head button').filter({
        hasText: /New conversation|新建对话|新对话/i,
    }).first();
    await expect(newBtn).toBeVisible({ timeout: 10_000 });
    if (await newBtn.isEnabled().catch(() => false)) {
        await newBtn.click();
    }
}

/**
 * Type prompt into Workbench AI Iteration composer and send it.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} prompt
 */
export async function sendWorkbenchIteratePrompt(page, prompt) {
    const win = page.locator('.wbench .wb-win').first();
    const input = win.locator('.wb-composer textarea.wb-input').first();
    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.fill(prompt);
    const sendBtn = win.locator('.wb-composer button.wb-send').first();
    await expect(sendBtn).toBeEnabled({ timeout: 10_000 });
    await sendBtn.click();
}

/**
 * Apply pending change cards in Workbench AI Iteration if `.wb-chg.is-pending` appears.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{ timeout?: number }} [opts]
 * @returns {Promise<boolean>} true if a pending card was applied
 */
export async function applyPendingWorkbenchChanges(page, opts = {}) {
    const win = page.locator('.wbench .wb-win').first();
    const pending = win.locator('.wb-chg.is-pending').last();
    if (!(await pending.isVisible().catch(() => false))) return false;
    const applyBtn = pending.locator('.wb-chg-foot button.is-primary').first();
    await expect(applyBtn).toBeEnabled({ timeout: opts.timeout ?? 10_000 });
    await applyBtn.click();
    await expect.poll(async () => {
        const cls = (await pending.getAttribute('class')) || '';
        return /\bis-(applied|partial)\b/.test(cls);
    }, { timeout: opts.timeout ?? 25_000 }).toBe(true);
    return true;
}

/**
 * Open Workbench -> Orchestration -> Setup view -> Manage skills panel.
 *
 * @param {import('@playwright/test').Page} page
 */
export async function openSkillManagerPanel(page) {
    await awaitMainUI(page);
    const lens = await openWorkbenchOrchView(page, /^(Setup|准备阶段|準備階段|配置)$/i);
    const openBtn = lens.locator('.ol-setup-bar button').filter({
        hasText: /Manage skills|管理技能/i,
    }).first();
    await expect(openBtn).toBeVisible({ timeout: 10_000 });
    await openBtn.click();

    const popup = page.locator('.popup .luker_skill_manager').first();
    await popup.waitFor({ state: 'visible', timeout: 10_000 });
    return popup;
}

/**
 * Hard-assert the dev server exposes the JS skills API on the context.
 *
 * @param {import('@playwright/test').Page} page
 */
export async function ensureSkillsApiAvailable(page) {
    const hasApi = await page.evaluate(() => {
        const ctx = window.Luker?.getContext?.();
        return Boolean(ctx?.skills && typeof ctx.skills.list === 'function');
    });
    expect(hasApi, 'context.skills API must be exposed by the dev server under test').toBe(true);
}

/**
 * Activate a real connection profile if one is configured. Returns the
 * profile name on success or '' when none usable.
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<string>}
 */
export async function activateConnectionProfile(page) {
    const hasAnyProfile = await page.evaluate(() => {
        const ctx = window.Luker?.getContext?.();
        const profiles = ctx?.extensionSettings?.connectionManager?.profiles;
        return Array.isArray(profiles) && profiles.length > 0;
    }).catch(() => false);
    if (!hasAnyProfile) return '';

    try {
        await page.waitForFunction(
            () => Boolean(document.getElementById('connection_profiles')?.options?.length),
            { timeout: 30000 },
        );
    } catch {
        // fallback below
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
 * Ensure a character card is loaded.
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
            const tile = document.querySelector('#rm_print_characters_block [chid][bogus_folder=\'false\']')
                || document.querySelector('#rm_print_characters_block [chid]');
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
 * Read the avatar id of the currently-loaded character.
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
 *
 * @param {import('@playwright/test').Page} page
 */
export async function ensureDirectorProfileInitialized(page) {
    await page.waitForFunction(() => {
        const ctx = window.Luker?.getContext?.();
        const settings = ctx?.extensionSettings?.orchestrator;
        return Boolean(settings && typeof settings === 'object');
    }, null, { timeout: 30000 });
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
            throw new Error(`ensureDirectorProfileInitialized: failed to load director-defaults (${e.message})`);
        }
    });
}

/**
 * Build a synthetic inline-files-v1 embed payload for a single SKILL.md.
 */
export function buildSyntheticEmbed({ name, description, bodyTail = '' }) {
    if (!name) throw new Error('buildSyntheticEmbed: name is required');
    if (!description) throw new Error('buildSyntheticEmbed: description is required');
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
 * Delete a skill by name from a given scope via HTTP API (best-effort).
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
