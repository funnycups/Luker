/**
 * Unified Workbench (`ws: orch`) creates an RP-real skill via LLM.
 *
 * LLM cost: ~$0.2-0.5 per run (single Workbench AI iteration round).
 * Requires: dev server running + LLM API configured (online_status !=
 *           'no_connection') + claude-style connection profile.
 */

import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
    REPO_ROOT,
    SCREENSHOTS_DIR,
    awaitMainUI,
    ensureSkillsApiAvailable,
    ensureDirectorProfileInitialized,
    activateConnectionProfile,
    ensureCharacterLoaded,
    openWorkbenchIterateTarget,
    startNewWorkbenchIterateSession,
    sendWorkbenchIteratePrompt,
    applyPendingWorkbenchChanges,
    closeWorkbenchWindow,
    takeDocScreenshot,
} from './helpers.js';

const SKILL_NAME = 'slowburn-intimacy-zh';
const SKILL_DISK_PATH = path.join(REPO_ROOT, 'data', 'default-user', 'skills', 'global', SKILL_NAME, 'SKILL.md');

const USER_PROMPT = `请生成一个真实可用的 RP 写作纪律 skill。

名字 (skill name): ${SKILL_NAME}
scope: global
主题：中文 RP 慢热亲密戏的节奏规则

要求：
1. 文风参照已有的 director-character-voice-zh 的 register：双语 CN/EN 列表、## section 头、✗/✓ 例子对照、Self-check 收尾。
2. 内容覆盖：
   - 推进必须先有一个"试图但被打断/挪开"的尝试
   - 触觉细节优先于情绪宣告
   - 不要直接跳到高潮强度
   - 节奏锚点：呼吸距离 / 衣物边缘 / 手温 / 间隔的沉默
   - 对方退避不算 setback，是 baseline
3. 大约 3-4KB
4. 用 skill_create 工具把它创建到 global scope

写完后用一句话简短确认你写了什么。`;

function stepPath(idx, slug) {
    return path.join(SCREENSHOTS_DIR, `iter-studio-${String(idx).padStart(2, '0')}-${slug}.png`);
}

test.describe('Skills Workbench AI iteration: LLM authors a real RP-discipline skill', () => {
    test.setTimeout(600_000);

    test.beforeAll(async () => {
        await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
        await fs.rm(path.dirname(SKILL_DISK_PATH), { recursive: true, force: true }).catch(() => {});
    });

    test('user opens Workbench orch target, asks LLM to author slowburn-intimacy-zh; skill_create lands on disk', async ({ page }) => {
        await awaitMainUI(page);
        await ensureSkillsApiAvailable(page);
        await ensureDirectorProfileInitialized(page);

        await page.locator('#sys-settings-button .drawer-toggle').first().click();
        await page.locator('#rm_api_block').waitFor({ state: 'visible', timeout: 5000 });
        const activatedProfile = await activateConnectionProfile(page);
        expect(activatedProfile, 'iter-studio LLM spec needs a usable connection profile').toBeTruthy();
        await page.waitForFunction(() => {
            const ctx = window.Luker?.getContext?.();
            const v = ctx?.onlineStatus ?? null;
            return Boolean(v) && String(v) !== 'no_connection';
        }, null, { timeout: 30000 });
        await page.locator('#sys-settings-button .drawer-toggle').first().click();
        await page.locator('#rm_api_block').waitFor({ state: 'hidden', timeout: 5000 });

        const loadedAvatar = await ensureCharacterLoaded(page);
        expect(loadedAvatar, 'iter-studio spec needs a character loaded').toBeTruthy();

        await takeDocScreenshot(page, stepPath(1, 'main-ui-ready'), { fullPage: false });

        // Open Unified Workbench -> AI Iteration -> Orchestration target (`wb-t-orch`).
        const win = await openWorkbenchIterateTarget(page, 'wb-t-orch');
        await startNewWorkbenchIterateSession(page);
        await takeDocScreenshot(page, stepPath(2, 'iter-studio-opened'), { fullPage: false });

        await sendWorkbenchIteratePrompt(page, USER_PROMPT);
        await takeDocScreenshot(page, stepPath(3, 'prompt-typed'), { fullPage: false });
        await takeDocScreenshot(page, stepPath(4, 'send-clicked'), { fullPage: false });

        // Wait for turn completion; apply pending `.wb-chg.is-pending` change list if surfaced.
        const deadline = Date.now() + 480_000;
        let landed = false;
        while (Date.now() < deadline) {
            const liveBusy = await win.locator('.wb-reads.is-live').isVisible().catch(() => false);
            if (!liveBusy) {
                await applyPendingWorkbenchChanges(page).catch(() => false);
            }
            try {
                await fs.stat(SKILL_DISK_PATH);
                landed = true;
                break;
            } catch {
                await new Promise(r => setTimeout(r, 3000));
            }
        }
        await takeDocScreenshot(page, stepPath(5, 'after-llm-round'), { fullPage: false });
        expect(landed, `skill_create should have written ${SKILL_DISK_PATH} within 8 minutes`).toBe(true);

        const body = await fs.readFile(SKILL_DISK_PATH, 'utf8');
        expect(body.length, 'skill body should be at least 1KB').toBeGreaterThan(1024);
        expect(body.startsWith('---\n'), 'skill body should start with YAML frontmatter').toBe(true);
        expect(body, 'skill body should declare the expected name').toContain(`name: ${SKILL_NAME}`);
        expect(body, 'skill body should have a description field').toMatch(/description:\s*\S+/);
        const sectionCount = (body.match(/^## /gm) || []).length;
        expect(sectionCount, 'skill body should have multiple ## section headers').toBeGreaterThanOrEqual(2);
        const sawSelfCheck = /self[-\s]?check/i.test(body);
        expect(sawSelfCheck, 'skill body should include a Self-check section').toBe(true);

        const apiSeen = await page.evaluate(async (name) => {
            const ctx = window.Luker.getContext();
            const all = await ctx.skills.list({ scope: 'all' });
            return (all || []).some(s => s.name === name && s.scope?.kind === 'global');
        }, SKILL_NAME);
        expect(apiSeen, 'skill should be visible in context.skills.list at global scope').toBe(true);

        await takeDocScreenshot(page, stepPath(6, 'skill-on-disk-verified'), { fullPage: false });
        await closeWorkbenchWindow(page);
    });
});
