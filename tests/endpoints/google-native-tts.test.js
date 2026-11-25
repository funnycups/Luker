import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { getGoogleApiConfig, router as googleRouter } from '../../src/endpoints/google.js';
import { SECRET_KEYS, SecretManager } from '../../src/endpoints/secrets.js';

describe('Google AI Studio config and native TTS endpoint', () => {
    let tempDir;
    let directories;
    let firstKeyId;
    let activeKeyId;

    beforeAll(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-google-tts-test-'));
        directories = { root: tempDir, backups: tempDir };
        const manager = new SecretManager(directories);
        firstKeyId = manager.writeSecret(SECRET_KEYS.MAKERSUITE, 'key-slot-one', 'TTS Direct Key');
        activeKeyId = manager.writeSecret(SECRET_KEYS.MAKERSUITE, 'key-slot-two-active', 'Global Active Key');
    });

    afterAll(() => {
        if (tempDir) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    function makeReq(body) {
        return {
            body,
            user: { directories },
        };
    }

    test('normalizes MakerSuite base_url and reverse_proxy without duplicating /v1beta', async () => {
        const withVersion = await getGoogleApiConfig(
            makeReq({ api: 'makersuite', base_url: 'https://proxy.example/v1beta/' }),
            'gemini-3.1-flash-tts-preview',
        );
        expect(withVersion.url).toBe('https://proxy.example/v1beta/models/gemini-3.1-flash-tts-preview:generateContent');

        const withPrefixAndVersion = await getGoogleApiConfig(
            makeReq({ api: 'makersuite', base_url: 'https://proxy.example/gemini/v1beta' }),
            'gemini-3.1-flash-tts-preview',
        );
        expect(withPrefixAndVersion.url).toBe('https://proxy.example/gemini/v1beta/models/gemini-3.1-flash-tts-preview:generateContent');

        const proxyWins = await getGoogleApiConfig(
            makeReq({
                api: 'makersuite',
                base_url: 'https://ignored.example/v1beta',
                reverse_proxy: 'https://preferred.example/v1',
            }),
            'gemini-3.1-flash-tts-preview',
        );
        expect(proxyWins.url).toBe('https://preferred.example/v1beta/models/gemini-3.1-flash-tts-preview:generateContent');
    });

    test('uses the explicitly bound secret_id instead of the globally active secret', async () => {
        const globalCfg = await getGoogleApiConfig(
            makeReq({ api: 'makersuite', strict_secret_id: false }),
            'gemini-3.1-flash-tts-preview',
        );
        expect(globalCfg.headers['x-goog-api-key']).toBe('key-slot-two-active');
        expect(activeKeyId).not.toBe(firstKeyId);

        const profileCfg = await getGoogleApiConfig(
            makeReq({ api: 'makersuite', secret_id: firstKeyId, strict_secret_id: true }),
            'gemini-3.1-flash-tts-preview',
        );
        expect(profileCfg.headers['x-goog-api-key']).toBe('key-slot-one');
    });

    test('never falls back to global active key when strict_secret_id is set', async () => {
        await expect(getGoogleApiConfig(
            makeReq({ api: 'makersuite', secret_id: 'deleted-secret-id', strict_secret_id: true }),
            'gemini-3.1-flash-tts-preview',
        )).rejects.toMatchObject({
            status: 400,
            message: expect.stringContaining('deleted-secret-id'),
        });

        await expect(getGoogleApiConfig(
            makeReq({ api: 'makersuite', secret_id: '', strict_secret_id: true }),
            'gemini-3.1-flash-tts-preview',
        )).rejects.toMatchObject({
            status: 400,
        });

        // Keyless custom base_url with strict_secret_id sends an empty key rather than leaking the global key.
        const keylessCustom = await getGoogleApiConfig(
            makeReq({
                api: 'makersuite',
                base_url: 'https://gateway.local/gemini',
                secret_id: '',
                strict_secret_id: true,
            }),
            'gemini-3.1-flash-tts-preview',
        );
        expect(keylessCustom.headers['x-goog-api-key']).toBe('');
        expect(keylessCustom.url).toBe('https://gateway.local/gemini/v1beta/models/gemini-3.1-flash-tts-preview:generateContent');
    });

    test('POST /generate-native-tts returns 400 with explicit message when bound secret_id is missing', async () => {
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.user = { directories };
            next();
        });
        app.use('/api/google', googleRouter);

        const res = await request(app)
            .post('/api/google/generate-native-tts')
            .send({
                text: 'Hello',
                voice: 'Zephyr',
                model: 'gemini-3.1-flash-tts-preview',
                api: 'makersuite',
                secret_id: 'nonexistent-slot',
                strict_secret_id: true,
            });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({
            error: expect.stringContaining('nonexistent-slot'),
        });
    });
});
