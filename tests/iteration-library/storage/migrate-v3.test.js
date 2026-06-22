import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { migrateToV3, MigrationFailedError } from '/scripts/iteration-library/storage/migrate-v3.js';
import { decodeBackward } from '/scripts/iteration-library/storage/patch-codec.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
function loadFixture(name) {
    return JSON.parse(readFileSync(resolve(__dirname, 'fixtures', name), 'utf8'));
}

describe('migrateToV3', () => {
    test('v1 session with one set-path-empty edit migrates to v3 with inverse patch', () => {
        const old = {
            id: 's1', title: 'old', messages: [{
                id: 'm1', role: 'assistant',
                edits: [{ op: 'set', path: '', oldValue: { a: 1 }, newValue: { a: 2 } }],
            }],
            busState: { version: 2, entries: [], outcomeQueue: [] },
        };
        const migrated = migrateToV3(old, { defaultTargetForKind: () => ({ type: 'preset' }) });
        expect(migrated.version).toBe(3);
        expect(migrated.messages[0].edits[0].target).toEqual({ type: 'preset' });
        expect(migrated.messages[0].edits[0]).not.toHaveProperty('oldValue');
        expect(migrated.messages[0].edits[0]).not.toHaveProperty('newValue');
        const inv = migrated.messages[0].edits[0].inverse;
        expect(decodeBackward({ a: 2 }, inv)).toEqual({ a: 1 });
    });

    test('legacy target string "lorebook:My Book" -> object form', () => {
        const old = {
            id: 's1', messages: [{
                id: 'm1', role: 'assistant',
                edits: [{ op: 'set', path: '', oldValue: { entries: {} },
                          newValue: { entries: { 1: { content: 'x' } } },
                          target: 'lorebook:My Book' }],
            }],
        };
        const migrated = migrateToV3(old, { defaultTargetForKind: () => null });
        expect(migrated.messages[0].edits[0].target).toEqual({ type: 'lorebook', name: 'My Book' });
    });

    test('busState v2 entries migrate to v3 (target+inverse)', () => {
        const old = {
            id: 's1', messages: [],
            busState: {
                version: 2,
                entries: [{
                    id: 'profile-edit_1_a', kind: 'profile-edit', sourceCallId: 'c1',
                    op: { op: 'set', path: '', newValue: { a: 2 } },
                    snapshot: { a: 1 },
                    status: 'committed', fingerprint: 'fp', afterFingerprint: 'fp2',
                    createdAt: 0, decidedAt: 1, committedAt: 1,
                }],
                outcomeQueue: [],
            },
        };
        const migrated = migrateToV3(old, { defaultTargetForKind: () => ({ type: 'preset' }) });
        const e = migrated.busState.entries[0];
        expect(e.target).toEqual({ type: 'preset' });
        expect(e.inverse).toEqual([{ op: 'replace', path: '/a', value: 1 }]);
        expect(e).not.toHaveProperty('snapshot');
        expect(e).not.toHaveProperty('op');
        expect(e).not.toHaveProperty('fingerprint');
    });

    test('missing newValue throws MigrationFailedError with sessionId+turnId', () => {
        const old = {
            id: 's1', messages: [{
                id: 'm1', edits: [{ op: 'set', path: '', oldValue: { a: 1 } }],
            }],
        };
        expect(() => migrateToV3(old, { defaultTargetForKind: () => ({ type: 'preset' }) }))
            .toThrow(MigrationFailedError);
    });

    test('CEA per-target group: oldValue/newValue split across multiple targets', () => {
        const old = {
            id: 's1', messages: [{
                id: 'm1', role: 'assistant',
                edits: [
                    { op: 'set', path: '', oldValue: { name: 'A' }, newValue: { name: 'B' }, target: 'character' },
                    { op: 'set', path: '', oldValue: { entries: {} }, newValue: { entries: { 1: {} } },
                      target: 'lorebook:My Book' },
                ],
            }],
        };
        const migrated = migrateToV3(old, { defaultTargetForKind: () => null });
        expect(migrated.messages[0].edits[0].target).toEqual({ type: 'character' });
        expect(migrated.messages[0].edits[1].target).toEqual({ type: 'lorebook', name: 'My Book' });
    });
});

describe('migrateToV3 — real-shape fixtures', () => {
    test('CPA v2 fixture migrates: edits gain target=preset, bus entry gains inverse', () => {
        const cpa = loadFixture('cpa-v2-session.json');
        const out = migrateToV3(cpa, { defaultTargetForKind: () => ({ type: 'preset' }) });
        expect(out.version).toBe(3);
        expect(out.messages[1].edits[0].target).toEqual({ type: 'preset' });
        expect(Array.isArray(out.messages[1].edits[0].inverse)).toBe(true);
        expect(out.busState.version).toBe(3);
        expect(out.busState.entries[0].target).toEqual({ type: 'preset' });
        expect(Array.isArray(out.busState.entries[0].inverse)).toBe(true);
        expect(out.busState.entries[0]).not.toHaveProperty('snapshot');
    });

    test('MG v2 fixture migrates: edits gain target=schema, bus entry inverse round-trips', () => {
        const mg = loadFixture('mg-v2-session.json');
        const out = migrateToV3(mg, { defaultTargetForKind: () => ({ type: 'schema' }) });
        expect(out.version).toBe(3);
        expect(out.messages[1].edits[0].target).toEqual({ type: 'schema' });
        const inv = out.busState.entries[0].inverse;
        const newValue = { character: { name: 'x', affection: 0 } };
        expect(decodeBackward(newValue, inv)).toEqual({ character: { name: 'x' } });
    });

    test('orch v2 fixture migrates: profile-edit -> profile target, lorebook-write -> lorebook with book name', () => {
        const orch = loadFixture('orch-v2-session.json');
        const out = migrateToV3(orch, {
            defaultTargetForKind: (kind) => kind === 'lorebook-write'
                ? null
                : { type: 'profile', mode: orch.mode },
        });
        expect(out.version).toBe(3);
        expect(out.busState.entries[0].target).toEqual({ type: 'profile', mode: 'director' });
        expect(out.busState.entries[1].target).toEqual({ type: 'lorebook', name: 'World Lore' });
    });

    test('CEA v2 fixture migrates: per-edit character vs lorebook targets preserved', () => {
        const cea = loadFixture('cea-v2-session.json');
        const out = migrateToV3(cea, {
            defaultTargetForKind: (kind) => kind === 'cea-lorebook-edits'
                ? null
                : { type: 'character' },
        });
        expect(out.version).toBe(3);
        expect(out.messages[1].edits[0].target).toEqual({ type: 'character' });
        expect(out.messages[1].edits[1].target).toEqual({ type: 'lorebook', name: 'Aurora Lore' });
        expect(out.busState.entries[0].target).toEqual({ type: 'character' });
        expect(out.busState.entries[1].target).toEqual({ type: 'lorebook', name: 'Aurora Lore' });
    });
});

describe('migrateToV3 — skill-author bus entries', () => {
    // Production skill-author propose carries the skill name+path in `meta`
    // (it's also on `target` at runtime but `target._op` is stripped at
    // serialize time, so meta is the durable source). The migrator must
    // reconstruct `target: {type:'skill-registry', name, path}` rather than
    // falling through to defaultTargetForKind, which would mis-route to
    // `preset` (CPA) or `profile` (orch).
    test('skill-author bus entry reconstructs skill-registry target from meta', () => {
        const old = {
            id: 's1', messages: [],
            proposalBus: {
                version: 2,
                entries: [{
                    id: 'skill-author_1_a', kind: 'skill-author', sourceCallId: 'c1',
                    op: { op: 'set', path: '', newValue: { skillName: 'beach-walk', scope: 'character', path: 'beach-walk/SKILL.md' } },
                    snapshot:                    { skillName: 'beach-walk', scope: 'character', path: 'beach-walk/SKILL.md' },
                    meta: {
                        op: { name: 'skill_create_or_update', args: {} },
                        skillName: 'beach-walk',
                        scope: 'character',
                        path: 'beach-walk/SKILL.md',
                        before: null, after: null, extras: null,
                    },
                    status: 'pending',
                    createdAt: 0, decidedAt: null, committedAt: null,
                }],
                outcomeQueue: [],
            },
        };
        // Caller's defaultTargetForKind would mis-route — proving the migrator
        // special-cases skill-author rather than delegating.
        const out = migrateToV3(old, { defaultTargetForKind: () => ({ type: 'profile', mode: 'director' }) });
        const e = out.proposalBus.entries[0];
        expect(e.target).toEqual({ type: 'skill-registry', name: 'beach-walk', path: 'beach-walk/SKILL.md' });
        expect(e.kind).toBe('skill-author');
        expect(Array.isArray(e.inverse)).toBe(true);
    });

    test('skill-author bus entry falls back to legacy target.name when meta is absent', () => {
        const old = {
            id: 's1', messages: [],
            proposalBus: {
                version: 2,
                entries: [{
                    id: 'skill-author_2_b', kind: 'skill-author', sourceCallId: 'c2',
                    target: { type: 'skill-registry', name: 'flirt-banter', path: 'flirt-banter/SKILL.md' },
                    op: { op: 'set', path: '', newValue: { skillName: 'flirt-banter' } },
                    snapshot: { skillName: 'flirt-banter' },
                    status: 'pending',
                    createdAt: 0,
                }],
                outcomeQueue: [],
            },
        };
        const out = migrateToV3(old, { defaultTargetForKind: () => ({ type: 'profile', mode: 'director' }) });
        const e = out.proposalBus.entries[0];
        expect(e.target).toEqual({ type: 'skill-registry', name: 'flirt-banter', path: 'flirt-banter/SKILL.md' });
    });

    test('skill-author bus entry missing both meta and target.name fails migration', () => {
        const old = {
            id: 's1', messages: [],
            proposalBus: {
                version: 2,
                entries: [{
                    id: 'skill-author_3_c', kind: 'skill-author', sourceCallId: 'c3',
                    op: { op: 'set', path: '', newValue: {} },
                    snapshot: {},
                    status: 'pending',
                    createdAt: 0,
                }],
                outcomeQueue: [],
            },
        };
        expect(() => migrateToV3(old, { defaultTargetForKind: () => null }))
            .toThrow(MigrationFailedError);
    });
});
