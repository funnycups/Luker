// #39 — Save connection profile → list → switch → request goes to that backend.
//
// Real UI version: switch active profile via the real
// `#connection_profiles` dropdown in the Connection Manager drawer.
// Two mock LLM endpoints, two profiles A→mockA / B→mockB seeded in
// settings.json. After loading the UI, change selection via the
// dropdown and confirm the next sent turn lands at the corresponding
// mock — proving the dropdown switch actually re-routes the backend.

import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    selectCharacterByName,
    sendMessageAndAwaitReply,
    reloadAndAwait,
    openExtensionsDrawer,
} from '../_lib/page.js';

let server, mockA, mockB;

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
    mockA = await startMockLLM({ scriptedReplies: [
        '*Ash answers with the chart still open between you.* "Mock A: the lantern is steady; tell me what the gull rocks looked like."',
        '*Ash sets the brass spyglass down.* "Mock A again — keep going, the wind has not yet shifted."',
    ] });
    mockB = await startMockLLM({ scriptedReplies: [
        '*A different voice cuts across the watchpost.* "Mock B speaking now — the reef would not have lit that brightly under the old chart."',
        '*Mock B again.* "Hold the next turn. Something is moving past the breakers."',
    ] });
    server = await startServer({ batchKey: 'server', scenarioId: 'profile-switch' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mockA.baseURL });
    seedTwoProfiles({ dataRoot: server.dataRoot, urlA: mockA.baseURL, urlB: mockB.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mockA?.stop();
    await mockB?.stop();
});

/**
 * Select a connection profile via the real #connection_profiles dropdown.
 * The select is wrapped by initActionableSingleSelect (select2-based), so
 * the underlying <select> is visually hidden — Playwright's selectOption
 * refuses hidden selects. We drive the change via jQuery the same way the
 * select2 widget's selection notifies its onChange listener; that's the
 * gesture the connection-manager applies the profile from.
 */
async function selectConnectionProfile(page, profileName) {
    await openExtensionsDrawer(page);
    const sel = page.locator('#connection_profiles');
    await sel.waitFor({ state: 'attached', timeout: 10_000 });
    // Wait for the option (with the right label) to appear in the underlying
    // select — connection profiles render async after settings hydrate.
    await page.waitForFunction((name) => {
        const s = document.querySelector('#connection_profiles');
        if (!s) return false;
        return Array.from(s.options).some(o => o.textContent === name);
    }, profileName, { timeout: 10_000 });
    // Fire the change via jQuery so the connection-manager's $().on('change')
    // handler runs (the change handler is what runs applyConnectionProfile +
    // CONNECTION_PROFILE_LOADED). Wait for that event before returning so
    // downstream test code can rely on the routing having taken effect.
    await page.evaluate(async (name) => {
        const s = document.querySelector('#connection_profiles');
        const opt = Array.from(s.options).find(o => o.textContent === name);
        if (!opt) throw new Error(`profile option "${name}" not found`);
        const $ = window.jQuery;
        // Set the value then notify select2 + the manager.
        $(s).val(opt.value);
        // select2 mirrors the native value; trigger both events to be sure
        // the manager's listener fires once.
        $(s).trigger('change');
    }, profileName);
    // Wait until the manager has applied the change (selectedProfile is in
    // sync and the connection status has had time to flip). We give the
    // apply chain up to 5s — that's enough for the slash-command sequence
    // /api custom + /api-url custom <url> + /model <model> + status probe.
    await page.waitForFunction((name) => {
        const ctx = window.Luker?.getContext?.();
        const cm = ctx?.extensionSettings?.connectionManager;
        if (!cm) return false;
        const sel = cm.profiles?.find(p => p.id === cm.selectedProfile);
        return sel?.name === name;
    }, profileName, { timeout: 10_000 });
    await page.waitForTimeout(1000);
}

test.describe('#39 — connection profile switching routes per backend (real dropdown)', () => {
    test('switch via #connection_profiles dropdown flips which mock receives the next turn', async ({ page }) => {
        test.setTimeout(180_000);
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        // Wait for greeting to settle.
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        // Profile A active by virtue of seed. Send turn 1 → should hit mock A.
        const beforeA1 = mockA.requests.filter(r => r.url.includes('chat/completions')).length;
        const beforeB1 = mockB.requests.filter(r => r.url.includes('chat/completions')).length;
        await sendMessageAndAwaitReply(page, 'I followed the cliff path north of the gull rocks; the tide is restless.');
        const afterA1 = mockA.requests.filter(r => r.url.includes('chat/completions')).length;
        const afterB1 = mockB.requests.filter(r => r.url.includes('chat/completions')).length;
        expect(afterA1 - beforeA1, 'profile A active: mock A should have received the turn').toBeGreaterThanOrEqual(1);
        expect(afterB1 - beforeB1, 'profile A active: mock B should NOT have received the turn').toBe(0);

        // Switch to profile B via the REAL dropdown.
        await selectConnectionProfile(page, 'mock-B');

        const beforeA2 = mockA.requests.filter(r => r.url.includes('chat/completions')).length;
        const beforeB2 = mockB.requests.filter(r => r.url.includes('chat/completions')).length;
        await sendMessageAndAwaitReply(page, 'Three breakers north — they do not move with the moon.');
        const afterA2 = mockA.requests.filter(r => r.url.includes('chat/completions')).length;
        const afterB2 = mockB.requests.filter(r => r.url.includes('chat/completions')).length;
        expect(afterB2 - beforeB2, 'profile B active: mock B should have received the turn').toBeGreaterThanOrEqual(1);
        expect(afterA2 - beforeA2, 'profile B active: mock A should NOT have received the turn').toBe(0);

        // Restart server; both profiles must still be present on disk.
        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        const persisted = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            const cm = ctx.extensionSettings?.connectionManager;
            return {
                count: cm?.profiles?.length || 0,
                names: (cm?.profiles || []).map(p => p.name).sort(),
            };
        });
        expect(persisted.count).toBe(2);
        expect(persisted.names).toEqual(['mock-A', 'mock-B']);
    });
});
