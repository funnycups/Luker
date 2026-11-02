// Two installs whose settings match pair with the settings category and no
// conflict on settings.json, also when each install ran the proxy to base
// URL migration at its own time.
//
// Two real servers, each opened in a real browser so the client start-up
// migrations write their settings. No LLM calls, so nothing is mocked.

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

import { startServer, tearDownServer } from '../_lib/server.js';
import { awaitMainUI } from '../_lib/page.js';
import { openLanSyncPanel, generatePairingLink, acceptPairingLink, readUserFile, userRootOf } from '../_lib/sync.js';

let A;
let B;
let contexts = [];

function seedSettings(server, patch) {
    const settingsPath = path.join(userRootOf(server), 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    patch(settings);
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 4));
}

test.afterEach(async () => {
    for (const ctx of contexts) await ctx.close();
    contexts = [];
    await tearDownServer(A);
    await tearDownServer(B);
});

async function pairSettings(browser) {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    contexts = [ctxA, ctxB];
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    await awaitMainUI(pageA, A.baseURL);
    await awaitMainUI(pageB, B.baseURL);
    await openLanSyncPanel(pageA);
    const link = await generatePairingLink(pageA, { label: 'B device', categories: ['settings'] });
    await openLanSyncPanel(pageB);
    return acceptPairingLink(pageB, link, { categories: ['settings'], localLabel: 'A device' });
}

test('two fresh installs pair the settings with no conflict', async ({ browser }, testInfo) => {
    A = await startServer({ batchKey: 'sync', scenarioId: `${testInfo.testId}-A` });
    B = await startServer({ batchKey: 'sync', scenarioId: `${testInfo.testId}-B` });
    expect(await pairSettings(browser)).toBe('success');
    expect(readUserFile(B, 'settings.json')).toBe(readUserFile(A, 'settings.json'));
});

test('two installs that ran the proxy migration at different times pair the settings with no conflict', async ({ browser }, testInfo) => {
    A = await startServer({ batchKey: 'sync', scenarioId: `${testInfo.testId}-A` });
    B = await startServer({ batchKey: 'sync', scenarioId: `${testInfo.testId}-B` });
    for (const [server, migratedAt] of [[A, Date.parse('2026-06-01T08:00:00Z')], [B, Date.parse('2026-07-15T19:30:00Z')]]) {
        // Historical migration evidence is installed only while stopped.
        await server.stop();
        seedSettings(server, settings => {
            settings.extension_settings ??= {};
            settings.extension_settings.connectionManager = { profiles: [], selectedProfile: null, _proxyToBaseUrlMigratedAt: migratedAt };
        });
        await server.restart();
    }
    expect(await pairSettings(browser)).toBe('success');
    expect(readUserFile(B, 'settings.json')).toBe(readUserFile(A, 'settings.json'));
});
