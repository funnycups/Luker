import { test, expect } from '../../harness/playwright.js';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { awaitMainUI } from '../_lib/page.js';
import { accountWindow, openAccountTab } from '../_lib/account-window.js';
import { materializeSeed } from '../../harness/seed.js';
import { directoryIdentity } from '../../../desktop-app/data-location.js';
import { launchLukerDesktop, spawnLukerDesktop } from '../_lib/desktop.js';

const SEED_CONFIG = resolve(import.meta.dirname, '../../../default/config.yaml');

async function seedDataInto(scope, dirPath) {
    const seeded = await materializeSeed(scope, { settingsOverrides: { firstRun: false, power_user: { auto_connect: false } } });
    renameSync(seeded.dataRoot, resolve(dirPath, 'data'));
}

test('a pointer target is used at startup and shown in Storage', async ({ resources }) => {
    const defaultDirReceipt = await resources.directory('desktop-pointer-default');
    const targetDirReceipt = await resources.directory('desktop-pointer-target');
    const defaultDir = defaultDirReceipt.path;
    const targetDir = targetDirReceipt.path;
    writeFileSync(resolve(defaultDir, 'data-location.json'), JSON.stringify({ version: 1, userData: targetDir }));
    await seedDataInto(resources, targetDir);

    const d = await launchLukerDesktop({
        scope: resources,
        scenarioId: 'pointer-target',
        defaultUserData: defaultDirReceipt,
        seed: false,
    });
    try {
        await awaitMainUI(d.page, d.baseURL);
        await openAccountTab(d.page, 'storage');
        await expect(accountWindow(d.page)).toContainText(targetDir);
        expect(existsSync(resolve(targetDir, 'data', 'luker-boot.log'))).toBe(true);
    } finally {
        await d.close();
    }
});

test('a missing data directory stops startup and exits on request', async ({ resources }) => {
    const defaultDirReceipt = await resources.directory('desktop-missing-default');
    const defaultDir = defaultDirReceipt.path;
    writeFileSync(resolve(defaultDir, 'data-location.json'), JSON.stringify({
        version: 1, userData: resolve(defaultDir, 'missing-target'),
    }));
    const d = await spawnLukerDesktop({
        scope: resources,
        defaultUserData: defaultDirReceipt,
        extraEnv: { LUKER_DESKTOP_TEST_LOCATION_DIALOG: 'quit' },
    });
    try {
        await d.waitForExit();
        expect(existsSync(resolve(defaultDir, 'missing-target', 'data'))).toBe(false);
    } finally {
        await d.stop();
    }
});

test('changing to an existing Luker folder adopts it', async ({ resources }) => {
    const defaultDirReceipt = await resources.directory('desktop-adopt-default');
    const targetDirReceipt = await resources.directory('desktop-adopt-target');
    const defaultDir = defaultDirReceipt.path;
    const targetDir = targetDirReceipt.path;
    await seedDataInto(resources, defaultDir);
    writeFileSync(resolve(defaultDir, 'config.yaml'), readFileSync(SEED_CONFIG));
    writeFileSync(resolve(targetDir, 'config.yaml'), readFileSync(SEED_CONFIG));
    await seedDataInto(resources, targetDir);

    const d = await launchLukerDesktop({
        scope: resources,
        scenarioId: 'adopt',
        defaultUserData: defaultDirReceipt,
        seed: false,
        extraEnv: { LUKER_DESKTOP_TEST_NO_RELAUNCH: '1' },
    });
    try {
        await awaitMainUI(d.page, d.baseURL);
        await openAccountTab(d.page, 'storage');
        await d.electronApp.evaluate(({ dialog }, target) => {
            dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
            dialog.showMessageBox = async () => ({ response: 0 });
        }, targetDir);
        await accountWindow(d.page).locator('[data-act="data-dir-change"]').click();
        await d.waitForExit();
        const pointer = JSON.parse(readFileSync(resolve(defaultDir, 'data-location.json'), 'utf8'));
        expect(pointer).toEqual({ version: 1, userData: targetDir });
        expect(existsSync(resolve(defaultDir, 'data'))).toBe(true);
    } finally {
        await d.close();
    }
});

test('the data directory is read-only when the launch environment sets it', async ({ resources }) => {
    const d = await launchLukerDesktop({ scope: resources, scenarioId: 'env-locked' });
    try {
        await awaitMainUI(d.page, d.baseURL);
        await openAccountTab(d.page, 'storage');
        await expect(accountWindow(d.page)).toContainText(d.userData);
        await expect(accountWindow(d.page).locator('[data-act="data-dir-change"]')).toBeDisabled();
    } finally {
        await d.close();
    }
});

test('changing to an empty folder writes a pending move', async ({ resources }) => {
    const defaultDirReceipt = await resources.directory('desktop-move-default');
    const targetDirReceipt = await resources.directory('desktop-move-target');
    const defaultDir = defaultDirReceipt.path;
    const targetDir = targetDirReceipt.path;
    await seedDataInto(resources, defaultDir);
    writeFileSync(resolve(defaultDir, 'config.yaml'), readFileSync(SEED_CONFIG));

    const d = await launchLukerDesktop({
        scope: resources,
        scenarioId: 'move-pending',
        defaultUserData: defaultDirReceipt,
        seed: false,
        extraEnv: { LUKER_DESKTOP_TEST_NO_RELAUNCH: '1' },
    });
    try {
        await awaitMainUI(d.page, d.baseURL);
        await openAccountTab(d.page, 'storage');
        await d.electronApp.evaluate(({ dialog }, target) => {
            dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
            dialog.showMessageBox = async () => ({ response: 0 });
        }, targetDir);
        await accountWindow(d.page).locator('[data-act="data-dir-change"]').click();
        await d.waitForExit();
        expect(JSON.parse(readFileSync(resolve(defaultDir, 'data-location.json'), 'utf8'))).toEqual({
            version: 1,
            userData: defaultDir,
            pendingMoveTo: targetDir,
            pendingMoveToIdentity: directoryIdentity(targetDir),
        });
    } finally {
        await d.close();
    }
});

test('a pending move migrates data and cleans the old folder after the new server starts', async ({ resources }) => {
    const defaultDirReceipt = await resources.directory('desktop-move-default');
    const sourceParentReceipt = await resources.directory('desktop-move-source-root');
    const targetDirReceipt = await resources.directory('desktop-move-target');
    const defaultDir = defaultDirReceipt.path;
    const sourceDir = resolve(sourceParentReceipt.path, 'source');
    mkdirSync(sourceDir);
    const targetDir = targetDirReceipt.path;
    await seedDataInto(resources, sourceDir);
    writeFileSync(resolve(sourceDir, 'config.yaml'), readFileSync(SEED_CONFIG));
    writeFileSync(resolve(sourceDir, 'http-auth.json'), JSON.stringify({ '127.0.0.1:8000:': { username: 'u', password: 'p' } }));
    mkdirSync(resolve(sourceDir, 'Cache'));
    writeFileSync(resolve(defaultDir, 'data-location.json'), JSON.stringify({
        version: 1,
        userData: sourceDir,
        pendingMoveTo: targetDir,
        pendingMoveToIdentity: directoryIdentity(targetDir),
    }));

    const first = await launchLukerDesktop({
        scope: resources,
        scenarioId: 'move-migrate',
        defaultUserData: defaultDirReceipt,
        seed: false,
        waitForWindow: false,
        extraEnv: { LUKER_DESKTOP_TEST_NO_RELAUNCH: '1' },
    });
    try {
        await first.waitForExit();
        expect(existsSync(resolve(targetDir, 'data'))).toBe(true);
        expect(existsSync(resolve(targetDir, 'config.yaml'))).toBe(true);
        expect(existsSync(resolve(targetDir, 'http-auth.json'))).toBe(true);
        expect(existsSync(resolve(targetDir, 'Cache'))).toBe(false);
        expect(JSON.parse(readFileSync(resolve(defaultDir, 'data-location.json'), 'utf8'))).toEqual({
            version: 1, userData: targetDir, pendingDeleteFrom: sourceDir,
        });
    } finally {
        await first.close();
    }

    const second = await launchLukerDesktop({
        scope: resources,
        scenarioId: 'move-final',
        defaultUserData: defaultDirReceipt,
        seed: false,
    });
    try {
        await awaitMainUI(second.page, second.baseURL);
        await expect.poll(() => existsSync(sourceDir), { timeout: 15_000 }).toBe(false);
        expect(JSON.parse(readFileSync(resolve(defaultDir, 'data-location.json'), 'utf8')))
            .toEqual({ version: 1, userData: targetDir });
    } finally {
        await second.close();
    }
});

test('the old folder stays when the new backend fails to start', async ({ resources }) => {
    const defaultDirReceipt = await resources.directory('desktop-cleanup-default');
    const sourceDirReceipt = await resources.directory('desktop-cleanup-source');
    const targetDirReceipt = await resources.directory('desktop-cleanup-target');
    const defaultDir = defaultDirReceipt.path;
    const sourceDir = sourceDirReceipt.path;
    const targetDir = targetDirReceipt.path;
    mkdirSync(resolve(sourceDir, 'data'), { recursive: true });
    mkdirSync(resolve(targetDir, 'data'), { recursive: true });
    writeFileSync(resolve(sourceDir, 'data', 'keep.txt'), 'keep');
    writeFileSync(resolve(targetDir, 'config.yaml'), 'storage: [\n');
    writeFileSync(resolve(defaultDir, 'data-location.json'), JSON.stringify({
        version: 1, userData: targetDir, pendingDeleteFrom: sourceDir,
    }));

    const d = await launchLukerDesktop({
        scope: resources,
        scenarioId: 'cleanup-failure',
        defaultUserData: defaultDirReceipt,
        seed: false,
    });
    try {
        await expect(d.page.locator('body')).toContainText(resolve(targetDir, 'data', 'luker-boot.log'));
        expect(existsSync(resolve(sourceDir, 'data', 'keep.txt'))).toBe(true);
        expect(JSON.parse(readFileSync(resolve(defaultDir, 'data-location.json'), 'utf8')).pendingDeleteFrom)
            .toBe(sourceDir);
    } finally {
        await d.close();
    }
});

test('a missing data directory can be recovered by choosing another folder', async ({ resources }) => {
    const defaultDirReceipt = await resources.directory('desktop-recover-default');
    const targetDirReceipt = await resources.directory('desktop-recover-target');
    const defaultDir = defaultDirReceipt.path;
    const targetDir = targetDirReceipt.path;
    await seedDataInto(resources, targetDir);
    writeFileSync(resolve(targetDir, 'config.yaml'), readFileSync(SEED_CONFIG));
    writeFileSync(resolve(defaultDir, 'data-location.json'), JSON.stringify({
        version: 1, userData: resolve(defaultDir, 'missing-target'),
    }));
    const d = await spawnLukerDesktop({
        scope: resources,
        defaultUserData: defaultDirReceipt,
        extraEnv: {
            LUKER_DESKTOP_TEST_LOCATION_DIALOG: 'choose',
            LUKER_DESKTOP_TEST_LOCATION_DIRECTORY: targetDir,
            LUKER_DESKTOP_TEST_LOCATION_CONFIRM: '1',
            LUKER_DESKTOP_TEST_NO_RELAUNCH: '1',
        },
    });
    try {
        await d.waitForExit();
        expect(JSON.parse(readFileSync(resolve(defaultDir, 'data-location.json'), 'utf8')))
            .toEqual({ version: 1, userData: targetDir });
    } finally {
        await d.stop();
    }
});
