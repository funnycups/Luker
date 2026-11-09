// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Memory Lens entry point: adds a wand-menu item and lazily loads the
// workspace UI the first time it is opened. The tag filter and the token
// recorder start here because they work while the lens is closed.

import { registerLensSharedLocaleData } from '../../lens-shared/locale-data.js';
import { startTagFilter } from './filter/filter-runtime.js';
import { i18n } from './i18n.js';
import { registerLensLocaleData } from './locale-data.js';
import { startRecorder } from './token-stats.js';

const MENU_ID = 'memory_lens_wand_item';
const getContext = () => Luker.getContext();

let handle = null;
let opening = null;

export async function openMemoryLens() {
    if (handle) {
        handle.focus();
        return;
    }
    if (opening) return opening;
    opening = (async () => {
        const [{ mountMemoryLens }, { createLukerSource }] = await Promise.all([
            import('./app.js'),
            import('./source-luker.js'),
        ]);
        handle = mountMemoryLens({
            source: createLukerSource(),
            onClose: () => { handle = null; },
        });
    })();
    try {
        await opening;
    } catch (err) {
        console.error('[memory-graph/lens] failed to open', err);
        toastr.error(String(err?.message || err), i18n('Memory Lens'));
    } finally {
        opening = null;
    }
}

function closeMemoryLens() {
    handle?.close();
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
    icon.className = 'fa-solid fa-circle-nodes extensionsMenuExtensionButton';
    const label = document.createElement('span');
    label.textContent = i18n('Memory Lens');
    item.append(icon, label);
    item.addEventListener('click', openMemoryLens);
    item.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openMemoryLens();
        }
    });
    menu.appendChild(item);
}

export function initMemoryLens() {
    const { addLocaleData } = getContext();
    registerLensSharedLocaleData(addLocaleData);
    registerLensLocaleData(addLocaleData);
    addMenuItem();
    try {
        startTagFilter(getContext);
    } catch (err) {
        console.warn('[memory-graph/lens] tag filter unavailable', err);
    }
    startRecorder(getContext);
    // Luker Workbench looks the lens up through this global.
    globalThis.MemoryLens = Object.freeze({ open: openMemoryLens, close: closeMemoryLens });
}
