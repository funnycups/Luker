// #44 — Live LLM 3-backend smoke (Anthropic / OpenAI / Gemini).
//
// Opt-in: set LIVE=1 plus the relevant API keys to enable the spec.
// When LIVE is not set, the describe block is suppressed entirely —
// no skipped-test noise, no false sense of coverage. Each per-backend
// test inside still fails loud if its own API key is missing.
//
// IMPORTANT: per memory `feedback_llm_conventions`, do not add timeouts to
// LLM-request paths. Playwright's per-test timeout is enough.

import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';

const LIVE = process.env.LIVE === '1';
const liveDescribe = LIVE ? test.describe : test.describe.skip;

let server;

test.beforeAll(async () => {
    if (!LIVE) return;
    server = await startServer({ batchKey: 'server', scenarioId: 'live-smoke' });
    markOnboarded({ dataRoot: server.dataRoot });
});

test.afterAll(async () => {
    if (server) await tearDownServer(server);
});

function configureBackend({ dataRoot, source, model, secretKey, value }) {
    const settingsPath = resolve(dataRoot, 'default-user', 'settings.json');
    const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
    s.main_api = 'openai';
    s.firstRun = false;
    s.oai_settings = s.oai_settings || {};
    s.oai_settings.chat_completion_source = source;
    s.oai_settings.openai_model = model;
    s.oai_settings[`${source}_model`] = model;
    s.oai_settings.stream_openai = false;
    writeFileSync(settingsPath, JSON.stringify(s, null, 4));
    // The secret is read from data-root/default-user/secrets.json.
    const secretsPath = resolve(dataRoot, 'default-user', 'secrets.json');
    let secrets = {};
    try { secrets = JSON.parse(readFileSync(secretsPath, 'utf8')); } catch {}
    secrets[secretKey] = value;
    writeFileSync(secretsPath, JSON.stringify(secrets, null, 4));
}

liveDescribe('#44 — live 3-backend smoke', () => {
    test.describe.configure({ mode: 'serial' });

    test('Anthropic (Claude) — chat-completion round-trip', async ({ page }) => {
        expect(process.env.ANTHROPIC_API_KEY, 'ANTHROPIC_API_KEY required for LIVE=1 run').toBeTruthy();
        configureBackend({
            dataRoot: server.dataRoot,
            source: 'claude',
            model: 'claude-haiku-4-5',
            secretKey: 'api_key_claude',
            value: process.env.ANTHROPIC_API_KEY,
        });
        await server.restart();
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        const { text } = await sendMessageAndAwaitReply(
            page,
            'Briefly describe the lantern that hangs at the cliff watchpost. Two sentences.',
            { timeoutMs: 60_000 },
        );
        expect(text.length).toBeGreaterThan(20);
    });

    test('OpenAI — chat-completion round-trip', async ({ page }) => {
        expect(process.env.OPENAI_API_KEY, 'OPENAI_API_KEY required for LIVE=1 run').toBeTruthy();
        configureBackend({
            dataRoot: server.dataRoot,
            source: 'openai',
            model: 'gpt-4o-mini',
            secretKey: 'api_key_openai',
            value: process.env.OPENAI_API_KEY,
        });
        await server.restart();
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        const { text } = await sendMessageAndAwaitReply(
            page,
            'Briefly describe the lantern that hangs at the cliff watchpost. Two sentences.',
            { timeoutMs: 60_000 },
        );
        expect(text.length).toBeGreaterThan(20);
    });

    test('Gemini (MakerSuite) — chat-completion round-trip', async ({ page }) => {
        expect(process.env.GOOGLE_API_KEY, 'GOOGLE_API_KEY required for LIVE=1 run').toBeTruthy();
        configureBackend({
            dataRoot: server.dataRoot,
            source: 'makersuite',
            model: 'gemini-2.5-flash',
            secretKey: 'api_key_makersuite',
            value: process.env.GOOGLE_API_KEY,
        });
        await server.restart();
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        const { text } = await sendMessageAndAwaitReply(
            page,
            'Briefly describe the lantern that hangs at the cliff watchpost. Two sentences.',
            { timeoutMs: 60_000 },
        );
        expect(text.length).toBeGreaterThan(20);
    });
});
