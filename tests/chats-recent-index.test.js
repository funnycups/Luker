import { describe, test, expect } from '@jest/globals';
import path from 'node:path';

import { isPathUnderDirectory } from '../src/endpoints/chats.js';

// isPathUnderDirectory underpins recent-chat index invalidation after bulk
// chat directory removal. The boundary check via path.sep matters because the
// reported bug surfaces with character names that share a prefix ("Alice" was
// deleted, a new card got the name "Alice1") - a naive startsWith would
// invalidate the new card's chats too.

describe('isPathUnderDirectory', () => {
    const root = path.sep === '/' ? '/chats' : 'C:\\chats';
    const aliceDir = path.join(root, 'Alice');
    const alice1Dir = path.join(root, 'Alice1');

    test('matches the directory itself', () => {
        expect(isPathUnderDirectory(aliceDir, aliceDir)).toBe(true);
    });

    test('matches files inside the directory', () => {
        expect(
            isPathUnderDirectory(path.join(aliceDir, 'session1.jsonl'), aliceDir),
        ).toBe(true);
        expect(
            isPathUnderDirectory(path.join(aliceDir, 'nested', 'session2.jsonl'), aliceDir),
        ).toBe(true);
    });

    test('does not match sibling directory sharing a name prefix', () => {
        expect(isPathUnderDirectory(alice1Dir, aliceDir)).toBe(false);
        expect(
            isPathUnderDirectory(path.join(alice1Dir, 'session.jsonl'), aliceDir),
        ).toBe(false);
    });

    test('does not match unrelated paths', () => {
        expect(
            isPathUnderDirectory(path.join(root, 'Bob', 'session.jsonl'), aliceDir),
        ).toBe(false);
    });

    test('returns false on empty or missing inputs', () => {
        expect(isPathUnderDirectory('', aliceDir)).toBe(false);
        expect(isPathUnderDirectory(aliceDir, '')).toBe(false);
        expect(isPathUnderDirectory('', '')).toBe(false);
    });

    test('treats a trailing separator on the directory as equivalent', () => {
        const dirWithSep = aliceDir + path.sep;
        expect(
            isPathUnderDirectory(path.join(aliceDir, 'session.jsonl'), dirWithSep),
        ).toBe(true);
        expect(isPathUnderDirectory(alice1Dir, dirWithSep)).toBe(false);
    });
});
