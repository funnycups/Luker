/**
 * Unit tests for the shared scope picker (post-refactor: no connection
 * profile field — preset scope is keyed by preset name alone).
 *
 * The picker's pure helpers (`listAllPresets`, `getActivePresetName`,
 * `listCharacters`, `buildScopePickerHtml`) are tested without any DOM.
 * The interactive `pickTargetScope` is exercised against a minimal Popup
 * stub that mirrors the Popup.show() contract used by ST.
 */

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';

describe('scope-picker — pure helpers', () => {
    let mod;
    beforeEach(async () => {
        mod = await import('../../public/scripts/skills/scope-picker.js');
    });

    test('listAllPresets walks every known preset manager and dedupes by name', () => {
        const managers = {
            openai: { getAllPresets: () => ['fast', 'slow'] },
            claude: { getAllPresets: () => ['slow', 'thoughtful'] }, // "slow" duplicates openai → first manager wins
        };
        const ctx = { getPresetManager: (api) => managers[api] || null };
        const out = mod.listAllPresets(ctx);
        expect(out.find(p => p.name === 'fast')).toEqual({ name: 'fast', api: 'openai' });
        expect(out.find(p => p.name === 'slow')).toEqual({ name: 'slow', api: 'openai' });
        expect(out.find(p => p.name === 'thoughtful')).toEqual({ name: 'thoughtful', api: 'claude' });
    });

    test('listAllPresets returns [] when no preset managers exist', () => {
        expect(mod.listAllPresets({})).toEqual([]);
        expect(mod.listAllPresets(null)).toEqual([]);
        expect(mod.listAllPresets({ getPresetManager: () => null })).toEqual([]);
    });

    test('listAllPresets sorts by preset name', () => {
        const ctx = {
            getPresetManager: (api) => (api === 'openai'
                ? { getAllPresets: () => ['zulu', 'alpha', 'mike'] }
                : null),
        };
        expect(mod.listAllPresets(ctx).map(p => p.name)).toEqual(['alpha', 'mike', 'zulu']);
    });

    test('getActivePresetName returns the first manager-reported selected preset', () => {
        const ctx = {
            getPresetManager: (api) => {
                if (api === 'openai') return { getSelectedPresetName: () => '' };
                if (api === 'claude') return { getSelectedPresetName: () => 'thoughtful' };
                return null;
            },
        };
        expect(mod.getActivePresetName(ctx)).toBe('thoughtful');
    });

    test('getActivePresetName returns empty string when nothing is selected anywhere', () => {
        expect(mod.getActivePresetName({})).toBe('');
        expect(mod.getActivePresetName({ getPresetManager: () => null })).toBe('');
    });

    test('listCharacters returns avatar-as-value, name-as-label pairs sorted by label', () => {
        const ctx = {
            characters: [
                { name: 'Bob', avatar: 'bob.png' },
                { name: 'Alice', avatar: 'alice.png' },
                { name: '', avatar: 'orphan.png' }, // empty name → label falls back to avatar
                { avatar: '' },                     // empty avatar → skipped
                null,                                // skipped
            ],
        };
        const out = mod.listCharacters(ctx);
        expect(out).toEqual([
            { value: 'alice.png', label: 'Alice (alice.png)' },
            { value: 'bob.png', label: 'Bob (bob.png)' },
            { value: 'orphan.png', label: 'orphan.png' },
        ]);
    });

    test('buildScopePickerHtml renders preset + character rows but never a connection-profile row', () => {
        const html = mod.buildScopePickerHtml({
            title: 'Move "demo" to scope',
            t: (s) => s,
            suggestKind: 'preset',
            suggestPreset: 'fast',
            suggestChar: '',
            presets: [
                { name: 'fast', api: 'openai' },
                { name: 'slow', api: 'openai' },
            ],
            characters: [{ value: 'a.png', label: 'A' }],
        });
        // Preset radio pre-checked
        expect(html).toMatch(/value="preset"\s+checked/);
        // Preset dropdown selected option
        expect(html).toMatch(/<option value="fast" selected>/);
        // Character sub-row hidden when kind=preset
        expect(html).toMatch(/luker_skill_scope_character_fields"\s+hidden/);
        // Preset sub-row visible
        expect(html).toMatch(/luker_skill_scope_preset_fields"\s+data-skill-scope-row="preset"/);
        // No connection profile select / row anywhere
        expect(html).not.toContain('data-skill-scope-api');
        expect(html).not.toContain('Connection profile');
    });

    test('buildScopePickerHtml hides both sub-rows when suggested kind is global', () => {
        const html = mod.buildScopePickerHtml({
            title: 'Scope',
            t: (s) => s,
            suggestKind: 'global',
            suggestPreset: '',
            suggestChar: '',
            presets: [],
            characters: [],
        });
        expect(html).toMatch(/luker_skill_scope_preset_fields"\s+hidden/);
        expect(html).toMatch(/luker_skill_scope_character_fields"\s+hidden/);
    });

    test('buildScopePickerHtml shows the empty-state option when no preset managers contributed', () => {
        const html = mod.buildScopePickerHtml({
            title: 'Scope',
            t: (s) => s,
            suggestKind: 'preset',
            suggestPreset: '',
            suggestChar: '',
            presets: [],
            characters: [],
        });
        expect(html).toContain('(no chat completion presets)');
    });
});

// ── Integration-style tests against a stub Popup ──────────────────────────

class StubElement {
    constructor(tagName = 'div') {
        this.tagName = String(tagName || 'div').toUpperCase();
        this._children = [];
        this._listeners = new Map();
        this._attrs = new Map();
        this._innerHTML = '';
        this.value = '';
        this.checked = false;
        this.hidden = false;
        this.parentNode = null;
    }
    get innerHTML() { return this._innerHTML; }
    set innerHTML(html) {
        this._innerHTML = String(html);
        this._children = parseStubChildren(this._innerHTML, this);
    }
    setAttribute(name, value) { this._attrs.set(String(name), String(value)); }
    getAttribute(name) { return this._attrs.has(String(name)) ? this._attrs.get(String(name)) : null; }
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
        if (/:checked/.test(sel) && !this.checked) return false;
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
        out.forEach = (cb) => { for (const e of out) cb(e); };
        return out;
    }
    addEventListener(event, handler) {
        if (!this._listeners.has(event)) this._listeners.set(event, []);
        this._listeners.get(event).push(handler);
    }
    dispatchEvent(event) {
        const list = this._listeners.get(event.type) || [];
        for (const h of list) h(event);
    }
}

function unescapeHtml(s) {
    return String(s ?? '')
        .replace(/&quot;/g, '"').replace(/&#39;/g, '\'')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
function parseStubChildren(html, parent) {
    const VOID_TAGS = new Set(['input', 'br', 'img', 'hr', 'meta', 'option']);
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
            if (stack.length > 1 && top.tagName === tag.toUpperCase()) stack.pop();
            continue;
        }
        const el = new StubElement(tag);
        const attrRe = /([a-z][a-z0-9-]*)(?:="([^"]*)")?/gi;
        let am;
        while ((am = attrRe.exec(attrs))) {
            el._attrs.set(am[1].toLowerCase(), am[2] !== undefined ? unescapeHtml(am[2]) : '');
        }
        if (el._attrs.has('value')) el.value = el._attrs.get('value');
        if (el._attrs.has('checked')) el.checked = true;
        if (el._attrs.has('hidden')) el.hidden = true;
        if (tag === 'option' && el._attrs.has('selected') && top.tagName === 'SELECT') {
            top.value = el.value;
        }
        el.parentNode = top;
        top._children.push(el);
        if (!selfClose && !VOID_TAGS.has(tag)) stack.push(el);
    }
    return parent._children;
}

class StubPopup {
    constructor(html, type, _title, opts) {
        this.html = html;
        this.type = type;
        this.opts = opts || {};
        this.dlg = new StubElement('div');
        this.dlg.innerHTML = html;
        this.result = null;
    }
    show() {
        return new Promise((resolve) => { this._resolve = resolve; });
    }
}

function makeStubContext({ presets = ['fast', 'slow'], characters = [] } = {}) {
    return {
        characters,
        getPresetManager: (api) => (api === 'openai'
            ? { getAllPresets: () => presets, getSelectedPresetName: () => presets[0] || '' }
            : null),
        Popup: StubPopup,
        POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null },
        POPUP_TYPE: { CONFIRM: 2, INPUT: 3 },
    };
}

describe('pickTargetScope — interactive', () => {
    let origToastr;
    beforeEach(() => {
        origToastr = global.toastr;
        global.toastr = { info: jest.fn(), success: jest.fn(), error: jest.fn() };
    });
    afterEach(() => { global.toastr = origToastr; });

    test('returns null when user cancels (Popup resolves with NEGATIVE)', async () => {
        const { pickTargetScope } = await import('../../public/scripts/skills/scope-picker.js');
        const ctx = makeStubContext({});
        const original = ctx.Popup;
        let popupInstance;
        ctx.Popup = class extends original {
            constructor(...a) { super(...a); popupInstance = this; }
        };
        const p = pickTargetScope(ctx, (s) => s, 'Move x', null);
        popupInstance._resolve(ctx.POPUP_RESULT.NEGATIVE);
        await expect(p).resolves.toBeNull();
    });

    test('returns global scope when kind=global radio is selected', async () => {
        const { pickTargetScope } = await import('../../public/scripts/skills/scope-picker.js');
        const ctx = makeStubContext({});
        const original = ctx.Popup;
        let popupInstance;
        ctx.Popup = class extends original {
            constructor(...a) { super(...a); popupInstance = this; }
        };
        const p = pickTargetScope(ctx, (s) => s, 'Move x', null);
        const ok = popupInstance.opts.onClosing({ result: ctx.POPUP_RESULT.AFFIRMATIVE, dlg: popupInstance.dlg });
        expect(ok).toBe(true);
        popupInstance._resolve(ctx.POPUP_RESULT.AFFIRMATIVE);
        await expect(p).resolves.toEqual({ kind: 'global' });
    });

    test('returns preset scope without apiId field', async () => {
        const { pickTargetScope } = await import('../../public/scripts/skills/scope-picker.js');
        const ctx = makeStubContext({ presets: ['fast', 'slow'] });
        const original = ctx.Popup;
        let popupInstance;
        ctx.Popup = class extends original {
            constructor(...a) { super(...a); popupInstance = this; }
        };
        const p = pickTargetScope(ctx, (s) => s, 'Move x', { kind: 'preset', name: 'slow' });
        const presetRadio = popupInstance.dlg.querySelector('input[value="preset"]');
        presetRadio.checked = true;
        const ok = popupInstance.opts.onClosing({ result: ctx.POPUP_RESULT.AFFIRMATIVE, dlg: popupInstance.dlg });
        expect(ok).toBe(true);
        popupInstance._resolve(ctx.POPUP_RESULT.AFFIRMATIVE);
        // The returned scope must NOT include any apiId / connection-profile field.
        await expect(p).resolves.toEqual({ kind: 'preset', name: 'slow' });
    });

    test('rejects preset scope when no preset is selected (validation error)', async () => {
        const { pickTargetScope } = await import('../../public/scripts/skills/scope-picker.js');
        // No presets available → the dropdown renders only the disabled "(no presets)" placeholder.
        const ctx = makeStubContext({ presets: [] });
        const original = ctx.Popup;
        let popupInstance;
        ctx.Popup = class extends original {
            constructor(...a) { super(...a); popupInstance = this; }
        };
        const p = pickTargetScope(ctx, (s) => s, 'Move x', { kind: 'preset', name: '' });
        const presetRadio = popupInstance.dlg.querySelector('input[value="preset"]');
        presetRadio.checked = true;
        const ok = popupInstance.opts.onClosing({ result: ctx.POPUP_RESULT.AFFIRMATIVE, dlg: popupInstance.dlg });
        expect(ok).toBe(false);
        expect(global.toastr.error).toHaveBeenCalled();
    });

    test('returns character scope using picked dropdown value', async () => {
        const { pickTargetScope } = await import('../../public/scripts/skills/scope-picker.js');
        const ctx = makeStubContext({
            characters: [
                { name: 'Alice', avatar: 'alice.png' },
                { name: 'Bob', avatar: 'bob.png' },
            ],
        });
        const original = ctx.Popup;
        let popupInstance;
        ctx.Popup = class extends original {
            constructor(...a) { super(...a); popupInstance = this; }
        };
        const p = pickTargetScope(ctx, (s) => s, 'Move x', { kind: 'character', characterFile: 'bob.png' });
        const charRadio = popupInstance.dlg.querySelector('input[value="character"]');
        charRadio.checked = true;
        const ok = popupInstance.opts.onClosing({ result: ctx.POPUP_RESULT.AFFIRMATIVE, dlg: popupInstance.dlg });
        expect(ok).toBe(true);
        popupInstance._resolve(ctx.POPUP_RESULT.AFFIRMATIVE);
        await expect(p).resolves.toEqual({ kind: 'character', characterFile: 'bob.png' });
    });
});
