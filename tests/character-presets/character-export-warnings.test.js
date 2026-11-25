// @jest-environment node
import { describeCharacterExportWarnings } from '../../public/scripts/character/export-warnings.js';

// Records which template each warning resolved to without asserting on
// the wording itself.
const seen = [];
function t(strings, ...values) {
    if (!seen.includes(strings)) seen.push(strings);
    return JSON.stringify({ template: seen.indexOf(strings), values });
}

function encode(value) {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

describe('describeCharacterExportWarnings', () => {
    test.each([false, true])('decodes UTF-8 names in single or array bodies: %s', (array) => {
        const warning = { reason: 'world_not_found', name: '世界书🌍' };
        const messages = describeCharacterExportWarnings(encode(array ? [warning] : warning), t);
        expect(JSON.parse(messages[0]).values).toEqual([warning.name]);
    });
    test('no header yields no messages', () => {
        expect(describeCharacterExportWarnings(null, t)).toEqual([]);
        expect(describeCharacterExportWarnings('', t)).toEqual([]);
    });

    test('a skills pack failure next to a world warning yields one distinct message each', () => {
        const messages = describeCharacterExportWarnings(encode([
            { reason: 'world_not_found', name: 'Bryn' },
            { reason: 'skills_pack_failed', error: 'boom' },
        ]), t).map(m => JSON.parse(m));
        expect(messages).toHaveLength(2);
        expect(messages[0].values).toEqual(['Bryn']);
        expect(messages[1].values).toEqual([]);
        expect(messages[0].template).not.toBe(messages[1].template);
    });

    test('each reason maps to its own message', () => {
        const reasons = ['skills_pack_failed', 'world_not_found', 'world_unreadable', 'world_read_error'];
        const templates = reasons.map(reason => JSON.parse(describeCharacterExportWarnings(encode([{ reason, name: 'Bryn' }]), t)[0]).template);
        expect(new Set(templates).size).toBe(reasons.length);
    });

    test('a single warning object is accepted', () => {
        const single = describeCharacterExportWarnings(encode({ reason: 'skills_pack_failed' }), t);
        const listed = describeCharacterExportWarnings(encode([{ reason: 'skills_pack_failed' }]), t);
        expect(single).toEqual(listed);
    });

    test('a malformed header throws for the caller to log', () => {
        expect(() => describeCharacterExportWarnings('not base64 json', t)).toThrow();
    });
});
