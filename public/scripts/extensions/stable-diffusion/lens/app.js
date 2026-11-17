// SPDX-License-Identifier: AGPL-3.0-or-later

import { h, clear, put } from '../../../lens-shared/util.js';
import { segmented } from '../../../lens-shared/ui.js';
import { createStudioView } from './views/studio-view.js';
import { createCharactersView } from './views/characters-view.js';
import { createRunView } from './views/run-view.js';
import { icon } from './icons.js';
import { i18n } from './i18n.js';

const STYLE_LINK_ID = 'luker-sd-lens-css';
const VALID_SUBVIEWS = new Set(['studio', 'characters', 'run']);

export function ensureSdLensStyles(doc = globalThis.document) {
    if (!doc?.head) return;
    if (!doc.getElementById(STYLE_LINK_ID)) {
        const link = doc.createElement('link');
        link.id = STYLE_LINK_ID;
        link.rel = 'stylesheet';
        link.href = new URL('./style.css', import.meta.url).href;
        doc.head.appendChild(link);
    }
}

export function mountSdLens({
    container,
    hostApp = null,
    opts = null,
    getContext = () => globalThis.Luker?.getContext?.(),
    getRunStore = () => null,
    imageService = null,
} = {}) {
    ensureSdLensStyles(container?.ownerDocument || globalThis.document);

    let activeView = VALID_SUBVIEWS.has(opts?.subview) ? opts.subview : 'studio';
    const root = h('div', {
        class: 'lw-surface sdlens',
        role: 'region',
        'aria-label': i18n('Image Generation'),
        tabIndex: -1,
    });
    const topBar = h('header', { class: 'sdlens-top' });
    const body = h('div', { class: 'sdlens-body' });
    put(root, topBar, body);

    const app = {
        root,
        hostApp,
        getContext,
        getRunStore,
        imageService,
        toast(message, toastOpts = {}) {
            if (typeof hostApp?.toast === 'function') {
                hostApp.toast(message, toastOpts);
                return;
            }
            if (toastOpts?.error) {
                globalThis.toastr?.error?.(message, i18n('Image Generation'));
            } else {
                globalThis.toastr?.info?.(message, i18n('Image Generation'));
            }
        },
        recordHistory({ label, title, from, lines, undo }) {
            if (typeof hostApp?.history?.record === 'function' && typeof undo === 'function') {
                hostApp.history.record({
                    ws: 'sd',
                    title: String(title || label || ''),
                    from: String(from || i18n('Image Generation')),
                    lines: Array.isArray(lines) ? lines : [],
                    undo,
                });
            }
        },
        switchView(viewId, viewOpts = {}) {
            if (!VALID_SUBVIEWS.has(viewId)) return;
            activeView = viewId;
            renderShell(viewOpts);
        },
        openStudioForCharacterDesign(designReq) {
            activeView = 'studio';
            renderShell({ characterDesign: designReq });
        },
    };

    const views = {
        studio: createStudioView(app),
        characters: createCharactersView(app),
        run: createRunView(app),
    };

    function renderTopBar() {
        clear(topBar);
        const navOptions = [
            { value: 'studio', label: i18n('Image Studio'), iconName: 'image', tone: 'sd' },
            { value: 'characters', label: i18n('Character Archive'), iconName: 'users' },
            { value: 'run', label: i18n('Run Traces'), iconName: 'run' },
        ];
        const seg = segmented(navOptions, activeView, (next) => {
            app.switchView(next);
        }, {
            ariaLabel: i18n('Image Generation'),
            renderIcon: icon,
            iconOnlyMobile: true,
        });
        const segBtns = seg.querySelectorAll('.lw-seg-btn');
        navOptions.forEach((opt, idx) => {
            if (segBtns[idx]) segBtns[idx].dataset.sdNav = opt.value;
        });
        put(topBar, seg);
    }

    function renderShell(viewOpts = {}) {
        renderTopBar();
        clear(body);
        const current = views[activeView] || views.studio;
        put(body, current.el);
        current.show?.(viewOpts);
    }

    container.appendChild(root);
    renderShell(opts || {});

    return {
        show(showOpts = {}) {
            if (VALID_SUBVIEWS.has(showOpts?.subview)) {
                activeView = showOpts.subview;
            }
            renderShell(showOpts || {});
        },
        hide() {},
        update(nextOpts = {}) {
            if (VALID_SUBVIEWS.has(nextOpts?.subview)) {
                activeView = nextOpts.subview;
            }
            renderShell(nextOpts || {});
        },
        onEscape: () => false,
        destroy() {
            views.studio.destroy?.();
            views.characters.destroy?.();
            views.run.destroy?.();
            root.remove();
        },
    };
}
