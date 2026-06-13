// Spawn a Luker server bound to a configurable port + dataRoot, with
// readiness probing, restart, and teardown.
//
// Each e2e spec calls `startServer({batchKey, scenarioId})` in a worker-
// scoped fixture so playwright's parallel workers within a batch share
// the same server (cheap: one node process per batch worker).
//
// A spec that needs persistence-across-restart calls `restartServer()`,
// which kills the node child and re-spawns against the same dataRoot.
//
// A spec that needs cross-server isolation (multi-user, scope migration)
// calls `startServer` a second time with a different `scenarioId` — that
// reserves a fresh port + a fresh APFS-cloned dataRoot.

import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { reservePort } from './ports.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const SEED_DATA = resolve(REPO_ROOT, 'data');
const SEED_CONFIG = resolve(REPO_ROOT, 'config.yaml');
const SCRATCH_ROOT = resolve(REPO_ROOT, 'tests/.e2e-scratch');

const READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 250;

mkdirSync(SCRATCH_ROOT, { recursive: true });

/**
 * Clone the seed `data/` directory using APFS copy-on-write so spec
 * isolation is effectively free (no real bytes copied on macOS APFS).
 * Falls back to `cp -R` on other filesystems.
 */
function cloneDataDir(targetDir) {
    if (existsSync(targetDir)) {
        rmSync(targetDir, { recursive: true, force: true });
    }
    try {
        execSync(`cp -c -R "${SEED_DATA}" "${targetDir}"`, { stdio: 'ignore' });
    } catch {
        execSync(`cp -R "${SEED_DATA}" "${targetDir}"`, { stdio: 'ignore' });
    }
}

/**
 * Write a per-scenario config.yaml at `targetPath` based on the project's
 * root `config.yaml`, applying simple top-level key overrides from
 * `extraConfig`. Naive text substitution — top-level boolean/scalar lines
 * only. That's enough for the personas / multi-user batch's needs
 * (`enableUserAccounts`, etc). Nested keys would need a YAML round-trip.
 *
 * @param {string} targetPath  absolute path to write the new config.yaml
 * @param {Record<string,any>} extraConfig  flat top-level overrides
 */
function writeScenarioConfig(targetPath, extraConfig) {
    const raw = readFileSync(SEED_CONFIG, 'utf8');
    let out = raw;
    for (const [key, value] of Object.entries(extraConfig)) {
        const yamlValue = value === true ? 'true' : value === false ? 'false' : String(value);
        const re = new RegExp(`^(${key}\\s*):\\s*(true|false|[^\\n]*)$`, 'm');
        if (re.test(out)) {
            out = out.replace(re, `$1: ${yamlValue}`);
        } else {
            out += `\n${key}: ${yamlValue}\n`;
        }
    }
    writeFileSync(targetPath, out, 'utf8');
}

async function probeReady(port, timeoutMs = READY_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            // `redirect: 'manual'` is critical when multi-user mode redirects
            // `/` → `/login` (which may itself bounce). Without manual mode,
            // Node fetch auto-follows and can hit "redirect count exceeded"
            // before our 200/302/401 ready signal lands.
            const res = await fetch(`http://127.0.0.1:${port}/`, { method: 'GET', redirect: 'manual' });
            if (res.status === 200 || res.status === 302 || res.status === 401) return true;
        } catch { /* not up yet */ }
        await new Promise(r => setTimeout(r, READY_POLL_MS));
    }
    throw new Error(`server on port ${port} did not become ready within ${timeoutMs}ms`);
}

/**
 * @typedef {object} ServerHandle
 * @property {number} port
 * @property {string} dataRoot
 * @property {string} baseURL
 * @property {() => Promise<void>} restart
 * @property {() => Promise<void>} stop
 */

/**
 * Spawn a Luker server bound to its own port + cloned data dir.
 *
 * @param {object} opts
 * @param {string} opts.batchKey  Key from ports.js (chat/character/...).
 * @param {string} [opts.scenarioId]  Unique id for this scenario inside the
 *   batch — different scenarios get different data dirs. Defaults to "default".
 * @param {Record<string,string>} [opts.extraEnv]
 * @param {Record<string,any>} [opts.extraConfig]  Top-level config.yaml
 *   overrides for this scenario (e.g. `{ enableUserAccounts: true, listen: false }`).
 *   When provided, a per-scenario config.yaml is written next to the
 *   cloned dataRoot and passed via `--configPath`.
 * @returns {Promise<ServerHandle>}
 */
export async function startServer({ batchKey, scenarioId = 'default', extraEnv = {}, extraConfig = null } = {}) {
    if (!batchKey) throw new Error('startServer: batchKey is required');
    const port = reservePort(batchKey);
    const dataRoot = resolve(SCRATCH_ROOT, `${batchKey}-${scenarioId}-${port}`);
    cloneDataDir(dataRoot);

    let scenarioConfigPath = '';
    if (extraConfig && Object.keys(extraConfig).length > 0) {
        scenarioConfigPath = resolve(SCRATCH_ROOT, `${batchKey}-${scenarioId}-${port}-config.yaml`);
        writeScenarioConfig(scenarioConfigPath, extraConfig);
    }

    let child = null;
    const env = { ...process.env, ...extraEnv, NODE_ENV: 'production' };

    async function spawnOnce() {
        const argv = [
            'server.js',
            `--port=${port}`,
            `--dataRoot=${dataRoot}`,
            '--browserLaunchEnabled=false',
            '--listen=false',
            '--whitelist=127.0.0.1',
            '--disableCsrf=false',
        ];
        if (scenarioConfigPath) argv.push(`--configPath=${scenarioConfigPath}`);
        child = spawn('node', argv, {
            cwd: REPO_ROOT,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: false,
        });
        child.stdout.on('data', () => { /* swallow; verbose */ });
        child.stderr.on('data', d => { process.stderr.write(`[srv:${port}] ${d}`); });
        try {
            await probeReady(port);
        } catch (err) {
            // probeReady failed (e.g. timeout). Kill the child we just spawned
            // so it doesn't become a zombie holding the port — the next test
            // run would then fail to bind on this same port.
            try { child?.kill('SIGKILL'); } catch {}
            child = null;
            throw err;
        }
    }

    async function stop() {
        if (!child) return;
        try {
            child.kill('SIGTERM');
            await new Promise((resolve) => {
                const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} ; resolve(); }, 3000);
                child.once('exit', () => { clearTimeout(t); resolve(); });
            });
        } catch { /* already gone */ }
        child = null;
    }

    async function restart() {
        await stop();
        await spawnOnce();
    }

    await spawnOnce();

    return {
        port,
        dataRoot,
        configPath: scenarioConfigPath || null,
        baseURL: `http://127.0.0.1:${port}`,
        restart,
        stop,
    };
}

/**
 * Cleanup helper for spec teardown: kill server and remove the scratch
 * dataRoot. Use in `afterAll` so the on-disk footprint doesn't grow.
 */
export async function tearDownServer(handle, { removeData = true } = {}) {
    if (!handle) return;
    await handle.stop();
    if (removeData && handle.dataRoot && handle.dataRoot.startsWith(SCRATCH_ROOT)) {
        try { rmSync(handle.dataRoot, { recursive: true, force: true }); } catch {}
    }
    if (removeData && handle.configPath && handle.configPath.startsWith(SCRATCH_ROOT)) {
        try { rmSync(handle.configPath, { force: true }); } catch {}
    }
}
