import { describe, test, expect } from '@jest/globals';
import {
    normalizeProviderConfig,
    normalizeProviderSettings,
} from '../../public/scripts/extensions/search-tools/providers.js';

describe('legacy safeSearch fallback', () => {
    test('a legacy top-level value seeds the three original providers', () => {
        const out = normalizeProviderSettings(undefined, { safeSearch: 'strict' });
        expect(out.ddg.safeSearch).toBe('strict');
        expect(out.searxng.safeSearch).toBe('strict');
        expect(out.brave.safeSearch).toBe('strict');
    });

    test('added providers keep their field default instead of the legacy value', () => {
        const out = normalizeProviderSettings(undefined, { safeSearch: 'strict' });
        expect(out.tavily.safeSearch).toBe('moderate');
        expect(out.exa.safeSearch).toBe('moderate');
        expect(out.serpapi.safeSearch).toBe('moderate');
    });

    test('an explicit per-provider value wins over the legacy value', () => {
        const out = normalizeProviderSettings(
            { ddg: { safeSearch: 'off' }, searxng: { safeSearch: 'off' }, brave: { safeSearch: 'off' } },
            { safeSearch: 'strict' },
        );
        expect(out.ddg.safeSearch).toBe('off');
        expect(out.searxng.safeSearch).toBe('off');
        expect(out.brave.safeSearch).toBe('off');
    });

    test('the legacy value only fills providers with no persisted value', () => {
        const out = normalizeProviderSettings({ ddg: { safeSearch: 'off' } }, { safeSearch: 'strict' });
        expect(out.ddg.safeSearch).toBe('off');
        expect(out.searxng.safeSearch).toBe('strict');
        expect(out.brave.safeSearch).toBe('strict');
    });

    test('an invalid legacy value falls back to the field default', () => {
        expect(normalizeProviderConfig('ddg', undefined, 'bogus').safeSearch).toBe('moderate');
    });
});
