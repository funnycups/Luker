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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
