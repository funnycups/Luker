/**
 * Plan 2 Unit 4 — Inline skill editor.
 *
 * Tests cover:
 *   - Pure helpers (parseFrontmatterShape, defaultSkillTemplate,
 *     buildFileTreeHtml, buildEditorHtml, validateNewFilePath)
 *   - Integration scenarios using the same node-stub-DOM pattern as
 *     skill-manager-panel.test.js: load files, save flow w/ sha256,
 *     optimistic-lock conflict, frontmatter parse error blocks save,
 *     create-new-skill flow, file-tree refresh.
 *
 * Luker's Jest config runs in `testEnvironment: "node"` (no jsdom), so we
 * install minimal DOM stubs on globalThis exactly as the manager-panel test
 * does. The editor module is imported lazily inside each test so the stubs
 * are in scope at module-evaluation time.
 */

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';

// ── Pure helper tests ─────────────────────────────────────────────────────

describe('skill-editor — pure helpers', () => {
    let mod;

    beforeEach(async () => {
        mod = await import('../../public/scripts/skills/skill-editor.js');
    });

    test('parseFrontmatterShape: valid SKILL.md returns ok with name+description', () => {
        const md = '---\nname: my_skill\ndescription: does the thing\n---\nbody\n';
        const r = mod.parseFrontmatterShape(md);
        expect(r.ok).toBe(true);
        expect(r.name).toBe('my_skill');
        expect(r.description).toBe('does the thing');
    });

    test('parseFrontmatterShape: missing opening --- returns ok=false', () => {
        const r = mod.parseFrontmatterShape('no frontmatter here');
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/frontmatter/);
    });

    test('parseFrontmatterShape: missing closing --- returns ok=false', () => {
        const r = mod.parseFrontmatterShape('---\nname: foo\n');
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/closed|closing/i);
    });

    test('parseFrontmatterShape: missing name field returns ok=false', () => {
        const r = mod.parseFrontmatterShape('---\ndescription: only desc\n---\nbody');
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/name/);
    });

    test('parseFrontmatterShape: missing description field returns ok=false', () => {
        const r = mod.parseFrontmatterShape('---\nname: foo\n---\nbody');
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/description/);
    });

    test('parseFrontmatterShape: name with illegal characters returns ok=false', () => {
        const r = mod.parseFrontmatterShape('---\nname: BAD NAME\ndescription: desc\n---\nbody');
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/name/);
    });

    test('defaultSkillTemplate: produces a SKILL.md with frontmatter that parses', () => {
        const tpl = mod.defaultSkillTemplate('weather_helper', 'Looks up weather forecasts');
        expect(tpl).toContain('name: weather_helper');
        expect(tpl).toContain('description: Looks up weather forecasts');
        const parsed = mod.parseFrontmatterShape(tpl);
        expect(parsed.ok).toBe(true);
        expect(parsed.name).toBe('weather_helper');
    });

    test('validateNewFilePath: rejects empty, traversal, leading slash, illegal chars', () => {
        expect(mod.validateNewFilePath('').ok).toBe(false);
        expect(mod.validateNewFilePath('../escape.md').ok).toBe(false);
        expect(mod.validateNewFilePath('/absolute.md').ok).toBe(false);
        expect(mod.validateNewFilePath('weird:name').ok).toBe(false);
        expect(mod.validateNewFilePath('SKILL.md').ok).toBe(false); // can't overwrite SKILL.md as 'new'
    });

    test('validateNewFilePath: accepts well-formed paths', () => {
        expect(mod.validateNewFilePath('references/note.md').ok).toBe(true);
        expect(mod.validateNewFilePath('scripts/run.py').ok).toBe(true);
        expect(mod.validateNewFilePath('a-b_c.txt').ok).toBe(true);
    });

    test('buildFileTreeHtml: lists files with the active one marked', () => {
        const files = [
            { path: 'SKILL.md', size: 100, isBinary: false },
            { path: 'references/note.md', size: 40, isBinary: false },
        ];
        const html = mod.buildFileTreeHtml({
            files,
            activePath: 'references/note.md',
            t: (s) => s,
            esc: (s) => String(s),
        });
        expect(html).toContain('SKILL.md');
        expect(html).toContain('references/note.md');
        expect(html).toMatch(/data-file-active="true"[^>]*data-file-path="references\/note\.md"|data-file-path="references\/note\.md"[^>]*data-file-active="true"/);
        // The "+ New file" action should be present somewhere in the tree
        expect(html).toMatch(/data-editor-action="new-file"/);
    });

    test('buildFileTreeHtml: non-SKILL.md files get both rename and delete actions', () => {
        const files = [
            { path: 'SKILL.md', size: 100, isBinary: false },
            { path: 'notes.md', size: 40, isBinary: false },
        ];
        const html = mod.buildFileTreeHtml({
            files,
            activePath: 'SKILL.md',
            t: (s) => s,
            esc: (s) => String(s),
        });
        // Rename + delete glyphs for the non-manifest file
        expect(html).toMatch(/data-editor-action="rename-file"[^>]*data-file-path="notes\.md"/);
        expect(html).toMatch(/data-editor-action="delete-file"[^>]*data-file-path="notes\.md"/);
        // SKILL.md never gets rename/delete (server enforces both rejections).
        // No occurrence of the rename/delete actions paired with SKILL.md.
        expect(html).not.toMatch(/data-editor-action="rename-file"[^>]*data-file-path="SKILL\.md"/);
        expect(html).not.toMatch(/data-editor-action="delete-file"[^>]*data-file-path="SKILL\.md"/);
    });

    test('buildEditorHtml: textarea is present and pre-filled', () => {
        const html = mod.buildEditorHtml({
            content: 'hello world',
            path: 'SKILL.md',
            sha256: 'abc',
            t: (s) => s,
            esc: (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]),
        });
        expect(html).toContain('hello world');
        expect(html).toContain('data-editor-save');
        expect(html).toMatch(/textarea/);
    });

    test('buildEditorHtml: empty state when no path is selected', () => {
        const html = mod.buildEditorHtml({
            content: '',
            path: null,
            sha256: '',
            t: (s) => s,
            esc: (s) => String(s),
        });
        // No save button when no file is open
        expect(html).not.toContain('data-editor-save');
    });
});

// ── Integration tests with stub DOM ───────────────────────────────────────

/**
 * Compact StubElement compatible with skill-manager-panel.test.js' stub.
 * Implements innerHTML parsing, addEventListener, click(), querySelector(All),
 * matches() with attribute-and-pseudo grammar, and closest().
 */
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
        this.selectionStart = 0;
        this.selectionEnd = 0;
        this.files = null;
        this.parentNode = null;
        this.focus = jest.fn();
    }
    get innerHTML() { return this._innerHTML; }
    set innerHTML(html) {
        this._innerHTML = String(html);
        this._children = parseStubChildren(this._innerHTML, this);
    }
    setAttribute(name, value) { this._attrs.set(String(name), String(value)); }
    getAttribute(name) { return this._attrs.has(String(name)) ? this._attrs.get(String(name)) : null; }
    appendChild(child) { child.parentNode = this; this._children.push(child); return child; }
    removeChild(child) {
        const i = this._children.indexOf(child);
        if (i >= 0) { this._children.splice(i, 1); child.parentNode = null; }
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
        // Mirror the manager-panel test's "array-like" return so callers can
        // .forEach + spread. Do NOT mutate `out` itself with [Symbol.iterator] —
        // that overwrites the native Array iterator and recurses forever.
        const arrayIter = out[Symbol.iterator].bind(out);
        return {
            length: out.length,
            forEach(cb) { for (const e of out) cb(e); },
            [Symbol.iterator]() { return arrayIter(); },
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
    click() { this.dispatchEvent({ type: 'click', preventDefault() {}, stopPropagation() {} }); }
}

function unescapeHtml(s) {
    return String(s ?? '')
        .replace(/&quot;/g, '"').replace(/&#39;/g, '\'')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

function parseStubChildren(html, parent) {
    // Reset parent's children before re-parsing — innerHTML setters in real
    // DOM replace children outright, but our naive push-based parser would
    // append-only without this reset, leaving stale elements alive.
    parent._children = [];
    const VOID_TAGS = new Set(['input', 'br', 'img', 'hr', 'meta']);
    const tokenRe = /<(\/?)([a-z][a-z0-9]*)\b([^>]*?)(\/?)>/gi;
    const stack = [parent];
    let lastIndex = 0;
    let m;
    while ((m = tokenRe.exec(html))) {
        // Capture any text content (textareas need this so .value is restored
        // from the body of <textarea>...</textarea>)
        const textContent = html.slice(lastIndex, m.index);
        if (textContent && stack[stack.length - 1].tagName === 'TEXTAREA') {
            stack[stack.length - 1]._textContent = (stack[stack.length - 1]._textContent || '') + textContent;
        }
        lastIndex = tokenRe.lastIndex;

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
    // Lift textarea text content into .value
    const visit = (n) => {
        if (n.tagName === 'TEXTAREA' && typeof n._textContent === 'string') {
            n.value = unescapeHtml(n._textContent);
        }
        for (const c of n._children || []) visit(c);
    };
    visit(parent);
    return parent._children;
}

class StubDocument {
    constructor() {
        this.body = new StubElement('body');
        this._byId = new Map();
    }
    createElement(tag) { return new StubElement(tag); }
    getElementById(id) { return this._byId.get(id) || null; }
    register(id, el) { this._byId.set(id, el); el._attrs.set('id', id); }
    querySelector(sel) { return this.body.querySelector(sel); }
    addEventListener() {}
}

function makeStubContext({ files = [], readContent = '---\nname: x\ndescription: y\n---\n', readSha = 'sha-initial', scenarios = {} } = {}) {
    const popupCalls = [];
    const skillsApi = {
        list: jest.fn(async () => []),
        listFiles: jest.fn(async () => ({ files: files.slice() })),
        readFile: jest.fn(async () => ({ content: readContent, sha256: readSha, totalLines: readContent.split('\n').length, truncated: false })),
        writeFile: jest.fn(async () => ({ sha256: 'sha-after-write' })),
        editFile: jest.fn(async () => ({ sha256: 'sha-after-edit', changesApplied: 1 })),
        deleteFile: jest.fn(async () => null),
        install: jest.fn(async () => ({ action: 'installed', name: 'new_skill' })),
        delete: jest.fn(async () => null),
    };
    const POPUP_TYPE = { TEXT: 1, CONFIRM: 2, INPUT: 3, DISPLAY: 4 };
    const POPUP_RESULT = { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null };
    const callGenericPopup = jest.fn((content, type) => {
        popupCalls.push({ content, type });
        if (type === POPUP_TYPE.TEXT) {
            // Editor popup itself — never resolves during tests.
            return new Promise(() => {});
        }
        const handler = scenarios[type === POPUP_TYPE.CONFIRM ? 'confirm' : 'input'];
        if (handler) return Promise.resolve(handler(content));
        return Promise.resolve(null);
    });
    return {
        skills: skillsApi,
        callGenericPopup,
        POPUP_TYPE,
        POPUP_RESULT,
        Popup: class StubPopup {
            constructor(html, type, _val, opts) {
                this.html = html; this.type = type; this.opts = opts;
                this.result = POPUP_RESULT.CANCELLED;
                this.dlg = new StubElement('div');
                this.dlg.innerHTML = html;
            }
            async show() {
                return scenarios.popupShow ? await scenarios.popupShow(this) : POPUP_RESULT.CANCELLED;
            }
        },
        __popupCalls: popupCalls,
        __skillsApi: skillsApi,
    };
}

describe('openSkillEditor — integration scenarios', () => {
    let origDoc, origToastr;

    // eslint-disable-next-line playwright/no-duplicate-hooks
    beforeEach(() => {
        origDoc = global.document;
        origToastr = global.toastr;
        global.document = new StubDocument();
        global.toastr = { info: jest.fn(), success: jest.fn(), error: jest.fn() };
    });

    // eslint-disable-next-line playwright/no-duplicate-hooks
    afterEach(() => {
        global.document = origDoc;
        global.toastr = origToastr;
    });

    async function bootstrap({ scope = { kind: 'global' }, name = 'demo', ctxOpts = {}, mode = 'edit' } = {}) {
        const { openSkillEditor } = await import('../../public/scripts/skills/skill-editor.js');
        const ctx = makeStubContext(ctxOpts);
        const stub = new StubElement('div');
        // The editor module computes a mountId with Date.now(); intercept any
        // luker_skill_editor_* lookup and return the same stub.
        const origGetById = global.document.getElementById.bind(global.document);
        global.document.getElementById = function (id) {
            const cached = origGetById(id);
            if (cached) return cached;
            if (String(id).startsWith('luker_skill_editor_')) return stub;
            return null;
        };
        const promise = openSkillEditor({ context: ctx, scope, name, mode });
        for (let i = 0; i < 6; i++) await Promise.resolve();
        return { ctx, mount: stub, promise };
    }

    test('initial render: listFiles is called and tree shows every file', async () => {
        const files = [
            { path: 'SKILL.md', size: 50, isBinary: false },
            { path: 'references/notes.md', size: 12, isBinary: false },
        ];
        const { ctx, mount } = await bootstrap({ ctxOpts: { files } });
        expect(ctx.__skillsApi.listFiles).toHaveBeenCalledTimes(1);
        expect(mount.innerHTML).toContain('SKILL.md');
        expect(mount.innerHTML).toContain('references/notes.md');
    });

    test('clicking a file in the tree loads its content into the textarea', async () => {
        const files = [
            { path: 'SKILL.md', size: 50, isBinary: false },
            { path: 'references/notes.md', size: 12, isBinary: false },
        ];
        const { ctx, mount } = await bootstrap({
            ctxOpts: {
                files,
                readContent: '---\nname: demo\ndescription: d\n---\noriginal body\n',
            },
        });
        // SKILL.md should be auto-loaded on initial render.
        expect(ctx.__skillsApi.readFile).toHaveBeenCalledTimes(1);
        expect(ctx.__skillsApi.readFile.mock.calls[0][0].path).toBe('SKILL.md');

        // Click the references/notes.md row. Note the file tree contains both
        // a row element AND a delete-x span carrying data-file-path; we skip
        // the delete glyph and pick the row.
        const fileButtons = mount.querySelectorAll('[data-file-path]');
        let target = null;
        for (const btn of fileButtons) {
            // eslint-disable-next-line playwright/no-conditional-in-test
            if (btn.getAttribute('data-editor-action') === 'delete-file') continue;
            // eslint-disable-next-line playwright/no-conditional-in-test
            if (btn.getAttribute('data-file-path') === 'references/notes.md') {
                target = btn; break;
            }
        }
        expect(target).toBeTruthy();
        // Set up read mock to return new content for the second call.
        ctx.__skillsApi.readFile.mockImplementationOnce(async () => ({
            content: 'NOTES BODY',
            sha256: 'sha-notes',
            totalLines: 1,
            truncated: false,
        }));
        target.click();
        for (let i = 0; i < 6; i++) await Promise.resolve();

        // The second readFile call should target the new path.
        expect(ctx.__skillsApi.readFile).toHaveBeenCalledTimes(2);
        expect(ctx.__skillsApi.readFile.mock.calls[1][0].path).toBe('references/notes.md');
        // The editor's textarea must now show NOTES BODY.
        const textarea = mount.querySelector('textarea');
        expect(textarea).toBeTruthy();
        expect(textarea.value).toContain('NOTES BODY');
    });

    test('save flow: writeFile called with expectedSha256 from initial read', async () => {
        const files = [{ path: 'SKILL.md', size: 50, isBinary: false }];
        const { ctx, mount } = await bootstrap({
            ctxOpts: {
                files,
                readContent: '---\nname: demo\ndescription: d\n---\nbody\n',
                readSha: 'sha-from-server',
            },
        });

        // Simulate user typing into the textarea.
        const textarea = mount.querySelector('textarea');
        expect(textarea).toBeTruthy();
        textarea.value = '---\nname: demo\ndescription: d\n---\nupdated body\n';

        const saveBtn = mount.querySelector('[data-editor-save]');
        expect(saveBtn).toBeTruthy();
        saveBtn.click();
        for (let i = 0; i < 6; i++) await Promise.resolve();

        expect(ctx.__skillsApi.writeFile).toHaveBeenCalledTimes(1);
        const args = ctx.__skillsApi.writeFile.mock.calls[0][0];
        expect(args.path).toBe('SKILL.md');
        expect(args.expectedSha256).toBe('sha-from-server');
        expect(args.content).toContain('updated body');
        expect(global.toastr.success).toHaveBeenCalled();
    });

    test('optimistic-lock conflict: sha256 mismatch error surfaces to the user', async () => {
        const files = [{ path: 'SKILL.md', size: 50, isBinary: false }];
        const { ctx, mount } = await bootstrap({
            ctxOpts: {
                files,
                readContent: '---\nname: demo\ndescription: d\n---\nbody\n',
            },
        });
        // Make writeFile throw a sha256-mismatch-shaped error.
        const conflict = new Error('sha256 mismatch (expected sha-server, got sha-other)');
        conflict.status = 409;
        ctx.__skillsApi.writeFile.mockRejectedValueOnce(conflict);

        const textarea = mount.querySelector('textarea');
        textarea.value = '---\nname: demo\ndescription: d\n---\nbody\n';
        mount.querySelector('[data-editor-save]').click();
        for (let i = 0; i < 6; i++) await Promise.resolve();

        // User should see an error toast referencing the mismatch.
        expect(global.toastr.error).toHaveBeenCalled();
        const msg = global.toastr.error.mock.calls[0][0];
        expect(String(msg)).toMatch(/sha256|mismatch|changed/i);
    });

    test('frontmatter parse error blocks save for SKILL.md', async () => {
        const files = [{ path: 'SKILL.md', size: 50, isBinary: false }];
        const { ctx, mount } = await bootstrap({
            ctxOpts: { files },
        });
        // Replace the SKILL.md body with malformed frontmatter.
        const textarea = mount.querySelector('textarea');
        textarea.value = 'no frontmatter at all\n';

        mount.querySelector('[data-editor-save]').click();
        for (let i = 0; i < 6; i++) await Promise.resolve();

        // writeFile must NOT have been called.
        expect(ctx.__skillsApi.writeFile).not.toHaveBeenCalled();
        // User must see an error.
        expect(global.toastr.error).toHaveBeenCalled();
    });

    test('non-SKILL.md files can save with arbitrary content (no frontmatter check)', async () => {
        const files = [
            { path: 'SKILL.md', size: 50, isBinary: false },
            { path: 'references/notes.md', size: 12, isBinary: false },
        ];
        const { ctx, mount } = await bootstrap({ ctxOpts: { files } });
        // Switch to the notes file
        const fileButtons = mount.querySelectorAll('[data-file-path]');
        let target = null;
        for (const btn of fileButtons) {
            // eslint-disable-next-line playwright/no-conditional-in-test
            if (btn.getAttribute('data-file-path') === 'references/notes.md') {
                target = btn; break;
            }
        }
        ctx.__skillsApi.readFile.mockImplementationOnce(async () => ({ content: 'plain text', sha256: 'n1', totalLines: 1, truncated: false }));
        target.click();
        for (let i = 0; i < 6; i++) await Promise.resolve();

        const textarea = mount.querySelector('textarea');
        textarea.value = 'arbitrary content without frontmatter\n';
        mount.querySelector('[data-editor-save]').click();
        for (let i = 0; i < 6; i++) await Promise.resolve();

        expect(ctx.__skillsApi.writeFile).toHaveBeenCalledTimes(1);
        expect(ctx.__skillsApi.writeFile.mock.calls[0][0].path).toBe('references/notes.md');
    });

    test('create-new-skill flow: install is called with a SKILL.md template', async () => {
        const { openCreateNewSkillFlow } = await import('../../public/scripts/skills/skill-editor.js');
        const ctx = makeStubContext({
            scenarios: {
                input: (content) => {
                    // First INPUT prompt is the name, second is the description (or
                    // a combined single prompt — implementation decides).
                    if (String(content).match(/name/i)) return 'fresh_skill';
                    return 'A freshly created skill';
                },
                popupShow: async (popup) => {
                    // Scope picker — default to global.
                    const dlg = popup.dlg;
                    const radios = dlg.querySelectorAll('[name="luker_skill_scope_kind"]');
                    for (const r of radios) {
                        r.checked = (r._attrs.get('value') === 'global');
                    }
                    if (popup.opts && typeof popup.opts.onClosing === 'function') {
                        const r = popup.opts.onClosing({ result: 1, dlg });
                        if (r === false) return 0;
                    }
                    return 1;
                },
            },
        });
        await openCreateNewSkillFlow({ context: ctx });
        for (let i = 0; i < 10; i++) await Promise.resolve();

        expect(ctx.__skillsApi.install).toHaveBeenCalledTimes(1);
        const payload = ctx.__skillsApi.install.mock.calls[0][0];
        expect(payload.scope.kind).toBe('global');
        const files = payload.payload.files;
        const skillMd = files.find(f => f.path === 'SKILL.md');
        expect(skillMd).toBeTruthy();
        expect(skillMd.content).toContain('name: fresh_skill');
        expect(skillMd.content).toContain('description: A freshly created skill');
    });

    test('file-tree refresh after new-file creation', async () => {
        let filesNow = [{ path: 'SKILL.md', size: 50, isBinary: false }];
        const { openSkillEditor } = await import('../../public/scripts/skills/skill-editor.js');
        const ctx = makeStubContext({ files: filesNow });
        // Override listFiles to track dynamic state
        ctx.__skillsApi.listFiles.mockImplementation(async () => ({ files: filesNow.slice() }));
        const stub = new StubElement('div');
        const origGetById = global.document.getElementById.bind(global.document);
        global.document.getElementById = function (id) {
            const cached = origGetById(id);
            // eslint-disable-next-line playwright/no-conditional-in-test
            if (cached) return cached;
            // eslint-disable-next-line playwright/no-conditional-in-test
            if (String(id).startsWith('luker_skill_editor_')) return stub;
            return null;
        };
        // Drive an input prompt for the new file path.
        ctx.scenarios = { input: () => 'references/added.md' };
        ctx.callGenericPopup.mockImplementation((content, type) => {
            ctx.__popupCalls.push({ content, type });
            if (type === ctx.POPUP_TYPE.TEXT) return new Promise(() => {});
            if (type === ctx.POPUP_TYPE.INPUT) return Promise.resolve('references/added.md');
            return Promise.resolve(1);
        });

        openSkillEditor({ context: ctx, scope: { kind: 'global' }, name: 'demo', mode: 'edit' });
        for (let i = 0; i < 6; i++) await Promise.resolve();

        // Click "+ New file" action
        const newFileBtn = stub.querySelector('[data-editor-action="new-file"]');
        expect(newFileBtn).toBeTruthy();
        // After the new file is created, listFiles will return the new file too.
        ctx.__skillsApi.writeFile.mockImplementationOnce(async (opts) => {
            filesNow = [...filesNow, { path: opts.path, size: opts.content.length, isBinary: false }];
            return { sha256: 'sha-new' };
        });
        newFileBtn.click();
        for (let i = 0; i < 12; i++) await Promise.resolve();

        expect(ctx.__skillsApi.writeFile).toHaveBeenCalledTimes(1);
        expect(ctx.__skillsApi.writeFile.mock.calls[0][0].path).toBe('references/added.md');
        // After write, listFiles should have been re-invoked at least once.
        expect(ctx.__skillsApi.listFiles.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
});
