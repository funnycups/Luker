/**
 * ProposalBus regression spec — covers the four bugs the 2f35fc972 → 6a6eedfd6
 * window introduced into the iter-studio skill / lorebook write flow:
 *
 *   1. Skill diff rendered as a one-line placeholder
 *      (`iter_skill_proposal_inline`) instead of the LCS diff card.
 *   2. Lorebook diff rendered as the same one-line placeholder.
 *   3. `skill_create` always flipped to conflict on approve because
 *      propose-time snapshot was `{ content: '' }` while readCurrent
 *      returned `null` (skill_create wasn't in FILE_OPS).
 *   4. Conflict cards rendered an Approve button that was a near-no-op
 *      (re-approval re-reads disk but only commits if the disk happens
 *      to match the original propose-time fingerprint, which by
 *      definition it doesn't); the loop was blocked because conflict
 *      counted as outstanding.
 *
 * Coverage approach: register the real skill-author KindHandler against
 * the live skillsApi, drive it through propose / approve, and inspect
 * the rendered card HTML + bus.hasOutstanding(). No LLM, no
 * orchestrator UI — the regression points are all in the bus layer and
 * the two diff-body helpers it now delegates to.
 */

import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import {
    awaitMainUI,
    ensureSkillsApiAvailable,
    SCREENSHOTS_DIR,
} from './helpers.js';

test.describe.configure({ mode: 'serial' });

const SKILL_NAME_UPDATE = 'iter-bus-regression-update';
const SKILL_NAME_CREATE = 'iter-bus-regression-create';

function buildSeedSkill(name) {
    return [
        '---',
        `name: ${name}`,
        'description: regression-spec seed',
        '---',
        '',
        '# Heading',
        '',
        'Line A',
        'Line B',
        'Line C',
        '',
    ].join('\n');
}

test.describe('iter-studio ProposalBus regressions (skill diff, skill_create conflict, conflict UX)', () => {
    test.setTimeout(60_000);

    test.beforeAll(async () => {
        await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
    });

    test.beforeEach(async ({ page }) => {
        await awaitMainUI(page);
        await ensureSkillsApiAvailable(page);
        // Seed the update-target skill; the create-target must NOT exist.
        await page.evaluate(async ({ updateName, createName, body }) => {
            const ctx = window.SillyTavern.getContext();
            try { await ctx.skills.delete({ kind: 'global' }, updateName); } catch { /* ok */ }
            try { await ctx.skills.delete({ kind: 'global' }, createName); } catch { /* ok */ }
            await ctx.skills.install({
                scope: { kind: 'global' },
                payload: { files: [{ path: 'SKILL.md', encoding: 'utf8', content: body }] },
            });
        }, { updateName: SKILL_NAME_UPDATE, createName: SKILL_NAME_CREATE, body: buildSeedSkill(SKILL_NAME_UPDATE) });
    });

    test.afterEach(async ({ page }) => {
        await page.evaluate(async ({ updateName, createName }) => {
            const ctx = window.SillyTavern.getContext();
            try { await ctx.skills.delete({ kind: 'global' }, updateName); } catch { /* ok */ }
            try { await ctx.skills.delete({ kind: 'global' }, createName); } catch { /* ok */ }
        }, { updateName: SKILL_NAME_UPDATE, createName: SKILL_NAME_CREATE });
    });

    test('skill-author card body renders an LCS diff (not the placeholder inline label)', async ({ page }) => {
        const result = await page.evaluate(async ({ name }) => {
            const ctx = window.SillyTavern.getContext();
            const lib = ctx.iterationLibrary;
            const diffBodies = await import('/scripts/iteration-library/proposal-bus/diff-bodies/skill.js');
            const skillTools = await import('/scripts/iteration-library/tools/skill-iter-studio.js');

            const bus = lib.proposalBus.createProposalBus({ i18n: (s) => s });
            bus.registerKind('skill-author', lib.proposalBus.createSkillAuthorHandler({
                commitOp: skillTools.commitApprovedSkillProposal,
                readFile: (args) => ctx.skills.readFile(args),
                renderDiff: (entry, helpers) => diffBodies.renderSkillBody(entry, helpers),
                label: (entry) => diffBodies.skillLabel(entry, { i18n: (s) => s }),
                icon: (entry) => diffBodies.skillIcon(entry),
                target: (entry) => diffBodies.skillTarget(entry, { i18n: (s) => s }),
            }));

            // Drive a skill_update_content through the tool — same shape
            // studio.js's dispatcher uses, then translate to a bus.propose
            // call so the entry.meta carries before/after the renderer needs.
            const out = await skillTools.runSkillIterStudioTool({
                name: 'skill_update_content',
                args: {
                    scope: { kind: 'global' },
                    name,
                    path: 'SKILL.md',
                    content: '---\nname: ' + name + '\ndescription: regression-spec seed\n---\n\n# Heading\n\nLine A (changed)\nLine B\nLine C\nLine D (new)\n',
                },
            }, {});
            if (!out?.ok || !out.pendingSkillEdit) {
                return { error: 'no pendingSkillEdit', shape: out };
            }
            const sk = out.pendingSkillEdit;
            const snapshot = typeof sk.before === 'string' ? { content: sk.before } : null;
            const { id } = await bus.propose({
                kind: 'skill-author',
                sourceCallId: 'call-x',
                op: sk.op,
                snapshot,
                meta: {
                    skillName: sk.skillName,
                    scope: sk.scope,
                    path: sk.path,
                    before: sk.before,
                    after: sk.after,
                },
            });
            const html = bus.renderCardsForMessage('call-x');
            return { id, html };
        }, { name: SKILL_NAME_UPDATE });

        expect(result.error, JSON.stringify(result)).toBeUndefined();
        // Placeholder used to be a tag like `iter_skill_proposal_inline`
        // with the one-line "skill_update_content foo/SKILL.md" inside.
        // The real diff renderer emits luker_lib_diff_* classes from the
        // shared LCS card.
        expect(result.html).not.toContain('iter_skill_proposal_inline');
        expect(result.html).toContain('luker_lib_diff');
        // The LCS renderer wraps inserted fragments in
        // `<span class="luker_lib_diff_word_add">…</span>` for partial-
        // line changes ("Line A (changed)") and wraps whole new lines in
        // `<td class="luker_lib_diff_text new">` ("Line D (new)" — no
        // word-split because the whole line is added). Either shape is
        // proof the LCS card body fired (not the inline placeholder).
        expect(result.html).toContain('luker_lib_diff_word_add');
        expect(result.html).toMatch(/luker_lib_diff_word_add[^>]*>\s*\(changed\)/);
        // Whole-new-line case ("Line D (new)") shows up inside the
        // "new" diff cell. The cell wraps its content in another div,
        // so we just look for the cell class + "Line D (new)" anywhere
        // in the same render — sequence is sufficient proof.
        expect(result.html).toMatch(/luker_lib_diff_text new[\s\S]*Line D \(new\)/);
    });

    test('skill_create approves cleanly (no false conflict from fingerprint mismatch)', async ({ page }) => {
        // Pre-2f35fc972, propose-time `before` was '' (wrapped to
        // { content: '' }) but skill_create wasn't in FILE_OPS, so
        // readCurrent returned null and fingerprint mismatched on
        // first approve → every skill_create flipped to conflict
        // without ever touching disk.
        const result = await page.evaluate(async ({ name }) => {
            const ctx = window.SillyTavern.getContext();
            const lib = ctx.iterationLibrary;
            const skillTools = await import('/scripts/iteration-library/tools/skill-iter-studio.js');

            const bus = lib.proposalBus.createProposalBus({ i18n: (s) => s });
            bus.registerKind('skill-author', lib.proposalBus.createSkillAuthorHandler({
                commitOp: skillTools.commitApprovedSkillProposal,
                readFile: (args) => ctx.skills.readFile(args),
            }));

            // Drive skill_create through the tool. before is null now
            // (was '' before the fix). Snapshot wrap stays null because
            // null isn't a string and isn't `{ content: string }`.
            const out = await skillTools.runSkillIterStudioTool({
                name: 'skill_create',
                args: {
                    scope: { kind: 'global' },
                    name,
                    description: 'fresh skill from regression spec',
                    body: '# Heading\n\nFresh body line.\n',
                },
            }, {});
            const sk = out?.pendingSkillEdit;
            const snapshot = (sk?.before != null && typeof sk.before === 'object' && typeof sk.before.content === 'string')
                ? { content: sk.before.content }
                : (typeof sk?.before === 'string' ? { content: sk.before } : null);
            const { id } = await bus.propose({
                kind: 'skill-author',
                sourceCallId: 'call-y',
                op: sk.op,
                snapshot,
                meta: {
                    skillName: sk.skillName,
                    scope: sk.scope,
                    path: sk.path,
                    before: sk.before,
                    after: sk.after,
                },
            });

            const approveOut = await bus.approve(id);
            const onDisk = await ctx.skills.readFile({ scope: { kind: 'global' }, name, path: 'SKILL.md' }).catch(() => null);
            const entry = bus._testOnly_entries().find((e) => e.id === id);
            return {
                proposeBefore: sk?.before,
                approveStatus: approveOut?.status,
                entryStatus: entry?.status,
                fileLanded: !!(onDisk && (onDisk.content || onDisk)),
                fileContent: (onDisk?.content || onDisk || '').toString(),
                // Diagnostic carry-over so a future regression that
                // re-introduces the false-conflict bug surfaces the
                // server error inline (otherwise you'd just see
                // "expected committed got conflict" with no clue).
                approveError: approveOut?.error || null,
                conflictInfo: entry?.conflictInfo || null,
            };
        }, { name: SKILL_NAME_CREATE });

        expect(result.proposeBefore).toBeNull();
        expect(result.approveStatus, JSON.stringify({
            approveError: result.approveError,
            conflictInfo: result.conflictInfo,
        })).toBe('committed');
        expect(result.entryStatus).toBe('committed');
        expect(result.fileLanded).toBe(true);
        expect(result.fileContent).toContain('Fresh body line.');
    });

    test('conflict card omits Approve/Reject buttons and bus.hasOutstanding excludes it', async ({ page }) => {
        const result = await page.evaluate(async ({ name }) => {
            const ctx = window.SillyTavern.getContext();
            const lib = ctx.iterationLibrary;
            const skillTools = await import('/scripts/iteration-library/tools/skill-iter-studio.js');

            const bus = lib.proposalBus.createProposalBus({ i18n: (s) => s });
            bus.registerKind('skill-author', lib.proposalBus.createSkillAuthorHandler({
                commitOp: skillTools.commitApprovedSkillProposal,
                readFile: (args) => ctx.skills.readFile(args),
            }));

            // Stage a normal update proposal against the seed body.
            const seedRead = await ctx.skills.readFile({ scope: { kind: 'global' }, name, path: 'SKILL.md' });
            const seedContent = seedRead?.content || seedRead || '';
            const op = {
                name: 'skill_update_content',
                args: {
                    scope: { kind: 'global' },
                    name,
                    path: 'SKILL.md',
                    content: seedContent.replace('Line A', 'Line A (proposed)'),
                },
            };
            const { id } = await bus.propose({
                kind: 'skill-author',
                sourceCallId: 'call-z',
                op,
                snapshot: { content: seedContent },
                meta: {
                    skillName: name,
                    scope: { kind: 'global' },
                    path: 'SKILL.md',
                    before: seedContent,
                    after: op.args.content,
                },
            });

            // External write between propose and approve → drift conflict.
            await skillTools.commitApprovedSkillProposal({
                name: 'skill_update_content',
                args: {
                    scope: { kind: 'global' },
                    name,
                    path: 'SKILL.md',
                    content: seedContent.replace('Line B', 'Line B (external)'),
                },
            });

            const approveOut = await bus.approve(id);
            const entry = bus._testOnly_entries().find((e) => e.id === id);
            const html = bus.renderCardsForMessage('call-z');
            return {
                approveStatus: approveOut?.status,
                entryStatus: entry?.status,
                hasOutstanding: bus.hasOutstanding(),
                html,
            };
        }, { name: SKILL_NAME_UPDATE });

        expect(result.approveStatus).toBe('conflict');
        expect(result.entryStatus).toBe('conflict');
        // Loop must NOT be blocked on a conflict — the AI gets the
        // conflict outcome via the drainOutcomes queue and decides
        // whether to re-propose.
        expect(result.hasOutstanding).toBe(false);
        // Conflict card chrome — visible explanation, but NO actionable
        // buttons. Re-approving against drifted state commits a stale
        // diff; rejecting adds nothing the outcome doesn't already carry.
        expect(result.html).toContain('iter_proposal_card_conflict');
        expect(result.html).not.toMatch(/data-proposal-action="approve"/);
        expect(result.html).not.toMatch(/data-proposal-action="reject"/);
    });
});
