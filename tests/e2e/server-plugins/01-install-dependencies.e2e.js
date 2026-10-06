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
import { awaitMainUI, openAdminPanel } from '../_lib/page.js';
import { markOnboarded } from '../_lib/fixtures.js';

let server;
let scratchRoot;
let pluginsDir;
let bareRepo;

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
        "import tinyDep from 'tiny-dep';",
        'export const info = { id: "example-plugin", name: "Example Plugin", description: "e2e fixture" };',
        'export async function init(router) {',
        "    router.get('/ping', (req, res) => res.json({ ok: true, value: tinyDep.value }));",
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
    test('installs dependencies from the admin prompt and the plugin route resolves them after restart', async ({ page, request }) => {
        await awaitMainUI(page, server.baseURL);
        await openAdminPanel(page);

        const adminPopup = page.locator('dialog.popup[open]').last();
        await adminPopup.locator('.serverPluginsButton').click();

        const tab = adminPopup.locator('.serverPluginsTab');
        await tab.waitFor({ state: 'visible', timeout: 10_000 });

        await tab.locator('#serverPluginRepoUrlInput').fill(bareRepo);
        await tab.locator('.installServerPluginButton').click();

        // Cloning finishes, then the UI asks whether to install the missing
        // dependencies. Accept through the real affirmative button. Target it
        // by its label because the Admin Panel dialog stays open underneath.
        const installDepsButton = page.locator('dialog.popup[open] .popup-button-ok', { hasText: 'Install dependencies' });
        await installDepsButton.waitFor({ state: 'visible', timeout: 30_000 });
        await installDepsButton.click();

        // The row re-renders once the install round-trips.
        await expect(tab.locator('.serverPluginDependencyStatus'))
            .toContainText('Dependencies installed', { timeout: 60_000 });

        // The plugin only loads at boot, so restart before probing its route.
        await server.restart();

        const response = await request.get(`${server.baseURL}/api/plugins/example-plugin/ping`);
        expect(response.ok()).toBe(true);
        expect(await response.json()).toEqual({ ok: true, value: 42 });
    });
});
