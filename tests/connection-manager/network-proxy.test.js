// SPDX-License-Identifier: AGPL-3.0-or-later
import { jest, test, expect } from '@jest/globals';

const settings = { connectionManager: { profiles: [] } };
jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({ extension_settings: settings }));

const { getProfileNetworkProxy, getNetworkProxy, normalizeNetworkProxyUrl } =
    await import('../../public/scripts/extensions/connection-manager/network-proxy.js');

test('getProfileNetworkProxy trims the profile field and treats missing values as empty', () => {
    expect(getProfileNetworkProxy({ 'network-proxy': '  http://127.0.0.1:7890  ' })).toBe('http://127.0.0.1:7890');
    expect(getProfileNetworkProxy({ 'network-proxy': '' })).toBe('');
    expect(getProfileNetworkProxy({})).toBe('');
    expect(getProfileNetworkProxy(null)).toBe('');
});

test('getNetworkProxy resolves an exact profile name first, then the selected profile', () => {
    settings.connectionManager.profiles = [
        { id: 'p1', name: 'Fast', 'network-proxy': 'http://127.0.0.1:7891' },
        { id: 'p2', name: 'Slow', 'network-proxy': 'socks5://127.0.0.1:1080' },
    ];
    settings.connectionManager.selectedProfile = 'p1';

    expect(getNetworkProxy('Slow')).toBe('socks5://127.0.0.1:1080');
    expect(getNetworkProxy()).toBe('http://127.0.0.1:7891');

    settings.connectionManager.selectedProfile = null;
    expect(getNetworkProxy()).toBe('');
});

test('normalizeNetworkProxyUrl accepts supported proxy protocols', () => {
    expect(normalizeNetworkProxyUrl('')).toBe('');
    expect(normalizeNetworkProxyUrl('  http://127.0.0.1:7890  ')).toBe('http://127.0.0.1:7890');
    expect(normalizeNetworkProxyUrl('https://user:pass@proxy.example:443')).toBe('https://user:pass@proxy.example:443');
    expect(normalizeNetworkProxyUrl('socks5h://127.0.0.1:1080')).toBe('socks5h://127.0.0.1:1080');
});

test('normalizeNetworkProxyUrl rejects malformed URLs and unsupported protocols', () => {
    expect(() => normalizeNetworkProxyUrl('not a url')).toThrow(/Invalid proxy URL/);
    expect(() => normalizeNetworkProxyUrl('ftp://127.0.0.1:21')).toThrow(/Unsupported proxy protocol/);
});
