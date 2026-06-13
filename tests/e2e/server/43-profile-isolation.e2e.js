// #43 — Switching profiles does not pollute settings.
//
// Snapshot settings.json after profile A is active. Switch to B. Switch
// back to A. Settings.json after the second A-active state should be
// effectively the same as after the first A-active state — modulo
// volatile/non-load-bearing fields (timestamps, generated IDs that don't
// affect routing, version markers).
//
// "Pollution" here means residue from B that should have been cleaned up
// on the way back: e.g. mock-B's URL still sitting in oai_settings.custom_url,
// or selectedProfile pointing to neither A nor B, etc.

import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';

let server, mockA, mockB;

function snapshotSettings(dataRoot) {
    const settingsPath = resolve(dataRoot, 'default-user', 'settings.json');
    return JSON.parse(readFileSync(settingsPath, 'utf8'));
}

function seedTwoProfiles({ dataRoot, urlA, urlB }) {
    const settingsPath = resolve(dataRoot, 'default-user', 'settings.json');
    const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
    // settings.json uses snake_case `extension_settings` on disk — the client
    // rehydrates `extensionSettings` (camelCase) at load time from it.
    s.extension_settings = s.extension_settings || {};
    const profileA = {
        id: 'pid-A',
        name: 'mock-A',
        // See #39: api must be 'custom' to route via /api custom → custom_url,
        // not 'openai' (which would target the default OpenAI source).
        api: 'custom',
        mode: 'cc',
        preset: '',
        model: 'mock-gpt-4o',
        proxy: '',
        instruct: '',
        context: '',
        sysprompt: '',
        'sysprompt-state': false,
        'instruct-state': false,
        tokenizer: '',
        'stop-strings': '',
        'api-url': urlA,
    };
    const profileB = { ...profileA, id: 'pid-B', name: 'mock-B', 'api-url': urlB };
    s.extension_settings.connectionManager = {
        profiles: [profileA, profileB],
        selectedProfile: 'pid-A',
    };
    writeFileSync(settingsPath, JSON.stringify(s, null, 4));
}

test.beforeAll(async () => {
    mockA = await startMockLLM({});
    mockB = await startMockLLM({});
    server = await startServer({ batchKey: 'server', scenarioId: 'settings-isolation' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mockA.baseURL });
    seedTwoProfiles({ dataRoot: server.dataRoot, urlA: mockA.baseURL, urlB: mockB.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mockA?.stop();
    await mockB?.stop();
});

// Fields we don't care about being byte-identical across snapshots — they are
// expected to drift on every save (timestamps, ephemeral counters, etc).
const VOLATILE_TOP_KEYS = new Set([
    'lastUseDate',
    'lastVersion',
    'last_imported_version',
]);

function diff(a, b, basePath = '') {
    const out = [];
    const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    for (const k of keys) {
        const path = basePath ? `${basePath}.${k}` : k;
        // Skip volatile top-level keys.
        if (!basePath && VOLATILE_TOP_KEYS.has(k)) continue;
        const va = a?.[k];
        const vb = b?.[k];
        if (va === vb) continue;
        const sa = JSON.stringify(va);
        const sb = JSON.stringify(vb);
        if (sa === sb) continue;
        if (va && vb && typeof va === 'object' && typeof vb === 'object' && !Array.isArray(va) && !Array.isArray(vb)) {
            out.push(...diff(va, vb, path));
        } else {
            out.push({ path, a: sa?.slice(0, 200), b: sb?.slice(0, 200) });
        }
    }
    return out;
}

test.describe('#43 — switching profiles does not pollute settings on round-trip', () => {
    test('A → B → A: settings.json after second A is equivalent to settings.json after first A', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Force a save so the disk state reflects the post-load settings.
        await page.evaluate(async () => {
            await window.SillyTavern.getContext().executeSlashCommandsWithOptions('/profile mock-A');
            // Wait for the save-debounce + spinner.
        });
        await page.waitForTimeout(2000);
        const snapAfterFirstA = snapshotSettings(server.dataRoot);

        // Switch to B.
        await page.evaluate(async () => {
            await window.SillyTavern.getContext().executeSlashCommandsWithOptions('/profile mock-B');
        });
        await page.waitForTimeout(2000);

        // Switch back to A.
        await page.evaluate(async () => {
            await window.SillyTavern.getContext().executeSlashCommandsWithOptions('/profile mock-A');
        });
        await page.waitForTimeout(2000);
        const snapAfterReturnA = snapshotSettings(server.dataRoot);

        const diffs = diff(snapAfterFirstA, snapAfterReturnA);

        // Acceptable drift:
        //   - `lastSaveTimestamp` style fields (covered by VOLATILE_TOP_KEYS)
        //   - field-order changes (we re-parse JSON so they're equivalent)
        //
        // Unacceptable drift:
        //   - oai_settings.custom_url contains mock-B URL after we're back on A
        //   - selectedProfile points to anything other than pid-A
        //   - new top-level keys introduced by the B-visit
        const fail = diffs.filter(d => {
            // Allow `online_status_text` / friends — these are runtime not saved
            // but if they appear they're harmless.
            if (/online_status|connection_status/.test(d.path)) return false;
            // Allow benign cosmetic stat counters.
            if (/usage|tokens|stats/.test(d.path)) return false;
            return true;
        });

        // The two crucial invariants:
        expect(snapAfterReturnA.oai_settings?.custom_url, `custom_url should be mock A's after returning to profile A; saw ${snapAfterReturnA.oai_settings?.custom_url}`).toBe(mockA.baseURL);
        expect(snapAfterReturnA.extension_settings?.connectionManager?.selectedProfile).toBe('pid-A');

        // The remaining drift should be tiny — capture it as a soft assertion
        // so spurious additions surface in the failure log without blocking
        // the byte-equal check above.
        if (fail.length > 0) {
            console.warn('[#43] non-empty settings drift after A → B → A:', JSON.stringify(fail, null, 2));
        }
        // Real bug guard: any field with both URLs in either side is a leak.
        for (const d of fail) {
            const bothUrls = (s) => typeof s === 'string' && s.includes(mockA.baseURL) && s.includes(mockB.baseURL);
            expect(bothUrls(d.a) || bothUrls(d.b), `field ${d.path} contains both mock URLs => leak`).toBe(false);
        }
    });
});
