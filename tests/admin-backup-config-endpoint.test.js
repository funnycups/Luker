import { afterEach, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import express from 'express';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { ensureRun, trackScope } from './harness/jest-run.js';
import { getConfigValue, reloadConfigCache, setConfigFilePath } from '../src/util.js';
import { router as usersAdminRouter } from '../src/endpoints/users-admin.js';

const SAMPLE_CONFIG = `# Server config
dataRoot: ./data
listen: false
whitelistMode: true

# Backup section
backups:
  allowFullDataBackup: true
  common:
    numberOfBackups: 50 # per-chat retention
  chat:
    enabled: true
    checkIntegrity: true
    maxTotalBackups: -1
    throttleInterval: 10000
`;

function buildApp({ admin }) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { profile: { handle: admin ? 'admin' : 'member', admin } };
        next();
    });
    app.use('/api/users', usersAdminRouter);
    return app;
}

describe('users-admin /backups/config/{get,save}', () => {
    let tmpDir;
    let configPath;
    const touchedEnvKeys = [
        'LUKER_BACKUPS_COMMON_NUMBEROFBACKUPS',
        'SILLYTAVERN_BACKUPS_COMMON_NUMBEROFBACKUPS',
    ];
    let savedEnv;

    beforeAll(async () => {
        const run = await ensureRun();
        const scope = trackScope(await run.scope({ kind: 'scenario', label: 'admin-backup-config-endpoint' }));
        tmpDir = (await scope.directory('luker-admin-backups')).path;
        configPath = path.join(tmpDir, 'config.yaml');
        await fsPromises.writeFile(configPath, SAMPLE_CONFIG, 'utf8');
        setConfigFilePath(configPath);
        reloadConfigCache();
    });

    beforeEach(async () => {
        savedEnv = Object.fromEntries(touchedEnvKeys.map(k => [k, process.env[k]]));
        for (const k of touchedEnvKeys) delete process.env[k];
        await fsPromises.writeFile(configPath, SAMPLE_CONFIG, 'utf8');
        reloadConfigCache();
    });

    afterEach(() => {
        for (const k of touchedEnvKeys) {
            if (savedEnv[k] === undefined) delete process.env[k];
            else process.env[k] = savedEnv[k];
        }
    });

    test('rejects non-admin users with 403 on get and save', async () => {
        const app = buildApp({ admin: false });
        const getRes = await request(app).post('/api/users/backups/config/get').send({});
        expect(getRes.status).toBe(403);

        const saveRes = await request(app).post('/api/users/backups/config/save').send({
            allowFullDataBackup: true,
            common: { numberOfBackups: 10 },
            chat: { enabled: true, checkIntegrity: true, maxTotalBackups: -1, throttleInterval: 10000 },
        });
        expect(saveRes.status).toBe(403);
    });

    test('admin get returns fileConfig, effectiveConfig, and active envOverrides', async () => {
        process.env.LUKER_BACKUPS_COMMON_NUMBEROFBACKUPS = '7';
        const app = buildApp({ admin: true });

        const res = await request(app).post('/api/users/backups/config/get').send({});
        expect(res.status).toBe(200);
        expect(res.body.fileConfig.common.numberOfBackups).toBe(50);
        expect(res.body.effectiveConfig.common.numberOfBackups).toBe(7);
        expect(res.body.envOverrides).toEqual({
            'backups.common.numberOfBackups': {
                envKey: 'LUKER_BACKUPS_COMMON_NUMBEROFBACKUPS',
                value: 7,
            },
        });
    });

    test('admin save persists to config.yaml with comments preserved and reloads cache immediately', async () => {
        const app = buildApp({ admin: true });
        const payload = {
            allowFullDataBackup: false,
            common: { numberOfBackups: 12 },
            chat: {
                enabled: false,
                checkIntegrity: false,
                maxTotalBackups: 40,
                throttleInterval: 2500,
            },
        };

        const res = await request(app).post('/api/users/backups/config/save').send(payload);
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.fileConfig).toEqual(payload);
        expect(res.body.effectiveConfig).toEqual(payload);

        // Live cache was reloaded immediately without server restart.
        expect(getConfigValue('backups.common.numberOfBackups', 50, 'number')).toBe(12);
        expect(getConfigValue('backups.chat.enabled', true, 'boolean')).toBe(false);
        expect(getConfigValue('backups.chat.maxTotalBackups', -1, 'number')).toBe(40);
        expect(getConfigValue('backups.chat.throttleInterval', 10000, 'number')).toBe(2500);
        expect(getConfigValue('backups.allowFullDataBackup', true, 'boolean')).toBe(false);

        const onDisk = await fsPromises.readFile(configPath, 'utf8');
        expect(onDisk).toContain('# Server config');
        expect(onDisk).toContain('# Backup section');
        expect(onDisk).toMatch(/numberOfBackups: 12[^\n]*# per-chat retention/);
    });

    test.each([
        ['negative numberOfBackups', { allowFullDataBackup: true, common: { numberOfBackups: -1 }, chat: { enabled: true, checkIntegrity: true, maxTotalBackups: -1, throttleInterval: 10000 } }],
        ['float throttleInterval', { allowFullDataBackup: true, common: { numberOfBackups: 50 }, chat: { enabled: true, checkIntegrity: true, maxTotalBackups: -1, throttleInterval: 12.5 } }],
        ['string boolean', { allowFullDataBackup: 'false', common: { numberOfBackups: 50 }, chat: { enabled: true, checkIntegrity: true, maxTotalBackups: -1, throttleInterval: 10000 } }],
        ['maxTotalBackups below -1', { allowFullDataBackup: true, common: { numberOfBackups: 50 }, chat: { enabled: true, checkIntegrity: true, maxTotalBackups: -2, throttleInterval: 10000 } }],
    ])('admin save rejects invalid payload (%s) with 400 and leaves disk/cache untouched', async (_label, badPayload) => {
        const app = buildApp({ admin: true });
        const beforeDisk = await fsPromises.readFile(configPath, 'utf8');

        const res = await request(app).post('/api/users/backups/config/save').send(badPayload);
        expect(res.status).toBe(400);
        expect(typeof res.body.error).toBe('string');
        expect(res.body.error.length).toBeGreaterThan(0);

        const afterDisk = await fsPromises.readFile(configPath, 'utf8');
        expect(afterDisk).toBe(beforeDisk);
        expect(getConfigValue('backups.common.numberOfBackups', 50, 'number')).toBe(50);
    });

    test('admin save returns 400 with safety codes and does not write when config.yaml is unsafe', async () => {
        const unsafeConfig = [
            'dataRoot: ./data',
            'listen: true',
            'whitelistMode: false',
            'basicAuthMode: false',
            'enableUserAccounts: false',
            'securityOverride: false',
            'backups:',
            '  common:',
            '    numberOfBackups: 50',
            '',
        ].join('\n');
        await fsPromises.writeFile(configPath, unsafeConfig, 'utf8');
        reloadConfigCache();

        const app = buildApp({ admin: true });
        const res = await request(app).post('/api/users/backups/config/save').send({
            allowFullDataBackup: true,
            common: { numberOfBackups: 25 },
            chat: { enabled: true, checkIntegrity: true, maxTotalBackups: -1, throttleInterval: 10000 },
        });
        expect(res.status).toBe(400);
        expect(res.body.codes).toEqual(['CONFIG_UNSAFE_NO_AUTH']);

        const afterDisk = await fsPromises.readFile(configPath, 'utf8');
        expect(afterDisk).toBe(unsafeConfig);
    });
});
