import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('EXA secret key registration', () => {
    test('server SECRET_KEYS exposes EXA', async () => {
        const { SECRET_KEYS } = await import('../../src/endpoints/secrets.js');
        expect(SECRET_KEYS.EXA).toBe('api_key_exa');
    });

    test('client secrets.js declares the EXA key and label', () => {
        const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../public/scripts/secrets.js'), 'utf8');
        expect(source).toContain("EXA: 'api_key_exa'");
        expect(source).toContain('[SECRET_KEYS.EXA]: \'Exa\'');
    });
});
