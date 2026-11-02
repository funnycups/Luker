import { test, expect } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanupOrphanedMetadata, METADATA_CACHE_FILE } from '../../src/endpoints/image-metadata.js';

test('cleanup preserves an unreadable synced index while deleting local cache orphans', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-metadata-cleanup-'));
    try {
        const bytes = '{"folders":[{"name":"recoverable"}]';
        fs.writeFileSync(path.join(root, 'image-metadata.json'), bytes);
        fs.mkdirSync(path.join(root, 'thumbnails'));
        fs.writeFileSync(path.join(root, METADATA_CACHE_FILE), JSON.stringify({ images: { 'user/images/missing.png': { hash: 'local' } } }));
        await expect(cleanupOrphanedMetadata(root)).rejects.toMatchObject({ code: 'IMAGE_METADATA_PRESERVED' });
        expect(fs.readFileSync(path.join(root, 'image-metadata.json'), 'utf8')).toBe(bytes);
        expect(JSON.parse(fs.readFileSync(path.join(root, METADATA_CACHE_FILE), 'utf8')).images).toEqual({});
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
