/** @jest-environment jsdom */

import { describe, test, expect, beforeAll, beforeEach, jest } from '@jest/globals';

// Rebuilding the Orchestra Lens setup preset selector bar must refresh the
// active preset ids highlighted in the bar without discarding unsaved
// drafts in either Orchestra Lens (`createDrafts`) or `editor-state.js`.

const extensionSettings = { orchestrator: {} };

globalThis.Luker = {
    getContext: () => ({
        extensionSettings,
        translate: (s) => String(s ?? ''),
        getCurrentLocale: () => 'en',
        addLocaleData: () => {},
        skills: { list: async () => [] },
        constants: {
            promptRoles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
            wiPosition: { before: 0, after: 1, ANTop: 2, ANBottom: 3, EMTop: 4, EMBottom: 5, atDepth: 6 },
            unset: Symbol('unset'),
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
    writeExtensionField: async () => true,
    UNSET_VALUE: Symbol('unset'),
}));
jest.unstable_mockModule('../../public/script.js', () => ({
    saveSettingsDebounced: () => {},
    saveSettings: async () => ({ ok: true, status: 'saved' }),
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
    createScopedI18n: () => ({ i18n: (s) => String(s ?? ''), i18nFormat: (s) => String(s ?? '') }),
}));

let editorState;
let createDrafts;
let createSetupView;
let createPresetAccess;
let addStage;
let getActivePreset;

beforeAll(async () => {
    editorState = await import('../../public/scripts/extensions/orchestrator/editor-state.js');
    ({ createDrafts } = await import('../../public/scripts/extensions/orchestrator/lens/model/drafts.js'));
    ({ createSetupView } = await import('../../public/scripts/extensions/orchestrator/lens/views/setup-view.js'));
    ({ createPresetAccess } = await import('../../public/scripts/extensions/orchestrator/lens/source-write.js'));
    ({ addStage } = await import('../../public/scripts/extensions/orchestrator/lens/model/edit.js'));
    ({ getActivePreset } = await import('../../public/scripts/extensions/orchestrator/preset-library.js'));
});

const specPreset = (name, presetId) => ({
    name,
    spec: { stages: [{ id: 'main', mode: 'serial', nodes: [{ id: presetId, preset: presetId }] }] },
    presets: { [presetId]: { systemPrompt: `${name} prompt`, userPromptTemplate: '' } },
});

function makeContext(cardExt) {
    const characters = cardExt
        ? [{ avatar: 'card.png', name: 'Card', data: { extensions: { orchestrator: cardExt } } }]
        : [];
    return { characters, characterId: cardExt ? 0 : undefined };
}

function makeLensSetupHarness(context) {
    const settings = extensionSettings.orchestrator;
    const presets = createPresetAccess(() => ({ ctx: context, settings }));
    const drafts = createDrafts();
    let currentTarget = null;
    let currentProfile = null;

    const syncSnapshotFromSettings = () => {
        const hasCard = Boolean(context.characters?.[0]?.data?.extensions?.orchestrator?.activePresetIds?.spec);
        const scope = hasCard ? 'character' : 'global';
        const avatar = hasCard ? 'card.png' : '';
        const presetId = hasCard
            ? context.characters[0].data.extensions.orchestrator.activePresetIds.spec
            : settings.activePresetIds.spec;
        currentTarget = { mode: 'spec', scope, presetId, avatar, chatKey: 'char:card.png:c1' };
        currentProfile = getActivePreset(settings, 'spec', { scope, context, avatar }).state;
        drafts.setBase(currentTarget, currentProfile);
        editorState.syncActivePresetIdsFromSettings(context);
    };
    syncSnapshotFromSettings();

    const app = {
        drafts,
        snapshot: () => ({ target: currentTarget, profile: currentProfile, mode: 'spec', presetName: currentProfile?.name || '', cardPinnedMode: '' }),
        canEdit: () => drafts.isCurrent(currentTarget),
        notify: jest.fn(),
        reload: jest.fn(async () => { syncSnapshotFromSettings(); }),
        promptText: jest.fn(async () => null),
        dialog: { ask: jest.fn(async () => '') },
        source: {
            presets,
            edit: {
                allTools: () => ({}),
                baseTools: () => ({}),
                defaultMainPrompt: () => '',
                convertFrom: () => null,
            },
            skills: { inventory: async () => [], mount: () => {} },
            customToolEditor: { registry: () => [], open: async () => null, bridge: async () => {}, importDefaults: () => {}, defaults: () => [] },
            openSkillManager: async () => {},
            openAiIteration: () => {},
        },
    };
    const view = createSetupView(app);
    document.body.innerHTML = '';
    document.body.appendChild(view.el);
    return { view, drafts, syncSnapshotFromSettings };
}

function selectedSpecOption(view) {
    return view.el.querySelector('select[aria-label="Orchestration profile"]')?.value ?? '';
}

beforeEach(() => {
    extensionSettings.orchestrator = {
        presetLibraries: {
            spec: { alpha: specPreset('Alpha', 'scout'), beta: specPreset('Beta', 'critic') },
            agenda: {},
            loop: {},
            director: {},
        },
        activePresetIds: { spec: 'alpha', agenda: '', loop: '', director: '' },
    };
});

describe('Orchestra Lens preset bar refresh', () => {
    test('keeps an edited global draft across structural edits and highlights the stored active preset', () => {
        const context = makeContext(null);
        editorState.initializeUiState(context);
        const hostDraft = editorState.uiState.globalEditor;
        hostDraft.presets.scout.systemPrompt = 'unsaved prompt edit';

        const { view, drafts } = makeLensSetupHarness(context);
        drafts.set('scout', 'system', 'unsaved lens edit');
        drafts.setProfile(addStage(drafts.profile()));
        view.render();

        expect(editorState.uiState.globalEditor).toBe(hostDraft);
        expect(hostDraft.presets.scout.systemPrompt).toBe('unsaved prompt edit');
        expect(drafts.get('scout', 'system')).toBe('unsaved lens edit');
        expect(drafts.profile().spec.stages).toHaveLength(2);
        expect(selectedSpecOption(view)).toBe('global:alpha');
    });

    test('reflects a stored global active preset change without discarding unsaved drafts', () => {
        const context = makeContext(null);
        editorState.initializeUiState(context);
        const hostDraft = editorState.uiState.globalEditor;
        hostDraft.presets.scout.systemPrompt = 'unsaved prompt edit';

        const { view, drafts, syncSnapshotFromSettings } = makeLensSetupHarness(context);
        drafts.set('scout', 'system', 'unsaved lens edit');

        extensionSettings.orchestrator.activePresetIds.spec = 'beta';
        syncSnapshotFromSettings();
        view.render();

        expect(selectedSpecOption(view)).toBe('global:beta');
        expect(editorState.uiState.globalActivePresetIds.spec).toBe('beta');
        expect(editorState.uiState.globalEditor).toBe(hostDraft);
        expect(hostDraft.presets.scout.systemPrompt).toBe('unsaved prompt edit');
        expect(drafts.count()).toBe(0);
        expect(drafts.foreignCount()).toBe(1);
        expect(drafts.totalCount()).toBe(1);

        extensionSettings.orchestrator.activePresetIds.spec = 'alpha';
        syncSnapshotFromSettings();
        expect(drafts.count()).toBe(1);
        expect(drafts.get('scout', 'system')).toBe('unsaved lens edit');
    });

    test('reflects a stored character active preset change without discarding card drafts', () => {
        const cardExt = {
            presetLibraries: { spec: { own1: specPreset('Own 1', 'scout'), own2: specPreset('Own 2', 'critic') } },
            activePresetIds: { spec: 'own1' },
        };
        const context = makeContext(cardExt);
        editorState.initializeUiState(context);
        const cardDraft = editorState.uiState.characterEditor;
        cardDraft.presets.scout.systemPrompt = 'unsaved card edit';

        const { view, drafts, syncSnapshotFromSettings } = makeLensSetupHarness(context);
        drafts.set('scout', 'system', 'unsaved lens card edit');
        view.render();
        expect(selectedSpecOption(view)).toBe('character:own1');

        cardExt.activePresetIds.spec = 'own2';
        syncSnapshotFromSettings();
        view.render();

        expect(selectedSpecOption(view)).toBe('character:own2');
        expect(editorState.uiState.characterActivePresetIds.spec).toBe('own2');
        expect(editorState.uiState.characterEditor).toBe(cardDraft);
        expect(cardDraft.presets.scout.systemPrompt).toBe('unsaved card edit');
        expect(drafts.count()).toBe(0);
        expect(drafts.foreignCount()).toBe(1);
        expect(drafts.totalCount()).toBe(1);

        cardExt.activePresetIds.spec = 'own1';
        syncSnapshotFromSettings();
        expect(drafts.count()).toBe(1);
        expect(drafts.get('scout', 'system')).toBe('unsaved lens card edit');
    });
});
