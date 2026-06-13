// Shared helper for the character/ batch: write a "real" character file
// by embedding card metadata into a PNG's tEXt chunk. The bundled
// `writeCharacter` fixture in _lib/fixtures.js only writes a JSON
// sidecar, but ST's /api/characters/all path parses card data from the
// PNG itself, so the sidecar is invisible — characters created that way
// surface under the bundled Seraphina's name. This helper embeds the
// card properly so the character appears under its own name.

import { resolve } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { write as writePngCard } from '../../../src/character-card-parser.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

function buildAshCard(overrides = {}) {
    const card = {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        name: 'Ash the Cartographer',
        description: 'A wiry coastal cartographer in her early thirties. Wind-bitten hands, ink-stained sleeves, and a quiet patience earned from years of mapping reefs that refuse to stay still. Carries a brass spyglass that once belonged to her mother.',
        personality: 'Observant, dry-witted, slow to anger but stubborn once committed. Prefers questions to assertions. Holds grief privately and competence publicly.',
        scenario: 'You and Ash share a watchpost on the Bryn headland, charged with reading the night reef for any sign of the salt-mark drifters returning before dawn.',
        first_mes: '*Ash looks up from a half-folded chart, brushing salt-crystal from the corner of the paper.* "You came earlier than I expected. The tide is still settling — sit. The lantern needs trimming and I would rather not do it twice."',
        mes_example: '',
        creator_notes: 'For e2e fixtures; safe for any backend.',
        system_prompt: 'You are Ash. Stay in scene. Reply with one to three immersive paragraphs unless the user asks a direct OOC question.',
        post_history_instructions: '',
        alternate_greetings: [
            '*Ash is already at the rail when you arrive, spyglass to her eye.* "Hold. Don\'t speak for a moment."',
        ],
        tags: ['rp', 'fixture'],
        creator: 'luker-e2e',
        character_version: '1.0',
        ...overrides,
    };
    // V2/V3 spec — wrap in `data` block as the import path expects.
    const v2Payload = {
        spec: card.spec,
        spec_version: card.spec_version,
        name: card.name,
        description: card.description,
        personality: card.personality,
        scenario: card.scenario,
        first_mes: card.first_mes,
        mes_example: card.mes_example,
        creator_notes: card.creator_notes,
        system_prompt: card.system_prompt,
        post_history_instructions: card.post_history_instructions,
        alternate_greetings: card.alternate_greetings,
        tags: card.tags,
        creator: card.creator,
        character_version: card.character_version,
        data: {
            name: card.name,
            description: card.description,
            personality: card.personality,
            scenario: card.scenario,
            first_mes: card.first_mes,
            mes_example: card.mes_example,
            creator_notes: card.creator_notes,
            system_prompt: card.system_prompt,
            post_history_instructions: card.post_history_instructions,
            alternate_greetings: card.alternate_greetings,
            tags: card.tags,
            creator: card.creator,
            character_version: card.character_version,
            extensions: card.extensions || {},
        },
    };
    return v2Payload;
}

/**
 * Write a character PNG with embedded v2 card metadata.
 *
 * @param {object} opts
 * @param {string} opts.dataRoot
 * @param {string} [opts.handle='default-user']
 * @param {string} [opts.avatarFile='ash-the-cartographer.png']
 * @param {object} [opts.overrides] Field overrides merged onto the default Ash card.
 * @returns {string} The avatar filename (with .png).
 */
export function writeEmbeddedCharacter({ dataRoot, handle = 'default-user', avatarFile = 'ash-the-cartographer.png', overrides = {} } = {}) {
    const charsDir = resolve(dataRoot, handle, 'characters');
    mkdirSync(charsDir, { recursive: true });
    const seed = resolve(REPO_ROOT, 'default/content/default_Seraphina.png');
    const seedPng = readFileSync(seed);
    const card = buildAshCard(overrides);
    const png = writePngCard(seedPng, JSON.stringify(card));
    writeFileSync(resolve(charsDir, avatarFile), png);
    return avatarFile;
}
