import { describe, test, expect } from '@jest/globals';

import { renderGeneric } from '../../src/sync/conflict-diff/generic.js';
import { maskSecretsDocument, renderSecrets } from '../../src/sync/conflict-diff/secrets.js';
import { renderText } from '../../src/sync/conflict-diff/text.js';
import { createBuilder } from '../../src/sync/conflict-diff/tree.js';
import { cellPage } from '../../src/sync/conflict-diff/values.js';

function build(render, left, right, options) {
    const builder = createBuilder();
    const sections = render(left, right, builder, options);
    return builder.finalize(sections);
}

const section = (sections, label) => sections.find(item => item.label === label);
const item = (parent, label) => parent.children.find(child => child.label === label);

describe('secret conflict renderer', () => {
    test('masks values and keeps ids, labels and active flags', () => {
        const masked = maskSecretsDocument({
            api_key_openai: 'sk-openai-secret',
            api_key_custom: [{ id: 'one', value: 'sk-custom-secret', label: 'Desk key', active: true }],
        });
        expect(masked.api_key_openai).toBe('********cret');
        expect(masked.api_key_custom[0]).toMatchObject({ id: 'one', label: 'Desk key', active: true, value: '********cret' });
    });

    test('never puts plaintext into the view or the value resolver', () => {
        const left = { api_key_custom: [{ id: 'one', value: 'sk-left-secret', label: 'left label', active: true }] };
        const right = { api_key_custom: [{ id: 'one', value: 'sk-right-secret', label: 'right label', active: false }] };
        const { sections, values } = build(renderSecrets, left, right);
        expect(JSON.stringify(sections)).not.toContain('sk-left-secret');
        expect(JSON.stringify(sections)).not.toContain('sk-right-secret');
        const keys = section(sections, 'Keys');
        const custom = item(keys, 'Api key custom');
        const entry = custom.children[0];
        expect(entry.label).toBe('right label');
        const value = item(entry, 'Value');
        const resolved = values.get(value.id)();
        expect(JSON.stringify(resolved)).not.toContain('sk-left-secret');
        expect(JSON.stringify(resolved)).not.toContain('sk-right-secret');
        expect(resolved.before).toBe('********cret');
        expect(resolved.after).toBe('********cret');
    });
});

describe('generic JSON conflict renderer', () => {
    test('creates one section per changed top-level key', () => {
        const { sections } = build(renderGeneric, { a: 1, b: { c: 2 } }, { a: 2, b: { c: 3 } });
        expect(sections.map(entry => entry.label).sort()).toEqual(['A', 'B']);
        expect(section(sections, 'A').children[0]).toMatchObject({ label: 'Value', status: 'changed' });
        expect(section(sections, 'B').children[0]).toMatchObject({ label: 'C', status: 'changed' });
    });

    test('renders a top-level array of objects as one section with entries', () => {
        const left = [{ id: 'a', value: 1 }, { id: 'b', value: 2 }];
        const right = [{ id: 'a', value: 1 }, { id: 'b', value: 3 }];
        const { sections } = build(renderGeneric, left, right);
        expect(sections).toHaveLength(1);
        expect(sections[0].label).toBe('Changes');
        expect(sections[0].children).toHaveLength(1);
        expect(sections[0].children[0].label).toBe('b');
        expect(sections[0].children[0].children[0]).toMatchObject({ label: 'Value', status: 'changed' });
    });
});

describe('text conflict renderer', () => {
    test('lists every changed block as a line hunk', () => {
        const before = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
        const after = before.slice();
        after[1] = 'changed two';
        after[15] = 'changed sixteen';
        const { sections, values } = build(renderText, before.join('\n'), after.join('\n'));
        const changes = section(sections, 'Changes');
        expect(changes.children).toHaveLength(2);
        expect(changes.children[0]).toMatchObject({ label: 'Lines', value: { kind: 'lines' } });
        expect(changes.children[0].meta.lines).toEqual({ from: 1, to: 5 });
        const resolved = values.get(changes.children[0].id)();
        expect(resolved.mode).toBe('lines');
        expect(resolved.rows.some(row => row.text === 'line 2' && row.kind === 'removed')).toBe(true);
        expect(resolved.rows.some(row => row.text === 'changed two' && row.kind === 'added')).toBe(true);
    });

    test('renders a single-line file as a paged value instead of a hunk', () => {
        const left = 'a'.repeat(10_000);
        const right = 'b'.repeat(10_000);
        const { sections, values } = build(renderText, left, right);
        const content = section(sections, 'Changes').children[0];
        expect(content).toMatchObject({ label: 'Content', value: { kind: 'scalar' } });
        const resolved = values.get(content.id)();
        expect(resolved.mode).toBe('cells');
        expect(cellPage(resolved.before, 0).text).toHaveLength(4000);
        expect(cellPage(resolved.after, 0).text).toHaveLength(4000);
    });
});
