// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Memory Lens entry point: adds a wand-menu item and lazily loads the
// workspace UI the first time it is opened. The tag filter and the token
// recorder start here because they work while the lens is closed.

import { extensionNames } from '../../../extensions.js';
import { registerLensSharedLocaleData } from '../../lens-shared/locale-data.js';
import { startTagFilter } from './filter/filter-runtime.js';
import { i18n } from './i18n.js';
import { registerLensLocaleData } from './locale-data.js';
import { startRecorder } from './token-stats.js';

const MENU_ID = 'memory_lens_wand_item';
const THIRD_PARTY_COPY = /third-party\/memory-lens$/i;
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

/** The former third-party copy would run the tag filter and token recorder a second time. */
function thirdPartyCopyActive() {
    const disabled = getContext().extensionSettings.disabledExtensions || [];
    return extensionNames.some(name => THIRD_PARTY_COPY.test(name) && !disabled.includes(name));
}

export function initMemoryLens() {
    const { addLocaleData } = getContext();
    registerLensSharedLocaleData(addLocaleData);
    registerLensLocaleData(addLocaleData);
    addMenuItem();
    // The old copy would run the filter and recorder a second time.
    if (thirdPartyCopyActive()) {
        toastr.warning(i18n('Please remove the third-party Memory Lens; the built-in one replaces it'), i18n('Memory Lens'));
        return;
    }
    try {
        startTagFilter(getContext);
    } catch (err) {
        console.warn('[memory-graph/lens] tag filter unavailable', err);
    }
    startRecorder(getContext);
}
