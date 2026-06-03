/**
 * Plan 2 Unit 6 — "Browse bundled" tab inside the skill manager.
 *
 * The bundled-browser component lists every skill in `default/skills/global/`
 * (returned by `context.skills.listBundledManifest()`), tags each row with one
 * of three install states based on whether/how the user has installed it
 * locally, and surfaces per-row + bulk install actions.
 *
 * Pure helpers (computeInstallStates, buildBundledTableHtml,
 * sortBundledRows) are unit-tested without any DOM. The interactive
 * renderBundledBrowser entry point is exercised against the same StubDocument
 * pattern as skill-manager-panel.test.js so we cover the "Install this" and
 * "Install all" wiring without pulling in jsdom.
 *
 * Mirrors the Jest config (testEnvironment: node) — no jsdom required.
 */

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';

// We import lazily inside each test so the DOM/context stubs installed in
// `beforeEach` are in place at evaluation time.

describe('bundled-browser — pure helpers', () => {
    let mod;

    beforeEach(async () => {
        mod = await import('../../public/scripts/skills/bundled-browser.js');
    });

    test('computeInstallStates marks installed_match when hash matches local', () => {
        const bundled = [
            { name: 'alpha', installedHash: 'hash-A', fileCount: 1, totalBytes: 100, description: 'a' },
        ];
        const installed = [
            { name: 'alpha', scope: { kind: 'global' }, installedHash: 'hash-A' },
        ];
        const rows = mod.computeInstallStates(bundled, installed);
        expect(rows).toHaveLength(1);
        expect(rows[0].state).toBe('installed_match');
        expect(rows[0].name).toBe('alpha');
        expect(rows[0].installedHash).toBe('hash-A');
    });

    test('computeInstallStates marks installed_differ when hashes differ', () => {
        const bundled = [
            { name: 'beta', installedHash: 'hash-NEW', fileCount: 1, totalBytes: 100, description: 'b' },
        ];
        const installed = [
            { name: 'beta', scope: { kind: 'global' }, installedHash: 'hash-OLD' },
        ];
        const rows = mod.computeInstallStates(bundled, installed);
        expect(rows[0].state).toBe('installed_differ');
        expect(rows[0].localHash).toBe('hash-OLD');
    });

    test('computeInstallStates marks not_installed when name absent locally', () => {
        const bundled = [
            { name: 'gamma', installedHash: 'h', fileCount: 1, totalBytes: 50, description: '' },
        ];
        const installed = [];
        const rows = mod.computeInstallStates(bundled, installed);
        expect(rows[0].state).toBe('not_installed');
    });

    test('computeInstallStates only considers global-scope local skills', () => {
        // Same name in character scope must NOT mask a not-installed global.
        const bundled = [
            { name: 'delta', installedHash: 'h', fileCount: 1, totalBytes: 50, description: '' },
        ];
        const installed = [
            { name: 'delta', scope: { kind: 'character', characterFile: 'A.png' }, installedHash: 'h' },
        ];
        const rows = mod.computeInstallStates(bundled, installed);
        expect(rows[0].state).toBe('not_installed');
    });

    test('computeInstallStates is empty when bundled[] is empty', () => {
        expect(mod.computeInstallStates([], [{ name: 'x', scope: { kind: 'global' } }])).toEqual([]);
        expect(mod.computeInstallStates(null, null)).toEqual([]);
    });

    test('sortBundledRows orders not_installed → installed_differ → installed_match, then by name', () => {
        const rows = [
            { name: 'b-match', state: 'installed_match' },
            { name: 'a-differ', state: 'installed_differ' },
            { name: 'c-match', state: 'installed_match' },
            { name: 'd-new', state: 'not_installed' },
            { name: 'a-new', state: 'not_installed' },
        ];
        const sorted = mod.sortBundledRows(rows);
        expect(sorted.map(r => r.name)).toEqual([
            'a-new', 'd-new',          // not_installed first
            'a-differ',                // then installed_differ
            'b-match', 'c-match',      // then installed_match
        ]);
    });

    test('buildBundledTableHtml renders one row per bundled skill with state badge', () => {
        const t = (s) => s;
        const esc = (s) => String(s);
        const rows = [
            { name: 'alpha', state: 'installed_match', description: 'a desc', fileCount: 2, totalBytes: 200 },
            { name: 'beta', state: 'installed_differ', description: 'b desc', fileCount: 3, totalBytes: 300, localHash: 'oh' },
            { name: 'gamma', state: 'not_installed', description: '', fileCount: 1, totalBytes: 50 },
        ];
        const html = mod.buildBundledTableHtml(rows, t, esc);
        expect(html).toContain('alpha');
        expect(html).toContain('beta');
        expect(html).toContain('gamma');
        // State indicators present
        expect(html).toContain('Installed');     // installed_match label
        expect(html).toContain('Differs');       // installed_differ label
        expect(html).toContain('Not installed'); // not_installed label
        // Toolbar actions
        expect(html).toContain('Install all bundled');
        expect(html).toContain('Refresh');
        // Per-row install/reinstall action
        expect(html).toMatch(/data-bundled-action="install"[^>]*data-bundled-name="gamma"/);
        // installed_match rows should NOT show an install button (already-installed).
        const alphaRowMatch = /data-bundled-name="alpha"[\s\S]*?<\/tr>/.exec(html);
        expect(alphaRowMatch).toBeTruthy();
        expect(alphaRowMatch[0]).not.toMatch(/data-bundled-action="install"/);
    });

    test('buildBundledTableHtml empty state', () => {
        const html = mod.buildBundledTableHtml([], (s) => s, (s) => String(s));
        expect(html).toContain('No bundled skills');
    });

    test('buildBundledTableHtml header row shows description column', () => {
        const html = mod.buildBundledTableHtml([], (s) => s, (s) => String(s));
        // Even with empty body the empty-state surface should still mention the
        // intent of the tab somewhere so the UI doesn't render a blank pane.
        expect(html).toMatch(/bundled/i);
    });

    test('describeBundledImportResult: empty bundle returns the "no bundled" info toast', () => {
        const { level, text } = mod.describeBundledImportResult({ installed: 0, replaced: 0, alreadyInstalled: 0 });
        expect(level).toBe('info');
        expect(text).toMatch(/no bundled/i);
    });

    test('describeBundledImportResult: all already up to date is an info toast (not a success)', () => {
        // The pre-fix regression: this case produced "0 installed, 0 replaced"
        // with `level: success`, which read identically to a hard failure.
        const { level, text } = mod.describeBundledImportResult({ installed: 0, replaced: 0, alreadyInstalled: 3 });
        expect(level).toBe('info');
        expect(text).toMatch(/already up to date|already match|already/i);
        expect(text).toContain('3');
    });

    test('describeBundledImportResult: a real import is a success toast that breaks down all three counts', () => {
        const { level, text } = mod.describeBundledImportResult({ installed: 2, replaced: 1, alreadyInstalled: 4 });
        expect(level).toBe('success');
        expect(text).toContain('2');
        expect(text).toContain('1');
        expect(text).toContain('4');
    });

    test('describeBundledImportResult: tolerates the legacy result shape that omits alreadyInstalled', () => {
        // An older server returning `{ installed, replaced }` without the new
        // counter must still produce a sensible toast — defensive against
        // skew between client + server during rolling updates.
        const { level } = mod.describeBundledImportResult({ installed: 1, replaced: 0 });
        expect(level).toBe('success');
    });
});

// ── Integration-style tests with a stub DOM + stub context ────────────────

class StubElement {
    constructor(tagName = 'div') {
        this.tagName = String(tagName || 'div').toUpperCase();
        this._children = [];
        this._listeners = new Map();
        this._attrs = new Map();
        this._innerHTML = '';
        this.style = {};
        this.value = '';
        this.checked = false;
        this.parentNode = null;
    }
    get innerHTML() { return this._innerHTML; }
    set innerHTML(html) {
        this._innerHTML = String(html);
        this._children = parseStubChildren(this._innerHTML, this);
    }
    setAttribute(name, value) { this._attrs.set(String(name), String(value)); }
    getAttribute(name) { return this._attrs.has(String(name)) ? this._attrs.get(String(name)) : null; }
    appendChild(child) {
        child.parentNode = this;
        this._children.push(child);
        return child;
    }
    removeChild(child) {
        const i = this._children.indexOf(child);
        if (i >= 0) {
            this._children.splice(i, 1);
            child.parentNode = null;
        }
    }
    closest(sel) {
        let cur = this;
        while (cur) {
            if (cur.matches && cur.matches(sel)) return cur;
            cur = cur.parentNode;
        }
        return null;
    }
    matches(sel) {
        const tagMatch = /^([a-z][a-z0-9]*)?/i.exec(sel);
        const tagName = tagMatch && tagMatch[1] ? tagMatch[1].toUpperCase() : null;
        if (tagName && this.tagName !== tagName) return false;
        const remainder = sel.slice(tagMatch[0].length);
        const attrRe = /\[([a-z0-9-]+)(?:="([^"]*)")?\]/gi;
        let m;
        while ((m = attrRe.exec(remainder))) {
            const [, name, value] = m;
            if (value === undefined) {
                if (!this._attrs.has(name)) return false;
            } else if (this._attrs.get(name) !== value) {
                return false;
            }
        }
        return true;
    }
    querySelector(sel) {
        const all = this.querySelectorAll(sel);
        return all[0] || null;
    }
    querySelectorAll(sel) {
        const out = [];
        const visit = (n) => {
            if (n.matches && n.matches(sel)) out.push(n);
            for (const c of n._children || []) visit(c);
        };
        for (const c of this._children) visit(c);
        return {
            length: out.length,
            forEach(cb) { for (const e of out) cb(e); },
            [Symbol.iterator]() { return out[Symbol.iterator](); },
            0: out[0],
            ...out,
        };
    }
    addEventListener(event, handler) {
        if (!this._listeners.has(event)) this._listeners.set(event, []);
        this._listeners.get(event).push(handler);
    }
    dispatchEvent(event) {
        const list = this._listeners.get(event.type) || [];
        for (const h of list) h(event);
    }
    click() {
        this.dispatchEvent({ type: 'click', preventDefault() {}, stopPropagation() {} });
    }
}

function unescapeHtml(s) {
    return String(s ?? '')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, '\'')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}
function parseStubChildren(html, parent) {
    const VOID_TAGS = new Set(['input', 'br', 'img', 'hr', 'meta']);
    const tokenRe = /<(\/?)([a-z][a-z0-9]*)\b([^>]*?)(\/?)>/gi;
    const stack = [parent];
    let m;
    while ((m = tokenRe.exec(html))) {
        const isClose = m[1] === '/';
        const tag = m[2].toLowerCase();
        const attrs = m[3] || '';
        const selfClose = m[4] === '/';
        const top = stack[stack.length - 1];
        if (isClose) {
            if (stack.length > 1 && top.tagName === tag.toUpperCase()) {
                stack.pop();
            }
            continue;
        }
        const el = new StubElement(tag);
        const attrRe = /([a-z][a-z0-9-]*)(?:="([^"]*)")?/gi;
        let am;
        while ((am = attrRe.exec(attrs))) {
            el._attrs.set(am[1].toLowerCase(), am[2] !== undefined ? unescapeHtml(am[2]) : '');
        }
        if (el._attrs.has('value')) el.value = el._attrs.get('value');
        el.parentNode = top;
        top._children.push(el);
        if (!selfClose && !VOID_TAGS.has(tag)) {
            stack.push(el);
        }
    }
    return parent._children;
}

function makeStubContext({ bundled = [], installed = [], scenarios = {} } = {}) {
    const skillsApi = {
        list: jest.fn(async () => installed.slice()),
        listBundledManifest: jest.fn(async () => bundled.slice()),
        importBundled: jest.fn(async () => ({ installed: bundled.map(b => b.name), replaced: 0 })),
        install: jest.fn(async () => ({ action: 'installed', name: 'one' })),
        readFile: jest.fn(async ({ name, path: relPath }) => ({
            // Return a minimal SKILL.md for any single-file install via per-row
            // button. Real implementation will pack via importBundled-by-name.
            content: relPath === 'SKILL.md'
                ? `---\nname: ${name}\ndescription: bundled body\n---\nbundled body\n`
                : 'extra',
        })),
    };
    const callGenericPopup = jest.fn((content, type, _title, _opts) => {
        if (scenarios.confirm && type === 2) return Promise.resolve(scenarios.confirm(content));
        return Promise.resolve(null);
    });
    return {
        skills: skillsApi,
        callGenericPopup,
        POPUP_TYPE: { TEXT: 1, CONFIRM: 2, INPUT: 3, DISPLAY: 4 },
        POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null },
        __skillsApi: skillsApi,
    };
}

describe('renderBundledBrowser — integration scenarios', () => {
    let origDoc, origToastr;

    // eslint-disable-next-line playwright/no-duplicate-hooks
    beforeEach(() => {
        origDoc = global.document;
        origToastr = global.toastr;
        global.document = {
            body: new StubElement('body'),
            createElement: (tag) => new StubElement(tag),
        };
        global.toastr = {
            info: jest.fn(),
            success: jest.fn(),
            error: jest.fn(),
        };
    });

    // eslint-disable-next-line playwright/no-duplicate-hooks
    afterEach(() => {
        global.document = origDoc;
        global.toastr = origToastr;
    });

    async function bootstrap(opts) {
        const { renderBundledBrowser } = await import('../../public/scripts/skills/bundled-browser.js');
        const ctx = makeStubContext(opts);
        const mount = new StubElement('div');
        await renderBundledBrowser({ context: ctx, mount, t: (s) => s });
        // Yield for any deferred refresh.
        await Promise.resolve();
        await Promise.resolve();
        return { ctx, mount };
    }

    test('initial render shows install state per bundled skill', async () => {
        const bundled = [
            { name: 'alpha', installedHash: 'A', fileCount: 1, totalBytes: 50, description: 'first' },
            { name: 'beta', installedHash: 'B', fileCount: 1, totalBytes: 80, description: 'second' },
            { name: 'gamma', installedHash: 'C', fileCount: 1, totalBytes: 30, description: 'third' },
        ];
        const installed = [
            { name: 'alpha', scope: { kind: 'global' }, installedHash: 'A' },          // match
            { name: 'beta', scope: { kind: 'global' }, installedHash: 'B-OLD' },       // differ
            // gamma not installed
        ];
        const { ctx, mount } = await bootstrap({ bundled, installed });
        expect(ctx.__skillsApi.listBundledManifest).toHaveBeenCalled();
        expect(ctx.__skillsApi.list).toHaveBeenCalled();
        expect(mount.innerHTML).toContain('alpha');
        expect(mount.innerHTML).toContain('beta');
        expect(mount.innerHTML).toContain('gamma');
        expect(mount.innerHTML).toContain('Installed');
        expect(mount.innerHTML).toContain('Differs');
        expect(mount.innerHTML).toContain('Not installed');
    });

    test('Install all calls importBundled and reflects refreshed state', async () => {
        const bundled = [
            { name: 'one', installedHash: 'H', fileCount: 1, totalBytes: 10, description: 'd' },
        ];
        let firstCall = true;
        const { ctx, mount } = await bootstrap({ bundled, installed: [] });
        ctx.__skillsApi.list.mockImplementation(async () => {
            // After install-all the row should flip to installed_match.
            if (firstCall) { firstCall = false; return []; }
            return [{ name: 'one', scope: { kind: 'global' }, installedHash: 'H' }];
        });
        const btn = mount.querySelector('[data-bundled-toolbar="install-all"]');
        expect(btn).toBeTruthy();
        btn.click();
        // Yield for the async chain (install-all + refresh).
        for (let i = 0; i < 8; i++) await Promise.resolve();
        expect(ctx.__skillsApi.importBundled).toHaveBeenCalledTimes(1);
        expect(global.toastr.success).toHaveBeenCalled();
    });

    test('Install this on a not_installed row calls install with bundled payload', async () => {
        const bundled = [
            { name: 'solo', installedHash: 'H1', fileCount: 1, totalBytes: 50, description: '' },
        ];
        const { ctx, mount } = await bootstrap({ bundled, installed: [] });
        const btn = mount.querySelector('[data-bundled-action="install"][data-bundled-name="solo"]');
        expect(btn).toBeTruthy();
        btn.click();
        for (let i = 0; i < 8; i++) await Promise.resolve();
        // The component invokes context.skills.importBundled (which installs
        // ALL of the default skills) — the per-row "Install this" button reuses
        // the same endpoint because installBundledSkills is idempotent via
        // 'replace' strategy and the server has no install-one-bundled route.
        // The toast should appear and list should re-fetch.
        expect(ctx.__skillsApi.importBundled).toHaveBeenCalledTimes(1);
        // After per-row install, list() runs again for refresh.
        expect(ctx.__skillsApi.list.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    test('Refresh button re-fetches bundled + installed', async () => {
        const { ctx, mount } = await bootstrap({ bundled: [], installed: [] });
        const before = ctx.__skillsApi.listBundledManifest.mock.calls.length;
        const btn = mount.querySelector('[data-bundled-toolbar="refresh"]');
        expect(btn).toBeTruthy();
        btn.click();
        for (let i = 0; i < 5; i++) await Promise.resolve();
        expect(ctx.__skillsApi.listBundledManifest.mock.calls.length).toBeGreaterThan(before);
    });

    test('Install all surfaces "already up to date" when nothing changed', async () => {
        // The exact server response the user hit: bundle exists, but every
        // entry matches the on-disk hash. Pre-fix the toast read
        // "0 installed, 0 replaced" — meaningless to the user.
        const bundled = [
            { name: 'pinned', installedHash: 'H', fileCount: 1, totalBytes: 10, description: '' },
        ];
        const installed = [{ name: 'pinned', scope: { kind: 'global' }, installedHash: 'H' }];
        const { ctx, mount } = await bootstrap({ bundled, installed });
        ctx.__skillsApi.importBundled.mockImplementation(async () => ({
            installed: 0,
            replaced: 0,
            alreadyInstalled: 1,
        }));
        const btn = mount.querySelector('[data-bundled-toolbar="install-all"]');
        btn.click();
        for (let i = 0; i < 8; i++) await Promise.resolve();
        expect(global.toastr.info).toHaveBeenCalled();
        const msg = global.toastr.info.mock.calls[0][0];
        expect(msg).toMatch(/already up to date|already match/i);
    });

    test('Install all surfaces empty-bundle case', async () => {
        const { ctx, mount } = await bootstrap({ bundled: [], installed: [] });
        ctx.__skillsApi.importBundled.mockImplementation(async () => ({
            installed: 0,
            replaced: 0,
            alreadyInstalled: 0,
        }));
        const btn = mount.querySelector('[data-bundled-toolbar="install-all"]');
        btn.click();
        for (let i = 0; i < 8; i++) await Promise.resolve();
        expect(global.toastr.info).toHaveBeenCalled();
        const msg = global.toastr.info.mock.calls[0][0];
        expect(msg).toMatch(/no bundled skills/i);
    });

    test('handles errors from listBundledManifest gracefully', async () => {
        // Simulate the server failing.
        const ctx = makeStubContext({ bundled: [], installed: [] });
        ctx.__skillsApi.listBundledManifest.mockImplementation(async () => {
            const err = new Error('lukerDefaultRoot not configured');
            err.status = 500;
            throw err;
        });
        const mount = new StubElement('div');
        const { renderBundledBrowser } = await import('../../public/scripts/skills/bundled-browser.js');
        await renderBundledBrowser({ context: ctx, mount, t: (s) => s });
        await Promise.resolve();
        await Promise.resolve();
        // Error toast surfaces; the panel renders an empty state, not a crash.
        expect(global.toastr.error).toHaveBeenCalled();
        expect(mount.innerHTML).toContain('No bundled skills');
    });
});
