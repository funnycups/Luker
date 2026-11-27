// Tests the post-CHARACTER_REPLACED diff helpers in CEA post-replace/seed.js
// that feed the iter-studio's seedSystemMessage:
//   - summarizeCharacterDiff: per-field add / remove / change with excerpt
//   - summarizeLorebookDiff: per-uid add / remove / change with the changed
//     field list, plus the "primary book renamed" short-circuit
//   - buildPostReplaceSeedMessage: end-to-end seed assembly, falling back to
//     the "no previous version" string when previousCharacter is missing.
//
// seed.js reaches live-state.js, which imports the edits engine; the
// engine's conflict UI imports popup.js, which is replaced so the
// SillyTavern DOM shell stays out of the import graph.

import { describe, expect, jest, test, beforeAll, afterAll } from '@jest/globals';
import lodash from 'lodash';
import { installBrowserModuleContext } from '../util/browser-module-context.js';

jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
    POPUP_TYPE: { DISPLAY: 'display' },
    POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 2, CANCELLED: 0 },
    Popup: class { constructor() {} show() { return Promise.resolve(''); } },
}));

let CEA;
let browserEnv;
beforeAll(async () => {
    browserEnv = installBrowserModuleContext({ lib: { lodash } });
    CEA = await import('../../public/scripts/extensions/character-editor-assistant/post-replace/seed.js');
});

afterAll(() => {
    browserEnv?.restore();
});

describe('summarizeCharacterDiff', () => {
    test('detects changed top-level field with prev/next full values inline', () => {
        // Short values render inline as `- prev: ...` / `- next: ...`
        // wrapped in inline-code backticks so markdown does not eat any
        // special characters in the excerpt.
        const prev = { name: 'Alice', description: 'Old description here.' };
        const next = { name: 'Alice', description: 'A brand new description.' };
        const lines = CEA.summarizeCharacterDiff(prev, next);
        expect(lines.some(l => l.includes('`description`'))).toBe(true);
        expect(lines.some(l => l.includes('`Old description here.`'))).toBe(true);
        expect(lines.some(l => l.includes('`A brand new description.`'))).toBe(true);
        expect(lines.some(l => l.includes('`name`'))).toBe(false);
    });

    test('detects added field present only on next', () => {
        const prev = { name: 'Alice' };
        const next = { name: 'Alice', personality: 'Calm and steady.' };
        const lines = CEA.summarizeCharacterDiff(prev, next);
        expect(lines.some(l => l.includes('`personality`'))).toBe(true);
        expect(lines.some(l => l.includes('`Calm and steady.`'))).toBe(true);
        expect(lines.some(l => l.includes('- prev:'))).toBe(false);
    });

    test('detects removed field present only on prev', () => {
        const prev = { name: 'Alice', scenario: 'Forest meeting.' };
        const next = { name: 'Alice' };
        const lines = CEA.summarizeCharacterDiff(prev, next);
        expect(lines.some(l => l.includes('`scenario`'))).toBe(true);
        expect(lines.some(l => l.includes('`Forest meeting.`'))).toBe(true);
        expect(lines.some(l => l.includes('- next:'))).toBe(false);
    });

    test('diffs nested data.* fields', () => {
        const prev = { name: 'A', data: { description: 'short' } };
        const next = { name: 'A', data: { description: 'updated' } };
        const lines = CEA.summarizeCharacterDiff(prev, next);
        expect(lines.some(l => l.includes('`data.description`'))).toBe(true);
        expect(lines.some(l => l.includes('`short`'))).toBe(true);
        expect(lines.some(l => l.includes('`updated`'))).toBe(true);
    });

    test('returns empty array when nothing changed', () => {
        const prev = { name: 'A', description: 'same' };
        const next = { name: 'A', description: 'same' };
        expect(CEA.summarizeCharacterDiff(prev, next)).toEqual([]);
    });

    test('renders long values verbatim inside fenced blocks (no silent truncation)', () => {
        // Long content used to be silently clipped at 240 chars with an
        // ellipsis, giving the AI a partial view of what actually
        // changed and blocking meaningful reconciliation. It now renders
        // in a fenced code block verbatim so the model sees the full
        // prev/next content. Multi-line / long values are the only
        // reason to reach for fenced rendering — short scalars keep the
        // inline `- prev: ` / `- next: ` shape.
        const long = 'x'.repeat(500);
        const lines = CEA.summarizeCharacterDiff({ description: 'old' }, { description: long });
        const joined = lines.join('\n');
        // Full 500 x's present unclipped.
        expect(joined).toContain('x'.repeat(500));
        // No ellipsis anywhere in the diff.
        expect(joined).not.toContain('…');
        // Fenced block markers appear around long values.
        expect(joined).toMatch(/```/);
    });

    test('preserves underscores and asterisks in real-world field names', () => {
        // Regression: __field__ used to read as markdown bold and visually
        // collapse to "field" in the chat bubble. Inline-code wrapping fixes
        // that for both names like system_prompt and values that contain _ or *.
        const prev = { system_prompt: 'old_value_one' };
        const next = { system_prompt: 'new__value__two' };
        const lines = CEA.summarizeCharacterDiff(prev, next);
        const joined = lines.join('\n');
        expect(joined).toContain('`system_prompt`');
        expect(joined).toContain('`old_value_one`');
        expect(joined).toContain('`new__value__two`');
    });

    test('long values with embedded backticks stay literal because they render inside fenced blocks', () => {
        // Fenced blocks preserve any inner backtick run without escaping,
        // so a value containing ``backticks`` renders as-is inside ``` … ```.
        // We add newlines to force the "multiline" code path.
        const prev = { description: 'plain\nline' };
        const next = { description: 'value with ``backticks`` inside\nsecond line' };
        const lines = CEA.summarizeCharacterDiff(prev, next);
        const joined = lines.join('\n');
        expect(joined).toContain('value with ``backticks`` inside');
        expect(joined).toContain('second line');
        // Fenced blocks used for multi-line values.
        expect(joined).toMatch(/```/);
    });

    test('short single-line values with embedded backticks still get an extended inline-code fence', () => {
        // Single-line values keep the inline `- prev: `…` / `- next: `…`
        // shape because they fit; mdLiteral extends the backtick fence to
        // outlast any inner backtick run so nothing collapses.
        const prev = { description: 'plain' };
        const next = { description: 'value with ``backticks`` inside' };
        const lines = CEA.summarizeCharacterDiff(prev, next);
        const nextLine = lines.find(l => l.includes('- next:'));
        expect(nextLine).toBeTruthy();
        expect(nextLine).toContain('```value with ``backticks`` inside```');
    });
});

describe('summarizeLorebookDiff', () => {
    test('when primary book is renamed, dumps both sides in full because uid identity is not preserved across the rename', () => {
        // uid 5 in OldBook is unrelated to uid 5 in NewBook — treating
        // them as "the same entry" would produce false positives /
        // negatives. Instead we list ALL prev entries under a "Previous
        // world book" heading and ALL next entries under a "Next world
        // book" heading so the AI can do content-based reconciliation
        // across the rename. This is verbose but faithful.
        const prevSnap = { bookName: 'OldBook', entries: { 0: { uid: 0, content: 'A', comment: 'first' } } };
        const nextData = { entries: { 5: { uid: 5, content: 'B', comment: 'other' } } };
        const lines = CEA.summarizeLorebookDiff(prevSnap, nextData, 'OldBook', 'NewBook');
        const joined = lines.join('\n');
        // Rename banner is present with old -> new ordering.
        expect(joined).toContain('`OldBook`');
        expect(joined).toContain('`NewBook`');
        expect(joined).toContain('→');
        // Both sides are dumped in full with entry names and verbatim content.
        expect(joined).toContain('`first`');
        expect(joined).toContain('`other`');
        expect(joined).toContain('A');
        expect(joined).toContain('B');
    });

    test('lists added / removed / changed entries by uid when book is the same', () => {
        const prevSnap = {
            bookName: 'B',
            entries: {
                1: { uid: 1, comment: 'entry one', content: 'A', key: ['k1'] },
                2: { uid: 2, comment: 'entry two', content: 'unchanged', key: ['k2'] },
                3: { uid: 3, comment: 'entry three', content: 'old', key: ['k3'] },
            },
        };
        const nextData = {
            entries: {
                1: { uid: 1, comment: 'entry one', content: 'A', key: ['k1'] }, // unchanged
                3: { uid: 3, comment: 'entry three', content: 'new', key: ['k3'] }, // changed
                4: { uid: 4, comment: 'entry four', content: 'C', key: ['k4'] }, // added
            },
        };
        const lines = CEA.summarizeLorebookDiff(prevSnap, nextData, 'B', 'B');
        const joined = lines.join('\n');
        expect(joined).toMatch(/uid 2[\s\S]*`entry two`/);
        expect(joined).toMatch(/uid 4[\s\S]*`entry four`/);
        expect(joined).toMatch(/uid 3[\s\S]*`entry three`/);
        expect(joined).toContain('old');
        expect(joined).toContain('new');
        // Unchanged entry must NOT appear.
        expect(joined).not.toMatch(/uid 1/);
    });

    test('returns empty array when nothing changed at all', () => {
        const prevSnap = { bookName: 'B', entries: { 1: { uid: 1, content: 'x', comment: 'c' } } };
        const nextData = { entries: { 1: { uid: 1, content: 'x', comment: 'c' } } };
        expect(CEA.summarizeLorebookDiff(prevSnap, nextData, 'B', 'B')).toEqual([]);
    });

    test('handles a missing previous snapshot gracefully, still lists the new book contents', () => {
        const nextData = { entries: { 1: { uid: 1, content: 'fresh_body' } } };
        const lines = CEA.summarizeLorebookDiff(null, nextData, '', 'B');
        const joined = lines.join('\n');
        // Primary-name transition and full new book content are both included.
        expect(joined).toContain('→');
        expect(joined).toContain('`B`');
        expect(joined).toContain('fresh_body');
    });
});

describe('buildPostReplaceSeedMessage', () => {
    test('falls back to the import-only seed when there is no previous character', async () => {
        const context = { loadWorldInfo: jest.fn(async () => ({ entries: {} })) };
        const detail = {
            character: { avatar: 'a.png', name: 'A', data: { extensions: { world: 'IgnoredBook' } } },
            previousCharacter: null,
            previousLorebookSnapshot: null,
        };
        const seed = await CEA.buildPostReplaceSeedMessage(context, detail);
        expect(typeof seed).toBe('string');
        expect(seed.trim().length).toBeGreaterThan(0);
        expect(context.loadWorldInfo).not.toHaveBeenCalled();
        expect(seed).not.toContain('IgnoredBook');
        expect(seed).not.toContain('- prev:');
        expect(seed).not.toContain('- next:');
    });

    test('builds a multi-section diff seed when both prev and next are present', async () => {
        const context = {
            loadWorldInfo: async (name) => {
                if (name === 'NewBook') {
                    return { entries: { 1: { uid: 1, content: 'fresh', comment: 'first' } } };
                }
                return null;
            },
        };
        const detail = {
            character: {
                avatar: 'a.png', name: 'Alice',
                description: 'New description',
                data: { extensions: { world: 'NewBook' } },
            },
            previousCharacter: {
                avatar: 'a.png', name: 'Alice',
                description: 'Old description',
                data: { extensions: { world: 'OldBook' } },
            },
            previousLorebookSnapshot: {
                bookName: 'OldBook',
                entries: { 1: { uid: 1, content: 'stale', comment: 'first' } },
            },
        };
        const seed = await CEA.buildPostReplaceSeedMessage(context, detail);
        expect(typeof seed).toBe('string');
        expect(seed.trim().length).toBeGreaterThan(0);
        expect(seed).toContain('`description`');
        expect(seed).toContain('stale');
        expect(seed).toContain('fresh');
        // Direction is hard-baked: prev: <old>, next: <new>.
        // If this ever flips, the AI will migrate the wrong direction.
        const prevLine = seed.split('\n').find(line => line.trim().startsWith('- prev:'));
        const nextLine = seed.split('\n').find(line => line.trim().startsWith('- next:'));
        expect(prevLine).toBeTruthy();
        expect(nextLine).toBeTruthy();
        expect(prevLine).toContain('Old description');
        expect(prevLine).not.toContain('New description');
        expect(nextLine).toContain('New description');
        expect(nextLine).not.toContain('Old description');
        // Book rename also fixed: OldBook → NewBook (NOT the reverse).
        const renameLine = seed.split('\n').find(line => line.includes('`OldBook`') && line.includes('→') && line.includes('`NewBook`'));
        expect(renameLine).toBeTruthy();
        const oldIdx = renameLine.indexOf('OldBook');
        const newIdx = renameLine.indexOf('NewBook');
        expect(oldIdx).toBeGreaterThanOrEqual(0);
        expect(newIdx).toBeGreaterThanOrEqual(0);
        expect(oldIdx).toBeLessThan(newIdx);
    });

    test('produces an empty-diff seed without prev/next markers when prev and next are identical', async () => {
        const context = {
            loadWorldInfo: async () => ({ entries: { 1: { uid: 1, content: 'same' } } }),
        };
        const same = {
            avatar: 'a.png', name: 'Alice', description: 'same',
            data: { extensions: { world: 'B' } },
        };
        const identicalSeed = await CEA.buildPostReplaceSeedMessage(context, {
            character: same,
            previousCharacter: { ...same },
            previousLorebookSnapshot: {
                bookName: 'B',
                entries: { 1: { uid: 1, content: 'same' } },
            },
        });
        const changedSeed = await CEA.buildPostReplaceSeedMessage(context, {
            character: { ...same, description: 'changed' },
            previousCharacter: { ...same },
            previousLorebookSnapshot: {
                bookName: 'B',
                entries: { 1: { uid: 1, content: 'same' } },
            },
        });
        expect(identicalSeed.trim().length).toBeGreaterThan(0);
        expect(identicalSeed).not.toContain('- prev:');
        expect(identicalSeed).not.toContain('- next:');
        expect(identicalSeed).not.toBe(changedSeed);
    });

    test('REGRESSION: diff direction does not flip when prev and next are swapped at the call site', () => {
        // If someone refactors buildPostReplaceSeedMessage and accidentally
        // calls summarizeCharacterDiff(nextCharacter, previousCharacter) with
        // the arguments swapped, the AI would migrate in the wrong direction
        // (treat new official content as "user customization" and overwrite
        // it with the prev/legacy state). Lock the direction with a direct
        // call to summarizeCharacterDiff against both orderings.
        const prev = { description: 'OLD_VALUE_PREV' };
        const next = { description: 'NEW_VALUE_NEXT' };

        const linesCorrect = CEA.summarizeCharacterDiff(prev, next).join('\n');
        const prevLineCorrect = linesCorrect.split('\n').find(l => l.trim().startsWith('- prev:'));
        const nextLineCorrect = linesCorrect.split('\n').find(l => l.trim().startsWith('- next:'));
        expect(prevLineCorrect).toContain('OLD_VALUE_PREV');
        expect(nextLineCorrect).toContain('NEW_VALUE_NEXT');

        // And the opposite ordering MUST give the opposite labels —
        // proving the labels track the parameter positions, not a hardcoded
        // string match on the values.
        const linesFlipped = CEA.summarizeCharacterDiff(next, prev).join('\n');
        const prevLineFlipped = linesFlipped.split('\n').find(l => l.trim().startsWith('- prev:'));
        const nextLineFlipped = linesFlipped.split('\n').find(l => l.trim().startsWith('- next:'));
        expect(prevLineFlipped).toContain('NEW_VALUE_NEXT');
        expect(nextLineFlipped).toContain('OLD_VALUE_PREV');
    });

    test('REGRESSION: lorebook diff labels removed entries as prev and added entries as next', () => {
        // Same hazard for lorebook diff. If swap happens, "added" and
        // "removed" semantics flip, AI deletes the user's curated entries
        // thinking they were added in next.
        const prevSnap = {
            bookName: 'B',
            entries: {
                1: { uid: 1, content: 'only_in_prev', comment: 'prev_only' },
            },
        };
        const nextData = {
            entries: {
                2: { uid: 2, content: 'only_in_next', comment: 'next_only' },
            },
        };
        const lines = CEA.summarizeLorebookDiff(prevSnap, nextData, 'B', 'B');
        const uid1Header = lines.find(l => l.includes('uid 1') && l.includes('prev_only'));
        const uid2Header = lines.find(l => l.includes('uid 2') && l.includes('next_only'));
        expect(uid1Header).toBeTruthy();
        expect(uid2Header).toBeTruthy();
        // Cross-check: removed vs added use distinct structural headers and swap flips them.
        const flipped = CEA.summarizeLorebookDiff(
            { bookName: 'B', entries: nextData.entries },
            { entries: prevSnap.entries },
            'B',
            'B',
        );
        const uid1Flipped = flipped.find(l => l.includes('uid 1') && l.includes('prev_only'));
        const uid2Flipped = flipped.find(l => l.includes('uid 2') && l.includes('next_only'));
        expect(uid1Flipped).not.toBe(uid1Header);
        expect(uid2Flipped).not.toBe(uid2Header);
    });

    test('omits world book diff payload when only character card fields changed', async () => {
        const context = { loadWorldInfo: async () => ({ entries: {} }) };
        const detail = {
            character: { avatar: 'a.png', name: 'A', description: 'new', data: { extensions: { world: 'B' } } },
            previousCharacter: { avatar: 'a.png', name: 'A', description: 'old', data: { extensions: { world: 'B' } } },
            previousLorebookSnapshot: { bookName: 'B', entries: {} },
        };
        const seed = await CEA.buildPostReplaceSeedMessage(context, detail);
        expect(typeof seed).toBe('string');
        expect(seed.trim().length).toBeGreaterThan(0);
        expect(seed).toContain('`description`');
        expect(seed).toContain('`old`');
        expect(seed).toContain('`new`');
        expect(CEA.summarizeLorebookDiff(detail.previousLorebookSnapshot, { entries: {} }, 'B', 'B')).toEqual([]);
        expect(seed).not.toContain('`B`');
    });

    test('REGRESSION: when nextCharacter carries data.character_book, the diff reads from it via convertCharacterBook (not from disk)', async () => {
        // Without this path the post-replace diff for the OPEN_EDITOR
        // branch degenerates to "every prev entry Removed, no Added"
        // whenever the new card's bookName hasn't been materialized to
        // disk yet — exactly the degenerate state we just fixed.
        //
        // seed.js reads Luker.getContext().convertCharacterBook at call
        // time, so replacing globalThis.Luker for the duration of the call
        // exposes a real implementation. The
        // `embeddedHasEntries && convertCharacterBook` branch fires
        // when convertCharacterBook is `typeof === 'function'`.
        const realConvert = (book) => ({
            entries: Object.fromEntries(
                book.entries.map((e, i) => [String(i), { uid: i, content: e.content, comment: e.keys?.[0] || '' }]),
            ),
        });
        const prevCtx = globalThis.Luker;
        globalThis.Luker = {
            getContext: () => ({ convertCharacterBook: realConvert }),
        };
        try {
            // loadWorldInfo is mocked to throw — proves we did NOT fall back to disk.
            const context = { loadWorldInfo: async () => { throw new Error('disk path must not be reached when embedded book is present'); } };
            const detail = {
                character: {
                    avatar: 'a.png', name: 'Alice',
                    description: 'new',
                    data: {
                        extensions: { world: 'NewBook' },
                        character_book: {
                            name: 'NewBook',
                            entries: [
                                { keys: ['new_only'], content: 'fresh content', extensions: {}, enabled: true, insertion_order: 0 },
                            ],
                        },
                    },
                },
                previousCharacter: {
                    avatar: 'a.png', name: 'Alice',
                    description: 'old',
                    data: { extensions: { world: 'OldBook' } },
                },
                previousLorebookSnapshot: {
                    bookName: 'OldBook',
                    entries: { 1: { uid: 1, content: 'old content', comment: 'old_only' } },
                },
            };
            const seed = await CEA.buildPostReplaceSeedMessage(context, detail);
            expect(typeof seed).toBe('string');
            expect(seed.trim().length).toBeGreaterThan(0);
            // The seed must interpolate BOTH the book rename (OldBook → NewBook)
            // and the embedded/previous entries without touching disk.
            expect(seed).toMatch(/`OldBook`.*→.*`NewBook`/);
            expect(seed).toContain('old_only');
            expect(seed).toContain('old content');
            expect(seed).toContain('new_only');
            expect(seed).toContain('fresh content');
            // Card-field diff for description (prev=old, next=new).
            expect(seed).toContain('`description`');
            const prevLine = seed.split('\n').find(l => l.trim().startsWith('- prev:'));
            const nextLine = seed.split('\n').find(l => l.trim().startsWith('- next:'));
            expect(prevLine).toContain('old');
            expect(nextLine).toContain('new');
        } finally {
            globalThis.Luker = prevCtx;
        }
    });

});
