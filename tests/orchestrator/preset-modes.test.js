import { describe, test, expect } from '@jest/globals';
import { ORCH_PRESET_MODES, makeModeMap } from '../../public/scripts/extensions/orchestrator/preset-modes.js';

describe('ORCH_PRESET_MODES', () => {
    test('lists the preset-library modes in display order and is frozen', () => {
        expect([...ORCH_PRESET_MODES]).toEqual(['spec', 'agenda', 'loop', 'director']);
        expect(Object.isFrozen(ORCH_PRESET_MODES)).toBe(true);
    });
});

describe('makeModeMap', () => {
    test('builds one key per mode in order from the factory', () => {
        const map = makeModeMap((mode) => `${mode}-slot`);
        expect(Object.keys(map)).toEqual(['spec', 'agenda', 'loop', 'director']);
        expect(map.loop).toBe('loop-slot');
    });

    test('returns fresh containers on every call', () => {
        const a = makeModeMap(() => ({}));
        const b = makeModeMap(() => ({}));
        expect(a).toEqual({ spec: {}, agenda: {}, loop: {}, director: {} });
        expect(a).not.toBe(b);
        expect(a.spec).not.toBe(a.agenda);
        a.spec.x = 1;
        expect(b.spec).toEqual({});
    });
});
