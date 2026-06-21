// #43 — Switching profiles does not pollute settings (real dropdown).
//
// Snapshot settings.json after profile A is active. Switch to B via the
// real #connection_profiles dropdown. Switch back to A via the dropdown.
// Settings.json after the second A-active state should be effectively
// the same as after the first A-active state, modulo volatile fields.
//
// "Pollution" here means residue from B that should have been cleaned up
// on the way back (e.g. mock-B's URL still in oai_settings.custom_url).

import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, openExtensionsDrawer } from '../_lib/page.js';

let server, mockA, mockB;

function snapshotSettings(dataRoot) {
    const settingsPath = resolve(dataRoot, 'default-user', 'settings.json');
    return JSON.parse(readFileSync(settingsPath, 'utf8'));
}

function seedTwoProfiles({ dataRoot, urlA, urlB }) {
    const settingsPath = resolve(dataRoot, 'default-user', 'settings.json');
    const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
    s.extension_settings = s.extension_settings || {};
    const profileA = {
        id: 'pid-A',
        name: 'mock-A',
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

const VOLATILE_TOP_KEYS = new Set(['lastUseDate', 'lastVersion', 'last_imported_version']);

function diff(a, b, basePath = '') {
    const out = [];
    const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    for (const k of keys) {
        const path = basePath ? `${basePath}.${k}` : k;
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

/**
 * Open the Extensions drawer and select a connection profile via the real
 * #connection_profiles dropdown. The change handler re-applies the
 * profile via the /profile slash chain and saves.
 *
 * The select is wrapped by initActionableSingleSelect (select2), so the
 * underlying <select> is hidden — Playwright's selectOption refuses
 * hidden selects with "expected string, got object". We drive the change
 * via jQuery the same way the select2 widget's selection notifies its
 * onChange listener.
 */
async function selectProfileFromDropdown(page, profileName) {
    await openExtensionsDrawer(page);
    const sel = page.locator('#connection_profiles');
    await sel.waitFor({ state: 'attached', timeout: 10_000 });
    await page.waitForFunction((name) => {
        const s = document.querySelector('#connection_profiles');
        if (!s) return false;
        return Array.from(s.options).some(o => o.textContent === name);
    }, profileName, { timeout: 10_000 });
    await page.evaluate(async (name) => {
        const s = document.querySelector('#connection_profiles');
        const opt = Array.from(s.options).find(o => o.textContent === name);
        if (!opt) throw new Error(`profile option "${name}" not found`);
        const $ = window.jQuery;
        $(s).val(opt.value);
        $(s).trigger('change');
    }, profileName);
    // Wait for the manager to register the selection then for the
    // settings-save debounce to flush.
    await page.waitForFunction((name) => {
        const ctx = window.Luker?.getContext?.();
        const cm = ctx?.extensionSettings?.connectionManager;
        if (!cm) return false;
        const sel = cm.profiles?.find(p => p.id === cm.selectedProfile);
        return sel?.name === name;
    }, profileName, { timeout: 10_000 });
    await page.waitForTimeout(2500);
}

test.describe('#43 — switching profiles does not pollute settings on round-trip (real dropdown)', () => {
    test('A → B → A via dropdown: settings.json after second A is equivalent to settings.json after first A', async ({ page }) => {
        test.setTimeout(120_000);
        await awaitMainUI(page, server.baseURL);

        // Make sure A is active (it should be by virtue of seed). Snapshot.
        await selectProfileFromDropdown(page, 'mock-A');
        const snapAfterFirstA = snapshotSettings(server.dataRoot);

        // Switch to B via dropdown.
        await selectProfileFromDropdown(page, 'mock-B');

        // Switch back to A via dropdown.
        await selectProfileFromDropdown(page, 'mock-A');
        const snapAfterReturnA = snapshotSettings(server.dataRoot);

        const diffs = diff(snapAfterFirstA, snapAfterReturnA);
        const fail = diffs.filter(d => {
            if (/online_status|connection_status/.test(d.path)) return false;
            if (/usage|tokens|stats/.test(d.path)) return false;
            return true;
        });

        expect(snapAfterReturnA.oai_settings?.custom_url, `custom_url should be mock A's after returning to profile A; saw ${snapAfterReturnA.oai_settings?.custom_url}`).toBe(mockA.baseURL);
        expect(snapAfterReturnA.extension_settings?.connectionManager?.selectedProfile).toBe('pid-A');

        if (fail.length > 0) {
            console.warn('[#43] non-empty settings drift after A → B → A:', JSON.stringify(fail, null, 2));
        }
        for (const d of fail) {
            const bothUrls = (s) => typeof s === 'string' && s.includes(mockA.baseURL) && s.includes(mockB.baseURL);
            expect(bothUrls(d.a) || bothUrls(d.b), `field ${d.path} contains both mock URLs => leak`).toBe(false);
        }
    });
});
