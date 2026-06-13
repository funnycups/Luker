// #39 — Save connection profile → list → switch → request goes to that backend.
//
// Spawn TWO independent mock LLM endpoints. Pre-seed two profiles A→mock1,
// B→mock2 in settings.json. After the UI loads, drive the connection-manager
// /profile slash command to switch profiles in-between turns and assert that:
//
//   - each mock only sees the chat-completion requests dispatched while it
//     was the active backend (no cross-talk)
//   - the profile list survives a server restart with both entries intact

import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply, reloadAndAwait } from '../_lib/page.js';

let server, mockA, mockB;

function seedTwoProfiles({ dataRoot, urlA, urlB }) {
    const settingsPath = resolve(dataRoot, 'default-user', 'settings.json');
    const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
    // settings.json uses snake_case `extension_settings` on disk — the client
    // hydrates `extensionSettings` (camelCase) from it. Writing the seed under
    // the disk key is what makes the client actually see the profiles.
    s.extension_settings = s.extension_settings || {};
    const profileA = {
        id: 'pid-A',
        name: 'mock-A',
        // `api: 'custom'` routes through the connection-manager slash chain as
        // `/api custom` → flips oai_settings.chat_completion_source to CUSTOM,
        // then `/api-url <url>` populates oai_settings.custom_url. `api: 'openai'`
        // would silently fall through to the standard OpenAI source and never
        // actually point at our mock.
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
    const profileB = {
        ...profileA,
        id: 'pid-B',
        name: 'mock-B',
        'api-url': urlB,
    };
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
    // Default the custom-backend bootstrap to mock A — it is what profile A
    // points at so the first turn is unambiguous.
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mockA.baseURL });
    seedTwoProfiles({ dataRoot: server.dataRoot, urlA: mockA.baseURL, urlB: mockB.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mockA?.stop();
    await mockB?.stop();
});

test.describe('#39 — connection profile switching routes per backend', () => {
    test('two profiles, two backends; switch flips which mock receives the next turn', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        // Wait for greeting to settle so MESSAGE_RECEIVED later belongs to /send.
        await page.waitForFunction(() => {
            const ctx = window.SillyTavern.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        // Profile A active by virtue of seed + bootstrap. Send turn 1.
        const beforeA1 = mockA.requests.length;
        const beforeB1 = mockB.requests.length;
        await sendMessageAndAwaitReply(page, 'I followed the cliff path north of the gull rocks; the tide is restless.');
        const afterA1 = mockA.requests.filter(r => r.url.includes('chat/completions')).length;
        const afterB1 = mockB.requests.filter(r => r.url.includes('chat/completions')).length;
        const aDelta1 = afterA1 - mockA.requests.slice(0, beforeA1).filter(r => r.url.includes('chat/completions')).length;
        const bDelta1 = afterB1 - mockB.requests.slice(0, beforeB1).filter(r => r.url.includes('chat/completions')).length;
        expect(aDelta1, 'profile A active: mock A should have received the turn').toBeGreaterThanOrEqual(1);
        expect(bDelta1, 'profile A active: mock B should NOT have received the turn').toBe(0);

        // Switch to profile B via slash command.
        await page.evaluate(async () => {
            await window.SillyTavern.getContext().executeSlashCommandsWithOptions('/profile mock-B');
        });
        // Give the apply-spinner a beat to finish the slash chain.
        await page.waitForTimeout(500);

        const beforeA2 = mockA.requests.filter(r => r.url.includes('chat/completions')).length;
        const beforeB2 = mockB.requests.filter(r => r.url.includes('chat/completions')).length;
        await sendMessageAndAwaitReply(page, 'Three breakers north — they do not move with the moon.');
        const afterA2 = mockA.requests.filter(r => r.url.includes('chat/completions')).length;
        const afterB2 = mockB.requests.filter(r => r.url.includes('chat/completions')).length;
        const aDelta2 = afterA2 - beforeA2;
        const bDelta2 = afterB2 - beforeB2;
        expect(bDelta2, 'profile B active: mock B should have received the turn').toBeGreaterThanOrEqual(1);
        expect(aDelta2, 'profile B active: mock A should NOT have received the turn').toBe(0);

        // Restart server; reopen; the two profiles must still be present on disk.
        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        const persisted = await page.evaluate(() => {
            const ctx = window.SillyTavern.getContext();
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
