// SPDX-License-Identifier: AGPL-3.0-or-later

import './_mocks/luker-zh.js';
import { describe, test, expect, jest, beforeAll } from '@jest/globals';

jest.unstable_mockModule('../../../public/scripts/extensions/connection-manager/profile-resolver.js', () => ({
    getChatCompletionConnectionProfiles: () => [],
}));

let canHold;
let getField;
let setField;
let diffProfiles;
let applyChanges;
let mergeChanges;
let sanitizePresetMap;
let mergePresetMaps;

beforeAll(async () => {
    ({
        canHold,
        getField,
        setField,
        diffProfiles,
        applyChanges,
        mergeChanges,
    } = await import('../../../public/scripts/extensions/orchestrator/lens/model/edit.js'));
    ({
        sanitizePresetMap,
        mergePresetMaps,
    } = await import('../../../public/scripts/extensions/orchestrator/editable-spec.js'));
});

describe('orchestrator/lens/model/edit.js', () => {
    test('canHold returns true for tools and skills on spec string shorthand nodes', () => {
        const profile = {
            spec: {
                stages: [
                    { id: 'distill', mode: 'serial', nodes: ['distiller'] },
                ],
            },
            presets: {
                distiller: { systemPrompt: 'sys', userPromptTemplate: 'task', apiPresetName: '', promptPresetName: '' },
            },
        };

        expect(canHold('spec', profile, 'distiller', 'tools')).toBe(true);
        expect(canHold('spec', profile, 'distiller', 'skills')).toBe(true);
        expect(canHold('spec', profile, 'nonexistent', 'tools')).toBe(false);
    });

    test('setField upgrades spec string node to object when setting tools/skills, and mergeChanges preserves it', () => {
        const base = {
            spec: {
                stages: [
                    { id: 'distill', mode: 'serial', nodes: ['distiller'] },
                ],
            },
            presets: {
                distiller: { systemPrompt: 'sys', userPromptTemplate: 'task', apiPresetName: '', promptPresetName: '' },
            },
        };

        const toolsJson = JSON.stringify({ chat: { search: true } });
        const next = setField('spec', base, 'distiller', 'tools', toolsJson);
        expect(typeof next.spec.stages[0].nodes[0]).toBe('object');
        expect(next.spec.stages[0].nodes[0].tools).toEqual({ chat: { search: true } });
        expect(getField('spec', next, 'distiller', 'tools')).not.toBe('');

        const changes = diffProfiles('spec', base, next);
        const merged = mergeChanges('spec', base, changes);
        expect(merged.missing).toEqual([]);
        expect(merged.conflicts).toEqual([]);
        expect(applyChanges('spec', base, changes).spec.stages[0].nodes[0].tools).toEqual({ chat: { search: true } });
    });
});

describe('editable-spec sanitizePresetMap prototype pollution guard', () => {
    test('strips __proto__, constructor, and prototype keys on import', () => {
        const malicious = JSON.parse('{"__proto__":{"systemPrompt":"pwned"},"constructor":{"systemPrompt":"pwned2"},"prototype":{"systemPrompt":"pwned3"},"legit":{"systemPrompt":"ok"}}');
        const clean = sanitizePresetMap(malicious);

        expect(Object.keys(clean)).toEqual(['legit']);
        expect(Object.getPrototypeOf(clean)).toBe(Object.prototype);
        expect(({}).systemPrompt).toBeUndefined();

        const merged = mergePresetMaps({ base: { systemPrompt: 'b' } }, malicious);
        expect(Object.keys(merged).sort()).toEqual(['base', 'legit']);
        expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    });
});
