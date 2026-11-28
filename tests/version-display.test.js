import { describe, expect, test } from '@jest/globals';
import {
    formatCompactVersion,
    formatLukerDisplayVersion,
    parseNpmDevVersion,
} from '../public/scripts/util/version-display.js';

describe('version display formatting', () => {
    test('parseNpmDevVersion parses prerelease-based and stable-based npm @dev versions', () => {
        expect(parseNpmDevVersion('2.9.0-rc.6.dev.20261128.42.ga3bc0ea')).toEqual({
            baseVersion: '2.9.0-rc.6',
            date: '20261128',
            runNumber: '42',
            sha: 'a3bc0ea',
        });

        expect(parseNpmDevVersion('2.9.1-0.dev.20261128.7.g0012345')).toEqual({
            baseVersion: '2.9.1',
            date: '20261128',
            runNumber: '7',
            sha: '0012345',
        });

        expect(parseNpmDevVersion('2.9.0')).toBeNull();
        expect(parseNpmDevVersion('2.9.0-rc.6')).toBeNull();
    });

    test('formatLukerDisplayVersion formats npm @dev versions like git builds while leaving other builds unchanged', () => {
        expect(formatLukerDisplayVersion('2.9.0-rc.6.dev.20261128.42.ga3bc0ea'))
            .toBe('Luker 2.9.0-rc.6 \'dev\' (a3bc0ea)');

        expect(formatLukerDisplayVersion('2.9.1-0.dev.20261128.7.g0012345'))
            .toBe('Luker 2.9.1 \'dev\' (0012345)');

        expect(formatLukerDisplayVersion('2.9.0'))
            .toBe('Luker 2.9.0');

        expect(formatLukerDisplayVersion('2.9.0-rc.6', { gitBranch: 'release', gitRevision: 'a3bc0ea' }))
            .toBe('Luker 2.9.0-rc.6 \'release\' (a3bc0ea)');
    });

    test('formatCompactVersion shortens npm @dev versions and preserves regular versions', () => {
        expect(formatCompactVersion('2.9.0-rc.6.dev.20261128.42.ga3bc0ea')).toBe('2.9.0-rc.6-dev (a3bc0ea)');
        expect(formatCompactVersion('2.9.1-0.dev.20261128.7.g0012345')).toBe('2.9.1-dev (0012345)');
        expect(formatCompactVersion('2.9.0-rc.6')).toBe('2.9.0-rc.6');
        expect(formatCompactVersion('2.9.0')).toBe('2.9.0');
    });
});
