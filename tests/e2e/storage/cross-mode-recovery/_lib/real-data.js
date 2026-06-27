// Helpers for the real-data cross-mode recovery e2e specs.
//
// The 12 parameterized cross-mode specs (01-..12-..) use a programmatically
// fabricated seed: ST's shipped default Seraphina + a single Chinese-emoji
// chat turn. They prove the wiring works end-to-end at the category level
// but tell us nothing about the developer's actual data shape (custom
// presets, lorebooks, extensions, embedded chats, etc).
//
// This module backs the `99-real-data-*.e2e.js` specs:
//   1. APFS-clone the developer's live `data/` into a private scratch dir
//      so the test never mutates the developer's real data.
//   2. Scrub secrets.json (real API keys/tokens) and any dev-only prompt
//      pollution so the cloned settings still boot cleanly under a test
//      runner — same scrub the standard fixtures use, applied to the
//      cloned settings.json.
//   3. Hand the caller back the scratch dataRoot path so they can pass it
//      to `startServer({useExistingDataRoot})` and skip the seed clone.
//
// The companion `parity-verify.js` builds a category-level fingerprint of
// the cloned source BEFORE backup + the dest dataRoot AFTER restore, then
// returns a diff so the spec can assert that every backed-up category
// round-tripped exactly.

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const SCRATCH_ROOT = resolve(REPO_ROOT, 'tests/.e2e-scratch');

// Same pollution markers the standard fixtures use. Reproduced here so this
// module stays self-contained (the original list lives in
// tests/e2e/_lib/server.js — kept in sync by reading the constant directly
// if it ever moves into a shared file).
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

const DEFAULT_OAI_PRESET_PATH = resolve(REPO_ROOT, 'default/content/presets/openai/Default.json');

/**
 * Resolve the path to the developer's live `data/` dir. Default points at
 * the syncthing-mirrored project root the user actually runs from
 * (~/Desktop/projects/open-source/Luker/data). Override via
 * `LUKER_REAL_DATA_ROOT` for CI / alternate setups.
 *
 * Returns null if the dir doesn't exist — callers should `test.skip()` so
 * a fresh checkout without a real dataRoot doesn't fail the whole suite.
 */
export function resolveRealDataRoot() {
    const envOverride = process.env.LUKER_REAL_DATA_ROOT;
    if (envOverride) {
        return existsSync(envOverride) ? resolve(envOverride) : null;
    }
    const candidate = resolve(process.env.HOME || '~', 'Desktop/projects/open-source/Luker/data');
    return existsSync(candidate) ? candidate : null;
}

/**
 * APFS-clone the developer's real data dir into a private scratch path
 * inside the test scratch root, then scrub the secrets + dev prompt
 * pollution.  The returned path is safe to pass to `startServer` via
 * `useExistingDataRoot`.
 *
 * The scratch dir lives under `tests/.e2e-scratch/realdata-<specId>/` so
 * tearDownServer's `rmSync` (which only deletes inside SCRATCH_ROOT) still
 * cleans up correctly when the spec finishes.
 *
 * @param {object} opts
 * @param {string} opts.sourceDataRoot  Absolute path to the real dataRoot.
 * @param {string} opts.specId          Short id used to namespace the scratch dir.
 * @returns {string} Absolute path to the prepared scratch dataRoot.
 */
export function cloneRealDataForSpec({ sourceDataRoot, specId }) {
    if (!sourceDataRoot || !existsSync(sourceDataRoot)) {
        throw new Error(`cloneRealDataForSpec: sourceDataRoot does not exist: ${sourceDataRoot}`);
    }
    mkdirSync(SCRATCH_ROOT, { recursive: true });
    const targetDir = resolve(SCRATCH_ROOT, `realdata-${specId}-${Date.now()}`);
    if (existsSync(targetDir)) {
        rmSync(targetDir, { recursive: true, force: true });
    }
    // APFS copy-on-write — instant for a 200MB tree on macOS.  Falls back
    // to a regular recursive copy on non-APFS filesystems.
    try {
        execSync(`cp -c -R "${sourceDataRoot}" "${targetDir}"`, { stdio: 'ignore' });
    } catch {
        execSync(`cp -R "${sourceDataRoot}" "${targetDir}"`, { stdio: 'ignore' });
    }

    // Scrub real secrets — secrets.json holds actual API keys / tokens.
    // Replace with an empty object so the server still boots; the test
    // doesn't need real API access (no LLM calls happen during the
    // backup/restore flow).
    const userRoot = resolve(targetDir, 'default-user');
    const secretsPath = resolve(userRoot, 'secrets.json');
    if (existsSync(secretsPath)) {
        writeFileSync(secretsPath, '{}\n');
    }

    // Scrub dev-only prompt pollution out of the cloned settings.json so
    // boot doesn't get hijacked by orchestrator/jailbreak prompts that
    // would otherwise stack onto every chat. Same logic as
    // tests/e2e/_lib/server.js#scrubDevPromptPollution.
    scrubDevPromptPollution(resolve(userRoot, 'settings.json'));

    // The seed cloneDataDir also drops _macros_cache and dev backups; do
    // the same here so the comparison-fingerprint isn't dominated by
    // multi-hundred-MB cache content that the user wouldn't expect to
    // round-trip through a backup ZIP anyway.
    for (const noise of ['_macros_cache']) {
        const p = resolve(userRoot, noise);
        if (existsSync(p)) {
            try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
        }
    }

    return targetDir;
}

function scrubDevPromptPollution(settingsPath) {
    if (!existsSync(settingsPath)) return;
    let json;
    try {
        json = JSON.parse(readFileSync(settingsPath, 'utf8'));
    } catch {
        return;
    }
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
            for (const key of Object.keys(oai)) {
                if (key.startsWith('preset_settings_')) oai[key] = 'Default';
            }
            writeFileSync(settingsPath, JSON.stringify(json, null, 4));
        }
    }
}

/**
 * Quick boolean: does the real dataRoot at the resolved path actually
 * carry user data (not just a placeholder)?  Used by the spec to bail
 * with a clear skip reason when the env is blank.
 */
export function realDataLooksPopulated(dataRoot) {
    if (!dataRoot || !existsSync(dataRoot)) return false;
    const userRoot = resolve(dataRoot, 'default-user');
    if (!existsSync(userRoot)) return false;
    // Either fs chats OR a sqlite engine file should be present for the
    // test to have anything meaningful to verify.
    const fsChats = resolve(userRoot, 'chats');
    const sqliteFile = resolve(userRoot, 'luker-storage.sqlite');
    const hasFsChats = existsSync(fsChats) && statSync(fsChats).isDirectory();
    const hasSqlite = existsSync(sqliteFile) && statSync(sqliteFile).size > 0;
    return hasFsChats || hasSqlite;
}
