import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ensureShadowRepo } from '../../../src/sync/shadow.js';
import {
    CONFLICTS_PATH, NOTICES_PATH, parseEntries, serializeEntries, mergeEntryMaps, readEntries, writeEntries,
} from '../../../src/sync/pipeline/conflict-records.js';

const OID = c => c.repeat(40);
const e = (createdAt, extra = {}) => ({ kept: OID('a'), ours: OID('b'), theirs: OID('c'), oursDevice: 'A', theirsDevice: 'B', mergeParents: [OID('d'), OID('e')], createdAt, ...extra });
const bytes = value => Buffer.from(JSON.stringify(value));

describe('entry-map merge', () => {
    test('an entry removed on one side is removed', () => {
        expect(mergeEntryMaps({ p: e('1') }, {}, { p: e('1') })).toEqual({});
        expect(mergeEntryMaps({ p: e('1') }, { p: e('1', { kept: OID('f') }) }, {})).toEqual({});
    });
    test('an entry removed on both sides is removed', () => {
        expect(mergeEntryMaps({ p: e('1') }, {}, {})).toEqual({});
    });
    test('an entry added on both sides with different content keeps the later createdAt', () => {
        const later = e('2026-10-13T11:00:00.000Z', { theirs: OID('9') });
        expect(mergeEntryMaps({}, { p: e('2026-10-13T10:00:00.000Z') }, { p: later })).toEqual({ p: later });
    });
    test('equal additions merge to one entry', () => {
        expect(mergeEntryMaps({}, { p: e('1') }, { p: e('1') })).toEqual({ p: e('1') });
    });
    test('a one-sided change wins over the base', () => {
        expect(mergeEntryMaps({ p: e('1') }, { p: e('1') }, { p: e('1', { kept: OID('7') }) })).toEqual({ p: e('1', { kept: OID('7') }) });
    });
    test('a both-sided change keeps the later createdAt and ours on a tie', () => {
        const o = e('2', { kept: OID('5') });
        const t = e('2', { kept: OID('6') });
        expect(mergeEntryMaps({ p: e('1') }, { p: o }, { p: t })).toEqual({ p: o });
        expect(mergeEntryMaps({ p: e('1') }, { p: o }, { p: e('3', { kept: OID('6') }) }).p.kept).toBe(OID('6'));
    });
    test('an entry keyed __proto__ stays an ordinary entry', () => {
        const ours = parseEntries(Buffer.from(`{"entries":{"__proto__":${JSON.stringify(e('1'))}}}`), 'conflicts');
        const merged = mergeEntryMaps({}, ours, {});
        expect(Object.keys(merged)).toEqual(['__proto__']);
        expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    });
});

describe('record files', () => {
    test('only absent record bytes read as no entries', () => {
        expect(() => parseEntries(Buffer.from('not json'), 'conflicts')).toThrow(expect.objectContaining({ code: 'PENDING_DOCUMENT_INVALID' }));
        expect(() => parseEntries(Buffer.from('{"entries":[]}'), 'conflicts')).toThrow(expect.objectContaining({ code: 'PENDING_DOCUMENT_INVALID' }));
        expect(parseEntries(null, 'notices')).toEqual({});
    });
    test('hostile entries are dropped', () => {
        const parsed = parseEntries(bytes({ entries: {
            '../outside.json': e('1'),
            'worlds/../x.json': e('1'),
            '.luker-sync/conflicts.json': e('1'),
            'worlds/bad-oid.json': e('1', { ours: 'not-an-oid' }),
            'worlds/bad-label.json': e('1', { oursDevice: { html: '<img src=x onerror=alert(1)>' } }),
            'worlds/ok.json': e('1', { theirsDevice: '<b>Phone</b>' }),
        } }), 'conflicts');
        expect(Object.keys(parsed)).toEqual(['worlds/ok.json']);
        expect(parsed['worlds/ok.json'].theirsDevice).toBe('<b>Phone</b>');
    });
    test('keys inside the sync metadata folder or naming it are dropped', () => {
        const parsed = parseEntries(bytes({ entries: {
            '.luker-sync': e('1'),
            '.luker-sync/x/y.json': e('1'),
            '.luker-sync-other/ok.json': e('1'),
        } }), 'conflicts');
        expect(Object.keys(parsed)).toEqual(['.luker-sync-other/ok.json']);
        const notice = { device: 'Phone', createdAt: '1', target: { kind: 'group', groupId: null, name: 'b' } };
        expect(parseEntries(bytes({ entries: { 'group chats/b.jsonl': { ...notice, chat: '.luker-sync' } } }), 'notices')).toEqual({});
    });
    test('an unknown record kind is an error', () => {
        expect(() => parseEntries(null, 'bogus')).toThrow('unknown sync record kind: bogus');
        expect(() => parseEntries(bytes({ entries: { a: e('1') } }), 'bogus')).toThrow('unknown sync record kind: bogus');
    });
    test('notice targets are validated', () => {
        const notice = { chat: 'chats/S/c.jsonl', device: 'Phone', createdAt: '1' };
        const parsed = parseEntries(bytes({ entries: {
            'chats/S/a.jsonl': { ...notice, target: { kind: 'character', avatar: 'S.png', name: 'a' } },
            'group chats/b.jsonl': { ...notice, target: { kind: 'group', groupId: null, name: 'b' } },
            'chats/S/c.jsonl': { ...notice, target: { kind: 'script', name: 'c' } },
            'chats/S/d.jsonl': { ...notice, chat: '../d.jsonl', target: { kind: 'character', avatar: 'S.png', name: 'd' } },
        } }), 'notices');
        expect(Object.keys(parsed).sort()).toEqual(['chats/S/a.jsonl', 'group chats/b.jsonl']);
    });
    test('notices are forks unless they name the restored kind', () => {
        const target = { kind: 'character', avatar: 'S.png', name: 'c' };
        const parsed = parseEntries(bytes({ entries: {
            'chats/S/a.jsonl': { chat: 'chats/S/c.jsonl', device: 'Phone', createdAt: '1', target },
            'chats/S/b.jsonl': { kind: 'fork', chat: 'chats/S/c.jsonl', device: 'Phone', createdAt: '1', target },
            'chats/S/c.jsonl': { kind: 'restored', device: 'Phone', createdAt: '1', target },
            'chats/S/d.jsonl': { kind: 'restored', device: 'Phone', createdAt: '1', target: { kind: 'script', name: 'd' } },
            'chats/S/e.jsonl': { kind: 'moved', chat: 'chats/S/c.jsonl', device: 'Phone', createdAt: '1', target },
            'chats/S/f.jsonl': { kind: 'restored', device: 'Phone', deletedBy: 'Desk', createdAt: '1', target },
            'chats/S/g.jsonl': { kind: 'restored', device: 'Phone', deletedBy: 7, createdAt: '1', target },
        } }), 'notices');
        expect(parsed).toEqual({
            'chats/S/a.jsonl': { kind: 'fork', chat: 'chats/S/c.jsonl', device: 'Phone', createdAt: '1', target },
            'chats/S/b.jsonl': { kind: 'fork', chat: 'chats/S/c.jsonl', device: 'Phone', createdAt: '1', target },
            'chats/S/c.jsonl': { kind: 'restored', device: 'Phone', createdAt: '1', target },
            'chats/S/f.jsonl': { kind: 'restored', device: 'Phone', deletedBy: 'Desk', createdAt: '1', target },
        });
    });
    test('serializeEntries is deterministic', () => {
        const text = serializeEntries({ b: e('1'), a: e('2') }).toString('utf8');
        expect(Object.keys(JSON.parse(text).entries)).toEqual(['a', 'b']);
        expect(parseEntries(Buffer.from(text), 'conflicts')).toEqual({ a: e('2'), b: e('1') });
    });

    describe('in a repository', () => {
        let userRoot;
        let gitdir;
        beforeEach(async () => {
            userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-records-'));
            ({ gitDir: gitdir } = await ensureShadowRepo({ userRoot, peerId: 'p' }));
        });
        afterEach(() => fs.rmSync(userRoot, { recursive: true, force: true }));

        test('writeEntries round-trips and removes the path when no entries remain', async () => {
            const files = new Map();
            await writeEntries({ gitdir, files, path: CONFLICTS_PATH, entries: { 'worlds/w.json': e('1') } });
            expect(await readEntries({ gitdir, files, path: CONFLICTS_PATH, kind: 'conflicts' })).toEqual({ 'worlds/w.json': e('1') });
            expect(files.get(CONFLICTS_PATH).mode).toBe('100644');
            await writeEntries({ gitdir, files, path: CONFLICTS_PATH, entries: {} });
            expect(files.has(CONFLICTS_PATH)).toBe(false);
            expect(await readEntries({ gitdir, files, path: NOTICES_PATH, kind: 'notices' })).toEqual({});
        });
    });
});
