import { beforeEach, afterEach, test, expect } from '@jest/globals';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBus } from '/scripts/iteration-library/proposal-bus/bus.js';
import { registerTarget, clearRegistry } from '/scripts/iteration-library/storage/target-registry.js';
import { rollbackFailKeyForTargetType, STR } from '/scripts/iteration-library/ui/strings.js';

// A synthetic JSON-file target exercises the real bus, registry and codec.
// It does not replace any application's persistence implementation.
let root;
let file;
const target = { type: 'json-fixture', name: 'document' };
const read = async () => JSON.parse(await fs.readFile(file, 'utf8'));
const write = async (doc) => fs.writeFile(file, JSON.stringify(doc));
function busFor(data) {
    const bus = createBus();
    bus.registerKind('fixture', { targetType: target.type });
    if (data) bus.hydrate(JSON.parse(JSON.stringify(data)));
    return bus;
}
beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'proposal-drift-'));
    file = join(root, 'document.json');
    clearRegistry();
    registerTarget(target.type, { read, write: async (_target, doc) => write(doc), describe: () => 'fixture' });
});
afterEach(async () => {
    clearRegistry();
    await fs.rm(root, { recursive: true, force: true });
});

const changes = [
    ['replace', { a: 'old', other: 1 }, { a: 'new', other: 1 }, { a: 'external', other: 1 }],
    ['add', { other: 1 }, { a: 'new', other: 1 }, { a: 'external', other: 1 }],
    ['remove', { a: 'old', other: 1 }, { other: 1 }, { a: 'external', other: 1 }],
    ['array insert', { a: ['x'], other: 1 }, { a: ['x', 'new'], other: 1 }, { a: ['x', 'external'], other: 1 }],
    ['array remove', { a: ['x', 'old'], other: 1 }, { a: ['x'], other: 1 }, { a: ['x', 'external'], other: 1 }],
    ['root', ['old'], ['new'], ['external']],
];
test.each(changes)('restored approval refuses overlapping %s drift', async (_name, before, after, external) => {
    await write(before);
    const bus = busFor();
    const { id } = await bus.propose({ kind: 'fixture', target, before, after });
    await write(external);
    expect((await busFor(bus.serialize()).approve(id)).status).toBe('conflict');
    expect(await read()).toEqual(external);
});
test.each(changes)('restored rollback refuses overlapping %s drift through all rollback entry points', async (_name, before, after, external) => {
    for (const route of ['single', 'turn', 'messages']) {
        await write(before);
        const bus = busFor();
        const { id } = await bus.propose({ kind: 'fixture', target, before, after, sourceCallId: 'call' });
        expect((await bus.approve(id)).ok).toBe(true);
        await write(external);
        const restored = busFor(bus.serialize());
        const message = { toolCalls: [{ id: 'call' }] };
        const result = route === 'single' ? await restored.rollback(id)
            : route === 'turn' ? (await restored.rollbackAllInTurn(message)).results[0]
                : (await restored.rollbackAllInMessages([message])).results[0];
        expect(result.status).toBe('conflict');
        expect(await read()).toEqual(external);
    }
});
test.each(changes.filter(([name]) => name !== 'root'))('restored %s approval and rollback preserve disjoint external edits', async (_name, before, after) => {
    await write(before);
    const bus = busFor();
    const { id } = await bus.propose({ kind: 'fixture', target, before, after });
    await write({ ...before, other: 9 });
    const restored = busFor(bus.serialize());
    expect((await restored.approve(id)).ok).toBe(true);
    expect(await read()).toEqual({ ...after, other: 9 });
    await write({ ...after, other: 10 });
    expect((await busFor(restored.serialize()).rollback(id)).ok).toBe(true);
    expect(await read()).toEqual({ ...before, other: 10 });
});
test('legacy array insert without expectations safely refuses approval', async () => {
    const before = { a: ['x'] };
    await write(before);
    const bus = busFor();
    const { id } = await bus.propose({ kind: 'fixture', target, before, after: { a: ['x', 'new'] } });
    const data = bus.serialize();
    delete data.entries[0].driftExpectations;
    expect((await busFor(data).approve(id)).status).toBe('conflict');
    expect(await read()).toEqual(before);
});

test('restored array approval chains unwind dependent commits in reverse proposal order', async () => {
    const before = { a: ['x'] };
    await write(before);
    const bus = busFor();
    const first = await bus.propose({ kind: 'fixture', target, before, after: { a: ['x', 'one'] }, sourceCallId: 'call' });
    const next = await bus.getCurrentPendingState('fixture', target);
    const second = await bus.propose({ kind: 'fixture', target, before: next, after: { a: ['x', 'one', 'two'] }, sourceCallId: 'call' });
    const restored = busFor(bus.serialize());
    expect((await restored.approve(first.id)).ok).toBe(true);
    expect((await restored.approve(second.id)).ok).toBe(true);
    const data = restored.serialize();
    for (const entry of data.entries) entry.committedAt = 1;
    expect((await busFor(data).rollbackAllInMessages([{ toolCalls: [{ id: 'call' }] }])).ok).toBe(true);
    expect(await read()).toEqual(before);
});

test('unknown kinds do not contribute hidden entries to turn actions', () => {
    const bus = busFor({ version: 3, entries: [{ id: 'missing', kind: 'removed', status: 'committed', sourceCallId: 'call', inverse: [{ op: 'replace', path: '/a', value: 1 }] }] });
    expect(bus.renderCardsForMessage('call')).toBe('');
    expect(bus.renderTurnActions('call')).toBe('');
});

test('orchestrator lorebook targets use the shared lorebook conflict category', () => {
    expect(rollbackFailKeyForTargetType('orch-lorebook')).toBe(STR.rollbackFail_lorebook);
});

test('pre-branch committed entries without forward or driftExpectations still roll back non-array patches and refuse array patches', async () => {
    await write({ title: 'after', other: 1 });
    const objectBus = busFor({
        version: 3,
        entries: [{
            id: 'legacy_obj_1',
            kind: 'fixture',
            target,
            status: 'committed',
            inverse: [{ op: 'replace', path: '/title', value: 'before' }],
        }],
    });
    expect((await objectBus.rollback('legacy_obj_1')).ok).toBe(true);
    expect(await read()).toEqual({ title: 'before', other: 1 });

    await write({ items: ['a', 'b'] });
    const arrayBus = busFor({
        version: 3,
        entries: [{
            id: 'legacy_arr_1',
            kind: 'fixture',
            target,
            status: 'committed',
            inverse: [{ op: 'remove', path: '/items/1' }],
        }],
    });
    expect((await arrayBus.rollback('legacy_arr_1')).status).toBe('conflict');
    expect(await read()).toEqual({ items: ['a', 'b'] });
});
