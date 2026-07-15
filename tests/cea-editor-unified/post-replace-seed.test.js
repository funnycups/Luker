// Tests the post-CHARACTER_REPLACED diff helpers in CEA main.js that feed
// the iter-studio's seedSystemMessage:
//   - summarizeCharacterDiff: per-field add / remove / change with excerpt
//   - summarizeLorebookDiff: per-uid add / remove / change with the changed
//     field list, plus the "primary book renamed" short-circuit
//   - buildPostReplaceSeedMessage: end-to-end seed assembly, falling back to
//     the "no previous version" string when previousCharacter is missing.
//
// The diff helpers are pure (no jQuery, no DOM, no popup), so the same
// import-tree stub used by lorebook-approval-flow lets us reach them.

import { describe, expect, jest, test } from '@jest/globals';

globalThis.jQuery = (cb) => {
    if (typeof cb === 'function') { /* swallow init handlers */ }
    return { ready: () => {}, on: () => {}, off: () => {} };
};
globalThis.$ = globalThis.jQuery;
globalThis.window = globalThis.window || globalThis;
globalThis.document = globalThis.document || {
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
};
globalThis.toastr = globalThis.toastr || {
    error: () => {}, warning: () => {}, success: () => {}, info: () => {},
};

jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
    POPUP_TYPE: { DISPLAY: 'display' },
    POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 2, CANCELLED: 0 },
    Popup: class { constructor() {} show() { return Promise.resolve(''); } },
}));

const realEdits = await import('../../public/scripts/lib/edits/index.js');

jest.unstable_mockModule('../../public/script.js', () => ({
    converter: { makeHtml: (s) => s },
    generateQuietPrompt: async () => '',
    getCharacterDescription: () => '',
    getCharacterFirstMessage: () => '',
    getCharacterMesExample: () => '',
    getCharacterName: () => '',
    getCharacterPersonality: () => '',
    getCharacterScenario: () => '',
    saveSettingsDebounced: () => {},
}));
jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
    extension_settings: { character_editor_assistant: {} },
    getContext: () => ({}),
    getCharacterState: () => ({}),
    setCharacterState: () => {},
}));
jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    addLocaleData: () => {},
    translate: (s) => s,
}));
jest.unstable_mockModule('../../public/scripts/world-info.js', () => ({
    newWorldInfoEntryTemplate: {},
    setWorldInfoButtonClass: () => {},
    updateWorldInfoList: () => {},
    getCharaAuxWorlds: () => [],
    getChatWorldInfoNames: () => [],
    selected_world_info: [],
}));
jest.unstable_mockModule('../../public/scripts/utils.js', () => ({
    getCharaFilename: () => '',
}));
jest.unstable_mockModule('../../public/scripts/extensions/connection-manager/profile-resolver.js', () => ({
    getChatCompletionConnectionProfiles: () => [],
}));
jest.unstable_mockModule('../../public/scripts/extensions/function-call-runtime.js', () => ({
    TOOL_PROTOCOL_STYLE: { OPENAI: 'openai' },
    validateParsedToolCalls: () => ({ ok: true, errors: [] }),
}));
jest.unstable_mockModule('../../public/scripts/extensions/character-editor-assistant/diff-ui.js', () => ({
    createCharacterEditorDiffUi: () => ({}),
}));
jest.unstable_mockModule('../../public/scripts/extensions/character-editor-assistant/editor-ui.js', () => ({
    createCharacterEditorUi: () => ({}),
}));
jest.unstable_mockModule('../../public/scripts/extensions/character-editor-assistant/editor-iteration/studio.js', () => ({
    openUnifiedCharacterEditorPopup: async () => {},
    DEFAULT_SYSTEM_PROMPT: '',
}));
jest.unstable_mockModule('../../public/scripts/extensions/character-editor-assistant/studio/ai-chat.js', () => ({
    DEFAULT_SYSTEM_PROMPT: '',
}));
jest.unstable_mockModule('../../public/scripts/iteration-library/index.js', () => ({
    applyEdits: realEdits.applyEdits,
}));
jest.unstable_mockModule('../../public/scripts/iteration-library/simulation-review/index.js', () => ({
    openSimulationReview: () => {},
}));
jest.unstable_mockModule('../../public/scripts/iteration-library/simulation-review/i18n/index.js', () => ({
    ensureSimulationReviewLocaleData: () => {},
}));
jest.unstable_mockModule('../../public/scripts/iteration-library/simulation-review/wi-hits.js', () => ({
    extractWorldInfoHitsFromRuntime: () => [],
}));
jest.unstable_mockModule('../../public/scripts/iteration-library/simulation-review/dry-run-capture.js', () => ({
    extractSystemFromCapturedPrompt: () => '',
    extractNonSystemFromCapturedPrompt: () => '',
}));

let CEA;
beforeAll(async () => {
    CEA = await import('../../public/scripts/extensions/character-editor-assistant/main.js');
});

describe('summarizeCharacterDiff', () => {
    test('detects changed top-level field with prev/next full values inline', () => {
        // Short values render inline as `- prev: ...` / `- next: ...`
        // wrapped in inline-code backticks so markdown does not eat any
        // special characters in the excerpt.
        const prev = { name: 'Alice', description: 'Old description here.' };
        const next = { name: 'Alice', description: 'A brand new description.' };
        const lines = CEA.summarizeCharacterDiff(prev, next);
        expect(lines.some(l => l.includes('Field changed: `description`'))).toBe(true);
        expect(lines.some(l => l.includes('`Old description here.`'))).toBe(true);
        expect(lines.some(l => l.includes('`A brand new description.`'))).toBe(true);
        expect(lines.some(l => l.includes('Field changed: `name`'))).toBe(false);
    });

    test('detects added field present only on next', () => {
        const prev = { name: 'Alice' };
        const next = { name: 'Alice', personality: 'Calm and steady.' };
        const lines = CEA.summarizeCharacterDiff(prev, next);
        expect(lines.some(l => l.includes('Field added: `personality`'))).toBe(true);
        expect(lines.some(l => l.includes('`Calm and steady.`'))).toBe(true);
    });

    test('detects removed field present only on prev', () => {
        const prev = { name: 'Alice', scenario: 'Forest meeting.' };
        const next = { name: 'Alice' };
        const lines = CEA.summarizeCharacterDiff(prev, next);
        expect(lines.some(l => l.includes('Field removed: `scenario`'))).toBe(true);
        expect(lines.some(l => l.includes('`Forest meeting.`'))).toBe(true);
    });

    test('diffs nested data.* fields', () => {
        const prev = { name: 'A', data: { description: 'short' } };
        const next = { name: 'A', data: { description: 'updated' } };
        const lines = CEA.summarizeCharacterDiff(prev, next);
        expect(lines.some(l => l.includes('Field changed: `data.description`'))).toBe(true);
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
        // Rename banner is still there.
        expect(joined).toContain('`OldBook`');
        expect(joined).toContain('`NewBook`');
        expect(joined).toContain('→');
        // Both sides are dumped in full (headings with counts).
        expect(joined).toMatch(/Previous world book `OldBook` \(1 entries\)/);
        expect(joined).toMatch(/Next world book `NewBook` \(1 entries\)/);
        // Each entry's content is present verbatim (inside fenced blocks).
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
        expect(joined).toMatch(/Entry removed \(uid 2\).*`entry two`/);
        expect(joined).toMatch(/Entry added \(uid 4\).*`entry four`/);
        // Change header + per-field content diff (fenced because 'content' is a prose field).
        expect(joined).toMatch(/Entry changed \(uid 3\).*`entry three`/);
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
        const nextData = { entries: { 1: { uid: 1, content: 'x' } } };
        const lines = CEA.summarizeLorebookDiff(null, nextData, '', 'B');
        const joined = lines.join('\n');
        // Primary-name change is listed (empty side rendered as `(none)`).
        expect(joined).toContain('Primary world book');
        expect(joined).toContain('`(none)`');
        expect(joined).toContain('`B`');
        // Since names differ, we dump the next side's contents in full so
        // the AI can see what the new book actually contains — a
        // one-line "book renamed" banner alone would leave the model
        // guessing about the entries on the new side.
        expect(joined).toMatch(/Next world book `B` \(1 entries\)/);
    });
});

describe('buildPostReplaceSeedMessage', () => {
    test('falls back to the import-only seed when there is no previous character', async () => {
        const context = { loadWorldInfo: async () => ({ entries: {} }) };
        const detail = {
            character: { avatar: 'a.png', name: 'A', data: { extensions: {} } },
            previousCharacter: null,
            previousLorebookSnapshot: null,
        };
        const seed = await CEA.buildPostReplaceSeedMessage(context, detail);
        expect(seed).toContain('Just imported this card');
        expect(seed).not.toContain('post-replace iteration');
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
        // Migration intent + direction convention is the new framing.
        expect(seed).toContain('post-replace iteration');
        expect(seed).toContain('REVIEW ONLY');
        expect(seed).toContain('Direction convention');
        expect(seed).toContain('Character card diff');
        expect(seed).toContain('Field changed: `description`');
        expect(seed).toContain('World book diff');
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
        const renameLine = seed.split('\n').find(line => line.includes('Primary world book'));
        expect(renameLine).toBeTruthy();
        const oldIdx = renameLine.indexOf('OldBook');
        const newIdx = renameLine.indexOf('NewBook');
        expect(oldIdx).toBeGreaterThanOrEqual(0);
        expect(newIdx).toBeGreaterThanOrEqual(0);
        expect(oldIdx).toBeLessThan(newIdx);
    });

    test('reports "no human-readable changes" when prev and next are identical', async () => {
        const context = {
            loadWorldInfo: async () => ({ entries: { 1: { uid: 1, content: 'same' } } }),
        };
        const same = {
            avatar: 'a.png', name: 'Alice', description: 'same',
            data: { extensions: { world: 'B' } },
        };
        const detail = {
            character: same,
            previousCharacter: { ...same },
            previousLorebookSnapshot: {
                bookName: 'B',
                entries: { 1: { uid: 1, content: 'same' } },
            },
        };
        const seed = await CEA.buildPostReplaceSeedMessage(context, detail);
        expect(seed).toContain('no human-readable changes detected');
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
        const lines = CEA.summarizeLorebookDiff(prevSnap, nextData, 'B', 'B').join('\n');
        // uid 1 is only in prev → should be tagged "removed", labeled with prev's comment.
        expect(lines).toMatch(/Entry removed \(uid 1\).*prev_only/);
        // uid 2 is only in next → should be tagged "added", labeled with next's comment.
        expect(lines).toMatch(/Entry added \(uid 2\).*next_only/);
        // Cross-check: NEVER the reverse.
        expect(lines).not.toMatch(/Entry added \(uid 1\)/);
        expect(lines).not.toMatch(/Entry removed \(uid 2\)/);
    });

    test('REGRESSION: when nextCharacter carries data.character_book, the diff reads from it via convertCharacterBook (not from disk)', async () => {
        // Without this path the post-replace diff for the OPEN_EDITOR
        // branch degenerates to "every prev entry Removed, no Added"
        // whenever the new card's bookName hasn't been materialized to
        // disk yet — exactly the degenerate state we just fixed.
        //
        // Reach into the live import-time __ctx capture in main.js by
        // overriding globalThis.Luker.getContext().convertCharacterBook.
        // The main.js module already imported __ctx at top of file, so
        // we override the stub at call time by replacing the proxy with
        // an object that exposes a real implementation. The
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
            // The seed must mention BOTH:
            //  - that we are running the review/migration flow
            expect(seed).toContain('post-replace iteration');
            //  - the book rename (OldBook → NewBook)
            expect(seed).toMatch(/Primary world book.*OldBook.*→.*NewBook/);
            // Card-field diff for description (prev=old, next=new).
            expect(seed).toContain('Field changed: `description`');
            const prevLine = seed.split('\n').find(l => l.trim().startsWith('- prev:'));
            const nextLine = seed.split('\n').find(l => l.trim().startsWith('- next:'));
            expect(prevLine).toContain('old');
            expect(nextLine).toContain('new');
        } finally {
            globalThis.Luker = prevCtx;
        }
    });

    test('seed asks AI to review + summarize first (no tool calls on turn 1) — not to start editing immediately', async () => {
        // UX requirement: on the first turn the AI must produce a plain-text
        // summary + reconciliation plan. Editing happens only on subsequent
        // turns after the user has reviewed.
        const context = { loadWorldInfo: async () => ({ entries: {} }) };
        const detail = {
            character: { avatar: 'a.png', name: 'A', description: 'x', data: { extensions: { world: 'B' } } },
            previousCharacter: { avatar: 'a.png', name: 'A', description: 'y', data: { extensions: { world: 'B' } } },
            previousLorebookSnapshot: { bookName: 'B', entries: {} },
        };
        const seed = await CEA.buildPostReplaceSeedMessage(context, detail);
        // Must explicitly forbid tool calls on the first turn.
        expect(seed).toContain('REVIEW ONLY');
        expect(seed).toContain('NO tool calls');
        // Must describe the expected first-turn deliverables.
        expect(seed).toMatch(/summarize for the user/);
        expect(seed).toMatch(/reconciliation plan/);
        // Tool use is only for "subsequent turns".
        expect(seed).toMatch(/subsequent turns/);
        // Migration direction policy is present so the AI knows what
        // "apply" means when the user does approve.
        expect(seed).toContain('Migrate prev-only curated content into next');
    });
});
