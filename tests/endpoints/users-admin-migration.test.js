import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import storage from 'node-persist';
import yaml from 'yaml';

import { router as usersAdminRouter } from '../../src/endpoints/users-admin.js';
import {
    getStorageEngine,
    getSettingsRepo,
    getWorldInfoRepo,
    initStorage,
    isReadOnly,
} from '../../src/storage/index.js';
import { getUserDirectories, toKey } from '../../src/users.js';
import { getConfigFilePath, reloadConfigCache, setConfigFilePath } from '../../src/util.js';

let handleSeq = 0;
function uniqueHandle(prefix) {
    handleSeq += 1;
    return `${prefix}_${process.pid}_${handleSeq}`;
}

function makeApp({ admin = true, handle = 'admin' } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = {
            profile: {
                handle,
                admin,
                enabled: true,
                name: handle,
                created: 0,
                password: '',
                salt: '',
            },
        };
        next();
    });
    app.use(usersAdminRouter);
    return app;
}

async function registerUsers(handles) {
    for (const handle of handles) {
        const dirs = getUserDirectories(handle);
        for (const dirPath of Object.values(dirs)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }
        await storage.setItem(toKey(handle), {
            handle,
            name: handle,
            created: 0,
            password: '',
            salt: '',
            admin: false,
            enabled: true,
        });
    }
}

async function seedUserData(handle, marker) {
    await getSettingsRepo().save(handle, { user_name: `name_${marker}`, marker });
    await getWorldInfoRepo().save(handle, `lore_${marker}`, {
        entries: {
            0: { uid: 0, key: [marker], content: `entry_${marker}` },
        },
    });
}

describe('POST /storage/migrate against real FsEngine, SqliteEngine, and MigrationRunner', () => {
    let tempRoot = null;
    let prevDataRoot;
    let prevConfigPath;
    let configPath;

    beforeEach(async () => {
        prevDataRoot = globalThis.DATA_ROOT;
        prevConfigPath = getConfigFilePath();

        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-admin-migrate-'));
        const dataRoot = path.join(tempRoot, 'data');
        fs.mkdirSync(dataRoot, { recursive: true });

        configPath = path.join(tempRoot, 'config.yaml');
        fs.writeFileSync(configPath, yaml.stringify({
            dataRoot,
            enableUserAccounts: true,
            storage: { mode: 'fs' },
        }), 'utf8');

        setConfigFilePath(configPath);
        reloadConfigCache();
        globalThis.DATA_ROOT = dataRoot;

        await storage.init({
            dir: path.join(dataRoot, '_storage'),
            ttl: false,
            expiredInterval: 0,
        });

        await initStorage({
            mode: 'fs',
            directoriesByHandle: getUserDirectories,
        });

        await request(makeApp()).post('/storage/migrate/reset').send({ confirm: true });
    });

    afterEach(async () => {
        await request(makeApp()).post('/storage/migrate/reset').send({ confirm: true });
        const engine = getStorageEngine();
        if (engine?.close) {
            await engine.close();
        }
        globalThis.DATA_ROOT = prevDataRoot;
        setConfigFilePath(prevConfigPath);
        reloadConfigCache();
        if (tempRoot) {
            fs.rmSync(tempRoot, { recursive: true, force: true });
            tempRoot = null;
        }
    });

    test('migrates multiple real users from fs to sqlite, persists config, swaps live engine, and round-trips back to fs', async () => {
        const handles = [uniqueHandle('mig_a'), uniqueHandle('mig_b'), uniqueHandle('mig_c')];
        await registerUsers(handles);
        for (let i = 0; i < handles.length; i += 1) {
            await seedUserData(handles[i], `u${i}`);
        }

        const app = makeApp();
        const res = await request(app)
            .post('/storage/migrate')
            .send({ targetMode: 'sqlite' });

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.currentMode).toBe('sqlite');
        expect(res.body.configPersisted).toBe(true);
        expect(getStorageEngine().kind).toBe('sqlite');
        expect(isReadOnly()).toBe(false);
        expect(fs.existsSync(path.join(globalThis.DATA_ROOT, '_migration.lock'))).toBe(false);

        for (let i = 0; i < handles.length; i += 1) {
            expect(res.body.perUser[handles[i]].status).toBe('done');
            const settings = await getSettingsRepo().get(handles[i]);
            expect(settings.marker).toBe(`u${i}`);
            const world = await getWorldInfoRepo().get(handles[i], `lore_u${i}`);
            expect(world.entries['0'].content).toBe(`entry_u${i}`);
        }

        const persistedCfg = yaml.parse(fs.readFileSync(configPath, 'utf8'));
        expect(persistedCfg.storage.mode).toBe('sqlite');

        const statusRes = await request(app).post('/storage/status').send({});
        expect(statusRes.status).toBe(200);
        expect(statusRes.body.currentMode).toBe('sqlite');
        expect(statusRes.body.migrationInProgress).toBe(false);
        expect(statusRes.body.readOnly).toBe(false);
        expect(statusRes.body.state).toBeNull();

        // Round-trip back from sqlite to fs
        const backRes = await request(app)
            .post('/storage/migrate')
            .send({ targetMode: 'fs' });
        expect(backRes.status).toBe(200);
        expect(backRes.body.ok).toBe(true);
        expect(backRes.body.currentMode).toBe('fs');
        expect(getStorageEngine().kind).toBe('fs');
        const roundTripSettings = await getSettingsRepo().get(handles[0]);
        expect(roundTripSettings.marker).toBe('u0');
    });

    test('partial failure retains source engine, preserves state, releases lock/read-only, and resumes only failed user after repair', async () => {
        const [a, b, c] = [uniqueHandle('res_a'), uniqueHandle('res_b'), uniqueHandle('res_c')];
        await registerUsers([a, b, c]);
        await seedUserData(a, 'ok_a');
        await seedUserData(b, 'ok_b');
        await seedUserData(c, 'ok_c');

        // Corrupt user b's settings.json on disk so real FsEngine read fails during MigrationRunner copy.
        const bSettingsPath = path.join(getUserDirectories(b).root, 'settings.json');
        fs.writeFileSync(bSettingsPath, '{ invalid json', 'utf8');

        const app = makeApp();
        const failRes = await request(app)
            .post('/storage/migrate')
            .send({ targetMode: 'sqlite' });

        expect(failRes.status).toBe(500);
        expect(failRes.body.ok).toBe(false);
        expect(failRes.body.currentMode).toBe('fs');
        expect(failRes.body.perUser[a].status).toBe('done');
        expect(failRes.body.perUser[b].status).toBe('failed');
        expect(failRes.body.perUser[b].error).toBeTruthy();
        expect(failRes.body.perUser[c].status).toBe('done');
        expect(getStorageEngine().kind).toBe('fs');
        expect(isReadOnly()).toBe(false);
        expect(fs.existsSync(path.join(globalThis.DATA_ROOT, '_migration.lock'))).toBe(false);

        const statusRes = await request(app).post('/storage/status').send({});
        expect(statusRes.body.migrationInProgress).toBe(false);
        expect(statusRes.body.state).not.toBeNull();
        expect(statusRes.body.state.perUser[b].status).toBe('failed');
        expect(typeof statusRes.body.state.staleSeconds).toBe('number');
        expect(statusRes.body.state.staleSeconds).toBeGreaterThanOrEqual(0);
        expect(statusRes.body.state.staleSeconds).toBeLessThanOrEqual(5);

        // Switching target while failed state exists returns 409 fingerprint conflict.
        const conflictRes = await request(app)
            .post('/storage/migrate')
            .send({ targetMode: 'mysql', mysql: { url: 'mysql://u:p@127.0.0.1/db' } });
        expect(conflictRes.status).toBe(409);
        expect(conflictRes.body.error).toBe('migration_in_progress_different_target');
        expect(conflictRes.body.currentTargetMode).toBe('sqlite');

        // Repair user b's settings and resume migration with the same target.
        fs.writeFileSync(bSettingsPath, JSON.stringify({ user_name: 'name_repaired_b', marker: 'repaired_b' }), 'utf8');
        const resumeRes = await request(app)
            .post('/storage/migrate')
            .send({ targetMode: 'sqlite' });

        expect(resumeRes.status).toBe(200);
        expect(resumeRes.body.ok).toBe(true);
        expect(resumeRes.body.currentMode).toBe('sqlite');
        expect(resumeRes.body.perUser[a].status).toBe('done');
        expect(resumeRes.body.perUser[b].status).toBe('done');
        expect(resumeRes.body.perUser[c].status).toBe('done');
        expect(getStorageEngine().kind).toBe('sqlite');
        expect((await getSettingsRepo().get(a)).marker).toBe('ok_a');
        expect((await getSettingsRepo().get(b)).marker).toBe('repaired_b');
        expect((await getSettingsRepo().get(c)).marker).toBe('ok_c');
    });

    test('reset requires confirm: true and clears failed migration state', async () => {
        const handle = uniqueHandle('reset_u');
        await registerUsers([handle]);
        fs.writeFileSync(path.join(getUserDirectories(handle).root, 'settings.json'), '{ broken', 'utf8');

        const app = makeApp();
        const noConfirm = await request(app).post('/storage/migrate/reset').send({});
        expect(noConfirm.status).toBe(400);
        expect(noConfirm.body.error).toBe('reset_requires_confirm');

        const failRes = await request(app).post('/storage/migrate').send({ targetMode: 'sqlite' });
        expect(failRes.status).toBe(500);

        let statusRes = await request(app).post('/storage/status').send({});
        expect(statusRes.body.state).not.toBeNull();

        const resetRes = await request(app).post('/storage/migrate/reset').send({ confirm: true });
        expect(resetRes.status).toBe(200);
        expect(resetRes.body.ok).toBe(true);

        statusRes = await request(app).post('/storage/status').send({});
        expect(statusRes.body.state).toBeNull();
    });

    test('refuses pre-existing lock from another holder, rejects invalid/redundant target modes, and enforces admin role', async () => {
        const handle = uniqueHandle('lock_u');
        await registerUsers([handle]);
        await seedUserData(handle, 'locked');

        const app = makeApp();

        // Non-admin rejected
        const nonAdminRes = await request(makeApp({ admin: false })).post('/storage/migrate').send({ targetMode: 'sqlite' });
        expect(nonAdminRes.status).toBe(403);

        // Invalid & already-in-target-mode rejected
        const invalidRes = await request(app).post('/storage/migrate').send({ targetMode: 'bogus' });
        expect(invalidRes.status).toBe(400);
        expect(invalidRes.body.error).toBe('invalid_target_mode');

        const redundantRes = await request(app).post('/storage/migrate').send({ targetMode: 'fs' });
        expect(redundantRes.status).toBe(400);
        expect(redundantRes.body.error).toBe('already_in_target_mode');

        // Pre-existing cross-process lock returns 409 and preserves lock + fs engine
        const lockPath = path.join(globalThis.DATA_ROOT, '_migration.lock');
        fs.writeFileSync(lockPath, JSON.stringify({
            holderId: 'other-host:9999:deadbeef',
            host: 'other-host',
            pid: 9999,
            acquiredAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }, null, 2), 'utf8');

        const lockedRes = await request(app).post('/storage/migrate').send({ targetMode: 'sqlite' });
        expect(lockedRes.status).toBe(409);
        expect(lockedRes.body.error).toBe('migration_locked');
        expect(lockedRes.body.message).toContain('other-host:9999:deadbeef');
        expect(getStorageEngine().kind).toBe('fs');
        expect(JSON.parse(fs.readFileSync(lockPath, 'utf8')).holderId).toBe('other-host:9999:deadbeef');
    });
});
