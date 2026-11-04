// Server plugins · install a plugin from git and install its npm
// dependencies through the admin panel.
//
// The plugin source is a local bare git repository whose package.json
// declares one dependency (`tiny-dep`, a `file:` path to a sibling
// package). Cloning the plugin therefore leaves it with an unsatisfied
// dependency, which is exactly what the admin install prompt is for.
//
// The flow is the real user path: open the Admin Panel, open the Server
// Plugins tab, paste the repository path, install, accept the dependency
// prompt, watch the row flip to "Dependencies installed", restart the
// backend, and confirm the plugin route answers using the installed
// dependency.

import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startServer, tearDownServer } from '../_lib/server.js';
import { awaitMainUI } from '../_lib/page.js';
import { accountWindow, answerWindowConfirm, openAdminPage, windowConfirm } from '../_lib/account-window.js';
import { markOnboarded } from '../_lib/fixtures.js';

let server;
let scratchRoot;
let pluginsDir;
let bareRepo;
let copiedPluginDir;

/**
 * Build a local bare git repository that serves as the plugin source.
 *
 * Layout under `baseDir`:
 *   tiny-dep/            a one-file ES module exporting `{ value: 42 }`
 *   example-plugin-work/ the plugin work tree, committed and pushed
 *   example-plugin.git/  the bare repository the admin UI clones from
 *
 * The work tree is initialized on `main` and the bare repository's HEAD is
 * pointed at `main` so a plain `git clone` checks the branch out.
 *
 * @param {string} baseDir
 * @returns {string} absolute path to the bare repository
 */
function createExamplePluginRepo(baseDir) {
    fs.mkdirSync(baseDir, { recursive: true });

    const dep = path.join(baseDir, 'tiny-dep');
    fs.mkdirSync(dep, { recursive: true });
    fs.writeFileSync(path.join(dep, 'package.json'), JSON.stringify({
        name: 'tiny-dep',
        version: '1.0.0',
        type: 'module',
        main: 'index.mjs',
    }, null, 2));
    fs.writeFileSync(path.join(dep, 'index.mjs'), 'export default { value: 42 };\n');

    const work = path.join(baseDir, 'example-plugin-work');
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({
        name: 'example-plugin',
        version: '1.0.0',
        type: 'module',
        main: 'index.mjs',
        dependencies: { 'tiny-dep': `file:${dep}` },
    }, null, 2));
    fs.writeFileSync(path.join(work, 'index.mjs'), [
        'import tinyDep from \'tiny-dep\';',
        'export const info = { id: "example-plugin", name: "Example Plugin", description: "e2e fixture" };',
        'export async function init(router) {',
        '    router.get(\'/ping\', (req, res) => res.json({ ok: true, value: tinyDep.value }));',
        '}',
        '',
    ].join('\n'));

    const bare = path.join(baseDir, 'example-plugin.git');
    execFileSync('git', ['init', '--bare', '--initial-branch=main', bare]);
    execFileSync('git', ['-C', work, 'init', '--initial-branch=main']);
    execFileSync('git', ['-C', work, 'add', '.']);
    execFileSync('git', ['-C', work, '-c', 'user.email=e2e@luker', '-c', 'user.name=e2e', 'commit', '-m', 'init']);
    execFileSync('git', ['-C', work, 'remote', 'add', 'origin', bare]);
    execFileSync('git', ['-C', work, 'push', 'origin', 'HEAD:main']);
    return bare;
}

test.beforeAll(async () => {
    // Keep the plugin source and the server's plugin directory outside the
    // repository so the clone never lands in the project's own plugins/.
    scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'server-plugins-e2e-'));
    pluginsDir = path.join(scratchRoot, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    bareRepo = createExamplePluginRepo(path.join(scratchRoot, 'repo'));
    // Reproduce copying a source directory rather than installing through git.
    copiedPluginDir = path.join(pluginsDir, 'copied-plugin');
    fs.cpSync(path.join(scratchRoot, 'repo', 'example-plugin-work'), copiedPluginDir, {
        recursive: true,
        filter: source => path.basename(source) !== '.git',
    });
    const copiedPackagePath = path.join(copiedPluginDir, 'package.json');
    const copiedPackage = JSON.parse(fs.readFileSync(copiedPackagePath, 'utf8'));
    copiedPackage.name = 'copied-plugin';
    copiedPackage.optionalDependencies = copiedPackage.dependencies;
    delete copiedPackage.dependencies;
    fs.writeFileSync(copiedPackagePath, JSON.stringify(copiedPackage));
    const copiedEntry = path.join(copiedPluginDir, 'index.mjs');
    fs.writeFileSync(copiedEntry, fs.readFileSync(copiedEntry, 'utf8').replace('"example-plugin"', '"copied-plugin"'));

    server = await startServer({
        batchKey: 'server-plugins',
        scenarioId: 'install-deps',
        extraConfig: {
            enableServerPlugins: true,
            serverPluginsPath: pluginsDir,
        },
    });
    markOnboarded({ dataRoot: server.dataRoot });
});

test.afterAll(async () => {
    await tearDownServer(server);
    if (scratchRoot) {
        fs.rmSync(scratchRoot, { recursive: true, force: true });
    }
});

test.describe('Server plugins · dependency install', () => {
    test('installs dependencies from the row and admin prompt and resolves them after restart', async ({ page, request }, testInfo) => {
        await awaitMainUI(page, server.baseURL);
        await openAdminPage(page, 'adminPlugins');
        const tab = accountWindow(page);
        const pluginCard = dir => tab.locator('.dw-card', { has: page.locator('.dw-card-name', { hasText: dir }) });

        const copiedRow = pluginCard('copied-plugin');
        await expect(copiedRow.locator('[data-act="adm-plugin-deps"]')).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('optional-dependencies-missing.png') });
        await copiedRow.locator('[data-act="adm-plugin-deps"]').click();
        await expect(copiedRow.locator('.dw-card-meta'))
            .toContainText('Dependencies installed', { timeout: 60_000 });
        expect(fs.existsSync(path.join(copiedPluginDir, 'node_modules', 'tiny-dep', 'package.json'))).toBe(true);
        await page.screenshot({ path: testInfo.outputPath('optional-dependencies-installed.png') });

        await tab.locator('[data-model="top.repo"]').fill(bareRepo);
        await tab.locator('[data-act="adm-plugin-install"]').click();
        // Installing asks to confirm trusting the repository first.
        await answerWindowConfirm(page, { text: 'Install this server plugin?' });

        // Cloning finishes, then the window asks whether to install the
        // missing dependencies. Accept through the real affirmative button.
        const installDeps = windowConfirm(page).locator('[data-r="1"]', { hasText: 'Install dependencies' });
        await installDeps.waitFor({ state: 'visible', timeout: 30_000 });
        await installDeps.click();

        // The card re-renders once the install round-trips.
        const installedRow = pluginCard('example-plugin');
        await expect(installedRow.locator('.dw-card-meta'))
            .toContainText('Dependencies installed', { timeout: 60_000 });

        // The plugin only loads at boot, so restart before probing its route.
        await server.restart();

        const response = await request.get(`${server.baseURL}/api/plugins/example-plugin/ping`);
        expect(response.ok()).toBe(true);
        expect(await response.json()).toEqual({ ok: true, value: 42 });
        const copiedResponse = await request.get(`${server.baseURL}/api/plugins/copied-plugin/ping`);
        expect(copiedResponse.ok()).toBe(true);
        expect(await copiedResponse.json()).toEqual({ ok: true, value: 42 });
    });
});
