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
    test('detects changed top-level field with prev/next excerpts wrapped as inline code', () => {
        const prev = { name: 'Alice', description: 'Old description here.' };
        const next = { name: 'Alice', description: 'A brand new description.' };
        const lines = CEA.summarizeCharacterDiff(prev, next);
        // Field names + values are wrapped in backticks so markdown won't eat
        // underscores/asterisks in real values like `system_prompt`.
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

    test('truncates long excerpts with ellipsis (still wrapped in backticks)', () => {
        const long = 'x'.repeat(500);
        const lines = CEA.summarizeCharacterDiff({ description: 'old' }, { description: long });
        const nextLine = lines.find(l => l.includes('next:'));
        expect(nextLine).toBeTruthy();
        // Closing backtick comes after the ellipsis.
        expect(nextLine.endsWith('…`')).toBe(true);
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

    test('escapes literal backticks in field values via a longer fence', () => {
        const prev = { description: 'plain' };
        // Value contains a backtick run of length 2 — fence must be at least 3.
        const next = { description: 'value with ``backticks`` inside' };
        const lines = CEA.summarizeCharacterDiff(prev, next);
        const nextLine = lines.find(l => l.includes('next:'));
        expect(nextLine).toBeTruthy();
        // Three-backtick fence keeps the inner pair literal.
        expect(nextLine).toContain('```value with ``backticks`` inside```');
    });
});

describe('summarizeLorebookDiff', () => {
    test('short-circuits to a one-line rename when the primary book name changes', () => {
        const prevSnap = { bookName: 'OldBook', entries: { 0: { uid: 0, content: 'A' } } };
        const nextData = { entries: { 0: { uid: 0, content: 'A' } } };
        const lines = CEA.summarizeLorebookDiff(prevSnap, nextData, 'OldBook', 'NewBook');
        expect(lines.some(l => l.includes('`OldBook`') && l.includes('→') && l.includes('`NewBook`'))).toBe(true);
        // No per-entry lines when the book itself was swapped.
        expect(lines.some(l => l.includes('Entry'))).toBe(false);
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
        expect(lines.some(l => l.includes('Entry removed (uid 2)') && l.includes('`entry two`'))).toBe(true);
        expect(lines.some(l => l.includes('Entry added (uid 4)') && l.includes('`entry four`'))).toBe(true);
        expect(lines.some(l => l.includes('Entry changed (uid 3') && l.includes('`content`') && l.includes('`entry three`'))).toBe(true);
        // Unchanged entry must NOT appear.
        expect(lines.some(l => l.includes('uid 1'))).toBe(false);
    });

    test('returns empty array when nothing changed at all', () => {
        const prevSnap = { bookName: 'B', entries: { 1: { uid: 1, content: 'x', comment: 'c' } } };
        const nextData = { entries: { 1: { uid: 1, content: 'x', comment: 'c' } } };
        expect(CEA.summarizeLorebookDiff(prevSnap, nextData, 'B', 'B')).toEqual([]);
    });

    test('handles a missing previous snapshot gracefully', () => {
        const nextData = { entries: { 1: { uid: 1, content: 'x' } } };
        const lines = CEA.summarizeLorebookDiff(null, nextData, '', 'B');
        // Primary-name change is listed (with the empty side rendered as `(none)`);
        // per-entry diff is suppressed since the names differ (treated as a
        // wholesale swap, not entry edits).
        expect(lines.some(l => l.includes('Primary world book') && l.includes('`(none)`') && l.includes('`B`'))).toBe(true);
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
        expect(seed).not.toContain('Diff vs the previous version');
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
        expect(seed).toContain('Diff vs the previous version');
        expect(seed).toContain('Character card diff');
        expect(seed).toContain('Field changed: `description`');
        expect(seed).toContain('`Old description`');
        expect(seed).toContain('`New description`');
        expect(seed).toContain('World book diff');
        expect(seed).toContain('`OldBook`');
        expect(seed).toContain('`NewBook`');
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
});
