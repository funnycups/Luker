// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Orchestra Lens entry point:
//   - wand-menu item for the full-screen lens (loaded lazily on first open)
//   - a recorder on every run-panel store (orchestrator and search agent), so
//     runs are captured even while the lens is closed
//   - the run dock, which shows orchestration and search progress

import { extensionNames } from '../../../extensions.js';
import { accountLocalStorage } from '../../lens-shared/current-account.js';
import { createRecorder } from './model/recorder.js';
import { buildFlow } from './model/profile.js';
import { createLukerSource } from './source-luker.js';
import { i18n } from './i18n.js';
import { registerLensLocaleData } from './locale-data.js';

const MENU_ID = 'orchestra_lens_wand_item';
const DOCK_MENU_ID = 'orchestra_lens_dock_item';
const THIRD_PARTY_COPY = /third-party\/orchestra-lens$/i;
const getContext = () => Luker.getContext();

let handle = null;
let opening = null;
let runtimeReady = null;

function startRuntime() {
    if (!runtimeReady) {
        runtimeReady = (async () => {
            const source = createLukerSource();
            const recorder = createRecorder({ storage: accountLocalStorage(), getRunContext: (from) => source.runContext(from) });
            // The third-party copy records runs itself; here only the lens window is offered.
            if (thirdPartyCopyActive()) {
                source.runStore = null;
                return { recorder, source, dock: () => null };
            }
            let dock = null;
            recorder.attach(source.runStore(), 'orchestrator');
            // search-tools loads before us but builds its store when ready; pick it up either way.
            const attachSearch = () => {
                const store = source.searchRunStore();
                if (store) recorder.attach(store, 'search');
            };
            attachSearch();
            try {
                const { eventSource, eventTypes } = getContext();
                eventSource.on('luker.search-tools.run-store-ready', attachSearch);
                eventSource.on(eventTypes.APP_READY, attachSearch);
            } catch { /* host gone */ }
            const { createDock } = await import('./dock/dock.js');
            let flow = null;
            const refreshFlow = async () => {
                try {
                    const snap = await source.load();
                    flow = buildFlow(snap.profile, { mode: snap.mode, settings: snap.settings });
                } catch { flow = null; }
            };
            void refreshFlow();
            recorder.subscribe((kind) => { if (kind === 'start') void refreshFlow().then(() => dock?.refresh()); });
            dock = createDock({ recorder, getFlow: () => flow, openLens: (key) => openOrchestraLens(key), onDiagnose: (key) => openOrchestraLens(key, { diagnose: true }) });
            return { recorder, source, dock: () => dock };
        })().catch((err) => {
            console.error('[orchestrator/lens] failed to start', err);
            runtimeReady = null;
            throw err;
        });
    }
    return runtimeReady;
}

export async function openOrchestraLens(runId = '', { diagnose = false } = {}) {
    const show = () => {
        if (runId) handle.app.openRun(runId);
        if (runId && diagnose) handle.app.diagnose(runId);
    };
    if (handle) {
        handle.focus();
        show();
        return;
    }
    if (opening) return opening;
    opening = (async () => {
        const [{ mountOrchestraLens }, { recorder, source, dock }] = await Promise.all([import('./app.js'), startRuntime()]);
        dock()?.close();
        handle = mountOrchestraLens({ source, recorder, onClose: () => { handle = null; } });
        show();
    })();
    try {
        await opening;
    } catch (err) {
        console.error('[orchestrator/lens] failed to open', err);
        toastr.error(String(err?.message || err), i18n('Orchestra Lens'));
    } finally {
        opening = null;
    }
}

/** Shows the run dock (the lens's run view when the dock is off). */
export async function openRunDock() {
    const runtime = await startRuntime();
    const dock = runtime.dock();
    if (dock) dock.open();
    else await openOrchestraLens();
}

async function toggleDock() {
    const runtime = await startRuntime();
    const dock = runtime.dock();
    if (dock) dock.toggle();
    else await openOrchestraLens();
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

function addMenuItems() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return;
    if (!document.getElementById(MENU_ID)) menu.appendChild(menuItem(MENU_ID, 'fa-diagram-project', i18n('Orchestra Lens'), () => openOrchestraLens()));
    if (!document.getElementById(DOCK_MENU_ID)) menu.appendChild(menuItem(DOCK_MENU_ID, 'fa-list-check', i18n('Run panel'), toggleDock));
}

/** The former third-party copy would wrap the run panel and record every run a second time. */
function thirdPartyCopyActive() {
    const disabled = getContext().extensionSettings.disabledExtensions || [];
    return extensionNames.some(name => THIRD_PARTY_COPY.test(name) && !disabled.includes(name));
}

export function initOrchestraLens() {
    const { addLocaleData } = getContext();
    registerLensLocaleData(addLocaleData);
    addMenuItems();
    if (thirdPartyCopyActive()) {
        console.warn('[orchestrator/lens] the third-party copy is still enabled; remove it to use the built-in one');
        toastr.warning(i18n('The third-party Orchestra Lens is still enabled. Remove it to use the built-in one.'), i18n('Orchestra Lens'));
        return;
    }
    startRuntime().catch(() => {});
}
