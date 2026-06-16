/**
 * ProposalBus — real-browser, real-disk coverage across the dimensions
 * the four iter-studio popups (orchestrator / CPA / CEA / MG) rely on
 * after migrating onto the shared bus.
 *
 * Why this spec exists:
 *   The Jest suites under tests/iteration-library/proposal-bus/* cover
 *   the bus state machine in isolation (mocked handlers, fake disk).
 *   The four popup smokes under tests/frontend/*IterationSmoke.e2e.js
 *   only check ST boot doesn't pageerror after the migration. Nothing
 *   exercises the bus + a real KindHandler + the live skillsApi in the
 *   same real-browser session — so a regression that breaks disk
 *   commits (e.g. a wrong arg shape in commitApprovedSkillProposal,
 *   or a hash mismatch in the drift path) silently passes everything
 *   except a manual user test.
 *
 *   This spec wires a real bus via getContext().iterationLibrary.proposalBus
 *   in the page, registers the real skill-author kind against the live
 *   skillsApi, and walks each dimension the migration introduced:
 *
 *     1. propose → snapshot captured, disk untouched
 *     2. approve → commit hits disk via real skillsApi
 *     3. reject → entry rejected, disk stays at pre-propose state
 *     4. drift conflict — external write between propose+approve traps
 *        the entry in 'conflict' instead of clobbering disk
 *     5. persistence — serialize() round-trips: hydrate() rebuilds the
 *        same entry shape (so a popup re-open after refresh restores
 *        pending entries instead of losing them)
 *     6. auto-approve — setAutoApprove(true) drains pending entries to
 *        committed inside one microtask flush (mirrors the popup's
 *        surfaceState.autoApply toggle)
 *
 *   No LLM, no plugin UI — the bus IS the unit under test. The popup-
 *   shell UX (data-proposal-action click delegation, render-card output,
 *   turn-actions wiring) is covered by the IterationStudioAdapterSmoke
 *   suite plus the proposal-bus Jest tests; combining all three would
 *   require driving the orchestrator popup which the standing smoke
 *   already does. This spec stays focused on the parts that need a real
 *   filesystem to be meaningful.
 */

import { test, expect } from '@playwright/test';
import {
    awaitMainUI,
    ensureSkillsApiAvailable,
} from './helpers.js';

// Per-test unique skill name. The playwright runner uses workers:4 by
// default (playwright.config.js), and tests inside one spec file are
// distributed across workers — so two specs in this file can otherwise
// race on the same `data/default-user/skills/global/<name>` directory,
// where one's `delete` collides with another's `install` (the install
// uses an atomic `.staging-<name>-<rand>` → rename pattern that fails
// with ENOENT if a sibling worker just removed the parent).
//
// `serial` mode forces tests in this file to run sequentially on one
// worker, which is the correct discipline anyway: each test does a
// full propose → approve → mutate-disk cycle on the same global
// skill scope and the assertions assume an undisturbed filesystem
// between steps. Letting them overlap would create false drift
// detection failures whose root cause is the test fixture itself.
test.describe.configure({ mode: 'serial' });

// One name shared by all tests — `mode: 'serial'` + the beforeEach/
// afterEach install + cleanup keeps the filesystem clean between
// runs without needing per-test name suffixes.
const SKILL_NAME = 'proposal-bus-flows-spec';

function buildSeed(name) {
    return [
        '---',
        `name: ${name}`,
        'description: seed body for ProposalBus real-flow spec',
        '---',
        '# Heading',
        '',
        'Line A',
        'Line B',
        'Line C',
        '',
    ].join('\n');
}

function buildEdit(name) {
    return [
        '---',
        `name: ${name}`,
        'description: seed body for ProposalBus real-flow spec',
        '---',
        '# Heading',
        '',
        'Line A (changed)',
        'Line B',
        'Line C',
        'Line D (new)',
        '',
    ].join('\n');
}

/**
 * Install the skill seed on disk through the live API. Idempotent — any
 * leftover from a crashed run is removed first so the test can rerun
 * without manual cleanup.
 */
async function installSeed(page, { name }) {
    await page.evaluate(async ({ name, body }) => {
        const ctx = window.SillyTavern.getContext();
        try { await ctx.skills.delete({ kind: 'global' }, name); } catch { /* not present */ }
        await ctx.skills.install({
            scope: { kind: 'global' },
            payload: { files: [{ path: 'SKILL.md', encoding: 'utf8', content: body }] },
        });
    }, { name, body: buildSeed(name) });
}

async function readSkillBody(page, { name }) {
    return await page.evaluate(async ({ name }) => {
        const ctx = window.SillyTavern.getContext();
        const raw = await ctx.skills.readFile({ scope: { kind: 'global' }, name, path: 'SKILL.md' });
        return raw?.content || raw || '';
    }, { name });
}

async function cleanup(page, { name }) {
    await page.evaluate(async ({ name }) => {
        const ctx = window.SillyTavern.getContext();
        try { await ctx.skills.delete({ kind: 'global' }, name); } catch { /* gone */ }
    }, { name });
}

test.describe('ProposalBus — real-browser, real-disk flows over the skill-author kind', () => {
    test.setTimeout(60_000);

    test.beforeEach(async ({ page }) => {
        await awaitMainUI(page);
        await ensureSkillsApiAvailable(page);
        await installSeed(page, { name: SKILL_NAME });
    });

    test.afterEach(async ({ page }) => {
        await cleanup(page, { name: SKILL_NAME });
    });

    test('iterationLibrary.proposalBus is reachable via the public API surface', async ({ page }) => {
        const surface = await page.evaluate(() => {
            const lib = window.SillyTavern?.getContext?.()?.iterationLibrary;
            const bus = lib?.proposalBus;
            return {
                hasNamespace: typeof bus === 'object',
                hasFactory: typeof bus?.createProposalBus === 'function',
                hasSkillAuthor: typeof bus?.createSkillAuthorHandler === 'function',
                hasProfileEdit: typeof bus?.createProfileEditHandler === 'function',
                hasLorebookWrite: typeof bus?.createLorebookWriteHandler === 'function',
                hasPresetClone: typeof bus?.createPresetCloneHandler === 'function',
                hasFingerprint: typeof bus?.sha256OfJson === 'function',
            };
        });
        expect(surface).toEqual({
            hasNamespace: true,
            hasFactory: true,
            hasSkillAuthor: true,
            hasProfileEdit: true,
            hasLorebookWrite: true,
            hasPresetClone: true,
            hasFingerprint: true,
        });
    });

    test('propose stages, approve commits, reject leaves disk alone', async ({ page }) => {
        const result = await page.evaluate(async ({ name, edited }) => {
            const ctx = window.SillyTavern.getContext();
            const lib = ctx.iterationLibrary;
            // Import the live commit helper from the iter-library tools
            // namespace via a dynamic import — this is the same helper
            // the four popups inject into createSkillAuthorHandler.
            const skillTools = await import('/scripts/iteration-library/tools/skill-iter-studio.js');

            const bus = lib.proposalBus.createProposalBus({ i18n: (s) => s });
            const skillHandler = lib.proposalBus.createSkillAuthorHandler({
                commitOp: skillTools.commitApprovedSkillProposal,
                readFile: (args) => ctx.skills.readFile(args),
            });
            bus.registerKind('skill-author', skillHandler);

            const op = {
                name: 'skill_update_content',
                args: { scope: { kind: 'global' }, name, path: 'SKILL.md', content: edited },
            };
            // Capture the snapshot the popup would capture (current disk).
            const seedRead = await ctx.skills.readFile({ scope: { kind: 'global' }, name, path: 'SKILL.md' });
            const snapshot = { content: (seedRead?.content || seedRead || '') };

            // ── 1. Propose: bus accepts the op, disk untouched.
            const { id } = await bus.propose({ kind: 'skill-author', sourceCallId: 'call-1', op, snapshot });
            const afterPropose = await ctx.skills.readFile({ scope: { kind: 'global' }, name, path: 'SKILL.md' });
            const proposedEntry = bus._testOnly_entries().find((e) => e.id === id);

            // ── 2. Approve: bus commits via skillsApi, disk now matches `edited`.
            const approveOut = await bus.approve(id);
            const afterApprove = await ctx.skills.readFile({ scope: { kind: 'global' }, name, path: 'SKILL.md' });
            const approvedEntry = bus._testOnly_entries().find((e) => e.id === id);

            // ── 3. Reject a fresh proposal: bus marks rejected, disk stays
            //   at the just-committed `edited` state (no rollback fires on
            //   reject — that's only for committed entries via rollback()).
            const op2 = {
                name: 'skill_update_content',
                args: {
                    scope: { kind: 'global' }, name, path: 'SKILL.md',
                    content: edited.replace('Line A (changed)', 'Line A (REJECTED ATTEMPT)'),
                },
            };
            const snapshot2 = { content: edited };
            const { id: id2 } = await bus.propose({ kind: 'skill-author', sourceCallId: 'call-2', op: op2, snapshot: snapshot2 });
            bus.reject(id2);
            const afterReject = await ctx.skills.readFile({ scope: { kind: 'global' }, name, path: 'SKILL.md' });
            const rejectedEntry = bus._testOnly_entries().find((e) => e.id === id2);

            return {
                proposed: {
                    status: proposedEntry?.status,
                    diskUntouched: (afterPropose?.content || afterPropose || '').includes('Line A\nLine B'),
                    diskHasEdited: (afterPropose?.content || afterPropose || '').includes('Line A (changed)'),
                },
                approved: {
                    status: approvedEntry?.status,
                    approveOk: approveOut?.ok === true,
                    diskHasEdited: (afterApprove?.content || afterApprove || '').includes('Line A (changed)'),
                    diskHasNewLine: (afterApprove?.content || afterApprove || '').includes('Line D (new)'),
                },
                rejected: {
                    status: rejectedEntry?.status,
                    diskUnchangedSinceApprove:
                        (afterReject?.content || afterReject || '').includes('Line A (changed)') &&
                        !(afterReject?.content || afterReject || '').includes('REJECTED ATTEMPT'),
                },
            };
        }, { name: SKILL_NAME, edited: buildEdit(SKILL_NAME) });

        expect(result.proposed.status).toBe('pending');
        expect(result.proposed.diskUntouched, 'disk still seed-shaped after propose').toBe(true);
        expect(result.proposed.diskHasEdited, 'disk does NOT have edited content yet').toBe(false);

        expect(result.approved.approveOk).toBe(true);
        expect(result.approved.status).toBe('committed');
        expect(result.approved.diskHasEdited).toBe(true);
        expect(result.approved.diskHasNewLine).toBe(true);

        expect(result.rejected.status).toBe('rejected');
        expect(result.rejected.diskUnchangedSinceApprove,
            'rejected proposal must NOT touch disk; disk still matches the prior approved state').toBe(true);
    });

    test('drift conflict — external write between propose and approve parks entry in conflict', async ({ page }) => {
        const result = await page.evaluate(async ({ name, edited }) => {
            const ctx = window.SillyTavern.getContext();
            const lib = ctx.iterationLibrary;
            const skillTools = await import('/scripts/iteration-library/tools/skill-iter-studio.js');

            const bus = lib.proposalBus.createProposalBus({ i18n: (s) => s });
            bus.registerKind('skill-author', lib.proposalBus.createSkillAuthorHandler({
                commitOp: skillTools.commitApprovedSkillProposal,
                readFile: (args) => ctx.skills.readFile(args),
            }));

            // 1. Capture proposal-time snapshot from disk.
            const seedRead = await ctx.skills.readFile({ scope: { kind: 'global' }, name, path: 'SKILL.md' });
            const snapshot = { content: seedRead?.content || seedRead || '' };

            // 2. Propose with that snapshot.
            const op = {
                name: 'skill_update_content',
                args: { scope: { kind: 'global' }, name, path: 'SKILL.md', content: edited },
            };
            const { id } = await bus.propose({ kind: 'skill-author', sourceCallId: 'call-1', op, snapshot });

            // 3. ── External write ── another agent (the test, here)
            //    rewrites the file out-of-band before approve runs. The
            //    bus's drift check should fingerprint-mismatch and refuse
            //    to commit.
            const externalBody = snapshot.content.replace('Line B', 'Line B (EXTERNAL EDIT)');
            await skillTools.commitApprovedSkillProposal({
                name: 'skill_update_content',
                args: { scope: { kind: 'global' }, name, path: 'SKILL.md', content: externalBody },
            });

            // 4. Approve — must go to 'conflict', not 'committed'.
            const approveOut = await bus.approve(id);
            const afterApprove = await ctx.skills.readFile({ scope: { kind: 'global' }, name, path: 'SKILL.md' });
            const conflictEntry = bus._testOnly_entries().find((e) => e.id === id);

            return {
                approveOk: approveOut?.ok === true,
                approveStatus: approveOut?.status,
                entryStatus: conflictEntry?.status,
                entryConflictInfoPresent: !!conflictEntry?.conflictInfo,
                fingerprintDiffers:
                    conflictEntry?.conflictInfo?.expectedFingerprint !==
                    conflictEntry?.conflictInfo?.actualFingerprint,
                diskMatchesExternal: (afterApprove?.content || afterApprove || '').includes('Line B (EXTERNAL EDIT)'),
                diskNotProposalEdit: !(afterApprove?.content || afterApprove || '').includes('Line A (changed)'),
            };
        }, { name: SKILL_NAME, edited: buildEdit(SKILL_NAME) });

        expect(result.approveOk).toBe(false);
        expect(result.approveStatus).toBe('conflict');
        expect(result.entryStatus).toBe('conflict');
        expect(result.entryConflictInfoPresent).toBe(true);
        expect(result.fingerprintDiffers).toBe(true);
        expect(result.diskMatchesExternal,
            'disk must still match the external write — bus refused to clobber').toBe(true);
        expect(result.diskNotProposalEdit,
            'disk must NOT have the proposal\'s after-image — that would be a clobber').toBe(true);
    });

    test('serialize → hydrate round-trip preserves entries verbatim', async ({ page }) => {
        const result = await page.evaluate(async ({ name, edited }) => {
            const ctx = window.SillyTavern.getContext();
            const lib = ctx.iterationLibrary;
            const skillTools = await import('/scripts/iteration-library/tools/skill-iter-studio.js');

            const makeBus = () => {
                const bus = lib.proposalBus.createProposalBus({ i18n: (s) => s });
                bus.registerKind('skill-author', lib.proposalBus.createSkillAuthorHandler({
                    commitOp: skillTools.commitApprovedSkillProposal,
                    readFile: (args) => ctx.skills.readFile(args),
                }));
                return bus;
            };

            // Bus 1: propose, then serialize.
            const bus1 = makeBus();
            const op = {
                name: 'skill_update_content',
                args: { scope: { kind: 'global' }, name, path: 'SKILL.md', content: edited },
            };
            const seedRead = await ctx.skills.readFile({ scope: { kind: 'global' }, name, path: 'SKILL.md' });
            const snapshot = { content: seedRead?.content || seedRead || '' };
            const { id } = await bus1.propose({ kind: 'skill-author', sourceCallId: 'call-1', op, snapshot });
            const blob = bus1.serialize();

            // Bus 2: fresh bus, hydrate from blob, verify entry resurrected
            // and approving from the second bus still hits disk correctly.
            const bus2 = makeBus();
            bus2.hydrate(blob);
            const hydratedEntry = bus2._testOnly_entries().find((e) => e.id === id);
            const approveOut = await bus2.approve(id);
            const afterApprove = await ctx.skills.readFile({ scope: { kind: 'global' }, name, path: 'SKILL.md' });

            return {
                blobVersion: blob?.version,
                blobEntriesLength: blob?.entries?.length,
                hydratedEntryStatus: hydratedEntry?.status,
                hydratedEntryHasFingerprint: !!hydratedEntry?.fingerprint,
                hydratedEntrySnapshotIntact: hydratedEntry?.snapshot?.content === snapshot.content,
                approveOk: approveOut?.ok === true,
                diskCommitted: (afterApprove?.content || afterApprove || '').includes('Line A (changed)'),
            };
        }, { name: SKILL_NAME, edited: buildEdit(SKILL_NAME) });

        expect(result.blobVersion).toBe(2);
        expect(result.blobEntriesLength).toBe(1);
        expect(result.hydratedEntryStatus).toBe('pending');
        expect(result.hydratedEntryHasFingerprint).toBe(true);
        expect(result.hydratedEntrySnapshotIntact,
            'snapshot survives JSON round-trip unchanged').toBe(true);
        expect(result.approveOk).toBe(true);
        expect(result.diskCommitted,
            'approving from the hydrated bus successfully reaches disk').toBe(true);
    });

    test('auto-approve drains pending entries on the next microtask flush', async ({ page }) => {
        const result = await page.evaluate(async ({ name, edited }) => {
            const ctx = window.SillyTavern.getContext();
            const lib = ctx.iterationLibrary;
            const skillTools = await import('/scripts/iteration-library/tools/skill-iter-studio.js');

            const bus = lib.proposalBus.createProposalBus({ i18n: (s) => s });
            bus.registerKind('skill-author', lib.proposalBus.createSkillAuthorHandler({
                commitOp: skillTools.commitApprovedSkillProposal,
                readFile: (args) => ctx.skills.readFile(args),
            }));
            bus.setAutoApprove(true);

            const seedRead = await ctx.skills.readFile({ scope: { kind: 'global' }, name, path: 'SKILL.md' });
            const snapshot = { content: seedRead?.content || seedRead || '' };

            const op = {
                name: 'skill_update_content',
                args: { scope: { kind: 'global' }, name, path: 'SKILL.md', content: edited },
            };
            const { id } = await bus.propose({ kind: 'skill-author', sourceCallId: 'call-1', op, snapshot });

            // The bus's auto-approve uses queueMicrotask. Allow one tick.
            await new Promise((r) => setTimeout(r, 0));
            // queueMicrotask may schedule across a couple of awaits in the
            // bus's own approval pipeline (readCurrent + commit are both
            // async). Give it up to ~200ms to settle.
            const start = Date.now();
            while (Date.now() - start < 500) {
                const e = bus._testOnly_entries().find((x) => x.id === id);
                if (e && e.status !== 'pending') break;
                await new Promise((r) => setTimeout(r, 10));
            }

            const finalEntry = bus._testOnly_entries().find((e) => e.id === id);
            const afterDrain = await ctx.skills.readFile({ scope: { kind: 'global' }, name, path: 'SKILL.md' });
            return {
                autoApproveActive: bus.isAutoApprove() === true,
                finalStatus: finalEntry?.status,
                diskCommitted: (afterDrain?.content || afterDrain || '').includes('Line A (changed)'),
            };
        }, { name: SKILL_NAME, edited: buildEdit(SKILL_NAME) });

        expect(result.autoApproveActive).toBe(true);
        expect(result.finalStatus,
            'auto-approve should have drained the entry to committed').toBe('committed');
        expect(result.diskCommitted,
            'auto-approve commit must reach disk via the real skillsApi').toBe(true);
    });

    test('rollback on a committed entry restores prior disk content via inverse', async ({ page }) => {
        const result = await page.evaluate(async ({ name, edited }) => {
            const ctx = window.SillyTavern.getContext();
            const lib = ctx.iterationLibrary;
            const skillTools = await import('/scripts/iteration-library/tools/skill-iter-studio.js');

            const bus = lib.proposalBus.createProposalBus({ i18n: (s) => s });
            bus.registerKind('skill-author', lib.proposalBus.createSkillAuthorHandler({
                commitOp: skillTools.commitApprovedSkillProposal,
                readFile: (args) => ctx.skills.readFile(args),
            }));

            const seedRead = await ctx.skills.readFile({ scope: { kind: 'global' }, name, path: 'SKILL.md' });
            const seedBody = seedRead?.content || seedRead || '';
            const snapshot = { content: seedBody };
            const op = {
                name: 'skill_update_content',
                args: { scope: { kind: 'global' }, name, path: 'SKILL.md', content: edited },
            };
            const { id } = await bus.propose({ kind: 'skill-author', sourceCallId: 'call-1', op, snapshot });
            await bus.approve(id);
            const afterApprove = await ctx.skills.readFile({ scope: { kind: 'global' }, name, path: 'SKILL.md' });

            const rollbackOut = await bus.rollback(id);
            const afterRollback = await ctx.skills.readFile({ scope: { kind: 'global' }, name, path: 'SKILL.md' });
            const finalEntry = bus._testOnly_entries().find((e) => e.id === id);

            return {
                approvedDiskHasEdit: (afterApprove?.content || afterApprove || '').includes('Line A (changed)'),
                rollbackOk: rollbackOut?.ok === true,
                finalStatus: finalEntry?.status,
                diskMatchesSeed: (afterRollback?.content || afterRollback || '') === seedBody,
            };
        }, { name: SKILL_NAME, edited: buildEdit(SKILL_NAME) });

        expect(result.approvedDiskHasEdit).toBe(true);
        expect(result.rollbackOk).toBe(true);
        expect(result.finalStatus).toBe('rolledBack');
        expect(result.diskMatchesSeed,
            'rollback must restore disk byte-for-byte to the pre-commit snapshot').toBe(true);
    });
});
