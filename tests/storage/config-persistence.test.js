import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    persistStorageBackendToConfig,
    rewriteStorageBlock,
    resolveStorageDbConfig,
} from '../../src/storage/config-persistence.js';

const PASS_SAFETY = () => ({ codes: [], errors: [] });

const SAMPLE = `# Luker config
dataRoot: ./data

# storage block
storage:
  mode: fs          # 'fs' | 'sqlite' | 'mysql' | 'postgres'
  mysql:
    url: mysql://user:pass@host:3306/luker
    poolSize: 10
  postgres:
    url: postgresql://user:pass@host:5432/luker
    poolSize: 10

listen: false
`;

describe('rewriteStorageBlock — pure transform', () => {
    test('changes mode without touching anything else', () => {
        const out = rewriteStorageBlock(SAMPLE, {
            targetMode: 'sqlite',
            mysqlInline: null,
            postgresInline: null,
        });
        // mode flipped
        expect(out).toMatch(/^\s*mode: sqlite/m);
        // every other surrounding key is still there
        expect(out).toContain('dataRoot: ./data');
        expect(out).toContain('listen: false');
        expect(out).toContain('mysql://user:pass@host:3306/luker');
        expect(out).toContain('postgresql://user:pass@host:5432/luker');
    });

    test('preserves top-level and storage block comments', () => {
        const out = rewriteStorageBlock(SAMPLE, {
            targetMode: 'mysql',
            mysqlInline: { url: 'mysql://a:b@db:3306/x' },
            postgresInline: null,
        });
        expect(out).toContain('# Luker config');
        expect(out).toContain('# storage block');
        // Inline enum hint after `mode:` survives (yaml v2 keeps trailing comments).
        expect(out).toMatch(/mode: mysql[^\n]*'fs' \| 'sqlite' \| 'mysql' \| 'postgres'/);
    });

    test('mysql inline url overrides existing url, leaves poolSize alone', () => {
        const out = rewriteStorageBlock(SAMPLE, {
            targetMode: 'mysql',
            mysqlInline: { url: 'mysql://new:pw@db:3306/foo' },
            postgresInline: null,
        });
        expect(out).toContain('mysql://new:pw@db:3306/foo');
        expect(out).not.toContain('mysql://user:pass@host:3306/luker');
        // poolSize untouched
        expect(out).toMatch(/mysql:[\s\S]*?poolSize: 10/);
    });

    test('mysql inline poolSize without url leaves existing url intact', () => {
        const out = rewriteStorageBlock(SAMPLE, {
            targetMode: 'mysql',
            mysqlInline: { poolSize: 25 },
            postgresInline: null,
        });
        expect(out).toContain('mysql://user:pass@host:3306/luker');
        expect(out).toMatch(/mysql:[\s\S]*?poolSize: 25/);
    });

    test('postgres inline values do not leak when targetMode is mysql', () => {
        const out = rewriteStorageBlock(SAMPLE, {
            targetMode: 'mysql',
            mysqlInline: { url: 'mysql://x@y/z' },
            postgresInline: { url: 'postgresql://leaked@bad/db' },
        });
        expect(out).not.toContain('leaked');
        // original postgres block untouched
        expect(out).toContain('postgresql://user:pass@host:5432/luker');
    });

    test('creates storage block when missing from input', () => {
        const minimal = 'dataRoot: ./data\nlisten: false\n';
        const out = rewriteStorageBlock(minimal, {
            targetMode: 'mysql',
            mysqlInline: { url: 'mysql://x@y/z', poolSize: 5 },
            postgresInline: null,
        });
        expect(out).toContain('storage:');
        expect(out).toContain('mode: mysql');
        expect(out).toContain('mysql://x@y/z');
        expect(out).toMatch(/poolSize: 5/);
    });
});

describe('persistStorageBackendToConfig — file IO', () => {
    let tmpDir;
    let configPath;

    beforeEach(async () => {
        tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'luker-config-persist-'));
        configPath = path.join(tmpDir, 'config.yaml');
        await fsPromises.writeFile(configPath, SAMPLE, 'utf8');
    });

    afterEach(async () => {
        await fsPromises.rm(tmpDir, { recursive: true, force: true });
    });

    test('happy path: writes new mode, leaves comments intact', async () => {
        const result = await persistStorageBackendToConfig({
            configPath,
            safetyCheck: PASS_SAFETY,
            targetMode: 'sqlite',
            mysqlInline: null,
            postgresInline: null,
        });
        expect(result).toEqual({ ok: true });
        const written = await fsPromises.readFile(configPath, 'utf8');
        expect(written).toMatch(/mode: sqlite/);
        expect(written).toContain('# Luker config');
    });

    test('happy path: mysql inline url + poolSize lands in file', async () => {
        const result = await persistStorageBackendToConfig({
            configPath,
            safetyCheck: PASS_SAFETY,
            targetMode: 'mysql',
            mysqlInline: { url: 'mysql://op:pw@db:3306/luker', poolSize: 25 },
            postgresInline: null,
        });
        expect(result.ok).toBe(true);
        const written = await fsPromises.readFile(configPath, 'utf8');
        expect(written).toContain('mysql://op:pw@db:3306/luker');
        expect(written).toMatch(/poolSize: 25/);
    });

    test('safety gate refuses unsafe rewrite without writing', async () => {
        const beforeContent = await fsPromises.readFile(configPath, 'utf8');
        const result = await persistStorageBackendToConfig({
            configPath,
            safetyCheck: () => ({ codes: ['CONFIG_UNSAFE_NO_AUTH'], errors: ['boom'] }),
            targetMode: 'sqlite',
            mysqlInline: null,
            postgresInline: null,
        });
        expect(result.ok).toBe(false);
        expect(result.error).toContain('config_safety');
        const afterContent = await fsPromises.readFile(configPath, 'utf8');
        expect(afterContent).toBe(beforeContent);
    });

    test('missing config path is reported, not thrown', async () => {
        const result = await persistStorageBackendToConfig({
            configPath: '',
            safetyCheck: PASS_SAFETY,
            targetMode: 'fs',
        });
        expect(result).toEqual({ ok: false, error: 'config_path_missing' });
    });

    test('missing safety check is reported, not thrown', async () => {
        const result = await persistStorageBackendToConfig({
            configPath,
            safetyCheck: null,
            targetMode: 'fs',
        });
        expect(result).toEqual({ ok: false, error: 'safety_check_missing' });
    });

    test('unreadable config path returns ok:false instead of throwing', async () => {
        const result = await persistStorageBackendToConfig({
            configPath: path.join(tmpDir, 'does-not-exist.yaml'),
            safetyCheck: PASS_SAFETY,
            targetMode: 'fs',
        });
        expect(result.ok).toBe(false);
        expect(result.error).toBeTruthy();
    });
});

describe('resolveStorageDbConfig — inline-vs-config fallback', () => {
    test('inline url only — config absent — engine carries inline url, no poolSize', () => {
        const r = resolveStorageDbConfig({
            inline: { url: 'mysql://op:pw@db:3306/x' },
            fromConfig: null,
        });
        expect(r).toEqual({
            engine: { url: 'mysql://op:pw@db:3306/x' },
            inlineFields: { url: 'mysql://op:pw@db:3306/x' },
        });
    });

    test('inline url + poolSize — both marked inline', () => {
        const r = resolveStorageDbConfig({
            inline: { url: 'mysql://op:pw@db:3306/x', poolSize: 25 },
            fromConfig: null,
        });
        expect(r.engine).toEqual({ url: 'mysql://op:pw@db:3306/x', poolSize: 25 });
        expect(r.inlineFields).toEqual({ url: 'mysql://op:pw@db:3306/x', poolSize: 25 });
    });

    test('config-only — inline absent — engine carries config values, inlineFields null', () => {
        const r = resolveStorageDbConfig({
            inline: null,
            fromConfig: { url: 'mysql://cfg@h/db', poolSize: 10 },
        });
        expect(r).toEqual({
            engine: { url: 'mysql://cfg@h/db', poolSize: 10 },
            inlineFields: null,
        });
    });

    test('inline url overrides config url, poolSize falls through from config', () => {
        const r = resolveStorageDbConfig({
            inline: { url: 'mysql://typed@h/db' },
            fromConfig: { url: 'mysql://old@h/db', poolSize: 10 },
        });
        expect(r.engine).toEqual({ url: 'mysql://typed@h/db', poolSize: 10 });
        expect(r.inlineFields).toEqual({ url: 'mysql://typed@h/db' });
    });

    test('inline poolSize overrides config poolSize, url falls through', () => {
        const r = resolveStorageDbConfig({
            inline: { poolSize: 50 },
            fromConfig: { url: 'mysql://cfg@h/db', poolSize: 10 },
        });
        expect(r.engine).toEqual({ url: 'mysql://cfg@h/db', poolSize: 50 });
        expect(r.inlineFields).toEqual({ poolSize: 50 });
    });

    test('neither inline nor config carries a url — returns null', () => {
        expect(resolveStorageDbConfig({ inline: null, fromConfig: null })).toBeNull();
        expect(resolveStorageDbConfig({ inline: {}, fromConfig: {} })).toBeNull();
        expect(resolveStorageDbConfig({ inline: { poolSize: 10 }, fromConfig: null })).toBeNull();
    });

    test('empty-string url is rejected (treated as absent)', () => {
        const r = resolveStorageDbConfig({
            inline: { url: '' },
            fromConfig: { url: 'mysql://cfg@h/db' },
        });
        expect(r.engine).toEqual({ url: 'mysql://cfg@h/db' });
        // Empty inline url is NOT counted as an inline override.
        expect(r.inlineFields).toBeNull();
    });

    test('non-finite poolSize is rejected from both sides', () => {
        const r = resolveStorageDbConfig({
            inline: { url: 'mysql://op@h/db', poolSize: 'NaN' },
            fromConfig: { poolSize: Infinity },
        });
        expect(r.engine).toEqual({ url: 'mysql://op@h/db' });
        expect(r.engine.poolSize).toBeUndefined();
        expect(r.inlineFields).toEqual({ url: 'mysql://op@h/db' });
    });

    test('non-object inline/config inputs are ignored', () => {
        expect(resolveStorageDbConfig({ inline: 'not-an-object', fromConfig: null })).toBeNull();
        expect(resolveStorageDbConfig({
            inline: null,
            fromConfig: 'not-an-object',
        })).toBeNull();
    });

    test('poolSize=0 is honored as a finite override', () => {
        // Number.isFinite(0) is true; 0 is a legitimate value here (no pool).
        const r = resolveStorageDbConfig({
            inline: { url: 'mysql://op@h/db', poolSize: 0 },
            fromConfig: { poolSize: 10 },
        });
        expect(r.engine.poolSize).toBe(0);
        expect(r.inlineFields).toEqual({ url: 'mysql://op@h/db', poolSize: 0 });
    });
});
