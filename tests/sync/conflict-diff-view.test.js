import { describe, test, expect } from '@jest/globals';

import * as characterCard from '../../src/character-card-parser.js';
import { buildConflictView, readConflictValue } from '../../src/sync/conflict-diff/index.js';

const bytes = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
const transparentPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const card = (name, description) => Buffer.from(characterCard.write(transparentPng, JSON.stringify({
    spec: 'chara_card_v2',
    data: { name, description },
})));

const viewOf = (path, left, right) => buildConflictView({ path, left: bytes(left), right: bytes(right) }).view;
const find = (nodes, label) => {
    for (const node of nodes ?? []) {
        if (node.label === label) return node;
        const found = find(node.children, label);
        if (found) return found;
    }
    return null;
};

const world = content => ({
    entries: {
        0: { uid: 1, displayIndex: 0, comment: 'Alpha', content, key: ['a'] },
    },
});

describe('buildConflictView — kind detection', () => {
    test('marks identical bytes as identical without sections', () => {
        const text = JSON.stringify(world('same'));
        const view = viewOf('worlds/w.json', text, text);
        expect(view).toMatchObject({ kind: 'worldbook', identical: true, totalChanges: 0 });
        expect(view.sections).toEqual([]);
    });

    test('marks a missing side as deleted without sections', () => {
        const view = buildConflictView({ path: 'worlds/w.json', left: null, right: bytes(world('x')) }).view;
        expect(view).toMatchObject({ kind: 'worldbook', deleted: 'left', totalChanges: 0 });
        expect(view.sections).toEqual([]);
    });

    test('detects presets, world books, settings, plain JSON, text and binaries', () => {
        const preset = { prompts: [{ identifier: 'a', name: 'A' }], prompt_order: [] };
        expect(viewOf('presets/p.json', preset, { ...preset, prompts: [{ identifier: 'a', name: 'B' }] }).kind).toBe('preset');
        expect(viewOf('worlds/w.json', world('a'), world('b')).kind).toBe('worldbook');
        expect(viewOf('settings.json', { a: 1 }, { a: 2 }).kind).toBe('settings');
        expect(viewOf('data.json', { a: 1 }, { a: 2 }).kind).toBe('json');
        expect(viewOf('notes.txt', 'a\nb', 'a\nc').kind).toBe('text');
        expect(viewOf('archive.bin', 'a', 'b').kind).toBe('binary');
    });

    test('falls back to text for unparseable JSON and invalid chat', () => {
        expect(viewOf('data.json', '{not json', '{}').kind).toBe('text');
        expect(viewOf('chats/c.jsonl', '{not json', '{}').kind).toBe('text');
        expect(viewOf('chats/c.jsonl', JSON.stringify({ mes: 'a', send_date: '1' }), JSON.stringify({ mes: 'b', send_date: '1' })).kind).toBe('chat');
    });

    test('reads a character card payload and reports pixel equality', () => {
        const view = buildConflictView({
            path: 'characters/Alice.png',
            left: card('Alice', 'first'),
            right: card('Alice', 'second'),
        }).view;
        expect(view).toMatchObject({ kind: 'character', imageDiffers: false });
        expect(find(view.sections, 'Profile')).toBeTruthy();
        expect(find(view.sections, 'Description')).toBeTruthy();
    });

    test('falls back to image when the card chunk is unreadable', () => {
        const left = Buffer.from(characterCard.write(transparentPng, '{not json'));
        const right = Buffer.from(characterCard.write(transparentPng, '{still not json'));
        const view = buildConflictView({ path: 'characters/Alice.png', left, right }).view;
        expect(view).toMatchObject({ kind: 'image', imageDiffers: false, sections: [] });
    });

    test('marks an unreadable secrets file instead of parsing it as text', () => {
        const view = viewOf('secrets.json', '{not json', '{}');
        expect(view).toMatchObject({ kind: 'secrets', unreadable: true, sections: [] });
    });
});

describe('buildConflictView — lazy values', () => {
    test('does not serialize value text into the view', () => {
        const marker = 'UNIQUE_PROMPT_BODY_MARKER';
        const left = { prompts: [{ identifier: 'a', name: 'A', content: marker }], prompt_order: [] };
        const right = { prompts: [{ identifier: 'a', name: 'A', content: `${marker} changed` }], prompt_order: [] };
        const { view, values } = buildConflictView({ path: 'presets/p.json', left: bytes(left), right: bytes(right) });
        expect(JSON.stringify(view)).not.toContain(marker);
        const content = find(view.sections, 'Content');
        expect(content.value).toEqual({ kind: 'scalar' });
        expect(values.get(content.id)()).toMatchObject({ mode: 'cells', before: marker });
    });

    test('pages a long value through the value entry point', () => {
        const left = world('x'.repeat(10_000));
        const right = world('y'.repeat(10_000));
        const { view } = buildConflictView({ path: 'worlds/w.json', left: bytes(left), right: bytes(right) });
        const content = find(view.sections, 'Content');
        const first = readConflictValue({ path: 'worlds/w.json', left: bytes(left), right: bytes(right), nodeId: content.id, offset: 0 });
        expect(first).toMatchObject({ mode: 'cells', offset: 0, nextOffset: 4000 });
        expect(first.before.text).toHaveLength(4000);
        expect(first.after.text).toHaveLength(4000);
        const second = readConflictValue({ path: 'worlds/w.json', left: bytes(left), right: bytes(right), nodeId: content.id, offset: 4000 });
        expect(second.before.text[0]).toBe('x');
        expect(second.after.text[0]).toBe('y');
    });

    test('rejects unknown nodes and invalid offsets', () => {
        const left = world('a');
        const right = world('b');
        expect(() => readConflictValue({ path: 'worlds/w.json', left: bytes(left), right: bytes(right), nodeId: '999999', offset: 0 }))
            .toThrow(expect.objectContaining({ code: 'UNKNOWN_NODE' }));
        const { view } = buildConflictView({ path: 'worlds/w.json', left: bytes(left), right: bytes(right) });
        const content = find(view.sections, 'Content');
        expect(() => readConflictValue({ path: 'worlds/w.json', left: bytes(left), right: bytes(right), nodeId: content.id, offset: -1 }))
            .toThrow(expect.objectContaining({ code: 'INVALID_OFFSET' }));
    });
});
