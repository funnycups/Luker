// Regression — Request Inspector must show the credential that actually
// went on the wire when a plugin overrides the auth header.
//
// Bug shape: a plugin (e.g. JS-Slash-Runner) issuing a CUSTOM-source request
// through the deprecated reverse-proxy presets sets
// `custom_include_headers` with an `Authorization: Bearer <proxy-key>`
// override. Providers merge custom_include_headers AFTER the resolved auth
// header, so the wire credential is the plugin/proxy key while the inspector
// still fingerprinted the stored provider secret — the Request Inspector
// displayed the wrong API key.
//
// REAL USER FLOW: boot the server, drive a plugin generation through
// `Luker.getContext().generateTask` with an apiPresetName bound to a
// connection profile whose `custom-include-headers` carries the override,
// then read the inspector detail through the real HTTP router. Assert both
// the mock upstream saw the override key and the inspector fingerprint
// matches it.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { appendConnectionProfile, bootstrapCustomBackend, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';

let server, mock, profile;

const WIRE_KEY = 'plugin-wire-key';
const STORED_KEY = 'stored-provider-key';

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: ['the tide log holds.'] });
    server = await startServer({ batchKey: 'regression', scenarioId: '131-inspector-wire-key' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    profile = appendConnectionProfile({
        dataRoot: server.dataRoot,
        baseURL: mock.baseURL,
        name: 'e2e-inspector-wire-key',
        api: 'custom',
        source: 'custom',
        profileOverrides: {
            'custom-include-headers': `Authorization: Bearer ${WIRE_KEY}\n`,
        },
    });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test('plugin request with custom auth override fingerprints the wire key', async ({ page }) => {
    test.setTimeout(120_000);
    await awaitMainUI(page, server.baseURL);

    // Seed the stored custom secret AFTER boot so the plugin path resolves a
    // real stored credential that could shadow the override if the
    // fingerprint regressed.
    await page.evaluate(async ({ storedKey }) => {
        const { writeSecret, SECRET_KEYS } = await import('/scripts/secrets.js');
        await writeSecret(SECRET_KEYS.CUSTOM, storedKey, 'e2e stored key', { allowEmpty: false });
    }, { storedKey: STORED_KEY });

    // Real plugin path: generateTask with an apiPresetName → profile resolver
    // → apiSettingsOverride (custom_include_headers) → dispatch.
    const result = await page.evaluate(async ({ profileName }) => {
        const ctx = window.Luker.getContext();
        try {
            const terminal = await ctx.generateTask({
                taskMessages: [{ role: 'user', content: 'Report the tide.' }],
                includeCharacterCard: false,
                apiPresetName: profileName,
            });
            return { ok: true, text: String(terminal?.assistantText || '') };
        } catch (err) {
            return { ok: false, error: String(err?.message || err) };
        }
    }, { profileName: profile.name });

    expect(result.ok, `plugin generateTask must succeed: ${result.error}`).toBe(true);

    // The mock upstream must have received the override key, not the stored one.
    const chatCall = mock.requests.find(r => (r.url || '').includes('/chat/completions'));
    expect(chatCall, 'mock upstream must have received the plugin request').toBeTruthy();
    const wireAuth = String(chatCall.headers?.authorization || '');
    expect(wireAuth).toBe(`Bearer ${WIRE_KEY}`);

    // The inspector detail must fingerprint that same key. Read through the
    // real HTTP router the UI uses.
    const detail = await page.evaluate(async () => {
        const listResp = await fetch('/api/request-inspector/list', { method: 'GET' });
        const summaries = await listResp.json();
        const chat = summaries.find(s => s.type === 'chat');
        if (!chat) return null;
        const detailResp = await fetch(`/api/request-inspector/${chat.id}`);
        return detailResp.json();
    });

    expect(detail, 'inspector must have a chat entry for the plugin request').toBeTruthy();
    // fingerprint format: first4...last4 (N chars)
    expect(detail.apiKeyFingerprint).toBe(`${WIRE_KEY.slice(0, 4)}...${WIRE_KEY.slice(-4)} (${WIRE_KEY.length} chars)`);
    expect(detail.apiKeyFingerprint).not.toContain(STORED_KEY.slice(0, 4));
});
