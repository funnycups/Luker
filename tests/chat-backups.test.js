import { beforeAll, afterAll, beforeEach, afterEach, describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reloadConfigCache, setConfigFilePath } from '../src/util.js';

// chats.js reads these config values at module load. Environment variables take
// precedence over config.yaml, so setting them here lets the module import
// without a config file present. The short throttle interval keeps lodash
// timers from delaying the Jest process while still being long enough that a
// per-user (rather than per-chat) throttle would defer the second chat's backup.
process.env.SILLYTAVERN_BACKUPS_CHAT_ENABLED = 'true';
process.env.SILLYTAVERN_BACKUPS_CHAT_MAXTOTALBACKUPS = '-1';
process.env.SILLYTAVERN_BACKUPS_CHAT_THROTTLEINTERVAL = '200';
process.env.SILLYTAVERN_BACKUPS_CHAT_CHECKINTEGRITY = 'false';
process.env.SILLYTAVERN_BACKUPS_COMMON_NUMBEROFBACKUPS = '1';

/** @type {import('../src/endpoints/chats.js')} */
let chats;
let workDir;

beforeAll(async () => {
    chats = await import('../src/endpoints/chats.js');
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-backups-'));
});

afterAll(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
});

/**
 * Builds a minimal chat array like the client sends it.
 * @param {string} message Message text
 * @returns {object[]} Chat array
 */
function makeChat(message) {
    return [
        { user_name: 'User', character_name: 'Char', chat_metadata: {} },
        { name: 'Char', is_user: false, mes: message },
    ];
}

describe('getBackupKey', () => {
    test('keeps plain ASCII names unchanged', () => {
        expect(chats.getBackupKey('Seraphina')).toBe('seraphina');
        expect(chats.getBackupKey('Some Test')).toBe('some_test');
    });

    test('produces distinct stable keys for names that sanitize identically', () => {
        const keyA = chats.getBackupKey('雷电将军');
        const keyB = chats.getBackupKey('测试角色');

        expect(keyA).not.toBe(keyB);
        expect(chats.getBackupKey('雷电将军')).toBe(keyA);
    });
});

describe('chat backups', () => {
    test('chats with equal-length CJK names get independent backups and quotas', async () => {
        const backupsDir = path.join(workDir, 'backups');
        const chatsDir = path.join(workDir, 'chats');
        fs.mkdirSync(backupsDir, { recursive: true });
        fs.mkdirSync(chatsDir, { recursive: true });

        // numberOfBackups is 1: with a shared backup key, the second chat's
        // backup would evict the first; with a shared throttle, it would not be
        // written at the leading edge at all
        await chats.trySaveChat(makeChat('first'), path.join(chatsDir, 'a.jsonl'), true, 'test-user', '雷电将军', backupsDir);
        await chats.trySaveChat(makeChat('second'), path.join(chatsDir, 'b.jsonl'), true, 'test-user', '测试角色', backupsDir);

        const backupFiles = fs.readdirSync(backupsDir);
        expect(backupFiles).toHaveLength(2);

        const keyA = chats.getBackupKey('雷电将军');
        const keyB = chats.getBackupKey('测试角色');
        expect(backupFiles.some(f => f.startsWith(`chat_${keyA}_`))).toBe(true);
        expect(backupFiles.some(f => f.startsWith(`chat_${keyB}_`))).toBe(true);
    });
});

describe('live backup config reload', () => {
    const envKeys = [
        'SILLYTAVERN_BACKUPS_CHAT_ENABLED',
        'SILLYTAVERN_BACKUPS_CHAT_MAXTOTALBACKUPS',
        'SILLYTAVERN_BACKUPS_CHAT_THROTTLEINTERVAL',
        'SILLYTAVERN_BACKUPS_CHAT_CHECKINTEGRITY',
        'SILLYTAVERN_BACKUPS_COMMON_NUMBEROFBACKUPS',
    ];
    let savedEnv;
    let configDir;
    let configPath;

    function writeBackupYaml({
        numberOfBackups = 50,
        enabled = true,
        checkIntegrity = false,
        maxTotalBackups = -1,
        throttleInterval = 0,
    } = {}) {
        const yamlText = [
            'backups:',
            '  allowFullDataBackup: true',
            '  common:',
            `    numberOfBackups: ${numberOfBackups}`,
            '  chat:',
            `    enabled: ${enabled}`,
            `    checkIntegrity: ${checkIntegrity}`,
            `    maxTotalBackups: ${maxTotalBackups}`,
            `    throttleInterval: ${throttleInterval}`,
            '',
        ].join('\n');
        fs.writeFileSync(configPath, yamlText, 'utf8');
        reloadConfigCache();
    }

    beforeAll(() => {
        savedEnv = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));
        for (const k of envKeys) delete process.env[k];
        configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-backups-live-'));
        configPath = path.join(configDir, 'config.yaml');
        fs.writeFileSync(configPath, 'backups:\n  common:\n    numberOfBackups: 50\n', 'utf8');
        setConfigFilePath(configPath);
        reloadConfigCache();
    });

    afterAll(() => {
        for (const k of envKeys) {
            if (savedEnv[k] === undefined) delete process.env[k];
            else process.env[k] = savedEnv[k];
        }
        fs.rmSync(configDir, { recursive: true, force: true });
    });

    let caseDir;
    let backupsDir;
    let chatsDir;

    beforeEach(() => {
        caseDir = fs.mkdtempSync(path.join(configDir, 'case-'));
        backupsDir = path.join(caseDir, 'backups');
        chatsDir = path.join(caseDir, 'chats');
        fs.mkdirSync(backupsDir, { recursive: true });
        fs.mkdirSync(chatsDir, { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(caseDir, { recursive: true, force: true });
    });

    test('toggling backups.chat.enabled off and back on takes effect immediately after reloadConfigCache', async () => {
        writeBackupYaml({ enabled: false, throttleInterval: 0 });
        await chats.trySaveChat(makeChat('disabled'), path.join(chatsDir, 'a.jsonl'), true, 'live-user', 'Alpha', backupsDir);
        expect(fs.readdirSync(backupsDir)).toHaveLength(0);

        writeBackupYaml({ enabled: true, throttleInterval: 0 });
        await chats.trySaveChat(makeChat('enabled'), path.join(chatsDir, 'a.jsonl'), true, 'live-user', 'Alpha', backupsDir);
        expect(fs.readdirSync(backupsDir)).toHaveLength(1);
    });

    test('saves while backups.chat.enabled is false do not arm throttle cooldown after re-enabling', async () => {
        try {
            writeBackupYaml({ enabled: false, throttleInterval: 60000 });
            await chats.trySaveChat(makeChat('while-disabled'), path.join(chatsDir, 'cd.jsonl'), true, 'live-user', 'CooldownChar', backupsDir);
            expect(fs.readdirSync(backupsDir)).toHaveLength(0);

            writeBackupYaml({ enabled: true, throttleInterval: 60000 });
            await chats.trySaveChat(makeChat('after-reenable'), path.join(chatsDir, 'cd.jsonl'), true, 'live-user', 'CooldownChar', backupsDir);

            const files = fs.readdirSync(backupsDir);
            expect(files).toHaveLength(1);
            expect(fs.readFileSync(path.join(backupsDir, files[0]), 'utf8')).toContain('"after-reenable"');
        } finally {
            chats._resetChatBackupThrottlesForTests();
        }
    });

    test('lowering backups.chat.maxTotalBackups trims total chat backups on next save', async () => {
        writeBackupYaml({ enabled: true, maxTotalBackups: -1, numberOfBackups: 50, throttleInterval: 0 });
        await chats.trySaveChat(makeChat('one'), path.join(chatsDir, 'one.jsonl'), true, 'live-user', 'CharOne', backupsDir);
        await chats.trySaveChat(makeChat('two'), path.join(chatsDir, 'two.jsonl'), true, 'live-user', 'CharTwo', backupsDir);
        expect(fs.readdirSync(backupsDir)).toHaveLength(2);

        writeBackupYaml({ enabled: true, maxTotalBackups: 1, numberOfBackups: 50, throttleInterval: 0 });
        await chats.trySaveChat(makeChat('three'), path.join(chatsDir, 'three.jsonl'), true, 'live-user', 'CharThree', backupsDir);
        expect(fs.readdirSync(backupsDir)).toHaveLength(1);
    });

    test('changing backups.chat.throttleInterval rebuilds the throttled wrapper without stale cooldown', async () => {
        writeBackupYaml({ enabled: true, throttleInterval: 60000 });
        await chats.trySaveChat(makeChat('first'), path.join(chatsDir, 't.jsonl'), true, 'live-user', 'ThrottleChar', backupsDir);
        await chats.trySaveChat(makeChat('second'), path.join(chatsDir, 't.jsonl'), true, 'live-user', 'ThrottleChar', backupsDir);

        const filesAfterThrottle = fs.readdirSync(backupsDir);
        expect(filesAfterThrottle).toHaveLength(1);
        const contentBeforeReload = fs.readFileSync(path.join(backupsDir, filesAfterThrottle[0]), 'utf8');
        expect(contentBeforeReload).toContain('"first"');
        expect(contentBeforeReload).not.toContain('"second"');

        writeBackupYaml({ enabled: true, throttleInterval: 0 });
        await chats.trySaveChat(makeChat('third'), path.join(chatsDir, 't.jsonl'), true, 'live-user', 'ThrottleChar', backupsDir);

        const filesAfterReload = fs.readdirSync(backupsDir);
        const latestContent = filesAfterReload
            .map(f => fs.readFileSync(path.join(backupsDir, f), 'utf8'))
            .join('\n');
        expect(latestContent).toContain('"third"');
    });

    test('toggling backups.chat.checkIntegrity on rejects stale integrity immediately', async () => {
        const chatFile = path.join(chatsDir, 'integrity.jsonl');
        writeBackupYaml({ enabled: false, checkIntegrity: false });
        await chats.trySaveChat(makeChat('v1'), chatFile, false, 'live-user', 'IntegrityChar', backupsDir);

        writeBackupYaml({ enabled: false, checkIntegrity: true });
        const staleChat = makeChat('v2');
        staleChat[0].chat_metadata = { integrity: 'stale-integrity-slug' };
        await expect(
            chats.trySaveChat(staleChat, chatFile, false, 'live-user', 'IntegrityChar', backupsDir),
        ).rejects.toThrow();
    });

    test('_resetChatBackupThrottlesForTests cleanly cancels throttled and zero-interval entries', async () => {
        writeBackupYaml({ enabled: true, throttleInterval: 60000 });
        await chats.trySaveChat(makeChat('throttled'), path.join(chatsDir, 'r1.jsonl'), true, 'live-user', 'ResetA', backupsDir);

        writeBackupYaml({ enabled: true, throttleInterval: 0 });
        await chats.trySaveChat(makeChat('immediate'), path.join(chatsDir, 'r2.jsonl'), true, 'live-user', 'ResetB', backupsDir);

        expect(() => chats._resetChatBackupThrottlesForTests()).not.toThrow();
    });
});
