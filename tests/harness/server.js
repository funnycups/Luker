import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import isDocker from 'is-docker';
import { applyYamlChanges, materializeSeed, parseYamlConfigDocument } from './seed.js';
import { contains } from './resources/registry.js';
import { normalizeReadinessLine } from './resources/process-diagnostics.js';

const repository = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const mapping = value => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === null || Object.getPrototypeOf(Object.getPrototypeOf(value)) === null);
const READY_TIMEOUT_MS = 60_000;

function validateConfig(extraConfig) {
    if (!mapping(extraConfig)) throw new TypeError('Application extraConfig requires a mapping');
    for (const key of Object.keys(extraConfig)) if (key.includes('.')) throw new TypeError(`Application extraConfig requires nested mappings: ${key}`);
    for (const key of ['protocol', 'storage', 'ssl', 'browserLaunch']) if (Object.hasOwn(extraConfig, key) && !mapping(extraConfig[key])) throw new TypeError(`Application extraConfig.${key} requires a mapping`);
    if (extraConfig.disableUpdateCheck !== undefined && typeof extraConfig.disableUpdateCheck !== 'boolean') throw new TypeError('Application disableUpdateCheck must be boolean');
}

/** Start an application whose process and declared data belong to the supplied scope. */
export async function startServer(options = {}) {
    if (!mapping(options)) throw new TypeError('Application startup options require a mapping');
    for (const name of Object.keys(options)) if (!['scope', 'batchKey', 'scenarioId', 'extraEnv', 'extraConfig', 'data', 'onboarding'].includes(name)) throw new TypeError(`Unknown application startup option: ${name}`);
    const { scope, batchKey = 'application', scenarioId = 'default', onboarding = false } = options;
    let { extraEnv = {}, extraConfig = {}, data } = options;
    if (!scope || ['process', 'verifyDirectory', 'directory'].some(name => typeof scope[name] !== 'function')) throw new TypeError('Application startup requires a managed resource scope');
    if (typeof batchKey !== 'string' || !batchKey || typeof scenarioId !== 'string' || !scenarioId) throw new TypeError('Application batchKey and scenarioId must be nonempty strings');
    if (!mapping(extraEnv) || Object.entries(extraEnv).some(([key, value]) => typeof value !== 'string' || key.includes('\0') || value.includes('\0'))) throw new TypeError('Application extraEnv requires string values without NUL');
    if (typeof onboarding !== 'boolean') throw new TypeError('Application onboarding must be boolean');
    validateConfig(extraConfig);
    extraEnv = { ...extraEnv };
    try { extraConfig = structuredClone(extraConfig); }
    catch (cause) { throw new TypeError('Application extraConfig cannot be snapshotted', { cause }); }
    if (mapping(data)) data = { ...data };
    const selectedPort = extraConfig.port === undefined ? 0 : extraConfig.port;
    if (!Number.isInteger(selectedPort) || selectedPort < 0 || selectedPort > 65535) throw new TypeError('Application port must be an integer TCP port from 0 to 65535');
    if (extraConfig.ssl?.enabled !== undefined && typeof extraConfig.ssl.enabled !== 'boolean') throw new TypeError('Application ssl.enabled must be boolean');
    const defaultDisableUpdateCheck = extraEnv.LUKER_GITHUB_API_BASE === undefined;
    const configOverrides = { ...extraConfig, port: selectedPort, listen: extraConfig.listen === undefined ? false : extraConfig.listen, disableUpdateCheck: extraConfig.disableUpdateCheck === undefined ? defaultDisableUpdateCheck : extraConfig.disableUpdateCheck, protocol: { ipv4: true, ipv6: false, ...extraConfig.protocol }, storage: { mode: 'fs', ...extraConfig.storage } };
    let fixture;
    if (data === undefined) fixture = { kind: 'defaults' };
    else if (mapping(data) && data.ownership === 'owned') fixture = { kind: 'owned', directory: data };
    else if (mapping(data) && data.ownership === 'borrowed') fixture = { kind: 'compatibility', root: (await scope.borrowDirectory(data.path)).path };
    else throw new TypeError('Application data requires a registered owned directory or explicitly borrowed input');
    const runtime = extraEnv.LUKER_RUNTIME ?? process.env.LUKER_RUNTIME ?? 'node';
    const executable = runtime === 'node' ? process.execPath : runtime === 'bun' ? extraEnv.LUKER_BUN_PATH ?? process.env.LUKER_BUN_PATH ?? path.join(os.homedir(), '.bun/bin/bun') : undefined;
    if (!executable) throw new TypeError(`Unknown or empty application runtime executable: ${runtime}`);
    const settingsOverrides = fixture.kind === 'defaults' ? { firstRun: onboarding, power_user: { auto_connect: false } } : {};
    const seed = await materializeSeed(scope, { fixture, configOverrides, ...(fixture.kind === 'defaults' ? { settingsOverrides } : {}) });
    const dependsOn = [...new Set([seed.owner.resourceId, seed.dataOwner.resourceId])];
    let lease, port = selectedPort, baseURL;
    let jitless = false;
    const epochs = [];
    const command = () => [executable, ...(jitless ? ['--jitless'] : []), path.join(repository, 'server.js'), `--port=${port}`, `--dataRoot=${seed.dataRoot}`, `--configPath=${seed.configPath}`, '--browserLaunchEnabled=false'];
    async function launch() {
        if (lease) epochs.push(lease.output);
        await scope.verifyDirectory(seed.owner);
        await scope.verifyDirectory(seed.dataOwner);
        for (const [name, filename, owner, directory] of [['data', seed.dataRoot, seed.dataOwner, true], ['configuration', seed.configPath, seed.owner, false]]) {
            const stat = fs.lstatSync(filename);
            if (!contains(owner.path, filename) || fs.realpathSync(filename) !== filename || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error(`Application ${name} ownership requires a ${directory ? 'real directory' : 'regular file'} inside ${owner.path}: ${filename}`);
        }
        lease = await scope.process({ label: `${batchKey}/${scenarioId}`, command: command(), cwd: repository, env: extraEnv, dependsOn, readyLine: { pattern: '\\[[^\\]]+\\] Luker is listening on .+' } });
        const actual = /\bIPv([46]):\s+(\S+)/.exec(normalizeReadinessLine(lease.readyLine));
        if (!actual) throw new Error(`Application readiness contains no bound address for resource ${lease.resourceId}: ${lease.readyLine}`);
        const reported = new URL(`${extraConfig.ssl?.enabled === true ? 'https' : 'http'}://${actual[2]}`);
        const boundPort = Number(reported.port || (reported.protocol === 'https:' ? 443 : 80));
        if (!Number.isInteger(boundPort) || boundPort < 1 || boundPort > 65535 || port !== 0 && boundPort !== port) throw new Error(`Application readiness port differs from its requested binding: ${port} -> ${reported.href}`);
        port = boundPort;
        baseURL = `${reported.protocol}//${actual[1] === '4' ? '127.0.0.1' : '[::1]'}:${port}`;
    }
    await launch();
    const handle = Object.freeze({
        dataRoot: seed.dataRoot, configPath: seed.configPath, manifestPath: seed.manifestPath, owner: seed.owner, dataOwner: seed.dataOwner,
        get baseURL() { return baseURL; }, get port() { return port; }, get pid() { return lease.pid; }, get resourceId() { return lease.resourceId; },
        get execArgv() { return command().slice(1); },
        get output() { return lease?.output ?? ''; },
        get outputEpochs() { return [...epochs, lease?.output ?? '']; },
        stop: () => lease.stop(),
        async expectExit(expected) { return await lease.expectExit(expected); },
        async kill(signal = 'SIGKILL') { return await lease.kill(signal); },
        async waitForStderr(text) {
            if (typeof text !== 'string' || !text) throw new TypeError('Application stderr expectation requires nonempty text');
            const deadline = Date.now() + READY_TIMEOUT_MS;
            while (Date.now() < deadline) {
                if (lease.output.includes(text)) return;
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            throw new Error(`Missing application output: ${text}\n${lease.output}`);
        },
        async restart(options = {}) {
            if (!mapping(options)) throw new TypeError('Application restart options require a mapping');
            for (const name of Object.keys(options)) if (!['extraEnv', 'extraConfig', 'jitless'].includes(name)) throw new TypeError(`Unknown application restart option: ${name}`);
            const changes = options.extraConfig === undefined ? {} : structuredClone(options.extraConfig);
            validateConfig(changes);
            const nextEnv = options.extraEnv === undefined ? {} : options.extraEnv;
            if (!mapping(nextEnv) || Object.entries(nextEnv).some(([key, value]) => typeof value !== 'string' || key.includes('\0') || value.includes('\0'))) throw new TypeError('Application restart extraEnv requires string values without NUL');
            if (options.jitless !== undefined && typeof options.jitless !== 'boolean') throw new TypeError('Application restart jitless must be boolean');
            await lease.stop();
            extraEnv = { ...extraEnv, ...nextEnv };
            if (Object.keys(changes).length) {
                const configDocument = parseYamlConfigDocument(fs.readFileSync(seed.configPath, 'utf8'), `application restart config ${seed.configPath}`);
                applyYamlChanges(configDocument, changes);
                fs.writeFileSync(seed.configPath, configDocument.toString());
            }
            jitless = options.jitless ?? jitless;
            await launch();
            return handle;
        },
    });
    if (batchKey === 'sync' && process.env.LUKER_SYNC_ACCEPTANCE_JITLESS === '1') {
        try {
            const bundles = resolveWarmupBundlesDir(seed.dataRoot);
            if (!bundles) throw new Error(`No genuine warmup bundles for ${seed.dataRoot}`);
            await handle.restart({ jitless: true, extraEnv: { LUKER_FORCE_JITLESS: '1', LUKER_PREBUILT_BUNDLES_DIR: bundles } });
            if (!handle.execArgv.includes('--jitless')) throw new Error('Sync acceptance server was not launched with --jitless');
        } catch (error) {
            await handle.stop();
            throw error;
        }
    }
    return handle;
}

export function resolveWarmupBundlesDir(dataRoot) {
    // Mirror webpack.config.js: inside Docker webpack writes to <repo>/dist/_webpack,
    // while bare hosts write under <dataRoot>/_webpack.
    const cache = isDocker() ? path.join(repository, 'dist', '_webpack') : path.join(dataRoot, '_webpack');
    if (!fs.existsSync(cache)) return null;
    return fs.readdirSync(cache)
        .map(name => path.join(cache, name, 'output'))
        .find(directory => fs.existsSync(path.join(directory, 'lib.core.bundle.js'))) || null;
}
