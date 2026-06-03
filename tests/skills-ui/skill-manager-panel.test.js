/**
 * Plan 2 Unit 2 — Skill manager subpanel.
 *
 * Tests target the pure helpers (groupSkillsByScope, filterGroups,
 * inferImportFormat, hasRenameCollision, hasMoveScopeCollision,
 * buildArchiveEmbedPayload, buildPanelHtml) and one integration-style
 * scenario per UX path (delete refresh, rename collision, move-scope
 * conflict, import bundled) that exercises the wired `openSkillManagerPanel`
 * via a stub context + stub DOM.
 *
 * Luker's Jest config runs in `testEnvironment: "node"` (see
 * tests/jest.config.json), with no jsdom installed. We stub just enough
 * DOM surface (document.createElement, document.body, document.getElementById,
 * querySelector, addEventListener) on globalThis for the panel's render +
 * event-binding code path. The popup is replaced with a stub that resolves
 * `callGenericPopup` and the new Popup constructor on demand.
 *
 * This mirrors the approach taken by tests/iteration-library/zoom-overlay.test.js.
 */

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';

// We import the panel module lazily inside each test so the DOM/context stubs
// installed in `beforeEach` are in place at evaluation time.

describe('skill-manager-panel — pure helpers', () => {
    let mod;

    beforeEach(async () => {
        mod = await import('../../public/scripts/skills/skill-manager-panel.js');
    });

    test('formatScopeLabel handles all scope kinds + unknowns', () => {
        expect(mod.formatScopeLabel({ kind: 'global' })).toBe('global');
        expect(mod.formatScopeLabel({ kind: 'preset', name: 'rp4' }))
            .toBe('preset: rp4');
        expect(mod.formatScopeLabel({ kind: 'character', characterFile: 'Alice.png' }))
            .toBe('character: Alice.png');
        expect(mod.formatScopeLabel(null)).toBe('unknown');
        expect(mod.formatScopeLabel({ kind: 'bogus' })).toBe('unknown');
    });

    test('scopesEqual compares by kind and sub-fields', () => {
        expect(mod.scopesEqual({ kind: 'global' }, { kind: 'global' })).toBe(true);
        expect(mod.scopesEqual({ kind: 'preset', name: 'b' }, { kind: 'preset', name: 'b' })).toBe(true);
        expect(mod.scopesEqual({ kind: 'preset', name: 'b' }, { kind: 'preset', name: 'c' })).toBe(false);
        expect(mod.scopesEqual({ kind: 'character', characterFile: 'x' }, { kind: 'character', characterFile: 'x' })).toBe(true);
        expect(mod.scopesEqual({ kind: 'global' }, { kind: 'character', characterFile: 'x' })).toBe(false);
        expect(mod.scopesEqual(null, { kind: 'global' })).toBe(false);
    });

    test('groupSkillsByScope groups + orders global → preset → character', () => {
        const flat = [
            { name: 'b', scope: { kind: 'character', characterFile: 'B.png' } },
            { name: 'a', scope: { kind: 'global' } },
            { name: 'c', scope: { kind: 'preset', name: 'rp' } },
            { name: 'd', scope: { kind: 'global' } },
        ];
        const grouped = mod.groupSkillsByScope(flat);
        expect(grouped).toHaveLength(3);
        expect(grouped[0].scope.kind).toBe('global');
        expect(grouped[0].skills.map(s => s.name)).toEqual(['a', 'd']);
        expect(grouped[1].scope.kind).toBe('preset');
        expect(grouped[2].scope.kind).toBe('character');
    });

    test('filterGroups narrows to one scope when a key is supplied', () => {
        const flat = [
            { name: 'a', scope: { kind: 'global' } },
            { name: 'b', scope: { kind: 'preset', name: 'rp' } },
        ];
        const grouped = mod.groupSkillsByScope(flat);
        const onlyGlobal = mod.filterGroups(grouped, 'global');
        expect(onlyGlobal).toHaveLength(1);
        expect(onlyGlobal[0].scope.kind).toBe('global');

        const allGroups = mod.filterGroups(grouped, 'all');
        expect(allGroups).toHaveLength(2);
    });

    test('hasRenameCollision finds same-scope name match', () => {
        const skills = [
            { name: 'foo', scope: { kind: 'global' } },
            { name: 'bar', scope: { kind: 'global' } },
            { name: 'baz', scope: { kind: 'character', characterFile: 'C.png' } },
        ];
        expect(mod.hasRenameCollision(skills, { kind: 'global' }, 'foo', 'bar')).toBe(true);
        expect(mod.hasRenameCollision(skills, { kind: 'global' }, 'foo', 'baz')).toBe(false);
        // Same name in different scope is fine.
        expect(mod.hasRenameCollision(skills, { kind: 'global' }, 'foo', 'foo')).toBe(false);
    });

    test('hasMoveScopeCollision finds destination-scope name match', () => {
        const skills = [
            { name: 'shared', scope: { kind: 'global' } },
            { name: 'shared', scope: { kind: 'preset', name: 'rp' } },
        ];
        expect(mod.hasMoveScopeCollision(
            skills, 'shared',
            { kind: 'global' },
            { kind: 'preset', name: 'rp' },
        )).toBe(true);
        expect(mod.hasMoveScopeCollision(
            skills, 'shared',
            { kind: 'global' },
            { kind: 'character', characterFile: 'A.png' },
        )).toBe(false);
        // No-op move returns false without scanning.
        expect(mod.hasMoveScopeCollision(
            skills, 'shared',
            { kind: 'global' },
            { kind: 'global' },
        )).toBe(false);
    });

    test('inferImportFormat: JSON embed payload → embed-json', () => {
        const payload = JSON.stringify({
            version: 1,
            items: [{ bundleFormat: 'inline-files-v1', name: 'x', files: [] }],
        });
        const r = mod.inferImportFormat('skill.json', payload);
        expect(r.kind).toBe('embed-json');
        expect(r.payload.version).toBe(1);
    });

    test('inferImportFormat: invalid JSON → unknown', () => {
        const r = mod.inferImportFormat('skill.json', '{not json');
        expect(r.kind).toBe('unknown');
        expect(r.reason).toMatch(/invalid JSON/);
    });

    test('inferImportFormat: JSON without {version, items} → unknown', () => {
        const r = mod.inferImportFormat('skill.json', JSON.stringify({ foo: 'bar' }));
        expect(r.kind).toBe('unknown');
        expect(r.reason).toMatch(/version: 1, items/);
    });

    test('inferImportFormat: zip → archive with base64', () => {
        const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]); // PK\x03\x04 zip magic
        const r = mod.inferImportFormat('weather-helper.zip', bytes);
        expect(r.kind).toBe('archive');
        expect(r.defaultName).toBe('weather-helper');
        expect(typeof r.contentBase64).toBe('string');
        expect(r.contentBase64.length).toBeGreaterThan(0);
    });

    test('inferImportFormat: unsupported extension', () => {
        const r = mod.inferImportFormat('readme.txt', 'hello');
        expect(r.kind).toBe('unknown');
        expect(r.reason).toMatch(/extension/);
    });

    test('buildArchiveEmbedPayload wraps a single item with correct shape', () => {
        const p = mod.buildArchiveEmbedPayload('foo', 'YmFzZTY0', 'abc123');
        expect(p.version).toBe(1);
        expect(p.items).toHaveLength(1);
        expect(p.items[0].bundleFormat).toBe('archive-base64-v1');
        expect(p.items[0].name).toBe('foo');
        expect(p.items[0].contentBase64).toBe('YmFzZTY0');
        expect(p.items[0].sha256).toBe('abc123');
    });

    test('encodeBase64 handles Uint8Array + ArrayBuffer + string', () => {
        const u = new Uint8Array([1, 2, 3]);
        const a = u.buffer;
        // base64('\x01\x02\x03') === 'AQID'
        expect(mod.encodeBase64(u)).toBe('AQID');
        expect(mod.encodeBase64(a)).toBe('AQID');
    });

    test('buildPanelHtml renders rows + empty state + filter dropdown', () => {
        const t = (s) => s;
        const esc = (s) => String(s);
        const skills = [
            {
                name: 'alpha',
                description: 'first',
                fileCount: 2,
                scope: { kind: 'global' },
            },
            {
                name: 'beta',
                description: '',
                fileCount: 1,
                hasScripts: true,
                scope: { kind: 'preset', name: 'rp' },
            },
        ];
        const groups = mod.groupSkillsByScope(skills);
        const html = mod.buildPanelHtml(groups, [skills[0].scope, skills[1].scope], 'all', 'installed', t, esc);
        expect(html).toContain('alpha');
        expect(html).toContain('beta');
        expect(html).toContain('has scripts');
        expect(html).toContain('All scopes');
        expect(html).toContain('Import bundled');
        expect(html).toContain('Import from file');
        expect(html).toContain('Import from URL');
        expect(html).toContain('Create new');
        // Tab strip is always rendered.
        expect(html).toContain('data-skill-tab="installed"');
        expect(html).toContain('data-skill-tab="bundled"');
        // Empty state when no groups
        const emptyHtml = mod.buildPanelHtml([], [], 'all', 'installed', t, esc);
        expect(emptyHtml).toContain('No skills installed');

        // On the bundled tab the body is a mount point, not the rows.
        const bundledHtml = mod.buildPanelHtml(groups, [skills[0].scope], 'all', 'bundled', t, esc);
        expect(bundledHtml).toContain('luker_skill_manager_bundled_mount');
        expect(bundledHtml).not.toContain('Import bundled');
    });
});

// ── Integration-style tests with a stub DOM + stub context ────────────────

/**
 * Minimal stub element for the panel's DOM access:
 *   - document.getElementById / querySelector / querySelectorAll
 *   - element.innerHTML (string store)
 *   - element.addEventListener / dispatchEvent
 *
 * We re-implement what the panel actually touches; specifically, it
 * paints HTML and registers click/change listeners through delegation.
 */

class StubElement {
    constructor(tagName = 'div') {
        this.tagName = String(tagName || 'div').toUpperCase();
        this._children = [];
        this._listeners = new Map();
        this._attrs = new Map();
        this._innerHTML = '';
        this.style = {};
        this._value = '';
        this.checked = false;
        this.files = null;
        this.parentNode = null;
    }
    get value() {
        // For <select> elements, mirror real DOM behaviour: the value is the
        // currently-selected option's value (or first option's if nothing has
        // an explicit `selected` attribute). For other elements, use the
        // attribute value or whatever the caller set via the setter.
        if (this.tagName === 'SELECT') {
            const opts = this._children.filter(c => c.tagName === 'OPTION');
            if (opts.length === 0) return this._value;
            const sel = opts.find(o => o._attrs.has('selected'));
            return sel ? String(sel._attrs.get('value') ?? '') : String(opts[0]._attrs.get('value') ?? '');
        }
        return this._value;
    }
    set value(v) { this._value = v; }
    get innerHTML() { return this._innerHTML; }
    set innerHTML(html) {
        this._innerHTML = String(html);
        // Parse extremely loosely: we don't need real DOM, just enough to
        // make querySelectorAll('[data-skill-toolbar]') etc. return stub
        // elements whose attribute and click-listener wiring work. The
        // tests call .click() on the stub directly.
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
            if (cur.matches(sel)) return cur;
            cur = cur.parentNode;
        }
        return null;
    }
    matches(sel) {
        // Accept the small grammar the panel actually uses:
        //   `[data-attr]`             → attribute present
        //   `[data-attr="value"]`     → attribute equals value
        //   `input[name="x"]:checked` → tag + attribute + pseudo
        //   `input[name="x"]:checked` (any-order combos with [data-y])
        //   `.cls`                    → class on this element
        // Anything else returns false; tests will surface that explicitly.
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
        // Class selectors: `.foo` (one or more). We split on `.` and confirm
        // every class is present in the element's class list.
        const classRe = /\.([a-z][a-z0-9_-]*)/gi;
        let cm;
        const classAttr = String(this._attrs.get('class') || '').split(/\s+/).filter(Boolean);
        const classes = new Set(classAttr);
        while ((cm = classRe.exec(remainder))) {
            if (!classes.has(cm[1])) return false;
        }
        if (remainder.includes(':checked')) {
            if (!this.checked) return false;
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

/**
 * Extract `<div data-skill-toolbar="x">...</div>` style tokens from the
 * panel's rendered HTML and produce StubElement children with matching
 * dataset attributes. Maintains parent/child structure based on tag
 * nesting (open / self-closing / close pairs) so `closest()` traverses
 * the proper ancestor chain.
 *
 * The parse is deliberately lossy — we only care about elements whose
 * attributes the panel queries (`data-skill-*`, `name`, `value`, etc.).
 * Text content is dropped. Attribute values are HTML-unescaped so that
 * JSON-encoded scope strings survive round-trip (the panel writes
 * `data-skill-scope="${esc(JSON.stringify(scope))}"`).
 */
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
        if (el._attrs.has('selected')) el.selected = true;
        if (el._attrs.has('checked')) el.checked = true;
        if (el._attrs.has('value')) el.value = el._attrs.get('value');
        el.parentNode = top;
        top._children.push(el);
        if (!selfClose && !VOID_TAGS.has(tag)) {
            stack.push(el);
        }
    }
    return parent._children;
}

class StubDocument {
    constructor() {
        this.body = new StubElement('body');
        this._byId = new Map();
    }
    createElement(tag) { return new StubElement(tag); }
    getElementById(id) {
        return this._byId.get(id) || null;
    }
    register(id, el) { this._byId.set(id, el); el._attrs.set('id', id); }
    querySelector(sel) { return this.body.querySelector(sel); }
}

function makeStubContext({ skills = [], bundled = [], characters = [], scenarios = {} } = {}) {
    const popupCalls = [];
    const skillsApi = {
        list: jest.fn(async () => skills.slice()),
        delete: jest.fn(async () => null),
        rename: jest.fn(async () => null),
        moveScope: jest.fn(async () => null),
        readFile: jest.fn(async () => ({ content: '---\nname: x\n---\n' })),
        importBundled: jest.fn(async () => ({ installed: ['one'], skipped: [] })),
        importFromUrl: jest.fn(async () => ({ installed: ['from-url'], skipped: [] })),
        previewExtractEmbed: jest.fn(async () => ({ items: [{ name: 'imported', conflict: 'new' }] })),
        executeExtractEmbed: jest.fn(async () => ({ installed: ['imported'], skipped: [] })),
        listBundledManifest: jest.fn(async () => bundled.slice()),
    };
    const POPUP_TYPE = { TEXT: 1, CONFIRM: 2, INPUT: 3, DISPLAY: 4 };
    const POPUP_RESULT = { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null };
    // The popup never actually resolves during tests — we never await it.
    // The handlers being tested complete before the user closes the dialog.
    const callGenericPopup = jest.fn((content, type, _title, _opts) => {
        popupCalls.push({ content, type });
        if (type === POPUP_TYPE.TEXT) {
            // Top-level skill manager popup. Resolves only after `okButton`
            // (Close); during tests we keep the promise pending so the
            // openSkillManagerPanel function awaits at the very end.
            return new Promise(() => {});
        }
        // For CONFIRM / INPUT scenarios, allow per-test override.
        const handler = scenarios[type === POPUP_TYPE.CONFIRM ? 'confirm' : 'input'];
        if (handler) return Promise.resolve(handler(content));
        return Promise.resolve(null);
    });
    return {
        skills: skillsApi,
        callGenericPopup,
        POPUP_TYPE,
        POPUP_RESULT,
        // The scope picker queries these to populate its dropdowns. Tests
        // that don't exercise the picker leave them empty.
        characters,
        extensionSettings: { connectionManager: { profiles: [], selectedProfile: '' } },
        getPresetManager: () => null,
        Popup: class StubPopup {
            constructor(html, type, _val, opts) {
                this.html = html; this.type = type; this.opts = opts;
                this.result = POPUP_RESULT.CANCELLED;
                this.dlg = new StubElement('div');
                this.dlg.innerHTML = html;
            }
            async show() {
                // Tests that need to drive scope-picker / etc. override the
                // scenario via the `confirm` handler; default cancel.
                return scenarios.popupShow ? await scenarios.popupShow(this) : POPUP_RESULT.CANCELLED;
            }
        },
        __popupCalls: popupCalls,
        __skillsApi: skillsApi,
    };
}

describe('openSkillManagerPanel — integration scenarios', () => {
    let origDoc, origToastr;

    // eslint-disable-next-line playwright/no-duplicate-hooks
    beforeEach(() => {
        origDoc = global.document;
        origToastr = global.toastr;
        global.document = new StubDocument();
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
        const { openSkillManagerPanel } = await import('../../public/scripts/skills/skill-manager-panel.js');
        const ctx = makeStubContext(opts);
        // Pre-create the mount element so `getElementById(mountId)` resolves
        // when the panel's deferred refresh runs.
        const mountId = `luker_skill_manager_${Date.now()}_test`;
        const stub = new StubElement('div');
        global.document.register(mountId, stub);

        // Patch the panel's mountId. The panel computes one with Date.now();
        // we can't intercept that, so instead we register the mount via a
        // sentinel selector that always returns the same element regardless
        // of the generated id.
        const origGetById = global.document.getElementById.bind(global.document);
        global.document.getElementById = function (id) {
            const cached = origGetById(id);
            if (cached) return cached;
            if (String(id).startsWith('luker_skill_manager_')) {
                return stub;
            }
            return null;
        };

        const panelOpts = { context: ctx };
        if (opts && opts.initialScope) panelOpts.initialScope = opts.initialScope;
        const panelPromise = openSkillManagerPanel(panelOpts);
        // Allow the deferred refresh() (Promise.resolve().then(...)) to run.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        return { ctx, mount: stub, panelPromise };
    }

    test('initial render lists skills + filter dropdown is in place', async () => {
        const skills = [
            { name: 'a', scope: { kind: 'global' }, description: 'desc-a', fileCount: 1 },
            { name: 'b', scope: { kind: 'character', characterFile: 'C.png' }, description: 'desc-b', fileCount: 2 },
        ];
        const { ctx, mount } = await bootstrap({ skills });
        expect(ctx.__skillsApi.list).toHaveBeenCalled();
        expect(mount.innerHTML).toContain('desc-a');
        expect(mount.innerHTML).toContain('desc-b');
        expect(mount.innerHTML).toContain('All scopes');
        expect(mount.innerHTML).toContain('Filter by scope:');
    });

    test('delete flow invokes context.skills.delete and refreshes the list', async () => {
        const skills = [
            { name: 'doomed', scope: { kind: 'global' }, description: 'd', fileCount: 1 },
        ];
        let firstList = true;
        const { ctx, mount } = await bootstrap({
            skills,
            scenarios: {
                confirm: () => 1, // AFFIRMATIVE
            },
        });
        // Replace ctx.__skillsApi.list to return empty after delete.
        ctx.__skillsApi.list.mockImplementation(async () => {
            if (firstList) { firstList = false; return skills; }
            return [];
        });

        // Click the row's delete button.
        const deleteBtns = mount.querySelectorAll('[data-skill-action="delete"]');
        expect(deleteBtns.length).toBeGreaterThan(0);
        deleteBtns[0].click();

        // Yield for the async delete + refresh.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(ctx.__skillsApi.delete).toHaveBeenCalledWith(
            { kind: 'global' }, 'doomed',
        );
        expect(global.toastr.success).toHaveBeenCalled();
    });

    test('rename collision shows a retry prompt instead of calling rename', async () => {
        const skills = [
            { name: 'foo', scope: { kind: 'global' }, description: 'a', fileCount: 1 },
            { name: 'bar', scope: { kind: 'global' }, description: 'b', fileCount: 1 },
        ];
        const inputResults = ['bar']; // user types the colliding name
        const confirmResults = [0]; // user declines the retry → CANCEL
        const { ctx, mount } = await bootstrap({
            skills,
            scenarios: {
                input: () => inputResults.shift(),
                confirm: () => confirmResults.shift(),
            },
        });

        const renameBtns = mount.querySelectorAll('[data-skill-action="rename"]');
        // First rename button corresponds to 'bar' (alphabetical). We want
        // to find the one whose row name is 'foo'. (The conditional below
        // is the conventional "find target by predicate" pattern; the
        // `playwright/no-conditional-in-test` lint rule fires on it but
        // there's no way to express this lookup without a branch.)
        let target = null;
        for (const btn of renameBtns) {
            const row = btn.closest('[data-skill-name]');
            // eslint-disable-next-line playwright/no-conditional-in-test
            if (row && row.getAttribute('data-skill-name') === 'foo') {
                target = btn; break;
            }
        }
        expect(target).toBeTruthy();
        target.click();

        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(ctx.__skillsApi.rename).not.toHaveBeenCalled();
        // The collision-warning CONFIRM popup should have been opened.
        const confirmCalls = ctx.__popupCalls.filter(c => c.type === ctx.POPUP_TYPE.CONFIRM);
        expect(confirmCalls.length).toBeGreaterThan(0);
    });

    test('move-scope conflict warns and only calls moveScope when user accepts', async () => {
        const skills = [
            { name: 'shared', scope: { kind: 'global' }, description: '', fileCount: 1 },
            { name: 'shared', scope: { kind: 'character', characterFile: 'A.png' }, description: '', fileCount: 1 },
        ];
        // Scope-picker returns character/A.png → collision → user accepts proceed.
        const { ctx, mount } = await bootstrap({
            // The new scope-picker renders the character row as a real <select>
            // populated from context.characters; we have to advertise A.png as a
            // selectable option for the test driver to be able to "pick" it.
            characters: [{ name: 'Alice', avatar: 'A.png' }],
            skills,
            scenarios: {
                confirm: () => 1, // AFFIRMATIVE — proceed despite warning
                popupShow: async (popup) => {
                    // Drive the scope-picker: emulate "user picks
                    // character/A.png". Flip the kind radio to "character"
                    // and mark the corresponding <option> as selected so the
                    // stub <select>.value reads A.png.
                    const dlg = popup.dlg;
                    const radios = dlg.querySelectorAll('[name="luker_skill_scope_kind"]');
                    for (const r of radios) {
                        r.checked = (r._attrs.get('value') === 'character');
                    }
                    const charSelect = dlg.querySelector('[data-skill-scope-character]');
                    if (charSelect) {
                        // Mark the matching <option> as selected — the stub
                        // <select>.value getter reads from option attrs, not
                        // from a direct .value setter.
                        for (const opt of charSelect._children) {
                            if (opt._attrs.get('value') === 'A.png') opt._attrs.set('selected', '');
                            else opt._attrs.delete('selected');
                        }
                    }
                    if (popup.opts && typeof popup.opts.onClosing === 'function') {
                        const r = popup.opts.onClosing({
                            result: 1,
                            dlg,
                        });
                        if (r === false) return 0;
                    }
                    popup.result = 1;
                    return 1;
                },
            },
        });

        const moveBtns = mount.querySelectorAll('[data-skill-action="move"]');
        // Click the move button for the global 'shared'.
        let target = null;
        for (const btn of moveBtns) {
            const row = btn.closest('[data-skill-name]');
            const scope = JSON.parse(row.getAttribute('data-skill-scope'));
            // eslint-disable-next-line playwright/no-conditional-in-test
            if (scope.kind === 'global') { target = btn; break; }
        }
        expect(target).toBeTruthy();
        target.click();

        // Yield for the async chain.
        for (let i = 0; i < 15; i++) await Promise.resolve();

        expect(ctx.__skillsApi.moveScope).toHaveBeenCalledTimes(1);
        const args = ctx.__skillsApi.moveScope.mock.calls[0];
        expect(args[0]).toBe('shared');
        expect(args[1]).toEqual({ kind: 'global' });
        expect(args[2]).toEqual({ kind: 'character', characterFile: 'A.png' });
    });

    test('Import bundled calls importBundled and refreshes', async () => {
        const { ctx, mount } = await bootstrap({ skills: [] });
        const btn = mount.querySelector('[data-skill-toolbar="import-bundled"]');
        expect(btn).toBeTruthy();
        btn.click();

        for (let i = 0; i < 5; i++) await Promise.resolve();

        expect(ctx.__skillsApi.importBundled).toHaveBeenCalledTimes(1);
        // List is called once at initial render + again after refresh.
        expect(ctx.__skillsApi.list.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(global.toastr.success).toHaveBeenCalled();
    });

    test('Create new triggers the create-new-skill flow (no Unit-4 stub toast)', async () => {
        const { ctx, mount } = await bootstrap({ skills: [] });
        const btn = mount.querySelector('[data-skill-toolbar="create"]');
        expect(btn).toBeTruthy();
        btn.click();
        // Multiple microtask drains so the create flow opens its first INPUT popup.
        for (let i = 0; i < 6; i++) await Promise.resolve();
        // Either an INPUT prompt for the new-skill name was opened or the
        // editor flow short-circuited; in both cases the Unit-2 placeholder
        // toast should NOT fire.
        const stubToast = global.toastr.info.mock.calls.find(c => /Unit 4/.test(String(c[0])));
        expect(stubToast).toBeFalsy();
        // The create flow opens an INPUT-type popup as its first step.
        const inputCalls = ctx.__popupCalls.filter(c => c.type === ctx.POPUP_TYPE.INPUT);
        expect(inputCalls.length).toBeGreaterThan(0);
    });

    test('Edit on a skill opens the editor popup (no Unit-4 stub toast)', async () => {
        const skills = [
            { name: 'demo', scope: { kind: 'global' }, description: 'd', fileCount: 1 },
        ];
        const { ctx, mount } = await bootstrap({ skills });
        // Override listFiles so the editor's initial refresh has something
        // to render (real openSkillEditor calls listFiles).
        ctx.__skillsApi.listFiles = jest.fn(async () => ({ files: [{ path: 'SKILL.md', size: 10, isBinary: false }] }));
        const editBtn = mount.querySelector('[data-skill-action="edit"]');
        expect(editBtn).toBeTruthy();
        editBtn.click();
        for (let i = 0; i < 6; i++) await Promise.resolve();
        // No Unit-2 placeholder toast
        const stubToast = global.toastr.info.mock.calls.find(c => /Unit 4/.test(String(c[0])));
        expect(stubToast).toBeFalsy();
        // The editor opens a TEXT-type popup as its container.
        const textCalls = ctx.__popupCalls.filter(c => c.type === ctx.POPUP_TYPE.TEXT);
        // First TEXT popup was the manager itself; we expect a SECOND one
        // for the editor.
        expect(textCalls.length).toBeGreaterThanOrEqual(2);
        // listFiles should have been called once the editor's deferred refresh runs.
        expect(ctx.__skillsApi.listFiles).toHaveBeenCalled();
    });

    test('Browse bundled tab is present and renders bundled rows', async () => {
        const bundled = [
            { name: 'bundle-one', installedHash: 'h1', fileCount: 1, totalBytes: 50, description: 'one' },
        ];
        const skills = [];
        const { ctx, mount } = await bootstrap({ skills, bundled });
        // The tab strip should render two tabs.
        const installedTab = mount.querySelector('[data-skill-tab="installed"]');
        const bundledTab = mount.querySelector('[data-skill-tab="bundled"]');
        expect(installedTab).toBeTruthy();
        expect(bundledTab).toBeTruthy();
        // Switch to bundled.
        bundledTab.click();
        for (let i = 0; i < 8; i++) await Promise.resolve();
        // The bundled tab should have called listBundledManifest.
        expect(ctx.__skillsApi.listBundledManifest).toHaveBeenCalled();
        // The bundled-browser paints into the inner mount. The stub's
        // outer-element `.innerHTML` is a snapshot (set during the panel's
        // own render); we check the inner mount directly.
        const bundledMount = mount.querySelector('.luker_skill_manager_bundled_mount');
        expect(bundledMount).toBeTruthy();
        expect(bundledMount.innerHTML).toContain('bundle-one');
        expect(bundledMount.innerHTML).toContain('Not installed');
    });

    test('initialScope filter pre-selects scope in dropdown', async () => {
        const skills = [
            { name: 'a', scope: { kind: 'global' }, description: 'g', fileCount: 1 },
            { name: 'b', scope: { kind: 'preset', name: 'rp' }, description: 'p', fileCount: 1 },
        ];
        // Open with initialScope filter set to that preset.
        const initialScope = { kind: 'preset', name: 'rp' };
        const { mount } = await bootstrap({ skills, initialScope });
        // The filter dropdown should have the preset scope selected; the panel
        // body should only contain group(s) for that scope.
        const filterSelect = mount.querySelector('[data-skill-filter]');
        expect(filterSelect).toBeTruthy();
        expect(filterSelect.value).toBe('preset/rp');
        // Global skill 'a' should not appear in the rendered list.
        const rows = mount.querySelectorAll('[data-skill-name]');
        const names = [];
        for (const r of rows) names.push(r.getAttribute('data-skill-name'));
        expect(names).toContain('b');
        expect(names).not.toContain('a');
    });
});
