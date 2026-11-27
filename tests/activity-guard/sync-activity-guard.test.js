/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
    getActiveActivities,
    hasUnloadGuard,
    hasChatSwitchGuard,
    hasKeepAliveHold,
} from '../../public/scripts/activity-guard.js';

import {
    initializeSyncActivity,
    beginSyncActivity,
} from '../../public/scripts/sync-activity.js';

let disposeObserver = null;

beforeEach(() => {
    document.body.innerHTML = '';
    globalThis.toastr = {
        error: jest.fn(),
        info: jest.fn(),
        warning: jest.fn(),
        success: jest.fn(),
        clear: jest.fn(),
    };
    disposeObserver = initializeSyncActivity();
});

afterEach(() => {
    disposeObserver?.();
    disposeObserver = null;
    const leftover = getActiveActivities();
    if (leftover.length > 0) {
        throw new Error(`Leaked activity leases after test: ${JSON.stringify(leftover)}`);
    }
});

describe('sync-activity activity guard leases', () => {
    test('beginSyncActivity acquires core:sync global lease and releases on finish', () => {
        const finish = beginSyncActivity({ backendId: 's3-main', label: 'Primary S3' });

        expect(getActiveActivities()).toEqual([
            expect.objectContaining({
                source: 'core:sync',
                label: expect.stringMatching(/\S/),
                scope: 'global',
                guardUnload: true,
                guardChatSwitch: false,
                keepAlive: true,
            }),
        ]);
        expect(hasUnloadGuard()).toBe(true);
        expect(hasKeepAliveHold()).toBe(true);
        expect(hasChatSwitchGuard()).toBe(false);

        finish({ ok: true, needsAttention: false });

        expect(getActiveActivities()).toEqual([]);
        expect(hasUnloadGuard()).toBe(false);
    });

    test('finish callback releases lease even if state.finishRequest throws on duplicate call or dispose ran first', () => {
        const finishA = beginSyncActivity({ backendId: 'lan-1', label: 'LAN Peer' });
        const finishB = beginSyncActivity({ backendId: 's3-2', label: 'Backup S3' });
        expect(getActiveActivities()).toHaveLength(2);

        // Disposing observer before finish callbacks run must not throw or strand leases
        disposeObserver();
        disposeObserver = null;

        finishA({ ok: true, needsAttention: false });
        expect(getActiveActivities()).toHaveLength(1);

        // Calling finishA a second time throws in state.finishRequest, yet stays safe
        expect(() => finishA({ ok: true, needsAttention: false })).toThrow(/already settled/i);

        finishB({ ok: false, needsAttention: true });
        expect(getActiveActivities()).toEqual([]);
    });

    test('overlapping sync requests keep core:sync active until every request finishes', () => {
        const finish1 = beginSyncActivity({ backendId: 's3-1', label: 'S3 One' });
        const finish2 = beginSyncActivity({ backendId: 's3-2', label: 'S3 Two' });
        expect(getActiveActivities()).toHaveLength(2);

        finish1({ ok: true, needsAttention: false });
        expect(getActiveActivities()).toHaveLength(1);
        expect(hasUnloadGuard()).toBe(true);

        finish2({ ok: true, needsAttention: false });
        expect(getActiveActivities()).toEqual([]);
        expect(hasUnloadGuard()).toBe(false);
    });
});
