/**
 * CPA orchestrator-optimize mode — Skills tool wiring e2e.
 *
 * LLM cost: ~$0.1-0.3 per run (single CPA round invoking skill_create).
 * Requires: dev server running + LLM API configured (online_status !=
 *           'no_connection') + a usable connection profile.
 *
 * Scope:
 *   - Open the Completion Preset Assistant against the currently-selected
 *     OpenAI Chat Completion preset.
 *   - Switch the session mode to "Adapt for orchestrator" — the only mode
 *     that exposes the skills toolset + the skill-authoring discipline
 *     block in the system prompt.
 *   - Send a real-user-shaped prompt asking the assistant to lift a
 *     reusable RP-craft rule into a brand-new skill at this preset's
 *     scope (so it travels with the preset on export).
 *   - Validate the skill landed on disk under preset scope (not global)
 *     and is well-formed (frontmatter + body).
 *
 * Why this matters:
 *   The new code wires the orchestrator iter-studio's skill toolset into
 *   CPA's orchestrator-optimize mode. Without an actual round driven from
 *   the popup, we cannot verify that
 *     (a) the tool catalog actually surfaces `skill_create` to the model,
 *     (b) the runtime augmentation tells the model to default scope to
 *         this preset,
 *     (c) the inline-executed skill dispatch path persists the result.
 *   A passing unit test for the tool catalog or the prompt builder does
 *   not catch the wiring being broken end-to-end.
 *
 * Failure-mode policy:
 *   - The LLM may need a clarifying back-and-forth, but the prompt is
 *     specific enough that one shot should suffice. We give it up to
 *     8 minutes to write + commit.
 *   - The on-disk skill file must exist under `preset/<apiId>/<presetName>`
 *     — global-scope landing means the prompt augmentation did not steer
 *     the model. That is a regression in scope-default wording.
 *   - The skill body must include the verbatim phrases requested. Compressed
 *     or paraphrased output means the "verbatim, do not reword" discipline
 *     did not reach the model.
 *
 * Screenshots: docs/public/_screenshots/skills/cpa-orch-NN-*.png.
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

const SKILL_NAME = 'preset-style-anti-meta-zh';
const SKILL_SENTINEL_LINE = '禁止把场景外的视角解释塞回叙事，比如 "正如你所知 X 是 Y"。';
const REPO_ROOT = path.resolve('/Users/funnycups/worktree/luker-skills-foundation');
const SKILLS_ROOT = path.join(REPO_ROOT, 'data/default-user/skills');

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

/**
 * Walk data/default-user/skills/preset/*\/*\/<SKILL_NAME>/SKILL.md and the
 * global fallback, returning the first matching file path + the scope
 * descriptor we found it under. Returns null when nothing matches.
 */
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
    } catch { /* preset/ doesn't exist yet */ }

    // Fallback: report global-scope landing — that's a regression for this
    // spec, but the caller still gets evidence the AI did create something.
    const globalCandidate = path.join(SKILLS_ROOT, 'global', skillName, 'SKILL.md');
    try {
        await fs.stat(globalCandidate);
        return { file: globalCandidate, scope: { kind: 'global' } };
    } catch { /* not here */ }
    return null;
}

/**
 * Clean up any prior copy of the skill from every scope so the spec
 * asserts on a fresh creation. Idempotent — missing dirs are silently
 * skipped.
 */
async function preCleanupSkill(skillName) {
    const targets = [];
    const presetRoot = path.join(SKILLS_ROOT, 'preset');
    try {
        const apis = await fs.readdir(presetRoot);
        for (const apiId of apis) {
            const apiDir = path.join(presetRoot, apiId);
            const presetNames = await fs.readdir(apiDir).catch(() => []);
            for (const presetName of presetNames) {
                targets.push(path.join(apiDir, presetName, skillName));
            }
        }
    } catch { /* preset/ doesn't exist yet */ }
    targets.push(path.join(SKILLS_ROOT, 'global', skillName));
    for (const t of targets) {
        await fs.rm(t, { recursive: true, force: true }).catch(() => {});
    }
}

test.describe('CPA orchestrator-optimize: skill toolset wiring', () => {
    // skill_create + inline-executed dispatch usually lands in 60-180 s
    // depending on model latency; allow 8 minutes for slow providers.
    test.setTimeout(600_000);

    test.beforeAll(async () => {
        await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
        await preCleanupSkill(SKILL_NAME);
    });

    test('user opens CPA, switches to Adapt-for-orchestrator, asks the AI to author a verbatim skill; skill_create lands on disk at preset scope', async ({ page }) => {
        // ── Setup: log in, wait for main UI, verify skills API is up. ─
        await awaitMainUI(page);
        await ensureSkillsApiAvailable(page);

        // Activate a connection profile so the iteration LLM call can fire.
        await page.locator('#sys-settings-button .drawer-toggle').first().click();
        await page.locator('#rm_api_block').waitFor({ state: 'visible', timeout: 5000 });
        const activatedProfile = await activateConnectionProfile(page);
        expect(activatedProfile, 'CPA spec needs a usable connection profile').toBeTruthy();
        await page.waitForFunction(() => {
            const ctx = window.Luker?.getContext?.();
            const v = ctx?.onlineStatus ?? null;
            return Boolean(v) && String(v) !== 'no_connection';
        }, null, { timeout: 30000 });
        await page.locator('#sys-settings-button .drawer-toggle').first().click();
        await page.locator('#rm_api_block').waitFor({ state: 'hidden', timeout: 5000 });

        // CPA requires the active preset to be a stored OpenAI chat-completion
        // preset. Default-user install ships a "Default" preset and selects
        // it on first boot — but assert here anyway so a regression in the
        // bootstrap surfaces as a precise spec failure rather than a Lambert
        // "AI request failed" later.
        let presetMeta = await page.evaluate(() => {
            const ctx = window.Luker?.getContext?.();
            const ref = ctx?.presets?.getSelected?.('openai');
            return ref && typeof ref === 'object' ? { name: String(ref.name || '') } : null;
        });
        expect(presetMeta, 'an OpenAI chat-completion preset must be selected before opening CPA').toBeTruthy();
        expect(presetMeta.name).toBeTruthy();

        // The skill API's preset scope path goes preset/<apiId>/<presetName>
        // and the server-side scope validator only accepts [A-Za-z0-9._-]
        // in each segment. If the currently-selected preset name is non-
        // ASCII (CJK is common in this user env), the AI would correctly
        // try preset scope first and then fall back to global when the
        // server rejects the segment — which would defeat this spec's
        // scope=preset assertion. Switch to an ASCII-safe preset before
        // opening CPA so the preset scope path is actually viable.
        const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
        if (!SAFE_SEGMENT.test(presetMeta.name)) {
            let candidate = await page.evaluate((re) => {
                const ctx = window.Luker?.getContext?.();
                const all = (ctx?.presets?.list?.('openai') || [])
                    .map(r => String(r?.name || ''))
                    .filter(Boolean);
                const regex = new RegExp(re);
                return all.find(n => regex.test(n)) || '';
            }, SAFE_SEGMENT.source);
            if (!candidate) {
                // Clone the active preset under an ASCII name so the
                // preset-scope spec can run. Fail loud if clone breaks —
                // the presets API is part of the contract this spec
                // depends on.
                candidate = `e2e-skill-ascii-${Date.now()}`;
                const cloned = await page.evaluate(async (name) => {
                    const ctx = window.Luker?.getContext?.();
                    const active = ctx?.presets?.getSelected?.('openai');
                    const stored = active ? ctx.presets.getStored(active) : null;
                    if (!stored?.body) return { ok: false, reason: 'active preset body unavailable' };
                    const cloneBody = structuredClone(stored.body);
                    await ctx.presets.save({ collection: 'openai', name }, cloneBody, { select: true });
                    return { ok: true };
                }, candidate);
                expect(cloned.ok, `clone ASCII preset failed: ${cloned.reason}`).toBe(true);
            }
            // Switch via the legacy preset manager UI (the same channel a
            // real user uses), then wait for getSelected to reflect the
            // change. The dropdown's option `value` attribute is the array
            // index, not the preset name — so find the matching option's
            // index first.
            await page.evaluate((name) => {
                const dropdown = document.querySelector('#settings_preset_openai');
                if (!dropdown) throw new Error('#settings_preset_openai not found');
                const opt = Array.from(dropdown.options).find(o => o.textContent === name);
                if (!opt) throw new Error(`option for preset "${name}" not in dropdown`);
                const $el = window.jQuery?.(dropdown);
                $el.val(opt.value).trigger('change');
            }, candidate);
            await page.waitForFunction((wantName) => {
                const ctx = window.Luker?.getContext?.();
                const ref = ctx?.presets?.getSelected?.('openai');
                return ref && String(ref.name || '') === wantName;
            }, candidate, { timeout: 10000 });
            presetMeta = { name: candidate };
        }
        // After potential switch, the preset name is guaranteed ASCII-safe.
        expect(SAFE_SEGMENT.test(presetMeta.name), `active preset name must be ASCII-safe for preset-scope skills to land; got: ${presetMeta.name}`).toBe(true);

        await page.screenshot({ path: stepPath(1, 'main-ui-ready'), fullPage: false });

        // ── Step 2: open the Extensions drawer + CPA settings panel. ──
        await ensureExtensionsDrawerOpen(page);
        await ensureInlineDrawerOpen(page, 'completion_preset_assistant_settings');
        await page.screenshot({ path: stepPath(2, 'cpa-settings-open'), fullPage: false });

        // ── Step 3: click Open Assistant → CPA popup mounts. ──────────
        const openBtn = page.locator('#completion_preset_assistant_open').first();
        await openBtn.waitFor({ state: 'visible', timeout: 10000 });
        await openBtn.click();

        const cpaPopup = page.locator('dialog.popup:has(.cpa_it_popup)').first();
        await cpaPopup.waitFor({ state: 'visible', timeout: 15000 });
        await page.waitForFunction(() => {
            const d = document.querySelector('dialog.popup:has(.cpa_it_popup)');
            return d && d.hasAttribute('open') && !d.hasAttribute('opening');
        }, null, { timeout: 5000 });
        await page.screenshot({ path: stepPath(3, 'cpa-popup-opened'), fullPage: false });

        // ── Step 3b: start a fresh session so any prior history for this
        // preset doesn't muddy the model's context (an old session may
        // resume from "no more changes needed" and the model never makes a
        // skill_create call). The new-session button lives inside the
        // History <details> block — expand it first, then click.
        const historyDetails = cpaPopup.locator('details[data-cpa-it-history]').first();
        await historyDetails.evaluate(el => { if (!el.hasAttribute('open')) el.setAttribute('open', ''); });
        await cpaPopup.locator('[data-cpa-it-action="new-session"]').first().dispatchEvent('click');
        // After a new session, the message list is empty — wait for that
        // before continuing so we don't race the re-render.
        await page.waitForFunction(() => {
            const list = document.querySelector('dialog.popup:has(.cpa_it_popup) [data-cpa-it-messages]');
            return list && list.children.length === 0;
        }, null, { timeout: 5000 });

        // ── Step 4: switch session mode to "orchestrator-optimize". ────
        // The mode dropdown is `.cpa_it_mode_select` with values matching
        // SESSION_MODES — 'orchestrator-optimize' is the AI-orchestrator
        // adapter mode that exposes the skill toolset.
        const modeSelect = cpaPopup.locator('.cpa_it_mode_select').first();
        await modeSelect.waitFor({ state: 'attached', timeout: 5000 });
        await modeSelect.selectOption('orchestrator-optimize');
        await modeSelect.dispatchEvent('change');
        // Wait for the select to settle to the chosen value (jQuery change
        // handlers may rerender on input — surface here that we actually
        // pinned the mode the spec promised).
        await page.waitForFunction(() => {
            const sel = document.querySelector('dialog.popup:has(.cpa_it_popup) .cpa_it_mode_select');
            return sel && sel.value === 'orchestrator-optimize';
        }, null, { timeout: 5000 });
        await page.screenshot({ path: stepPath(4, 'orchestrator-mode-selected'), fullPage: false });

        // ── Step 5: type the prompt + send. ─────────────────────────────
        const composer = cpaPopup.locator('textarea[data-cpa-it-input]').first();
        await composer.waitFor({ state: 'attached', timeout: 5000 });
        // Direct DOM mutation — composer textarea may render with 0-size
        // during dialog transitions; Playwright's fill() rejects that.
        await composer.evaluate((el, v) => {
            el.value = v;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }, USER_PROMPT);
        await page.screenshot({ path: stepPath(5, 'prompt-typed'), fullPage: false });

        const sendBtn = cpaPopup.locator('[data-cpa-it-action="send"]').first();
        await sendBtn.dispatchEvent('click');
        await page.screenshot({ path: stepPath(6, 'send-clicked'), fullPage: false });

        // ── Step 6: wait for skill_create to write the file on disk. ───
        // We poll the filesystem because the runtime trace channel for CPA
        // edit-tool / skill-tool calls isn't a stable assertion target —
        // the AI may produce a skill_create + a follow-up skill_inspect
        // in the same round, or split across rounds. The skill file on
        // disk is the unambiguous "this actually happened" signal.
        const deadline = Date.now() + 480_000;
        let found = null;
        while (Date.now() < deadline) {
            found = await findSkillOnDisk(SKILL_NAME);
            if (found) break;
            await new Promise(r => setTimeout(r, 5000));
        }
        await page.screenshot({ path: stepPath(7, 'after-llm-round'), fullPage: false });
        expect(found, `skill ${SKILL_NAME} should be on disk within 8 minutes`).toBeTruthy();

        // ── Step 7: verify scope landed at preset (regression guard). ──
        // The runtime augmentation tells the AI to default scope to this
        // preset. A global-scope landing means the prompt augmentation
        // didn't reach the model or its instruction got lost.
        expect(
            found.scope?.kind,
            `expected scope=preset (so the skill travels with the preset on export), got: ${JSON.stringify(found.scope)}`,
        ).toBe('preset');
        expect(
            found.scope?.name,
            'preset scope name should match the active preset',
        ).toBe(presetMeta.name);

        // ── Step 8: verify SKILL.md is well-formed and verbatim. ───────
        const body = await fs.readFile(found.file, 'utf8');
        expect(body.startsWith('---\n'), 'skill body must start with YAML frontmatter').toBe(true);
        expect(body, 'skill name in frontmatter should match the requested name').toContain(`name: ${SKILL_NAME}`);
        expect(body, 'skill description must be present').toMatch(/description:\s*\S+/);
        // The "verbatim" discipline assertion: the sentinel sentence the
        // user asked for must appear unchanged in the body. The LLM might
        // also add headings or framing — that's fine — but compressing or
        // paraphrasing the sentinel line means the discipline didn't land.
        expect(
            body,
            'skill body must contain the verbatim sentinel sentence from the prompt',
        ).toContain(SKILL_SENTINEL_LINE);

        // ── Step 9: skills API surfaces it at the same scope. ──────────
        const apiSeen = await page.evaluate(async ({ name, scopeName }) => {
            const ctx = window.Luker.getContext();
            const all = await ctx.skills.list({ scope: 'all' });
            return (all || []).filter(s => s.name === name).map(s => ({ name: s.name, scope: s.scope }));
        }, { name: SKILL_NAME, scopeName: presetMeta.name });
        expect(apiSeen.length, 'skills.list should surface exactly one row for the created skill').toBe(1);
        expect(apiSeen[0].scope?.kind, 'skills.list scope kind should match disk scope').toBe('preset');
        expect(apiSeen[0].scope?.name, 'skills.list scope name should match disk scope').toBe(presetMeta.name);

        await page.screenshot({ path: stepPath(8, 'skill-on-disk-verified'), fullPage: false });

        // ── Step 10: close the popup. Best-effort — popup may auto-close
        // if the AI finished without leaving pending edits. ────────────
        const closeBtn = cpaPopup.locator('div.popup-button-ok, div.popup-button-close, .popup-button-cancel').first();
        if (await closeBtn.count() > 0) {
            await closeBtn.dispatchEvent('click').catch(() => {});
        }
    });
});
