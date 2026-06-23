// Tests the lorebook approval flow's CEA-side helpers:
//   - `computeCharacterEditorLorebookUpdate` (via the helper-tool dispatcher):
//     validates args + loads the entry + returns {before, after} WITHOUT
//     calling saveWorldInfo. Proposal-mode contract.
//   - `computeCharacterEditorLorebookStrReplace` (via the dispatcher):
//     same, plus the unique-substring guard.
//   - `applyCharacterEditorLorebookCommit`: the Apply-time disk-write
//     entry point. Merges the after-image over the live entry, preserves
//     the uid as the address, calls saveWorldInfo once.
//
// CEA's main.js drags in the full SillyTavern surface (script.js,
// world-info.js, popup.js, iteration-library, …); we stub the entire
// import tree because the functions under test only touch
// `context.loadWorldInfo` / `context.saveWorldInfo`.

import { describe, expect, jest, test } from '@jest/globals';

// CEA main.js boots via a module-level `jQuery(() => …)` registration. The
// jest-node env has no jQuery so we stub it to a no-op before importing
// the module under test. Same pattern as tests/memory-graph/write-api.test.js.
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

// public/lib.js is handled by the global moduleNameMapper (→ tests/util/lib-stub.js).

// popup.js + popup-utils must be mocked BEFORE we touch lib/edits/index.js,
// since conflict-ui.js → popup.js → power-user.js → textgen-models.js
// touches `document` at module-load. Register popup mock first so the
// dynamic `import('../../public/scripts/lib/edits/index.js')` below
// (used to forward the real applyEdits into the iteration-library mock)
// doesn't pull the SillyTavern DOM shell.
jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
    POPUP_TYPE: { DISPLAY: 'display' },
    POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 2, CANCELLED: 0 },
    Popup: class { constructor() {} show() { return Promise.resolve(''); } },
}));

// Forward the REAL edits engine through the iteration-library umbrella so
// the studio's applyEdits/inverseEdit calls do real work. Other surfaces
// stay stubbed (they need DOM and are out of scope for this test).
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

// ── Helper: stub context with in-memory worldinfo store ──────────────
function makeStubContext(initialBooks = {}) {
    // Caller passes { 'BookA': { entries: { 0: {...}, 1: {...} } } }
    // We deep-clone so the stub doesn't share refs with the test fixture.
    const books = JSON.parse(JSON.stringify(initialBooks));
    const saveSpy = jest.fn(async (name, data) => {
        books[name] = JSON.parse(JSON.stringify(data));
    });
    const loadSpy = jest.fn(async (name) => {
        if (!books[name]) return null;
        // Return a fresh clone so mutations inside the function under test
        // don't leak back into our fixture between calls.
        return JSON.parse(JSON.stringify(books[name]));
    });
    return {
        ctx: { loadWorldInfo: loadSpy, saveWorldInfo: saveSpy },
        saveSpy,
        loadSpy,
        books,
    };
}

// ── compute: lorebook_update_entry (proposal mode) ───────────────────
describe('lorebook write proposals: update_entry compute path', () => {
    function buildApi(ctx) {
        // buildCharacterEditorHelperApis returns the array of helper APIs;
        // the lorebook-write API is the second entry per the factory order.
        const apis = CEA.buildCharacterEditorHelperApis(ctx, { avatar: 'TestCard' });
        const writeApi = apis.find(a => typeof a?.isToolName === 'function'
            && a.isToolName('luker_card_update_lorebook_entry'));
        if (!writeApi) throw new Error('lorebook-write helper api not found');
        return writeApi;
    }

    test('returns {before, after, kind:"update"} and does NOT save', async () => {
        const { ctx, saveSpy } = makeStubContext({
            BookA: { entries: { 5: { uid: 5, content: 'must use markdown', disable: false, comment: 'fmt' } } },
        });
        const api = buildApi(ctx);
        const result = await api.invoke({
            name: 'luker_card_update_lorebook_entry',
            args: { book_name: 'BookA', uid: 5, patch: { disable: true } },
        });

        expect(result.ok).toBe(true);
        expect(result.kind).toBe('update');
        expect(result.book_name).toBe('BookA');
        expect(result.uid).toBe(5);
        expect(result.before).toEqual({ uid: 5, content: 'must use markdown', disable: false, comment: 'fmt' });
        expect(result.after).toEqual({ uid: 5, content: 'must use markdown', disable: true, comment: 'fmt' });
        expect(result.updated_fields).toEqual(['disable']);
        // Proposal-mode contract: no disk write at compute time.
        expect(saveSpy).not.toHaveBeenCalled();
    });

    test('rejects when entry does not exist', async () => {
        const { ctx, saveSpy } = makeStubContext({
            BookA: { entries: { 5: { uid: 5, content: 'x' } } },
        });
        const api = buildApi(ctx);
        await expect(api.invoke({
            name: 'luker_card_update_lorebook_entry',
            args: { book_name: 'BookA', uid: 99, patch: { disable: true } },
        })).rejects.toThrow(/Entry uid 99 not found/);
        expect(saveSpy).not.toHaveBeenCalled();
    });

    test('rejects when book does not exist', async () => {
        const { ctx, saveSpy } = makeStubContext({});
        const api = buildApi(ctx);
        await expect(api.invoke({
            name: 'luker_card_update_lorebook_entry',
            args: { book_name: 'GhostBook', uid: 0, patch: { disable: true } },
        })).rejects.toThrow(/World book "GhostBook" not found/);
        expect(saveSpy).not.toHaveBeenCalled();
    });

    test('rejects empty patch', async () => {
        const { ctx } = makeStubContext({
            BookA: { entries: { 5: { uid: 5 } } },
        });
        const api = buildApi(ctx);
        await expect(api.invoke({
            name: 'luker_card_update_lorebook_entry',
            args: { book_name: 'BookA', uid: 5, patch: {} },
        })).rejects.toThrow(/patch must contain at least one field/);
    });

    test('after preserves uid even when patch tries to overwrite it', async () => {
        const { ctx } = makeStubContext({
            BookA: { entries: { 5: { uid: 5, content: 'x' } } },
        });
        const api = buildApi(ctx);
        const result = await api.invoke({
            name: 'luker_card_update_lorebook_entry',
            args: { book_name: 'BookA', uid: 5, patch: { uid: 999, content: 'y' } },
        });
        expect(result.after.uid).toBe(5);
        // uid is filtered out of updated_fields since it's the address, not payload.
        expect(result.updated_fields).toEqual(['content']);
    });
});

// ── compute: lorebook_str_replace_in_entry (proposal mode) ───────────
describe('lorebook write proposals: str_replace_in_entry compute path', () => {
    function buildApi(ctx) {
        const apis = CEA.buildCharacterEditorHelperApis(ctx, { avatar: 'TestCard' });
        const writeApi = apis.find(a => typeof a?.isToolName === 'function'
            && a.isToolName('luker_card_str_replace_in_lorebook_entry'));
        if (!writeApi) throw new Error('lorebook-write helper api not found');
        return writeApi;
    }

    test('returns {before, after} with content slice replaced; no save', async () => {
        const { ctx, saveSpy } = makeStubContext({
            BookA: { entries: { 5: { uid: 5, content: 'she must speak in poetry always' } } },
        });
        const api = buildApi(ctx);
        const result = await api.invoke({
            name: 'luker_card_str_replace_in_lorebook_entry',
            args: { book_name: 'BookA', uid: 5, oldString: 'must speak in poetry', newString: 'prefers a poetic cadence' },
        });
        expect(result.ok).toBe(true);
        expect(result.kind).toBe('str_replace');
        expect(result.before.content).toBe('she must speak in poetry always');
        expect(result.after.content).toBe('she prefers a poetic cadence always');
        expect(result.replaced_chars).toBe('must speak in poetry'.length);
        expect(result.new_chars).toBe('prefers a poetic cadence'.length);
        expect(saveSpy).not.toHaveBeenCalled();
    });

    test('rejects multi-site match (uniqueness contract)', async () => {
        const { ctx } = makeStubContext({
            BookA: { entries: { 5: { uid: 5, content: 'must must must' } } },
        });
        const api = buildApi(ctx);
        await expect(api.invoke({
            name: 'luker_card_str_replace_in_lorebook_entry',
            args: { book_name: 'BookA', uid: 5, oldString: 'must', newString: 'might' },
        })).rejects.toThrow(/more than once/);
    });

    test('rejects when oldString not present', async () => {
        const { ctx } = makeStubContext({
            BookA: { entries: { 5: { uid: 5, content: 'unrelated text' } } },
        });
        const api = buildApi(ctx);
        await expect(api.invoke({
            name: 'luker_card_str_replace_in_lorebook_entry',
            args: { book_name: 'BookA', uid: 5, oldString: 'must use markdown', newString: '' },
        })).rejects.toThrow(/not found/);
    });

    test('rejects empty oldString', async () => {
        const { ctx } = makeStubContext({
            BookA: { entries: { 5: { uid: 5, content: 'x' } } },
        });
        const api = buildApi(ctx);
        await expect(api.invoke({
            name: 'luker_card_str_replace_in_lorebook_entry',
            args: { book_name: 'BookA', uid: 5, oldString: '', newString: 'y' },
        })).rejects.toThrow(/non-empty oldString/);
    });

    test('empty newString is allowed (used to delete a clause)', async () => {
        const { ctx } = makeStubContext({
            BookA: { entries: { 5: { uid: 5, content: 'keep [DROP THIS] tail' } } },
        });
        const api = buildApi(ctx);
        const result = await api.invoke({
            name: 'luker_card_str_replace_in_lorebook_entry',
            args: { book_name: 'BookA', uid: 5, oldString: ' [DROP THIS]', newString: '' },
        });
        expect(result.after.content).toBe('keep tail');
    });
});

// ── Apply: applyCharacterEditorLorebookCommit ─────────────────────────
describe('applyCharacterEditorLorebookCommit — disk write phase', () => {
    test('merges after over the live entry and persists via saveWorldInfo', async () => {
        const { ctx, saveSpy, books } = makeStubContext({
            BookA: { entries: { 5: { uid: 5, content: 'must use markdown', disable: false, comment: 'fmt' } } },
        });
        await CEA.applyCharacterEditorLorebookCommit(ctx, {
            book_name: 'BookA',
            uid: 5,
            after: { uid: 5, content: 'must use markdown', disable: true, comment: 'fmt' },
        });
        expect(saveSpy).toHaveBeenCalledTimes(1);
        // saveWorldInfo gets the full book data with the entry merged.
        const [savedName, savedData] = saveSpy.mock.calls[0];
        expect(savedName).toBe('BookA');
        expect(savedData.entries[5].disable).toBe(true);
        expect(savedData.entries[5].uid).toBe(5);
        // In-memory store reflects the saved state.
        expect(books.BookA.entries[5].disable).toBe(true);
    });

    test('preserves uid even when after tries to overwrite it', async () => {
        const { ctx, saveSpy } = makeStubContext({
            BookA: { entries: { 5: { uid: 5, content: 'a' } } },
        });
        await CEA.applyCharacterEditorLorebookCommit(ctx, {
            book_name: 'BookA',
            uid: 5,
            after: { uid: 999, content: 'b' },
        });
        const [, savedData] = saveSpy.mock.calls[0];
        expect(savedData.entries[5].uid).toBe(5);
        expect(savedData.entries[5].content).toBe('b');
    });

    test('rejects missing book', async () => {
        const { ctx, saveSpy } = makeStubContext({});
        await expect(CEA.applyCharacterEditorLorebookCommit(ctx, {
            book_name: 'Ghost',
            uid: 0,
            after: { uid: 0 },
        })).rejects.toThrow(/World book "Ghost" not found/);
        expect(saveSpy).not.toHaveBeenCalled();
    });

    test('rejects missing entry', async () => {
        const { ctx, saveSpy } = makeStubContext({
            BookA: { entries: { 5: { uid: 5 } } },
        });
        await expect(CEA.applyCharacterEditorLorebookCommit(ctx, {
            book_name: 'BookA',
            uid: 99,
            after: { uid: 99 },
        })).rejects.toThrow(/Entry uid 99 not found/);
        expect(saveSpy).not.toHaveBeenCalled();
    });

    test('validates required args', async () => {
        const { ctx } = makeStubContext({ BookA: { entries: {} } });
        await expect(CEA.applyCharacterEditorLorebookCommit(ctx, {
            book_name: '', uid: 0, after: { uid: 0 },
        })).rejects.toThrow(/book_name is required/);
        await expect(CEA.applyCharacterEditorLorebookCommit(ctx, {
            book_name: 'BookA', uid: -1, after: { uid: 0 },
        })).rejects.toThrow(/uid must be a non-negative integer/);
        await expect(CEA.applyCharacterEditorLorebookCommit(ctx, {
            book_name: 'BookA', uid: 0, after: null,
        })).rejects.toThrow(/after must be an object/);
    });
});

// ── Apply via re-derived after: applyCharacterEditorLorebookProposal ──
describe('applyCharacterEditorLorebookProposal — re-derived commit (chained edits)', () => {
    test('re-runs update compute and commits against current state', async () => {
        const { ctx, saveSpy, books } = makeStubContext({
            BookA: { entries: { 5: { uid: 5, content: 'keep me', disable: false } } },
        });
        await CEA.applyCharacterEditorLorebookProposal(ctx, {
            kind: 'update',
            args: { book_name: 'BookA', uid: 5, patch: { disable: true } },
        });
        expect(saveSpy).toHaveBeenCalledTimes(1);
        expect(books.BookA.entries[5].disable).toBe(true);
        // content untouched
        expect(books.BookA.entries[5].content).toBe('keep me');
    });

    test('two sequential update proposals against the same uid chain correctly', async () => {
        // This is the same-entry clobber regression — proposal B used to
        // wipe proposal A because B's snapshot was taken pre-A. Re-deriving
        // against current state fixes it: each call reads the entry as
        // already-mutated by the prior commit.
        const { ctx, books } = makeStubContext({
            BookA: { entries: { 5: { uid: 5, content: 'a', disable: false, comment: 'fmt' } } },
        });
        await CEA.applyCharacterEditorLorebookProposal(ctx, {
            kind: 'update',
            args: { book_name: 'BookA', uid: 5, patch: { disable: true } },
        });
        await CEA.applyCharacterEditorLorebookProposal(ctx, {
            kind: 'update',
            args: { book_name: 'BookA', uid: 5, patch: { comment: 'new comment' } },
        });
        // Both edits land — disable=true survives second commit, comment updated.
        expect(books.BookA.entries[5].disable).toBe(true);
        expect(books.BookA.entries[5].comment).toBe('new comment');
        expect(books.BookA.entries[5].content).toBe('a');
    });

    test('str_replace after update sees the updated content (chain works for mixed kinds too)', async () => {
        const { ctx, books } = makeStubContext({
            BookA: { entries: { 5: { uid: 5, content: 'must use markdown always' } } },
        });
        await CEA.applyCharacterEditorLorebookProposal(ctx, {
            kind: 'update',
            args: { book_name: 'BookA', uid: 5, patch: { content: 'must use markdown sometimes' } },
        });
        // Second commit's str_replace should match the new content.
        await CEA.applyCharacterEditorLorebookProposal(ctx, {
            kind: 'str_replace',
            args: { book_name: 'BookA', uid: 5, oldString: 'must use markdown', newString: 'prefers markdown' },
        });
        expect(books.BookA.entries[5].content).toBe('prefers markdown sometimes');
    });

    test('surfaces drift as a fresh validation error when str_replace no longer matches', async () => {
        // Simulate parallel session having moved the entry's content
        // before our Apply runs — the str_replace's unique-match guard
        // should refuse the commit instead of silently writing the
        // wrong slice.
        const { ctx, saveSpy } = makeStubContext({
            BookA: { entries: { 5: { uid: 5, content: 'the world has shifted' } } },
        });
        await expect(CEA.applyCharacterEditorLorebookProposal(ctx, {
            kind: 'str_replace',
            args: { book_name: 'BookA', uid: 5, oldString: 'must use markdown', newString: 'prefers markdown' },
        })).rejects.toThrow(/not found/);
        expect(saveSpy).not.toHaveBeenCalled();
    });

    test('rejects unknown kind', async () => {
        const { ctx, saveSpy } = makeStubContext({});
        await expect(CEA.applyCharacterEditorLorebookProposal(ctx, {
            kind: 'erase_entry',
            args: { book_name: 'X', uid: 0 },
        })).rejects.toThrow(/unknown kind/);
        expect(saveSpy).not.toHaveBeenCalled();
    });
});
