import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readCharacterFolderName, isCharacterFolderNameShared } from '../../src/character-assets.js';
import { write as writeCardChunk } from '../../src/character-card-parser.js';

const SEED_PNG = fileURLToPath(new URL('../../default/content/default_Seraphina.png', import.meta.url));

function writeCard(dir, avatarFile, name) {
    fs.mkdirSync(dir, { recursive: true });
    const seed = fs.readFileSync(SEED_PNG);
    const card = { spec: 'chara_card_v2', spec_version: '2.0', name, data: { name, description: '' } };
    fs.writeFileSync(path.join(dir, avatarFile), writeCardChunk(seed, JSON.stringify(card)));
}

describe('character asset folder naming', () => {
    test('reads the sanitized display name from a card', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-assets-'));
        writeCard(dir, 'a.png', 'Ash the Cartographer');
        expect(await readCharacterFolderName(path.join(dir, 'a.png'))).toBe('Ash the Cartographer');
    });

    test('returns an empty string for unreadable cards', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-assets-'));
        fs.writeFileSync(path.join(dir, 'broken.png'), 'not a png');
        expect(await readCharacterFolderName(path.join(dir, 'broken.png'))).toBe('');
    });

    test('treats unreadable sibling cards as shared', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-assets-'));
        writeCard(dir, 'good.png', 'X');
        fs.writeFileSync(path.join(dir, 'broken.png'), 'not a png');

        expect(await isCharacterFolderNameShared(dir, 'X', { excludeAvatars: ['good.png'] })).toBe(true);
    });

    test('fails closed when the characters directory cannot be read', async () => {
        const dir = path.join(os.tmpdir(), `luker-assets-missing-${Date.now()}`);
        expect(await isCharacterFolderNameShared(dir, 'X', { excludeAvatars: [] })).toBe(true);
    });

    test('detects another card resolving to the same folder name', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-assets-'));
        writeCard(dir, 'a.png', 'Ash the Cartographer');
        writeCard(dir, 'b.png', 'Ash the Cartographer');
        writeCard(dir, 'c.png', 'Bryn');

        expect(await isCharacterFolderNameShared(dir, 'Ash the Cartographer', { excludeAvatars: ['a.png'] })).toBe(true);
        expect(await isCharacterFolderNameShared(dir, 'Ash the Cartographer', { excludeAvatars: ['a.png', 'b.png'] })).toBe(false);
        expect(await isCharacterFolderNameShared(dir, 'Bryn', { excludeAvatars: [] })).toBe(true);
        expect(await isCharacterFolderNameShared(dir, '', { excludeAvatars: [] })).toBe(false);
    });
});
