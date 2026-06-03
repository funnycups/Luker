/**
 * Plan 2 Unit 5 — Skill embed import dialog.
 *
 * Pure-helper unit tests for the dialog builder + decision collector, plus
 * one integration-style scenario per UX path (preview-only / user-replace /
 * user-skip / cancel) that exercises `runEmbedImportFlow` end-to-end.
 *
 * Like the Unit 2-4 tests, runs under `testEnvironment: "node"` with a
 * minimal stub DOM (just enough for the popup's `dlg.querySelectorAll`
 * loop to drive radios). The popup itself is replaced with a stub that
 * lets us drive the onClosing path manually.
 */

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';

// ── Minimal stub DOM ─────────────────────────────────────────────────────

class StubElement {
    constructor(tag = 'div') {
        this.tagName = String(tag || 'div').toUpperCase();
        this._children = [];
        this._attrs = new Map();
        this._innerHTML = '';
        this.checked = false;
        this.value = '';
        this.parentNode = null;
    }
    get innerHTML() { return this._innerHTML; }
    set innerHTML(html) {
        this._innerHTML = String(html);
        this._children = parseStubChildren(this._innerHTML, this);
    }
    getAttribute(name) { return this._attrs.has(String(name)) ? this._attrs.get(String(name)) : null; }
    setAttribute(name, value) { this._attrs.set(String(name), String(value)); }
    appendChild(child) { child.parentNode = this; this._children.push(child); return child; }
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
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    querySelectorAll(sel) {
        const out = [];
        const visit = (n) => {
            if (n.matches && n.matches(sel)) out.push(n);
            for (const c of n._children || []) visit(c);
        };
        for (const c of this._children) visit(c);
        out.forEach = function (cb) { for (const e of this) cb(e); };
        return out;
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

// ── Pure helper tests ────────────────────────────────────────────────────

describe('embed-import-dialog — pure helpers', () => {
    let mod;

    beforeEach(async () => {
        mod = await import('../../public/scripts/skills/embed-import-dialog.js');
    });

    test('formatScopeLabel handles all scope kinds', () => {
        expect(mod.formatScopeLabel({ kind: 'global' })).toBe('global');
        expect(mod.formatScopeLabel({ kind: 'preset', name: 'pj' }))
            .toBe('preset: pj');
        expect(mod.formatScopeLabel({ kind: 'character', characterFile: 'Alice.png' }))
            .toBe('character: Alice.png');
        expect(mod.formatScopeLabel(null)).toBe('unknown');
    });

    test('getEmbeddedSkillsSource pulls payload at the canonical path', () => {
        const ok = {
            extensions: {
                luker: {
                    embedded_skills_source: {
                        version: 1,
                        items: [{ name: 'a', bundleFormat: 'inline-files-v1', files: [] }],
                    },
                },
            },
        };
        expect(mod.getEmbeddedSkillsSource(ok)).toBeTruthy();
        expect(mod.getEmbeddedSkillsSource(null)).toBeNull();
        expect(mod.getEmbeddedSkillsSource({})).toBeNull();
        // Wrong version → reject
        expect(mod.getEmbeddedSkillsSource({
            extensions: { luker: { embedded_skills_source: { version: 2, items: [] } } },
        })).toBeNull();
        // Missing items[] → reject
        expect(mod.getEmbeddedSkillsSource({
            extensions: { luker: { embedded_skills_source: { version: 1 } } },
        })).toBeNull();
    });

    test('buildDefaultConflictStrategies picks per-conflict defaults', () => {
        const items = [
            { name: 'a', conflict: 'new' },
            { name: 'b', conflict: 'same' },
            { name: 'c', conflict: 'different' },
            { name: 'd', conflict: 'invalid' },
            { name: null, conflict: 'invalid' },
        ];
        const out = mod.buildDefaultConflictStrategies(items);
        expect(out).toEqual({ a: 'replace', b: 'skip', c: 'skip' });
    });

    test('buildImportTableHtml renders one row per conflict state', () => {
        const items = [
            { name: 'alpha', conflict: 'new' },
            { name: 'beta', conflict: 'same' },
            { name: 'gamma', conflict: 'different' },
            { name: 'delta', conflict: 'invalid' },
        ];
        const t = (s) => s;
        const esc = (s) => String(s);
        const html = mod.buildImportTableHtml(items, t, esc);
        expect(html).toContain('alpha');
        expect(html).toContain('beta');
        expect(html).toContain('gamma');
        expect(html).toContain('delta');
        expect(html).toContain('New (install)');
        expect(html).toContain('Already installed (skip)');
        expect(html).toContain('Different (choose)');
        expect(html).toContain('Invalid (will be ignored)');
        // Only `different` rows get a radio.
        expect(html.match(/type="radio"/g)).toHaveLength(2);
    });

    test('buildImportTableHtml handles empty list', () => {
        const html = mod.buildImportTableHtml([], (s) => s, (s) => String(s));
        expect(html).toContain('No skills found');
    });

    test('buildDialogHtml composes header + scope label + table', () => {
        const items = [{ name: 'x', conflict: 'new' }];
        const scope = { kind: 'character', characterFile: 'A.png' };
        const html = mod.buildDialogHtml(scope, items, (s) => s, (s) => String(s));
        expect(html).toContain('character: A.png');
        expect(html).toContain('x');
        expect(html).toContain('Skills embedded in this asset');
    });

    test('collectConflictStrategies reads radio state from a stub DOM', () => {
        const items = [
            { name: 'newone', conflict: 'new' },
            { name: 'diff1', conflict: 'different' },
            { name: 'diff2', conflict: 'different' },
        ];
        const html = mod.buildDialogHtml({ kind: 'global' }, items, (s) => s, (s) => String(s));
        const root = new StubElement('div');
        root.innerHTML = html;

        // Default state: diff rows defaulted to skip.
        let out = mod.collectConflictStrategies(root, items);
        expect(out).toEqual({ newone: 'replace', diff1: 'skip', diff2: 'skip' });

        // Flip diff1 to replace.
        const radios = root.querySelectorAll('input[type="radio"][data-skill-import-radio]');
        // Find the diff1-replace radio and the diff1-skip radio.
        let diff1Replace = null;
        let diff1Skip = null;
        for (const r of radios) {
            const name = r.getAttribute('data-skill-import-radio');
            const value = r.value;
            // eslint-disable-next-line playwright/no-conditional-in-test
            if (name === 'diff1' && value === 'replace') diff1Replace = r;
            // eslint-disable-next-line playwright/no-conditional-in-test
            if (name === 'diff1' && value === 'skip') diff1Skip = r;
        }
        expect(diff1Replace).toBeTruthy();
        expect(diff1Skip).toBeTruthy();
        diff1Replace.checked = true;
        diff1Skip.checked = false;
        out = mod.collectConflictStrategies(root, items);
        expect(out.diff1).toBe('replace');
        // diff2 stays skip (still the default-checked radio).
        expect(out.diff2).toBe('skip');
    });
});

// ── Integration-style tests for runEmbedImportFlow ───────────────────────

function makeStubContext({
    previewItems = [],
    executeResult = { installed: [], skipped: [] },
    previewError = null,
    executeError = null,
    popupResult = 1,
    radioFlips = null,
} = {}) {
    const popupCalls = [];
    const POPUP_TYPE = { TEXT: 1, CONFIRM: 2, INPUT: 3, DISPLAY: 4 };
    const POPUP_RESULT = { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null };
    const skillsApi = {
        previewExtractEmbed: jest.fn(async () => {
            if (previewError) throw previewError;
            return { items: previewItems };
        }),
        executeExtractEmbed: jest.fn(async () => {
            if (executeError) throw executeError;
            return executeResult;
        }),
    };
    const Popup = class StubPopup {
        constructor(html, type, _val, opts) {
            this.html = html;
            this.type = type;
            this.opts = opts || {};
            this.result = POPUP_RESULT.CANCELLED;
            this.dlg = new StubElement('div');
            this.dlg.innerHTML = html;
            popupCalls.push({ html, type });
        }
        async show() {
            // If the caller supplied a radioFlips override, apply it before
            // we drive onClosing — this simulates the user toggling a radio
            // in the table.
            if (radioFlips && typeof radioFlips === 'object') {
                const radios = this.dlg.querySelectorAll('input[type="radio"][data-skill-import-radio]');
                for (const r of radios) {
                    const name = r.getAttribute('data-skill-import-radio');
                    const value = r.value;
                    const desired = radioFlips[name];
                    // eslint-disable-next-line playwright/no-conditional-in-test
                    if (desired !== undefined) {
                        r.checked = (value === desired);
                    }
                }
            }
            if (this.opts && typeof this.opts.onClosing === 'function') {
                this.opts.onClosing({ result: popupResult, dlg: this.dlg });
            }
            this.result = popupResult;
            return popupResult;
        }
    };
    return {
        skills: skillsApi,
        Popup,
        POPUP_TYPE,
        POPUP_RESULT,
        callGenericPopup: jest.fn(),
        __popupCalls: popupCalls,
        __skillsApi: skillsApi,
    };
}

describe('runEmbedImportFlow', () => {
    let origToastr;

    // eslint-disable-next-line playwright/no-duplicate-hooks
    beforeEach(() => {
        origToastr = global.toastr;
        global.toastr = { info: jest.fn(), success: jest.fn(), error: jest.fn() };
    });

    // eslint-disable-next-line playwright/no-duplicate-hooks
    afterEach(() => {
        global.toastr = origToastr;
    });

    test('preview empty → returns installed=[], no popup shown', async () => {
        const { runEmbedImportFlow } = await import('../../public/scripts/skills/embed-import-dialog.js');
        const ctx = makeStubContext({ previewItems: [] });
        const out = await runEmbedImportFlow({
            context: ctx,
            payload: { version: 1, items: [] },
            targetScope: { kind: 'global' },
        });
        expect(out.installed).toEqual([]);
        expect(ctx.__skillsApi.previewExtractEmbed).toHaveBeenCalledTimes(1);
        expect(ctx.__skillsApi.executeExtractEmbed).not.toHaveBeenCalled();
        expect(ctx.__popupCalls).toHaveLength(0);
    });

    test('all-new conflict → auto-install via execute with replace strategy', async () => {
        const { runEmbedImportFlow } = await import('../../public/scripts/skills/embed-import-dialog.js');
        const ctx = makeStubContext({
            previewItems: [
                { name: 'one', conflict: 'new' },
                { name: 'two', conflict: 'new' },
            ],
            executeResult: { installed: ['one', 'two'], skipped: [] },
        });
        const out = await runEmbedImportFlow({
            context: ctx,
            payload: { version: 1, items: [{ name: 'one' }, { name: 'two' }] },
            targetScope: { kind: 'character', characterFile: 'A.png' },
        });
        expect(ctx.__skillsApi.executeExtractEmbed).toHaveBeenCalledTimes(1);
        const args = ctx.__skillsApi.executeExtractEmbed.mock.calls[0][0];
        expect(args.targetScope).toEqual({ kind: 'character', characterFile: 'A.png' });
        expect(args.conflictStrategies).toEqual({ one: 'replace', two: 'replace' });
        expect(out.installed).toEqual(['one', 'two']);
        expect(global.toastr.success).toHaveBeenCalled();
    });

    test('different + same + new mix → defaults skip for different rows', async () => {
        const { runEmbedImportFlow } = await import('../../public/scripts/skills/embed-import-dialog.js');
        const ctx = makeStubContext({
            previewItems: [
                { name: 'newone', conflict: 'new' },
                { name: 'sameone', conflict: 'same' },
                { name: 'diffone', conflict: 'different' },
            ],
        });
        await runEmbedImportFlow({
            context: ctx,
            payload: { version: 1, items: [] },
            targetScope: { kind: 'global' },
        });
        const args = ctx.__skillsApi.executeExtractEmbed.mock.calls[0][0];
        expect(args.conflictStrategies).toEqual({
            newone: 'replace',
            sameone: 'skip',
            diffone: 'skip',
        });
    });

    test('user flips a different row to replace → conflictStrategies reflects it', async () => {
        const { runEmbedImportFlow } = await import('../../public/scripts/skills/embed-import-dialog.js');
        const ctx = makeStubContext({
            previewItems: [
                { name: 'newone', conflict: 'new' },
                { name: 'diffone', conflict: 'different' },
                { name: 'difftwo', conflict: 'different' },
            ],
            // Simulate user toggling diffone to Replace.
            radioFlips: { diffone: 'replace' },
        });
        await runEmbedImportFlow({
            context: ctx,
            payload: { version: 1, items: [] },
            targetScope: { kind: 'global' },
        });
        const args = ctx.__skillsApi.executeExtractEmbed.mock.calls[0][0];
        expect(args.conflictStrategies).toEqual({
            newone: 'replace',
            diffone: 'replace',
            difftwo: 'skip',
        });
    });

    test('user cancels → no execute call, aborted true', async () => {
        const { runEmbedImportFlow } = await import('../../public/scripts/skills/embed-import-dialog.js');
        const ctx = makeStubContext({
            previewItems: [{ name: 'foo', conflict: 'new' }],
            popupResult: 0, // NEGATIVE
        });
        const out = await runEmbedImportFlow({
            context: ctx,
            payload: { version: 1, items: [] },
            targetScope: { kind: 'global' },
        });
        expect(out.aborted).toBe(true);
        expect(ctx.__skillsApi.executeExtractEmbed).not.toHaveBeenCalled();
    });

    test('preview error → returns aborted with error message, no popup', async () => {
        const { runEmbedImportFlow } = await import('../../public/scripts/skills/embed-import-dialog.js');
        const ctx = makeStubContext({
            previewError: new Error('boom'),
        });
        const out = await runEmbedImportFlow({
            context: ctx,
            payload: { version: 1, items: [] },
            targetScope: { kind: 'global' },
        });
        expect(out.aborted).toBe(true);
        expect(out.error).toBe('boom');
        expect(ctx.__popupCalls).toHaveLength(0);
        expect(global.toastr.error).toHaveBeenCalled();
    });

    test('execute error → returns aborted with error message', async () => {
        const { runEmbedImportFlow } = await import('../../public/scripts/skills/embed-import-dialog.js');
        const ctx = makeStubContext({
            previewItems: [{ name: 'x', conflict: 'new' }],
            executeError: new Error('exec-fail'),
        });
        const out = await runEmbedImportFlow({
            context: ctx,
            payload: { version: 1, items: [] },
            targetScope: { kind: 'global' },
        });
        expect(out.aborted).toBe(true);
        expect(out.error).toBe('exec-fail');
        expect(global.toastr.error).toHaveBeenCalled();
    });
});
