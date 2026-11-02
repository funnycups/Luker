/**
 * Behavioral tests for the staged asset download and for hiding staging
 * entries from the asset listing. The download source is a loopback
 * http.Server, whitelisted through the config environment override before
 * content-manager.js reads it at module load.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import http from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import express from 'express';
import request from 'supertest';

process.env.SILLYTAVERN_WHITELISTIMPORTDOMAINS = JSON.stringify(['127.0.0.1']);

const SONG = Buffer.from('ID3-not-really-an-mp3');

function stagingEntries(dir) {
    return fs.readdirSync(dir).filter(name => name.startsWith('.luker-staging-'));
}

describe('assets staging', () => {
    let router;
    let gate;
    let source;
    let sourceUrl;
    let userRoot;
    let assetsDir;
    let dirtyCalls;

    beforeAll(async () => {
        ({ router } = await import('../../src/endpoints/assets.js'));
        gate = await import('../../src/sync/in-progress-gate.js');
        source = http.createServer((req, res) => {
            if (req.url === '/song.mp3') {
                res.setHeader('Content-Type', 'audio/mpeg');
                res.end(SONG);
                return;
            }
            res.statusCode = 404;
            res.end();
        });
        await new Promise(resolve => source.listen(0, '127.0.0.1', resolve));
        sourceUrl = `http://127.0.0.1:${source.address().port}`;
    });

    afterAll(() => new Promise(resolve => source.close(resolve)));

    beforeEach(() => {
        userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-assets-staging-'));
        assetsDir = path.join(userRoot, 'assets');
        fs.mkdirSync(assetsDir);
        dirtyCalls = [];
        gate._resetGateForTests();
        gate.setDirtyListener(info => { dirtyCalls.push(info); });
    });

    afterEach(() => {
        gate._resetGateForTests();
        fs.rmSync(userRoot, { recursive: true, force: true });
    });

    function buildApp() {
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.user = {
                profile: { handle: 'test-user' },
                directories: { root: userRoot, assets: assetsDir },
            };
            next();
        });
        app.use(router);
        return app;
    }

    test('download lands the file with no staging left and marks dirty once', async () => {
        const res = await request(buildApp()).post('/download').send({ url: `${sourceUrl}/song.mp3`, category: 'bgm', filename: 'song.mp3' });
        expect(res.status).toBe(200);
        expect(fs.readFileSync(path.join(assetsDir, 'bgm', 'song.mp3'))).toEqual(SONG);
        expect(stagingEntries(path.join(assetsDir, 'bgm'))).toEqual([]);
        expect(dirtyCalls).toEqual([{ handle: 'test-user', userRoot: path.resolve(userRoot) }]);
    });

    test('a failed download leaves neither the file nor staging and does not mark dirty', async () => {
        const res = await request(buildApp()).post('/download').send({ url: `${sourceUrl}/missing.mp3`, category: 'bgm', filename: 'missing.mp3' });
        expect(res.status).toBe(500);
        expect(fs.readdirSync(path.join(assetsDir, 'bgm'))).toEqual([]);
        expect(dirtyCalls).toEqual([]);
    });

    test('get lists no staging entries', async () => {
        await request(buildApp()).post('/get').send({});
        fs.writeFileSync(path.join(assetsDir, 'bgm', 'song.mp3'), SONG);
        fs.mkdirSync(path.join(assetsDir, 'bgm', '.luker-staging-asset-1'));
        fs.writeFileSync(path.join(assetsDir, 'bgm', '.luker-staging-asset-1', 'partial.mp3'), 'PART');
        fs.mkdirSync(path.join(assetsDir, 'live2d', 'girl'), { recursive: true });
        fs.writeFileSync(path.join(assetsDir, 'live2d', 'girl', 'girl.model3.json'), '{}');
        fs.mkdirSync(path.join(assetsDir, 'live2d', '.luker-staging-asset-2'));
        fs.writeFileSync(path.join(assetsDir, 'live2d', '.luker-staging-asset-2', 'girl.model3.json'), '{}');
        fs.mkdirSync(path.join(assetsDir, 'vrm', 'model', '.luker-staging-asset-3'), { recursive: true });
        fs.writeFileSync(path.join(assetsDir, 'vrm', 'model', '.luker-staging-asset-3', 'avatar.vrm'), 'PART');

        const res = await request(buildApp()).post('/get').send({});
        expect(res.status).toBe(200);
        expect(res.body.bgm).toEqual(['assets/bgm/song.mp3']);
        expect(res.body.live2d).toHaveLength(1);
        expect(JSON.stringify(res.body)).not.toContain('.luker-staging-');
    });
});
