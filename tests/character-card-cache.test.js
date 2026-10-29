import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { read } from '../src/character-card-parser.js';
import { diskCache, readCharacterData, writeCharacterData } from '../src/endpoints/characters.js';

const seedPath = fileURLToPath(new URL('../default/content/default_Seraphina.png', import.meta.url));

describe('character card cache storage identity', () => {
    test('caches the preferred PNG payload rather than the pre-write string', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-character-cache-'));
        const characters = path.join(root, 'characters');
        fs.mkdirSync(characters, { recursive: true });
        const inputPath = path.join(characters, 'Input.png');
        fs.copyFileSync(seedPath, inputPath);
        const raw = JSON.stringify({
            spec: 'chara_card_v2',
            spec_version: '2.0',
            data: {
                name: 'Cache Identity',
                description: 'kept',
                extensions: { example: { enabled: true } },
            },
        });
        const request = {
            user: {
                directories: { characters },
                profile: { handle: 'cache-test' },
            },
        };

        try {
            assert.equal(await writeCharacterData(inputPath, raw, 'CacheIdentity', request), true);
            const outputPath = path.join(characters, 'CacheIdentity.png');
            const preferred = read(fs.readFileSync(outputPath));
            const warm = await readCharacterData(outputPath);
            assert.equal(warm, preferred);
            assert.notEqual(warm, raw);
        } finally {
            diskCache.dispose();
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
