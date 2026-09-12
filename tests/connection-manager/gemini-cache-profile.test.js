// SPDX-License-Identifier: AGPL-3.0-or-later
import { jest, test, expect } from '@jest/globals';

const settings = { connectionManager: { profiles: [] } };
jest.unstable_mockModule('../../public/script.js', () => ({ CONNECT_API_MAP: {} }));
jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({ extension_settings: settings }));
jest.unstable_mockModule('../../public/scripts/openai.js', () => ({
    chat_completion_sources: { OPENROUTER: 'openrouter' }, proxies: [],
}));
const { resolveChatCompletionRequestProfile } = await import('../../public/scripts/extensions/connection-manager/profile-resolver.js');

test('request-specific profiles retain independent Gemini history cache choices', () => {
    settings.connectionManager.profiles = [
        { name: 'History', mode: 'cc', api: 'openrouter', 'gemini-enable-history-cache': 'true', 'gemini-cache-keep-recent-turns': '3' },
        { name: 'System', mode: 'cc', api: 'openrouter', 'gemini-enable-history-cache': 'false', 'gemini-cache-keep-recent-turns': '2' },
    ];
    expect(resolveChatCompletionRequestProfile({ profileName: 'History' }).apiSettingsOverride).toMatchObject({
        gemini_enable_history_cache: true, gemini_cache_keep_recent_turns: 3,
    });
    expect(resolveChatCompletionRequestProfile({ profileName: 'System' }).apiSettingsOverride).toMatchObject({
        gemini_enable_history_cache: false, gemini_cache_keep_recent_turns: 2,
    });
});

test('legacy profiles leave Gemini defaults untouched; invalid explicit values fail', () => {
    settings.connectionManager.profiles = [{ name: 'Legacy', mode: 'cc', api: 'openrouter' }];
    const result = resolveChatCompletionRequestProfile({ profileName: 'Legacy' }).apiSettingsOverride;
    expect(result).not.toHaveProperty('gemini_enable_history_cache');
    expect(result).not.toHaveProperty('gemini_cache_keep_recent_turns');
    settings.connectionManager.profiles[0]['gemini-cache-keep-recent-turns'] = '0';
    expect(() => resolveChatCompletionRequestProfile({ profileName: 'Legacy' })).toThrow('positive integer');
});
