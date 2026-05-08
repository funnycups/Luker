import { describe, expect, test } from '@jest/globals';

import {
    SETTINGS_PATCH_OPS_THRESHOLD,
    shouldUseSettingsPatch,
} from '../public/scripts/util/settings-patch-threshold.js';

describe('shouldUseSettingsPatch', () => {
    test('rejects empty operations list', () => {
        expect(shouldUseSettingsPatch([])).toBe(false);
    });

    test('rejects non-array input', () => {
        expect(shouldUseSettingsPatch(null)).toBe(false);
        expect(shouldUseSettingsPatch(undefined)).toBe(false);
        expect(shouldUseSettingsPatch({})).toBe(false);
        expect(shouldUseSettingsPatch('ops')).toBe(false);
    });

    test('rejects the diff-worker overflow sentinel: single replace at root path', () => {
        const sentinel = [{ op: 'replace', path: '', value: { whole: 'tree' } }];
        expect(shouldUseSettingsPatch(sentinel)).toBe(false);
    });

    test('accepts a single non-sentinel replace op', () => {
        const ops = [{ op: 'replace', path: '/foo/bar', value: 1 }];
        expect(shouldUseSettingsPatch(ops)).toBe(true);
    });

    test('accepts a small mixed-op patch', () => {
        const ops = [
            { op: 'replace', path: '/oai_settings/temperature', value: 0.7 },
            { op: 'add', path: '/extension_settings/foo', value: { x: 1 } },
            { op: 'remove', path: '/old_field' },
        ];
        expect(shouldUseSettingsPatch(ops)).toBe(true);
    });

    test('accepts exactly threshold ops', () => {
        const ops = Array.from({ length: SETTINGS_PATCH_OPS_THRESHOLD }, (_, i) => ({
            op: 'replace',
            path: `/x/${i}`,
            value: i,
        }));
        expect(shouldUseSettingsPatch(ops)).toBe(true);
    });

    test('rejects threshold + 1 ops (prefer full-save fallback)', () => {
        const ops = Array.from({ length: SETTINGS_PATCH_OPS_THRESHOLD + 1 }, (_, i) => ({
            op: 'replace',
            path: `/x/${i}`,
            value: i,
        }));
        expect(shouldUseSettingsPatch(ops)).toBe(false);
    });

    test('honors a custom threshold override', () => {
        const ops = [
            { op: 'replace', path: '/a', value: 1 },
            { op: 'replace', path: '/b', value: 2 },
            { op: 'replace', path: '/c', value: 3 },
        ];
        expect(shouldUseSettingsPatch(ops, 3)).toBe(true);
        expect(shouldUseSettingsPatch(ops, 2)).toBe(false);
    });

    test('rejects non-positive or non-finite custom thresholds', () => {
        const ops = [{ op: 'replace', path: '/a', value: 1 }];
        expect(shouldUseSettingsPatch(ops, 0)).toBe(false);
        expect(shouldUseSettingsPatch(ops, -1)).toBe(false);
        expect(shouldUseSettingsPatch(ops, NaN)).toBe(false);
        expect(shouldUseSettingsPatch(ops, Infinity)).toBe(false);
    });

    test('does not treat a non-empty path replace as the sentinel', () => {
        const ops = [{ op: 'replace', path: '/whole_thing', value: { x: 1 } }];
        expect(shouldUseSettingsPatch(ops)).toBe(true);
    });

    test('default threshold export matches behavior', () => {
        expect(SETTINGS_PATCH_OPS_THRESHOLD).toBe(256);
    });
});
