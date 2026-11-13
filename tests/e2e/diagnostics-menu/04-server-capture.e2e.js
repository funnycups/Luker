// tests/e2e/diagnostics-menu/04-server-capture.e2e.js
//
// The HarmonyOS build cannot run the capture inside the WebView bridge, so it
// drives server-side endpoints instead. This test stands a real devtools
// server on a unix socket, points the Luker server at it, and walks the real
// user path: settings menu -> capture -> downloaded artifact.

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { startServer, tearDownServer } from '../_lib/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';
import { startFakeDevtools } from '../../renderer-capture/_lib/fake-devtools-server.js';

const HEAP_CHUNKS = ['{"snapshot":{"meta":{', '"node_count":1}}'];
const TRACE_EVENTS = [{ name: 'RunTask' }];

let server;
let devtools;

test.beforeAll(async () => {
    devtools = await startFakeDevtools({ heapChunks: HEAP_CHUNKS, traceEvents: TRACE_EVENTS });
    server = await startServer({
        batchKey: 'diagnostics',
        scenarioId: 'server-capture',
        extraEnv: { LUKER_RENDERER_DEVTOOLS_SOCKET: devtools.socketPath },
    });
    markOnboarded({ dataRoot: server.dataRoot });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await devtools?.close();
});

async function openSettingsAndMenu(page) {
    await awaitMainUI(page, server.baseURL);
    if (await page.locator('#user-settings-button .drawer-icon.closedIcon').count()) {
        await page.locator('#user-settings-button .drawer-toggle').click();
    }
    await page.locator('#debug-export-btn').click();
    await expect(page.locator('#debug-menu-list')).toBeVisible();
}

test('the capture entries appear when the server can capture', async ({ page }) => {
    await openSettingsAndMenu(page);

    await expect(page.locator('[data-debug-action="capture-heap"]')).toBeVisible();
    await expect(page.locator('[data-debug-action="toggle-perf-recording"]')).toBeVisible();
    await expect(page.locator('[data-debug-action="download-perf-report"]')).toBeHidden();
    await expect(page.locator('[data-debug-action="toggle-self-profiling"]')).toBeHidden();
});

test('a heap capture downloads the artifact the server wrote', async ({ page }) => {
    await openSettingsAndMenu(page);

    const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.locator('[data-debug-action="capture-heap"]').click(),
    ]);

    expect(download.suggestedFilename()).toMatch(/^luker-heap-\d{8}-\d{6}-\d{3}\.heapsnapshot$/);
    expect(readFileSync(await download.path(), 'utf8')).toBe(HEAP_CHUNKS.join(''));
});

test('a performance recording downloads the trace when it stops', async ({ page }) => {
    await openSettingsAndMenu(page);

    const recordingItem = page.locator('[data-debug-action="toggle-perf-recording"]');
    await recordingItem.click();
    await expect(recordingItem).toHaveText('Stop Performance Recording');
    await expect(page.locator('#debug-recording-indicator')).toBeVisible();

    await page.locator('#debug-export-btn').click();

    const [download] = await Promise.all([
        page.waitForEvent('download'),
        recordingItem.click(),
    ]);

    expect(download.suggestedFilename()).toMatch(/^luker-trace-\d{8}-\d{6}-\d{3}\.json$/);
    expect(JSON.parse(readFileSync(await download.path(), 'utf8'))).toEqual({ traceEvents: TRACE_EVENTS });
    await expect(recordingItem).toHaveText('Start Performance Recording');
    await expect(page.locator('#debug-recording-indicator')).toBeHidden();
});
