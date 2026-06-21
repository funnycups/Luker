// Programmatic builders for the e2e corpus. Each builder writes JSON
// directly into a server's dataRoot (no HTTP). Spec code then reloads
// the affected list in the UI to pick it up.
//
// All sample content is RP-immersive (per repo convention) — no "say hi"
// placeholder messages and no doc-example strings.

import { mkdirSync, writeFileSync, copyFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

function userRoot(dataRoot, handle = 'default-user') {
    return resolve(dataRoot, handle);
}

/**
 * Write a v2 character card JSON next to a copied avatar PNG.
 * Returns the avatar filename (which is the character's id in Luker).
 *
 * @param {object} opts
 * @param {string} opts.dataRoot
 * @param {string} opts.handle  user handle ("default-user")
 * @param {string} [opts.avatarFile]  Filename; default "ash-the-cartographer.png"
 * @param {object} [opts.overrides]  Field overrides merged onto the default card.
 */
export function writeCharacter({ dataRoot, handle = 'default-user', avatarFile = 'ash-the-cartographer.png', overrides = {} }) {
    const charsDir = resolve(userRoot(dataRoot, handle), 'characters');
    mkdirSync(charsDir, { recursive: true });
    // Use a real PNG byte stream from the bundled Seraphina sample so the
    // file passes Luker's PNG validation; the embedded card data lives in
    // a sidecar JSON which Luker honors for non-embedded edits.
    const seed = resolve(REPO_ROOT, 'default/content/default_Seraphina.png');
    const target = resolve(charsDir, avatarFile);
    copyFileSync(seed, target);

    const card = {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        name: 'Ash the Cartographer',
        description: 'A wiry coastal cartographer in her early thirties. Wind-bitten hands, ink-stained sleeves, and a quiet patience earned from years of mapping reefs that refuse to stay still. Carries a brass spyglass that once belonged to her mother.',
        personality: 'Observant, dry-witted, slow to anger but stubborn once committed. Prefers questions to assertions. Holds grief privately and competence publicly.',
        scenario: 'You and Ash share a watchpost on the Bryn headland, charged with reading the night reef for any sign of the salt-mark drifters returning before dawn.',
        first_mes: '*Ash looks up from a half-folded chart, brushing salt-crystal from the corner of the paper.* "You came earlier than I expected. The tide is still settling — sit. The lantern needs trimming and I would rather not do it twice."',
        mes_example: '<START>\n{{user}}: What do you read in the reef tonight?\n{{char}}: *She traces a line on the chart with one knuckle.* "Three breakers north of the gull rocks that don\'t belong to the moon. Something is moving."',
        creator_notes: 'For e2e fixtures; safe for any backend.',
        system_prompt: 'You are Ash. Stay in scene. Reply with one to three immersive paragraphs unless the user asks a direct OOC question.',
        post_history_instructions: '',
        alternate_greetings: [
            '*Ash is already at the rail when you arrive, spyglass to her eye.* "Hold. Don\'t speak for a moment."',
        ],
        character_book: undefined,
        tags: ['rp', 'fixture'],
        creator: 'luker-e2e',
        character_version: '1.0',
        extensions: {},
        ...overrides,
    };

    // Luker characters endpoint reads JSON from disk via PNG metadata,
    // but for v2 cards a sidecar `<avatar>.json` is also recognized.
    writeFileSync(resolve(charsDir, avatarFile.replace(/\.png$/, '.json')), JSON.stringify(card, null, 2));
    return avatarFile;
}

/**
 * Write a CPA-style OpenAI preset (the format settings.json keys live in).
 * Returns the preset name (without .json).
 */
export function writePreset({ dataRoot, handle = 'default-user', name = 'e2e-ash-preset', overrides = {} }) {
    const dir = resolve(userRoot(dataRoot, handle), 'OpenAI Settings');
    mkdirSync(dir, { recursive: true });
    const seed = resolve(REPO_ROOT, 'default/content/presets/openai/Default.json');
    let base = {};
    if (existsSync(seed)) base = JSON.parse(readFileSync(seed, 'utf8'));
    const preset = { ...base, ...overrides };
    writeFileSync(resolve(dir, `${name}.json`), JSON.stringify(preset, null, 4));
    return name;
}

/**
 * Write a world info book.
 * Returns the book name (without .json).
 */
export function writeWorldBook({ dataRoot, handle = 'default-user', name = 'e2e-bryn-headland', entries = [] }) {
    const dir = resolve(userRoot(dataRoot, handle), 'worlds');
    mkdirSync(dir, { recursive: true });
    const indexed = {};
    entries.forEach((e, i) => {
        indexed[String(i)] = {
            uid: i,
            key: e.key || [],
            keysecondary: e.keysecondary || [],
            comment: e.comment || `entry ${i}`,
            content: e.content || '',
            constant: !!e.constant,
            selective: e.selective !== false,
            order: e.order ?? 100,
            position: e.position ?? 0,
            disable: !!e.disable,
            displayIndex: i,
            addMemo: true,
            group: '',
            groupOverride: false,
            groupWeight: 100,
            sticky: 0,
            cooldown: 0,
            delay: 0,
            probability: 100,
            depth: e.depth ?? 4,
            useProbability: true,
            role: null,
            vectorized: !!e.vectorized,
            excludeRecursion: !!e.excludeRecursion,
            preventRecursion: !!e.preventRecursion,
            delayUntilRecursion: !!e.delayUntilRecursion,
            scanDepth: null,
            caseSensitive: null,
            matchWholeWords: null,
            useGroupScoring: null,
            automationId: '',
        };
    });
    writeFileSync(resolve(dir, `${name}.json`), JSON.stringify({ entries: indexed }, null, 4));
    return name;
}

/**
 * The two-entry default world book for chat-flow tests.
 */
export const BRYN_ENTRIES = [
    {
        key: ['reef', 'reefs', 'breakers'],
        comment: 'reef-conditions',
        content: 'The Bryn reef shifts on a 19-day cycle. Charts older than two weeks are considered unreliable. Locals call the worst tide "the slow swallow".',
        order: 100,
    },
    {
        key: ['salt-mark drifters', 'drifters', 'salt mark'],
        comment: 'drifters',
        content: 'Salt-mark drifters are not bandits; they are families that refused the cliffside relocation after the great surge. They travel by skiff and never light fires inland.',
        order: 200,
    },
];

/**
 * Write a connection-manager profile pointing at the in-process mock LLM.
 * Stored under settings.json -> extensionSettings.connectionManager.profiles.
 */
export function appendConnectionProfile({ dataRoot, handle = 'default-user', name = 'e2e-mock', baseURL, model = 'mock-gpt-4o' }) {
    const settingsPath = resolve(userRoot(dataRoot, handle), 'settings.json');
    if (!existsSync(settingsPath)) {
        throw new Error(`settings.json not found at ${settingsPath} — start the server once before adding profiles`);
    }
    const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
    s.extensionSettings = s.extensionSettings || {};
    s.extensionSettings.connectionManager = s.extensionSettings.connectionManager || { profiles: [], selectedProfile: null };
    const profileId = `e2e-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const profile = {
        id: profileId,
        name,
        api: 'openai',
        mode: 'cc',
        preset: '',
        model,
        proxy: '',
        instruct: '',
        context: '',
        sysprompt: '',
        'sysprompt-state': false,
        instruct: '',
        'instruct-state': false,
        'tokenizer': '',
        'stop-strings': '',
        // CUSTOM source with explicit URL — no real key needed.
        'chat-completion-source': 'custom',
        'custom-url': baseURL,
    };
    s.extensionSettings.connectionManager.profiles.push(profile);
    s.extensionSettings.connectionManager.selectedProfile = profileId;
    writeFileSync(settingsPath, JSON.stringify(s, null, 4));
    return { profileId, name };
}

/**
 * Patch settings.json with the openai sub-tree config for the CUSTOM
 * chat-completion source so the very first turn already routes to the
 * mock. Done because connection-manager profile activation in the UI
 * happens after page load — bootstrapping the settings keys directly
 * avoids a click+wait race in chat-flow tests.
 *
 * Also neutralizes dev-env pollution so plugin LLM nodes (orchestrator,
 * CPA, memory-graph, CEA, iter-studios) all fall through to the active
 * oai_settings (= our mock) instead of routing via a missing connection
 * profile or a real-API connection name.
 */
export function bootstrapCustomBackend({ dataRoot, handle = 'default-user', baseURL, model = 'mock-gpt-4o' }) {
    const settingsPath = resolve(userRoot(dataRoot, handle), 'settings.json');
    const s = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
    s.main_api = 'openai';
    s.firstRun = false;
    s.oai_settings = s.oai_settings || {};
    s.oai_settings.chat_completion_source = 'custom';
    s.oai_settings.custom_url = baseURL;
    s.oai_settings.custom_model = model;
    s.oai_settings.openai_model = model;
    s.oai_settings.stream_openai = true;
    // Wipe legacy fields the dev's settings.json may have left behind that
    // would otherwise reroute orchestrator/CPA/MG/CEA LLM calls via a real
    // provider URL. The mirrored values live under extension_settings
    // (snake_case) — the SPA reads from there at load.
    const ext = (s.extension_settings = s.extension_settings || {});
    for (const slot of ['orchestrator', 'completion_preset_assistant', 'memory_graph', 'character_editor_assistant']) {
        const m = (ext[slot] = ext[slot] || {});
        for (const key of [
            'llmNodeApiPresetName', 'llmNodePresetName',
            'requestApiPresetName', 'requestLlmPresetName',
            'schemaIterationApiPresetName', 'schemaIterationLlmPresetName',
            'iterationApiPresetName', 'iterationLlmPresetName',
            'recallApiPresetName', 'recallLlmPresetName',
            'extractApiPresetName', 'extractLlmPresetName',
        ]) {
            m[key] = '';
        }
    }
    // Clear the active connection profile so resolveProfile doesn't
    // override chat_completion_source/custom_url with a dev's "Claude"
    // / "Gemini" profile blob.
    ext.connectionManager = ext.connectionManager || { profiles: [], selectedProfile: null };
    ext.connectionManager.selectedProfile = null;
    writeFileSync(settingsPath, JSON.stringify(s, null, 4));
}

/**
 * Mark the user as having completed onboarding so the welcome popup
 * does not block first paint. Idempotent.
 */
export function markOnboarded({ dataRoot, handle = 'default-user' }) {
    const settingsPath = resolve(userRoot(dataRoot, handle), 'settings.json');
    const s = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
    s.firstRun = false;
    writeFileSync(settingsPath, JSON.stringify(s, null, 4));
}

/**
 * Wire the mock LLM's `/v1/embeddings` endpoint into Luker's vector pipeline.
 *
 * Adds a Connection-Manager embed profile (`source: 'openai'` with
 * `api-url` pointing at the mock) and patches the vectors / memory-graph
 * extension settings so:
 *   - `extension_settings.vectors.embeddingProfileId` selects that profile
 *   - `extension_settings.memory_graph.embeddingProfileId` selects the
 *     same profile (so MG's `vectorSearch` / `syncVectorIndex` resolve it)
 *
 * NB: Luker's settings.json uses `extension_settings` (snake_case) as the
 * persisted key — the client hydrates `extension_settings` from
 * `settings.extension_settings` on load and serializes back to the same
 * key on save. Earlier fixtures (`appendConnectionProfile`) wrote to a
 * camelCase `extensionSettings` slot which the client silently ignores;
 * this helper writes under the snake_case key the client actually reads.
 *
 * `enabled_world_info` is NOT flipped here — the vectors WI semantic
 * path is opt-in and several specs that share the same dataRoot
 * bootstrap specifically assert it stays off. Tests that want the WI
 * path enabled should toggle the `#vectors_enabled_world_info` checkbox
 * via `page.evaluate` (the canonical handler updates the module-scope
 * mirror that the interceptor actually reads).
 *
 * The `proxy-password` is any non-empty token; the openai vector
 * backend uses it verbatim as the bearer key when `reverse_proxy` is
 * set, and the mock ignores authorization entirely.
 *
 * @param {object} opts
 * @param {string} opts.dataRoot
 * @param {string} [opts.handle]
 * @param {string} opts.baseURL  Mock LLM base URL (ends in /v1)
 * @param {string} [opts.model]  Embedding model name string
 * @param {string} [opts.profileName]
 * @returns {{ profileId: string, profileName: string }}
 */
export function bootstrapVectorsBackend({
    dataRoot,
    handle = 'default-user',
    baseURL,
    model = 'mock-embed',
    profileName = 'e2e-mock-embed',
}) {
    const settingsPath = resolve(userRoot(dataRoot, handle), 'settings.json');
    if (!existsSync(settingsPath)) {
        throw new Error(`settings.json not found at ${settingsPath} — start the server once before adding embed profiles`);
    }
    const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
    // Persisted shape (what the client hydrates from): snake_case.
    s.extension_settings = s.extension_settings || {};

    // Connection-manager profile shared between vectors + memory-graph.
    s.extension_settings.connectionManager = s.extension_settings.connectionManager || { profiles: [], selectedProfile: null };
    const profiles = Array.isArray(s.extension_settings.connectionManager.profiles)
        ? s.extension_settings.connectionManager.profiles
        : [];
    const profileId = `e2e-embed-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    profiles.push({
        id: profileId,
        mode: 'embed',
        name: profileName,
        source: 'openai',
        model,
        // api-url + proxy-password ⇒ server takes `<api-url>/embeddings`
        // and uses `proxy-password` as the bearer key. Any non-empty
        // password works; the mock ignores Authorization entirely.
        'api-url': baseURL,
        'proxy-password': 'mock-embed-key',
    });
    s.extension_settings.connectionManager.profiles = profiles;

    // Vectors extension wiring: select the profile.
    s.extension_settings.vectors = s.extension_settings.vectors || {};
    s.extension_settings.vectors.embeddingProfileId = profileId;
    // The mock embedder (cf. mockLLM.js — bag-of-tokens hash) produces
    // cosine similarities clustered in [0.0, 0.7] with a clear gap
    // around 0.2 between "topical match" and "unrelated". Setting the
    // threshold there keeps semantic-miss entries out of the prompt
    // without requiring a real semantic embedder. Tests that need a
    // different threshold can override via page.evaluate.
    s.extension_settings.vectors.score_threshold = 0.2;
    s.extension_settings.vectors.max_entries = 5;

    // Memory-graph extension wiring: same profile, shared collection backend.
    s.extension_settings.memory_graph = s.extension_settings.memory_graph || {};
    s.extension_settings.memory_graph.embeddingProfileId = profileId;

    writeFileSync(settingsPath, JSON.stringify(s, null, 4));
    return { profileId, profileName };
}

/**
 * List characters present in a dataRoot (for assertions across restart).
 */
export function listCharacters({ dataRoot, handle = 'default-user' }) {
    const dir = resolve(userRoot(dataRoot, handle), 'characters');
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter(f => f.endsWith('.png')).sort();
}
