/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect, beforeEach, jest } from '@jest/globals';

import { commitFields, fieldPlan, saveSettingsChecked } from '../../public/scripts/workbench/model/patch.js';
import { approvalMatches, diffUnits } from '../../public/scripts/workbench/model/units.js';
import { createHistory } from '../../public/scripts/workbench/model/history.js';
import { buildBudget, budgetNote } from '../../public/scripts/workbench/model/budget.js';
import { renderMarkdown } from '../../public/scripts/workbench/ui/markdown.js';
import { changeList } from '../../public/scripts/workbench/ui/change-list.js';
import { createMemoryStorage } from '../../public/scripts/run-panel/recorder.js';

function itemUnits(list) {
    return new Map((list || []).map(item => [String(item.id), {
        key: String(item.id),
        label: item.label || String(item.id),
        group: item.group || 'Items',
        text: String(item.text || ''),
        fields: { ...item },
        hidden: item.hidden || {},
    }]));
}

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

function applyItemOps(list, ops) {
    let next = clone(list);
    for (const op of ops) {
        if (op.kind === 'remove') {
            next = next.filter(item => String(item.id) !== op.key);
            continue;
        }
        let item = next.find(x => String(x.id) === op.key);
        if (!item) {
            item = { id: op.key };
            next.push(item);
        }
        for (const c of op.changes) {
            if (c.after === undefined) delete item[c.field];
            else item[c.field] = clone(c.after);
        }
    }
    return next;
}

function makeIo(stored) {
    return {
        read: async () => clone(stored.body),
        units: itemUnits,
        apply: applyItemOps,
        write: async (body) => { stored.body = body; },
    };
}

beforeEach(() => {
    document.body.innerHTML = '';
    globalThis.toastr = { error: jest.fn(), warning: jest.fn(), info: jest.fn() };
    jest.restoreAllMocks();
});

test('approving one field keeps a parallel edit of another', async () => {
    const base = [{ id: 'settings', temperature: 0.5, top_p: 1 }];
    const ai = [{ id: 'settings', temperature: 0.8, top_p: 1 }];
    const stored = { body: [{ id: 'settings', temperature: 0.5, top_p: 0.6 }] };
    const handle = await commitFields(makeIo(stored), fieldPlan(itemUnits(base), itemUnits(ai), ['settings']));
    expect(stored.body[0].temperature).toBe(0.8);
    expect(stored.body[0].top_p).toBe(0.6);
    await handle.undo();
    expect(stored.body[0].temperature).toBe(0.5);
    expect(stored.body[0].top_p).toBe(0.6);
});

test('a change only in a hidden field is surfaced in diffUnits', () => {
    const base = [{ id: 'w1', label: 'Rule', text: 'a', hidden: { order: 5 } }];
    const ai = [{ id: 'w1', label: 'Rule', text: 'a', hidden: { order: 99 } }];
    const [change] = diffUnits(itemUnits(base), itemUnits(ai));
    expect(change.key).toBe('w1');
    expect(change.before).toMatch(/order: 5/);
    expect(change.after).toMatch(/order: 99/);
});

test('two independent commits from one baseline both survive', async () => {
    const base = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }];
    const stored = { body: clone(base) };
    const io = makeIo(stored);
    const one = [{ id: 'a', label: 'A1' }, base[1]];
    const two = [base[0], { id: 'b', label: 'B2' }];
    await commitFields(io, fieldPlan(itemUnits(base), itemUnits(one), ['a']));
    await commitFields(io, fieldPlan(itemUnits(base), itemUnits(two), ['b']));
    expect(stored.body.map(s => s.label)).toEqual(['A1', 'B2']);
});

test('a field changed elsewhere since the proposal is a conflict', async () => {
    const base = [{ id: 's', temperature: 0.5 }];
    const ai = [{ id: 's', temperature: 0.8 }];
    const stored = { body: [{ id: 's', temperature: 0.7 }] };
    const ops = fieldPlan(itemUnits(base), itemUnits(ai), ['s']);
    await expect(commitFields(makeIo(stored), ops)).rejects.toMatchObject({ code: 'conflict' });
    expect(stored.body[0].temperature).toBe(0.7);
});

test('missing target leaves undo failing and history entry not undone', async () => {
    const base = [{ id: 's', temperature: 0.5 }];
    const ai = [{ id: 's', temperature: 0.8 }];
    const stored = { body: clone(base) };
    const handle = await commitFields(makeIo(stored), fieldPlan(itemUnits(base), itemUnits(ai), ['s']));
    const history = createHistory(createMemoryStorage());
    const id = history.record({ ws: 'preset', title: 't', undo: handle.undo });
    const body = stored.body;
    stored.body = null;
    await expect(history.undo(id)).rejects.toThrow();
    expect(history.list()[0].undone).toBe(false);
    expect(history.canUndo(id)).toBe(true);
    stored.body = body;
    await history.undo(id);
    expect(history.list()[0].undone).toBe(true);
});

test('saveSettingsChecked fails if onSaved never fires and succeeds when onSaved fires', async () => {
    await expect(saveSettingsChecked({ saveSettings: async () => {} })).rejects.toMatchObject({ code: 'write-failed' });
    await expect(saveSettingsChecked({ saveSettings: async (_, options) => options.onSaved() })).resolves.toBeUndefined();
});

test('writeExtensionField with requireSaved keeps in-memory character unmutated on server failure and mutates + mirrors on success', async () => {
    const mockContext = {
        characterId: 0,
        characters: [],
    };
    const noop = () => {};

    jest.unstable_mockModule('fflate', () => ({
        gzipSync: (x) => x,
        gzip: (x, cb) => cb?.(null, x),
    }));
    jest.unstable_mockModule('../../public/scripts/utils.js', () => ({
        delay: async () => {},
        equalsIgnoreCaseAndAccents: (a, b) => a === b,
        escapeHtml: (s) => String(s ?? ''),
        isSubsetOf: () => false,
        sanitizeSelector: (s) => s,
        versionCompare: () => 0,
        setValueByPath: (obj, path, val) => {
            const parts = String(path).split('.');
            let cur = obj;
            for (let i = 0; i < parts.length - 1; i++) {
                if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
                cur = cur[parts[i]];
            }
            cur[parts[parts.length - 1]] = val;
        },
        deleteValueByPath: (obj, path) => {
            const parts = String(path).split('.');
            let cur = obj;
            for (let i = 0; i < parts.length - 1; i++) {
                if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') return;
                cur = cur[parts[i]];
            }
            delete cur[parts[parts.length - 1]];
        },
    }));
    jest.unstable_mockModule('../../public/script.js', () => ({
        eventSource: { on: noop, off: noop, emit: async () => {} },
        event_types: {},
        saveSettings: async () => {},
        saveSettingsDebounced: noop,
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        animation_duration: 0,
        EXTENSIONS_CLIENT_VERSION: '1.0.0',
        buildObjectPatchOperationsAsync: async () => [],
        buildObjectPatchOperations: () => [],
        cloneAsJsonWire: (v) => clone(v),
        ensureFullSettingsLoaded: async () => {},
    }));
    jest.unstable_mockModule('../../public/scripts/st-context.js', () => ({
        getContext: () => mockContext,
    }));
    jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
        POPUP_RESULT: {},
        POPUP_TYPE: {},
        Popup: class {},
        callGenericPopup: async () => {},
    }));
    jest.unstable_mockModule('../../public/scripts/templates.js', () => ({
        renderTemplate: async () => '',
        renderTemplateAsync: async () => '',
    }));
    jest.unstable_mockModule('../../public/scripts/user.js', () => ({
        isAdmin: () => false,
    }));
    jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
        addLocaleData: noop,
        getCurrentLocale: () => 'en',
        t: (strings, ...values) => String.raw(strings, ...values),
    }));
    jest.unstable_mockModule('../../public/scripts/util/AccountStorage.js', () => ({
        accountStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    }));
    jest.unstable_mockModule('../../public/scripts/state-resource.js', () => ({
        invalidateStateResources: noop,
        readStateEnvelope: async () => ({ ok: true, state: null }),
    }));

    const { writeExtensionField } = await import('../../public/scripts/extensions.js');

    const jsonInput = document.createElement('input');
    jsonInput.id = 'character_json_data';
    document.body.appendChild(jsonInput);
    const prevDollar = globalThis.$;
    globalThis.$ = (sel) => {
        const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
        return {
            val: (next) => {
                if (next !== undefined) {
                    if (el) el.value = next;
                    return undefined;
                }
                return el?.value ?? '';
            },
        };
    };

    const initialJson = JSON.stringify({ data: { extensions: { existing: 'keep' } } });
    const character = {
        avatar: 'Aqua.png',
        data: { extensions: { existing: 'keep' } },
        json_data: initialJson,
    };
    mockContext.characters = [character];
    mockContext.characterId = 0;
    jsonInput.value = initialJson;

    const prevFetch = globalThis.fetch;
    try {
        // 1. Server fails -> rejects, and neither character.data.extensions nor character.json_data nor DOM is mutated
        globalThis.fetch = jest.fn(async () => ({ ok: false, status: 500, statusText: 'Server Error' }));
        await expect(writeExtensionField(0, 'wb_test', { count: 1 }, { requireSaved: true }))
            .rejects.toThrow('Failed to save extension field (500): Server Error');
        expect(character.data.extensions.wb_test).toBeUndefined();
        expect(character.data.extensions.existing).toBe('keep');
        expect(character.json_data).toBe(initialJson);
        expect(jsonInput.value).toBe(initialJson);

        // 2. Missing character -> rejects
        await expect(writeExtensionField(99, 'wb_test', { count: 1 }, { requireSaved: true }))
            .rejects.toThrow('Character not found');

        // 3. Server succeeds -> mutates character.data.extensions, character.json_data, and mirrors #character_json_data
        globalThis.fetch = jest.fn(async () => ({ ok: true, status: 200, statusText: 'OK' }));
        await writeExtensionField(0, 'wb_test', { count: 2 }, { requireSaved: true });
        expect(character.data.extensions.wb_test).toEqual({ count: 2 });
        expect(JSON.parse(character.json_data).data.extensions.wb_test).toEqual({ count: 2 });
        expect(JSON.parse(jsonInput.value).data.extensions.wb_test).toEqual({ count: 2 });

        // 4. Undefined avatars must not spuriously mirror to #character_json_data
        const avatarless = {
            data: { extensions: {} },
            json_data: JSON.stringify({ data: { extensions: {} } }),
        };
        mockContext.characters = [avatarless];
        jsonInput.value = 'untouched';
        await writeExtensionField(0, 'wb_test', { count: 3, gone: '__@@UNSET@@__', items: [{ id: 1, stale: '__@@UNSET@@__' }] }, { requireSaved: true });
        expect(avatarless.data.extensions.wb_test).toEqual({ count: 3, items: [{ id: 1 }] });
        expect(JSON.parse(avatarless.json_data).data.extensions.wb_test).toEqual({ count: 3, items: [{ id: 1 }] });
        expect(jsonInput.value).toBe('untouched');
    } finally {
        globalThis.fetch = prevFetch;
        globalThis.$ = prevDollar;
    }
});

test('approval compares the full proposal even when the stored text was shortened', () => {
    const [full] = diffUnits(
        itemUnits([{ id: 'desc', text: 'a'.repeat(50) }]),
        itemUnits([{ id: 'desc', text: 'b'.repeat(50) }]),
    );
    const stored = [{ ...full, after: 'b' }];
    expect(approvalMatches(stored, [full], [full.key])).toBe(true);
    expect(approvalMatches(stored, [{ ...full, sig: 'other' }], [full.key])).toBe(false);
});

test('history.js surfaces localStorage quota errors and preserves existing stored entries', () => {
    const backing = createMemoryStorage();
    let throwQuota = false;
    const quotaStorage = {
        getItem: (k) => backing.getItem(k),
        setItem: (k, v) => {
            if (throwQuota) {
                throw new DOMException('Quota exceeded', 'QuotaExceededError');
            }
            backing.setItem(k, v);
        },
        removeItem: (k) => backing.removeItem(k),
    };

    const errors = [];
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const history = createHistory(quotaStorage, { onError: (err) => errors.push(err) });
    history.record({ ws: 'memory', title: 'first' });
    const snapshotBeforeQuota = backing.getItem('workbench.history.v1');
    expect(JSON.parse(snapshotBeforeQuota)).toHaveLength(1);

    throwQuota = true;
    let notified = 0;
    history.subscribe(() => { notified += 1; });
    history.record({ ws: 'memory', title: 'second' });

    expect(errors).toHaveLength(1);
    expect(errors[0].type).toBe('quota');
    expect(history.getStorageError()?.type).toBe('quota');
    expect(consoleSpy).toHaveBeenCalled();
    expect(globalThis.toastr.error).toHaveBeenCalled();
    expect(notified).toBe(1);
    expect(backing.getItem('workbench.history.v1')).toBe(snapshotBeforeQuota);
});

test('history.js surfaces corrupted JSON and never overwrites existing storage', () => {
    const backing = createMemoryStorage();
    backing.setItem('workbench.history.v1', '{broken json!');
    const errors = [];
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const history = createHistory(backing, { onError: (err) => errors.push(err) });
    expect(errors).toHaveLength(1);
    expect(errors[0].type).toBe('parse');
    expect(history.getStorageError()?.type).toBe('parse');
    expect(consoleSpy).toHaveBeenCalled();
    expect(globalThis.toastr.error).toHaveBeenCalled();

    history.record({ ws: 'preset', title: 'attempt' });
    expect(backing.getItem('workbench.history.v1')).toBe('{broken json!');
});

test('budget, markdown, and change-list render safely without innerHTML', () => {
    const budget = buildBudget({
        this_main_api: 'openai',
        finalPromptTokens: 2000,
        thisPrompt_max_context: 4000,
        oaiPromptTokens: 800,
        charDescriptionTokens: 200,
        worldInfoStringTokens: 500,
        ActualChatHistoryTokens: 700,
    }, { memory: 300 });
    expect(budget.total).toBe(2000);
    expect(budget.parts.find(p => p.key === 'memory')?.tokens).toBe(300);
    expect(budget.parts.find(p => p.key === 'world')?.tokens).toBe(200);
    expect(budgetNote(budget, [100, 100, 100, 100, 100])).toBe('');

    const md = renderMarkdown('# Heading\n\n<script>alert(1)</script> **bold** `code`\n\n- item 1');
    expect(md.querySelector('script')).toBeNull();
    expect(md.querySelector('b')?.textContent).toBe('bold');
    expect(md.querySelector('code')?.textContent).toBe('code');

    const chg = changeList({
        changes: [{ key: 'k1', kind: 'change', label: 'Field', group: '', before: 'old', after: 'new' }],
        onApply: () => {},
        onDiscard: () => {},
    });
    expect(chg.el.querySelector('.lw-btn.is-primary')).not.toBeNull();
    expect(chg.el.querySelector('.lw-check')).not.toBeNull();
});
