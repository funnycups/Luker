import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { awaitMainUI } from '../_lib/page.js';
import { accountWindow, openAccountTab } from '../_lib/account-window.js';
import { cloneDataDir, SCRATCH_ROOT, SEED_CONFIG } from '../_lib/server.js';
import { directoryIdentity } from '../../../desktop-app/data-location.js';
import { launchLukerDesktop, spawnLukerDesktop } from '../_lib/desktop.js';

test('a pointer target is used at startup and shown in Storage', async () => {
    const defaultDir = resolve(SCRATCH_ROOT, `desktop-pointer-default-${Date.now()}`);
    const targetDir = resolve(SCRATCH_ROOT, `desktop-pointer-target-${Date.now()}`);
    mkdirSync(defaultDir, { recursive: true });
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(resolve(defaultDir, 'data-location.json'), JSON.stringify({ version: 1, userData: targetDir }));
    cloneDataDir(resolve(targetDir, 'data'));

    const d = await launchLukerDesktop({
        scenarioId: 'pointer-target', defaultUserData: defaultDir, seed: false,
    });
    try {
        await awaitMainUI(d.page, d.baseURL);
        await openAccountTab(d.page, 'storage');
        await expect(accountWindow(d.page)).toContainText(targetDir);
        expect(existsSync(resolve(targetDir, 'data', 'luker-boot.log'))).toBe(true);
    } finally {
        await d.close();
        rmSync(defaultDir, { recursive: true, force: true });
        rmSync(targetDir, { recursive: true, force: true });
    }
});

test('a missing data directory stops startup and exits on request', async () => {
    const defaultDir = resolve(SCRATCH_ROOT, `desktop-missing-default-${Date.now()}`);
    mkdirSync(defaultDir, { recursive: true });
    writeFileSync(resolve(defaultDir, 'data-location.json'), JSON.stringify({
        version: 1, userData: resolve(defaultDir, 'missing-target'),
    }));
    const d = spawnLukerDesktop({
        defaultUserData: defaultDir,
        extraEnv: { LUKER_DESKTOP_TEST_LOCATION_DIALOG: 'quit' },
    });
    try {
        await d.waitForExit();
        expect(existsSync(resolve(defaultDir, 'missing-target', 'data'))).toBe(false);
    } finally {
        if (d.child.exitCode === null) d.child.kill('SIGKILL');
        rmSync(defaultDir, { recursive: true, force: true });
    }
});

test('changing to an existing Luker folder adopts it', async () => {
    const defaultDir = resolve(SCRATCH_ROOT, `desktop-adopt-default-${Date.now()}`);
    const targetDir = resolve(SCRATCH_ROOT, `desktop-adopt-target-${Date.now()}`);
    mkdirSync(defaultDir, { recursive: true });
    mkdirSync(targetDir, { recursive: true });
    cloneDataDir(resolve(defaultDir, 'data'));
    writeFileSync(resolve(defaultDir, 'config.yaml'), readFileSync(SEED_CONFIG));
    writeFileSync(resolve(targetDir, 'config.yaml'), readFileSync(SEED_CONFIG));
    cloneDataDir(resolve(targetDir, 'data'));

    const d = await launchLukerDesktop({
        scenarioId: 'adopt', defaultUserData: defaultDir, seed: false,
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
        rmSync(defaultDir, { recursive: true, force: true });
        rmSync(targetDir, { recursive: true, force: true });
    }
});

test('the data directory is read-only when the launch environment sets it', async () => {
    const d = await launchLukerDesktop({ scenarioId: 'env-locked' });
    try {
        await awaitMainUI(d.page, d.baseURL);
        await openAccountTab(d.page, 'storage');
        await expect(accountWindow(d.page)).toContainText(d.userData);
        await expect(accountWindow(d.page).locator('[data-act="data-dir-change"]')).toBeDisabled();
    } finally {
        await d.close();
    }
});

test('changing to an empty folder writes a pending move', async () => {
    const defaultDir = resolve(SCRATCH_ROOT, `desktop-move-default-${Date.now()}`);
    const targetDir = resolve(SCRATCH_ROOT, `desktop-move-target-${Date.now()}`);
    mkdirSync(defaultDir, { recursive: true });
    mkdirSync(targetDir, { recursive: true });
    cloneDataDir(resolve(defaultDir, 'data'));
    writeFileSync(resolve(defaultDir, 'config.yaml'), readFileSync(SEED_CONFIG));

    const d = await launchLukerDesktop({
        scenarioId: 'move-pending', defaultUserData: defaultDir, seed: false,
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
        rmSync(defaultDir, { recursive: true, force: true });
        rmSync(targetDir, { recursive: true, force: true });
    }
});

test('a pending move migrates data and cleans the old folder after the new server starts', async () => {
    const defaultDir = resolve(SCRATCH_ROOT, `desktop-move-default-${Date.now()}`);
    const sourceDir = resolve(SCRATCH_ROOT, `desktop-move-source-${Date.now()}`);
    const targetDir = resolve(SCRATCH_ROOT, `desktop-move-target-${Date.now()}`);
    mkdirSync(defaultDir, { recursive: true });
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(targetDir, { recursive: true });
    cloneDataDir(resolve(sourceDir, 'data'));
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
        scenarioId: 'move-migrate', defaultUserData: defaultDir, seed: false,
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
        await first.close({ removeData: false });
    }

    const second = await launchLukerDesktop({
        scenarioId: 'move-final', defaultUserData: defaultDir, seed: false,
    });
    try {
        await awaitMainUI(second.page, second.baseURL);
        await expect.poll(() => existsSync(sourceDir), { timeout: 15_000 }).toBe(false);
        expect(JSON.parse(readFileSync(resolve(defaultDir, 'data-location.json'), 'utf8')))
            .toEqual({ version: 1, userData: targetDir });
    } finally {
        await second.close();
        rmSync(defaultDir, { recursive: true, force: true });
        rmSync(sourceDir, { recursive: true, force: true });
        rmSync(targetDir, { recursive: true, force: true });
    }
});

test('the old folder stays when the new backend fails to start', async () => {
    const defaultDir = resolve(SCRATCH_ROOT, `desktop-cleanup-default-${Date.now()}`);
    const sourceDir = resolve(SCRATCH_ROOT, `desktop-cleanup-source-${Date.now()}`);
    const targetDir = resolve(SCRATCH_ROOT, `desktop-cleanup-target-${Date.now()}`);
    mkdirSync(defaultDir, { recursive: true });
    mkdirSync(resolve(sourceDir, 'data'), { recursive: true });
    mkdirSync(resolve(targetDir, 'data'), { recursive: true });
    writeFileSync(resolve(sourceDir, 'data', 'keep.txt'), 'keep');
    writeFileSync(resolve(targetDir, 'config.yaml'), 'storage: [\n');
    writeFileSync(resolve(defaultDir, 'data-location.json'), JSON.stringify({
        version: 1, userData: targetDir, pendingDeleteFrom: sourceDir,
    }));

    const d = await launchLukerDesktop({
        scenarioId: 'cleanup-failure', defaultUserData: defaultDir, seed: false,
    });
    try {
        await expect(d.page.locator('body')).toContainText(resolve(targetDir, 'data', 'luker-boot.log'));
        expect(existsSync(resolve(sourceDir, 'data', 'keep.txt'))).toBe(true);
        expect(JSON.parse(readFileSync(resolve(defaultDir, 'data-location.json'), 'utf8')).pendingDeleteFrom)
            .toBe(sourceDir);
    } finally {
        await d.close();
        rmSync(defaultDir, { recursive: true, force: true });
        rmSync(sourceDir, { recursive: true, force: true });
        rmSync(targetDir, { recursive: true, force: true });
    }
});

test('a missing data directory can be recovered by choosing another folder', async () => {
    const defaultDir = resolve(SCRATCH_ROOT, `desktop-recover-default-${Date.now()}`);
    const targetDir = resolve(SCRATCH_ROOT, `desktop-recover-target-${Date.now()}`);
    mkdirSync(defaultDir, { recursive: true });
    mkdirSync(targetDir, { recursive: true });
    cloneDataDir(resolve(targetDir, 'data'));
    writeFileSync(resolve(targetDir, 'config.yaml'), readFileSync(SEED_CONFIG));
    writeFileSync(resolve(defaultDir, 'data-location.json'), JSON.stringify({
        version: 1, userData: resolve(defaultDir, 'missing-target'),
    }));
    const d = spawnLukerDesktop({
        defaultUserData: defaultDir,
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
        if (d.child.exitCode === null) d.child.kill('SIGKILL');
        rmSync(defaultDir, { recursive: true, force: true });
        rmSync(targetDir, { recursive: true, force: true });
    }
});
