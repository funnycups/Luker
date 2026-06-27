/**
 * Iter-studio creates an RP-real skill via LLM.
 *
 * LLM cost: ~$0.2-0.5 per run (single iter-studio LLM round).
 * Requires: dev server running + LLM API configured (online_status !=
 *           'no_connection') + claude-style connection profile.
 *
 * Scope:
 *   - Open the orchestration iteration workbench (iter-studio popup),
 *     which lets the user iterate on the active orchestrator profile via
 *     LLM tool-calls — including authoring brand-new skills via the
 *     skill_create tool.
 *   - The user types a prompt asking the LLM to author a skill describing
 *     RP slow-burn intimacy pacing discipline (matching the bundled
 *     scaffold register).
 *   - The LLM should call skill_create with the requested name/scope/body.
 *   - Validate the skill landed on disk and is visible to the skill API.
 *
 * Why this matters:
 *   The other LLM spec (rp-demo-manual-flow) shows the human authoring
 *   path. This spec shows the LLM-authored path that iter-studio was
 *   designed for from the start: the user describes what they want, the
 *   LLM writes the SKILL.md, and the result installs into the chosen
 *   scope as a normal skill — discoverable by all the same APIs.
 *
 * Failure-mode policy:
 *   - The LLM may need a clarifying back-and-forth, but the prompt is
 *     specific enough that one shot should suffice. We give it up to
 *     8 minutes to finish.
 *   - If the LLM produces a SKILL.md whose body is shorter than 1KB
 *     or missing YAML frontmatter, that's a failure of either the prompt
 *     or the model — surface it.
 *
 * Screenshots: docs/public/_screenshots/skills/iter-studio-NN-*.png.
 */

import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
    SCREENSHOTS_DIR,
    awaitMainUI,
    ensureSkillsApiAvailable,
    ensureExtensionsDrawerOpen,
    ensureInlineDrawerOpen,
    ensureDirectorProfileInitialized,
    activateConnectionProfile,
    ensureCharacterLoaded,
} from './helpers.js';

const SKILL_NAME = 'slowburn-intimacy-zh';
const SKILL_DISK_PATH = path.resolve(
    '/Users/funnycups/worktree/luker-skills-foundation',
    'data/default-user/skills/global',
    SKILL_NAME,
    'SKILL.md',
);

// The actual user prompt to iter-studio. RP-immersive — describes a real
// craft skill the LLM should author, not a synthetic detection test.
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

test.describe('Skills iter-studio: LLM authors a real RP-discipline skill', () => {
    // The iter-studio LLM round + skill_create execution typically lands in
    // 60-180 seconds, but allow up to 8 minutes to absorb provider slowness.
    test.setTimeout(600_000);

    test.beforeAll(async () => {
        await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
        // Pre-cleanup: if a prior run left the skill on disk, wipe it so we
        // assert on a fresh creation rather than a no-op overwrite.
        await fs.rm(path.dirname(SKILL_DISK_PATH), { recursive: true, force: true }).catch(() => {});
    });

    test('user opens iter-studio, asks LLM to author slowburn-intimacy-zh; skill_create fires and skill lands on disk', async ({ page }) => {
        // ── Setup ───────────────────────────────────────────────────────
        await awaitMainUI(page);
        await ensureSkillsApiAvailable(page);
        await ensureDirectorProfileInitialized(page);

        // Connection profile activation (claude).
        await page.locator('#sys-settings-button .drawer-toggle').first().click();
        await page.locator('#rm_api_block').waitFor({ state: 'visible', timeout: 5000 });
        const activatedProfile = await activateConnectionProfile(page);
        expect(activatedProfile, 'iter-studio LLM spec needs a usable connection profile').toBeTruthy();
        await page.waitForFunction(() => {
            const ctx = window.Luker?.getContext?.();
            const v = ctx?.onlineStatus ?? null;
            return Boolean(v) && String(v) !== 'no_connection';
        }, null, { timeout: 30000 });
        // Close API drawer.
        await page.locator('#sys-settings-button .drawer-toggle').first().click();
        await page.locator('#rm_api_block').waitFor({ state: 'hidden', timeout: 5000 });

        // Load Seraphina (any character works; iter-studio doesn't require one
        // but the orchestrator extension surfaces are calmer with an active
        // character in the workspace).
        const loadedAvatar = await ensureCharacterLoaded(page);
        expect(loadedAvatar, 'iter-studio spec needs a character loaded').toBeTruthy();

        await page.screenshot({ path: stepPath(1, 'main-ui-ready'), fullPage: false });

        // ── Step 2: open the Extensions drawer + Orchestrator settings,
        //   click "Open AI Iteration Studio" (visible only in director-mode
        //   templates; surface the matching one in the active mode block).
        await ensureExtensionsDrawerOpen(page);
        await ensureInlineDrawerOpen(page, 'orchestrator_settings');
        const openIterBtn = page.locator(
            '#orchestrator_settings [data-luker-action="ai-iterate-open"]:visible',
        ).first();
        await openIterBtn.waitFor({ state: 'visible', timeout: 10000 });
        await openIterBtn.click();

        // The iter-studio popup uses orch_it_${ts}_${rand} as id and
        // .orch_it_popup as class.
        const iterPopup = page.locator('dialog.popup:has(.orch_it_popup)').first();
        await iterPopup.waitFor({ state: 'visible', timeout: 10000 });
        await page.waitForFunction(() => {
            const d = document.querySelector('dialog.popup:has(.orch_it_popup)');
            return d && d.hasAttribute('open') && !d.hasAttribute('opening');
        }, null, { timeout: 5000 });
        await page.screenshot({ path: stepPath(2, 'iter-studio-opened'), fullPage: false });

        // ── Step 3: type the prompt into the composer textarea and send. ─
        const composerInput = iterPopup.locator('textarea[data-orch-it-input]').first();
        await composerInput.waitFor({ state: 'attached', timeout: 5000 });
        // Direct DOM mutation — popup composer textarea may render with
        // 0-size during transitions, and Playwright fill rejects that.
        await composerInput.evaluate((el, v) => {
            el.value = v;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }, USER_PROMPT);
        await page.screenshot({ path: stepPath(3, 'prompt-typed'), fullPage: false });

        const sendBtn = iterPopup.locator('button[data-orch-it-action="send"]').first();
        await sendBtn.dispatchEvent('click');
        await page.screenshot({ path: stepPath(4, 'send-clicked'), fullPage: false });

        // ── Step 4: wait for the LLM round to complete + skill_create to
        //   land on disk. We poll for the file's existence — the most direct
        //   evidence that the tool ran successfully (server-side fs write).
        const deadline = Date.now() + 480_000; // 8 minutes
        let landed = false;
        while (Date.now() < deadline) {
            try {
                await fs.stat(SKILL_DISK_PATH);
                landed = true;
                break;
            } catch {
                await new Promise(r => setTimeout(r, 5000));
            }
        }
        await page.screenshot({ path: stepPath(5, 'after-llm-round'), fullPage: false });
        expect(landed, `skill_create should have written ${SKILL_DISK_PATH} within 8 minutes`).toBe(true);

        // ── Step 5: read the on-disk file and assert it is well-formed. ─
        const body = await fs.readFile(SKILL_DISK_PATH, 'utf8');
        expect(body.length, 'skill body should be at least 1KB').toBeGreaterThan(1024);
        // Frontmatter check.
        expect(body.startsWith('---\n'), 'skill body should start with YAML frontmatter').toBe(true);
        expect(body, 'skill body should declare the expected name').toContain(`name: ${SKILL_NAME}`);
        expect(body, 'skill body should have a description field').toMatch(/description:\s*\S+/);
        // The prompt asked for ## section headers and Self-check.
        const sectionCount = (body.match(/^## /gm) || []).length;
        expect(sectionCount, 'skill body should have multiple ## section headers').toBeGreaterThanOrEqual(2);
        const sawSelfCheck = /self[-\s]?check/i.test(body);
        expect(sawSelfCheck, 'skill body should include a Self-check section').toBe(true);

        // ── Step 6: verify the skill surfaces in the skills API. ────────
        const apiSeen = await page.evaluate(async (name) => {
            const ctx = window.Luker.getContext();
            const all = await ctx.skills.list({ scope: 'all' });
            return (all || []).some(s => s.name === name && s.scope?.kind === 'global');
        }, SKILL_NAME);
        expect(apiSeen, 'skill should be visible in context.skills.list at global scope').toBe(true);

        await page.screenshot({ path: stepPath(6, 'skill-on-disk-verified'), fullPage: false });

        // ── Step 7: close the iter-studio popup. ────────────────────────
        await iterPopup.locator('div.popup-button-ok, div.popup-button-close, .popup-button-cancel').first().dispatchEvent('click');
        await iterPopup.waitFor({ state: 'detached', timeout: 10000 });

        // ── Teardown ────────────────────────────────────────────────────
        // The created skill stays on disk — useful for inspection. Cleanup
        // happens in beforeAll on the next run, so the run is idempotent.
    });
});
