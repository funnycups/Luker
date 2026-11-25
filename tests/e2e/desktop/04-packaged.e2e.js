// The built artifact, driven the same way a user starts it: the app carries
// its own backend under its resources, so it is launched as a plain
// executable. Everything the shell would otherwise
// read from the checkout has to come out of the bundle instead.
//
// Run it through `npm run test:e2e:desktop:packaged`, which needs
// `desktop-app/dist` to be built first.

import { test, expect } from '../../harness/playwright.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { launchLukerDesktop } from '../_lib/desktop.js';
import { awaitMainUI } from '../_lib/page.js';

const LOCAL_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost):\d+$/;

test('the packaged app renders the main UI on a local origin', async ({ resources }) => {
    const d = await launchLukerDesktop({ scope: resources, scenarioId: 'packaged-boot', packaged: true });
    expect(d.baseURL).toMatch(LOCAL_ORIGIN);
    expect(new URL(d.page.url()).origin).toBe(d.baseURL);
    await awaitMainUI(d.page, d.baseURL);
    await d.close();
});

test('the packaged backend tree stays read-only', async ({ resources }) => {
    const directory = await resources.directory('packaged backend read-only check');
    const userData = directory.path;
    const d = await launchLukerDesktop({ scope: resources, scenarioId: 'packaged-readonly', packaged: true, userData: directory });
    await awaitMainUI(d.page, d.baseURL);
    // The backend's writable state is redirected under userData, so the
    // resources tree it ships in is never written to.
    expect(existsSync(join(userData, 'backups'))).toBe(true);
    expect(existsSync(join(d.artifact.resourcesDir, 'luker', 'backups'))).toBe(false);
    await d.close();
});

test('a first run writes its config and data root under userData', async ({ resources }) => {
    const directory = await resources.directory('packaged first run');
    const userData = directory.path;
    const d = await launchLukerDesktop({ scope: resources, scenarioId: 'packaged-firstrun', packaged: true, userData: directory });
    expect(existsSync(join(userData, 'config.yaml'))).toBe(true);
    expect(existsSync(join(userData, 'data'))).toBe(true);
    await awaitMainUI(d.page, d.baseURL);
    await d.close();
});
