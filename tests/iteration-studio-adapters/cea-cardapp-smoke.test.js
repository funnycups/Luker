import { describe, test, expect, beforeAll, jest } from '@jest/globals';

// Route defineAdapter through pure session.js (avoid heavy DOM-only transitive imports)
jest.unstable_mockModule('../../public/scripts/iteration-studio/index.js', async () => {
    const session = await import('../../public/scripts/iteration-studio/session.js');
    return { defineAdapter: session.defineAdapter };
});
jest.unstable_mockModule('../../public/scripts/utils.js', () => ({
    escapeHtml: (s) => String(s ?? ''),
}));

// lib.js pulls in browser-only bundles; stub DiffMatchPatch with just enough
// surface for diff-render.js (used by adapter.renderMessageCard).
jest.unstable_mockModule('../../public/lib.js', () => {
    class DiffMatchPatch {
        diff_linesToChars_(a, b) { return { chars1: a || '', chars2: b || '', lineArray: [] }; }
        diff_main() { return []; }
        diff_charsToLines_() {}
    }
    return { DiffMatchPatch };
});

// Mock ai-chat.js to avoid pulling in heavy DOM-only transitive imports (script.js, world-info.js, etc.).
// We assert the wiring (adapter delegates to ai-chat helpers); the helper bodies are exercised by the real app.
jest.unstable_mockModule('../../public/scripts/extensions/character-editor-assistant/studio/ai-chat.js', () => {
    const CARDAPP_TOOL_DEFS = [
        { type: 'function', function: { name: 'cardapp_list_files', description: 'List CardApp files.', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
        { type: 'function', function: { name: 'cardapp_read_file', description: 'Read a file.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } } },
        { type: 'function', function: { name: 'cardapp_write_file', description: 'Write a file.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false } } },
        { type: 'function', function: { name: 'cardapp_patch_file', description: 'Patch a file.', parameters: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'], additionalProperties: false } } },
        { type: 'function', function: { name: 'cardapp_delete_file', description: 'Delete a file.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } } },
        { type: 'function', function: { name: 'cardapp_rename_file', description: 'Rename a file.', parameters: { type: 'object', properties: { from_path: { type: 'string' }, to_path: { type: 'string' } }, required: ['from_path', 'to_path'], additionalProperties: false } } },
    ];
    return {
        buildCardAppStudioTools: () => CARDAPP_TOOL_DEFS.map(t => ({ ...t, function: { ...t.function } })),
        buildCardAppStudioSystemPrompt: (_session, _deps) => 'You are the CardApp Studio assistant. Tools: cardapp_list_files, cardapp_read_file, cardapp_write_file, cardapp_patch_file, cardapp_delete_file, cardapp_rename_file.',
        buildCardAppStudioUserPrompt: (_session, userText, _opts) => String(userText ?? ''),
        executeCardAppControlToolCall: async (call, _ctx, _signal, deps = {}) => {
            const name = String(call?.function?.name || '');
            let args = {};
            try { args = JSON.parse(call?.function?.arguments ?? '{}') || {}; }
            catch { args = {}; }
            if (name === 'cardapp_list_files') {
                const files = await deps.fetchFileList(deps.charId);
                return { content: JSON.stringify({ files }) };
            }
            if (name === 'cardapp_read_file') {
                const content = await deps.fetchFileContent(deps.charId, String(args?.path || ''));
                return { content: String(content ?? '') };
            }
            return { content: `Unknown control tool: ${name}` };
        },
    };
});

let createCardAppStudioAdapter;

const fakeFiles = new Map([
    ['index.js', "console.log('hi');\n"],
    ['styles/main.css', 'body { color: red; }\n'],
]);

function makeDeps(overrides = {}) {
    const calls = { save: [], remove: [], rename: [] };
    return {
        charId: 'char_abc',
        i18n: (s) => s,
        i18nFormat: (s) => s,
        escapeHtml: (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
        fetchFileList: async () => Array.from(fakeFiles.keys()),
        fetchFileContent: async (_charId, path) => fakeFiles.get(path) ?? '',
        saveFileContent: async (_charId, path, content) => { calls.save.push({ path, content }); fakeFiles.set(path, content); },
        deleteFile: async (_charId, path) => { calls.remove.push({ path }); fakeFiles.delete(path); },
        renameFile: async (_charId, from, to) => { calls.rename.push({ from, to }); const c = fakeFiles.get(from); fakeFiles.delete(from); fakeFiles.set(to, c); },
        getCharacterState: () => ({}),
        setCharacterState: () => {},
        getContextStub: () => ({ characters: [{ avatar: 'char_abc' }], characterId: 0 }),
        reloadCardApp: () => {},
        ...overrides,
        _calls: calls,
    };
}

beforeAll(async () => {
    globalThis.SillyTavern = { getContext: () => ({ characters: [{ avatar: 'char_abc' }], characterId: 0 }) };
    globalThis.saveSettingsDebounced = () => {};
    const mod = await import('../../public/scripts/extensions/character-editor-assistant/studio/adapter.js');
    createCardAppStudioAdapter = mod.createCardAppStudioAdapter;
});

describe('CEA CardApp Studio adapter — contract surface', () => {
    test('exposes all required v2 hooks', () => {
        const a = createCardAppStudioAdapter(makeDeps());
        for (const k of [
            'id', 'title', 'mode', 'layout', 'live', 'commit', 'sessionScope',
            'listSessions', 'loadSession', 'saveSession', 'deleteSession',
            'buildToolCatalog', 'normalizeToolCallToEdit',
            'buildSystemPrompt', 'buildUserPrompt',
            'renderMessageCard', 'renderHistoryItem', 'renderPreviewPane',
        ]) {
            expect(a[k]).toBeDefined();
        }
        expect(a.layout).toBe('split');
        expect(a.id).toMatch(/^cea_cardapp/);
    });

    test('sessionScope is per-character', () => {
        const a = createCardAppStudioAdapter(makeDeps());
        expect(a.sessionScope()).toBe('char_char_abc');
    });
});

describe('CEA CardApp Studio adapter — live()', () => {
    test('live() returns { files, metadata: { charId } } with file contents loaded', async () => {
        const a = createCardAppStudioAdapter(makeDeps());
        const live = await a.live();
        expect(live.metadata.charId).toBe('char_abc');
        expect(live.files['index.js']).toContain("console.log('hi')");
        expect(live.files['styles/main.css']).toContain('color: red');
    });

    test('live() reflects updates after deps.fetchFileList changes', async () => {
        const deps = makeDeps();
        const a = createCardAppStudioAdapter(deps);
        await a.live();
        deps.fetchFileList = async () => ['index.js'];   // simulate deletion
        const live2 = await a.live();
        expect(Object.keys(live2.files).sort()).toEqual(['index.js']);
    });
});

describe('CEA CardApp Studio adapter — normalizeToolCallToEdit', () => {
    const callOf = (name, args) => ({ function: { name, arguments: JSON.stringify(args) } });

    test('cardapp_write_file (new) emits set on files["<path>"]', async () => {
        const a = createCardAppStudioAdapter(makeDeps());
        const live = await a.live();
        const edits = await a.normalizeToolCallToEdit(
            callOf('cardapp_write_file', { path: 'new.js', content: 'const x = 1;' }),
            { live, session: {} },
        );
        expect(edits).toEqual([{ op: 'set', path: 'files["new.js"]', oldValue: undefined, newValue: 'const x = 1;' }]);
    });

    test('cardapp_write_file (existing) emits set with oldValue', async () => {
        const a = createCardAppStudioAdapter(makeDeps());
        const live = await a.live();
        const edits = await a.normalizeToolCallToEdit(
            callOf('cardapp_write_file', { path: 'index.js', content: 'replaced' }),
            { live, session: {} },
        );
        expect(edits[0]).toMatchObject({ op: 'set', path: 'files["index.js"]', newValue: 'replaced' });
        expect(edits[0].oldValue).toContain("console.log('hi')");
    });

    test('cardapp_patch_file emits str_replace on files["<path>"]', async () => {
        const a = createCardAppStudioAdapter(makeDeps());
        const live = await a.live();
        const edits = await a.normalizeToolCallToEdit(
            callOf('cardapp_patch_file', { path: 'index.js', old_text: "'hi'", new_text: "'bye'" }),
            { live, session: {} },
        );
        expect(edits).toEqual([{ op: 'str_replace', path: 'files["index.js"]', find: "'hi'", replace: "'bye'" }]);
    });

    test('cardapp_delete_file emits unset with expected_value', async () => {
        const a = createCardAppStudioAdapter(makeDeps());
        const live = await a.live();
        const edits = await a.normalizeToolCallToEdit(
            callOf('cardapp_delete_file', { path: 'index.js' }),
            { live, session: {} },
        );
        expect(edits[0]).toMatchObject({ op: 'unset', path: 'files["index.js"]' });
        expect(edits[0].expected_value).toContain("console.log('hi')");
    });

    test('cardapp_rename_file emits unset(from) + set(to)', async () => {
        const a = createCardAppStudioAdapter(makeDeps());
        const live = await a.live();
        const edits = await a.normalizeToolCallToEdit(
            callOf('cardapp_rename_file', { from_path: 'index.js', to_path: 'renamed.js' }),
            { live, session: {} },
        );
        expect(edits).toHaveLength(2);
        expect(edits[0]).toMatchObject({ op: 'unset', path: 'files["index.js"]' });
        expect(edits[1]).toMatchObject({ op: 'set', path: 'files["renamed.js"]', oldValue: undefined });
        expect(edits[1].newValue).toContain("console.log('hi')");
    });

    test('cardapp_list_files / cardapp_read_file are classified as control (return null from normalizer)', async () => {
        const a = createCardAppStudioAdapter(makeDeps());
        expect(a.classifyToolCall({ function: { name: 'cardapp_list_files', arguments: '{}' } })).toBe('control');
        expect(a.classifyToolCall({ function: { name: 'cardapp_read_file', arguments: '{"path":"x"}' } })).toBe('control');
        expect(a.classifyToolCall({ function: { name: 'cardapp_write_file', arguments: '{}' } })).toBe('editable');
    });

    test('malformed JSON args returns null (drift signal)', async () => {
        const a = createCardAppStudioAdapter(makeDeps());
        const live = await a.live();
        const edits = await a.normalizeToolCallToEdit(
            { function: { name: 'cardapp_write_file', arguments: '{not json' } },
            { live, session: {} },
        );
        expect(edits).toBeNull();
    });
});

describe('CEA CardApp Studio adapter — commit()', () => {
    test('first commit saves all files (no prior snapshot)', async () => {
        const deps = makeDeps();
        const a = createCardAppStudioAdapter(deps);
        await a.live();  // primes snapshot? No — live() should not prime; commit must call fetchFileList itself or rely on baseline state. Assume commit reads previous-commit cache.
        const newLive = { files: { 'index.js': 'A', 'b.js': 'B' }, metadata: { charId: 'char_abc' } };
        await a.commit(newLive);
        expect(deps._calls.save.map(c => c.path).sort()).toEqual(['b.js', 'index.js']);
    });

    test('subsequent commit writes only changed files', async () => {
        const deps = makeDeps();
        const a = createCardAppStudioAdapter(deps);
        await a.commit({ files: { 'a.js': 'A1' }, metadata: { charId: 'char_abc' } });
        deps._calls.save.length = 0;
        await a.commit({ files: { 'a.js': 'A2', 'b.js': 'B1' }, metadata: { charId: 'char_abc' } });
        expect(deps._calls.save.map(c => c.path).sort()).toEqual(['a.js', 'b.js']);
    });

    test('commit removes files dropped from the map', async () => {
        const deps = makeDeps();
        const a = createCardAppStudioAdapter(deps);
        await a.commit({ files: { 'a.js': 'A', 'b.js': 'B' }, metadata: { charId: 'char_abc' } });
        deps._calls.save.length = 0;
        await a.commit({ files: { 'a.js': 'A' }, metadata: { charId: 'char_abc' } });
        expect(deps._calls.remove.map(c => c.path)).toEqual(['b.js']);
    });

    test('commit calls reloadCardApp after writes', async () => {
        let reloaded = 0;
        const deps = makeDeps({ reloadCardApp: () => { reloaded++; } });
        const a = createCardAppStudioAdapter(deps);
        await a.commit({ files: { 'a.js': 'A' }, metadata: { charId: 'char_abc' } });
        expect(reloaded).toBe(1);
    });
});

describe('CEA CardApp Studio adapter — session storage (character sidecar)', () => {
    function withSidecarDeps() {
        const sidecar = { sessions: {} };
        return makeDeps({
            getCharacterState: (avatar, ns) => {
                if (avatar === 'char_abc' && ns === 'cardapp_studio_sessions_v2') return sidecar;
                return null;
            },
            setCharacterState: (avatar, ns, val) => {
                if (avatar === 'char_abc' && ns === 'cardapp_studio_sessions_v2') Object.assign(sidecar, val);
            },
            _sidecar: sidecar,
        });
    }

    test('saveSession persists into sidecar bucket; listSessions returns meta', async () => {
        const deps = withSidecarDeps();
        const a = createCardAppStudioAdapter(deps);
        await a.saveSession('char_char_abc', { id: 's1', title: 'first', updatedAt: 100, messages: [] });
        const list = await a.listSessions('char_char_abc');
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({ id: 's1', title: 'first', updatedAt: 100 });
    });

    test('loadSession deep-clones the persisted blob', async () => {
        const deps = withSidecarDeps();
        const a = createCardAppStudioAdapter(deps);
        await a.saveSession('char_char_abc', { id: 's1', title: 't', updatedAt: 0, messages: [{ role: 'user', content: 'hi' }] });
        const loaded = await a.loadSession('char_char_abc', 's1');
        expect(loaded.messages).toEqual([{ role: 'user', content: 'hi' }]);
        loaded.messages[0].content = 'mutated';
        const reloaded = await a.loadSession('char_char_abc', 's1');
        expect(reloaded.messages[0].content).toBe('hi');
    });

    test('deleteSession removes from sidecar', async () => {
        const deps = withSidecarDeps();
        const a = createCardAppStudioAdapter(deps);
        await a.saveSession('char_char_abc', { id: 's1', title: 't', updatedAt: 0, messages: [] });
        await a.deleteSession('char_char_abc', 's1');
        const list = await a.listSessions('char_char_abc');
        expect(list).toEqual([]);
    });
});

describe('CEA CardApp Studio adapter — clearObsoleteSessions', () => {
    test('wipes the v1 cardapp_studio_sessions sidecar key', async () => {
        const sidecar = { v1: { sessions: [{ id: 'old' }] }, v2: { sessions: {} } };
        const deps = makeDeps({
            getCharacterState: (avatar, ns) => {
                if (ns === 'cardapp_studio_sessions') return sidecar.v1;
                if (ns === 'cardapp_studio_sessions_v2') return sidecar.v2;
                return null;
            },
            setCharacterState: (avatar, ns, val) => {
                if (ns === 'cardapp_studio_sessions') sidecar.v1 = val;
                if (ns === 'cardapp_studio_sessions_v2') sidecar.v2 = val;
            },
        });
        const a = createCardAppStudioAdapter(deps);
        await a.clearObsoleteSessions('char_char_abc');
        expect(sidecar.v1).toBeFalsy();  // null or empty
    });
});

describe('CEA CardApp Studio adapter — buildToolCatalog', () => {
    test('exposes 6 cardapp_* tool definitions', () => {
        const a = createCardAppStudioAdapter(makeDeps());
        const tools = a.buildToolCatalog({});
        const names = tools.map(t => t.function?.name).sort();
        expect(names).toEqual([
            'cardapp_delete_file',
            'cardapp_list_files',
            'cardapp_patch_file',
            'cardapp_read_file',
            'cardapp_rename_file',
            'cardapp_write_file',
        ]);
    });
});

describe('CEA CardApp Studio adapter — prompts', () => {
    test('buildSystemPrompt mentions CardApp Studio role + file ops', () => {
        const a = createCardAppStudioAdapter(makeDeps());
        const sys = a.buildSystemPrompt({});
        expect(sys).toMatch(/CardApp/i);
        expect(sys).toMatch(/cardapp_write_file|cardapp_patch_file/);
    });

    test('buildUserPrompt includes the user text', async () => {
        const a = createCardAppStudioAdapter(makeDeps());
        await a.live();
        const usr = a.buildUserPrompt({}, 'add a footer', { reference: null });
        expect(usr).toContain('add a footer');
    });
});

describe('CEA CardApp Studio adapter — render hooks', () => {
    test('renderMessageCard escapes user content', () => {
        const a = createCardAppStudioAdapter(makeDeps());
        const html = a.renderMessageCard({ role: 'user', content: '<script>x</script>' }, {});
        expect(html).toContain('&lt;script&gt;');
    });

    test('renderHistoryItem includes id + title', () => {
        const a = createCardAppStudioAdapter(makeDeps());
        const html = a.renderHistoryItem({ id: 's1', title: 'First', updatedAt: 0 });
        expect(html).toContain('data-id="s1"');
        expect(html).toContain('First');
    });

    test('renderPreviewPane returns split-pane skeleton', () => {
        const a = createCardAppStudioAdapter(makeDeps());
        const html = a.renderPreviewPane({});
        expect(html).toContain('card-app-studio-file-tree');
        expect(html).toContain('card-app-studio-editor-wrap');
    });

    test('renderToolbarSlots includes reload-preview button', () => {
        const a = createCardAppStudioAdapter(makeDeps());
        const slots = a.renderToolbarSlots({});
        expect(slots.end).toContain('cardapp-reload-preview');
    });

    test('handleAction("cardapp-reload-preview") invokes deps.reloadCardApp', async () => {
        let reloaded = 0;
        const deps = makeDeps({ reloadCardApp: () => { reloaded++; } });
        const a = createCardAppStudioAdapter(deps);
        await a.handleAction('cardapp-reload-preview', { session: {}, root: null });
        expect(reloaded).toBe(1);
    });
});

describe('CEA CardApp Studio adapter — control tool execution', () => {
    function makeIsolatedDeps() {
        // Earlier describe blocks (commit, sidecar) mutate the module-level
        // `fakeFiles` map. Build a fresh per-test map so read tests see the
        // original content regardless of describe ordering.
        const files = new Map([
            ['index.js', "console.log('hi');\n"],
            ['styles/main.css', 'body { color: red; }\n'],
        ]);
        return makeDeps({
            fetchFileList: async () => Array.from(files.keys()),
            fetchFileContent: async (_charId, path) => files.get(path) ?? '',
        });
    }

    test('cardapp_list_files returns JSON list', async () => {
        const a = createCardAppStudioAdapter(makeIsolatedDeps());
        const result = await a.executeControlToolCall(
            { function: { name: 'cardapp_list_files', arguments: '{}' } },
            { session: {}, live: null },
            null,
        );
        const parsed = JSON.parse(result.content);
        expect(parsed.files).toContain('index.js');
        expect(parsed.files).toContain('styles/main.css');
    });

    test('cardapp_read_file returns file content as string', async () => {
        const a = createCardAppStudioAdapter(makeIsolatedDeps());
        const result = await a.executeControlToolCall(
            { function: { name: 'cardapp_read_file', arguments: '{"path":"index.js"}' } },
            { session: {}, live: null },
            null,
        );
        expect(result.content).toContain("console.log('hi')");
    });
});
