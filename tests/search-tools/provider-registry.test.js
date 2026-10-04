import { describe, test, expect, beforeAll } from '@jest/globals';

process.env.SILLYTAVERN_ALLOWKEYSEXPOSURE = 'false';

let SEARCH_PROVIDERS;
let serverIds;
let serverSecrets;

beforeAll(async () => {
    ({ SEARCH_PROVIDERS } = await import('../../public/scripts/extensions/search-tools/providers.js'));
    ({ SEARCH_PROVIDER_IDS: serverIds } = await import('../../src/endpoints/search.js'));
    ({ SECRET_KEYS: serverSecrets } = await import('../../src/endpoints/secrets.js'));
});

describe('SEARCH_PROVIDERS', () => {
    test('has the exact id set the server exposes', () => {
        const clientIds = SEARCH_PROVIDERS.map(p => p.id).sort();
        expect(clientIds).toEqual([...serverIds].sort());
    });

    test('ids are unique and each descriptor is well-formed', () => {
        const ids = SEARCH_PROVIDERS.map(p => p.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const p of SEARCH_PROVIDERS) {
            expect(typeof p.label).toBe('string');
            expect(Array.isArray(p.fields)).toBe(true);
            for (const f of p.fields) {
                expect(['select', 'text', 'number', 'checkbox']).toContain(f.type);
                if (f.type === 'select') {
                    expect(f.options.some(([v]) => v === f.default)).toBe(true);
                }
            }
        }
    });

    test('every secretKey is a real server SECRET_KEYS value', () => {
        const known = new Set(Object.values(serverSecrets));
        for (const p of SEARCH_PROVIDERS) {
            if (p.secretKey) {
                expect(known.has(p.secretKey)).toBe(true);
            }
        }
    });

    test('safe search is present only where the provider supports it', () => {
        const withSafe = SEARCH_PROVIDERS.filter(p => p.fields.some(f => f.key === 'safeSearch')).map(p => p.id).sort();
        expect(withSafe).toEqual(['brave', 'ddg', 'exa', 'searxng', 'serpapi', 'tavily']);
    });
});
