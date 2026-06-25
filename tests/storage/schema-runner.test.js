import { runMigrations, runMigrationsSync } from '../../src/storage/engines/schema-runner.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('runMigrations (async)', () => {
    let tmpDir;
    let migDir;
    let version;
    let executed;
    const executor = (sql) => { executed.push(sql); return Promise.resolve(); };
    const readVersion = () => Promise.resolve(version);
    const writeVersion = (n) => { version = n; return Promise.resolve(); };

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-runner-'));
        migDir = path.join(tmpDir, 'mysql');
        fs.mkdirSync(migDir, { recursive: true });
        version = 0;
        executed = [];
    });

    afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

    test('applies all migrations from 0', async () => {
        fs.writeFileSync(path.join(migDir, '0001-init.sql'), 'SQL_ONE');
        fs.writeFileSync(path.join(migDir, '0002-add.sql'), 'SQL_TWO');
        await runMigrations({
            kind: 'mysql',
            executor,
            migrationsDir: tmpDir,
            readVersion,
            writeVersion,
        });
        expect(executed).toEqual(['SQL_ONE', 'SQL_TWO']);
        expect(version).toBe(2);
    });

    test('applies only newer migrations', async () => {
        fs.writeFileSync(path.join(migDir, '0001-init.sql'), 'SQL_ONE');
        fs.writeFileSync(path.join(migDir, '0002-add.sql'), 'SQL_TWO');
        fs.writeFileSync(path.join(migDir, '0003-more.sql'), 'SQL_THREE');
        version = 2;
        await runMigrations({
            kind: 'mysql',
            executor,
            migrationsDir: tmpDir,
            readVersion,
            writeVersion,
        });
        expect(executed).toEqual(['SQL_THREE']);
        expect(version).toBe(3);
    });

    test('no-op when up to date', async () => {
        fs.writeFileSync(path.join(migDir, '0001-init.sql'), 'X');
        version = 1;
        await runMigrations({
            kind: 'mysql',
            executor,
            migrationsDir: tmpDir,
            readVersion,
            writeVersion,
        });
        expect(executed).toEqual([]);
        expect(version).toBe(1);
    });

    test('throws if executor fails and does not advance version', async () => {
        fs.writeFileSync(path.join(migDir, '0001-init.sql'), 'BAD');
        const badExecutor = () => Promise.reject(new Error('syntax error'));
        await expect(runMigrations({
            kind: 'mysql',
            executor: badExecutor,
            migrationsDir: tmpDir,
            readVersion,
            writeVersion,
        })).rejects.toThrow('syntax error');
        expect(version).toBe(0);
    });

    test('throws on schema version higher than max known', async () => {
        fs.writeFileSync(path.join(migDir, '0001-init.sql'), 'X');
        version = 99;
        await expect(runMigrations({
            kind: 'mysql',
            executor,
            migrationsDir: tmpDir,
            readVersion,
            writeVersion,
        })).rejects.toThrow(/schema version 99 is newer than max known migration 1/);
    });

    test('sorts numerically not lexically (0010 > 0002)', async () => {
        fs.writeFileSync(path.join(migDir, '0002-second.sql'), 'TWO');
        fs.writeFileSync(path.join(migDir, '0010-tenth.sql'), 'TEN');
        await runMigrations({
            kind: 'mysql',
            executor,
            migrationsDir: tmpDir,
            readVersion,
            writeVersion,
        });
        expect(executed).toEqual(['TWO', 'TEN']);
        expect(version).toBe(10);
    });

    test('skips files not matching NNNN-*.sql', async () => {
        fs.writeFileSync(path.join(migDir, '0001-init.sql'), 'OK');
        fs.writeFileSync(path.join(migDir, 'README.md'), '...');
        fs.writeFileSync(path.join(migDir, 'broken.sql'), '...');
        await runMigrations({
            kind: 'mysql',
            executor,
            migrationsDir: tmpDir,
            readVersion,
            writeVersion,
        });
        expect(executed).toEqual(['OK']);
        expect(version).toBe(1);
    });

    test('tolerates a missing migrations directory (treats as empty)', async () => {
        // No files written, directory for the kind doesn't exist.
        const otherMigDir = path.join(tmpDir, 'kind-not-on-disk');
        // Use a kind that has no directory; the helper above only made `mysql/`.
        await runMigrations({
            kind: 'never-created',
            executor,
            migrationsDir: tmpDir,
            readVersion,
            writeVersion,
        });
        expect(executed).toEqual([]);
        expect(version).toBe(0);
        // Sanity: we intentionally did not create otherMigDir.
        expect(fs.existsSync(otherMigDir)).toBe(false);
    });
});

describe('runMigrationsSync (sync, for better-sqlite3 callers)', () => {
    let tmpDir;
    let migDir;
    let version;
    let executed;
    const executor = (sql) => { executed.push(sql); };
    const readVersion = () => version;
    const writeVersion = (n) => { version = n; };

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-runner-sync-'));
        migDir = path.join(tmpDir, 'sqlite');
        fs.mkdirSync(migDir, { recursive: true });
        version = 0;
        executed = [];
    });

    afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

    test('applies all migrations synchronously and updates version', () => {
        fs.writeFileSync(path.join(migDir, '0001-init.sql'), 'SQL_ONE');
        fs.writeFileSync(path.join(migDir, '0002-add.sql'), 'SQL_TWO');
        runMigrationsSync({
            kind: 'sqlite',
            executor,
            migrationsDir: tmpDir,
            readVersion,
            writeVersion,
        });
        expect(executed).toEqual(['SQL_ONE', 'SQL_TWO']);
        expect(version).toBe(2);
    });

    test('no-op when up to date', () => {
        fs.writeFileSync(path.join(migDir, '0001-init.sql'), 'X');
        version = 1;
        runMigrationsSync({
            kind: 'sqlite',
            executor,
            migrationsDir: tmpDir,
            readVersion,
            writeVersion,
        });
        expect(executed).toEqual([]);
        expect(version).toBe(1);
    });

    test('throws on schema version higher than max known', () => {
        fs.writeFileSync(path.join(migDir, '0001-init.sql'), 'X');
        version = 7;
        expect(() => runMigrationsSync({
            kind: 'sqlite',
            executor,
            migrationsDir: tmpDir,
            readVersion,
            writeVersion,
        })).toThrow(/schema version 7 is newer than max known migration 1/);
    });

    test('throws if executor fails and does not advance version', () => {
        fs.writeFileSync(path.join(migDir, '0001-init.sql'), 'BAD');
        const badExecutor = () => { throw new Error('syntax error'); };
        expect(() => runMigrationsSync({
            kind: 'sqlite',
            executor: badExecutor,
            migrationsDir: tmpDir,
            readVersion,
            writeVersion,
        })).toThrow('syntax error');
        expect(version).toBe(0);
    });
});
