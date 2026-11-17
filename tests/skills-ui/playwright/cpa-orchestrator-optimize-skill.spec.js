/**
 * Unified Workbench (`ws: preset`, orchestrator-optimize mode) — Skills tool wiring e2e.
 */

import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
    REPO_ROOT,
    SCREENSHOTS_DIR,
    awaitMainUI,
    ensureSkillsApiAvailable,
    ensureExtensionsDrawerOpen,
    ensureInlineDrawerOpen,
    activateConnectionProfile,
    startNewWorkbenchIterateSession,
    sendWorkbenchIteratePrompt,
    applyPendingWorkbenchChanges,
    closeWorkbenchWindow,
    takeDocScreenshot,
} from './helpers.js';

const SKILL_NAME = 'preset-style-anti-meta-zh';
const SKILL_SENTINEL_LINE = '禁止把场景外的视角解释塞回叙事，比如 "正如你所知 X 是 Y"。';
const SKILLS_ROOT = path.join(REPO_ROOT, 'data', 'default-user', 'skills');

const USER_PROMPT = `请帮我把这条反 meta 写作纪律抽成一个 skill，让以后用这份预设的所有 agent 都能读到。

名字 (skill name): ${SKILL_NAME}
作用域 (scope): 直接用 preset 作用域，绑这份预设。当前预设名是什么就用什么，不用换名字、不用改成 ASCII —— skill API 内部会处理 URL 编码，CJK 预设名完全没问题。

内容（原文照搬，不许压缩、不许改措辞、不许换字）：

${SKILL_SENTINEL_LINE}
进一步禁止："众所周知"、"作为一个 NPC"、"在这段剧情里"、"按设定" 这类元叙述。
角色发言只允许说他/她在场景里会说的话。
旁白只允许写场景里能被五感感知的事实。
任何破墙意识、跳出角色谈架构、向读者解释设定的写法都视为出戏。

请直接调用 skill_create 落地，别再追问。写完用一句话简短确认。`;

function stepPath(idx, slug) {
    return path.join(SCREENSHOTS_DIR, `cpa-orch-${String(idx).padStart(2, '0')}-${slug}.png`);
}

async function findSkillOnDisk(skillName) {
    const presetRoot = path.join(SKILLS_ROOT, 'preset');
    try {
        const apis = await fs.readdir(presetRoot);
        for (const apiId of apis) {
            const apiDir = path.join(presetRoot, apiId);
            const presetNames = await fs.readdir(apiDir).catch(() => []);
            for (const presetName of presetNames) {
                const candidate = path.join(apiDir, presetName, skillName, 'SKILL.md');
                try {
                    await fs.stat(candidate);
                    return { file: candidate, scope: { kind: 'preset', apiId, name: presetName } };
                } catch { /* not here */ }
            }
        }
    } catch { /* no preset dir yet */ }
    const globalCandidate = path.join(SKILLS_ROOT, 'global', skillName, 'SKILL.md');
    try {
        await fs.stat(globalCandidate);
        return { file: globalCandidate, scope: { kind: 'global' } };
    } catch { /* not here */ }
    return null;
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

test.describe('Skills Workbench preset target: orchestrator-optimize authors preset skill', () => {
    test.setTimeout(600_000);

    test.beforeAll(async () => {
        await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
        for (let i = 0; i < 3; i++) {
            const existing = await findSkillOnDisk(SKILL_NAME);
            if (!existing) break;
            await fs.rm(path.dirname(existing.file), { recursive: true, force: true }).catch(() => {});
        }
    });

    test('user opens Preset AI via bridge, switches mode to orchestrator-optimize; skill_create lands at preset scope', async ({ page }) => {
        await awaitMainUI(page);
        await ensureSkillsApiAvailable(page);

        await page.locator('#sys-settings-button .drawer-toggle').first().click();
        await page.locator('#rm_api_block').waitFor({ state: 'visible', timeout: 5000 });
        const profile = await activateConnectionProfile(page);
        expect(profile, 'CPA live LLM spec needs a usable connection profile').toBeTruthy();
        await page.waitForFunction(() => {
            const ctx = window.Luker?.getContext?.();
            const v = ctx?.onlineStatus ?? null;
            return Boolean(v) && String(v) !== 'no_connection';
        }, null, { timeout: 30000 });
        await page.locator('#sys-settings-button .drawer-toggle').first().click();
        await page.locator('#rm_api_block').waitFor({ state: 'hidden', timeout: 5000 });

        let presetMeta = await page.evaluate(() => {
            const ctx = window.Luker?.getContext?.();
            const ref = ctx?.presets?.getSelected?.('openai');
            const list = (ctx?.presets?.list?.('openai') || []).map(p => String(p?.name || ''));
            return { name: String(ref?.name || ''), all: list };
        });
        expect(presetMeta.name, 'CPA spec needs an active openai preset').toBeTruthy();
        if (!SAFE_SEGMENT.test(presetMeta.name)) {
            const candidate = presetMeta.all.find(n => SAFE_SEGMENT.test(n));
            expect(candidate, `need at least one ASCII-safe preset; got: ${JSON.stringify(presetMeta.all)}`).toBeTruthy();
            await page.evaluate((name) => {
                const dropdown = document.querySelector('#settings_preset_openai');
                if (!dropdown) throw new Error('#settings_preset_openai not found');
                const opt = Array.from(dropdown.options).find(o => o.textContent === name);
                if (!opt) throw new Error(`option for preset "${name}" not in dropdown`);
                window.jQuery?.(dropdown).val(opt.value).trigger('change');
            }, candidate);
            await page.waitForFunction((wantName) => {
                const ctx = window.Luker?.getContext?.();
                const ref = ctx?.presets?.getSelected?.('openai');
                return ref && String(ref.name || '') === wantName;
            }, candidate, { timeout: 10000 });
            presetMeta = { name: candidate };
        }
        expect(SAFE_SEGMENT.test(presetMeta.name)).toBe(true);

        await takeDocScreenshot(page, stepPath(1, 'main-ui-ready'), { fullPage: false });

        // Open Extensions drawer -> CPA panel -> Open Assistant (bridge opens Workbench preset workspace).
        await ensureExtensionsDrawerOpen(page);
        await ensureInlineDrawerOpen(page, 'completion_preset_assistant_settings');
        await takeDocScreenshot(page, stepPath(2, 'cpa-settings-open'), { fullPage: false });

        const openBtn = page.locator('#completion_preset_assistant_open').first();
        await openBtn.waitFor({ state: 'visible', timeout: 10000 });
        await openBtn.click();

        const win = page.locator('.wbench .wb-win').first();
        await win.waitFor({ state: 'visible', timeout: 15000 });
        await expect(win.locator('.wb-ws-seg .lw-seg-btn[aria-pressed="true"]').filter({ hasText: /^(Preset|预设|預設)$/i })).toBeVisible({ timeout: 5000 });
        await takeDocScreenshot(page, stepPath(3, 'cpa-popup-opened'), { fullPage: false });

        await startNewWorkbenchIterateSession(page);

        // Switch CPA session mode inside `.wb-target-controls` to `orchestrator-optimize`.
        const modeSelect = win.locator('select[data-wb-preset-control="mode"], select.wb-preset-mode-select').first();
        await modeSelect.waitFor({ state: 'visible', timeout: 5000 });
        await modeSelect.selectOption('orchestrator-optimize');
        await expect(modeSelect).toHaveValue('orchestrator-optimize', { timeout: 5000 });
        await takeDocScreenshot(page, stepPath(4, 'orchestrator-mode-selected'), { fullPage: false });

        await sendWorkbenchIteratePrompt(page, USER_PROMPT);
        await takeDocScreenshot(page, stepPath(5, 'prompt-typed'), { fullPage: false });
        await takeDocScreenshot(page, stepPath(6, 'send-clicked'), { fullPage: false });

        // Wait for AI turn completion and apply pending `.wb-chg.is-pending` change list when surfaced.
        const deadline = Date.now() + 480_000;
        let hit = null;
        while (Date.now() < deadline) {
            const liveBusy = await win.locator('.wb-reads.is-live').isVisible().catch(() => false);
            if (!liveBusy) {
                await applyPendingWorkbenchChanges(page).catch(() => false);
            }
            hit = await findSkillOnDisk(SKILL_NAME);
            if (hit) break;
            await new Promise(r => setTimeout(r, 3000));
        }
        await takeDocScreenshot(page, stepPath(7, 'after-llm-round'), { fullPage: false });
        expect(hit, `skill_create should have landed ${SKILL_NAME}/SKILL.md on disk within 8 minutes`).toBeTruthy();

        expect(hit.scope.kind, `skill should default to preset scope when iterating a preset; saw scope=${JSON.stringify(hit.scope)}`).toBe('preset');
        expect(hit.scope.name, `skill should land under active preset "${presetMeta.name}"; saw "${hit.scope.name}"`).toBe(presetMeta.name);

        const body = await fs.readFile(hit.file, 'utf8');
        expect(body.startsWith('---\n'), 'skill body should start with YAML frontmatter').toBe(true);
        expect(body, 'skill body should declare expected name').toContain(`name: ${SKILL_NAME}`);
        expect(body, 'skill body should preserve the verbatim sentinel rule without rewording').toContain(SKILL_SENTINEL_LINE);
        expect(body, 'skill body should preserve secondary rules').toContain('元叙述');

        const apiSeen = await page.evaluate(async ({ name, presetName }) => {
            const ctx = window.Luker.getContext();
            const list = await ctx.skills.list({ scope: { kind: 'preset', name: presetName } });
            return (list || []).some(s => s.name === name);
        }, { name: SKILL_NAME, presetName: presetMeta.name });
        expect(apiSeen, 'skill must be returned by context.skills.list for preset scope').toBe(true);

        await takeDocScreenshot(page, stepPath(8, 'skill-on-disk-verified'), { fullPage: false });
        await closeWorkbenchWindow(page);
    });
});
