// Local helper for the worldinfo batch — writes a character card with the
// supplied data embedded into the PNG's `chara` / `ccv3` tEXt chunks so
// the server's processCharacter() returns the correct name and binding.
//
// The shared `writeCharacter` in tests/e2e/_lib/fixtures.js copies the
// Seraphina seed PNG but only writes a sidecar JSON — the server's
// processCharacter ignores sidecars and reads only PNG metadata, so every
// card built with the shared helper shows up as "Seraphina". This local
// helper re-stamps the PNG metadata with the requested name + binding so
// multi-character WI tests (#25, #27, #28, #31, #32) can distinguish cards.

import { resolve } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import { write as writeCharPng } from '../../../src/character-card-parser.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

/**
 * Write a character with proper PNG-embedded v2/v3 data.
 *
 * @param {object} opts
 * @param {string} opts.dataRoot
 * @param {string} [opts.handle]
 * @param {string} opts.avatarFile  Filename (with .png)
 * @param {string} opts.name        Character display name
 * @param {string} [opts.worldBook] Optional primary world book name
 * @param {object} [opts.extras]    Extra v2 card field overrides
 * @returns {string} avatarFile
 */
export function writeCharacterWithBinding({ dataRoot, handle = 'default-user', avatarFile, name, worldBook, extras = {} }) {
    const charsDir = resolve(dataRoot, handle, 'characters');
    mkdirSync(charsDir, { recursive: true });
    const seed = resolve(REPO_ROOT, 'default/content/default_Seraphina.png');
    const target = resolve(charsDir, avatarFile);

    const card = {
        name,
        description: extras.description ?? `${name} is a wind-bitten character in the Bryn coastal fixture.`,
        personality: extras.personality ?? 'Observant, dry-witted, slow to anger but stubborn once committed.',
        scenario: extras.scenario ?? `You and ${name} share a watch on the Bryn headland.`,
        first_mes: extras.first_mes ?? `*${name} looks up from a half-folded chart, brushing salt-crystal from the corner of the paper.* "You came earlier than I expected."`,
        mes_example: extras.mes_example ?? '',
        creator_notes: 'For e2e fixtures; safe for any backend.',
        system_prompt: extras.system_prompt ?? `You are ${name}. Stay in scene. Reply with one to three immersive paragraphs.`,
        post_history_instructions: '',
        alternate_greetings: extras.alternate_greetings ?? [],
        tags: ['rp', 'fixture'],
        creator: 'luker-e2e-worldinfo-batch',
        character_version: '1.0',
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name,
            description: extras.description ?? `${name} is a wind-bitten character in the Bryn coastal fixture.`,
            personality: extras.personality ?? 'Observant, dry-witted, slow to anger but stubborn once committed.',
            scenario: extras.scenario ?? `You and ${name} share a watch on the Bryn headland.`,
            first_mes: extras.first_mes ?? `*${name} looks up from a half-folded chart, brushing salt-crystal from the corner of the paper.* "You came earlier than I expected."`,
            mes_example: extras.mes_example ?? '',
            creator_notes: 'For e2e fixtures; safe for any backend.',
            system_prompt: extras.system_prompt ?? `You are ${name}. Stay in scene. Reply with one to three immersive paragraphs.`,
            post_history_instructions: '',
            alternate_greetings: extras.alternate_greetings ?? [],
            tags: ['rp', 'fixture'],
            creator: 'luker-e2e-worldinfo-batch',
            character_version: '1.0',
            extensions: {
                ...(worldBook ? { world: worldBook } : {}),
                talkativeness: '0.5',
                fav: false,
                depth_prompt: { prompt: '', depth: 4, role: 'system' },
            },
        },
    };

    const seedBuffer = readFileSync(seed);
    const stampedBuffer = writeCharPng(seedBuffer, JSON.stringify(card));
    writeFileSync(target, stampedBuffer);

    return avatarFile;
}

/**
 * Resolve a unique, parallel-worker-safe port for a given spec.
 *
 * The shared `_lib/ports.js` reserves count=4 ports per batch and uses
 * an in-process round-robin counter — fine within one worker, but across
 * worker processes (PW_WORKERS=N) two workers each start at offset 0 and
 * collide. Since the worldinfo batch ships 8 specs and the brief asks
 * for PW_WORKERS=2 runs, we hash the caller's filename to a deterministic
 * port within the worldinfo range so two parallel workers on different
 * specs never race for the same TCP port. Workers running the SAME spec
 * are not a concern — playwright serializes within a file.
 *
 * The shared ports.js reserves base..base+3 for worldinfo (8471-8474) and
 * preset starts at 8481. We use 8471-8478 (eight specs), occupying the
 * worldinfo range plus the otherwise-empty 8475-8480 gap before preset.
 *
 * @param {string} specBaseName  e.g. '25-activation-strategies'
 * @returns {number} port in the worldinfo range
 */
export function pickStableWorldInfoPort(specBaseName) {
    const base = 8471; // mirror PORT_RANGES.worldinfo.base
    const seq = ['25', '26', '27', '28', '29', '30', '31', '32'];
    const idx = seq.findIndex(prefix => specBaseName.startsWith(prefix));
    return idx >= 0 ? base + idx : base;
}

const REPO_ROOT_ABS = resolve(import.meta.dirname, '../../..');
const SEED_DATA_ABS = resolve(REPO_ROOT_ABS, 'data');
const SCRATCH_ROOT_ABS = resolve(REPO_ROOT_ABS, 'tests/.e2e-scratch');
mkdirSync(SCRATCH_ROOT_ABS, { recursive: true });

function cloneDataDirLocal(targetDir) {
    if (existsSync(targetDir)) {
        rmSync(targetDir, { recursive: true, force: true });
    }
    const essentials = [
        'default-user/settings.json',
        'default-user/User Avatars',
        'default-user/characters',
        '_storage',
    ];
    for (let attempt = 0; attempt < 8; attempt++) {
        try {
            if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
            // `cp -R` (no -c) is slower than APFS clone but is far more
            // resilient to concurrent writers in `data/` (the clone
            // form sometimes loses files on parallel sessions).
            execSync(`cp -R "${SEED_DATA_ABS}" "${targetDir}"`, { stdio: 'ignore' });
            const missing = essentials.filter(rel => !existsSync(resolve(targetDir, rel)));
            if (missing.length === 0) return;
            // eslint-disable-next-line no-console
            console.warn(`[worldinfo cloneDataDirLocal] attempt ${attempt + 1} missing: ${missing.join(', ')} — retrying`);
        } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(`[worldinfo cloneDataDirLocal] attempt ${attempt + 1} threw: ${err.message} — retrying`);
        }
        // Backoff briefly in case `data/` is mid-write by a concurrent
        // test run. Spin-wait — Date.now() is enough granularity.
        const deadline = Date.now() + 500 * (attempt + 1);
        while (Date.now() < deadline) { /* spin briefly */ }
    }
    throw new Error(`cloneDataDirLocal failed after retries; target=${targetDir}`);
}

async function probeReadyLocal(port, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/`, { method: 'GET' });
            if (res.status === 200 || res.status === 302 || res.status === 401) return true;
        } catch { /* not up yet */ }
        await new Promise(r => setTimeout(r, 250));
    }
    throw new Error(`server on port ${port} did not become ready within ${timeoutMs}ms`);
}

/**
 * Spawn a Luker server bound to a deterministic port assigned by
 * pickStableWorldInfoPort. Mirrors the shared `startServer` API surface
 * (returns { port, dataRoot, baseURL, restart, stop }) but bypasses the
 * shared port reservation to avoid PW_WORKERS=2 collisions.
 *
 * @param {object} opts
 * @param {string} opts.specBaseName  filename prefix (e.g. '25-activation-strategies')
 * @param {string} [opts.scenarioId]
 */
export async function startWorldInfoServer({ specBaseName, scenarioId = 'default' } = {}) {
    const port = pickStableWorldInfoPort(specBaseName);
    const dataRoot = resolve(SCRATCH_ROOT_ABS, `worldinfo-${specBaseName}-${scenarioId}-${port}`);
    cloneDataDirLocal(dataRoot);

    // The seed `data/` doesn't include a populated `_storage/` for the
    // sqlite backend (settings:default-user row is missing), so the
    // local `config.yaml`'s `storage.mode: sqlite` would make every
    // /bootstrap call fail with `settings missing for handle
    // default-user`. Mirror the shared `_lib/server.js` approach: write
    // a one-off per-spec config that pins the filesystem backend.
    const configPath = resolve(SCRATCH_ROOT_ABS, `worldinfo-${specBaseName}-${scenarioId}-${port}-config.yaml`);
    writeFileSync(configPath, 'storage:\n  mode: fs\n', 'utf8');

    let child = null;
    const env = { ...process.env, NODE_ENV: 'production' };

    async function spawnOnce() {
        child = spawn('node', [
            'server.js',
            `--port=${port}`,
            `--dataRoot=${dataRoot}`,
            `--configPath=${configPath}`,
            '--browserLaunchEnabled=false',
            '--listen=false',
            '--whitelist=127.0.0.1',
            '--disableCsrf=false',
        ], {
            cwd: REPO_ROOT_ABS,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: false,
        });
        child.stdout.on('data', () => { /* swallow */ });
        child.stderr.on('data', d => { process.stderr.write(`[srv:${port}] ${d}`); });
        await probeReadyLocal(port);
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
        baseURL: `http://127.0.0.1:${port}`,
        restart,
        stop,
    };
}

export async function tearDownWorldInfoServer(handle, { removeData = true } = {}) {
    if (!handle) return;
    await handle.stop();
    if (removeData && handle.dataRoot && handle.dataRoot.startsWith(SCRATCH_ROOT_ABS)) {
        try { rmSync(handle.dataRoot, { recursive: true, force: true }); } catch {}
        // Best-effort: remove the per-spec config.yaml beside the dataRoot.
        try { rmSync(`${handle.dataRoot}-config.yaml`, { force: true }); } catch {}
    }
}
