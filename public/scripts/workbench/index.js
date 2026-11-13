// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Workbench entry point: a resident pill in the bottom-right corner (mounted
// once Luker is ready), a wand-menu item, Alt+W shortcut, and deferred open()
// handler wired via registry.js. The window itself loads lazily.

import { registerLensSharedLocaleData } from '../lens-shared/locale-data.js';
import { i18n } from './i18n.js';
import { registerWorkbenchLocaleData } from './locale-data.js';
import { setOpenHandler } from './registry.js';
import { ensureWorkbenchStyles, mountWorkbench } from './app.js';
import { registerBuiltinTargets } from './targets/index.js';

const MENU_ID = 'luker_workbench_wand_item';
const THIRD_PARTY_COPY = /third-party\/luker-workbench$/i;

const getContext = () => globalThis.Luker?.getContext?.() ?? globalThis.lukerContext ?? null;

let handle = null;
let initialized = false;
let boundAppReady = null;
let keydownBound = false;
let unregisterBuiltinTargets = null;

function workbenchSettings() {
    const ext = getContext()?.extensionSettings || {};
    return ext.workbench ?? ext.luker_workbench;
}

function mount({ collapsed }) {
    if (handle) return handle;
    try {
        ensureWorkbenchStyles();
        handle = mountWorkbench({
            startCollapsed: collapsed,
            onClose: () => { handle = null; },
        });
        return handle;
    } catch (err) {
        console.error('[workbench] failed to open', err);
        globalThis.toastr?.error?.(String(err?.message || err), i18n('Workbench'));
        return null;
    }
}

async function open(opts = null) {
    const instance = handle || mount({ collapsed: false });
    if (!instance) return null;
    if (opts && typeof opts === 'object' && Object.keys(opts).length > 0) {
        instance.open(opts);
    } else if (instance.isCollapsed()) {
        instance.expand();
    } else {
        instance.focus?.();
    }
    return instance;
}

async function toggle() {
    if (!handle) return open();
    handle.toggle();
    return handle;
}

function addMenuItem() {
    if (typeof document === 'undefined') return;
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById(MENU_ID)) return;
    const item = document.createElement('div');
    item.id = MENU_ID;
    item.className = 'list-group-item flex-container flexGap5';
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    const iconEl = document.createElement('div');
    iconEl.className = 'fa-solid fa-table-columns extensionsMenuExtensionButton';
    const label = document.createElement('span');
    label.textContent = i18n('Workbench');
    item.append(iconEl, label);
    item.addEventListener('click', () => open());
    item.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            open();
        }
    });
    menu.appendChild(item);
}

function hotkeyOn() {
    return (workbenchSettings()?.hotkey ?? 'alt+w') === 'alt+w';
}

function onKeydown(event) {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.code !== 'KeyW') return;
    if (!hotkeyOn()) return;
    event.preventDefault();
    toggle();
}

function mountPill() {
    addMenuItem();
    if (workbenchSettings()?.pill === false) return;
    if (!handle) mount({ collapsed: true });
}

/** The former third-party copy would open a second window on every shortcut press. */
function thirdPartyCopyActive() {
    const ctx = getContext();
    const names = ctx?.listExtensionNames?.() || [];
    const disabled = ctx?.extensionSettings?.disabledExtensions || [];
    return names.some(name => THIRD_PARTY_COPY.test(name) && !disabled.includes(name));
}

export function initWorkbench() {
    if (initialized) return;
    const ctx = getContext();
    if (!ctx) return;

    const { addLocaleData, eventSource, eventTypes } = ctx;
    if (typeof addLocaleData === 'function') {
        registerLensSharedLocaleData(addLocaleData);
        registerWorkbenchLocaleData(addLocaleData);
    }
    if (thirdPartyCopyActive()) {
        console.warn('[workbench] the third-party copy is still enabled; remove it to use the built-in one');
        return;
    }

    initialized = true;
    unregisterBuiltinTargets?.();
    unregisterBuiltinTargets = registerBuiltinTargets();
    ensureWorkbenchStyles();
    addMenuItem();

    if (typeof document !== 'undefined' && !keydownBound) {
        document.addEventListener('keydown', onKeydown);
        keydownBound = true;
    }

    setOpenHandler((opts) => open(opts));

    if (eventSource && eventTypes?.APP_READY) {
        boundAppReady = mountPill;
        eventSource.on(eventTypes.APP_READY, boundAppReady);
    }
}

export function resetWorkbenchForTest() {
    const ctx = getContext();
    if (boundAppReady && ctx?.eventSource && ctx?.eventTypes?.APP_READY) {
        ctx.eventSource.off?.(ctx.eventTypes.APP_READY, boundAppReady);
    }
    boundAppReady = null;
    if (typeof document !== 'undefined' && keydownBound) {
        document.removeEventListener('keydown', onKeydown);
        keydownBound = false;
    }
    if (typeof document !== 'undefined') {
        document.getElementById(MENU_ID)?.remove();
    }
    setOpenHandler(null);
    unregisterBuiltinTargets?.();
    unregisterBuiltinTargets = null;
    handle?.close?.();
    handle = null;
    initialized = false;
}
