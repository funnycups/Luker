/**
 * Iter-studio skill proposal cards — real-flow rendering smoke.
 *
 * Coverage gap this closes:
 *   The orchestrator iter-studio used to silently direct-write skill files
 *   from the 7 authoring tools (skill_create / skill_update_content / ...).
 *   They now stage proposals through the ProposalBus; the popup renders a
 *   line-by-line diff card per proposal; the user Approves per card and
 *   only then does commitApprovedSkillProposal write through skillsApi.
 *
 *   The jest unit tests cover the data shape end-to-end and the
 *   commit-replay branches. What they CAN'T cover is the full chain
 *   running in a real browser against the live skillsApi:
 *     - runSkillIterStudioTool (exposed on
 *       getContext().iterationLibrary.tools.skillIterStudio) actually
 *       returns { pendingSkillEdit }
 *     - commitApprovedSkillProposal (same namespace) actually writes the
 *       file via the live skillsApi
 *
 *   This spec drives both in a real browser, against a real server, against
 *   the live skills filesystem. No LLM — the proposal envelope is
 *   constructed directly by calling the iter-library tools surface, which
 *   is exactly what iter-studio's own dispatcher does. That keeps the spec
 *   deterministic and fast (~5 s) while still being a true real-flow test.
 *
 * Why not screenshot-test the rendered diff card too?
 *   The diff card is rendered by `iteration-library/ui/diff.renderDiffCard`,
 *   which is exhaustively covered by its own jest suite. The proposal
 *   handler returns a `before` / `after` string pair that flows into
 *   renderDiffCard verbatim. Asserting the byte-level shape of the LCS
 *   output would just re-test the diff library.
 *
 * Pre-ProposalBus history:
 *   This spec originally called runSkillIterStudioTool /
 *   commitApprovedSkillProposal through
 *   `getContext().getExtensionApi('orchestrator')` — the orchestrator's
 *   extension-API surface re-exported those iter-library helpers so
 *   sibling plugins could splice the same tool catalog without crossing
 *   the plugin↔plugin boundary. The ProposalBus migration moved every
 *   popup onto the shared bus, the re-exports were dropped, and the
 *   iter-library tools namespace became the canonical surface — that's
 *   what this spec drives now.
 */

import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
    SCREENSHOTS_DIR,
    awaitMainUI,
    ensureSkillsApiAvailable,
} from './helpers.js';

// Pick a name that won't collide with bundled fixtures. The test cleans
// up in afterAll so repeated runs are idempotent.
const SKILL_NAME = 'iter-skill-proposal-card-test';

function stepPath(slug) {
    return path.join(SCREENSHOTS_DIR, `iter-skill-proposal-card-${slug}.png`);
}

test.describe('iter-studio skill proposal card — real-flow disk write through Approve → Apply', () => {
    test.setTimeout(60_000);

    test.beforeAll(async () => {
        await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
    });

    test('skill_update_content proposes (no disk write) → commitApprovedSkillProposal writes through skillsApi', async ({ page }) => {
        await awaitMainUI(page);
        await ensureSkillsApiAvailable(page);
        // ── 1. Seed: create a skill on disk so update_content has a target.
        const seedBody = '---\nname: ' + SKILL_NAME + '\ndescription: seed for the proposal card spec\n---\n# Heading\n\nLine A\nLine B\nLine C\n';
        await page.evaluate(async ({ name, body }) => {
            const ctx = window.SillyTavern.getContext();
            // Best-effort tear-down of any leftover from a prior run.
            try { await ctx.skills.delete({ kind: 'global' }, name); } catch { /* not present */ }
            await ctx.skills.install({
                scope: { kind: 'global' },
                payload: { files: [{ path: 'SKILL.md', encoding: 'utf8', content: body }] },
            });
        }, { name: SKILL_NAME, body: seedBody });

        await page.screenshot({ path: stepPath('1-seed-installed'), fullPage: false });

        // ── 2. Call runSkillIterStudioTool via the iter-library tools
        //   namespace exactly as iter-studio's dispatcher does. The return
        //   envelope MUST contain pendingSkillEdit with line-by-line
        //   before/after — and the on-disk SKILL.md MUST stay seed-shaped.
        const proposalResult = await page.evaluate(async ({ name }) => {
            const ctx = window.SillyTavern.getContext();
            const skillTools = ctx.iterationLibrary?.tools?.skillIterStudio;
            if (!skillTools) return { ok: false, error: 'iterationLibrary.tools.skillIterStudio not present' };
            const out = await skillTools.runSkillIterStudioTool(
                {
                    name: 'skill_update_content',
                    args: {
                        name,
                        path: 'SKILL.md',
                        content: '---\nname: ' + name + '\ndescription: seed for the proposal card spec\n---\n# Heading\n\nLine A (changed)\nLine B\nLine C\nLine D (new)\n',
                    },
                },
                { getWorkingProfile: () => null },
            );
            const diskBody = await ctx.skills.readFile({
                scope: { kind: 'global' }, name, path: 'SKILL.md',
            });
            return {
                ok: !!out?.ok,
                rawError: out?.error || null,
                hasPendingSkillEdit: !!out?.pendingSkillEdit,
                proposed: out?.result?.proposed === true,
                tool: out?.result?.tool,
                beforeSnippet: out?.pendingSkillEdit?.before?.includes('Line A') || false,
                afterSnippet: out?.pendingSkillEdit?.after?.includes('Line A (changed)') || false,
                op: out?.pendingSkillEdit?.op?.name,
                // Disk should still match the seed because the tool is
                // PROPOSAL mode now — no inline write.
                diskUnchanged: (diskBody?.content || diskBody || '').includes('Line A\nLine B') &&
                               !(diskBody?.content || diskBody || '').includes('Line A (changed)'),
            };
        }, { name: SKILL_NAME });

        expect(proposalResult.ok, 'runSkillIterStudioTool returned ok').toBe(true);
        expect(proposalResult.hasPendingSkillEdit, 'envelope carries pendingSkillEdit (proposal mode)').toBe(true);
        expect(proposalResult.proposed, 'slim ack returned to the LLM marks proposed:true').toBe(true);
        expect(proposalResult.tool, 'op carries source tool name for replay').toBe('skill_update_content');
        expect(proposalResult.beforeSnippet, 'proposal before captures seed content').toBe(true);
        expect(proposalResult.afterSnippet, 'proposal after captures new content').toBe(true);
        expect(proposalResult.diskUnchanged, 'seed file on disk is untouched until Apply commits').toBe(true);

        await page.screenshot({ path: stepPath('2-proposal-returned-disk-untouched'), fullPage: false });

        // ── 3. Commit the proposal through the same iter-library surface
        //   the bus uses at approve time. After this the file MUST contain
        //   the new content — the replay walks the original args, not a
        //   snapshot.
        const commitResult = await page.evaluate(async ({ name }) => {
            const ctx = window.SillyTavern.getContext();
            const skillTools = ctx.iterationLibrary.tools.skillIterStudio;
            await skillTools.commitApprovedSkillProposal({
                name: 'skill_update_content',
                args: {
                    scope: { kind: 'global' },
                    name,
                    path: 'SKILL.md',
                    content: '---\nname: ' + name + '\ndescription: seed for the proposal card spec\n---\n# Heading\n\nLine A (changed)\nLine B\nLine C\nLine D (new)\n',
                },
            });
            const diskBody = await ctx.skills.readFile({
                scope: { kind: 'global' }, name, path: 'SKILL.md',
            });
            const text = diskBody?.content || diskBody || '';
            return {
                hasChangedLine: text.includes('Line A (changed)'),
                hasNewLine: text.includes('Line D (new)'),
                originalLineGone: !text.includes('Line A\nLine B'),
                anchorsKept: text.includes('Line B') && text.includes('Line C'),
            };
        }, { name: SKILL_NAME });

        expect(commitResult.hasChangedLine, 'changed line landed on disk').toBe(true);
        expect(commitResult.hasNewLine, 'new line landed on disk').toBe(true);
        expect(commitResult.originalLineGone, 'original "Line A\\nLine B" sequence replaced').toBe(true);
        expect(commitResult.anchorsKept, 'unaltered anchor lines preserved').toBe(true);

        await page.screenshot({ path: stepPath('3-after-commit-disk-updated'), fullPage: false });

        // ── 4. Teardown: remove the seed skill.
        await page.evaluate(async ({ name }) => {
            const ctx = window.SillyTavern.getContext();
            try { await ctx.skills.delete({ kind: 'global' }, name); } catch { /* gone */ }
        }, { name: SKILL_NAME });
    });
});
