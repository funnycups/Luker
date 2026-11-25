import { test, expect } from '../../harness/playwright.js';
import { writeFileSync, readFileSync, existsSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import net from 'node:net';
import { launchLukerDesktop } from '../_lib/desktop.js';
import { materializeSeed } from '../../harness/seed.js';
import { awaitMainUI } from '../_lib/page.js';

const SEED_CONFIG = resolve(import.meta.dirname, '../../../default/config.yaml');
const REPO_ROOT = resolve(import.meta.dirname, '../../..');

async function pickUnusedPort() {
    const probe = net.createServer();
    await new Promise((resolvePromise, rejectPromise) => {
        probe.once('error', rejectPromise);
        probe.listen({ host: '127.0.0.1', port: 0 }, resolvePromise);
    });
    const { port } = probe.address();
    await new Promise(r => probe.close(r));
    return port;
}

test('a first run creates config.yaml and the data root under userData', async ({ resources }) => {
    const directory = await resources.directory('desktop first run');
    const userData = directory.path;
    const d = await launchLukerDesktop({ scope: resources, scenarioId: 'first-run', userData: directory });
    expect(existsSync(join(userData, 'config.yaml'))).toBe(true);
    expect(existsSync(join(userData, 'data'))).toBe(true);
    expect(existsSync(join(userData, 'backups'))).toBe(true);
    expect(existsSync(join(REPO_ROOT, 'backups', '_migration'))).toBe(false);
    await d.close();
});

test('a busy preferred port does not stop startup', async ({ resources }) => {
    const blocker = net.createServer();
    try {
        await new Promise((r, j) => {
            blocker.once('error', j);
            blocker.listen({ host: '127.0.0.1', port: 8000 }, r);
        });
    } catch { /* port 8000 already busy */ }
    const d = await launchLukerDesktop({ scope: resources, scenarioId: 'busy-port' });
    expect(d.port).not.toBe(8000);
    await d.close();
    await new Promise(r => blocker.close(r));
});

test('a port configured in config.yaml is used when no CLI port is passed', async ({ resources }) => {
    const customPort = await pickUnusedPort();
    const directory = await resources.directory('desktop config port');
    const userData = directory.path;
    const seeded = await materializeSeed(resources, { settingsOverrides: { firstRun: false, power_user: { auto_connect: false } } });
    renameSync(seeded.dataRoot, join(userData, 'data'));
    const seed = readFileSync(SEED_CONFIG, 'utf8');
    const config = seed.replace(/^port:\s*\d+$/m, `port: ${customPort}`);
    expect(config).not.toBe(seed);
    writeFileSync(join(userData, 'config.yaml'), config);

    const d = await launchLukerDesktop({
        scope: resources,
        scenarioId: 'config-port',
        userData: directory,
        passPort: false,
    });
    try {
        expect(d.port).toBe(customPort);
    } finally {
        await d.close();
    }
});

test('the boot log stops growing once the server is up', async ({ resources }) => {
    const d = await launchLukerDesktop({ scope: resources, scenarioId: 'boot-log-scope' });
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

test('a backend that cannot start shows the error in the window', async ({ resources }) => {
    const directory = await resources.directory('desktop invalid configuration');
    const userData = directory.path;
    writeFileSync(join(userData, 'config.yaml'), 'storage: [\n');
    const d = await launchLukerDesktop({ scope: resources, scenarioId: 'bad-config', userData: directory });
    await expect(d.page.locator('body'))
        .toContainText(join(userData, 'data', 'luker-boot.log'));
    await d.close();
});

test('a backend that fails after its module graph starts shows the error in the window', async ({ resources }) => {
    const seed = readFileSync(SEED_CONFIG, 'utf8');
    const config = seed.replace(
        /^protocol:\n(?: {4}ipv[46]: (?:true|false)\n)+/m,
        'protocol:\n    ipv4: false\n    ipv6: false\n',
    );
    expect(config).not.toBe(seed);
    const directory = await resources.directory('desktop module graph failure');
    const userData = directory.path;
    writeFileSync(join(userData, 'config.yaml'), config);
    const d = await launchLukerDesktop({ scope: resources, scenarioId: 'late-failure', userData: directory });
    await expect(d.page.locator('body'))
        .toContainText(join(userData, 'data', 'luker-boot.log'));
    await expect(d.page.locator('#boot-log'))
        .toContainText('at least IPv6 or IPv4 must be enabled');
    const exitPromise = d.waitForExit();
    await d.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await exitPromise;
});

test('the startup failure screen allows opening the data directory and saving a new port before retry', async ({ resources }) => {
    const seed = readFileSync(SEED_CONFIG, 'utf8');
    const config = seed
        .replace(/^port:\s*\d+$/m, 'port: 8456')
        .replace(
            /^protocol:\n(?: {4}ipv[46]: (?:true|false)\n)+/m,
            'protocol:\n    ipv4: false\n    ipv6: false\n',
        );
    const directory = await resources.directory('desktop failure recovery');
    const userData = directory.path;
    writeFileSync(join(userData, 'config.yaml'), config);

    const d = await launchLukerDesktop({
        scope: resources,
        scenarioId: 'failure-recovery',
        userData: directory,
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
    }
});

test('a storage mode the packaged build cannot load shows the error in the window', async ({ resources }) => {
    const seed = readFileSync(SEED_CONFIG, 'utf8');
    const config = seed
        .replace(/^(\s*)mode: fs$/m, '$1mode: mysql')
        .replace(/^(\s*)failFast: false$/m, '$1failFast: true');
    expect(config).not.toBe(seed);
    const directory = await resources.directory('desktop storage initialization failure');
    const userData = directory.path;
    writeFileSync(join(userData, 'config.yaml'), config);
    const d = await launchLukerDesktop({ scope: resources, scenarioId: 'unloadable-storage', userData: directory });
    await expect(d.page.locator('body'))
        .toContainText(join(userData, 'data', 'luker-boot.log'));
    await d.close();
});
