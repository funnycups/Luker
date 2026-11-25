/** @jest-environment jsdom */

import { describe, test, expect, beforeAll, beforeEach, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

// Host events (connection profile, chat, character card changes) refresh
// an already mounted orchestrator drawer through `refreshUiStateFromHost`.
// That refresh must keep every editor draft whose source did not change:
// global drafts always, character drafts unless the avatar changed or the
// active card's orchestrator data for that mode changed. The real
// editor-state module runs; only host-page module-load shims are stubbed.

const extensionSettings = { orchestrator: {} };

globalThis.Luker = {
    getContext: () => ({
        extensionSettings,
        saveSettings: async () => ({ ok: true, status: 'saved', payload: { extension_settings: JSON.parse(JSON.stringify(extensionSettings)) } }),
        translate: (s) => String(s ?? ''),
        skills: { list: async () => [] },
        constants: {
            promptRoles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
            wiPosition: { before: 0, after: 1, ANTop: 2, ANBottom: 3, EMTop: 4, EMBottom: 5, atDepth: 6 },
        },
        lib: { yaml: { dump: (v) => JSON.stringify(v), load: (s) => JSON.parse(s) } },
    }),
};

jest.unstable_mockModule('../../public/lib.js', async () => {
    const { default: lodash } = await import('lodash');
    return { lodash, yaml: { dump: (v) => JSON.stringify(v), load: (s) => JSON.parse(s) } };
});
jest.unstable_mockModule('../../public/scripts/extensions/connection-manager/profile-resolver.js', () => ({
    getChatCompletionConnectionProfiles: () => [],
}));
jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
    Popup: class {},
    POPUP_TYPE: { TEXT: 0, CONFIRM: 1 },
    POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: -1 },
    callGenericPopup: async () => null,
}));
jest.unstable_mockModule('../../public/scripts/st-context.js', () => ({ getContext: () => globalThis.Luker.getContext() }));
jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
    extension_settings: extensionSettings,
    getContext: () => ({}),
    writeExtensionField: async () => {},
    UNSET_VALUE: Symbol('unset'),
}));
jest.unstable_mockModule('../../public/script.js', () => ({
    saveSettingsDebounced: () => {},
    saveSettings: async () => {},
}));
jest.unstable_mockModule('../../public/scripts/world-info.js', () => ({
    world_info_position: { before: 0, after: 1, ANTop: 2, ANBottom: 3, EMTop: 4, EMBottom: 5, atDepth: 6 },
    wi_anchor_position: {},
}));
jest.unstable_mockModule('../../public/scripts/utils.js', () => ({ escapeHtml: (s) => String(s) }));
jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    addLocaleData: () => {},
    translate: (s) => String(s ?? ''),
    getCurrentLocale: () => 'en',
    t: (s) => String(s ?? ''),
}));

let editorState;
let editorPersist;

beforeAll(async () => {
    editorState = await import('../../public/scripts/extensions/orchestrator/editor-state.js');
    editorPersist = await import('../../public/scripts/extensions/orchestrator/editor-persist.js');
});

const DRAFT_KEYS = [
    'globalEditor', 'characterEditor',
    'globalAgendaEditor', 'characterAgendaEditor',
    'globalLoopEditor', 'characterLoopEditor',
    'globalDirectorEditor', 'characterDirectorEditor',
];

const specPreset = (name, presetId) => ({
    name,
    spec: { stages: [{ id: 'main', mode: 'serial', nodes: [{ id: presetId, preset: presetId }] }] },
    presets: { [presetId]: { systemPrompt: `${name} prompt`, userPromptTemplate: '' } },
});

function makeCard(avatar, orchestrator) {
    return { avatar, name: avatar, data: { extensions: orchestrator ? { orchestrator } : {} } };
}

function snapshotDrafts() {
    return Object.fromEntries(DRAFT_KEYS.map(key => [key, editorState.uiState[key]]));
}

beforeEach(() => {
    extensionSettings.orchestrator = {
        presetLibraries: {
            spec: { alpha: specPreset('Alpha', 'scout') },
            agenda: {}, loop: {}, director: {},
        },
        activePresetIds: { spec: 'alpha', agenda: '', loop: '', director: '' },
    };
});

describe('refreshUiStateFromHost', () => {
    test('keeps every draft when nothing it was loaded from changed', () => {
        const cardExt = {
            presetLibraries: { spec: { own: specPreset('Own', 'critic') } },
            activePresetIds: { spec: 'own' },
        };
        const context = { characters: [makeCard('card.png', cardExt)], characterId: 0 };
        editorState.initializeUiState(context);
        const { uiState } = editorState;
        uiState.globalEditor.presets.scout.systemPrompt = 'unsaved global edit';
        uiState.characterEditor.presets.critic.systemPrompt = 'unsaved card edit';
        uiState.characterLoopEditor.system_prompt = 'unsaved card loop edit';
        const before = snapshotDrafts();

        editorState.refreshUiStateFromHost(context);
        expect(snapshotDrafts()).toEqual(before);
        for (const key of DRAFT_KEYS) expect(uiState[key]).toBe(before[key]);

        // A card save reloads the character from the server: a new object
        // with the same data must not count as a source change.
        context.characters = JSON.parse(JSON.stringify(context.characters));
        editorState.refreshUiStateFromHost(context);
        for (const key of DRAFT_KEYS) expect(uiState[key]).toBe(before[key]);
        expect(uiState.globalEditor.presets.scout.systemPrompt).toBe('unsaved global edit');
        expect(uiState.characterEditor.presets.critic.systemPrompt).toBe('unsaved card edit');
        expect(uiState.characterLoopEditor.system_prompt).toBe('unsaved card loop edit');
    });

    test('reloads only the character draft whose card data changed', () => {
        const context = { characters: [makeCard('card.png', null)], characterId: 0 };
        editorState.initializeUiState(context);
        const { uiState } = editorState;
        uiState.globalEditor.presets.scout.systemPrompt = 'unsaved global edit';
        uiState.characterLoopEditor.system_prompt = 'unsaved card loop edit';
        const before = snapshotDrafts();
        expect(uiState.specDisplayedScope).toBe('global');

        context.characters = [makeCard('card.png', {
            presetLibraries: { spec: { own: specPreset('Own', 'critic') } },
            activePresetIds: { spec: 'own' },
        })];
        editorState.refreshUiStateFromHost(context);

        expect(uiState.characterEditor).not.toBe(before.characterEditor);
        expect(uiState.characterEditor.presets.critic.systemPrompt).toBe('Own prompt');
        expect(uiState.characterEditor.enabled).toBe(true);
        expect(uiState.specDisplayedScope).toBe('character');
        expect(uiState.characterActivePresetIds.spec).toBe('own');
        for (const key of DRAFT_KEYS.filter(k => k !== 'characterEditor')) {
            expect(uiState[key]).toBe(before[key]);
        }
        expect(uiState.globalEditor.presets.scout.systemPrompt).toBe('unsaved global edit');
        expect(uiState.characterLoopEditor.system_prompt).toBe('unsaved card loop edit');

        // The reloaded draft now matches the card again and is kept.
        const reloaded = uiState.characterEditor;
        reloaded.presets.critic.systemPrompt = 'unsaved edit after reload';
        editorState.refreshUiStateFromHost(context);
        expect(uiState.characterEditor).toBe(reloaded);
    });

    test('swaps the character drafts when the active avatar changes', () => {
        const context = {
            characters: [
                makeCard('first.png', null),
                makeCard('second.png', {
                    presetLibraries: { spec: { own: specPreset('Second', 'critic') } },
                    activePresetIds: { spec: 'own' },
                }),
            ],
            characterId: 0,
        };
        editorState.initializeUiState(context);
        const { uiState } = editorState;
        uiState.globalEditor.presets.scout.systemPrompt = 'unsaved global edit';
        const before = snapshotDrafts();

        context.characterId = 1;
        editorState.refreshUiStateFromHost(context);

        expect(uiState.selectedAvatar).toBe('second.png');
        for (const key of DRAFT_KEYS.filter(k => k.startsWith('character'))) {
            expect(uiState[key]).not.toBe(before[key]);
            expect(uiState[key].avatar).toBe('second.png');
        }
        expect(uiState.characterEditor.presets.critic.systemPrompt).toBe('Second prompt');
        expect(uiState.specDisplayedScope).toBe('character');
        expect(uiState.globalEditor).toBe(before.globalEditor);
        expect(uiState.globalEditor.presets.scout.systemPrompt).toBe('unsaved global edit');
    });

    test('keeps a character draft loaded from a card with the legacy overrideEnabled flags', () => {
        // The flag shape settles on first read and only in memory, so a card
        // save brings the unsettled shape back from the server.
        const legacyCard = () => makeCard('card.png', {
            presetLibraries: { spec: { own: specPreset('Own', 'critic') } },
            activePresetIds: { spec: '' },
            overrideEnabled: { spec: true },
        });
        const context = { characters: [legacyCard()], characterId: 0 };
        editorState.initializeUiState(context);
        const { uiState } = editorState;
        expect(uiState.characterEditor.enabled).toBe(true);
        expect(uiState.characterEditor.presets.critic.systemPrompt).toBe('Own prompt');
        uiState.characterEditor.presets.critic.systemPrompt = 'unsaved card edit';
        const before = snapshotDrafts();

        editorState.refreshUiStateFromHost(context);
        for (const key of DRAFT_KEYS) expect(uiState[key]).toBe(before[key]);

        context.characters = [legacyCard()];
        editorState.refreshUiStateFromHost(context);
        for (const key of DRAFT_KEYS) expect(uiState[key]).toBe(before[key]);
        expect(uiState.characterEditor.presets.critic.systemPrompt).toBe('unsaved card edit');
    });

    test('keeps an unsaved character draft when only its merged global base changes', () => {
        const context = {
            characters: [makeCard('card.png', {
                presetLibraries: { spec: { own: specPreset('Own', 'critic') } },
                activePresetIds: { spec: 'own' },
            })],
            characterId: 0,
        };
        editorState.initializeUiState(context);
        const { uiState } = editorState;
        expect(uiState.characterEditor.presets.scout.systemPrompt).toBe('Alpha prompt');
        uiState.characterEditor.presets.critic.systemPrompt = 'unsaved card edit';
        uiState.characterLoopEditor.system_prompt = 'unsaved card loop edit';
        // An explicit display choice survives a reload caused by the global base only.
        uiState.specDisplayedScope = 'global';
        const before = snapshotDrafts();

        extensionSettings.orchestrator.presetLibraries.spec.alpha.presets.scout.systemPrompt = 'Saved global prompt';
        editorState.refreshUiStateFromHost(context);

        expect(uiState.characterEditor).not.toBe(before.characterEditor);
        expect(uiState.characterEditor.presets.scout.systemPrompt).toBe('Saved global prompt');
        expect(uiState.characterEditor.presets.critic.systemPrompt).toBe('unsaved card edit');
        expect(uiState.specDisplayedScope).toBe('global');
        for (const key of DRAFT_KEYS.filter(k => k !== 'characterEditor')) {
            expect(uiState[key]).toBe(before[key]);
        }
        expect(uiState.characterLoopEditor.system_prompt).toBe('unsaved card loop edit');

        const reloaded = uiState.characterEditor;
        editorState.refreshUiStateFromHost(context);
        expect(uiState.characterEditor).toBe(reloaded);
    });
});

describe('refreshCharacterDraftIfSourceChanged', () => {
    test.each(['active slot', 'card source', 'global base'])('an owned write cannot acknowledge a changed %s on the same draft', change => {
        extensionSettings.orchestrator.presetLibraries.loop = { base: { name: 'Base', system_prompt: 'base' } };
        extensionSettings.orchestrator.activePresetIds.loop = 'base';
        const ext = {
            presetLibraries: { loop: { own: { name: 'Own', system_prompt: 'saved' }, next: { name: 'Next', system_prompt: 'next' } } },
            activePresetIds: { loop: 'own' },
        };
        const context = { characters: [makeCard('card.png', ext)], characterId: 0 };
        editorState.initializeUiState(context);
        const draft = editorState.uiState.characterLoopEditor;
        draft.system_prompt = 'unsaved';
        ext.presetLibraries.loop.own.max_rounds = 9;
        const written = editorState.getCharacterDraftSourceFingerprint(context, 'card.png', 'loop');
        if (change === 'active slot') ext.activePresetIds.loop = 'next';
        if (change === 'card source') ext.presetLibraries.loop.own.system_prompt = 'external';
        if (change === 'global base') extensionSettings.orchestrator.presetLibraries.loop.base.system_prompt = 'external base';
        expect(editorState.getCharacterDraftForMode('loop')).toBe(draft);
        expect(editorState.acknowledgeCharacterDraftSource(context, 'card.png', 'loop', draft, written)).toBe(false);
        editorState.refreshUiStateFromHost(context);
        expect(editorState.uiState.characterLoopEditor).not.toBe(draft);
    });

    test('acknowledging an owned character write keeps unsaved draft content at host refresh', () => {
        const context = { characters: [makeCard('card.png', {
            presetLibraries: { loop: { own: { name: 'Own', system_prompt: 'saved', max_rounds: 4 } } },
            activePresetIds: { loop: 'own' },
        })], characterId: 0 };
        editorState.initializeUiState(context);
        const draft = editorState.uiState.characterLoopEditor;
        draft.system_prompt = 'unsaved';
        context.characters[0].data.extensions.orchestrator.presetLibraries.loop.own.max_rounds = 9;
        editorState.acknowledgeCharacterDraftSource(context, 'card.png', 'loop');
        editorState.refreshUiStateFromHost(context);
        expect(editorState.uiState.characterLoopEditor).toBe(draft);
        expect(draft.system_prompt).toBe('unsaved');
    });

    test('a write for another avatar cannot acknowledge the selected draft', () => {
        const context = { characters: [makeCard('card.png', { presetLibraries: { loop: {} }, activePresetIds: { loop: '' } }), makeCard('other.png', null)], characterId: 0 };
        editorState.initializeUiState(context);
        const draft = editorState.uiState.characterLoopEditor;
        context.characters[0].data.extensions.orchestrator.presetLibraries.loop.changed = { name: 'Changed' };
        editorState.acknowledgeCharacterDraftSource(context, 'other.png', 'loop');
        editorState.refreshUiStateFromHost(context);
        expect(editorState.uiState.characterLoopEditor).not.toBe(draft);
    });
    test('reloads only the given mode and only when its sources changed', () => {
        const context = {
            characters: [makeCard('card.png', {
                presetLibraries: { spec: { own: specPreset('Own', 'critic') } },
                activePresetIds: { spec: 'own' },
            })],
            characterId: 0,
        };
        editorState.initializeUiState(context);
        const { uiState } = editorState;
        const before = snapshotDrafts();

        expect(editorState.refreshCharacterDraftIfSourceChanged(context, 'spec')).toBe(false);
        expect(uiState.characterEditor).toBe(before.characterEditor);

        extensionSettings.orchestrator.presetLibraries.spec.alpha.presets.scout.systemPrompt = 'Saved global prompt';
        expect(editorState.refreshCharacterDraftIfSourceChanged(context, 'agenda')).toBe(false);
        expect(uiState.characterAgendaEditor).toBe(before.characterAgendaEditor);
        expect(editorState.refreshCharacterDraftIfSourceChanged(context, 'spec')).toBe(true);
        expect(uiState.characterEditor.presets.scout.systemPrompt).toBe('Saved global prompt');
        for (const key of DRAFT_KEYS.filter(k => k !== 'characterEditor')) {
            expect(uiState[key]).toBe(before[key]);
        }
    });
});

describe('reloadPresetDraft', () => {
    test('reloads the global draft and the character draft that merges it', () => {
        extensionSettings.orchestrator.presetLibraries.loop = { watch: { name: 'Watch', system_prompt: 'Global loop prompt' } };
        extensionSettings.orchestrator.activePresetIds.loop = 'watch';
        const context = { characters: [makeCard('card.png', null)], characterId: 0 };
        editorState.initializeUiState(context);
        const { uiState } = editorState;
        expect(uiState.characterLoopEditor.system_prompt).toBe('Global loop prompt');
        uiState.characterEditor.presets.scout.systemPrompt = 'unsaved card edit';
        const before = snapshotDrafts();

        extensionSettings.orchestrator.presetLibraries.loop.watch.system_prompt = 'Applied loop prompt';
        editorState.reloadPresetDraft(context, 'loop');

        expect(uiState.globalLoopEditor.system_prompt).toBe('Applied loop prompt');
        expect(uiState.characterLoopEditor.system_prompt).toBe('Applied loop prompt');
        for (const key of DRAFT_KEYS.filter(k => k !== 'globalLoopEditor' && k !== 'characterLoopEditor')) {
            expect(uiState[key]).toBe(before[key]);
        }

        // Nothing is left to reload at the next host event.
        const reloaded = snapshotDrafts();
        editorState.refreshUiStateFromHost(context);
        for (const key of DRAFT_KEYS) expect(uiState[key]).toBe(reloaded[key]);
        expect(uiState.characterEditor.presets.scout.systemPrompt).toBe('unsaved card edit');
    });
});

describe('auto-saved global runtime limits and custom tools', () => {
    test.each(['limits', 'tools'])('failed character %s auto-save does not acknowledge its source', async kind => {
        const context = { characters: [makeCard('card.png', {
            presetLibraries: { loop: { own: { name: 'Own', system_prompt: 'saved', max_rounds: 4 } } }, activePresetIds: { loop: 'own' },
        })], characterId: 0, writeExtensionField: async () => { throw new Error('write failure'); } };
        editorState.initializeUiState(context);
        const draft = editorState.uiState.characterLoopEditor;
        const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const ok = kind === 'limits'
                ? await editorPersist.persistRuntimeLimitsKeepingDrafts(context, extensionSettings.orchestrator, 'loop', 'character', { max_rounds: 9 }, { avatar: 'card.png' })
                : await editorPersist.persistCustomToolsKeepingDrafts(context, extensionSettings.orchestrator, 'loop', 'character', [], { avatar: 'card.png' });
            expect(ok).toBe(false);
            context.characters[0].data.extensions.orchestrator.presetLibraries.loop.own.system_prompt = 'external';
            editorState.refreshUiStateFromHost(context);
            expect(editorState.uiState.characterLoopEditor).not.toBe(draft);
            expect(editorState.uiState.characterLoopEditor.system_prompt).toBe('external');
        } finally { spy.mockRestore(); }
    });
    test('a delayed character auto-save cannot acknowledge a replacement draft', async () => {
        let release;
        const saved = new Promise(resolve => { release = resolve; });
        const context = { characters: [makeCard('card.png', {
            presetLibraries: { loop: { own: { name: 'Own', system_prompt: 'saved', max_rounds: 4 }, next: { name: 'Next', system_prompt: 'next' } } },
            activePresetIds: { loop: 'own' },
        })], characterId: 0, writeExtensionField: async () => saved };
        editorState.initializeUiState(context);
        const pending = editorPersist.persistRuntimeLimitsKeepingDrafts(context, extensionSettings.orchestrator, 'loop', 'character', { max_rounds: 9 }, { avatar: 'card.png' });
        context.characters[0].data.extensions.orchestrator.activePresetIds.loop = 'next';
        editorState.refreshUiStateFromHost(context);
        const replacement = editorState.uiState.characterLoopEditor;
        replacement.system_prompt = 'unsaved next';
        context.characters[0].data.extensions.orchestrator.presetLibraries.loop.next.system_prompt = 'external next';
        release();
        await pending;
        editorState.refreshUiStateFromHost(context);
        expect(editorState.uiState.characterLoopEditor).not.toBe(replacement);
        expect(editorState.uiState.characterLoopEditor.system_prompt).toBe('external next');
    });
    test.each(['limits', 'tools'])('successful async character %s writes preserve other unsaved fields at host refresh', async (kind) => {
        const root = await fs.mkdtemp(resolve(tmpdir(), 'orch-draft-'));
        const context = { characters: [makeCard('card.png', {
            presetLibraries: { loop: { own: { name: 'Own', system_prompt: 'saved', max_rounds: 4 } } },
            activePresetIds: { loop: 'own' },
        })], characterId: 0, writeExtensionField: async (_id, key, value) => {
            if (typeof value === 'function') value = await value(JSON.parse(JSON.stringify(context.characters[_id].data.extensions[key])));
            await fs.writeFile(resolve(root, `${key}.json`), JSON.stringify(value));
            context.characters[_id].data.extensions[key] = value;
            return true;
        } };
        try {
            editorState.initializeUiState(context);
            const draft = editorState.uiState.characterLoopEditor;
            draft.system_prompt = 'unsaved';
            const settings = extensionSettings.orchestrator;
            const ok = kind === 'limits'
                ? await editorPersist.persistRuntimeLimitsKeepingDrafts(context, settings, 'loop', 'character', { max_rounds: 9 }, { avatar: 'card.png' })
                : await editorPersist.persistCustomToolsKeepingDrafts(context, settings, 'loop', 'character', [{ name: 'lookup', description: 'Look up', parameters: { type: 'object' } }], { avatar: 'card.png' });
            expect(ok).toBe(true);
            editorState.refreshUiStateFromHost(context);
            expect(editorState.uiState.characterLoopEditor).toBe(draft);
            expect(draft.system_prompt).toBe('unsaved');
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });
    test('rebuild the edit-free character draft from the new global value', async () => {
        extensionSettings.orchestrator.presetLibraries.loop = { watch: { name: 'Watch', system_prompt: 'Global loop prompt', max_rounds: 4 } };
        extensionSettings.orchestrator.activePresetIds.loop = 'watch';
        const context = { characters: [makeCard('card.png', null)], characterId: 0 };
        editorState.initializeUiState(context);
        const { uiState } = editorState;
        expect(uiState.characterLoopEditor.max_rounds).toBe(4);
        uiState.globalEditor.presets.scout.systemPrompt = 'unsaved global spec edit';
        const before = snapshotDrafts();

        const settings = extensionSettings.orchestrator;
        expect(await editorPersist.persistRuntimeLimitsKeepingDrafts(context, settings, 'loop', 'global', { max_rounds: 9 }, { avatar: 'card.png' })).toBe(true);
        expect(uiState.characterLoopEditor.max_rounds).toBe(9);

        const tool = { name: 'lookup', description: 'Look up', parameters: { type: 'object', properties: {} } };
        expect(await editorPersist.persistCustomToolsKeepingDrafts(context, settings, 'loop', 'global', [tool], { avatar: 'card.png' })).toBe(true);
        expect(uiState.characterLoopEditor.customTools.map(t => t.name)).toEqual(['lookup']);

        for (const key of DRAFT_KEYS.filter(k => k !== 'characterLoopEditor')) {
            expect(uiState[key]).toBe(before[key]);
        }

        // Nothing is left to reload at the next host event.
        const reloaded = snapshotDrafts();
        editorState.refreshUiStateFromHost(context);
        for (const key of DRAFT_KEYS) expect(uiState[key]).toBe(reloaded[key]);
        expect(uiState.globalEditor.presets.scout.systemPrompt).toBe('unsaved global spec edit');
    });
});

describe('orchestrator global writes', () => {
    const mainSource = readFileSync(resolve('../public/scripts/extensions/orchestrator/main.js'), 'utf8');
    const lensSourceWrite = readFileSync(resolve('../public/scripts/extensions/orchestrator/lens/source-write.js'), 'utf8');
    const lensIterateTarget = readFileSync(resolve('../public/scripts/extensions/orchestrator/lens/iterate-target.js'), 'utf8');

    test('global writes use the shared acknowledged persistence boundary without wiping unrelated drafts', () => {
        expect(mainSource.match(/uiState\.global\w*Editor\s*=/g) || []).toEqual([]);
        expect(lensSourceWrite.match(/uiState\.global\w*Editor\s*=/g) || []).toEqual([]);
        expect(lensIterateTarget.match(/uiState\.global\w*Editor\s*=/g) || []).toEqual([]);
        expect(lensSourceWrite).toContain('persistGlobalPresetWrite(');
        expect(lensSourceWrite).toContain('refreshUiStateFromHost(');
        expect(lensSourceWrite).not.toMatch(/\binitializeUiState\(/);
        expect(lensIterateTarget).toContain('deps.persistGlobalPresetWrite(');
    });

    test('auto-save runtime limits and custom tools only through the keep-drafts wrappers', () => {
        expect(mainSource).not.toMatch(/\bpersistRuntimeLimitsPatch\(/);
        expect(mainSource).not.toMatch(/\bpersistCustomToolsPatch\(/);
        expect(lensSourceWrite).not.toMatch(/\bpersistRuntimeLimitsPatch\(/);
        expect(lensSourceWrite).not.toMatch(/\bpersistCustomToolsPatch\(/);
        expect(lensSourceWrite).toContain('persistRuntimeLimitsKeepingDrafts(');
        expect(lensSourceWrite).toContain('persistCustomToolsKeepingDrafts(');
    });
});
