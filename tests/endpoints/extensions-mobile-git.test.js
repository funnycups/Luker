import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_CONFIG_PATH = path.join(REPO_ROOT, 'default/config.yaml');
const UTIL_URL = pathToFileURL(path.join(REPO_ROOT, 'src/util.js')).href;
const CONSTANTS_URL = pathToFileURL(path.join(REPO_ROOT, 'src/constants.js')).href;
const EXTENSIONS_URL = pathToFileURL(path.join(REPO_ROOT, 'src/endpoints/extensions.js')).href;
const PLUGIN_LOADER_URL = pathToFileURL(path.join(REPO_ROOT, 'src/plugin-loader.js')).href;

const IDENTITY = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid'];

function startGitHttpServer(projectRoot, emptyGitConfig) {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        const child = spawn('git', ['http-backend'], {
            env: {
                ...process.env,
                GIT_CONFIG_GLOBAL: emptyGitConfig,
                GIT_CONFIG_NOSYSTEM: '1',
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
        child.stdout.on('data', (chunk) => chunks.push(chunk));
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
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

describe('third-party extensions and server plugins git operations under mobile sandboxes', () => {
    let scratch;
    let emptyGitConfig;
    let httpRoot;
    let sourceDir;
    let bareDir;
    let server;
    let repoUrl;
    let initialHead;
    let featureHead;

    const gitRun = (cwd, ...args) => execFileSync('git', [...IDENTITY, ...args], {
        cwd,
        encoding: 'utf8',
        env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: emptyGitConfig,
            GIT_CONFIG_NOSYSTEM: '1',
        },
    }).trim();

    beforeAll(async () => {
        scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-mobile-git-'));
        emptyGitConfig = path.join(scratch, 'empty-gitconfig');
        fs.writeFileSync(emptyGitConfig, '');

        sourceDir = path.join(scratch, 'source');
        fs.mkdirSync(sourceDir, { recursive: true });
        gitRun(sourceDir, 'init', '-q', '-b', 'main');
        fs.writeFileSync(path.join(sourceDir, 'manifest.json'), JSON.stringify({ display_name: 'DemoExt', version: '1.0.0' }));
        fs.writeFileSync(path.join(sourceDir, 'package.json'), JSON.stringify({ name: 'demo-plugin', version: '1.0.0', main: 'index.js' }));
        fs.writeFileSync(path.join(sourceDir, 'index.js'), 'module.exports = {};\n');
        gitRun(sourceDir, 'add', '.');
        gitRun(sourceDir, 'commit', '-q', '-m', 'v1.0.0');
        initialHead = gitRun(sourceDir, 'rev-parse', 'HEAD');

        gitRun(sourceDir, 'checkout', '-q', '-b', 'feature');
        fs.writeFileSync(path.join(sourceDir, 'manifest.json'), JSON.stringify({ display_name: 'DemoExt', version: '1.0.0-feature' }));
        gitRun(sourceDir, 'commit', '-q', '-am', 'feature-commit');
        featureHead = gitRun(sourceDir, 'rev-parse', 'HEAD');
        gitRun(sourceDir, 'checkout', '-q', 'main');

        httpRoot = path.join(scratch, 'http-root');
        bareDir = path.join(httpRoot, 'demo-ext.git');
        gitRun(scratch, 'clone', '-q', '--bare', sourceDir, bareDir);

        server = await startGitHttpServer(httpRoot, emptyGitConfig);
        repoUrl = `http://127.0.0.1:${server.address().port}/demo-ext.git`;
    });

    afterAll(async () => {
        if (server?.listening) {
            await new Promise((resolve) => server.close(resolve));
        }
        fs.rmSync(scratch, { recursive: true, force: true });
    });

    function addUpstreamMainCommit(version) {
        gitRun(sourceDir, 'checkout', '-q', 'main');
        fs.writeFileSync(path.join(sourceDir, 'manifest.json'), JSON.stringify({ display_name: 'DemoExt', version }));
        fs.writeFileSync(path.join(sourceDir, 'package.json'), JSON.stringify({ name: 'demo-plugin', version, main: 'index.js' }));
        gitRun(sourceDir, 'commit', '-q', '-am', `v${version}`);
        const newHead = gitRun(sourceDir, 'rev-parse', 'HEAD');
        gitRun(sourceDir, 'push', '-q', bareDir, 'main:main');
        return newHead;
    }

    async function runInIsolatedRuntime({ platform, forbidAllSpawns = false, failGitSpawnCode = null }, scriptBody) {
        const caseRoot = fs.mkdtempSync(path.join(scratch, 'case-'));
        const resultFile = path.join(caseRoot, 'result.json');
        const child = await new Promise((resolve) => {
            const proc = spawn(process.execPath, ['--input-type=module', '-e', `
            import childProcess from 'node:child_process';
            import { EventEmitter } from 'node:events';
            import fs from 'node:fs';
            import http from 'node:http';
            import path from 'node:path';
            import { syncBuiltinESMExports } from 'node:module';
            import express from 'express';

            const spawnCalls = [];
            const makeSpawnError = (cmd, code) => Object.assign(
                new Error(\`spawn \${cmd} \${code}\`),
                { code, errno: -1, syscall: \`spawn \${cmd}\`, path: String(cmd) },
            );

            if (${JSON.stringify(Boolean(platform))}) {
                Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
            }

            if (${JSON.stringify(forbidAllSpawns)}) {
                const deny = (cmd) => {
                    spawnCalls.push(String(cmd));
                    throw makeSpawnError(cmd, 'EPERM');
                };
                childProcess.spawn = deny;
                childProcess.spawnSync = deny;
                childProcess.exec = deny;
                childProcess.execSync = deny;
                childProcess.execFile = deny;
                childProcess.execFileSync = deny;
                syncBuiltinESMExports();
            } else if (${JSON.stringify(Boolean(failGitSpawnCode))}) {
                const origSpawn = childProcess.spawn;
                childProcess.spawn = function patchedSpawn(cmd, args, opts) {
                    if (String(cmd) === 'git') {
                        spawnCalls.push('git');
                        const fake = new EventEmitter();
                        fake.stdout = new EventEmitter();
                        fake.stderr = new EventEmitter();
                        fake.stdin = new EventEmitter();
                        fake.kill = () => {};
                        fake.killed = false;
                        const err = makeSpawnError('git', ${JSON.stringify(failGitSpawnCode)});
                        queueMicrotask(() => {
                            fake.emit('error', err);
                            fake.emit('close', -1);
                        });
                        return fake;
                    }
                    return origSpawn.call(this, cmd, args, opts);
                };
                syncBuiltinESMExports();
            }

            const userRoot = path.join(${JSON.stringify(caseRoot)}, 'user');
            const extensionsDir = path.join(userRoot, 'extensions');
            const globalExtensionsDir = path.join(${JSON.stringify(caseRoot)}, 'global-extensions');
            const pluginsDir = path.join(${JSON.stringify(caseRoot)}, 'plugins');
            fs.mkdirSync(extensionsDir, { recursive: true });
            fs.mkdirSync(globalExtensionsDir, { recursive: true });
            fs.mkdirSync(pluginsDir, { recursive: true });
            globalThis.DATA_ROOT = userRoot;

            const { setConfigFilePath, reloadConfigCache } = await import(${JSON.stringify(UTIL_URL)});
            setConfigFilePath(${JSON.stringify(DEFAULT_CONFIG_PATH)});
            reloadConfigCache();

            const constants = await import(${JSON.stringify(CONSTANTS_URL)});
            constants.setGlobalExtensionsDirectory(globalExtensionsDir);

            const { router: extensionsRouter } = await import(${JSON.stringify(EXTENSIONS_URL)});
            const { installServerPlugin, updateServerPlugin } = await import(${JSON.stringify(PLUGIN_LOADER_URL)});

            const app = express();
            app.use(express.json());
            app.use((req, _res, next) => {
                req.user = {
                    profile: { handle: 'u', admin: true },
                    directories: { root: userRoot, extensions: extensionsDir },
                };
                next();
            });
            app.use('/api/extensions', extensionsRouter);

            const listener = await new Promise((resolve) => {
                const srv = http.createServer(app);
                srv.listen(0, '127.0.0.1', () => resolve(srv));
            });
            const apiBase = \`http://127.0.0.1:\${listener.address().port}/api/extensions\`;
            const postJson = async (route, body) => {
                const res = await fetch(\`\${apiBase}\${route}\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
                const text = await res.text();
                let json = null;
                try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
                return { status: res.status, json, text };
            };
            const writeResult = (payload) => fs.writeFileSync(
                ${JSON.stringify(resultFile)},
                JSON.stringify({ spawnCalls, ...payload }),
            );

            try {
                ${scriptBody}
            } finally {
                await new Promise((resolve) => listener.close(resolve));
            }
        `], {
                cwd: REPO_ROOT,
                env: {
                    ...process.env,
                    SILLYTAVERN_GIT_BACKEND: 'auto',
                    SILLYTAVERN_EXTENSIONS_ENABLED: 'true',
                },
            });
            let stderr = '';
            proc.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
            proc.on('close', (status) => resolve({ status, stderr }));
        });

        return {
            status: child.status,
            stderr: child.stderr,
            result: fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : null,
        };
    }

    test.each(['ios', 'openharmony', 'android'])(
        'mobile runtime (%s) installs, checks version, lists/switches branches, and updates without spawning subprocesses',
        async (platform) => {
            const currentMainHead = gitRun(bareDir, 'rev-parse', 'refs/heads/main');
            const nextVersion = `1.1.0-${platform}`;
            const child = await runInIsolatedRuntime(
                { platform, forbidAllSpawns: true },
                `
                const installed = await postJson('/install', { url: ${JSON.stringify(repoUrl)} });
                const versionInitial = await postJson('/version', { extensionName: 'demo-ext', global: false });
                const branches = await postJson('/branches', { extensionName: 'demo-ext', global: false });
                const switched = await postJson('/switch', { extensionName: 'demo-ext', branch: 'origin/feature', global: false });
                const versionFeature = await postJson('/version', { extensionName: 'demo-ext', global: false });
                const switchedBack = await postJson('/switch', { extensionName: 'demo-ext', branch: 'main', global: false });

                const pluginInstalled = await installServerPlugin(pluginsDir, ${JSON.stringify(repoUrl)});
                const pluginNoopUpdate = await updateServerPlugin(pluginsDir, 'demo-ext');

                writeResult({
                    installedStatus: installed.status,
                    versionInitial: versionInitial.json,
                    branchesStatus: branches.status,
                    branchNames: Array.isArray(branches.json) ? branches.json.map((b) => b.name).sort() : [],
                    switchedStatus: switched.status,
                    versionFeature: versionFeature.json,
                    switchedBackStatus: switchedBack.status,
                    pluginInstalledVersion: pluginInstalled.version,
                    pluginNoopUpToDate: pluginNoopUpdate.isUpToDate,
                });
                `,
            );

            expect({ status: child.status, stderr: child.stderr }).toEqual({ status: 0, stderr: '' });
            expect(child.result).toEqual({
                spawnCalls: [],
                installedStatus: 200,
                versionInitial: {
                    currentBranchName: 'main',
                    currentCommitHash: currentMainHead,
                    isUpToDate: true,
                    remoteUrl: repoUrl,
                    remoteCommitHash: currentMainHead,
                },
                branchesStatus: 200,
                branchNames: ['main', 'origin/feature', 'origin/main'],
                switchedStatus: 204,
                versionFeature: {
                    currentBranchName: 'feature',
                    currentCommitHash: featureHead,
                    isUpToDate: true,
                    remoteUrl: repoUrl,
                    remoteCommitHash: featureHead,
                },
                switchedBackStatus: 204,
                pluginInstalledVersion: fs.existsSync(sourceDir) ? JSON.parse(fs.readFileSync(path.join(sourceDir, 'package.json'), 'utf8')).version : nextVersion,
                pluginNoopUpToDate: true,
            });

            // Push an upstream commit and verify update detection + pull in mobile mode
            const pushedHead = addUpstreamMainCommit(nextVersion);
            const updateChild = await runInIsolatedRuntime(
                { platform, forbidAllSpawns: true },
                `
                await postJson('/install', { url: ${JSON.stringify(repoUrl)} });
                // Rewind installed repo to previous commit? Instead install before push is simulated by cloning at initialHead:
                const { default: isoGit } = await import('isomorphic-git');
                const extPath = path.join(extensionsDir, 'demo-ext');
                const httpClient = (await import('isomorphic-git/http/node')).default;
                await isoGit.fetch({ fs, http: httpClient, dir: extPath, url: ${JSON.stringify(repoUrl)}, ref: 'main', depth: 2, singleBranch: true });
                await isoGit.writeRef({ fs, dir: extPath, ref: 'refs/heads/main', value: ${JSON.stringify(currentMainHead)}, force: true });
                await isoGit.checkout({ fs, dir: extPath, ref: 'main', force: true });

                const beforeUpdate = await postJson('/version', { extensionName: 'demo-ext', global: false });
                const updated = await postJson('/update', { extensionName: 'demo-ext', global: false });
                const afterUpdate = await postJson('/version', { extensionName: 'demo-ext', global: false });
                writeResult({
                    beforeUpdate: beforeUpdate.json,
                    updatedStatus: updated.status,
                    updatedBody: updated.json,
                    afterUpdate: afterUpdate.json,
                });
                `,
            );

            expect({ status: updateChild.status, stderr: updateChild.stderr }).toEqual({ status: 0, stderr: '' });
            expect(updateChild.result).toEqual({
                spawnCalls: [],
                beforeUpdate: {
                    currentBranchName: 'main',
                    currentCommitHash: currentMainHead,
                    isUpToDate: false,
                    remoteUrl: repoUrl,
                    remoteCommitHash: pushedHead,
                },
                updatedStatus: 200,
                updatedBody: expect.objectContaining({
                    isUpToDate: false,
                    shortCommitHash: pushedHead.slice(0, 7),
                    remoteUrl: repoUrl,
                }),
                afterUpdate: {
                    currentBranchName: 'main',
                    currentCommitHash: pushedHead,
                    isUpToDate: true,
                    remoteUrl: repoUrl,
                    remoteCommitHash: pushedHead,
                },
            });
            expect(initialHead).toHaveLength(40);
        },
    );

    test.each(['EPERM', 'ENOSYS'])(
        'desktop runtime falls back to isomorphic-git when spawning git fails with %s',
        async (code) => {
            const currentMainHead = gitRun(bareDir, 'rev-parse', 'refs/heads/main');
            const child = await runInIsolatedRuntime(
                { platform: 'linux', failGitSpawnCode: code },
                `
                const installed = await postJson('/install', { url: ${JSON.stringify(repoUrl)} });
                const versionRes = await postJson('/version', { extensionName: 'demo-ext', global: false });
                const branchesRes = await postJson('/branches', { extensionName: 'demo-ext', global: false });
                const updateRes = await postJson('/update', { extensionName: 'demo-ext', global: false });
                writeResult({
                    installedStatus: installed.status,
                    version: versionRes.json,
                    branchesStatus: branchesRes.status,
                    updateStatus: updateRes.status,
                    updateUpToDate: updateRes.json?.isUpToDate,
                });
                `,
            );

            expect(child.status).toBe(0);
            expect(child.result).toMatchObject({
                installedStatus: 200,
                version: {
                    currentBranchName: 'main',
                    currentCommitHash: currentMainHead,
                    isUpToDate: true,
                    remoteUrl: repoUrl,
                    remoteCommitHash: currentMainHead,
                },
                branchesStatus: 200,
                updateStatus: 200,
                updateUpToDate: true,
            });
        },
    );

    test('/api/extensions/version preserves local branch and commit hash when remote is unreachable', async () => {
        const currentMainHead = gitRun(bareDir, 'rev-parse', 'refs/heads/main');
        const child = await runInIsolatedRuntime(
            { platform: 'ios', forbidAllSpawns: true },
            `
            await postJson('/install', { url: ${JSON.stringify(repoUrl)} });
            const { default: isoGit } = await import('isomorphic-git');
            const extPath = path.join(extensionsDir, 'demo-ext');
            const unreachableUrl = 'http://127.0.0.1:1/unreachable-repo.git';
            await isoGit.setConfig({ fs, dir: extPath, path: 'remote.origin.url', value: unreachableUrl });

            const versionRes = await postJson('/version', { extensionName: 'demo-ext', global: false });
            writeResult({ version: versionRes.json });
            `,
        );

        expect(child.status).toBe(0);
        expect(child.result).toEqual({
            spawnCalls: [],
            version: {
                currentBranchName: 'main',
                currentCommitHash: currentMainHead,
                isUpToDate: true,
                remoteUrl: 'http://127.0.0.1:1/unreachable-repo.git',
                remoteCommitHash: '',
            },
        });
    });
});
