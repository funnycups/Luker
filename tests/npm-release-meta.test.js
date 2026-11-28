import { describe, expect, test } from '@jest/globals';
import {
    buildDevVersion,
    resolveNpmPublishPlan,
    resolveReleaseDistTag,
} from '../.github/scripts/npm-release-meta.mjs';
import { compareSemver } from '../src/semver.js';

describe('npm release metadata', () => {
    const fixedDate = new Date('2026-11-28T13:45:00Z');

    test('buildDevVersion appends .dev.<date>.<run>.g<sha> to prerelease versions and preserves SemVer ordering', () => {
        const dev = buildDevVersion('2.9.0-rc.6', {
            date: fixedDate,
            runNumber: 42,
            sha: '0012345abcdef',
        });

        expect(dev).toBe('2.9.0-rc.6.dev.20261128.42.g0012345');
        expect(compareSemver(dev, 'v2.9.0-rc.6')).toBeGreaterThan(0);
        expect(compareSemver(dev, 'v2.9.0-rc.7')).toBeLessThan(0);
        expect(compareSemver(dev, 'v2.9.0')).toBeLessThan(0);

        const nextDev = buildDevVersion('2.9.0-rc.6', {
            date: fixedDate,
            runNumber: 43,
            sha: 'abcdef0123456',
        });
        expect(compareSemver(nextDev, dev)).toBeGreaterThan(0);
    });

    test('buildDevVersion bumps patch with -0.dev.* for stable versions so it sorts above current and below any next prerelease', () => {
        const dev = buildDevVersion('2.9.0', {
            date: fixedDate,
            runNumber: 7,
            sha: '8d9ac4c92000',
        });

        expect(dev).toBe('2.9.1-0.dev.20261128.7.g8d9ac4c');
        expect(compareSemver(dev, 'v2.9.0')).toBeGreaterThan(0);
        expect(compareSemver(dev, 'v2.9.1-alpha.1')).toBeLessThan(0);
        expect(compareSemver(dev, 'v2.9.1-beta.1')).toBeLessThan(0);
        expect(compareSemver(dev, 'v2.9.1-rc.1')).toBeLessThan(0);
        expect(compareSemver(dev, 'v2.9.1')).toBeLessThan(0);
        expect(compareSemver(dev, 'v2.10.0')).toBeLessThan(0);
    });

    test('resolveReleaseDistTag maps stable to latest and prereleases to their channel', () => {
        expect(resolveReleaseDistTag('2.9.0')).toBe('latest');
        expect(resolveReleaseDistTag('2.9.0-rc.6')).toBe('rc');
        expect(resolveReleaseDistTag('2.9.0-beta.1')).toBe('beta');
        expect(resolveReleaseDistTag('2.9.0-alpha.2')).toBe('alpha');
    });

    test('resolveNpmPublishPlan handles v-prefixed release tags and rejects version mismatch', () => {
        expect(resolveNpmPublishPlan({
            eventName: 'push',
            ref: 'refs/tags/v2.9.0',
            refName: 'v2.9.0',
            pkgVersion: '2.9.0',
        })).toEqual({
            mode: 'release',
            publishVersion: '2.9.0',
            distTag: 'latest',
            mutateVersion: false,
        });

        expect(resolveNpmPublishPlan({
            eventName: 'workflow_dispatch',
            ref: 'refs/heads/release',
            inputTag: 'v2.9.0-rc.6',
            pkgVersion: '2.9.0-rc.6',
        })).toEqual({
            mode: 'release',
            publishVersion: '2.9.0-rc.6',
            distTag: 'rc',
            mutateVersion: false,
        });

        expect(() => resolveNpmPublishPlan({
            eventName: 'push',
            ref: 'refs/tags/v2.9.0',
            refName: 'v2.9.0',
            pkgVersion: '2.9.0-rc.6',
        })).toThrow(/does not match package\.json version/);
    });

    test('resolveNpmPublishPlan publishes @dev on release branch push and empty/dev manual dispatch', () => {
        const pushDev = resolveNpmPublishPlan({
            eventName: 'push',
            ref: 'refs/heads/release',
            pkgVersion: '2.9.0-rc.6',
            runNumber: 12,
            sha: '8d9ac4c92',
            date: fixedDate,
        });
        expect(pushDev).toEqual({
            mode: 'dev',
            publishVersion: '2.9.0-rc.6.dev.20261128.12.g8d9ac4c',
            distTag: 'dev',
            mutateVersion: true,
        });

        const dispatchDev = resolveNpmPublishPlan({
            eventName: 'workflow_dispatch',
            ref: 'refs/heads/release',
            inputTag: '',
            pkgVersion: '2.9.0',
            runNumber: 15,
            sha: '8d9ac4c92',
            date: fixedDate,
        });
        expect(dispatchDev).toEqual({
            mode: 'dev',
            publishVersion: '2.9.1-0.dev.20261128.15.g8d9ac4c',
            distTag: 'dev',
            mutateVersion: true,
        });
    });
});
