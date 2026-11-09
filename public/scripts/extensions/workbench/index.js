// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Workbench entry point: a resident pill in the bottom-right corner (mounted
// once Luker is ready), a wand-menu item and Alt+W for the floating window.
// The window itself loads lazily.

import { registerLensSharedLocaleData } from '../lens-shared/locale-data.js';
import { extensionNames } from '../../extensions.js';
import { i18n } from './i18n.js';
import { registerWorkbenchLocaleData } from './locale-data.js';

const MENU_ID = 'luker_workbench_wand_item';
const THIRD_PARTY_COPY = /third-party\/luker-workbench$/i;
const getContext = () => Luker.getContext();

let handle = null;
let opening = null;

async function mount({ collapsed }) {
    if (handle) return handle;
    if (opening) return opening;
    opening = (async () => {
        const [{ mountWorkbench }, source] = await Promise.all([
            import('./app.js'),
            import('./source-luker.js'),
        ]);
        handle = mountWorkbench({ source, startCollapsed: collapsed, onClose: () => { handle = null; } });
        return handle;
    })();
    try {
        return await opening;
    } catch (err) {
        console.error('[workbench] failed to open', err);
        toastr.error(String(err?.message || err), i18n('Workbench'));
        return null;
    } finally {
        opening = null;
    }
}

async function open() {
    const instance = handle || await mount({ collapsed: false });
    instance?.expand();
}

async function toggle() {
    if (!handle) return open();
    handle.toggle();
}

function addMenuItem() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById(MENU_ID)) return;
    const item = document.createElement('div');
    item.id = MENU_ID;
    item.className = 'list-group-item flex-container flexGap5';
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    const icon = document.createElement('div');
    icon.className = 'fa-solid fa-table-columns extensionsMenuExtensionButton';
    const label = document.createElement('span');
    label.textContent = i18n('Workbench');
    item.append(icon, label);
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
    const settings = getContext().extensionSettings.luker_workbench;
    return (settings?.hotkey ?? 'alt+w') === 'alt+w';
}

function onKeydown(event) {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.code !== 'KeyW') return;
    if (!hotkeyOn()) return;
    event.preventDefault();
    toggle();
}

function mountPill() {
    if (!handle && !opening) mount({ collapsed: true });
}

/** The former third-party copy would open a second window on every shortcut press. */
function thirdPartyCopyActive() {
    const disabled = getContext().extensionSettings.disabledExtensions || [];
    return extensionNames.some(name => THIRD_PARTY_COPY.test(name) && !disabled.includes(name));
}

function init() {
    const { addLocaleData, eventSource, eventTypes } = getContext();
    registerLensSharedLocaleData(addLocaleData);
    registerWorkbenchLocaleData(addLocaleData);
    if (thirdPartyCopyActive()) {
        console.warn('[workbench] the third-party copy is still enabled; remove it to use the built-in one');
        return;
    }
    addMenuItem();
    document.addEventListener('keydown', onKeydown);
    // APP_READY is an auto-fire event: late listeners are called right away.
    eventSource.on(eventTypes.APP_READY, mountPill);
}

init();
