import assert from 'node:assert/strict';

import {
    assembleCharacterRaw,
    buildCharacterProjection,
    buildCharacterSourceView,
} from '../src/character-resource-view.js';
import { applyPatch } from '../public/scripts/util/fast-json-patch.js';

function roundTrip(raw) {
    const view = buildCharacterSourceView({ raw, account: 'u', avatar: 'Alice.png' });
    assert.equal(assembleCharacterRaw(view.rawLayout, view.values), raw);
    return view;
}

describe('character resource source views', () => {
    test('preserves whitespace, CRLF, escapes, Unicode, and V1 root fields exactly', () => {
        const raw = '{\r\n  "name": "A\\u0062c",\r\n  "description": "漢字 🙂",\r\n  "personality": "p",\r\n  "scenario": "s",\r\n  "first_mes": "hi",\r\n  "mes_example": ""\r\n}';
        const view = roundTrip(raw);
        assert.equal(view.values.get('/name'), '"A\\u0062c"');
        assert.equal(view.values.get('/description'), '"漢字 🙂"');
        assert.equal(view.values.get('/personality'), '"p"');
    });

    test('uses the last duplicate property and keeps earlier text literal', () => {
        const raw = '{"name":"first","name":"second","data":{"description":"old","description":"new","extensions":{"x":{"a":1},"x":{"b":2}}}}';
        const view = roundTrip(raw);
        assert.equal(view.values.get('/name'), '"second"');
        assert.equal(view.values.get('/data/description'), '"new"');
        assert.equal(view.values.get('/data/extensions/x'), '{"b":2}');
        assert.ok(view.rawLayout.some(part => typeof part === 'string' && part.includes('"first"')));
    });

    test('keeps unknown extension namespaces and embedded books as complete values', () => {
        const raw = '{"spec":"chara_card_v2","data":{"name":"A","character_book":{"name":"book","entries":[{"content":"x"}]},"extensions":{"tavern_helper":{"scripts":[{"content":"s"}]},"depth_prompt":{"depth":4}}}}';
        const view = roundTrip(raw);
        assert.equal(view.values.get('/data/extensions/tavern_helper'), '{"scripts":[{"content":"s"}]}');
        assert.equal(view.values.get('/data/extensions/depth_prompt'), '{"depth":4}');
        assert.equal(view.values.get('/data/character_book'), '{"name":"book","entries":[{"content":"x"}]}');
    });

    test('surfaces only effective field paths in the directory', () => {
        const raw = '{"name":"one","name":"two","data":{"extensions":{"a":1,"a":2}}}';
        const view = roundTrip(raw);
        assert.deepEqual(view.fields, [
            '/name',
            '/data/extensions/a',
        ]);
    });

    test('reconstructs legacy runtime objects from a lossless projection', () => {
        const raw = '{"spec":"chara_card_v2","data":{"name":"A","description":"d","extensions":{"keep":{"x":1}}}}';
        const legacy = {
            avatar: 'A.png',
            spec: 'chara_card_v2',
            data: { name: 'A', description: 'd', extensions: { keep: { x: 1 } } },
            name: 'A',
            description: 'd',
            json_data: raw,
            date_added: 123,
            create_date: '2026-01-01T00:00:00.000Z',
            chat_size: 4,
            date_last_chat: 5,
            data_size: 6,
        };
        const projection = buildCharacterProjection({ raw, character: legacy });
        const runtime = applyPatch(JSON.parse(raw), projection.patch).newDocument;
        runtime.json_data = raw;
        const ordered = {};
        for (const key of projection.keyOrder) {
            if (Object.prototype.hasOwnProperty.call(runtime, key)) ordered[key] = runtime[key];
        }
        for (const key of Object.keys(runtime)) {
            if (!Object.prototype.hasOwnProperty.call(ordered, key)) ordered[key] = runtime[key];
        }
        expect(ordered).toEqual(legacy);
        expect(Object.keys(ordered)).toEqual(Object.keys(legacy));
    });

    test('rejects missing field values in a layout', () => {
        assert.throws(
            () => assembleCharacterRaw([{ literal: '{"x":' }, { path: '/x' }, { literal: '}' }], new Map()),
            error => error.code === 'read_conflict',
        );
    });
    test('preserves whitespace outside the root object', () => {
        const raw = ' \n{"name":"x","data":{}}\n ';
        const view = buildCharacterSourceView({ raw });
        expect(assembleCharacterRaw(view.rawLayout, view.values)).toBe(raw);
    });

});
