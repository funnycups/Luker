/**
 * CPA orchestrator-optimize mode — PROACTIVE skill extraction sweep e2e.
 *
 * Verifies the design contract: in orchestrator-optimize mode, an adapt
 * request triggers a skill-extraction sweep ALONGSIDE the usual coercion/
 * format rewrites — without the user having to ask for it explicitly.
 *
 * The contract is documented in
 * `docs/features/preset-assistant.md#authoring-skills-from-preset-content`
 * and implemented across:
 *   - `cpa-iteration/system-prompts.js#buildOrchestratorOptimizeModeBlock`
 *     (category C disposition + decision-tree extension + Approach
 *     checklist step)
 *   - `cpa-iteration/skill-prompt.js#augmentCpaPromptWithSkills` (tail
 *     augmentation with REQUIRED-language sweep instruction + catalog)
 *
 * Setup flow:
 *   1. Login + skills API up.
 *   2. Switch to an ASCII-safe preset so preset-scope paths work
 *      (server-side scope validator rejects CJK segments).
 *   3. Open CPA settings panel + reset the orchestrator-optimize prompt
 *      override to the current code default. This is the load-bearing
 *      step the user explicitly called out: any prior customization to
 *      the iterModePromptOrchestratorOptimize setting would shadow my
 *      updated mode-block content, leaving the AI unaware of the new
 *      category-C disposition. Reset returns the user to the in-code
 *      default so the new prompt actually reaches the model.
 *   4. Inject a known multi-paragraph rule block (two named ## sections
 *      with imperative language) into the first substantive preset entry.
 *   5. Open CPA in orchestrator-optimize mode, vanilla adapt request.
 *
 * Pass criteria (either branch counts):
 *   (a) AI emits skill_create against our block (strong evidence: the
 *       skill file lands on disk with the verbatim sentinel sentence
 *       inside).
 *   (b) AI's text explicitly says "scanned and found nothing extractable"
 *       (diagnostic evidence: instruction reached the model and it
 *       exercised judgment).
 *
 * Failure (test FAILS) only when the AI is silent AND nothing extracted —
 * that means the augmentation didn't shape behavior at all.
 *
 * Teardown:
 *   - Restore preset body to pre-test snapshot (in finally).
 *   - Delete any skill created from our sentinel block.
 *
 * Screenshots: docs/public/_screenshots/skills/cpa-orch-proactive-NN-*.png.
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
    activateConnectionProfile,
} from './helpers.js';

const REPO_ROOT = path.resolve('/Users/funnycups/worktree/luker-skills-foundation');
const SKILLS_ROOT = path.join(REPO_ROOT, 'data/default-user/skills');

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
        try { entries = await fs.readdir(scopeDir, { withFileTypes: true }); }
        catch { return; }
        for (const ent of entries) {
            if (!ent.isDirectory()) continue;
            const skillDir = path.join(scopeDir, ent.name);
            const skillMd = path.join(skillDir, 'SKILL.md');
            try {
                const body = await fs.readFile(skillMd, 'utf8');
                if (body.includes(sentinel)) {
                    results.push({ file: skillMd, name: ent.name, scope: scopeBuilder(ent.name), body });
                }
            } catch { /* not a real skill dir */ }
        }
    }

    await walkScope(path.join(SKILLS_ROOT, 'global'), () => ({ kind: 'global' }));

    const presetRoot = path.join(SKILLS_ROOT, 'preset');
    let apis = [];
    try { apis = await fs.readdir(presetRoot); } catch { /* none */ }
    for (const apiId of apis) {
        const apiDir = path.join(presetRoot, apiId);
        let presets = [];
        try { presets = await fs.readdir(apiDir); } catch { continue; }
        for (const presetName of presets) {
            await walkScope(
                path.join(apiDir, presetName),
                () => ({ kind: 'preset', apiId, name: presetName }),
            );
        }
    }
    return results;
}

test.describe('CPA orchestrator-optimize: proactive skill extraction sweep', () => {
    test.setTimeout(720_000);

    test.beforeAll(async () => {
        await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
        // Aggressive cleanup: remove EVERY skill whose name matches the
        // pattern the AI is likely to pick for this extraction, regardless
        // of body content or scope. Otherwise a stale skill from a prior
        // run (or from cpa-orchestrator-optimize-skill.spec.js, which uses
        // the same naming family) makes the AI rationally say "this skill
        // already exists, no need to extract again" — defeating the test's
        // ability to observe proactive extraction. We match on
        // preset-style-* and on names containing anti-meta / touch-detail
        // (the two sections in our injected block).
        async function purgeMatchingSkills(scopeDir) {
            let entries = [];
            try { entries = await fs.readdir(scopeDir, { withFileTypes: true }); }
            catch { return; }
            for (const ent of entries) {
                if (!ent.isDirectory()) continue;
                const matches = /^preset-style-/.test(ent.name)
                    || /anti-meta/.test(ent.name)
                    || /touch-detail/.test(ent.name);
                if (matches) {
                    await fs.rm(path.join(scopeDir, ent.name), { recursive: true, force: true }).catch(() => {});
                }
            }
        }
        await purgeMatchingSkills(path.join(SKILLS_ROOT, 'global'));
        const presetRoot = path.join(SKILLS_ROOT, 'preset');
        let apis = [];
        try { apis = await fs.readdir(presetRoot); } catch { /* none */ }
        for (const apiId of apis) {
            const apiDir = path.join(presetRoot, apiId);
            let presets = [];
            try { presets = await fs.readdir(apiDir); } catch { continue; }
            for (const presetName of presets) {
                await purgeMatchingSkills(path.join(apiDir, presetName));
            }
        }
        // Also: sweep by sentinel as a belt-and-suspenders check for any
        // odd-named skill that happens to carry our injected content.
        const prior = await findSkillsContainingSentinel(INJECTED_SENTINEL);
        for (const s of prior) {
            await fs.rm(path.dirname(s.file), { recursive: true, force: true }).catch(() => {});
        }
    });

    test('vanilla "adapt for orchestrator" prompt triggers proactive skill extraction OR explicit "scanned, nothing found" reply', async ({ page }) => {
        await awaitMainUI(page);
        await ensureSkillsApiAvailable(page);

        await page.locator('#sys-settings-button .drawer-toggle').first().click();
        await page.locator('#rm_api_block').waitFor({ state: 'visible', timeout: 5000 });
        const activatedProfile = await activateConnectionProfile(page);
        expect(activatedProfile, 'spec needs a usable connection profile').toBeTruthy();
        await page.waitForFunction(() => {
            const ctx = window.SillyTavern?.getContext?.();
            const v = ctx?.onlineStatus ?? null;
            return Boolean(v) && String(v) !== 'no_connection';
        }, null, { timeout: 30000 });
        await page.locator('#sys-settings-button .drawer-toggle').first().click();
        await page.locator('#rm_api_block').waitFor({ state: 'hidden', timeout: 5000 });

        let presetMeta = await page.evaluate(() => {
            const ctx = window.SillyTavern?.getContext?.();
            const ref = ctx?.presets?.getSelected?.('openai');
            return ref && typeof ref === 'object' ? { name: String(ref.name || '') } : null;
        });
        expect(presetMeta?.name).toBeTruthy();

        if (!SAFE_SEGMENT.test(presetMeta.name)) {
            const candidate = await page.evaluate((re) => {
                const ctx = window.SillyTavern?.getContext?.();
                const all = (ctx?.presets?.list?.('openai') || []).map(r => String(r?.name || '')).filter(Boolean);
                const regex = new RegExp(re);
                return all.find(n => regex.test(n)) || '';
            }, SAFE_SEGMENT.source);
            if (!candidate) {
                test.skip(true, 'no ASCII-safe OpenAI preset; cannot test preset-scope sweep without one.');
                return;
            }
            await page.evaluate((name) => {
                const dropdown = document.querySelector('#settings_preset_openai');
                const opt = Array.from(dropdown.options).find(o => o.textContent === name);
                window.jQuery?.(dropdown).val(opt.value).trigger('change');
            }, candidate);
            await page.waitForFunction((n) => {
                const ctx = window.SillyTavern?.getContext?.();
                const ref = ctx?.presets?.getSelected?.('openai');
                return ref && String(ref.name || '') === n;
            }, candidate, { timeout: 10000 });
            presetMeta = { name: candidate };
        }
        expect(SAFE_SEGMENT.test(presetMeta.name)).toBe(true);

        // ── Step 2: open CPA settings panel + RESET orchestrator-optimize
        // mode prompt to the current code default. ─────────────────────
        // Any prior user-customization of iterModePromptOrchestratorOptimize
        // would shadow the new mode-block content (category C disposition,
        // updated decision tree, approach checklist) — the AI would see the
        // OLD prompt and behave per the OLD design (no extraction). Reset
        // restores the default so the new content reaches the model.
        await ensureExtensionsDrawerOpen(page);
        await ensureInlineDrawerOpen(page, 'completion_preset_assistant_settings');
        await page.evaluate(() => {
            const d = document.querySelector('details.cpa_prompt_overrides');
            if (d && !d.hasAttribute('open')) d.setAttribute('open', '');
        });
        // The reset button is bound in main.js via jQuery click handler;
        // dispatchEvent('click') bypasses any overlay hit-testing issues.
        await page.locator('#cpa_reset_iter_mode_orchestrator_optimize')
            .first()
            .dispatchEvent('click');
        // Verify the settings actually carry the in-code default after reset.
        // We compare against the textarea value (which the reset handler
        // syncs to the settings value) — both should now be the freshly-
        // computed buildOrchestratorOptimizeModeBlock() output. A 0-length
        // value would mean the reset didn't fire.
        const resetTextLen = await page.evaluate(() => {
            const el = document.querySelector('#cpa_iter_mode_orchestrator_optimize');
            return el ? String(el.value || '').length : 0;
        });
        expect(resetTextLen, 'mode prompt textarea should have content after reset').toBeGreaterThan(1000);
        // Sanity: the reset-installed default must now contain the new
        // category C disposition we added in system-prompts.js. If it
        // doesn't, the dev server is serving stale JS or the reset wasn't
        // applied to the settings store.
        const resetTextHasCategoryC = await page.evaluate(() => {
            const el = document.querySelector('#cpa_iter_mode_orchestrator_optimize');
            const txt = el ? String(el.value || '') : '';
            return /^C\.\s/m.test(txt) && /skill_create/.test(txt);
        });
        expect(resetTextHasCategoryC, 'after reset, the mode prompt should contain category C + skill_create — otherwise the dev server is serving stale JS').toBe(true);
        await page.screenshot({ path: stepPath(1, 'mode-prompt-reset-to-new-default'), fullPage: false });

        // ── Step 3: inject the extractable block. ────────────────────────
        const injection = await page.evaluate(async ({ injectBlock, presetName }) => {
            const ctx = window.SillyTavern.getContext();
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
        await page.screenshot({ path: stepPath(2, 'injected-block-saved'), fullPage: false });

        try {
            // ── Step 4: open CPA popup, fresh session, switch to mode. ──
            const openBtn = page.locator('#completion_preset_assistant_open').first();
            await openBtn.waitFor({ state: 'visible', timeout: 10000 });
            await openBtn.click();
            const cpaPopup = page.locator('dialog.popup:has(.cpa_it_popup)').first();
            await cpaPopup.waitFor({ state: 'visible', timeout: 15000 });
            await page.waitForFunction(() => {
                const d = document.querySelector('dialog.popup:has(.cpa_it_popup)');
                return d && d.hasAttribute('open') && !d.hasAttribute('opening');
            }, null, { timeout: 5000 });

            const historyDetails = cpaPopup.locator('details[data-cpa-it-history]').first();
            await historyDetails.evaluate(el => { if (!el.hasAttribute('open')) el.setAttribute('open', ''); });
            await cpaPopup.locator('[data-cpa-it-action="new-session"]').first().dispatchEvent('click');
            await page.waitForFunction(() => {
                const list = document.querySelector('dialog.popup:has(.cpa_it_popup) [data-cpa-it-messages]');
                return list && list.children.length === 0;
            }, null, { timeout: 5000 });

            const modeSelect = cpaPopup.locator('.cpa_it_mode_select').first();
            await modeSelect.selectOption('orchestrator-optimize');
            await modeSelect.dispatchEvent('change');
            await page.waitForFunction(() => {
                const sel = document.querySelector('dialog.popup:has(.cpa_it_popup) .cpa_it_mode_select');
                return sel && sel.value === 'orchestrator-optimize';
            }, null, { timeout: 5000 });
            await page.screenshot({ path: stepPath(3, 'mode-selected'), fullPage: false });

            // ── Step 5: vanilla adapt request (no mention of skills). ────
            const VANILLA_PROMPT = '请把这份预设改造成编排器主 Agent 用的预设。按你判断的优先级处理。';
            const composer = cpaPopup.locator('textarea[data-cpa-it-input]').first();
            await composer.evaluate((el, v) => {
                el.value = v;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }, VANILLA_PROMPT);
            await page.screenshot({ path: stepPath(4, 'vanilla-prompt-typed'), fullPage: false });

            const sendBtn = cpaPopup.locator('[data-cpa-it-action="send"]').first();
            await sendBtn.dispatchEvent('click');
            await page.screenshot({ path: stepPath(5, 'send-clicked'), fullPage: false });

            // ── Step 6: poll for either extraction OR explicit "found
            // nothing" — both prove the augmentation reached the model. ─
            const deadline = Date.now() + 480_000;
            let matches = [];
            let sweptButFoundNothing = false;
            let lastAssistantText = '';
            while (Date.now() < deadline) {
                matches = await findSkillsContainingSentinel(INJECTED_SENTINEL);
                if (matches.length > 0) break;
                lastAssistantText = await cpaPopup
                    .locator('.cpa_it_msg_assistant').last()
                    .innerText()
                    .catch(() => '');
                const text = String(lastAssistantText || '');
                const englishSwept = /scan(?:ned)?[\s\S]{0,80}?(?:found\s+none|nothing\s+worth|no\s+(?:reusable|extractable)|nothing\s+to\s+(?:extract|lift))/i.test(text)
                    && /skill/i.test(text);
                const chineseSwept = /(?:扫|检查|审视|检视)(?:过|了|描|视)?/.test(text)
                    && (/没(?:有)?(?:找到|看到|发现)|无(?:可|需)抽取|找不到|不(?:需要|必要|值得|建议)抽取/.test(text))
                    && /skill|抽取|抽成|抽出/.test(text);
                if (englishSwept || chineseSwept) {
                    sweptButFoundNothing = true;
                    break;
                }
                await new Promise(r => setTimeout(r, 5000));
            }
            await page.screenshot({ path: stepPath(6, 'after-llm-round'), fullPage: false });

            if (matches.length === 0 && !sweptButFoundNothing) {
                throw new Error(
                    `Proactive sweep produced neither an extraction nor an explicit "scanned, found nothing" line within 8 minutes.\n`
                    + `AI's last assistant message:\n${(lastAssistantText || '(unavailable)').slice(0, 1200)}`,
                );
            }

            if (matches.length > 0) {
                for (const m of matches) {
                    expect(m.body, `skill ${m.name} should contain the verbatim sentinel`).toContain(INJECTED_SENTINEL);
                }
                const presetScoped = matches.filter(m => m.scope?.kind === 'preset');
                expect(
                    presetScoped.length,
                    `expected at least one preset-scope extraction; got: ${matches.map(m => `${m.name}@${m.scope?.kind}`).join(', ')}`,
                ).toBeGreaterThanOrEqual(1);
            } else {
                // eslint-disable-next-line no-console
                console.log(
                    `[proactive sweep] AI swept and reported nothing extractable. Snippet:\n${lastAssistantText.slice(0, 600)}`,
                );
            }
            await page.screenshot({ path: stepPath(7, 'verified'), fullPage: false });
        } finally {
            // Restore preset body.
            await page.evaluate(async ({ presetName, body }) => {
                const ctx = window.SillyTavern.getContext();
                await ctx.presets.save({ collection: 'openai', name: presetName }, body, { select: true });
            }, { presetName: presetMeta.name, body: injection.originalBody });

            // Delete any skill the test caused to be created.
            const matches = await findSkillsContainingSentinel(INJECTED_SENTINEL);
            for (const m of matches) {
                await fs.rm(path.dirname(m.file), { recursive: true, force: true }).catch(() => {});
            }
        }
    });
});
