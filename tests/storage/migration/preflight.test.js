import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FsEngine } from '../../../src/storage/engines/fs-engine.js';
import { WorldInfoRepo } from '../../../src/storage/repositories/world-info-repo.js';
import { NamedDocRepo } from '../../../src/storage/repositories/named-doc-repo.js';
import { GroupRepo } from '../../../src/storage/repositories/group-repo.js';
import { PresetRepo } from '../../../src/storage/repositories/preset-repo.js';
import { ChatRepo } from '../../../src/storage/repositories/chat-repo.js';
import { preflightNameLengths, formatPreflightOffenders } from '../../../src/storage/migration/preflight.js';

describe('preflightNameLengths', () => {
    let tmpDir;
    const handle = 'u';
    let sourceRepos;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-preflight-'));
        const userDir = path.join(tmpDir, handle);
        const dirs = {
            root: userDir,
            worlds: path.join(userDir, 'worlds'),
            themes: path.join(userDir, 'themes'),
            movingUI: path.join(userDir, 'movingUI'),
            quickreplies: path.join(userDir, 'QuickReplies'),
            groups: path.join(userDir, 'groups'),
            groupChats: path.join(userDir, 'group chats'),
            chats: path.join(userDir, 'chats'),
            koboldAI_Settings: path.join(userDir, 'KoboldAI Settings'),
        };
        for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
        const engine = new FsEngine({ directoriesByHandle: () => dirs });
        sourceRepos = {
            chat: new ChatRepo({ engine }),
            preset: new PresetRepo({ engine }),
            worldInfo: new WorldInfoRepo({ engine }),
            namedDoc: new NamedDocRepo({ engine }),
            group: new GroupRepo({ engine }),
        };
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('no-op when dstMode is fs', async () => {
        // Even if there were >128-byte names, fs/sqlite have no PK length limit.
        const r = await preflightNameLengths({ dstMode: 'fs', sourceRepos, handles: [handle] });
        expect(r.ok).toBe(true);
    });

    test('no-op when dstMode is sqlite', async () => {
        const r = await preflightNameLengths({ dstMode: 'sqlite', sourceRepos, handles: [handle] });
        expect(r.ok).toBe(true);
    });

    test('returns offenders when world name exceeds 128 bytes (mysql dest)', async () => {
        const longName = 'a'.repeat(129);
        // Bypass the engine put guard (which now rejects this) by writing the
        // file directly — the point of preflight is to catch names that
        // *already* exist on disk before strict validation arrived.
        fs.writeFileSync(
            path.join(tmpDir, handle, 'worlds', `${longName}.json`),
            JSON.stringify({ entries: {} }),
        );
        const r = await preflightNameLengths({
            dstMode: 'mysql',
            sourceRepos,
            handles: [handle],
        });
        expect(r.ok).toBe(false);
        expect(r.offenders).toHaveLength(1);
        expect(r.offenders[0].bucket).toBe('world');
        expect(r.offenders[0].name).toBe(longName);
        expect(r.offenders[0].bytes).toBe(129);
    });

    test('ok when all names fit', async () => {
        fs.writeFileSync(
            path.join(tmpDir, handle, 'worlds', 'Short.json'),
            JSON.stringify({ entries: {} }),
        );
        const r = await preflightNameLengths({
            dstMode: 'postgres',
            sourceRepos,
            handles: [handle],
        });
        expect(r.ok).toBe(true);
    });

    test('formatPreflightOffenders surfaces handle, bucket, name, byte count', () => {
        const out = formatPreflightOffenders([
            { handle: 'alice', bucket: 'world', name: 'X'.repeat(130), bytes: 130 },
        ]);
        expect(out).toContain('alice');
        expect(out).toContain('world');
        expect(out).toContain('130 bytes');
    });
});
