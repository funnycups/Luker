import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { createBus } from '/scripts/iteration-library/proposal-bus/bus.js';
import { registerTarget, clearRegistry } from '/scripts/iteration-library/storage/target-registry.js';
import { skillAuthor } from '/scripts/iteration-library/proposal-bus/kinds/skill-author.js';
import { customToolAuthor } from '/scripts/iteration-library/proposal-bus/kinds/custom-tool-author.js';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let root;
beforeEach(() => {
    clearRegistry();
    root = fs.mkdtempSync(join(tmpdir(), 'bus-irreversible-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const fmt = (_s, ...args) => args.join('|');

// Synthetic JSON documents exercise bus policy, not application profile/skill targets.
function documentHandler(name, initial) {
    const file = join(root, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify(initial));
    const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
        read: async () => read(),
        write: jest.fn(async (_target, next) => { await fs.promises.writeFile(file, JSON.stringify(next)); }),
        describe: () => name,
        get: read,
    };
}

const SKILL_SHAPE = { skillName: 'reef-watch', scope: { kind: 'global' }, path: 'SKILL.md' };

function skillProposal(sourceCallId) {
    return {
        kind: 'irreversible-document',
        target: { type: 'irreversible-document' },
        before: SKILL_SHAPE,
        after: { ...SKILL_SHAPE, committed: true },
        sourceCallId,
    };
}

function message(id, callIds) {
    return { id, toolCalls: callIds.map((cid) => ({ id: cid })) };
}

describe('irreversible proposal kinds', () => {
    test('skill and custom-tool descriptors opt out of rollback', () => {
        expect(skillAuthor.inverseAvailable).toBe(false);
        expect(customToolAuthor.inverseAvailable).toBe(false);
    });

    test('rollback of a committed irreversible document does not write again', async () => {
        const skill = documentHandler('irreversible', SKILL_SHAPE);
        registerTarget('irreversible-document', skill);
        const bus = createBus();
        bus.registerKind('irreversible-document', { targetType: 'irreversible-document', inverseAvailable: false });
        const { id } = await bus.propose(skillProposal('c1'));
        await bus.approve(id);
        expect(skill.write).toHaveBeenCalledTimes(1);
        expect(skill.get()).toEqual({ ...SKILL_SHAPE, committed: true });
        expect(await bus.rollback(id)).toEqual({ ok: false, status: 'committed', reason: 'not_reversible' });
        expect(skill.write).toHaveBeenCalledTimes(1);
        expect(bus.listEntries()[0].status).toBe('committed');
    });

    test('an empty inverse on a reversible kind is skipped as well', async () => {
        const profile = documentHandler('reversible', { v: 1 });
        registerTarget('document', profile);
        const bus = createBus();
        bus.registerKind('k', { targetType: 'document' });
        const { id } = await bus.propose({ kind: 'k', target: { type: 'document' }, before: { v: 1 }, after: { v: 1 }, sourceCallId: 'c1' });
        await bus.approve(id);
        profile.write.mockClear();
        expect(await bus.rollback(id)).toEqual({ ok: false, status: 'committed', reason: 'not_reversible' });
        expect(profile.write).not.toHaveBeenCalled();
    });

    test('rollbackAllInMessages unwinds reversible documents and leaves irreversible commits alone', async () => {
        const skill = documentHandler('irreversible', SKILL_SHAPE);
        const profile = documentHandler('reversible', { v: 0 });
        registerTarget('irreversible-document', skill);
        registerTarget('document', profile);
        const bus = createBus();
        bus.registerKind('irreversible-document', { targetType: 'irreversible-document', inverseAvailable: false });
        bus.registerKind('document-edit', { targetType: 'document' });
        const s = await bus.propose(skillProposal('c1'));
        const p = await bus.propose({ kind: 'document-edit', target: { type: 'document' }, before: { v: 0 }, after: { v: 1 }, sourceCallId: 'c2' });
        await bus.approve(s.id);
        await bus.approve(p.id);
        const msgs = [message('m1', ['c1', 'c2'])];
        expect(bus.countCommittedInMessages(msgs)).toBe(1);
        const out = await bus.rollbackAllInMessages(msgs);
        expect(out.ok).toBe(true);
        expect(out.results.map((r) => r.id)).toEqual([p.id]);
        expect(profile.get()).toEqual({ v: 0 });
        expect(skill.write).toHaveBeenCalledTimes(1);
        expect(bus.countCommittedInMessages(msgs)).toBe(0);
    });

    test('rollbackAllInTurn and the turn row count only reversible entries', async () => {
        const skill = documentHandler('irreversible', SKILL_SHAPE);
        const profile = documentHandler('reversible', { v: 0 });
        registerTarget('irreversible-document', skill);
        registerTarget('document', profile);
        const bus = createBus({ i18n: fmt });
        bus.registerKind('irreversible-document', { targetType: 'irreversible-document', inverseAvailable: false });
        bus.registerKind('document-edit', { targetType: 'document' });
        const ids = [];
        ids.push((await bus.propose(skillProposal('c1'))).id);
        ids.push((await bus.propose({ kind: 'document-edit', target: { type: 'document' }, before: { v: 0 }, after: { v: 1 }, sourceCallId: 'c2' })).id);
        ids.push((await bus.propose({ kind: 'document-edit', target: { type: 'document' }, before: { v: 1 }, after: { v: 2 }, sourceCallId: 'c3' })).id);
        for (const id of ids) {
            await bus.approve(id);
        }
        const msg = message('m1', ['c1', 'c2', 'c3']);
        expect(bus.countCommittedInMessages([msg])).toBe(2);
        expect(bus.renderTurnActions(msg)).toContain('data-proposal-action="rollback-turn"');
        const out = await bus.rollbackAllInTurn(msg);
        expect(out.results).toHaveLength(2);
        expect(profile.get()).toEqual({ v: 0 });
        expect(skill.write).toHaveBeenCalledTimes(1);
    });
});
