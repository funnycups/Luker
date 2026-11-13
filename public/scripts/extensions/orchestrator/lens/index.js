// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Orchestra Lens entry point:
//   - registers the embedded 'orch' workspace, AskProvider, SuggestRuleProvider,
//     and 'orch' IterateTarget with Workbench
//   - attaches the orchestrator's RunStore to the shared Run Panel Dock
//     (unless a third-party copy of orchestra-lens is active)
//   - wand-menu item for toggling the shared Run Panel Dock

import { registerLensSharedLocaleData } from '../../../lens-shared/locale-data.js';
import { sanitizeDirectorProfile } from '../defaults.js';
import { sanitizeAgendaWorkingProfile } from '../agenda-profile.js';
import {
    clearCharacterExtensionForMode,
    getCharacterActivePresetId,
    getCharacterDisplayNameByAvatar,
    getCharacterExtensionDataByAvatar,
    getCharacterIndexByAvatar,
    getRuntimePresetScope,
} from '../character-overrides.js';
import { sanitizePresetMap } from '../editable-spec.js';
import { getIterationDefaultScope } from '../editor-display.js';
import { persistOrchestratorCharacterExtension } from '../editor-persist.js';
import { initializeUiState } from '../editor-state.js';
import {
    ITERATION_MODE_PROMPT_DEFAULTS,
    buildAiIterationSystemPrompt,
    buildAiIterationToolSet,
    executeAiIterationToolCalls,
    getDefaultRequestSystemPrompt,
    getSettings,
} from '../main.js';
import { sanitizeLoopProfile } from '../persistence.js';
import {
    getActivePreset,
    getActivePresetId,
    sanitizePresetEntry,
    writeActivePreset,
} from '../preset-library.js';
import { promptEmbedUnembeddedPresetsForCharacterApply } from '../prompt-embed-unembedded.js';
import { getLatestOrchestrationEntry } from '../snapshot-cache.js';
import { sanitizeSpec } from '../spec-schema.js';
import { buildDiagnoseDraft } from './app.js';
import { i18n } from './i18n.js';
import { createOrchIterateTarget } from './iterate-target.js';
import { registerLensLocaleData } from './locale-data.js';
import { buildFlow } from './model/profile.js';
import { buildRunView } from './model/run.js';
import { createOrchAskProvider, createOrchSuggestRuleProvider } from './providers.js';
import { createLukerSource } from './source-luker.js';

const DOCK_MENU_ID = 'orchestra_lens_dock_item';
const THIRD_PARTY_COPY = /third-party\/orchestra-lens$/i;
const getContext = () => Luker.getContext();

let unregisters = [];
let warnedThirdParty = false;

/** The former third-party copy would wrap the run panel and record every run a second time. */
function thirdPartyCopyActive(ctx) {
    const names = ctx?.listExtensionNames?.() || [];
    const disabled = ctx?.extensionSettings?.disabledExtensions || [];
    return names.some(name => THIRD_PARTY_COPY.test(name) && !disabled.includes(name));
}

function menuItem(id, iconClass, label, onActivate) {
    const item = document.createElement('div');
    item.id = id;
    item.className = 'list-group-item flex-container flexGap5';
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    const icon = document.createElement('div');
    icon.className = `fa-solid ${iconClass} extensionsMenuExtensionButton`;
    const text = document.createElement('span');
    text.textContent = label;
    item.append(icon, text);
    item.addEventListener('click', () => onActivate());
    item.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onActivate();
        }
    });
    return item;
}

function addMenuItems(ctx) {
    if (typeof document === 'undefined') return;
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return;
    if (!document.getElementById(DOCK_MENU_ID)) {
        menu.appendChild(menuItem(DOCK_MENU_ID, 'fa-list-check', i18n('Run panel'), () => toggleDock(ctx)));
    }
}

export async function openRunDock(ctx = getContext()) {
    if (typeof ctx?.runPanel?.openRunDock === 'function') {
        await ctx.runPanel.openRunDock();
    } else {
        await ctx?.workbench?.open?.({ ws: 'orch', subview: 'run' });
    }
}

async function toggleDock(ctx = getContext()) {
    if (typeof ctx?.runPanel?.toggleRunDock === 'function') {
        await ctx.runPanel.toggleRunDock();
    } else {
        await ctx?.workbench?.open?.({ ws: 'orch', subview: 'run' });
    }
}

export function initOrchestraLens() {
    const ctx = getContext();
    const { addLocaleData, workbench, runPanel } = ctx || {};
    if (typeof addLocaleData === 'function') {
        registerLensSharedLocaleData(addLocaleData);
        registerLensLocaleData(addLocaleData);
    }

    for (const unreg of unregisters.splice(0)) unreg?.();

    const deps = {
        getSettings,
        getDefaultRequestSystemPrompt,
        ITERATION_MODE_PROMPT_DEFAULTS,
        buildAiIterationToolSet,
        buildAiIterationSystemPrompt,
        executeAiIterationToolCalls,
        getIterationDefaultScope,
        initializeUiState,
        persistOrchestratorCharacterExtension,
        clearCharacterExtensionForMode,
        getCharacterActivePresetId,
        getCharacterDisplayNameByAvatar,
        getCharacterExtensionDataByAvatar,
        getCharacterIndexByAvatar,
        getRuntimePresetScope,
        getActivePreset,
        getActivePresetId,
        sanitizePresetEntry,
        writeActivePreset,
        sanitizeLoopProfile,
        sanitizeAgendaWorkingProfile,
        sanitizeDirectorProfile,
        sanitizeSpec,
        sanitizePresetMap,
        getLatestOrchestrationEntry,
        promptEmbedUnembeddedPresetsForCharacterApply,
    };

    if (workbench) {
        unregisters.push(
            workbench.registerWorkspace({
                id: 'orch',
                get title() { return i18n('Orchestration'); },
                icon: 'orch',
                order: 20,
                tone: 'orch',
                flush: true,
                mount(container, { app: hostApp, opts } = {}) {
                    let instance = null;
                    let pendingOpts = opts || null;
                    let destroyed = false;
                    const mounting = Promise.all([
                        import('./app.js'),
                        import('./source-luker.js'),
                    ]).then(([{ mountOrchestraLens }, { createLukerSource }]) => {
                        if (destroyed) return;
                        instance = mountOrchestraLens({
                            source: createLukerSource({
                                onError: (msg) => hostApp?.toast?.(msg, { error: true }),
                            }),
                            container,
                            hostApp,
                            opts: pendingOpts,
                            embedded: true,
                        });
                    }).catch((err) => {
                        console.error('[orchestrator/lens] failed to mount workspace', err);
                        hostApp?.toast?.(String(err?.message || err), { error: true });
                    });
                    return {
                        show(showOpts) {
                            if (instance) instance.show(showOpts);
                            else if (showOpts) pendingOpts = showOpts;
                            void mounting;
                        },
                        hide() {
                            instance?.hide?.();
                        },
                        update(nextOpts) {
                            if (instance) instance.update(nextOpts);
                            else if (nextOpts) pendingOpts = nextOpts;
                        },
                        onEscape: () => instance?.onEscape?.() || false,
                        onSnapshot: () => instance?.onSnapshot?.(),
                        destroy() {
                            destroyed = true;
                            instance?.destroy?.();
                            instance = null;
                        },
                    };
                },
            }),
            workbench.registerAskProvider(createOrchAskProvider(getContext, deps)),
            workbench.registerSuggestRuleProvider(createOrchSuggestRuleProvider(getContext, deps)),
            workbench.registerIterateTarget?.(createOrchIterateTarget(getContext, deps)),
        );
    }

    addMenuItems(ctx);

    if (thirdPartyCopyActive(ctx)) {
        if (!warnedThirdParty) {
            warnedThirdParty = true;
            console.warn('[orchestrator/lens] the third-party copy is still enabled; remove it to use the built-in one');
            globalThis.toastr?.warning?.(
                i18n('The third-party Orchestra Lens is still enabled. Remove it to use the built-in one.'),
                i18n('Orchestra Lens'),
            );
        }
        return;
    }

    if (runPanel?.attachDock) {
        const source = createLukerSource();
        let cachedFlow = null;
        const refreshFlow = async () => {
            try {
                const snap = await source.load();
                cachedFlow = buildFlow(snap.profile, { mode: snap.mode, settings: snap.settings });
            } catch {
                cachedFlow = null;
            }
        };
        void refreshFlow();
        const rec = runPanel.getRunRecorder?.();
        const unsubRec = rec?.subscribe?.((kind) => {
            if (kind === 'start') void refreshFlow();
        });
        if (typeof unsubRec === 'function') unregisters.push(unsubRec);

        const openDiagnose = (runKey) => {
            const recorder = runPanel.getRunRecorder?.();
            const raw = recorder?.history?.()?.find(item => `${item.source || 'orchestrator'}:${item.runId}` === runKey || item.runId === runKey)
                || recorder?.currents?.()?.find(item => `${item.source || 'orchestrator'}:${item.runId}` === runKey || item.runId === runKey)
                || null;
            const view = raw ? buildRunView(raw, Object.keys(cachedFlow?.agents || {})) : null;
            const draft = buildDiagnoseDraft({ runKey, runView: view });
            void getContext()?.workbench?.open?.({ page: 'ai', ws: 'orch', draft });
        };

        runPanel.attachDock(source.runStore(), {
            source: 'orchestrator',
            getRunContext: () => source.runContext('orchestrator'),
            getFlow: () => cachedFlow,
            onInspect: (runKey) => void getContext()?.workbench?.open?.({ ws: 'orch', subview: 'run', runKey }),
            onDiagnose: (runKey) => openDiagnose(runKey),
        });
    }
}
