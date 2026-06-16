import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import pg from 'pg';
import { initStorage, getStorageEngine } from '../../src/storage/index.js';
import { FsEngine } from '../../src/storage/engines/fs-engine.js';
import { SqliteEngine } from '../../src/storage/engines/sqlite-engine.js';
import { MysqlEngine } from '../../src/storage/engines/mysql-engine.js';
import { PgEngine } from '../../src/storage/engines/postgres-engine.js';

// Live-container settings mirror tests/storage/harness/{mysql,pg}-harness.js so
// the smoke tests fail in the same conditions as the contract suite.
const MYSQL_ROOT_URL = process.env.LUKER_TEST_MYSQL_ROOT_URL || 'mysql://root:root@127.0.0.1:53306';
const PG_ROOT_URL = process.env.LUKER_TEST_POSTGRES_URL || 'postgresql://luker:postgres@127.0.0.1:55432/luker_test';
const skipMysql = !!process.env.LUKER_DISABLE_MYSQL_TESTS;
const skipPostgres = !!process.env.LUKER_DISABLE_POSTGRES_TESTS;

describe('initStorage mode switch', () => {
    let tmpDir;
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-init-mode-'));
    });
    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('default mode is fs (FsEngine)', () => {
        initStorage({ directoriesByHandle: () => ({ root: tmpDir }) });
        expect(getStorageEngine()).toBeInstanceOf(FsEngine);
    });

    test('mode: "fs" picks FsEngine', () => {
        initStorage({ mode: 'fs', directoriesByHandle: () => ({ root: tmpDir }) });
        expect(getStorageEngine()).toBeInstanceOf(FsEngine);
    });

    test('mode: "sqlite" picks SqliteEngine', () => {
        initStorage({ mode: 'sqlite', directoriesByHandle: () => ({ root: tmpDir }) });
        expect(getStorageEngine()).toBeInstanceOf(SqliteEngine);
        // Cleanup any db handle
        const e = getStorageEngine();
        e.close();
    });

    test('mode: "unknown" throws', () => {
        expect(() => initStorage({ mode: 'unknown', directoriesByHandle: () => ({ root: tmpDir }) }))
            .toThrow(/unknown storage mode/);
    });

    test('re-init replaces engine', () => {
        initStorage({ mode: 'fs', directoriesByHandle: () => ({ root: tmpDir }) });
        const e1 = getStorageEngine();
        initStorage({ mode: 'sqlite', directoriesByHandle: () => ({ root: tmpDir }) });
        const e2 = getStorageEngine();
        expect(e1).not.toBe(e2);
        expect(e2).toBeInstanceOf(SqliteEngine);
        e2.close();
    });

    test('mode: "mysql" without storage.mysql.url throws', () => {
        expect(() => initStorage({ mode: 'mysql', directoriesByHandle: () => ({ root: tmpDir }) }))
            .toThrow(/mode=mysql requires storage\.mysql\.url/);
        expect(() => initStorage({
            mode: 'mysql',
            directoriesByHandle: () => ({ root: tmpDir }),
            mysql: {},
        })).toThrow(/mode=mysql requires storage\.mysql\.url/);
    });

    test('mode: "postgres" without storage.postgres.url throws', () => {
        expect(() => initStorage({ mode: 'postgres', directoriesByHandle: () => ({ root: tmpDir }) }))
            .toThrow(/mode=postgres requires storage\.postgres\.url/);
        expect(() => initStorage({
            mode: 'postgres',
            directoriesByHandle: () => ({ root: tmpDir }),
            postgres: {},
        })).toThrow(/mode=postgres requires storage\.postgres\.url/);
    });
});

// Live-container smoke. Each successful-construction case creates a fresh
// engine, pings to prove the pool round-trips through the real DB, then closes
// to release the pool. We provision and tear down throw-away databases /
// schemas so the suite leaves no residue and can run repeatedly.
const describeMysql = skipMysql ? describe.skip : describe;
describeMysql('initStorage mode: "mysql" against live container', () => {
    let dbName;
    let url;

    beforeEach(async () => {
        dbName = `luker_test_init_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
        const rootConn = await mysql.createConnection(MYSQL_ROOT_URL);
        try {
            await rootConn.query(
                `CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
            );
        } finally {
            await rootConn.end();
        }
        url = `${MYSQL_ROOT_URL}/${dbName}`;
    });

    afterEach(async () => {
        // Engine close happens inside each test (so even thrown-construction
        // cases don't leak); the database itself goes away here.
        const c = await mysql.createConnection(MYSQL_ROOT_URL);
        try { await c.query(`DROP DATABASE IF EXISTS \`${dbName}\``); }
        finally { await c.end(); }
    });

    test('mode: "mysql" with storage.mysql.url picks MysqlEngine and pings', async () => {
        initStorage({
            mode: 'mysql',
            directoriesByHandle: () => ({ root: '/tmp' }),
            mysql: { url },
        });
        const engine = getStorageEngine();
        try {
            expect(engine).toBeInstanceOf(MysqlEngine);
            await expect(engine.ping('u')).resolves.toBeUndefined();
        } finally {
            await engine.close();
        }
    });
});

const describePostgres = skipPostgres ? describe.skip : describe;
describePostgres('initStorage mode: "postgres" against live container', () => {
    let schemaName;
    let url;

    beforeEach(async () => {
        schemaName = `luker_test_init_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
        const rootClient = new pg.Client({ connectionString: PG_ROOT_URL });
        await rootClient.connect();
        try {
            await rootClient.query(`CREATE SCHEMA "${schemaName}"`);
        } finally {
            await rootClient.end();
        }
        url = `${PG_ROOT_URL}?options=-csearch_path%3D${encodeURIComponent(schemaName)}`;
    });

    afterEach(async () => {
        const c = new pg.Client({ connectionString: PG_ROOT_URL });
        await c.connect();
        try { await c.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`); }
        finally { await c.end(); }
    });

    test('mode: "postgres" with storage.postgres.url picks PgEngine and pings', async () => {
        initStorage({
            mode: 'postgres',
            directoriesByHandle: () => ({ root: '/tmp' }),
            postgres: { url },
        });
        const engine = getStorageEngine();
        try {
            expect(engine).toBeInstanceOf(PgEngine);
            await expect(engine.ping('u')).resolves.toBeUndefined();
        } finally {
            await engine.close();
        }
    });
});
