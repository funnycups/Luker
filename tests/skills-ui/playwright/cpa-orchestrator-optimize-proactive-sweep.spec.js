/**
 * Workbench Preset target (`orchestrator-optimize` mode) — PROACTIVE skill extraction sweep e2e.
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
    openWorkbenchRailTab,
    startNewWorkbenchIterateSession,
    sendWorkbenchIteratePrompt,
    applyPendingWorkbenchChanges,
    closeWorkbenchWindow,
    takeDocScreenshot,
} from './helpers.js';

const SKILLS_ROOT = path.join(REPO_ROOT, 'data', 'default-user', 'skills');

const INJECTED_SENTINEL = '【反 meta 纪律 / anti-meta】禁止在叙事里出现"正如读者所知"、"出戏地说"、"这段剧情中"这种破墙旁白。';
const INJECTED_BLOCK = `

## 反 meta 写作纪律

${INJECTED_SENTINEL}
进一步禁止角色对话出现 "众所周知"、"作为 NPC"、"按设定" 这类元叙述。
旁白只允许写场景内能被五感感知的事实；任何向读者解释、跳出角色谈架构、补全设定背景的句子都视为破墙。
违反这条纪律会让长 RP 失去沉浸感，比任何文风错误更致命。
绝对禁止角色直接对读者说话。绝对禁止 narrator 评价角色行为。绝对禁止出现"作者"、"作品"、"故事"这种词。

## 触觉细节先行的语态规则

每一个亲密 / 暴力 / 强情绪场景的第一句都必须是一个具体的、可感知的物理细节 —— 不是情绪宣告，不是状态描述，是 ${'「'}对方的手指停在了她衬衫第三颗扣子上${'」'} 这样的句子。
情绪只能由动作和触感推出，禁止直接命名（"她感到害怕"、"他很愤怒"）。
节奏锚点限定：呼吸距离 / 衣物边缘 / 手温 / 间隔的沉默 —— 任何场景内的张力先用这四类锚点之一落地。

这两段规则是给整个编排团队所有 sub-agent 共用的写作纪律 —— 不是只给主 Agent 的，主评审、口吻评审、连贯性评审都得读到。`;

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

function stepPath(idx, slug) {
    return path.join(SCREENSHOTS_DIR, `cpa-orch-proactive-${String(idx).padStart(2, '0')}-${slug}.png`);
}

async function findSkillsContainingSentinel(sentinel) {
    const results = [];
    async function walkScope(scopeDir, scopeBuilder) {
        let entries = [];
        try { entries = await fs.readdir(scopeDir, { withFileTypes: true }); } catch { return; }
        for (const ent of entries) {
            if (!ent.isDirectory()) continue;
            const skillDir = path.join(scopeDir, ent.name);
            const skillMd = path.join(skillDir, 'SKILL.md');
            try {
                const body = await fs.readFile(skillMd, 'utf8');
                if (body.includes(sentinel)) {
                    results.push({ file: skillMd, scope: scopeBuilder(), name: ent.name, body });
                }
            } catch { /* no SKILL.md */ }
        }
    }
    await walkScope(path.join(SKILLS_ROOT, 'global'), () => ({ kind: 'global' }));
    const presetRoot = path.join(SKILLS_ROOT, 'preset');
    try {
        const apis = await fs.readdir(presetRoot);
        for (const apiId of apis) {
            const names = await fs.readdir(path.join(presetRoot, apiId)).catch(() => []);
            for (const presetName of names) {
                await walkScope(
                    path.join(presetRoot, apiId, presetName),
                    () => ({ kind: 'preset', apiId, name: presetName }),
                );
            }
        }
    } catch { /* no preset dir */ }
    return results;
}

test.describe('Workbench Preset orchestrator-optimize: PROACTIVE skill extraction sweep', () => {
    test.setTimeout(600_000);

    test.beforeAll(async () => {
        await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
        for (const hit of await findSkillsContainingSentinel(INJECTED_SENTINEL)) {
            await fs.rm(path.dirname(hit.file), { recursive: true, force: true }).catch(() => {});
        }
    });

    test('vanilla adapt prompt on preset with extractable block triggers sweep', async ({ page }) => {
        await awaitMainUI(page);
        await ensureSkillsApiAvailable(page);

        await page.locator('#sys-settings-button .drawer-toggle').first().click();
        await page.locator('#rm_api_block').waitFor({ state: 'visible', timeout: 5000 });
        const profile = await activateConnectionProfile(page);
        expect(profile, 'need a usable connection profile').toBeTruthy();
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
        expect(presetMeta.name).toBeTruthy();
        if (!SAFE_SEGMENT.test(presetMeta.name)) {
            const candidate = presetMeta.all.find(n => SAFE_SEGMENT.test(n));
            expect(candidate, `need an ASCII preset; got: ${JSON.stringify(presetMeta.all)}`).toBeTruthy();
            await page.evaluate((n) => {
                const dropdown = document.querySelector('#settings_preset_openai');
                const opt = Array.from(dropdown.options).find(o => o.textContent === n);
                window.jQuery?.(dropdown).val(opt.value).trigger('change');
            }, candidate);
            await page.waitForFunction((n) => {
                const ctx = window.Luker?.getContext?.();
                const ref = ctx?.presets?.getSelected?.('openai');
                return ref && String(ref.name || '') === n;
            }, candidate, { timeout: 10000 });
            presetMeta = { name: candidate };
        }
        expect(SAFE_SEGMENT.test(presetMeta.name)).toBe(true);

        // Verify Preset prompt in Workbench Settings is populated cleanly.
        const settingsWin = await openWorkbenchRailTab(page, /^Settings$|^设置$/i);
        const presetPromptDetails = settingsWin.locator('details.wb-prompt').filter({
            hasText: /Preset|预设/i,
        }).first();
        if (await presetPromptDetails.isVisible().catch(() => false)) {
            await presetPromptDetails.locator('summary').first().click();
            const promptText = (await presetPromptDetails.locator('pre.wb-prompt-text').first().textContent().catch(() => '')) || '';
            expect(promptText.length, 'Workbench Settings Preset prompt summary should be non-empty').toBeGreaterThan(200);
        }
        await takeDocScreenshot(page, stepPath(1, 'mode-prompt-verified-in-settings'), { fullPage: false });
        await closeWorkbenchWindow(page);

        // Inject extractable rule block into active preset fixture.
        const injection = await page.evaluate(async ({ injectBlock, presetName }) => {
            const ctx = window.Luker.getContext();
            const ref = { collection: 'openai', name: presetName };
            const stored = ctx.presets.getStored(ref);
            if (!stored?.body) throw new Error('preset body unavailable');
            const original = structuredClone(stored.body);
            const mutated = structuredClone(stored.body);
            if (!Array.isArray(mutated.prompts)) throw new Error('preset has no prompts[]');
            const targetIdx = mutated.prompts.findIndex(p =>
                p && typeof p.content === 'string' && p.content.trim().length > 50);
            if (targetIdx < 0) throw new Error('no prompts[] entry with substantive content');
            const target = mutated.prompts[targetIdx];
            target.content = `${String(target.content || '').replace(/\s+$/, '')}\n\n${injectBlock}`;
            await ctx.presets.save(ref, mutated, { select: true });
            return {
                originalBody: original,
                targetIdentifier: String(target.identifier || target.id || ''),
                targetIndex: targetIdx,
                originalContentLength: original.prompts?.[targetIdx]?.content?.length || 0,
                mutatedContentLength: target.content.length,
            };
        }, { injectBlock: INJECTED_BLOCK, presetName: presetMeta.name });
        expect(injection.mutatedContentLength).toBeGreaterThan(injection.originalContentLength);
        await takeDocScreenshot(page, stepPath(2, 'injected-block-saved'), { fullPage: false });

        try {
            // Open CPA via Extensions drawer bridge button -> opens Workbench Preset target.
            await ensureExtensionsDrawerOpen(page);
            await ensureInlineDrawerOpen(page, 'completion_preset_assistant_settings');
            const openBtn = page.locator('#completion_preset_assistant_open').first();
            await openBtn.waitFor({ state: 'visible', timeout: 10000 });
            await openBtn.click();

            const win = page.locator('.wbench .wb-win').first();
            await win.waitFor({ state: 'visible', timeout: 15000 });
            await expect(win.locator('.wb-ws-seg .lw-seg-btn[aria-pressed="true"]').filter({ hasText: /^(Preset|预设|預設)$/i })).toBeVisible({ timeout: 5000 });

            await startNewWorkbenchIterateSession(page);

            const modeSelect = win.locator('select[data-wb-preset-control="mode"], select.wb-preset-mode-select').first();
            await modeSelect.selectOption('orchestrator-optimize');
            await expect(modeSelect).toHaveValue('orchestrator-optimize', { timeout: 5000 });
            await takeDocScreenshot(page, stepPath(3, 'mode-selected'), { fullPage: false });

            const VANILLA_PROMPT = '请把这份预设改造成编排器主 Agent 用的预设。按你判断的优先级处理。';
            await sendWorkbenchIteratePrompt(page, VANILLA_PROMPT);
            await takeDocScreenshot(page, stepPath(4, 'vanilla-prompt-typed'), { fullPage: false });
            await takeDocScreenshot(page, stepPath(5, 'send-clicked'), { fullPage: false });

            const deadline = Date.now() + 480_000;
            let matches = [];
            let sweptButFoundNothing = false;
            let lastAssistantText = '';
            while (Date.now() < deadline) {
                const liveBusy = await win.locator('.wb-reads.is-live').isVisible().catch(() => false);
                if (!liveBusy) {
                    await applyPendingWorkbenchChanges(page).catch(() => false);
                }
                matches = await findSkillsContainingSentinel(INJECTED_SENTINEL);
                if (matches.length > 0) break;

                lastAssistantText = await win
                    .locator('.wb-msg-ai').last()
                    .innerText()
                    .catch(() => '');
                const text = String(lastAssistantText || '');
                const englishSwept = /scan(?:ned)?[\s\S]{0,80}?(?:found\s+none|nothing\s+worth|no\s+(?:reusable|extractable)|nothing\s+to\s+(?:extract|lift))/i.test(text)
                    && /skill/i.test(text);
                const chineseSwept = /(?:扫|检查|审视|检视)(?:过|了|描|视)?/.test(text)
                    && (/没(?:有)?(?:找到|看到|发现)|无(?:可|需)抽取|找不到|不(?:需要|必要|值得|建议)抽取/.test(text))
                    && /skill|抽取|抽成|抽出/.test(text);
                if (!liveBusy && (englishSwept || chineseSwept)) {
                    sweptButFoundNothing = true;
                    break;
                }
                await new Promise(r => setTimeout(r, 3000));
            }
            await takeDocScreenshot(page, stepPath(6, 'after-llm-round'), { fullPage: false });

            if (matches.length === 0 && !sweptButFoundNothing) {
                throw new Error(
                    'Proactive sweep produced neither an extraction nor an explicit "scanned, found nothing" line within 8 minutes.\n'
                    + `AI's last assistant message:\n${(lastAssistantText || '(unavailable)').slice(0, 1200)}`,
                );
            }

            if (matches.length > 0) {
                // eslint-disable-next-line no-console
                console.log(
                    `[proactive-sweep] PROACTIVE EXTRACTION FIRED: ${matches.length} skill(s) extracted from vanilla adapt request: `
                    + matches.map(m => `${m.scope.kind}:${m.name}`).join(', '),
                );
                const onPreset = matches.find(m => m.scope.kind === 'preset' && m.scope.name === presetMeta.name);
                expect(onPreset, `extracted skill should land on active preset (${presetMeta.name}); got ${JSON.stringify(matches.map(m => m.scope))}`).toBeTruthy();
                expect(onPreset.body).toContain(INJECTED_SENTINEL);
            } else {
                // eslint-disable-next-line no-console
                console.log(
                    '[proactive-sweep] Model explicitly ran proactive sweep and declined extraction:\n'
                    + lastAssistantText.slice(0, 500),
                );
            }

            await closeWorkbenchWindow(page);
        } finally {
            await page.evaluate(async ({ presetName, originalBody }) => {
                try {
                    const ctx = window.Luker?.getContext?.();
                    if (!ctx?.presets) return;
                    await ctx.presets.save({ collection: 'openai', name: presetName }, originalBody, { select: true });
                } catch { /* best-effort restore */ }
            }, { presetName: presetMeta.name, originalBody: injection.originalBody });
            for (const hit of await findSkillsContainingSentinel(INJECTED_SENTINEL)) {
                await fs.rm(path.dirname(hit.file), { recursive: true, force: true }).catch(() => {});
            }
        }
    });
});
