import { test, expect } from '@playwright/test';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { launchLukerDesktop } from '../_lib/desktop.js';
import { reservePort } from '../_lib/ports.js';
import { cloneDataDir } from '../_lib/server.js';
import { awaitMainUI } from '../_lib/page.js';

const SEED_CONFIG = resolve(import.meta.dirname, '../../../default/config.yaml');
const REPO_ROOT = resolve(import.meta.dirname, '../../..');

test('a first run creates config.yaml and the data root under userData', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'luker-desktop-firstrun-'));
    const d = await launchLukerDesktop({ scenarioId: 'first-run', userData });
    expect(existsSync(join(userData, 'config.yaml'))).toBe(true);
    expect(existsSync(join(userData, 'data'))).toBe(true);
    // The backups root is redirected under userData; with the relative
    // default it resolves against the backend tree instead, so this
    // directory would never appear here.
    expect(existsSync(join(userData, 'backups'))).toBe(true);
    // Nothing is written into the backend tree.
    expect(existsSync(join(REPO_ROOT, 'backups', '_migration'))).toBe(false);
    await d.close();
    rmSync(userData, { recursive: true, force: true });
});

test('a busy preferred port does not stop startup', async () => {
    // 占住 8000。若本机已有别的进程占着，用例前提同样成立。
    const blocker = net.createServer();
    try {
        await new Promise((r, j) => {
            blocker.once('error', j);
            blocker.listen({ host: '127.0.0.1', port: 8000 }, r);
        });
    } catch { /* 8000 已被占用 */ }
    const d = await launchLukerDesktop({ scenarioId: 'busy-port', passPort: false });
    expect(d.port).not.toBe(8000);
    await d.close();
    await new Promise(r => blocker.close(r));
});

test('a port configured in config.yaml is used when no CLI port is passed', async () => {
    const customPort = await reservePort('desktop');
    const userData = mkdtempSync(join(tmpdir(), 'luker-desktop-configport-'));
    cloneDataDir(join(userData, 'data'));
    const seed = readFileSync(SEED_CONFIG, 'utf8');
    const config = seed.replace(/^port:\s*\d+$/m, `port: ${customPort}`);
    expect(config).not.toBe(seed);
    writeFileSync(join(userData, 'config.yaml'), config);

    const d = await launchLukerDesktop({
        scenarioId: 'config-port',
        userData,
        passPort: false,
    });
    try {
        expect(d.port).toBe(customPort);
    } finally {
        await d.close();
        rmSync(userData, { recursive: true, force: true });
    }
});

test('the boot log stops growing once the server is up', async () => {
    const d = await launchLukerDesktop({ scenarioId: 'boot-log-scope' });
    await awaitMainUI(d.page, d.baseURL);
    const logPath = join(d.userData, 'data', 'luker-boot.log');
    const marker = await d.electronApp.evaluate(() => {
        const text = `zzmark-${Date.now()}`;
        process.stdout.write(`${text}\n`);
        return text;
    });
    expect(readFileSync(logPath, 'utf8')).not.toContain(marker);
    await d.close();
});

test('a backend that cannot start shows the error in the window', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'luker-desktop-badconfig-'));
    writeFileSync(join(userData, 'config.yaml'), 'storage: [\n');
    const d = await launchLukerDesktop({ scenarioId: 'bad-config', userData });
    await expect(d.page.locator('body'))
        .toContainText(join(userData, 'data', 'luker-boot.log'));
    await d.close();
    rmSync(userData, { recursive: true, force: true });
});

test('a backend that fails after its module graph starts shows the error in the window', async () => {
    // 关掉两个 IP 协议：后端在模块图求值阶段拒绝启动，位于 server.js 的 try 之外。
    // YAML 语法错那条用例在 try 之前就抛，走不到这条路径。
    const seed = readFileSync(SEED_CONFIG, 'utf8');
    const config = seed.replace(
        /^protocol:\n(?: {4}ipv[46]: (?:true|false)\n)+/m,
        'protocol:\n    ipv4: false\n    ipv6: false\n',
    );
    expect(config).not.toBe(seed);
    const userData = mkdtempSync(join(tmpdir(), 'luker-desktop-late-failure-'));
    writeFileSync(join(userData, 'config.yaml'), config);
    const d = await launchLukerDesktop({ scenarioId: 'late-failure', userData });
    await expect(d.page.locator('body'))
        .toContainText(join(userData, 'data', 'luker-boot.log'));
    await expect(d.page.locator('#boot-log'))
        .toContainText('at least IPv6 or IPv4 must be enabled');
    // Closing a failed startup window exits the app instead of hiding a dead shell to the tray.
    const exitPromise = d.waitForExit();
    await d.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await exitPromise;
    rmSync(userData, { recursive: true, force: true });
});

test('the startup failure screen allows opening the data directory and saving a new port before retry', async () => {
    const seed = readFileSync(SEED_CONFIG, 'utf8');
    const config = seed
        .replace(/^port:\s*\d+$/m, 'port: 8456')
        .replace(
            /^protocol:\n(?: {4}ipv[46]: (?:true|false)\n)+/m,
            'protocol:\n    ipv4: false\n    ipv6: false\n',
        );
    const userData = mkdtempSync(join(tmpdir(), 'luker-desktop-failure-recovery-'));
    writeFileSync(join(userData, 'config.yaml'), config);

    const d = await launchLukerDesktop({
        scenarioId: 'failure-recovery',
        userData,
        passPort: false,
        extraEnv: {
            LUKER_DESKTOP_SKIP_OPEN_DATA_DIR: '1',
            LUKER_DESKTOP_TEST_NO_RELAUNCH: '1',
        },
    });
    let exited = false;
    try {
        await expect(d.page.locator('#boot-log'))
            .toContainText('at least IPv6 or IPv4 must be enabled');
        await expect(d.page.locator('#startup-port')).toBeVisible();
        await expect(d.page.locator('#startup-port')).toHaveValue('8456');

        await d.page.locator('#startup-open-data-dir').click();
        const opened = await d.electronApp.evaluate(() => globalThis.__lukerDataDirectoryOpens);
        expect(opened).toEqual([userData]);

        await d.page.locator('#startup-port').fill('9345');
        const exitPromise = d.waitForExit();
        await d.page.locator('#startup-retry').click();
        await exitPromise;
        exited = true;

        expect(readFileSync(join(userData, 'config.yaml'), 'utf8')).toContain('port: 9345');
    } finally {
        if (!exited) {
            await d.close();
        }
        rmSync(userData, { recursive: true, force: true });
    }
});

test('a storage mode the packaged build cannot load shows the error in the window', async () => {
    // 打包产物不携带任何外部数据库端点，切到 mysql 后端后启动探测必然失败；
    // failFast 让这次失败中止启动，窗口随即换成启动失败页。
    const seed = readFileSync(SEED_CONFIG, 'utf8');
    const config = seed
        .replace(/^(\s*)mode: fs$/m, '$1mode: mysql')
        .replace(/^(\s*)failFast: false$/m, '$1failFast: true');
    expect(config).not.toBe(seed);
    const userData = mkdtempSync(join(tmpdir(), 'luker-desktop-unloadable-storage-'));
    writeFileSync(join(userData, 'config.yaml'), config);
    const d = await launchLukerDesktop({ scenarioId: 'unloadable-storage', userData });
    await expect(d.page.locator('body'))
        .toContainText(join(userData, 'data', 'luker-boot.log'));
    await d.close();
    rmSync(userData, { recursive: true, force: true });
});
