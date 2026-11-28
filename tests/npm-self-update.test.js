import { describe, expect, test } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import {
    buildNpmGlobalUpdateArgs,
    detectNpmGlobalPrefix,
    normalizeNpmUpdateTarget,
} from '../src/updater.js';
import { router as usersAdminRouter } from '../src/endpoints/users-admin.js';

describe('npm self-update helpers', () => {
    test('detectNpmGlobalPrefix resolves POSIX and Windows global prefixes and ignores non-global paths', () => {
        expect(detectNpmGlobalPrefix(
            '/usr/local/lib/node_modules/@funnycups/luker',
            '@funnycups/luker',
            { platform: 'darwin' },
        )).toBe('/usr/local');

        expect(detectNpmGlobalPrefix(
            '/tmp/custom-prefix/lib/node_modules/@funnycups/luker',
            '@funnycups/luker',
            { platform: 'linux' },
        )).toBe('/tmp/custom-prefix');

        expect(detectNpmGlobalPrefix(
            'C:\\Users\\demo\\AppData\\Roaming\\npm\\node_modules\\@funnycups\\luker',
            '@funnycups/luker',
            { platform: 'win32' },
        )).toBe('C:\\Users\\demo\\AppData\\Roaming\\npm');

        expect(detectNpmGlobalPrefix(
            '/Users/demo/projects/Luker',
            '@funnycups/luker',
            { platform: 'darwin' },
        )).toBeNull();

        expect(detectNpmGlobalPrefix(
            '/home/node/app',
            '@funnycups/luker',
            { platform: 'linux' },
        )).toBeNull();

        expect(detectNpmGlobalPrefix(
            '/Users/demo/.npm/_npx/abcdef/node_modules/@funnycups/luker',
            '@funnycups/luker',
            { platform: 'darwin' },
        )).toBeNull();
    });

    test('normalizeNpmUpdateTarget validates strict SemVer strings and rejects unsafe inputs', () => {
        expect(normalizeNpmUpdateTarget('v2.9.0')).toBe('2.9.0');
        expect(normalizeNpmUpdateTarget('2.9.0-rc.7')).toBe('2.9.0-rc.7');
        expect(normalizeNpmUpdateTarget('v2.9.0-rc.6.dev.20261128.12.g8d9ac4c')).toBe('2.9.0-rc.6.dev.20261128.12.g8d9ac4c');

        expect(normalizeNpmUpdateTarget('2.9.0 && echo pwned')).toBeNull();
        expect(normalizeNpmUpdateTarget('https://evil.invalid/pkg.tgz')).toBeNull();
        expect(normalizeNpmUpdateTarget('latest')).toBeNull();
        expect(normalizeNpmUpdateTarget('')).toBeNull();
        expect(normalizeNpmUpdateTarget(123)).toBeNull();
    });

    test('buildNpmGlobalUpdateArgs builds safe npm install -g arguments with optional prefix', () => {
        expect(buildNpmGlobalUpdateArgs({
            packageName: '@funnycups/luker',
            targetVersion: 'v2.9.0',
            prefix: '/opt/homebrew',
        })).toEqual([
            'install',
            '-g',
            '--no-audit',
            '--no-fund',
            '--prefix',
            '/opt/homebrew',
            '@funnycups/luker@2.9.0',
        ]);

        expect(buildNpmGlobalUpdateArgs({
            packageName: '@funnycups/luker',
            targetVersion: '2.9.0-rc.7',
        })).toEqual([
            'install',
            '-g',
            '--no-audit',
            '--no-fund',
            '@funnycups/luker@2.9.0-rc.7',
        ]);
    });

    test('POST /api/users/update/start rejects invalid targetVersion with 400', async () => {
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.user = { profile: { handle: 'admin', admin: true } };
            next();
        });
        app.use('/api/users', usersAdminRouter);

        const res = await request(app)
            .post('/api/users/update/start')
            .send({ targetVersion: '2.9.0; rm -rf /' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/Invalid target version/i);
    });
});
