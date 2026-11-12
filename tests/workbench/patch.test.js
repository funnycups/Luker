/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

test('script.js and extensions.js expose save-ack plumbing', () => {
    const scriptSrc = readFileSync(fileURLToPath(new URL('../../public/script.js', import.meta.url)), 'utf8');
    expect(scriptSrc).toContain('baseOptions?.onSaved?.()');
    expect(scriptSrc).toContain('overrideOptions?.onSaved?.()');
    expect(scriptSrc).toContain('options.onSaved?.()');
    expect(scriptSrc).toContain('initWorkbench');

    const extSrc = readFileSync(fileURLToPath(new URL('../../public/scripts/extensions.js', import.meta.url)), 'utf8');
    expect(extSrc).toContain('requireSaved = false');
    expect(extSrc).toContain('if (requireSaved) updateLocalCharacter();');
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
