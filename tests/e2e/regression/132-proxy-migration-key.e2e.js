// Regression — the deprecated proxy→base-url migration must preserve the
// profile proxy credential.
//
// Bug shape: `migrateProxyToBaseUrl` resolved the secret-store key from
// `profile.source`, a field cc profiles never carry (they use `api`), and
// only read the profile's `proxy-password` snapshot. The historical data
// shape keeps the password in the top-level `proxies` preset while the
// profile snapshot holds only the URL, so the password was never written to
// the secret store while the legacy fields were deleted unconditionally.
// Subsequent requests through the migrated profile fell back to the active
// provider secret — the wrong key was sent upstream and the Request
// Inspector displayed it.
//
// REAL USER FLOW: seed a cc profile naming a legacy proxy preset (password
// in the preset, as the pre-refactor UI wrote), boot the server so init()
// runs the one-shot migration, then drive a plugin generation through the
// profile and assert the upstream mock received the proxy credential, not
// the stored provider secret.

import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';

let server, mock;

const PROXY_KEY = 'legacy-proxy-secret-key';
const STORED_KEY = 'stored-provider-secret-key';
const PROFILE_NAME = 'e2e-migrated-proxy';
const PROFILE_ID = 'e2e-migrated-proxy-id';
const PROXY_PRESET_NAME = 'e2e-legacy-preset';

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: ['migration reply.'] });
    server = await startServer({ batchKey: 'regression', scenarioId: '132-proxy-migration-key' });
    markOnboarded({ dataRoot: server.dataRoot });

    const settingsPath = resolve(server.dataRoot, 'default-user', 'settings.json');
    const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
    s.main_api = 'openai';
    s.oai_settings = s.oai_settings || {};
    s.oai_settings.chat_completion_source = 'custom';
    s.oai_settings.custom_url = mock.baseURL;
    s.oai_settings.custom_model = 'mock-gpt-4o';
    s.oai_settings.openai_model = 'mock-gpt-4o';
    s.oai_settings.stream_openai = false;

    // Top-level proxy preset store — the password lives HERE, matching the
    // historical shape (`profile.proxy` names the preset).
    s.proxies = [
        { name: 'None', url: '', password: '' },
        { name: PROXY_PRESET_NAME, url: mock.baseURL, password: PROXY_KEY },
    ];

    const ext = (s.extension_settings = s.extension_settings || {});
    ext.connectionManager = ext.connectionManager || { profiles: [], selectedProfile: null };
    // Clear the one-shot flag so the migration actually runs in this scratch
    // dataRoot (the repo's data/ already carries it).
    delete ext.connectionManager._proxyToBaseUrlMigratedAt;
    ext.connectionManager.selectedProfile = null;
    ext.connectionManager.profiles = [{
        id: PROFILE_ID,
        name: PROFILE_NAME,
        api: 'custom',
        mode: 'cc',
        preset: '',
        model: 'mock-gpt-4o',
        proxy: PROXY_PRESET_NAME,
        'proxy-url': mock.baseURL,
        // No 'proxy-password' snapshot — historical shape keeps it in the preset.
        'chat-completion-source': 'custom',
        'api-url': mock.baseURL,
        'custom-url': mock.baseURL,
    }];
    writeFileSync(settingsPath, JSON.stringify(s, null, 4));

    const secretsPath = resolve(server.dataRoot, 'default-user', 'secrets.json');
    let secrets = {};
    try { secrets = JSON.parse(readFileSync(secretsPath, 'utf8')); } catch { /* first seed */ }
    secrets['api_key_custom'] = [{
        id: 'e2e-stored-custom-key',
        value: STORED_KEY,
        label: 'e2e-mock',
        active: true,
    }];
    writeFileSync(secretsPath, JSON.stringify(secrets, null, 4));
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test('proxy→base-url migration preserves the profile credential and plugin requests use it', async ({ page }) => {
    test.setTimeout(120_000);
    await awaitMainUI(page, server.baseURL);

    // Migration runs during extension init; wait until the profile snapshot
    // on disk shows the migrated shape.
    const settingsPath = resolve(server.dataRoot, 'default-user', 'settings.json');
    await expect.poll(() => {
        const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
        const p = s.extension_settings?.connectionManager?.profiles?.find(x => x.id === PROFILE_ID);
        return Boolean(p && p['base-url'] === mock.baseURL && p['secret-id'] && !('proxy-password' in p) && !('proxy-url' in p));
    }, { message: 'migration must set base-url + secret-id and drop the legacy proxy fields', timeout: 30_000 }).toBe(true);

    const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const migrated = s.extension_settings.connectionManager.profiles.find(x => x.id === PROFILE_ID);
    expect(migrated['base-url']).toBe(mock.baseURL);
    expect(migrated.proxy).toBeUndefined();

    // The proxy password must exist in the secret store under the profile's
    // resolved source key (custom), and the profile must point at it.
    const secretsPath = resolve(server.dataRoot, 'default-user', 'secrets.json');
    await expect.poll(() => {
        const secrets = JSON.parse(readFileSync(secretsPath, 'utf8'));
        const entries = secrets['api_key_custom'] || [];
        return entries.some(e => e.value === PROXY_KEY && e.id === migrated['secret-id']);
    }, { message: 'the migrated proxy password must be written to api_key_custom and selected by the profile', timeout: 15_000 }).toBe(true);

    // Real plugin path through the migrated profile.
    const result = await page.evaluate(async ({ profileName }) => {
        const ctx = window.Luker.getContext();
        try {
            const terminal = await ctx.generateTask({
                taskMessages: [{ role: 'user', content: 'Log the crossing.' }],
                includeCharacterCard: false,
                apiPresetName: profileName,
            });
            return { ok: true, text: String(terminal?.assistantText || '') };
        } catch (err) {
            return { ok: false, error: String(err?.message || err) };
        }
    }, { profileName: PROFILE_NAME });

    expect(result.ok, `plugin generateTask must succeed: ${result.error}`).toBe(true);

    const chatCall = mock.requests.find(r => (r.url || '').includes('/chat/completions'));
    expect(chatCall, 'mock upstream must have received the plugin request').toBeTruthy();
    const wireAuth = String(chatCall.headers?.authorization || '');
    expect(wireAuth, 'upstream must receive the migrated proxy credential, not the stored provider secret').toBe(`Bearer ${PROXY_KEY}`);

    // The inspector must fingerprint the same credential that went on the wire.
    const detail = await page.evaluate(async () => {
        const summaries = await (await fetch('/api/request-inspector/list')).json();
        const chat = summaries.find(x => x.type === 'chat');
        if (!chat) return null;
        return await (await fetch(`/api/request-inspector/${chat.id}`)).json();
    });

    expect(detail, 'inspector must have a chat entry').toBeTruthy();
    expect(detail.apiKeyFingerprint).toBe(`${PROXY_KEY.slice(0, 4)}...${PROXY_KEY.slice(-4)} (${PROXY_KEY.length} chars)`);
});
