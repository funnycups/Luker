import { describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import extract from 'png-chunks-extract';
import PNGtext from 'png-chunk-text';

import encode from '../../../src/png/encode.js';
import { write as writeCard } from '../../../src/character-card-parser.js';
import { chooseChatId, mergeGroupDocuments, mergeCharacterCards } from '../../../src/sync/pipeline/bookkeeping-merge.js';

const SEED_PNG = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../default/content/default_Seraphina.png'));

describe('group document merge', () => {
    const group = extra => ({ id: 'g1', name: 'Glade Watch', chat_id: 'gc1', chats: ['gc1'], date_last_chat: 100, ...extra });

    test('the later date_last_chat wins and brings its chat_id', () => {
        const merged = mergeGroupDocuments(group(), group({ chat_id: 'gc2', chats: ['gc1', 'gc2'], date_last_chat: 300 }), group({ date_last_chat: 200 }));
        expect(merged).toEqual({ value: group({ chat_id: 'gc2', chats: ['gc1', 'gc2'], date_last_chat: 300 }), conflicted: false });
    });

    test('theirs chat_id wins when theirs chatted later', () => {
        const merged = mergeGroupDocuments(group(), group({ date_last_chat: 200 }), group({ chat_id: 'gc3', chats: ['gc1', 'gc3'], date_last_chat: 300 }));
        expect(merged.value).toMatchObject({ chat_id: 'gc3', date_last_chat: 300 });
    });

    test('a date_last_chat tie keeps the ours chat_id', () => {
        const chats = ['gc1', 'gc2', 'gc3'];
        const merged = mergeGroupDocuments(group({ chats }), group({ chat_id: 'gc2', chats, date_last_chat: 300 }), group({ chat_id: 'gc3', chats, date_last_chat: 300 }));
        expect(merged.value.chat_id).toBe('gc2');
    });

    test('chats lists ours order then theirs extras without the ids one side removed', () => {
        const merged = mergeGroupDocuments(group({ chats: ['gc1', 'gc2'] }), group({ chats: ['gc1', 'gc4'] }), group({ chats: ['gc3', 'gc1', 'gc2'] }));
        expect(merged.value.chats).toEqual(['gc1', 'gc4', 'gc3']);
    });

    test('a field one side changed takes that side and a field both changed the same way is kept', () => {
        const merged = mergeGroupDocuments(group({ fav: false }), group({ name: 'North Watch', fav: true }), group({ fav: true, date_last_chat: 150 }));
        expect(merged).toEqual({ value: group({ name: 'North Watch', fav: true, date_last_chat: 150 }), conflicted: false });
    });

    test('a field removed on one side and unchanged on the other is removed', () => {
        const merged = mergeGroupDocuments(group({ avatar_url: 'a.png' }), group(), group({ avatar_url: 'a.png', date_last_chat: 200 }));
        expect(merged.value).not.toHaveProperty('avatar_url');
        expect(merged.conflicted).toBe(false);
    });

    test('a field both sides changed differently keeps ours with the bookkeeping merged', () => {
        const merged = mergeGroupDocuments(group(), group({ name: 'Glade', date_last_chat: 200 }), group({ name: 'Watch', chat_id: 'gc5', chats: ['gc1', 'gc5'], date_last_chat: 300 }));
        expect(merged).toEqual({ value: group({ name: 'Glade', chat_id: 'gc5', chats: ['gc1', 'gc5'], date_last_chat: 300 }), conflicted: true });
    });

    test('without a base only fields equal on both sides merge cleanly', () => {
        expect(mergeGroupDocuments(null, group({ date_last_chat: 1 }), group({ date_last_chat: 2 })).conflicted).toBe(false);
        expect(mergeGroupDocuments(null, group({ name: 'A' }), group({ name: 'B' })).conflicted).toBe(true);
    });

    test('a side that is not an object is not merged', () => {
        expect(mergeGroupDocuments(group(), 'oops', group())).toBeNull();
        expect(mergeGroupDocuments(group(), group(), [1])).toBeNull();
    });

    test('date_added and create_date come from the side stamped earlier and chat_size from the side that chatted later', () => {
        const merged = mergeGroupDocuments(
            group(),
            group({ date_added: 20.5, create_date: '1970-01-01T00:00:00.020Z', chat_size: 400, date_last_chat: 300 }),
            group({ date_added: 10.25, create_date: '1970-01-01T00:00:00.010Z', chat_size: 300, date_last_chat: 200 }),
        );
        expect(merged).toEqual({ value: group({ date_added: 10.25, create_date: '1970-01-01T00:00:00.010Z', chat_size: 400, date_last_chat: 300 }), conflicted: false });
    });

    test('chat_id comes from the later side only when the merged chats list it', () => {
        // Theirs chatted later in gc2, which ours deleted.
        const merged = mergeGroupDocuments(group({ chats: ['gc1', 'gc2'] }), group({ chats: ['gc1'], date_last_chat: 200 }), group({ chat_id: 'gc2', chats: ['gc1', 'gc2'], date_last_chat: 300 }));
        expect(merged.value).toMatchObject({ chat_id: 'gc1', chats: ['gc1'] });
    });

    test('chat_id falls back to the last listed chat when neither side\'s chat is listed', () => {
        const merged = mergeGroupDocuments(
            group({ chats: ['gc1', 'gc2', 'gc3'] }),
            group({ chat_id: 'gc2', chats: ['gc1', 'gc2', 'gc4'], date_last_chat: 200 }),
            group({ chat_id: 'gc3', chats: ['gc1', 'gc3', 'gc5'], date_last_chat: 300 }),
        );
        expect(merged.value).toMatchObject({ chats: ['gc1', 'gc4', 'gc5'], chat_id: 'gc5' });
    });

    test('an empty merged chats list keeps the chat_id of the side that chatted later', () => {
        const merged = mergeGroupDocuments(group({ chats: ['gc1'] }), group({ chats: [], chat_id: 'gc2', date_last_chat: 200 }), group({ chats: ['gc1'], chat_id: 'gc3', date_last_chat: 300 }));
        expect(merged.value).toMatchObject({ chats: [], chat_id: 'gc3' });
    });

    test('chooseChatId takes the first listed candidate, else the last listed id, else the first candidate', () => {
        expect(chooseChatId(['b', 'a'], ['a', 'b'])).toBe('b');
        expect(chooseChatId(['x', 'a'], ['a', 'b'])).toBe('a');
        expect(chooseChatId(['x', undefined], ['a', 'b'])).toBe('b');
        expect(chooseChatId([undefined, 'x'], [])).toBe('x');
    });

    test('a non-numeric date_last_chat merges three-way and decides no side', () => {
        const merged = mergeGroupDocuments(group(), group({ date_last_chat: 'yesterday', chat_id: 'gc2', chats: ['gc1', 'gc2'] }), group({ date_last_chat: 300, chat_id: 'gc3', chats: ['gc1', 'gc2', 'gc3'] }));
        expect(merged.conflicted).toBe(true);
        expect(merged.value).toMatchObject({ date_last_chat: 'yesterday', chat_id: 'gc2' });
    });

    test('a non-numeric date one side changed alone takes that side without a record', () => {
        const merged = mergeGroupDocuments(group({ date_added: 'x' }), group({ date_added: 'x' }), group({ date_added: 5, create_date: 'c' }));
        expect(merged).toEqual({ value: group({ date_added: 5, create_date: 'c' }), conflicted: false });
    });

    test('key order follows ours then the keys only theirs has', () => {
        const merged = mergeGroupDocuments({}, { b: 1, a: 1 }, { c: 1, a: 1, b: 1 });
        expect(Object.keys(merged.value)).toEqual(['b', 'a', 'c']);
    });
});

describe('character card merge', () => {
    const card = extra => ({ spec: 'chara_card_v2', spec_version: '2.0', name: 'Seraphina', data: { name: 'Seraphina', description: 'A guardian.', extensions: {} }, ...extra });
    const png = (value, image = SEED_PNG) => writeCard(image, JSON.stringify(value));
    const cardOf = bytes => {
        const chara = extract(new Uint8Array(bytes)).filter(c => c.name === 'tEXt').map(c => PNGtext.decode(c.data)).find(t => t.keyword === 'chara');
        return JSON.parse(Buffer.from(chara.text, 'base64').toString('utf8'));
    };

    test('cards that differ only in the last chat merge without a record', () => {
        const merged = mergeCharacterCards(png(card()), png(card({ chat: 'Forest Path' })), png(card({ chat: 'River Ford' })));
        expect(merged.conflicted).toBe(false);
        expect(cardOf(merged.bytes)).toMatchObject({ name: 'Seraphina', chat: 'Forest Path' });
    });

    test('the last chat one side changed takes that side', () => {
        const merged = mergeCharacterCards(png(card({ chat: 'A' })), png(card({ chat: 'A', data: { name: 'Seraphina', description: 'Edited.', extensions: {} } })), png(card({ chat: 'B' })));
        expect(merged.conflicted).toBe(false);
        expect(cardOf(merged.bytes)).toMatchObject({ chat: 'B', data: { description: 'Edited.' } });
    });

    test('the later date_last_chat brings its chat', () => {
        const merged = mergeCharacterCards(png(card()), png(card({ chat: 'A', date_last_chat: 1 })), png(card({ chat: 'B', date_last_chat: 2 })));
        expect(cardOf(merged.bytes)).toMatchObject({ chat: 'B', date_last_chat: 2 });
    });

    test('the merged card is the same bytes whichever device merges', () => {
        const [base, ours, theirs] = [png(card()), png(card({ chat: 'A' })), png(card({ chat: 'B' }))];
        expect(Buffer.compare(mergeCharacterCards(base, ours, theirs).bytes, mergeCharacterCards(base, ours, theirs).bytes)).toBe(0);
    });

    test('a card one side edited takes that side with the merged last chat', () => {
        const edited = card({ chat: 'A', data: { name: 'Seraphina', description: 'Edited.', extensions: {} } });
        const merged = mergeCharacterCards(png(card()), png(edited), png(card({ chat: 'B' })));
        expect(merged.conflicted).toBe(false);
        expect(cardOf(merged.bytes)).toEqual({ ...edited, chat: 'A' });
    });

    test('cards both sides edited otherwise are conflicted and keep ours', () => {
        const ours = card({ chat: 'A', data: { name: 'Seraphina', description: 'Ours.', extensions: {} } });
        const merged = mergeCharacterCards(png(card()), png(ours), png(card({ chat: 'B', data: { name: 'Seraphina', description: 'Theirs.', extensions: {} } })));
        expect(merged.conflicted).toBe(true);
        expect(cardOf(merged.bytes)).toEqual(ours);
    });

    test('an image one side changed takes that side', () => {
        const chunks = extract(new Uint8Array(SEED_PNG));
        chunks.splice(-1, 0, PNGtext.encode('Comment', 'repainted'));
        const repainted = Buffer.from(encode(chunks));
        const merged = mergeCharacterCards(png(card()), png(card({ chat: 'A' })), png(card({ chat: 'B' }), repainted));
        expect(merged.conflicted).toBe(false);
        const comments = extract(new Uint8Array(merged.bytes)).filter(c => c.name === 'tEXt').map(c => PNGtext.decode(c.data)).filter(t => t.keyword === 'Comment');
        expect(comments.map(t => t.text)).toEqual(['repainted']);
        expect(cardOf(merged.bytes).chat).toBe('A');
    });

    test('images both sides changed are conflicted', () => {
        const variant = text => {
            const chunks = extract(new Uint8Array(SEED_PNG));
            chunks.splice(-1, 0, PNGtext.encode('Comment', text));
            return Buffer.from(encode(chunks));
        };
        expect(mergeCharacterCards(png(card()), png(card(), variant('a')), png(card(), variant('b'))).conflicted).toBe(true);
    });

    test('a card whose ccv3 chunk carries content its chara chunk lacks is not merged', () => {
        const chunks = extract(new Uint8Array(png(card({ chat: 'A' }))));
        const ccv3 = chunks.findIndex(c => c.name === 'tEXt' && PNGtext.decode(c.data).keyword === 'ccv3');
        chunks[ccv3] = PNGtext.encode('ccv3', Buffer.from(JSON.stringify({ ...card({ chat: 'A' }), spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'Seraphina', description: 'A guardian.', extensions: {}, group_only_greetings: ['Hello'] } })).toString('base64'));
        const mismatched = Buffer.from(encode(chunks));
        expect(mergeCharacterCards(png(card()), mismatched, png(card({ chat: 'B' })))).toBeNull();
        expect(mergeCharacterCards(png(card()), png(card({ chat: 'B' })), mismatched)).toBeNull();
    });

    test('chunks that differ only in their spec and bookkeeping fields merge', () => {
        const chunks = extract(new Uint8Array(png(card({ chat: 'A' }))));
        const ccv3 = chunks.findIndex(c => c.name === 'tEXt' && PNGtext.decode(c.data).keyword === 'ccv3');
        chunks[ccv3] = PNGtext.encode('ccv3', Buffer.from(JSON.stringify({ ...card({ chat: 'stale' }), spec: 'chara_card_v3', spec_version: '3.0' })).toString('base64'));
        const merged = mergeCharacterCards(png(card()), Buffer.from(encode(chunks)), png(card({ chat: 'B' })));
        expect(merged.conflicted).toBe(false);
    });

    test('a card without a chara chunk is not merged', () => {
        const chunks = extract(new Uint8Array(png(card()))).filter(c => !(c.name === 'tEXt' && PNGtext.decode(c.data).keyword === 'chara'));
        expect(mergeCharacterCards(png(card()), Buffer.from(encode(chunks)), png(card({ chat: 'B' })))).toBeNull();
    });

    test('a non-numeric card date_last_chat makes a last chat both sides changed a conflict', () => {
        const merged = mergeCharacterCards(png(card()), png(card({ chat: 'A', date_last_chat: 'later' })), png(card({ chat: 'B', date_last_chat: 2 })));
        expect(merged.conflicted).toBe(true);
        expect(cardOf(merged.bytes)).toMatchObject({ chat: 'A', date_last_chat: 'later' });
    });

    test('a side without card data is not merged', () => {
        expect(mergeCharacterCards(png(card()), Buffer.from('not a png'), png(card()))).toBeNull();
    });
});
