import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';

import { bindIterWorkspaceResizer } from '../../public/scripts/iteration-library/workspace-resizer.js';

// Minimal pointer-event-capable DOM stub. The repo's tests run in
// `testEnvironment: "node"` (jest.config.json) with no jsdom installed,
// so we hand-build just enough of EventTarget + Element to exercise the
// resizer's pointerdown→move→up flow. Same shape pattern as
// tests/iteration-library/text-diff.test.js's StubElement.
class StubEventTarget {
    constructor() {
        this._listeners = new Map();
    }
    addEventListener(type, handler) {
        if (!this._listeners.has(type)) this._listeners.set(type, new Set());
        this._listeners.get(type).add(handler);
    }
    removeEventListener(type, handler) {
        if (this._listeners.has(type)) this._listeners.get(type).delete(handler);
    }
    dispatchEvent(event) {
        const set = this._listeners.get(event.type);
        if (!set) return true;
        for (const handler of [...set]) {
            try { handler(event); } catch { /* ignore */ }
        }
        return !event.defaultPrevented;
    }
}

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

class StubElement extends StubEventTarget {
    constructor(className) {
        super();
        this.className = String(className || '');
        this.classList = new StubClassList();
        this.style = new StubStyle();
        this.dataset = {};
        this.children = [];
        this._rect = null;
    }
    setBoundingClientRect(rect) { this._rect = rect; }
    getBoundingClientRect() {
        return this._rect ?? { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    }
    querySelector(selector) {
        const match = /^\.([\w-]+)$/.exec(String(selector || ''));
        if (!match) return null;
        const cls = match[1];
        return this.children.find(c => c.className.includes(cls)) || null;
    }
    appendChild(child) { this.children.push(child); return child; }
    // Pointer-capture hooks are no-ops; the resizer wraps them in try/catch.
    setPointerCapture() {}
    releasePointerCapture() {}
}

class StubPointerEvent {
    constructor(type, init = {}) {
        this.type = String(type);
        this.pointerId = init.pointerId ?? 0;
        this.clientX = init.clientX ?? 0;
        this.clientY = init.clientY ?? 0;
        this.defaultPrevented = false;
        this._stopped = false;
    }
    preventDefault() { this.defaultPrevented = true; }
    stopPropagation() { this._stopped = true; }
}

function buildWorkspace() {
    const root = new StubElement('luker-iter-workspace');
    const grid = new StubElement('luker-iter-workspace-grid');
    grid.setBoundingClientRect({ left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600 });
    const splitter = new StubElement('luker-iter-workspace-resizer');
    root.appendChild(grid);
    root.appendChild(splitter);
    return { root, grid, splitter };
}

let previousWindow;
beforeEach(() => {
    previousWindow = globalThis.window;
    globalThis.window = new StubEventTarget();
});

afterEach(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
});

describe('bindIterWorkspaceResizer', () => {
    test('returns a no-op unbind when grid or splitter missing', () => {
        const bare = new StubElement('bare');
        const unbind = bindIterWorkspaceResizer(bare);
        expect(typeof unbind).toBe('function');
        expect(() => unbind()).not.toThrow();
    });

    test('pointerdown + pointermove updates --luker-iter-split clamped to [25, 80]', () => {
        const { root, grid, splitter } = buildWorkspace();
        const unbind = bindIterWorkspaceResizer(root);

        splitter.dispatchEvent(new StubPointerEvent('pointerdown', { pointerId: 1, clientX: 500 }));

        // 10% would be 100/1000 → clamped to 25%.
        window.dispatchEvent(new StubPointerEvent('pointermove', { pointerId: 1, clientX: 100 }));
        expect(grid.style.getPropertyValue('--luker-iter-split')).toBe('25%');

        // 90% → clamped to 80%.
        window.dispatchEvent(new StubPointerEvent('pointermove', { pointerId: 1, clientX: 900 }));
        expect(grid.style.getPropertyValue('--luker-iter-split')).toBe('80%');

        // 60% → unclamped.
        window.dispatchEvent(new StubPointerEvent('pointermove', { pointerId: 1, clientX: 600 }));
        expect(grid.style.getPropertyValue('--luker-iter-split')).toBe('60%');

        window.dispatchEvent(new StubPointerEvent('pointerup', { pointerId: 1, clientX: 600 }));
        unbind();
    });

    test('active class toggles during drag', () => {
        const { root, splitter } = buildWorkspace();
        const unbind = bindIterWorkspaceResizer(root);

        splitter.dispatchEvent(new StubPointerEvent('pointerdown', { pointerId: 2, clientX: 500 }));
        expect(splitter.classList.contains('active')).toBe(true);

        window.dispatchEvent(new StubPointerEvent('pointerup', { pointerId: 2, clientX: 500 }));
        expect(splitter.classList.contains('active')).toBe(false);

        unbind();
    });

    test('ignores pointermove for unrelated pointerId', () => {
        const { root, grid, splitter } = buildWorkspace();
        const unbind = bindIterWorkspaceResizer(root);

        splitter.dispatchEvent(new StubPointerEvent('pointerdown', { pointerId: 7, clientX: 500 }));
        // Wrong pointerId → no-op; split should still be unset.
        window.dispatchEvent(new StubPointerEvent('pointermove', { pointerId: 99, clientX: 300 }));
        expect(grid.style.getPropertyValue('--luker-iter-split')).toBe('');
        window.dispatchEvent(new StubPointerEvent('pointerup', { pointerId: 7, clientX: 500 }));
        unbind();
    });

    test('unbind removes the pointerdown handler', () => {
        const { root, grid, splitter } = buildWorkspace();
        const unbind = bindIterWorkspaceResizer(root);
        unbind();
        // After unbind, pointerdown is no longer wired.
        splitter.dispatchEvent(new StubPointerEvent('pointerdown', { pointerId: 3, clientX: 500 }));
        expect(splitter.classList.contains('active')).toBe(false);
        // No pointermove should reach the resizer either.
        window.dispatchEvent(new StubPointerEvent('pointermove', { pointerId: 3, clientX: 300 }));
        expect(grid.style.getPropertyValue('--luker-iter-split')).toBe('');
    });
});
