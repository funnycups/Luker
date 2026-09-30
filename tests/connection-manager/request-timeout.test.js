// SPDX-License-Identifier: AGPL-3.0-or-later
import { jest, test, expect } from '@jest/globals';

const settings = { connectionManager: { profiles: [] } };
jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({ extension_settings: settings }));

const { clampRequestTimeout, getProfileRequestTimeoutMs, getRequestTimeoutMs } =
    await import('../../public/scripts/extensions/connection-manager/request-timeout.js');

test('clampRequestTimeout accepts positive seconds and disables everything else', () => {
    expect(clampRequestTimeout(2)).toBe(2);
    expect(clampRequestTimeout(1.5)).toBe(1.5);
    expect(clampRequestTimeout('30')).toBe(30);
    expect(clampRequestTimeout(0)).toBe(0);
    expect(clampRequestTimeout(-5)).toBe(0);
    expect(clampRequestTimeout('abc')).toBe(0);
    expect(clampRequestTimeout(null)).toBe(0);
    expect(clampRequestTimeout(undefined)).toBe(0);
});

test('getProfileRequestTimeoutMs converts seconds to milliseconds', () => {
    expect(getProfileRequestTimeoutMs({ 'request-timeout': 2 })).toBe(2000);
    expect(getProfileRequestTimeoutMs({ 'request-timeout': 0.5 })).toBe(500);
    expect(getProfileRequestTimeoutMs({})).toBe(0);
    expect(getProfileRequestTimeoutMs(null)).toBe(0);
});

test('getRequestTimeoutMs resolves exact profile name first, then selected profile', () => {
    settings.connectionManager.profiles = [
        { id: 'p1', name: 'Fast', 'request-timeout': 2 },
        { id: 'p2', name: 'Slow', 'request-timeout': 10 },
    ];
    settings.connectionManager.selectedProfile = 'p1';
    expect(getRequestTimeoutMs('Slow')).toBe(10_000);
    expect(getRequestTimeoutMs()).toBe(2000);
    settings.connectionManager.selectedProfile = null;
    expect(getRequestTimeoutMs()).toBe(0);
});
