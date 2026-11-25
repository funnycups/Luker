import { afterEach, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import { ensureRun, trackScope } from './harness/jest-run.js';
import { reloadConfigCache, setConfigFilePath } from '../src/util.js';
import {
    BACKUP_CONFIG_DEFAULTS,
    persistBackupConfig,
    readBackupConfigState,
    rewriteBackupConfigBlock,
    validateBackupConfigPayload,
} from '../src/backup-config.js';

const PASS_SAFETY = () => ({ codes: [], errors: [] });

const SAMPLE = `# Luker config
dataRoot: ./data

## BACKUP CONFIGURATION
backups:
  # Allow users to create a full backup archive of their data
  allowFullDataBackup: true
  # Common settings for all backup types
  common:
    # Number of backups to keep for each chat and settings file
    numberOfBackups: 50 # keep fifty
  chat:
    # Enable automatic chat backups
    enabled: true
    # Verify integrity of chat files before saving
    checkIntegrity: true
    # Maximum number of chat backups to keep per user
    maxTotalBackups: -1
    # Interval in milliseconds to throttle chat backups per user
    throttleInterval: 10000

listen: false
`;

describe('validateBackupConfigPayload', () => {
    test('accepts valid boundary and large integer values', () => {
        const res = validateBackupConfigPayload({
            allowFullDataBackup: false,
            common: { numberOfBackups: 0 },
            chat: {
                enabled: true,
                checkIntegrity: false,
                maxTotalBackups: -1,
                throttleInterval: 0,
            },
        });
        expect(res).toEqual({
            ok: true,
            value: {
                allowFullDataBackup: false,
                common: { numberOfBackups: 0 },
                chat: {
                    enabled: true,
                    checkIntegrity: false,
                    maxTotalBackups: -1,
                    throttleInterval: 0,
                },
            },
        });

        const largeRes = validateBackupConfigPayload({
            allowFullDataBackup: true,
            common: { numberOfBackups: 100000 },
            chat: {
                enabled: false,
                checkIntegrity: true,
                maxTotalBackups: 0,
                throttleInterval: 600000,
            },
        });
        expect(largeRes.ok).toBe(true);
        expect(largeRes.value.common.numberOfBackups).toBe(100000);
        expect(largeRes.value.chat.maxTotalBackups).toBe(0);
    });

    test.each([
        ['non-object body', null, 'object'],
        ['missing common object', { allowFullDataBackup: true, chat: { enabled: true, checkIntegrity: true, maxTotalBackups: -1, throttleInterval: 10000 } }, 'common'],
        ['missing chat object', { allowFullDataBackup: true, common: { numberOfBackups: 50 } }, 'chat'],
        ['string boolean for allowFullDataBackup', { allowFullDataBackup: 'true', common: { numberOfBackups: 50 }, chat: { enabled: true, checkIntegrity: true, maxTotalBackups: -1, throttleInterval: 10000 } }, 'allowFullDataBackup'],
        ['numeric boolean for chat.enabled', { allowFullDataBackup: true, common: { numberOfBackups: 50 }, chat: { enabled: 1, checkIntegrity: true, maxTotalBackups: -1, throttleInterval: 10000 } }, 'chat.enabled'],
        ['null for chat.checkIntegrity', { allowFullDataBackup: true, common: { numberOfBackups: 50 }, chat: { enabled: true, checkIntegrity: null, maxTotalBackups: -1, throttleInterval: 10000 } }, 'chat.checkIntegrity'],
        ['negative numberOfBackups', { allowFullDataBackup: true, common: { numberOfBackups: -1 }, chat: { enabled: true, checkIntegrity: true, maxTotalBackups: -1, throttleInterval: 10000 } }, 'numberOfBackups'],
        ['fractional numberOfBackups', { allowFullDataBackup: true, common: { numberOfBackups: 1.5 }, chat: { enabled: true, checkIntegrity: true, maxTotalBackups: -1, throttleInterval: 10000 } }, 'numberOfBackups'],
        ['NaN numberOfBackups', { allowFullDataBackup: true, common: { numberOfBackups: Number.NaN }, chat: { enabled: true, checkIntegrity: true, maxTotalBackups: -1, throttleInterval: 10000 } }, 'numberOfBackups'],
        ['maxTotalBackups below -1', { allowFullDataBackup: true, common: { numberOfBackups: 50 }, chat: { enabled: true, checkIntegrity: true, maxTotalBackups: -2, throttleInterval: 10000 } }, 'maxTotalBackups'],
        ['fractional maxTotalBackups', { allowFullDataBackup: true, common: { numberOfBackups: 50 }, chat: { enabled: true, checkIntegrity: true, maxTotalBackups: 2.5, throttleInterval: 10000 } }, 'maxTotalBackups'],
        ['negative throttleInterval', { allowFullDataBackup: true, common: { numberOfBackups: 50 }, chat: { enabled: true, checkIntegrity: true, maxTotalBackups: -1, throttleInterval: -1 } }, 'throttleInterval'],
        ['Infinity throttleInterval', { allowFullDataBackup: true, common: { numberOfBackups: 50 }, chat: { enabled: true, checkIntegrity: true, maxTotalBackups: -1, throttleInterval: Number.POSITIVE_INFINITY } }, 'throttleInterval'],
    ])('rejects %s', (_label, payload, expectedField) => {
        const res = validateBackupConfigPayload(payload);
        expect(res.ok).toBe(false);
        expect(res.error).toContain(expectedField);
    });
});

describe('rewriteBackupConfigBlock — pure transform', () => {
    test('updates all six keys while preserving comments and surrounding settings', () => {
        const out = rewriteBackupConfigBlock(SAMPLE, {
            allowFullDataBackup: false,
            common: { numberOfBackups: 12 },
            chat: {
                enabled: false,
                checkIntegrity: false,
                maxTotalBackups: 200,
                throttleInterval: 2500,
            },
        });

        expect(out).toContain('# Luker config');
        expect(out).toContain('## BACKUP CONFIGURATION');
        expect(out).toContain('# Allow users to create a full backup archive of their data');
        expect(out).toMatch(/numberOfBackups: 12[^\n]*# keep fifty/);
        expect(out).toContain('allowFullDataBackup: false');
        expect(out).toContain('enabled: false');
        expect(out).toContain('checkIntegrity: false');
        expect(out).toContain('maxTotalBackups: 200');
        expect(out).toContain('throttleInterval: 2500');
        expect(out).toContain('dataRoot: ./data');
        expect(out).toContain('listen: false');
    });

    test('creates missing backups block cleanly', () => {
        const minimal = '# Keep me\ndataRoot: ./data\nlisten: false\n';
        const out = rewriteBackupConfigBlock(minimal, BACKUP_CONFIG_DEFAULTS);
        expect(out).toContain('# Keep me');
        expect(out).toContain('backups:');
        expect(out).toContain('numberOfBackups: 50');
        expect(out).toContain('throttleInterval: 10000');
    });

    test('replaces null backups or null sub-blocks cleanly', () => {
        const nullRoot = '# Top comment\nbackups: null\nlisten: false\n';
        const outRoot = rewriteBackupConfigBlock(nullRoot, BACKUP_CONFIG_DEFAULTS);
        expect(outRoot).toContain('# Top comment');
        expect(outRoot).toContain('numberOfBackups: 50');
        expect(outRoot).toContain('maxTotalBackups: -1');

        const nullSub = 'backups:\n  common: null\n  chat: null\nlisten: false\n';
        const outSub = rewriteBackupConfigBlock(nullSub, {
            allowFullDataBackup: false,
            common: { numberOfBackups: 7 },
            chat: { enabled: true, checkIntegrity: false, maxTotalBackups: 30, throttleInterval: 500 },
        });
        expect(outSub).toContain('numberOfBackups: 7');
        expect(outSub).toContain('maxTotalBackups: 30');
        expect(outSub).toContain('throttleInterval: 500');
    });
});

describe('readBackupConfigState & persistBackupConfig — file IO', () => {
    let tmpDir;
    let configPath;
    const touchedEnvKeys = [
        'LUKER_BACKUPS_COMMON_NUMBEROFBACKUPS',
        'LUKER_BACKUPS_COMMON_NUMBER_OF_BACKUPS',
        'SILLYTAVERN_BACKUPS_COMMON_NUMBEROFBACKUPS',
        'SILLYTAVERN_BACKUPS_CHAT_ENABLED',
        'LUKER_BACKUPS_CHAT_ENABLED',
    ];
    let savedEnv;

    beforeAll(async () => {
        const run = await ensureRun();
        const scope = trackScope(await run.scope({ kind: 'scenario', label: 'backup-config' }));
        tmpDir = (await scope.directory('luker-backup-cfg')).path;
        configPath = path.join(tmpDir, 'config.yaml');
        await fsPromises.writeFile(configPath, SAMPLE, 'utf8');
        setConfigFilePath(configPath);
        reloadConfigCache();
    });

    beforeEach(async () => {
        savedEnv = Object.fromEntries(touchedEnvKeys.map(k => [k, process.env[k]]));
        for (const k of touchedEnvKeys) delete process.env[k];
        await fsPromises.writeFile(configPath, SAMPLE, 'utf8');
        reloadConfigCache();
    });

    afterEach(() => {
        for (const k of touchedEnvKeys) {
            if (savedEnv[k] === undefined) delete process.env[k];
            else process.env[k] = savedEnv[k];
        }
    });

    test('fills missing keys in partial config.yaml from defaults without losing explicit keys', async () => {
        await fsPromises.writeFile(configPath, 'backups:\n  common:\n    numberOfBackups: 15\nlisten: false\n', 'utf8');
        reloadConfigCache();

        const state = await readBackupConfigState(configPath);
        expect(state.fileConfig).toEqual({
            allowFullDataBackup: true,
            common: { numberOfBackups: 15 },
            chat: {
                enabled: true,
                checkIntegrity: true,
                maxTotalBackups: -1,
                throttleInterval: 10000,
            },
        });
        expect(state.effectiveConfig).toEqual(state.fileConfig);
        expect(state.envOverrides).toEqual({});
    });

    test('reports env overrides with LUKER_* precedence while keeping fileConfig from disk', async () => {
        process.env.SILLYTAVERN_BACKUPS_COMMON_NUMBEROFBACKUPS = '9';
        process.env.LUKER_BACKUPS_COMMON_NUMBER_OF_BACKUPS = '7';
        process.env.SILLYTAVERN_BACKUPS_CHAT_ENABLED = 'false';

        const state = await readBackupConfigState(configPath);
        expect(state.fileConfig.common.numberOfBackups).toBe(50);
        expect(state.effectiveConfig.common.numberOfBackups).toBe(7);
        expect(state.fileConfig.chat.enabled).toBe(true);
        expect(state.effectiveConfig.chat.enabled).toBe(false);
        expect(state.envOverrides).toEqual({
            'backups.common.numberOfBackups': {
                envKey: 'LUKER_BACKUPS_COMMON_NUMBER_OF_BACKUPS',
                value: 7,
            },
            'backups.chat.enabled': {
                envKey: 'SILLYTAVERN_BACKUPS_CHAT_ENABLED',
                value: false,
            },
        });
    });

    test('persistBackupConfig writes updated block and preserves comments', async () => {
        const result = await persistBackupConfig({
            configPath,
            safetyCheck: PASS_SAFETY,
            config: {
                allowFullDataBackup: false,
                common: { numberOfBackups: 20 },
                chat: {
                    enabled: true,
                    checkIntegrity: false,
                    maxTotalBackups: 100,
                    throttleInterval: 5000,
                },
            },
        });
        expect(result).toEqual({ ok: true });

        const onDisk = await fsPromises.readFile(configPath, 'utf8');
        expect(onDisk).toContain('# Luker config');
        expect(onDisk).toMatch(/numberOfBackups: 20[^\n]*# keep fifty/);
        expect(onDisk).toContain('maxTotalBackups: 100');
        expect(onDisk).toContain('allowFullDataBackup: false');
    });

    test('persistBackupConfig refuses to write when safetyCheck fails', async () => {
        const before = await fsPromises.readFile(configPath, 'utf8');
        const result = await persistBackupConfig({
            configPath,
            safetyCheck: () => ({ codes: ['CONFIG_UNSAFE_NO_AUTH'], errors: ['Unsafe config'] }),
            config: BACKUP_CONFIG_DEFAULTS,
        });
        expect(result.ok).toBe(false);
        expect(result.codes).toEqual(['CONFIG_UNSAFE_NO_AUTH']);
        expect(result.error).toContain('Unsafe config');

        const after = await fsPromises.readFile(configPath, 'utf8');
        expect(after).toBe(before);
    });

    test('persistBackupConfig returns error when configPath is missing or unreadable', async () => {
        const missingPath = await persistBackupConfig({
            configPath: '',
            safetyCheck: PASS_SAFETY,
            config: BACKUP_CONFIG_DEFAULTS,
        });
        expect(missingPath.ok).toBe(false);

        const unreadable = await persistBackupConfig({
            configPath: path.join(tmpDir, 'does-not-exist.yaml'),
            safetyCheck: PASS_SAFETY,
            config: BACKUP_CONFIG_DEFAULTS,
        });
        expect(unreadable.ok).toBe(false);
    });
});
