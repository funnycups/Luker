import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import isDocker from 'is-docker';
import { applyYamlChanges, materializeSeed, parseYamlConfigDocument } from './seed.js';

const repository = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const mapping = value => value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === null || Object.getPrototypeOf(Object.getPrototypeOf(value)) === null);
const READY_TIMEOUT_MS = 60_000;
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\u001b\[[0-9;]*[a-zA-Z]/g;

function normalizeReadinessLine(line) {
    return String(line ?? '').replace(ANSI_ESCAPE, '');
}

function isInside(parentDir, targetPath) {
    const rel = path.relative(fs.realpathSync(parentDir), fs.realpathSync(targetPath));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function validateConfig(extraConfig) {
    if (!mapping(extraConfig)) throw new TypeError('Application extraConfig requires a mapping');
    for (const key of Object.keys(extraConfig)) if (key.includes('.')) throw new TypeError(`Application extraConfig requires nested mappings: ${key}`);
    for (const key of ['protocol', 'storage', 'ssl', 'browserLaunch']) {
        if (Object.hasOwn(extraConfig, key) && !mapping(extraConfig[key])) throw new TypeError(`Application extraConfig.${key} requires a mapping`);
    }
    if (extraConfig.disableUpdateCheck !== undefined && typeof extraConfig.disableUpdateCheck !== 'boolean') {
        throw new TypeError('Application disableUpdateCheck must be boolean');
    }
}

/** Start a Luker server whose process and data belong to the supplied scope. */
export async function startServer(options = {}) {
    if (!mapping(options)) throw new TypeError('Application startup options require a mapping');
    const { scope, batchKey = 'application', scenarioId = 'default', onboarding = false } = options;
    let { extraEnv = {}, extraConfig = {}, data } = options;
    if (!scope || ['process', 'verifyDirectory', 'directory'].some(name => typeof scope[name] !== 'function')) {
        throw new TypeError('Application startup requires a managed resource scope');
    }
    validateConfig(extraConfig);
    extraEnv = { ...extraEnv };
    extraConfig = structuredClone(extraConfig);
    if (mapping(data)) data = { ...data };

    const selectedPort = extraConfig.port === undefined ? 0 : extraConfig.port;
    if (!Number.isInteger(selectedPort) || selectedPort < 0 || selectedPort > 65535) {
        throw new TypeError('Application port must be an integer TCP port from 0 to 65535');
    }
    const defaultDisableUpdateCheck = extraEnv.LUKER_GITHUB_API_BASE === undefined;
    const configOverrides = {
        ...extraConfig,
        port: selectedPort,
        listen: extraConfig.listen === undefined ? false : extraConfig.listen,
        disableUpdateCheck: extraConfig.disableUpdateCheck === undefined ? defaultDisableUpdateCheck : extraConfig.disableUpdateCheck,
        protocol: { ipv4: true, ipv6: false, ...extraConfig.protocol },
        storage: { mode: 'fs', ...extraConfig.storage },
    };

    let fixture;
    if (data === undefined) fixture = { kind: 'defaults' };
    else if (mapping(data) && data.ownership === 'owned') fixture = { kind: 'owned', directory: data };
    else if (mapping(data) && data.ownership === 'borrowed') fixture = { kind: 'compatibility', root: (await scope.borrowDirectory(data.path)).path };
    else throw new TypeError('Application data requires a registered owned directory or explicitly borrowed input');

    const runtime = extraEnv.LUKER_RUNTIME ?? process.env.LUKER_RUNTIME ?? 'node';
    const executable = runtime === 'node'
        ? process.execPath
        : runtime === 'bun'
            ? (extraEnv.LUKER_BUN_PATH ?? process.env.LUKER_BUN_PATH ?? path.join(os.homedir(), '.bun/bin/bun'))
            : undefined;
    if (!executable) throw new TypeError(`Unknown or empty application runtime executable: ${runtime}`);

    const settingsOverrides = fixture.kind === 'defaults'
        ? { firstRun: onboarding, power_user: { auto_connect: false } }
        : {};
    const seed = await materializeSeed(scope, {
        fixture,
        configOverrides,
        ...(fixture.kind === 'defaults' ? { settingsOverrides } : {}),
    });

    let lease;
    let port = selectedPort;
    let baseURL;
    let jitless = false;
    const epochs = [];
    const command = () => [
        executable,
        ...(jitless ? ['--jitless'] : []),
        path.join(repository, 'server.js'),
        `--port=${port}`,
        `--dataRoot=${seed.dataRoot}`,
        `--configPath=${seed.configPath}`,
        '--browserLaunchEnabled=false',
    ];

    async function launch() {
        if (lease) epochs.push(lease.output);
        await scope.verifyDirectory(seed.owner);
        await scope.verifyDirectory(seed.dataOwner);
        if (!isInside(seed.dataOwner.path, seed.dataRoot) || !isInside(seed.owner.path, seed.configPath)) {
            throw new Error(`Application paths escaped managed scope: ${seed.dataRoot}, ${seed.configPath}`);
        }
        lease = await scope.process({
            label: `${batchKey}/${scenarioId}`,
            command: command(),
            cwd: repository,
            env: extraEnv,
            readyLine: { pattern: '\\[[^\\]]+\\] Luker is listening on .+' },
        });
        const actual = /\bIPv([46]):\s+(\S+)/.exec(normalizeReadinessLine(lease.readyLine));
        if (!actual) {
            throw new Error(`Application readiness contains no bound address: ${lease.readyLine}`);
        }
        const reported = new URL(`${extraConfig.ssl?.enabled === true ? 'https' : 'http'}://${actual[2]}`);
        const boundPort = Number(reported.port || (reported.protocol === 'https:' ? 443 : 80));
        if (!Number.isInteger(boundPort) || boundPort < 1 || boundPort > 65535 || (port !== 0 && boundPort !== port)) {
            throw new Error(`Application readiness port differs from requested binding: ${port} -> ${reported.href}`);
        }
        port = boundPort;
        baseURL = `${reported.protocol}//${actual[1] === '4' ? '127.0.0.1' : '[::1]'}:${port}`;
    }

    await launch();

    const handle = Object.freeze({
        dataRoot: seed.dataRoot,
        configPath: seed.configPath,
        manifestPath: seed.manifestPath,
        owner: seed.owner,
        dataOwner: seed.dataOwner,
        get baseURL() { return baseURL; },
        get port() { return port; },
        get pid() { return lease.pid; },
        get resourceId() { return lease.resourceId; },
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
        async restart(restartOptions = {}) {
            const changes = restartOptions.extraConfig === undefined ? {} : structuredClone(restartOptions.extraConfig);
            validateConfig(changes);
            const nextEnv = restartOptions.extraEnv ?? {};
            await lease.stop();
            extraEnv = { ...extraEnv, ...nextEnv };
            if (Object.keys(changes).length) {
                const configDocument = parseYamlConfigDocument(
                    fs.readFileSync(seed.configPath, 'utf8'),
                    `application restart config ${seed.configPath}`,
                );
                applyYamlChanges(configDocument, changes);
                fs.writeFileSync(seed.configPath, configDocument.toString());
            }
            jitless = restartOptions.jitless ?? jitless;
            await launch();
            return handle;
        },
    });

    if (batchKey === 'sync' && process.env.LUKER_SYNC_ACCEPTANCE_JITLESS === '1') {
        try {
            const bundles = resolveWarmupBundlesDir(seed.dataRoot);
            if (!bundles) throw new Error(`No genuine warmup bundles for ${seed.dataRoot}`);
            await handle.restart({
                jitless: true,
                extraEnv: { LUKER_FORCE_JITLESS: '1', LUKER_PREBUILT_BUNDLES_DIR: bundles },
            });
            if (!handle.execArgv.includes('--jitless')) {
                throw new Error('Sync acceptance server was not launched with --jitless');
            }
        } catch (error) {
            await handle.stop();
            throw error;
        }
    }

    return handle;
}

export function resolveWarmupBundlesDir(dataRoot) {
    const cache = isDocker() ? path.join(repository, 'dist', '_webpack') : path.join(dataRoot, '_webpack');
    if (!fs.existsSync(cache)) return null;
    return fs.readdirSync(cache)
        .map(name => path.join(cache, name, 'output'))
        .find(directory => fs.existsSync(path.join(directory, 'lib.core.bundle.js'))) || null;
}
