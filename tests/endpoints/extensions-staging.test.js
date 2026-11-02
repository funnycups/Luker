/**
 * Behavioral tests for the staged extension install and update paths:
 * per-user extensions are cloned or updated in a `.luker-staging-*`
 * sibling and swapped into place under the sync write gate.
 *
 * The origin is a local repository served over smart HTTP by
 * `git http-backend` behind a loopback http.Server, so no outside network
 * is involved.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { afterAll, afterEach, beforeAll, describe, expect, test } from '@jest/globals';
import express from 'express';
import request from 'supertest';

process.env.SILLYTAVERN_GIT_BACKEND = 'auto';
process.env.SILLYTAVERN_EXTENSIONS_ENABLED = 'true';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-ext-staging-'));
// Keep the developer's global git config (hooksPath, rebase, signing) out of
// every git process this test and the router start.
const emptyGitConfig = path.join(scratch, 'empty-gitconfig');
fs.writeFileSync(emptyGitConfig, '');
process.env.GIT_CONFIG_GLOBAL = emptyGitConfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';

const IDENTITY = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid'];
const gitRun = (cwd, ...args) => execFileSync('git', [...IDENTITY, ...args], { cwd, encoding: 'utf8' }).trim();

/**
 * Serve every bare repository under `projectRoot` over smart HTTP through
 * the `git http-backend` CGI program.
 */
function startGitHttpServer(projectRoot) {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        const child = spawn('git', ['http-backend'], {
            env: {
                ...process.env,
                GIT_PROJECT_ROOT: projectRoot,
                GIT_HTTP_EXPORT_ALL: '1',
                PATH_INFO: url.pathname,
                QUERY_STRING: url.search.slice(1),
                REQUEST_METHOD: req.method,
                CONTENT_TYPE: req.headers['content-type'] || '',
                REMOTE_ADDR: '127.0.0.1',
            },
        });
        req.pipe(child.stdin);
        const chunks = [];
        child.stdout.on('data', chunk => chunks.push(chunk));
        child.on('close', () => {
            const output = Buffer.concat(chunks);
            const separator = output.indexOf('\r\n\r\n');
            let status = 200;
            for (const line of output.subarray(0, separator).toString().split('\r\n')) {
                const colon = line.indexOf(':');
                const name = line.slice(0, colon).trim();
                const value = line.slice(colon + 1).trim();
                if (name.toLowerCase() === 'status') status = parseInt(value, 10);
                else res.setHeader(name, value);
            }
            res.statusCode = status;
            res.end(output.subarray(separator + 4));
        });
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function stagingEntries(dir) {
    return fs.readdirSync(dir).filter(name => name.startsWith('.luker-staging-'));
}

describe('staged extension install and update', () => {
    let router;
    let gate;
    let constants;
    let originalGlobalExtensionsDir;
    let userRoot;
    let extensionsDir;
    let dirtyCalls;

    beforeAll(async () => {
        constants = await import('../../src/constants.js');
        originalGlobalExtensionsDir = constants.PUBLIC_DIRECTORIES.globalExtensions;
        constants.setGlobalExtensionsDirectory(path.join(scratch, 'global-extensions'));
        ({ router } = await import('../../src/endpoints/extensions.js'));
        gate = await import('../../src/sync/in-progress-gate.js');
    });

    afterAll(() => {
        constants.setGlobalExtensionsDirectory(originalGlobalExtensionsDir);
        fs.rmSync(scratch, { recursive: true, force: true });
    });

    let caseDir;
    function setUpCase(name) {
        caseDir = path.join(scratch, name);
        userRoot = path.join(caseDir, 'user');
        extensionsDir = path.join(userRoot, 'extensions');
        fs.mkdirSync(extensionsDir, { recursive: true });
        dirtyCalls = [];
        gate._resetGateForTests();
        gate.setDirtyListener(info => { dirtyCalls.push(info); });
    }

    afterEach(() => {
        gate._resetGateForTests();
    });

    function buildApp() {
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.user = {
                profile: { handle: 'test-user', admin: false },
                directories: { root: userRoot, extensions: extensionsDir },
            };
            next();
        });
        app.use(router);
        return app;
    }

    /** A working repo with one commit whose manifest carries `version`. */
    function makeSourceRepo(dir, version) {
        fs.mkdirSync(dir, { recursive: true });
        gitRun(dir, 'init', '-q', '-b', 'main');
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ display_name: 'Ext', version }));
        gitRun(dir, 'add', '.');
        gitRun(dir, 'commit', '-q', '-m', `v${version}`);
    }

    function addCommit(dir, version) {
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ display_name: 'Ext', version }));
        gitRun(dir, 'commit', '-q', '-am', `v${version}`);
        return gitRun(dir, 'rev-parse', 'HEAD');
    }

    describe('install over HTTP', () => {
        let server;
        let repoUrl;

        beforeAll(async () => {
            const httpRoot = path.join(scratch, 'http-root');
            makeSourceRepo(path.join(scratch, 'http-source'), '2.0.0');
            gitRun(scratch, 'clone', '-q', '--bare', path.join(scratch, 'http-source'), path.join(httpRoot, 'ext.git'));
            server = await startGitHttpServer(httpRoot);
            repoUrl = `http://127.0.0.1:${server.address().port}/ext.git`;
        });

        afterAll(() => new Promise(resolve => server.close(resolve)));

        test('a fresh install lands in place with no staging left and marks dirty once', async () => {
            setUpCase('install-fresh');
            const res = await request(buildApp()).post('/install').send({ url: repoUrl });
            expect(res.status).toBe(200);
            expect(res.body).toEqual(expect.objectContaining({ version: '2.0.0', folderName: 'ext' }));
            const live = path.join(extensionsDir, 'ext');
            expect(JSON.parse(fs.readFileSync(path.join(live, 'manifest.json'), 'utf8')).version).toBe('2.0.0');
            expect(fs.existsSync(path.join(live, '.git'))).toBe(true);
            expect(stagingEntries(extensionsDir)).toEqual([]);
            expect(dirtyCalls).toEqual([{ handle: 'test-user', userRoot: path.resolve(userRoot) }]);
        });

        test('replace: true swaps the new checkout over the existing directory', async () => {
            setUpCase('install-replace');
            const live = path.join(extensionsDir, 'ext');
            fs.mkdirSync(live);
            fs.writeFileSync(path.join(live, 'manifest.json'), JSON.stringify({ version: '1.0.0' }));
            fs.writeFileSync(path.join(live, 'old-only.js'), 'old');

            const refused = await request(buildApp()).post('/install').send({ url: repoUrl });
            expect(refused.status).toBe(409);

            const res = await request(buildApp()).post('/install').send({ url: repoUrl, replace: true });
            expect(res.status).toBe(200);
            expect(JSON.parse(fs.readFileSync(path.join(live, 'manifest.json'), 'utf8')).version).toBe('2.0.0');
            expect(fs.existsSync(path.join(live, 'old-only.js'))).toBe(false);
            expect(stagingEntries(extensionsDir)).toEqual([]);
            expect(dirtyCalls).toHaveLength(1);
        });

        test('overlapping installs of the same target leave a complete checkout', async () => {
            setUpCase('install-overlap');
            const app = buildApp();
            const responses = await Promise.all([request(app).post('/install').send({ url: repoUrl, replace: true }), request(app).post('/install').send({ url: repoUrl, replace: true })]);
            expect(responses.map(r => r.status)).toEqual([200, 200]);
            const live = path.join(extensionsDir, 'ext');
            expect(JSON.parse(fs.readFileSync(path.join(live, 'manifest.json'), 'utf8')).version).toBe('2.0.0');
            expect(gitRun(live, 'status', '--porcelain')).toBe('');
            expect(stagingEntries(extensionsDir)).toEqual([]);
        });
    });

    describe('update from a local origin', () => {
        let origin;
        let live;
        let oldHead;

        function setUpUpdateCase(name) {
            setUpCase(name);
            origin = path.join(caseDir, 'origin');
            makeSourceRepo(origin, '1.0.0');
            live = path.join(extensionsDir, 'ext');
            gitRun(caseDir, 'clone', '-q', origin, live);
            oldHead = gitRun(live, 'rev-parse', 'HEAD');
        }

        test('pulls the new commit into the live directory with no staging left and marks dirty once', async () => {
            setUpUpdateCase('update-ok');
            const newHead = addCommit(origin, '1.1.0');

            const res = await request(buildApp()).post('/update').send({ extensionName: 'ext' });
            expect(res.status).toBe(200);
            expect(res.body).toEqual(expect.objectContaining({ isUpToDate: false, shortCommitHash: newHead.slice(0, 7) }));
            expect(gitRun(live, 'rev-parse', 'HEAD')).toBe(newHead);
            expect(JSON.parse(fs.readFileSync(path.join(live, 'manifest.json'), 'utf8')).version).toBe('1.1.0');
            expect(stagingEntries(extensionsDir)).toEqual([]);
            expect(dirtyCalls).toEqual([{ handle: 'test-user', userRoot: path.resolve(userRoot) }]);
        });

        test('returns 409 and keeps the live directory when it changes during the update', async () => {
            setUpUpdateCase('update-changed');
            // The hook is copied into the staged work copy with .git and runs
            // after its pull, changing the live directory mid-update.
            const hook = path.join(live, '.git', 'hooks', 'post-merge');
            fs.writeFileSync(hook, `#!/bin/sh\necho changed > '${path.join(live, 'touched-by-hook.txt')}'\n`);
            fs.chmodSync(hook, 0o755);
            addCommit(origin, '1.1.0');

            const res = await request(buildApp()).post('/update').send({ extensionName: 'ext' });
            expect(res.status).toBe(409);
            expect(res.text).toBe('The extension changed while it was updating. Retry the update.');
            expect(fs.readFileSync(path.join(live, 'touched-by-hook.txt'), 'utf8').trim()).toBe('changed');
            expect(gitRun(live, 'rev-parse', 'HEAD')).toBe(oldHead);
            expect(JSON.parse(fs.readFileSync(path.join(live, 'manifest.json'), 'utf8')).version).toBe('1.0.0');
            expect(stagingEntries(extensionsDir)).toEqual([]);
            expect(dirtyCalls).toEqual([]);
        });

        test('overlapping updates retain the installed checkout and local untracked bytes', async () => {
            setUpUpdateCase('update-overlap');
            fs.writeFileSync(path.join(live, 'local-only.txt'), 'local bytes');
            const head = addCommit(origin, '1.1.0');
            const app = buildApp();
            const responses = await Promise.all([request(app).post('/update').send({ extensionName: 'ext' }), request(app).post('/update').send({ extensionName: 'ext' })]);
            expect(responses.some(r => r.status === 200)).toBe(true);
            expect(responses.every(r => r.status === 200 || r.status === 409)).toBe(true);
            expect(gitRun(live, 'rev-parse', 'HEAD')).toBe(head);
            expect(fs.readFileSync(path.join(live, 'local-only.txt'), 'utf8')).toBe('local bytes');
            expect(stagingEntries(extensionsDir)).toEqual([]);
        });
    });
});
