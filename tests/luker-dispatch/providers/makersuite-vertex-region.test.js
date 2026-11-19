// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';

import { beforeAll, describe, expect, jest, test } from '@jest/globals';

// Full (service account) auth exchanges a JWT for an access token through
// node-fetch. That token exchange is the only upstream call made before the
// dispatch fetch under test, so the mock returns a token for it.
const tokenFetch = jest.fn(async () => ({
    ok: true,
    json: async () => ({ access_token: 'sa-access-token' }),
}));

jest.unstable_mockModule('node-fetch', () => ({ default: tokenFetch }));

let dispatchMakerSuite;

beforeAll(async () => {
    ({ dispatchMakerSuite } = await import('../../../src/luker-dispatch/providers/chat-completions/makersuite.js'));
});

function createSecretsRoot(secrets) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-vertex-region-'));
    fs.writeFileSync(path.join(root, 'secrets.json'), JSON.stringify(secrets, null, 4));
    return root;
}

function fakeCtx({ body, directories, secretsReadImpl }) {
    const emitted = [];
    const ac = new AbortController();

    return {
        body: {
            chat_completion_source: 'vertexai',
            model: 'gemini-2.5-pro',
            messages: [{ role: 'user', content: 'hi' }],
            stream: false,
            max_tokens: 128,
            temperature: 0.7,
            top_p: 1,
            ...body,
        },
        user: {
            handle: 'alice',
            directories,
            profile: { handle: 'alice' },
        },
        signal: ac.signal,
        fetch: jest.fn(async () => new Response(JSON.stringify({
            candidates: [{
                content: { role: 'model', parts: [{ text: 'hello back' }] },
                finishReason: 'STOP',
            }],
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
        }), { status: 200, headers: { 'content-type': 'application/json' } })),
        secrets: { read: jest.fn((key) => (secretsReadImpl ? secretsReadImpl(key) : '')) },
        generation: {
            startJob: jest.fn(() => null),
            appendEvent: jest.fn(),
            hasActiveKeepAliveJob: jest.fn(() => false),
        },
        inspection: {
            start: jest.fn(),
            attach: jest.fn(),
            complete: jest.fn(),
            fail: jest.fn(),
        },
        emit: {
            head: (h) => emitted.push({ kind: 'head', data: h }),
            chunk: (b) => emitted.push({ kind: 'chunk', data: b }),
            end: () => emitted.push({ kind: 'end' }),
            error: (e) => emitted.push({ kind: 'error', error: e }),
        },
        _emitted: emitted,
    };
}

function requestUrl(ctx) {
    return String(ctx.fetch.mock.calls[0][0]);
}

describe('Vertex AI chat completions region endpoints', () => {
    test('express mode with a project id keeps /locations/eu/ and uses the eu multi-region host', async () => {
        const directories = {
            root: createSecretsRoot({
                api_key_vertexai: [{ value: 'vertex-express-key', active: true }],
            }),
        };
        const ctx = fakeCtx({
            body: {
                vertexai_auth_mode: 'express',
                vertexai_region: 'eu',
                vertexai_express_project_id: 'express-project',
            },
            directories,
        });

        await dispatchMakerSuite(ctx);

        expect(requestUrl(ctx)).toBe(
            'https://aiplatform.eu.rep.googleapis.com/v1/projects/express-project/locations/eu/publishers/google/models/gemini-2.5-pro:generateContent?key=vertex-express-key',
        );
    });

    test('express mode with a project id keeps /locations/us/ and uses the us multi-region host', async () => {
        const directories = {
            root: createSecretsRoot({
                api_key_vertexai: [{ value: 'vertex-express-key', active: true }],
            }),
        };
        const ctx = fakeCtx({
            body: {
                vertexai_auth_mode: 'express',
                vertexai_region: 'us',
                vertexai_express_project_id: 'express-project',
            },
            directories,
        });

        await dispatchMakerSuite(ctx);

        expect(requestUrl(ctx)).toBe(
            'https://aiplatform.us.rep.googleapis.com/v1/projects/express-project/locations/us/publishers/google/models/gemini-2.5-pro:generateContent?key=vertex-express-key',
        );
    });

    test('express mode without a project id uses the multi-region host', async () => {
        const directories = {
            root: createSecretsRoot({
                api_key_vertexai: [{ value: 'vertex-express-key', active: true }],
            }),
        };
        const ctx = fakeCtx({
            body: {
                vertexai_auth_mode: 'express',
                vertexai_region: 'eu',
            },
            directories,
        });

        await dispatchMakerSuite(ctx);

        expect(requestUrl(ctx)).toBe(
            'https://aiplatform.eu.rep.googleapis.com/v1/publishers/google/models/gemini-2.5-pro:generateContent?key=vertex-express-key',
        );
    });

    describe('full (service account) mode', () => {
        const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
        const serviceAccountJson = JSON.stringify({
            type: 'service_account',
            project_id: 'sa-project',
            client_email: 'sa@example.iam.gserviceaccount.com',
            private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        });

        function fullModeCtx(region) {
            const directories = {
                root: createSecretsRoot({
                    vertexai_service_account_json: [{ value: serviceAccountJson, active: true }],
                }),
            };
            return fakeCtx({
                body: {
                    vertexai_auth_mode: 'full',
                    vertexai_region: region,
                },
                directories,
                secretsReadImpl: (key) => (key === 'vertexai_service_account_json' ? serviceAccountJson : ''),
            });
        }

        test('eu uses the eu multi-region host and keeps /locations/eu/', async () => {
            const ctx = fullModeCtx('eu');
            await dispatchMakerSuite(ctx);

            expect(requestUrl(ctx)).toBe(
                'https://aiplatform.eu.rep.googleapis.com/v1/projects/sa-project/locations/eu/publishers/google/models/gemini-2.5-pro:generateContent',
            );
        });

        test('us uses the us multi-region host and keeps /locations/us/', async () => {
            const ctx = fullModeCtx('us');
            await dispatchMakerSuite(ctx);

            expect(requestUrl(ctx)).toBe(
                'https://aiplatform.us.rep.googleapis.com/v1/projects/sa-project/locations/us/publishers/google/models/gemini-2.5-pro:generateContent',
            );
        });

        test('global keeps the global host and /locations/global/', async () => {
            const ctx = fullModeCtx('global');
            await dispatchMakerSuite(ctx);

            expect(requestUrl(ctx)).toBe(
                'https://aiplatform.googleapis.com/v1/projects/sa-project/locations/global/publishers/google/models/gemini-2.5-pro:generateContent',
            );
        });

        test('single regions keep the location-prefixed host', async () => {
            const ctx = fullModeCtx('europe-west2');
            await dispatchMakerSuite(ctx);

            expect(requestUrl(ctx)).toBe(
                'https://europe-west2-aiplatform.googleapis.com/v1/projects/sa-project/locations/europe-west2/publishers/google/models/gemini-2.5-pro:generateContent',
            );
        });
    });
});
