// Batch-local helpers for the personas e2e set.
//
// Two utilities the shared _lib doesn't currently offer:
//
//  1. `writeCharacterWithChunks` — like fixtures.js#writeCharacter but
//     embeds the card JSON as proper `chara` / `ccv3` tEXt chunks in the
//     PNG. The server reads card data from PNG chunks ONLY (see
//     src/character-card-parser.js#read) so a sidecar JSON file is not
//     honoured; the original helper writes only that sidecar and the
//     character ends up named "Seraphina" from the fallback PNG's own
//     embedded chunk. This helper is the chunk-aware variant.
//
//  2. `preseedPersona` — directly stamps a persona into a user's
//     settings.json (power_user.personas + power_user.persona_descriptions)
//     so the page-side `/persona-set` and `setUserAvatar` paths can work
//     WITHOUT going through `/persona-create`, which in this dev
//     environment hits a Jimp/squoosh WASM file-URL check that rejects
//     paths outside the worktree (node_modules is a symlink to the
//     original repo — its realpath escapes serverDirectory). Pre-seeding
//     the persona is functionally equivalent for everything the tests
//     here exercise (name1 propagation, character binding, lock state)
//     but skips the avatar re-encode.
//
// Both helpers operate purely on disk before page boot. Spec code then
// reloads the affected list via the UI.

import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { write as writeChara } from '../../../src/character-card-parser.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const SERAPHINA_PNG = resolve(REPO_ROOT, 'default/content/default_Seraphina.png');

function userRoot(dataRoot, handle = 'default-user') {
    return resolve(dataRoot, handle);
}

/**
 * Write a v2 character card with the card data embedded directly as a
 * `chara` (and v3 `ccv3`) PNG tEXt chunk. The server-side parser ignores
 * the legacy sidecar JSON path and reads card metadata only from PNG
 * chunks, so this is the only path that makes `/api/characters/all`
 * return the card under the intended name.
 *
 * @param {object} opts
 * @param {string} opts.dataRoot
 * @param {string} [opts.handle]
 * @param {string} [opts.avatarFile]   Filename, e.g. 'ash.png'
 * @param {object} [opts.overrides]    Field overrides merged onto the default card
 * @returns {string}                  The avatar filename
 */
export function writeCharacterWithChunks({
    dataRoot,
    handle = 'default-user',
    avatarFile = 'ash-the-cartographer.png',
    overrides = {},
}) {
    const charsDir = resolve(userRoot(dataRoot, handle), 'characters');
    mkdirSync(charsDir, { recursive: true });

    const card = {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        name: 'Ash the Cartographer',
        description: 'A wiry coastal cartographer in her early thirties. Wind-bitten hands, ink-stained sleeves, and a quiet patience earned from years of mapping reefs that refuse to stay still.',
        personality: 'Observant, dry-witted, slow to anger but stubborn once committed. Prefers questions to assertions.',
        scenario: 'You and Ash share a watchpost on the Bryn headland, charged with reading the night reef for any sign of the salt-mark drifters returning before dawn.',
        first_mes: '*Ash looks up from a half-folded chart, brushing salt-crystal from the corner of the paper.* "You came earlier than I expected. The tide is still settling — sit. The lantern needs trimming and I would rather not do it twice."',
        mes_example: '<START>\n{{user}}: What do you read in the reef tonight?\n{{char}}: *She traces a line on the chart with one knuckle.* "Three breakers north of the gull rocks that don\'t belong to the moon. Something is moving."',
        creator_notes: 'For e2e fixtures; safe for any backend.',
        system_prompt: 'You are Ash. Stay in scene. Reply with one to three immersive paragraphs unless the user asks a direct OOC question.',
        post_history_instructions: '',
        alternate_greetings: [
            '*Ash is already at the rail when you arrive, spyglass to her eye.* "Hold. Don\'t speak for a moment."',
        ],
        tags: ['rp', 'fixture'],
        creator: 'luker-e2e',
        character_version: '1.0',
        extensions: {},
        ...overrides,
    };

    const seedBuf = readFileSync(SERAPHINA_PNG);
    const cardJson = JSON.stringify(card);
    const stamped = writeChara(seedBuf, cardJson);
    writeFileSync(resolve(charsDir, avatarFile), stamped);
    return avatarFile;
}

/**
 * Stamp a persona into <dataRoot>/<handle>/settings.json under
 * `power_user.personas` and `power_user.persona_descriptions`. Writes a
 * real PNG to `User Avatars/<avatarId>` too so the bell/avatar UI bits
 * have something to render against.
 *
 * Returns the avatarId you should pass to `setUserAvatar(avatarId)` on
 * the page side to activate this persona.
 *
 * @param {object} opts
 * @param {string} opts.dataRoot
 * @param {string} [opts.handle]
 * @param {string} opts.avatarId         Filename used as the persona key
 * @param {string} opts.name             Display name (becomes name1)
 * @param {string} [opts.description]
 * @param {string} [opts.title]
 * @returns {string}
 */
export function preseedPersona({
    dataRoot,
    handle = 'default-user',
    avatarId,
    name,
    description = '',
    title = '',
}) {
    if (!avatarId) throw new Error('preseedPersona: avatarId is required');
    if (!name) throw new Error('preseedPersona: name is required');

    const settingsPath = resolve(userRoot(dataRoot, handle), 'settings.json');
    if (!existsSync(settingsPath)) {
        throw new Error(`settings.json not found at ${settingsPath}`);
    }
    const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
    s.power_user = s.power_user || {};
    s.power_user.personas = s.power_user.personas || {};
    s.power_user.persona_descriptions = s.power_user.persona_descriptions || {};

    s.power_user.personas[avatarId] = name;
    s.power_user.persona_descriptions[avatarId] = {
        description,
        position: 0, // persona_description_positions.IN_PROMPT
        depth: 2,
        role: 0,
        lorebook: '',
        title,
        connections: [],
    };

    writeFileSync(settingsPath, JSON.stringify(s, null, 4));

    // Drop a real PNG for the avatar so /User%20Avatars/<id> serves a
    // valid image. This is NOT going through Jimp re-encoding — the
    // raw bytes are written straight to disk.
    const avatarsDir = resolve(userRoot(dataRoot, handle), 'User Avatars');
    mkdirSync(avatarsDir, { recursive: true });
    copyFileSync(SERAPHINA_PNG, resolve(avatarsDir, avatarId));

    return avatarId;
}
