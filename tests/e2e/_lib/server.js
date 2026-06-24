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
    // Drop any dev-time chat history under default-user/chats/ so specs
    // that load a character don't see leftover turns from the developer's
    // own runs (the integrity check rejects them anyway, but the noise
    // hides real failures).
    const chatsDir = resolve(targetDir, 'default-user/chats');
    if (existsSync(chatsDir)) {
        try { rmSync(chatsDir, { recursive: true, force: true }); } catch {}
        mkdirSync(chatsDir, { recursive: true });
    }
    // Drop dev-time backups (they grow to hundreds of MB on a long-lived
    // dev env and bloat each spec's APFS clone).
    for (const noise of ['default-user/backups', 'default-user/_macros_cache']) {
        const p = resolve(targetDir, noise);
        if (existsSync(p)) {
            try { rmSync(p, { recursive: true, force: true }); } catch {}
        }
    }
    // Scrub the dev's personal prompt content out of the cloned settings.
    // A normal dev `data/` carries the developer's actual preset prompts
    // — they may include heavy ORCHESTRATOR-MODE / persona-override /
    // jailbreak text that drowns out the character body the spec is
    // asserting on (e.g. group rotation specs check the mock saw the
    // character's description, but the preset's 6 KB system prompt
    // outweighs it in the request log).
    //
    // We keep the structure (so extensions that depend on the openai
    // preset schema still see their fields) but zero out the bodies of
    // prompt entries that obviously carry persona/role text. The list of
    // markers below targets the ORCHESTRATOR-MODE injection scaffold and
    // the Dreamweaver "cognitive override" jailbreak that ships with the
    // dev env — both are spec-hostile and never installed by a fresh
    // user. Anything else is left alone.
    scrubDevPromptPollution(resolve(targetDir, 'default-user/settings.json'));
}

const SPEC_HOSTILE_PROMPT_MARKERS = [
    'ORCHESTRATOR MODE',
    'UNCONSTRAINED INFERENCE',
    'FULL-SPECTRUM DATA POLICY',
    'REFUSAL PATTERN SUPPRESSION',
    'Dreamweaver',
    '织梦者',
    '虚境实验室',
    '认知框架覆写',
    '创作许可契约',
    'orchestrator_guidance',
    'final_writing_style_guidance',
    'final_content_wrapper_guidance',
    'deep_preparation_guidance',
    'final_banned_words_guidance',
    'LIORA_JAILBREAK',
    'NSFW指南',
    '黑森林',
];

// ST's shipped "Default" OpenAI preset — the minimal prompt set that
// every fresh user starts from. We snap the cloned settings back to
// this so the dev's local prompt-order + custom entries don't bleed
// into spec assertions.
const DEFAULT_OAI_PRESET_PATH = resolve(REPO_ROOT, 'default/content/presets/openai/Default.json');

function scrubDevPromptPollution(settingsPath) {
    if (!existsSync(settingsPath)) return;
    let dirty = false;
    let json;
    try {
        json = JSON.parse(readFileSync(settingsPath, 'utf8'));
    } catch {
        return;
    }
    // Load the shipped Default preset once; we'll splice its prompts into
    // the live settings if the active prompts carry any spec-hostile
    // marker. Anything else (a developer who simply runs the unmodified
    // default in their dev env) stays untouched.
    let defaultPreset = null;
    try {
        defaultPreset = JSON.parse(readFileSync(DEFAULT_OAI_PRESET_PATH, 'utf8'));
    } catch { /* shipped preset missing — leave settings alone */ }

    const oai = json?.oai_settings;
    if (oai && Array.isArray(oai.prompts) && defaultPreset?.prompts) {
        const hasPollution = oai.prompts.some(p => {
            const content = typeof p?.content === 'string' ? p.content : '';
            return SPEC_HOSTILE_PROMPT_MARKERS.some(m => content.includes(m));
        });
        if (hasPollution) {
            oai.prompts = JSON.parse(JSON.stringify(defaultPreset.prompts));
            if (Array.isArray(defaultPreset.prompt_order)) {
                oai.prompt_order = JSON.parse(JSON.stringify(defaultPreset.prompt_order));
            }
            // Pin every "preset for source X" field to "Default" so the
            // active preset is the one we just installed.
            for (const key of Object.keys(oai)) {
                if (key.startsWith('preset_settings_')) oai[key] = 'Default';
            }
            dirty = true;
        }
    }
    if (dirty) {
        writeFileSync(settingsPath, JSON.stringify(json, null, 4));
    }
}

/**
 * Write a per-scenario config.yaml at `targetPath` based on the project's
 * root `config.yaml`, applying simple top-level key overrides from
 * `extraConfig`. Naive text substitution — top-level boolean/scalar lines
 * only. That's enough for the personas / multi-user batch's needs
 * (`enableUserAccounts`, etc).
 *
 * Also supports a tiny dotted notation for nested scalars (single level
 * deep, e.g. `storage.mode`). The leaf line must be the only line in the
 * file whose key matches that leaf name — true for `storage.mode` today
 * (it's the only `mode:` key in default config.yaml). If a second `mode:`
 * key ever lands, this regex needs path context.
 *
 * @param {string} targetPath  absolute path to write the new config.yaml
 * @param {Record<string,any>} extraConfig  flat top-level overrides; keys
 *   may also be dotted "parent.child" to overwrite a nested scalar.
 */
function writeScenarioConfig(targetPath, extraConfig) {
    const raw = readFileSync(SEED_CONFIG, 'utf8');
    let out = raw;
    for (const [key, value] of Object.entries(extraConfig)) {
        const yamlValue = value === true ? 'true' : value === false ? 'false' : String(value);
        if (key.includes('.')) {
            const segments = key.split('.');
            const leaf = segments[segments.length - 1];
            if (segments.length >= 3) {
                // Anchor the leaf inside its nested parent block so a leaf
                // name shared across siblings (e.g. `url:` under both
                // `mysql:` and `postgres:`) lands on the correct one.
                // Match: <root>:\n ... <parent>:\n ... <leaf>: <scalar>
                // The middle is captured loosely (any number of lines) up
                // to the leaf line that lives directly under the parent
                // header. The leaf indent is preserved via its capture
                // group so we only touch the scalar value.
                const root = segments[0];
                const parent = segments[segments.length - 2];
                const re = new RegExp(
                    `^(${root}:[\\s\\S]*?^\\s+${parent}:[\\s\\S]*?^)(\\s+${leaf}\\s*):\\s*[^\\n]*$`,
                    'm',
                );
                if (re.test(out)) {
                    out = out.replace(re, `$1$2: ${yamlValue}`);
                    continue;
                }
                throw new Error(`writeScenarioConfig: nested key "${key}" not found in seed config.yaml`);
            }
            // Match an indented "leaf: <scalar>" line (under a parent
            // block). Preserve original indentation via the capture group.
            const re = new RegExp(`^(\\s+${leaf}\\s*):\\s*[^\\n]*$`, 'm');
            if (re.test(out)) {
                out = out.replace(re, `$1: ${yamlValue}`);
            } else {
                throw new Error(`writeScenarioConfig: nested key "${key}" not found in seed config.yaml`);
            }
            continue;
        }
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
    // Up to 3 attempts to acquire a port that the OS will let us rebind.
    // The transient `net.Server.listen({port:0})` in ports.js gives us a
    // free port at that instant, but in a high-parallelism run two workers
    // can race for the same OS-assigned port before either binds. Retry
    // wraps the entire spawn so a bind failure rerolls a fresh port.
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
        const port = await reservePort(batchKey);
        try {
            return await spawnAt(port, batchKey, scenarioId, extraEnv, extraConfig);
        } catch (err) {
            lastErr = err;
            // Only retry on bind-collision style errors.
            const msg = String(err?.message || err || '');
            if (!/already in use|did not become ready/i.test(msg)) throw err;
        }
    }
    throw lastErr;
}

async function spawnAt(port, batchKey, scenarioId, extraEnv, extraConfig) {
    const dataRoot = resolve(SCRATCH_ROOT, `${batchKey}-${scenarioId}-${port}`);
    cloneDataDir(dataRoot);

    // The seed `data/` doesn't include a populated `_storage/` for the
    // sqlite backend (settings:default-user row is missing), so default
    // every spec to the filesystem backend. Specs that genuinely need
    // sqlite (e.g. the storage-migrate suite) override via extraConfig.
    const effectiveConfig = { 'storage.mode': 'fs', ...(extraConfig || {}) };

    let scenarioConfigPath = '';
    if (Object.keys(effectiveConfig).length > 0) {
        scenarioConfigPath = resolve(SCRATCH_ROOT, `${batchKey}-${scenarioId}-${port}-config.yaml`);
        writeScenarioConfig(scenarioConfigPath, effectiveConfig);
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
        // Watch stderr for the early bind-in-use line so we can fail fast
        // (and let startServer's retry loop reroll a fresh port) instead of
        // waiting the full readiness timeout.
        let bindInUse = false;
        let earlyExit = null;
        child.stdout.on('data', () => { /* swallow; verbose */ });
        child.stderr.on('data', d => {
            const s = String(d);
            if (s.includes('listen port is already in use') || s.includes('EADDRINUSE')) {
                bindInUse = true;
            }
            process.stderr.write(`[srv:${port}] ${d}`);
        });
        child.once('exit', (code, signal) => {
            earlyExit = { code, signal };
        });
        try {
            // Probe with a tight loop that bails on bindInUse / early exit.
            const deadline = Date.now() + READY_TIMEOUT_MS;
            while (Date.now() < deadline) {
                if (bindInUse) throw new Error(`server on port ${port} reported listen port already in use`);
                if (earlyExit) throw new Error(`server on port ${port} exited early (code=${earlyExit.code} signal=${earlyExit.signal})`);
                try {
                    const res = await fetch(`http://127.0.0.1:${port}/`, { method: 'GET', redirect: 'manual' });
                    if (res.status === 200 || res.status === 302 || res.status === 401) return;
                } catch { /* not up yet */ }
                await new Promise(r => setTimeout(r, READY_POLL_MS));
            }
            throw new Error(`server on port ${port} did not become ready within ${READY_TIMEOUT_MS}ms`);
        } catch (err) {
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
