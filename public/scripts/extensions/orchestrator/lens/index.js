// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Orchestra Lens entry point:
//   - wand-menu item for the full-screen lens (loaded lazily on first open)
//   - a recorder on every run-panel store (orchestrator and search agent), so
//     runs are captured even while the lens is closed
//   - the dock that replaces the native run panels (it can be turned off from
//     the dock's menu; then the native panels come back)

import { createRecorder } from './model/recorder.js';
import { buildFlow } from './model/profile.js';
import { createLukerSource } from './source-luker.js';
import { installTakeover, setNativeHidden } from './dock/takeover.js';
import { i18n } from './i18n.js';
import { registerLensLocaleData } from './locale-data.js';

const MENU_ID = 'orchestra_lens_wand_item';
const DOCK_MENU_ID = 'orchestra_lens_dock_item';
const TAKEOVER_KEY = 'orchestraLens.takeover';
const getContext = () => Luker.getContext();

let handle = null;
let opening = null;
let runtimeReady = null;

export function takeoverEnabled() {
    try { return globalThis.localStorage?.getItem(TAKEOVER_KEY) !== 'off'; } catch { return true; }
}

function startRuntime() {
    if (!runtimeReady) {
        runtimeReady = (async () => {
            const source = createLukerSource();
            const recorder = createRecorder({ getRunContext: (from) => source.runContext(from) });
            let dock = null;
            let lastStart = 0;
            recorder.subscribe((kind) => { if (kind === 'start') lastStart = Date.now(); });
            const enabled = takeoverEnabled();
            setNativeHidden(enabled);
            installTakeover({
                onStore: (store, from) => recorder.attach(store, from),
                // Native panels also open themselves when a run starts; only
                // redirect explicit opens (the "show run panel" button).
                onNativeOpen: () => { if (Date.now() - lastStart > 800) dock?.open(); },
            });
            recorder.attach(source.runStore(), 'orchestrator');
            if (enabled) {
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
                dock = createDock({ recorder, getFlow: () => flow, openLens: (key) => open(key), onDiagnose: (key) => open(key, { diagnose: true }), onRestoreNative: () => setTakeover(false) });
            }
            return { recorder, source, dock: () => dock };
        })().catch((err) => {
            console.error('[orchestrator/lens] failed to start', err);
            runtimeReady = null;
            throw err;
        });
    }
    return runtimeReady;
}

async function open(runId = '', { diagnose = false } = {}) {
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
        handle = mountOrchestraLens({ source, recorder, takeover: { enabled: takeoverEnabled, set: setTakeover }, onClose: () => { handle = null; } });
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

function close() {
    handle?.close();
}

async function toggleDock() {
    const runtime = await startRuntime();
    const dock = runtime.dock();
    if (dock) dock.toggle();
    else toastr.info(i18n('The run panel is off. You can turn it back on from the History page of Orchestra Lens.'));
}

/** Turns the dock on or off. Off brings the native run panels back (applies after reload). */
function setTakeover(on) {
    try { globalThis.localStorage?.setItem(TAKEOVER_KEY, on ? 'on' : 'off'); } catch { /* optional */ }
    toastr.info(i18n('Reload the page to apply.'));
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
    if (!document.getElementById(MENU_ID)) menu.appendChild(menuItem(MENU_ID, 'fa-diagram-project', i18n('Orchestra Lens'), () => open()));
    if (takeoverEnabled() && !document.getElementById(DOCK_MENU_ID)) menu.appendChild(menuItem(DOCK_MENU_ID, 'fa-list-check', i18n('Run panel'), toggleDock));
}

export function initOrchestraLens() {
    const { addLocaleData } = getContext();
    registerLensLocaleData(addLocaleData);
    addMenuItems();
    // Hide the native panels right away so they never flash.
    if (takeoverEnabled()) document.documentElement.classList.add('ol-takeover');
    startRuntime().catch(() => {});
    // Luker Workbench looks the lens up through this global.
    globalThis.OrchestraLens = Object.freeze({ open, close, toggleDock, setTakeover, takeoverEnabled });
}
