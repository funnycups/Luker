/**
 * Per-agent skill chips component.
 *
 * Tests target the pure helpers (renderSkillChipsHtml, chipClasses,
 * computeAddOptions, applyChipToggle, applyChipRemove, applyChipAdd,
 * isInheritedChipName, chipKindFor) plus an integration scenario that
 * mounts the chips into a stub DOM, dispatches click events, and asserts
 * the underlying `value` mutates as expected.
 *
 * Conventions mirror tests/skills-ui/skill-manager-panel.test.js: jest
 * runs in node (no jsdom), we install a minimal `global.document` stub
 * with the slice of DOM the component actually touches, and tests drive
 * UI by calling `.click()` on stub elements.
 */

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';

describe('skill-chips — pure helpers', () => {
    let mod;

    beforeEach(async () => {
        mod = await import('../../public/scripts/skills/skill-chips.js');
    });

    test('chipKindFor — inherit sentinel returns "inherit"', () => {
        expect(mod.chipKindFor('+', { visible: ['+', 'foo'], deny: [] })).toBe('inherit');
    });

    test('chipKindFor — visible name returns "visible"', () => {
        expect(mod.chipKindFor('foo', { visible: ['foo'], deny: [] })).toBe('visible');
    });

    test('chipKindFor — deny name returns "deny"', () => {
        expect(mod.chipKindFor('bar', { visible: [], deny: ['bar'] })).toBe('deny');
    });

    test('chipKindFor — name not in either returns null', () => {
        expect(mod.chipKindFor('missing', { visible: [], deny: [] })).toBe(null);
    });

    test('isInstalled — true when name is in availableSkills', () => {
        const skills = [{ name: 'foo' }, { name: 'bar' }];
        expect(mod.isInstalled('foo', skills)).toBe(true);
        expect(mod.isInstalled('missing', skills)).toBe(false);
    });

    test('isInstalled — "+" inherit chip is always considered installed', () => {
        expect(mod.isInstalled('+', [])).toBe(true);
    });

    test('computeAddOptions — returns available skills minus already-added', () => {
        const value = { visible: ['foo'], deny: ['bar'] };
        const avail = [{ name: 'foo' }, { name: 'bar' }, { name: 'baz' }, { name: 'qux' }];
        const opts = mod.computeAddOptions(value, avail);
        expect(opts.map(s => s.name).sort()).toEqual(['baz', 'qux']);
    });

    test('computeAddOptions — handles undefined value and missing inheritFrom', () => {
        const avail = [{ name: 'a' }, { name: 'b' }];
        const opts = mod.computeAddOptions(undefined, avail);
        expect(opts.map(s => s.name).sort()).toEqual(['a', 'b']);
    });

    test('computeAddOptions — excludes "+" inherit sentinel from add list', () => {
        // The inherit chip is added by a dedicated control, not from the dropdown.
        const value = { visible: ['+'], deny: [] };
        const avail = [{ name: 'a' }];
        const opts = mod.computeAddOptions(value, avail);
        expect(opts.map(s => s.name)).toEqual(['a']);
    });

    test('chipClasses — visible name gets visible class', () => {
        expect(mod.chipClasses({ name: 'foo', kind: 'visible', installed: true })).toContain('luker_skill_chip_visible');
    });

    test('chipClasses — deny name gets deny class', () => {
        expect(mod.chipClasses({ name: 'foo', kind: 'deny', installed: true })).toContain('luker_skill_chip_deny');
    });

    test('chipClasses — inherit chip gets inherit class', () => {
        expect(mod.chipClasses({ name: '+', kind: 'inherit', installed: true })).toContain('luker_skill_chip_inherit');
    });

    test('chipClasses — missing (not installed) chip gets missing class', () => {
        const cls = mod.chipClasses({ name: 'missing', kind: 'visible', installed: false });
        expect(cls).toContain('luker_skill_chip_missing');
    });

    test('chipClasses — installed chips do NOT get the missing class', () => {
        const cls = mod.chipClasses({ name: 'foo', kind: 'visible', installed: true });
        expect(cls).not.toContain('luker_skill_chip_missing');
    });

    test('renderSkillChipsHtml — visible + deny chips render with names and toggle action attrs', () => {
        const html = mod.renderSkillChipsHtml({
            value: { visible: ['alpha'], deny: ['beta'] },
            availableSkills: [{ name: 'alpha' }, { name: 'beta' }, { name: 'gamma' }],
        });
        expect(html).toContain('alpha');
        expect(html).toContain('beta');
        expect(html).toContain('luker_skill_chip_visible');
        expect(html).toContain('luker_skill_chip_deny');
        expect(html).toContain('data-skill-chip-action="toggle"');
        expect(html).toContain('data-skill-chip-action="remove"');
    });

    test('renderSkillChipsHtml — "+" inherit chip renders distinctly', () => {
        const html = mod.renderSkillChipsHtml({
            value: { visible: ['+', 'alpha'], deny: [] },
            inheritFrom: { visible: ['shared-rule'], deny: [] },
            availableSkills: [{ name: 'shared-rule' }, { name: 'alpha' }],
        });
        expect(html).toContain('luker_skill_chip_inherit');
        // Inherit chip uses its own data attribute value so toggle/remove
        // bind to the sentinel name '+'.
        expect(html).toContain('data-skill-chip-name="+"');
        // Hint text should reference mode default for the inherit chip.
        expect(html).toMatch(/inherit/i);
    });

    test('renderSkillChipsHtml — missing chip gets greyed class and tooltip', () => {
        const html = mod.renderSkillChipsHtml({
            value: { visible: ['ghost-skill'], deny: [] },
            availableSkills: [],
        });
        expect(html).toContain('luker_skill_chip_missing');
        expect(html).toMatch(/title="[^"]*not installed/i);
    });

    test('renderSkillChipsHtml — empty value renders only the add control', () => {
        const html = mod.renderSkillChipsHtml({
            value: { visible: [], deny: [] },
            availableSkills: [{ name: 'a' }],
        });
        expect(html).toContain('data-skill-chip-action="open-add"');
        // No visible/deny chips should be present.
        expect(html).not.toContain('luker_skill_chip_visible');
        expect(html).not.toContain('luker_skill_chip_deny');
    });

    test('renderSkillChipsHtml — agent context exposes inherit-add control', () => {
        // When the chips are mounted on an agent (not mode-level), and the
        // chips do not yet contain '+', the add control should offer an
        // "inherit mode default" entry.
        const html = mod.renderSkillChipsHtml({
            value: { visible: ['method-x'], deny: [] },
            inheritFrom: { visible: ['baseline'], deny: [] },
            availableSkills: [{ name: 'baseline' }, { name: 'method-x' }, { name: 'extra' }],
        });
        expect(html).toContain('data-skill-chip-action="add-inherit"');
    });

    test('renderSkillChipsHtml — when "+" already present, add-inherit is not rendered', () => {
        const html = mod.renderSkillChipsHtml({
            value: { visible: ['+', 'method-x'], deny: [] },
            inheritFrom: { visible: ['baseline'], deny: [] },
            availableSkills: [{ name: 'baseline' }, { name: 'method-x' }],
        });
        expect(html).not.toContain('data-skill-chip-action="add-inherit"');
    });

    test('renderSkillChipsHtml — without inheritFrom (mode-level chips) does not render inherit add', () => {
        const html = mod.renderSkillChipsHtml({
            value: { visible: ['foo'], deny: [] },
            availableSkills: [{ name: 'foo' }],
        });
        // Mode-level chips have no parent to inherit from.
        expect(html).not.toContain('data-skill-chip-action="add-inherit"');
    });

    test('renderSkillChipsHtml — escapes HTML in skill names', () => {
        const html = mod.renderSkillChipsHtml({
            value: { visible: ['<script>'], deny: [] },
            availableSkills: [{ name: '<script>' }],
        });
        expect(html).not.toContain('<script>');
        expect(html).toMatch(/&lt;script&gt;/);
    });
});

describe('skill-chips — mutation helpers', () => {
    let mod;

    beforeEach(async () => {
        mod = await import('../../public/scripts/skills/skill-chips.js');
    });

    test('applyChipToggle — visible→deny moves name to deny list', () => {
        const value = { visible: ['foo'], deny: [] };
        const next = mod.applyChipToggle(value, 'foo');
        expect(next.visible).toEqual([]);
        expect(next.deny).toEqual(['foo']);
    });

    test('applyChipToggle — deny→visible moves name back to visible list', () => {
        const value = { visible: [], deny: ['foo'] };
        const next = mod.applyChipToggle(value, 'foo');
        expect(next.visible).toEqual(['foo']);
        expect(next.deny).toEqual([]);
    });

    test('applyChipToggle — inherit sentinel "+" is a no-op (cannot be toggled to deny)', () => {
        const value = { visible: ['+', 'foo'], deny: [] };
        const next = mod.applyChipToggle(value, '+');
        // Returns either the same object reference OR an equivalent clone.
        expect(next.visible).toEqual(['+', 'foo']);
        expect(next.deny).toEqual([]);
    });

    test('applyChipRemove — removes from visible', () => {
        const value = { visible: ['foo', 'bar'], deny: [] };
        const next = mod.applyChipRemove(value, 'foo');
        expect(next.visible).toEqual(['bar']);
    });

    test('applyChipRemove — removes from deny', () => {
        const value = { visible: [], deny: ['foo', 'bar'] };
        const next = mod.applyChipRemove(value, 'foo');
        expect(next.deny).toEqual(['bar']);
    });

    test('applyChipRemove — removes "+" inherit sentinel from visible', () => {
        const value = { visible: ['+', 'foo'], deny: [] };
        const next = mod.applyChipRemove(value, '+');
        expect(next.visible).toEqual(['foo']);
    });

    test('applyChipAdd — appends to visible by default', () => {
        const value = { visible: ['foo'], deny: [] };
        const next = mod.applyChipAdd(value, 'bar');
        expect(next.visible).toEqual(['foo', 'bar']);
    });

    test('applyChipAdd — appends "+" at the front (canonical position)', () => {
        const value = { visible: ['foo'], deny: [] };
        const next = mod.applyChipAdd(value, '+');
        expect(next.visible[0]).toBe('+');
        expect(next.visible).toContain('foo');
    });

    test('applyChipAdd — duplicate name is a no-op', () => {
        const value = { visible: ['foo'], deny: [] };
        const next = mod.applyChipAdd(value, 'foo');
        expect(next.visible).toEqual(['foo']);
    });

    test('applyChipAdd — normalizes shape on undefined input', () => {
        const next = mod.applyChipAdd(undefined, 'foo');
        expect(next).toEqual({ visible: ['foo'], deny: [] });
    });

    test('applyChipToggle — does not mutate the input object', () => {
        const value = { visible: ['foo'], deny: [] };
        const next = mod.applyChipToggle(value, 'foo');
        expect(value.visible).toEqual(['foo']);
        expect(value.deny).toEqual([]);
        expect(next).not.toBe(value);
    });
});

// ── Integration: mount + click ────────────────────────────────────────────

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
        // Clear before re-parsing so re-renders into the same host don't
        // accumulate stale children (each parse appends via push into the
        // parent passed to parseStubChildren).
        this._children = [];
        parseStubChildren(this._innerHTML, this);
    }
    setAttribute(name, value) { this._attrs.set(String(name), String(value)); }
    getAttribute(name) { return this._attrs.has(String(name)) ? this._attrs.get(String(name)) : null; }
    appendChild(child) {
        child.parentNode = this;
        this._children.push(child);
        return child;
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

describe('mountSkillChips — DOM mount + click delegation', () => {
    let mod, origDoc;

    beforeEach(async () => {
        origDoc = global.document;
        global.document = { createElement: (tag) => new StubElement(tag) };
        mod = await import('../../public/scripts/skills/skill-chips.js');
    });

    afterEach(() => {
        global.document = origDoc;
    });

    test('clicking a visible chip toggles it to deny and calls onChange', () => {
        const host = new StubElement('div');
        const onChange = jest.fn();
        mod.mountSkillChips(host, {
            value: { visible: ['alpha'], deny: [] },
            availableSkills: [{ name: 'alpha' }],
            onChange,
        });
        const chip = host.querySelector('[data-skill-chip-action="toggle"][data-skill-chip-name="alpha"]');
        expect(chip).toBeTruthy();
        chip.click();
        expect(onChange).toHaveBeenCalledTimes(1);
        const next = onChange.mock.calls[0][0];
        expect(next.visible).toEqual([]);
        expect(next.deny).toEqual(['alpha']);
    });

    test('clicking the remove "x" on a chip drops the name from value', () => {
        const host = new StubElement('div');
        const onChange = jest.fn();
        mod.mountSkillChips(host, {
            value: { visible: ['alpha', 'beta'], deny: [] },
            availableSkills: [{ name: 'alpha' }, { name: 'beta' }],
            onChange,
        });
        const removeBtn = host.querySelector('[data-skill-chip-action="remove"][data-skill-chip-name="alpha"]');
        expect(removeBtn).toBeTruthy();
        removeBtn.click();
        expect(onChange).toHaveBeenCalled();
        const next = onChange.mock.calls[0][0];
        expect(next.visible).toEqual(['beta']);
    });

    test('clicking add-inherit appends "+" at the head of visible', () => {
        const host = new StubElement('div');
        const onChange = jest.fn();
        mod.mountSkillChips(host, {
            value: { visible: ['method-x'], deny: [] },
            inheritFrom: { visible: ['baseline'], deny: [] },
            availableSkills: [{ name: 'baseline' }, { name: 'method-x' }],
            onChange,
        });
        const addBtn = host.querySelector('[data-skill-chip-action="add-inherit"]');
        expect(addBtn).toBeTruthy();
        addBtn.click();
        expect(onChange).toHaveBeenCalled();
        const next = onChange.mock.calls[0][0];
        expect(next.visible[0]).toBe('+');
        expect(next.visible).toContain('method-x');
    });

    test('clicking remove on inherit chip drops the "+" sentinel', () => {
        const host = new StubElement('div');
        const onChange = jest.fn();
        mod.mountSkillChips(host, {
            value: { visible: ['+', 'method-x'], deny: [] },
            inheritFrom: { visible: ['baseline'], deny: [] },
            availableSkills: [{ name: 'baseline' }, { name: 'method-x' }],
            onChange,
        });
        const removeBtn = host.querySelector('[data-skill-chip-action="remove"][data-skill-chip-name="+"]');
        expect(removeBtn).toBeTruthy();
        removeBtn.click();
        expect(onChange).toHaveBeenCalled();
        const next = onChange.mock.calls[0][0];
        expect(next.visible).toEqual(['method-x']);
    });

    test('clicking toggle on inherit chip is a no-op (does NOT call onChange)', () => {
        const host = new StubElement('div');
        const onChange = jest.fn();
        mod.mountSkillChips(host, {
            value: { visible: ['+'], deny: [] },
            inheritFrom: { visible: ['baseline'], deny: [] },
            availableSkills: [{ name: 'baseline' }],
            onChange,
        });
        // The inherit chip must not render a toggle action; only a remove.
        const inheritToggle = host.querySelector('[data-skill-chip-action="toggle"][data-skill-chip-name="+"]');
        expect(inheritToggle).toBeNull();
    });
});
