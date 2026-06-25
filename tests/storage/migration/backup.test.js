import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshotUser } from '../../../src/storage/migration/backup.js';

describe('snapshotUser', () => {
    let tmpRoot;
    beforeEach(() => { tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-backup-')); });
    afterEach(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

    test('creates a timestamped backup directory containing source contents', async () => {
        const userRoot = path.join(tmpRoot, 'u');
        fs.mkdirSync(path.join(userRoot, 'chats', 'TestChar'), { recursive: true });
        fs.writeFileSync(path.join(userRoot, 'chats', 'TestChar', 'chat1.jsonl'), 'line1\nline2\n');
        fs.writeFileSync(path.join(userRoot, 'settings.json'), '{"x":1}');
        const backupRoot = path.join(tmpRoot, '_storage-migrations');

        const dest = await snapshotUser({ handle: 'u', userRoot, backupRoot });

        expect(fs.existsSync(dest)).toBe(true);
        expect(path.basename(dest)).toMatch(/-u$/);
        expect(fs.readFileSync(path.join(dest, 'settings.json'), 'utf-8')).toBe('{"x":1}');
        expect(fs.readFileSync(path.join(dest, 'chats', 'TestChar', 'chat1.jsonl'), 'utf-8'))
            .toBe('line1\nline2\n');
    });

    test('throws when source userRoot missing', async () => {
        await expect(snapshotUser({
            handle: 'u',
            userRoot: path.join(tmpRoot, 'nonexistent'),
            backupRoot: path.join(tmpRoot, 'backup'),
        })).rejects.toThrow(/does not exist/);
    });

    test('throws when required arg missing', async () => {
        await expect(snapshotUser({ handle: 'u', userRoot: tmpRoot })).rejects.toThrow(/backupRoot/);
        await expect(snapshotUser({ handle: 'u', backupRoot: tmpRoot })).rejects.toThrow(/userRoot/);
        await expect(snapshotUser({ userRoot: tmpRoot, backupRoot: tmpRoot })).rejects.toThrow(/handle/);
    });

    test('creates backupRoot recursively if missing', async () => {
        const userRoot = path.join(tmpRoot, 'u');
        fs.mkdirSync(userRoot, { recursive: true });
        const backupRoot = path.join(tmpRoot, 'deep', 'nested', 'backup');

        const dest = await snapshotUser({ handle: 'u', userRoot, backupRoot });
        expect(fs.existsSync(backupRoot)).toBe(true);
        expect(fs.existsSync(dest)).toBe(true);
    });

    test('two snapshots produce distinct dirs (clock-advanced timestamps)', async () => {
        const userRoot = path.join(tmpRoot, 'u');
        fs.mkdirSync(userRoot, { recursive: true });
        const backupRoot = path.join(tmpRoot, 'backup');

        const first = await snapshotUser({ handle: 'u', userRoot, backupRoot });
        await new Promise((r) => setTimeout(r, 5));
        const second = await snapshotUser({ handle: 'u', userRoot, backupRoot });
        expect(first).not.toBe(second);
        expect(fs.existsSync(first)).toBe(true);
        expect(fs.existsSync(second)).toBe(true);
    });

    test('preserves binary content (e.g. a sqlite-like blob)', async () => {
        const userRoot = path.join(tmpRoot, 'u');
        fs.mkdirSync(userRoot, { recursive: true });
        const blob = Buffer.from([0x00, 0x01, 0xFF, 0xAB, 0xCD]);
        fs.writeFileSync(path.join(userRoot, 'luker-storage.sqlite'), blob);
        const dest = await snapshotUser({
            handle: 'u',
            userRoot,
            backupRoot: path.join(tmpRoot, 'backup'),
        });
        const restored = fs.readFileSync(path.join(dest, 'luker-storage.sqlite'));
        expect(restored.equals(blob)).toBe(true);
    });

    test('timestamp is filename-safe (no colons or dots)', async () => {
        const userRoot = path.join(tmpRoot, 'u');
        fs.mkdirSync(userRoot, { recursive: true });
        const dest = await snapshotUser({
            handle: 'u',
            userRoot,
            backupRoot: path.join(tmpRoot, 'backup'),
        });
        const base = path.basename(dest);
        expect(base).not.toMatch(/[:.]/);
    });
});
