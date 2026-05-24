/**
 * iteration-library/zoom-overlay — narrow-class breakpoint behavior.
 *
 * The zoom overlay dialog must:
 *   - render dual-column at viewports ≥ 720px (no `luker_lib_diff_zoom_narrow`
 *     class on the dialog)
 *   - stack into a single column with each panel capped at 45vh at
 *     viewports < 720px (class is added by `openExpandedDiff` so the CSS
 *     override can lift)
 *
 * The repo's tests run in `testEnvironment: "node"` (jest.config.json) with
 * no jsdom installed — same constraint as `text-diff.test.js` and
 * `resizer-bind.test.js`. So we hand-build just enough of Element /
 * HTMLElement / Document to exercise `openExpandedDiff`'s overlay-build
 * path. The stub's `innerHTML` setter scans for the four overlay class
 * names the function uses and pre-creates child stubs with those classes
 * so `querySelector` lookups (and the new narrow-class add) succeed.
 */

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';

class StubClassList {
    constructor() { this._set = new Set(); }
    add(...names) { for (const n of names) this._set.add(String(n)); }
    remove(...names) { for (const n of names) this._set.delete(String(n)); }
    contains(name) { return this._set.has(String(name)); }
    toggle(name, force) {
        if (force === true) { this.add(name); return true; }
        if (force === false) { this.remove(name); return false; }
        if (this.contains(name)) { this.remove(name); return false; }
        this.add(name); return true;
    }
}

class StubStyle {
    constructor() { this._props = new Map(); }
    setProperty(name, value) { this._props.set(String(name), String(value)); }
    getPropertyValue(name) { return this._props.get(String(name)) ?? ''; }
}

// Base shape — every node is at minimum an Element. HTMLElement is a
// subclass that adds the `style` slot etc.; `openExpandedDiff` checks
// `instanceof HTMLElement` on every node it touches, so all our stubs
// extend the HTMLElement-flavored class.
class StubElement {
    constructor(tagName = 'div', className = '') {
        this.tagName = String(tagName).toUpperCase();
        this._className = String(className || '');
        this.classList = new StubClassList();
        if (this._className) {
            for (const cls of this._className.split(/\s+/).filter(Boolean)) {
                this.classList.add(cls);
            }
        }
        this.style = new StubStyle();
        this.dataset = {};
        this.attributes = new Map();
        this.children = [];
        this.parent = null;
        this.id = '';
        this._innerHTML = '';
    }
    get className() { return this._className; }
    set className(value) {
        this._className = String(value || '');
        this.classList = new StubClassList();
        for (const cls of this._className.split(/\s+/).filter(Boolean)) {
            this.classList.add(cls);
        }
    }
    setAttribute(name, value) { this.attributes.set(String(name), String(value)); }
    getAttribute(name) {
        const key = String(name);
        if (this.attributes.has(key)) return this.attributes.get(key);
        return null;
    }
    appendChild(child) {
        if (child.parent && child.parent !== this) {
            child.parent.removeChild(child);
        }
        child.parent = this;
        this.children.push(child);
        return child;
    }
    append(...nodes) {
        for (const n of nodes) this.appendChild(n);
    }
    removeChild(child) {
        const i = this.children.indexOf(child);
        if (i >= 0) {
            this.children.splice(i, 1);
            child.parent = null;
        }
        return child;
    }
    remove() {
        if (this.parent) this.parent.removeChild(this);
    }
    cloneNode(deep) {
        const copy = new StubElement(this.tagName.toLowerCase(), this._className);
        for (const [k, v] of this.attributes) copy.setAttribute(k, v);
        copy.id = this.id;
        if (deep) {
            for (const c of this.children) copy.appendChild(c.cloneNode(true));
        }
        return copy;
    }
    // Match a single class-selector ".foo" against descendants (DFS).
    querySelector(selector) {
        const match = /^\.([\w-]+)$/.exec(String(selector || ''));
        if (!match) return null;
        const cls = match[1];
        return this._findFirstByClass(cls);
    }
    querySelectorAll(selector) {
        const match = /^\.([\w-]+)$/.exec(String(selector || ''));
        if (!match) return [];
        const cls = match[1];
        const out = [];
        this._collectByClass(cls, out);
        return out;
    }
    _findFirstByClass(cls) {
        for (const child of this.children) {
            if (child.classList.contains(cls)) return child;
            const nested = child._findFirstByClass(cls);
            if (nested) return nested;
        }
        return null;
    }
    _collectByClass(cls, out) {
        for (const child of this.children) {
            if (child.classList.contains(cls)) out.push(child);
            child._collectByClass(cls, out);
        }
    }
    closest(selector) {
        const match = /^\.([\w-]+)$/.exec(String(selector || ''));
        if (!match) return null;
        const cls = match[1];
        let node = this;
        while (node) {
            if (node.classList && node.classList.contains(cls)) return node;
            node = node.parent;
        }
        return null;
    }
    // `innerHTML` setter: parse the overlay HTML produced by
    // `openExpandedDiff` well enough that subsequent `.querySelector`
    // calls for the four overlay class names work. The function emits a
    // fixed template so we don't need a real HTML parser — we just look
    // for the class names we care about and synthesize nested stubs.
    set innerHTML(html) {
        this._innerHTML = String(html ?? '');
        // Reset children before re-parsing.
        for (const c of [...this.children]) this.removeChild(c);

        const knownClasses = [
            'luker_lib_diff_zoom_backdrop',
            'luker_lib_diff_zoom_dialog',
            'luker_lib_diff_zoom_header',
            'luker_lib_diff_zoom_title',
            'luker_lib_diff_zoom_close',
            'luker_lib_diff_zoom_body',
        ];
        // We synthesize the nesting that `openExpandedDiff` emits:
        //   overlay → backdrop, dialog
        //     dialog → header, body
        //       header → title, close
        const backdrop = this._maybeMake(html, 'luker_lib_diff_zoom_backdrop', knownClasses);
        const dialog = this._maybeMake(html, 'luker_lib_diff_zoom_dialog', knownClasses);
        if (backdrop) this.appendChild(backdrop);
        if (dialog) {
            this.appendChild(dialog);
            const header = this._maybeMake(html, 'luker_lib_diff_zoom_header', knownClasses);
            const body = this._maybeMake(html, 'luker_lib_diff_zoom_body', knownClasses);
            if (header) {
                dialog.appendChild(header);
                const title = this._maybeMake(html, 'luker_lib_diff_zoom_title', knownClasses);
                const closeBtn = this._maybeMake(html, 'luker_lib_diff_zoom_close', knownClasses);
                if (title) header.appendChild(title);
                if (closeBtn) header.appendChild(closeBtn);
            }
            if (body) dialog.appendChild(body);
        }
    }
    get innerHTML() { return this._innerHTML; }
    _maybeMake(html, cls) {
        const re = new RegExp(`class="[^"]*\\b${cls}\\b[^"]*"`);
        if (!re.test(String(html))) return null;
        return new StubElement('div', cls);
    }
}

// Expose Element / HTMLElement globally so the production code's
// `instanceof` checks accept our stubs. Use the same class for both —
// the `openExpandedDiff` flow doesn't distinguish them beyond the gate.
function installGlobals() {
    const previous = {
        document: globalThis.document,
        window: globalThis.window,
        Element: globalThis.Element,
        HTMLElement: globalThis.HTMLElement,
    };
    globalThis.Element = StubElement;
    globalThis.HTMLElement = StubElement;
    // Minimal `document` — just a body StubElement plus `createElement` /
    // `querySelector` / `querySelectorAll` that descend through it.
    const body = new StubElement('body');
    globalThis.document = {
        body,
        createElement(tag) { return new StubElement(tag); },
        querySelector(sel) { return body.querySelector(sel); },
        querySelectorAll(sel) { return body.querySelectorAll(sel); },
    };
    // jQuery may be probed by `attachZoomOverlay` but is not used here.
    return previous;
}

function restoreGlobals(previous) {
    for (const key of ['document', 'window', 'Element', 'HTMLElement']) {
        if (previous[key] === undefined) delete globalThis[key];
        else globalThis[key] = previous[key];
    }
}

function setWindowSize(width, height = 900) {
    globalThis.window = globalThis.window ?? {};
    globalThis.window.innerWidth = width;
    globalThis.window.innerHeight = height;
}

// Build the host DOM `openExpandedDiff` expects to find on the page:
//   host
//     .luker_lib_diff
//       button.trigger[data-luker-lib-action=expand-line-diff]
//       .luker_lib_diff_pre
//         .luker_lib_diff_dual
//           .luker_lib_diff_side > .luker_lib_diff_side_scroll
//           .luker_lib_diff_splitter
//           .luker_lib_diff_side > .luker_lib_diff_side_scroll
function buildHostWithDiff() {
    const host = new StubElement('div', 'host');
    host.id = 'test-host';
    const diff = new StubElement('div', 'luker_lib_diff');
    const trigger = new StubElement('button', 'trigger');
    trigger.setAttribute('data-luker-lib-action', 'expand-line-diff');
    const pre = new StubElement('div', 'luker_lib_diff_pre');
    const dual = new StubElement('div', 'luker_lib_diff_dual');
    const sideL = new StubElement('div', 'luker_lib_diff_side');
    sideL.appendChild(new StubElement('div', 'luker_lib_diff_side_scroll'));
    const sideR = new StubElement('div', 'luker_lib_diff_side');
    sideR.appendChild(new StubElement('div', 'luker_lib_diff_side_scroll'));
    const splitter = new StubElement('div', 'luker_lib_diff_splitter');
    dual.appendChild(sideL);
    dual.appendChild(splitter);
    dual.appendChild(sideR);
    pre.appendChild(dual);
    diff.appendChild(trigger);
    diff.appendChild(pre);
    host.appendChild(diff);
    document.body.appendChild(host);
    return { host, trigger };
}

describe('iteration-library zoom-overlay — openExpandedDiff narrow-class breakpoint', () => {
    let openExpandedDiff;
    let previousGlobals;

    beforeEach(async () => {
        previousGlobals = installGlobals();
        // Re-import per test so a hot-loaded module never caches across
        // distinct `window` shapes.
        ({ openExpandedDiff } = await import('../../public/scripts/iteration-library/zoom-overlay.js'));
    });

    afterEach(() => {
        restoreGlobals(previousGlobals);
    });

    test('opens dialog at desktop width without the narrow class', () => {
        setWindowSize(1400);
        const { host, trigger } = buildHostWithDiff();
        openExpandedDiff(host, trigger);
        const dialog = document.querySelector('.luker_lib_diff_zoom_dialog');
        expect(dialog).not.toBeNull();
        expect(dialog.classList.contains('luker_lib_diff_zoom_narrow')).toBe(false);
    });

    test('adds luker_lib_diff_zoom_narrow class when innerWidth < 720', () => {
        setWindowSize(480);
        const { host, trigger } = buildHostWithDiff();
        openExpandedDiff(host, trigger);
        const dialog = document.querySelector('.luker_lib_diff_zoom_dialog');
        expect(dialog).not.toBeNull();
        expect(dialog.classList.contains('luker_lib_diff_zoom_narrow')).toBe(true);
    });

    test('keeps the dialog non-narrow at exactly the 720px breakpoint', () => {
        setWindowSize(720);
        const { host, trigger } = buildHostWithDiff();
        openExpandedDiff(host, trigger);
        const dialog = document.querySelector('.luker_lib_diff_zoom_dialog');
        expect(dialog).not.toBeNull();
        expect(dialog.classList.contains('luker_lib_diff_zoom_narrow')).toBe(false);
    });
});
