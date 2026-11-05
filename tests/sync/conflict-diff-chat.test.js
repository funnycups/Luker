import { describe, test, expect } from '@jest/globals';

import { parseChat, renderChat } from '../../src/sync/conflict-diff/chat.js';
import { createBuilder } from '../../src/sync/conflict-diff/tree.js';

const message = (sendDate, name, mes, extra = {}) => ({
    name,
    is_user: false,
    is_system: false,
    send_date: sendDate,
    mes,
    extra: {},
    swipes: [mes],
    swipe_id: 0,
    ...extra,
});

const jsonl = values => values.map(value => JSON.stringify(value)).join('\n');

function build(left, right) {
    const builder = createBuilder();
    const sections = renderChat(left, right, builder);
    return builder.finalize(sections);
}

const section = (sections, label) => sections.find(item => item.label === label);
const item = (parent, label) => parent.children.find(child => child.label === label);

describe('chat conflict renderer', () => {
    test('separates the group metadata line from the messages', () => {
        const text = jsonl([
            { user_name: 'U', character_name: 'Seraphina', chat_metadata: { note: 'a' } },
            message('1', 'Seraphina', 'Hello'),
        ]);
        const parsed = parseChat(text);
        expect(parsed.metadata).toMatchObject({ user_name: 'U' });
        expect(parsed.messages).toHaveLength(1);
        expect(parseChat('not json')).toBeNull();
    });

    test('aligns messages by send_date and labels them by speaker and first line', () => {
        const left = jsonl([
            { user_name: 'U', character_name: 'Seraphina', chat_metadata: { note: 'a' } },
            message('1', 'Seraphina', 'First line\nSecond line'),
            message('2', 'Seraphina', 'Middle'),
            message('3', 'U', 'Last'),
        ]);
        const right = jsonl([
            { user_name: 'U', character_name: 'Seraphina', chat_metadata: { note: 'b' } },
            message('1', 'Seraphina', 'First line\nSecond line'),
            message('1.5', 'Seraphina', 'Inserted'),
            message('2', 'Seraphina', 'Middle changed'),
            message('3', 'U', 'Last'),
        ]);
        const { sections, values } = build(left, right);

        const metadata = section(sections, 'Chat metadata');
        expect(metadata).toBeTruthy();
        const meta = item(metadata, 'Metadata');
        expect(item(meta, 'Note')).toBeTruthy();

        const messages = section(sections, 'Messages');
        expect(messages.children.map(child => child.label).sort()).toEqual([
            'Seraphina: Inserted',
            'Seraphina: Middle changed',
        ]);
        const middle = item(messages, 'Seraphina: Middle changed');
        const mes = item(middle, 'Message');
        expect(mes).toMatchObject({ type: 'field', value: { kind: 'scalar' } });
        expect(values.get(mes.id)()).toEqual({ mode: 'cells', before: 'Middle', after: 'Middle changed' });

        const inserted = item(messages, 'Seraphina: Inserted');
        expect(inserted).toMatchObject({ status: 'added' });
        expect(values.get(item(inserted, 'Message').id)()).toMatchObject({ mode: 'cells', after: 'Inserted' });
    });

    test('marks a multi-line message body as a text value', () => {
        const left = jsonl([message('1', 'Seraphina', 'one\ntwo')]);
        const right = jsonl([message('1', 'Seraphina', 'one\nthree')]);
        const { sections } = build(left, right);
        expect(item(section(sections, 'Messages').children[0], 'Message')).toMatchObject({ value: { kind: 'text' } });
    });

    test('returns null for an unparseable chat so the caller can fall back to text', () => {
        expect(renderChat('{"mes":"ok"}', 'not json', createBuilder())).toBeNull();
    });

    test('returns no sections for identical chats', () => {
        const text = jsonl([message('1', 'Seraphina', 'Hello')]);
        expect(build(text, text).sections).toEqual([]);
    });
});
