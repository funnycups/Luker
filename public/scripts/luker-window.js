// Luker window: the floating window shell shared by the Account window and its pages.
// Provides the top-layer dialog, draggable title bar, side navigation, per-tab page stack,
// sticky footer, toast, confirm, help popover, colour schemes and Escape handling.
import { t } from './i18n.js';

export const ICONS = {
    sync: '<path d="M20 11a8 8 0 0 0-14.9-3.5M4 4v4h4M4 13a8 8 0 0 0 14.9 3.5M20 20v-4h-4"/>',
    more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
    undo: '<path d="M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3M15 8l2 2"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    qr: '<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2zM14 18h2M18 14h2"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    chev: '<path d="m9 6 6 6-6 6"/>',
    back: '<path d="m15 6-6 6 6 6"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
    cloud: '<path d="M7 18a5 5 0 0 1-.6-10A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9z"/>',
    lan: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    warn: '<path d="M12 4 2.5 20h19zM12 10v4M12 17h.01"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    check: '<path d="m5 12 5 5 9-10"/>',
    eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    unlock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/>',
    download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
    upload: '<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>',
    restore: '<path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.6M4 4v4.6h4.6"/><path d="M12 8v4l3 2"/>',
    move: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
    zip: '<path d="M6 3h9l4 4v14H6zM14 3v5h5M11 7h1M11 10h1M11 13h1M10.5 16h2v2h-2z"/>',
    db: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/>',
    branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10M18 10c0 4-6 3-11 7"/>',
    chat: '<path d="M5 18 3 21V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2z"/>',
    clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7 7 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 0 1 4.9.7c0 1.6-2.4 2.1-2.4 3.6M12 17h.01"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/>',
    camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
    pie: '<path d="M12 3a9 9 0 1 0 9 9h-9z"/><path d="M15 3.5A9 9 0 0 1 20.5 9H15z"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
    reset: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5"/>',
    skull: '<path d="M12 3a8 8 0 0 0-5 14.2V21h10v-3.8A8 8 0 0 0 12 3z"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><path d="M10 21v-2M14 21v-2"/>',
    shield: '<path d="M12 3 5 6v5c0 4.5 3 8.5 7 10 4-1.5 7-5.5 7-10V6z"/>',
    server: '<rect x="4" y="4" width="16" height="7" rx="1.5"/><rect x="4" y="13" width="16" height="7" rx="1.5"/><path d="M8 7.5h.01M8 16.5h.01"/>',
    browser: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M7 6.5h.01M10 6.5h.01"/>',
};

export const THEMES = [
    { key: 'mist', dark: false, a: '#f3f4f2', b: '#13a68b' },
    { key: 'latte', dark: false, a: '#f3ece2', b: '#c0673b' },
    { key: 'ocean', dark: true, a: '#1c2433', b: '#4fd1b9' },
    { key: 'dusk', dark: true, a: '#2a2833', b: '#a594f9' },
];
const themeLabel = key => ({ mist: t`Mist`, latte: t`Latte`, ocean: t`Ocean`, dusk: t`Dusk` })[key];
// Kept from the Data window so a colour scheme picked there carries over.
const THEME_KEY = 'luker.dataWindow.theme';

/**
 * Reads the saved colour scheme, falling back to the system preference.
 * @returns {string} Theme key
 */
export function loadTheme() {
    const saved = globalThis.localStorage?.getItem(THEME_KEY);
    if (THEMES.some(tp => tp.key === saved)) return saved;
    return globalThis.matchMedia?.('(prefers-color-scheme: light)').matches ? 'mist' : 'ocean';
}

/**
 * Inline SVG icon.
 * @param {string} name Key of ICONS
 * @param {string} [cls] Extra class
 * @returns {string} SVG markup
 */
export const ic = (name, cls = '') => `<svg class="dw-ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;

/**
 * Escapes text for HTML.
 * @param {*} value Any value
 * @returns {string} Escaped text
 */
export function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[ch]);
}

/**
 * Base class for a window rendered into the shell made by mountLukerWindow().
 * Subclasses fill `this.stack` with one page stack per tab and override the hooks below.
 */
export class LukerWindow {
    /**
     * @param {HTMLElement} root Element the window renders into
     * @param {object} options
     * @param {string} options.tab Tab to show first
     */
    constructor(root, { tab }) {
        this.root = root;
        this.tab = tab;
        /** @type {Record<string, Array<{view: string}>>} */
        this.stack = {};
        this.help = false;
        this.themeMenu = false;
        this.theme = loadTheme();
        this.modal = null;
        this.shownPw = new Set();
        this.root.addEventListener('click', e => this.onClick(e));
    }

    // ---------- hooks ----------

    /** Title shown in the title bar. */
    get windowTitle() {
        return '';
    }

    /** Icon key shown before the title. */
    get windowIcon() {
        return 'db';
    }

    /**
     * Navigation entries; `{ sep: true }` draws a divider.
     * @returns {Array<{key?: string, label?: string, icon?: string, count?: number, danger?: boolean, sep?: boolean}>}
     */
    navItems() {
        return [];
    }

    /** Navigation entries pinned to the bottom of the rail. */
    footItems() {
        return [];
    }

    /** Heading of the current page. */
    pageTitle() {
        return '';
    }

    /** Paragraphs for the help popover of the current page. */
    helpLines() {
        return [];
    }

    /** Extra markup on the right of the page heading. */
    headExtra() {
        return '';
    }

    /** Markup of the current page below its heading. */
    renderView() {
        return '';
    }

    /** Runs after the page markup is (re)built, to attach live DOM. */
    afterRender() {}

    /**
     * Status shown next to the title.
     * @returns {{tone: string, text: string, act?: string} | null}
     */
    statusInfo() {
        return null;
    }

    /** Name of a long job in progress; closing the window asks first. */
    get busyJob() {
        return null;
    }

    /** Handles a data-act the shell does not know. */
    onAction() {}

    /** Releases timers and subscriptions. */
    destroy() {}

    // ---------- page stack ----------

    get top() {
        const s = this.stack[this.tab];
        return s[s.length - 1];
    }

    get viewKey() {
        return this.top.view;
    }

    push(view, params = {}) {
        this.stack[this.tab].push({ view, ...params });
        this.help = false;
        this.shownPw.clear();
        this.render();
    }

    pop() {
        const s = this.stack[this.tab];
        if (s.length > 1) s.pop();
        this.help = false;
        this.shownPw.clear();
        this.render();
    }

    /**
     * Shows a tab (and optionally a page inside it) in the open window.
     * @param {{tab?: string, view?: string}} target
     */
    navigate({ tab, view }) {
        if (tab && this.stack[tab]) this.tab = tab;
        if (view && this.top.view !== view) this.stack[this.tab].push({ view });
        this.shownPw.clear();
        this.render();
    }

    // ---------- rendering ----------

    navButton(item) {
        if (item.sep) return '<hr class="dw-rail-sep">';
        return `<button class="dw-tab${item.danger ? ' is-danger' : ''}" data-act="tab" data-tab="${item.key}" role="tab" aria-selected="${item.key === this.tab}">
            ${ic(item.icon)}<span>${esc(item.label)}</span>${item.count ? `<span class="dw-tab-count">${item.count}</span>` : ''}</button>`;
    }

    render() {
        const foot = this.footItems();
        const help = this.helpLines();
        this.root.innerHTML = `
            <header class="dw-titlebar">
                <span class="dw-mark">${ic(this.windowIcon)}</span>
                <span class="dw-title">${esc(this.windowTitle)}</span>
                <span data-region="status"></span>
                <span class="dw-sp"></span>
                <button class="dw-ibtn${this.themeMenu ? ' on' : ''}" data-act="theme-menu" title="${t`Color scheme`}">${ic(THEMES.find(tp => tp.key === this.theme)?.dark ? 'moon' : 'sun')}</button>
                ${help.length ? `<button class="dw-ibtn${this.help ? ' on' : ''}" data-act="help" title="${t`Help`}">${ic('help')}</button>` : ''}
                <button class="dw-ibtn is-close" data-act="close" title="${t`Close`}">${ic('x')}</button>
            </header>
            <div class="dw-shell">
                <nav class="dw-rail" role="tablist">
                    ${this.navItems().map(i => this.navButton(i)).join('')}
                    ${foot.length ? `<div class="dw-rail-foot">${foot.map(i => this.navButton(i)).join('')}</div>` : ''}
                </nav>
                <main class="dw-main"><div class="dw-body">${this.renderPage()}</div></main>
            </div>
            ${this.themeMenu ? `<div class="dw-themes" role="menu">${THEMES.map(tp => `
                <button class="dw-theme" role="menuitemradio" aria-checked="${tp.key === this.theme}" data-act="theme" data-theme="${tp.key}">
                    <span class="dw-swatch" style="--a:${tp.a};--b:${tp.b}"></span><span>${themeLabel(tp.key)}</span>${tp.key === this.theme ? ic('check') : ''}
                </button>`).join('')}</div>` : ''}
            ${this.help && help.length ? `<div class="dw-pop">${help.map(l => `<p>${esc(l)}</p>`).join('')}</div>` : ''}`;
        this.renderStatus();
        this.revealTab();
        this.afterRender();
    }

    /** Keeps the selected tab in view when the rail scrolls sideways (phone layout). */
    revealTab() {
        const rail = this.root.querySelector('.dw-rail');
        const sel = rail?.querySelector('.dw-tab[aria-selected="true"]');
        if (!sel || rail.scrollWidth <= rail.clientWidth) return;
        const r = rail.getBoundingClientRect();
        const b = sel.getBoundingClientRect();
        rail.scrollLeft += b.left - r.left - (r.width - b.width) / 2;
    }

    renderPage() {
        const deep = this.stack[this.tab].length > 1;
        return `<div class="dw-pagehead" data-view="${esc(this.top.view)}">
            ${deep ? `<button class="dw-ibtn" data-act="back" title="${t`Back`}">${ic('back')}</button>` : ''}
            <h2 class="dw-h2">${esc(this.pageTitle())}</h2>
            <span class="dw-sp"></span>
            ${this.headExtra()}
        </div>${this.renderView()}`;
    }

    /** Rebuilds only the page, keeping the scroll position. */
    rerender() {
        const main = this.root.querySelector('.dw-main');
        const body = this.root.querySelector('.dw-body');
        if (!body) return;
        const scroll = main.scrollTop;
        body.innerHTML = this.renderPage();
        body.style.animation = 'none';
        main.scrollTop = scroll;
        this.afterRender();
    }

    renderStatus() {
        const el = this.root.querySelector('[data-region="status"]');
        if (!el) return;
        const s = this.statusInfo();
        el.outerHTML = s
            ? `<span class="dw-title-ctx" data-region="status" data-tone="${s.tone}" ${s.act ? `data-act="${s.act}" role="button"` : ''}><i class="dw-dot"></i><span>${esc(s.text)}</span></span>`
            : '<span data-region="status"></span>';
    }

    /**
     * Sticky footer holding the page's main buttons.
     * @param {string} html Buttons
     * @returns {string} Markup
     */
    foot(html) {
        return `<div class="dw-foot">${html}</div>`;
    }

    /**
     * Password input with a show/hide button.
     * @param {string} model data-model path
     * @param {string} value Current value
     * @param {string} [placeholder] Placeholder
     * @param {string} [autocomplete] Autocomplete hint
     * @returns {string} Markup
     */
    pw(model, value, placeholder = '', autocomplete = 'new-password') {
        const shown = this.shownPw.has(model);
        return `<span class="dw-pw"><input class="dw-inp" type="${shown ? 'text' : 'password'}" data-model="${model}" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="${autocomplete}"><button class="dw-eye" data-act="eye" type="button" title="${t`Show`}">${ic('eye')}</button></span>`;
    }

    toast(text, error = false) {
        this.root.querySelector('.dw-toast')?.remove();
        const el = document.createElement('div');
        el.className = `dw-toast${error ? ' error' : ''}`;
        el.innerHTML = `${ic(error ? 'x' : 'check')}<span>${esc(text)}</span>`;
        this.root.append(el);
        setTimeout(() => el.remove(), 2800);
    }

    /**
     * Confirmation drawn inside the window.
     * @param {{title: string, text?: string, ok?: string, danger?: boolean}} options
     * @returns {Promise<boolean>} Whether the user confirmed
     */
    confirm({ title, text, ok = t`Proceed`, danger = false }) {
        return new Promise(resolve => {
            const el = document.createElement('div');
            el.className = 'dw-modal';
            el.innerHTML = `
                <div class="dw-modal-card" role="alertdialog">
                    <h4>${esc(title)}</h4>
                    ${text ? `<p>${esc(text)}</p>` : ''}
                    <div class="dw-actions">
                        <button class="dw-btn" data-r="0">${t`Cancel`}</button>
                        <button class="dw-btn ${danger ? 'danger solid' : 'primary'}" data-r="1">${esc(ok)}</button>
                    </div>
                </div>`;
            this.modal = el;
            el.addEventListener('click', e => {
                e.stopPropagation();
                const btn = e.target.closest('[data-r]');
                if (!btn && e.target !== el) return;
                el.remove();
                this.modal = null;
                resolve(btn?.dataset.r === '1');
            });
            this.root.append(el);
            el.querySelector('[data-r="1"]').focus();
        });
    }

    // ---------- popovers & events ----------

    /** Whether a popover is open (Escape closes it before the window). */
    get hasPopover() {
        return this.help || this.themeMenu;
    }

    closePopovers() {
        this.help = false;
        this.themeMenu = false;
        this.render();
    }

    /**
     * Closes popovers when the click lands outside them.
     * @param {MouseEvent} e Click
     * @param {string} [act] data-act of the clicked control
     */
    dismiss(e, act) {
        if (this.help && act !== 'help' && !e.target.closest('.dw-pop')) {
            this.help = false;
            this.root.querySelector('.dw-pop')?.remove();
            this.root.querySelector('[data-act="help"]')?.classList.remove('on');
        }
        if (this.themeMenu && act !== 'theme-menu' && act !== 'theme' && !e.target.closest('.dw-themes')) {
            this.themeMenu = false;
            this.root.querySelector('.dw-themes')?.remove();
            this.root.querySelector('[data-act="theme-menu"]')?.classList.remove('on');
        }
    }

    async onClick(e) {
        const el = e.target.closest('[data-act]');
        const act = el?.dataset.act;
        this.dismiss(e, act);
        if (!el) return;
        switch (act) {
            case 'close': return this.close?.();
            case 'tab':
                this.tab = el.dataset.tab;
                this.help = false;
                this.shownPw.clear();
                return this.render();
            case 'back': return this.pop();
            case 'push': return this.push(el.dataset.view);
            case 'help':
                this.help = !this.help;
                this.themeMenu = false;
                return this.render();
            case 'theme-menu':
                this.themeMenu = !this.themeMenu;
                this.help = false;
                return this.render();
            case 'theme':
                this.theme = el.dataset.theme;
                this.themeMenu = false;
                globalThis.localStorage?.setItem(THEME_KEY, this.theme);
                this.onTheme?.(this.theme);
                return this.render();
            case 'eye': {
                const input = el.previousElementSibling;
                const show = input.type === 'password';
                input.type = show ? 'text' : 'password';
                const model = input.dataset.model;
                if (model) show ? this.shownPw.add(model) : this.shownPw.delete(model);
                return;
            }
        }
        return this.onAction(act, el, e);
    }
}

function makeDraggable(win, root) {
    root.addEventListener('pointerdown', event => {
        const bar = event.target.closest('.dw-titlebar');
        if (!bar || event.button !== 0 || event.target.closest('button, [data-act]') || globalThis.innerWidth <= 640) return;
        event.preventDefault();
        const rect = win.getBoundingClientRect();
        const start = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
        bar.classList.add('is-dragging');
        bar.setPointerCapture?.(event.pointerId);
        const move = e => {
            const left = Math.min(Math.max(start.left + e.clientX - start.x, 120 - rect.width), globalThis.innerWidth - 120);
            const top = Math.min(Math.max(start.top + e.clientY - start.y, 0), globalThis.innerHeight - 46);
            Object.assign(win.style, { left: `${left}px`, top: `${top}px`, transform: 'none', animation: 'none' });
        };
        const end = () => {
            bar.classList.remove('is-dragging');
            bar.removeEventListener('pointermove', move);
            bar.removeEventListener('pointerup', end);
            bar.removeEventListener('pointercancel', end);
        };
        bar.addEventListener('pointermove', move);
        bar.addEventListener('pointerup', end);
        bar.addEventListener('pointercancel', end);
    });
}

/**
 * Builds the window shell, puts it in the top layer and renders the window into it.
 * @param {object} options
 * @param {string} options.label Accessible name of the window
 * @param {(root: HTMLElement) => LukerWindow} options.create Creates the window for the given root
 * @param {() => void} [options.onClosed] Called once the window is gone
 * @returns {{ui: LukerWindow, win: HTMLElement, closed: Promise<void>, close: () => void}}
 */
export function mountLukerWindow({ label, create, onClosed }) {
    // A modal <dialog> joins the top layer, so it sits above Luker popups it is opened from.
    const layer = document.createElement('dialog');
    layer.className = 'dw-layer';
    const scrim = document.createElement('div');
    scrim.className = 'dw-scrim';
    const win = document.createElement('section');
    win.className = 'dw-win';
    win.setAttribute('role', 'dialog');
    win.setAttribute('aria-label', label);
    win.tabIndex = -1;
    const root = document.createElement('div');
    root.className = 'dw';
    win.append(root);
    layer.append(scrim, win);

    let resolveClosed;
    const closed = new Promise(resolve => resolveClosed = resolve);
    const ui = create(root);
    layer.dataset.theme = ui.theme;
    ui.onTheme = theme => layer.dataset.theme = theme;
    const onKey = e => {
        if (e.key !== 'Escape') return;
        // Luker popups opened from the window sit above it and handle their own Escape.
        if (!layer.contains(e.target) && e.target !== document.body) return;
        e.stopPropagation();
        if (ui.modal) return ui.modal.querySelector('[data-r="0"]')?.click();
        if (ui.hasPopover) return ui.closePopovers();
        requestClose();
    };
    // Long jobs keep running on the server; closing only hides their progress.
    async function requestClose() {
        const job = ui.busyJob;
        if (job && !await ui.confirm({ title: t`${job}. Close the window anyway?`, text: t`The task keeps running on the server. Reopen the window to see its progress.`, ok: t`Close` })) return;
        close();
    }
    let closedOnce = false;
    function close() {
        if (closedOnce) return;
        closedOnce = true;
        ui.destroy();
        document.removeEventListener('keydown', onKey, true);
        layer.remove();
        onClosed?.();
        resolveClosed();
    }
    ui.close = close;
    root.addEventListener('click', e => {
        if (e.target.closest('[data-act="close"]')) {
            e.stopImmediatePropagation();
            requestClose();
        }
    }, true);
    layer.addEventListener('cancel', e => e.preventDefault());
    document.addEventListener('keydown', onKey, true);
    makeDraggable(win, root);
    document.body.append(layer);
    layer.showModal();
    ui.render();
    win.focus();
    return { ui, win, closed, close };
}
